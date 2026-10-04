package moe.sable.next

import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private external fun nativeInitSystemBars()
  private external fun nativeNetworkChanged(unmetered: Boolean)
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    NativeSentry.apply(this, getSharedPreferences("sentry", MODE_PRIVATE).getBoolean("enabled", false))
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
    runCatching { nativeInitSystemBars() }
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
        nativeNetworkChanged(false)
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        if (instance !== this@MainActivity) return
        if (network != current) return
        nativeNetworkChanged(
          capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
          !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
        )
      }

      override fun onLost(network: Network) {
        if (instance !== this@MainActivity) return
        if (network != current) return
        current = null
        nativeNetworkChanged(false)
      }
    }
    runCatching {
      nativeNetworkChanged(false)
      connectivity.registerDefaultNetworkCallback(callback)
      networkCallback = callback
    }.onFailure { error ->
      Log.w("SableNetwork", "Could not monitor network cost", error)
    }
  }

  override fun onNewIntent(intent: Intent) {
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
      }.toString()
    )
  }

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
        android.util.Log.w("ShareTarget", "provider returned no stream for $uri")
        return
      }
      input.use { FileOutputStream(File(batchDir, fileName)).use { output -> it.copyTo(output) } }
      items.put(JSONObject().apply {
        put("kind", "file")
        put("fileName", fileName)
        put("mime", resolver.getType(uri) ?: "application/octet-stream")
      })
    } catch (e: Exception) {
      android.util.Log.w("ShareTarget", "stage failed: ${e.message}")
    }
  }

  override fun onDestroy() {
    networkCallback?.let {
      runCatching {
        getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
      }
    }
    networkCallback = null
    if (instance === this) {
      instance = null
      nativeNetworkChanged(false)
    }
    super.onDestroy()
  }

  companion object {
    @Volatile private var instance: MainActivity? = null
    private var hiddenBarsDepth = 0
    private var shownBarsBehavior: Int? = null

    @JvmStatic
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
    @JvmStatic
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
    @JvmStatic
    fun setWindowBackgroundNative(color: Int) {
      val activity = instance ?: return
      activity.runOnUiThread {
        activity.window.setBackgroundDrawable(ColorDrawable(color))
      }
    }

    @JvmStatic
    fun setNavigationBarLightNative(light: Boolean) {
      val activity = instance ?: return
      activity.runOnUiThread {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightNavigationBars = light
      }
    }

    @JvmStatic
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

    @JvmStatic
    fun setSentryEnabledNative(enabled: Boolean) {
      val activity = instance ?: return
      activity.runOnUiThread {
        activity.getSharedPreferences("sentry", MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply()
        NativeSentry.apply(activity, enabled)
      }
    }
  }
}
