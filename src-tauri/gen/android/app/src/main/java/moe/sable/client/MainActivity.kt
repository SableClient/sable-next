package moe.sable.client

import android.content.Intent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.res.Configuration
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.util.Base64
import android.webkit.WebView
import android.webkit.JavascriptInterface
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import androidx.core.content.IntentCompat
import androidx.core.content.FileProvider
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import moe.sable.push.ConversationShortcuts
import moe.sable.push.Secrets
import java.lang.ref.WeakReference
import org.json.JSONArray
import org.json.JSONObject
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.core.graphics.drawable.toDrawable

class MainActivity : TauriActivity() {
  private external fun nativeInitSystemBars()
  private external fun nativeNetworkChanged(available: Boolean, unmetered: Boolean)
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var fullscreenClient: FullscreenChromeClient? = null
  private var mainWebView: WebView? = null
  private val authBrowser = AuthBrowser(this)
  private val fullscreenBackCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      fullscreenClient?.exitFullscreen()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Before Tauri starts the core, which reads saved logins.
    Secrets.install(this)
    NativeSentry.apply(this, getSharedPreferences("sentry", MODE_PRIVATE).getBoolean("enabled", false))
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    
    instance = this
    onBackPressedDispatcher.addCallback(this, fullscreenBackCallback)
    runCatching { nativeInitSystemBars() }.onFailure {
      Log.e("Sable", "Could not initialize the native Activity bridge", it)
    }
    
    AppLifecycle.start()
    startNetworkMonitor()
    stageShareIntent(intent)
  }

  private fun startNetworkMonitor() {
    val connectivity = getSystemService(ConnectivityManager::class.java)
    
    val callback = object : ConnectivityManager.NetworkCallback() {
      private var current: Network? = null

      override fun onAvailable(network: Network) {
        if (instance !== this@MainActivity) return
        current = network
        nativeNetworkChanged(available = true, unmetered = false)
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        if (instance !== this@MainActivity) return
        if (network != current) return
        nativeNetworkChanged(
          true,
          capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
          !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
        )
      }

      override fun onLost(network: Network) {
        if (instance !== this@MainActivity) return
        if (network != current) return
        current = null
        nativeNetworkChanged(available = false, unmetered = false)
      }
    }
    
    runCatching {
      nativeNetworkChanged(connectivity.activeNetwork != null, false)
      connectivity.registerDefaultNetworkCallback(callback)
      networkCallback = callback
    }.onFailure { error ->
      Log.w("SableNetwork", "Could not monitor network cost", error)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    mainWebView = webView
    webView.addJavascriptInterface(SystemTheme(), "__sableAndroidSystemTheme")
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(
          "(typeof window.__sableAndroidBack === 'function' && window.__sableAndroidBack() === true)"
        ) { consumed ->
          if (consumed != "true") moveTaskToBack(true)
        }
      }
    })
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return
    webView.post {
      val inner = webView.webChromeClient ?: return@post
      val client = FullscreenChromeClient(inner, ::setFullscreenVideo)
      webView.webChromeClient = client
      fullscreenClient = client
    }
  }

  @Keep
  private inner class SystemTheme {
    @JavascriptInterface
    fun isDarkMode(): Boolean =
      resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    mainWebView?.evaluateJavascript(
      "window.dispatchEvent(new Event('sable:system-theme-changed'))",
      null
    )
  }

  private fun setFullscreenVideo(active: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    
    if (active) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
    
    fullscreenBackCallback.isEnabled = active
  }

  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
    stageShareIntent(intent)
  }

  private fun stageShareIntent(intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

    val batchDir = File(File(dataDir, "share_inbox"), "${System.currentTimeMillis()}-${UUID.randomUUID()}")
    batchDir.mkdirs()
    val items = JSONArray()

    when (action) {
      Intent.ACTION_SEND -> {
        when (intent.type) {
          "text/plain" -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let { addTextItem(items, it) }
          else -> {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
              ?.let { stageFile(it, 0, batchDir, items) }
            intent.getStringExtra(Intent.EXTRA_TEXT)?.let { addTextItem(items, it) }
          }
        }
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
          ?.forEachIndexed { i, uri -> stageFile(uri, i, batchDir, items) }
      }
    }

    if (items.length() == 0) {
      batchDir.deleteRecursively()
      return
    }
    
    File(batchDir, "share.json").writeText(
      JSONObject().apply {
        put("version", 1)
        put("items", items)
        intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID)
          ?.takeIf(::isPublishedShortcut)
          ?.let(ConversationShortcuts::parse)
          ?.let { (userId, roomId) -> put("target", JSONObject().put("userId", userId).put("roomId", roomId)) }
      }.toString()
    )
  }

  /** Any app can send this activity a shortcut id, so only trust the ones published here. */
  private fun isPublishedShortcut(id: String): Boolean = runCatching {
    ShortcutManagerCompat.getShortcuts(
      this,
      ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or ShortcutManagerCompat.FLAG_MATCH_CACHED,
    ).any { it.id == id }
  }.getOrDefault(false)

  private fun addTextItem(items: JSONArray, text: String) {
    items.put(JSONObject().apply {
      put("kind", if (text.startsWith("http://") || text.startsWith("https://")) "url" else "text")
      put("text", text)
    })
  }

  private fun stageFile(uri: Uri, index: Int, batchDir: File, items: JSONArray) {
    val resolver = contentResolver
    try {
      var displayName = "shared-$index"
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (i >= 0) c.getString(i)?.let { displayName = it }
        }
      }
      
      val sanitized = displayName
        .replace("/", "_").replace("\\", "_").replace("\u0000", "")
        .take(120)
        .let { if (it.isEmpty() || it == "." || it == "..") "shared" else it }

      val fileName = "$index-$sanitized"
      val input = resolver.openInputStream(uri)
      if (input == null) {
        Log.w("ShareTarget", "provider returned no stream for $uri")
        return
      }
      
      input.use { FileOutputStream(File(batchDir, fileName)).use { output -> it.copyTo(output) } }
      items.put(JSONObject().apply {
        put("kind", "file")
        put("fileName", fileName)
        put("mime", resolver.getType(uri) ?: "application/octet-stream")
      })
    } catch (e: Exception) {
      Log.w("ShareTarget", "stage failed: ${e.message}")
    }
  }

  override fun onDestroy() {
    mainWebView = null
    authBrowser.close()
    
    networkCallback?.let {
      runCatching {
        getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
      }
    }
    
    networkCallback = null
    if (instance === this) {
      instance = null
      nativeNetworkChanged(available = true, unmetered = false)
    }
    
    super.onDestroy()
  }

  // functions here aren't unused as they're used by the rust backend
  companion object {
    @Volatile private var instanceRef: WeakReference<MainActivity>? = null
    private var instance: MainActivity?
      get() = instanceRef?.get()
      set(value) {
        instanceRef = value?.let(::WeakReference)
      }
    private var hiddenBarsDepth = 0
    private var shownBarsBehavior: Int? = null

    @Keep
    @JvmStatic
    @Suppress("unused")
    fun openAuthUrlNative(id: String, url: String, sheet: Boolean): Boolean {
      val activity = checkNotNull(instance) { "Activity is unavailable" }
      val result = CompletableFuture<Boolean>()
      
      activity.runOnUiThread {
        runCatching {
          activity.authBrowser.open(id, url.toUri(), sheet) { opened ->
            opened.fold(result::complete) { result.completeExceptionally(it) }
          }
        }.onFailure { result.completeExceptionally(it) }
      }
      return result.get(10, TimeUnit.SECONDS)
    }

    @Keep
    @JvmStatic
    @Suppress("unused")
    fun closeAuthWindowNative(id: String) {
      val activity = instance ?: return
      
      activity.runOnUiThread { activity.authBrowser.dismiss(id) }
    }

    @Keep
    @JvmStatic
    @Suppress("unused")
    fun hapticFeedbackNative(strong: Boolean) {
      val activity = instance ?: return
      
      activity.runOnUiThread {
        activity.window.decorView.performHapticFeedback(
          if (strong) android.view.HapticFeedbackConstants.LONG_PRESS
          else android.view.HapticFeedbackConstants.CLOCK_TICK
        )
      }
    }

    // The bars stay transparent under edge-to-edge and the webview paints them,
    // so only the icon contrast is left. setStatusBarColor is a no-op from API 35.
    @Keep
    @JvmStatic
    @Suppress("unused")
    fun setStatusBarLightNative(light: Boolean) {
      val activity = instance ?: return
      
      activity.runOnUiThread {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
      }
    }

    // The inset host pads the webview's parent to the keyboard's final height as
    // soon as the IME animation starts, and that band shows the window
    // background, which follows the system theme rather than the app's.
    @Keep
    @JvmStatic
    @Suppress("unused")
    fun setWindowBackgroundNative(color: Int) {
      val activity = instance ?: return
      
      activity.runOnUiThread {
        activity.window.setBackgroundDrawable(color.toDrawable())
      }
    }

    @Keep
    @JvmStatic
    @Suppress("unused")
    fun copyImageToClipboardNative(image: String) {
      val activity = checkNotNull(instance) { "Activity is unavailable" }
      val directory = File(activity.cacheDir, "clipboard").apply { mkdirs() }
      val file = File(directory, "image.png")
      
      try {
        file.writeBytes(Base64.decode(image, Base64.NO_WRAP))
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val copy = FutureTask {
          activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(
            ClipData.newUri(activity.contentResolver, "Image", uri)
          )
        }
        
        activity.runOnUiThread(copy)
        copy.get()
      } catch (error: Exception) {
        file.delete()
        throw error
      }
    }

    @Keep
    @JvmStatic
    @Suppress("unused")
    fun setNavigationBarLightNative(light: Boolean) {
      val activity = instance ?: return
      
      activity.runOnUiThread {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightNavigationBars = light
      }
    }

    @Keep
    @JvmStatic
    @Suppress("unused")
    fun setSystemBarsHiddenNative(hidden: Boolean) {
      val activity = instance ?: return
      activity.runOnUiThread {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        
        if (hidden) {
          hiddenBarsDepth += 1
          if (hiddenBarsDepth > 1) return@runOnUiThread
          shownBarsBehavior = controller.systemBarsBehavior
          controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          
          controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
          hiddenBarsDepth = maxOf(0, hiddenBarsDepth - 1)
          if (hiddenBarsDepth > 0) return@runOnUiThread
          controller.show(WindowInsetsCompat.Type.systemBars())
          
          shownBarsBehavior?.let { controller.systemBarsBehavior = it }
          shownBarsBehavior = null
        }
      }
    }

    @Keep
    @JvmStatic
    @Suppress("unused")
    fun setSentryEnabledNative(enabled: Boolean) {
      val activity = instance ?: return
      
      activity.runOnUiThread {
        activity.getSharedPreferences("sentry", MODE_PRIVATE).edit {
          putBoolean(
            "enabled",
            enabled
          )
        }
        NativeSentry.apply(activity, enabled)
      }
    }
  }
}
