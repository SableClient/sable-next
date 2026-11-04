package moe.sable.client

import android.app.Activity
import android.app.Service
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession

class AuthBrowser(private val activity: Activity) {
  private val handler = Handler(Looper.getMainLooper())
  private var connection: CustomTabsServiceConnection? = null
  private var pending: ((Result<Boolean>) -> Unit)? = null
  private var timeout: Runnable? = null
  private var browserId: String? = null
  private var launched = false
  private var sheet = false

  fun open(id: String, uri: Uri, sheet: Boolean, complete: (Result<Boolean>) -> Unit) {
    close()
    if (uri.scheme !in listOf("https", "http") || uri.host.isNullOrEmpty()) {
      complete(Result.failure(IllegalArgumentException("Invalid authentication URL")))
      return
    }
    pending = complete
    browserId = id
    this.sheet = sheet
    val packageName = CustomTabsClient.getPackageName(activity, null)
    if (packageName == null) {
      launch(uri, null, null)
      return
    }

    val service = object : CustomTabsServiceConnection() {
      override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
        if (connection !== this || pending == null) return
        val connected = this
        client.warmup(0)
        val session = client.newSession(object : CustomTabsCallback() {
          override fun onNavigationEvent(event: Int, extras: Bundle?) {
            // Hidden tabs can still be open behind another activity.
            if (event == TAB_HIDDEN && connection === connected) disconnect()
          }
        })
        if (session == null) disconnect()
        launch(uri, packageName, session)
      }

      override fun onServiceDisconnected(name: ComponentName) {
        if (connection === this) {
          if (pending != null) close() else disconnect()
        }
      }
    }
    connection = service
    val bound = runCatching {
      CustomTabsClient.bindCustomTabsService(activity, packageName, service)
    }.getOrDefault(false)
    if (!bound) {
      connection = null
      launch(uri, packageName, null)
      return
    }
    timeout = Runnable {
      if (pending != null && connection === service) {
        disconnect()
        launch(uri, packageName, null)
      }
    }.also { handler.postDelayed(it, 2000) }
  }

  private fun launch(uri: Uri, packageName: String?, session: CustomTabsSession?) {
    val complete = pending ?: return
    pending = null
    timeout?.let(handler::removeCallbacks)
    timeout = null
    val result = runCatching {
      val builder = CustomTabsIntent.Builder(session).setShowTitle(true)
      val besideApp = sheet && session != null && supportsPartialTabs(packageName)
      if (besideApp) {
        val metrics = activity.resources.displayMetrics
        builder
          .setInitialActivityHeightPx(
            metrics.heightPixels * 85 / 100,
            CustomTabsIntent.ACTIVITY_HEIGHT_FIXED,
          )
          .setInitialActivityWidthPx(metrics.widthPixels / 2)
      }
      val tab = builder.build()
      packageName?.let(tab.intent::setPackage)
      if (session != null) {
        // Chrome binds this service for the lifetime of the approval tab.
        tab.intent.putExtra(
          "android.support.customtabs.extra.KEEP_ALIVE",
          Intent(activity, AuthBrowserKeepAliveService::class.java),
        )
      }
      tab.launchUrl(activity, uri)
      launched = true
      besideApp
    }
    if (result.isFailure) close()
    complete(result)
  }

  private fun supportsPartialTabs(packageName: String?): Boolean {
    if (packageName == null || packageName !in CHROME_PACKAGES) return false
    val version = runCatching {
      activity.packageManager.getPackageInfo(packageName, 0).versionName
    }.getOrNull()
    val major = version?.substringBefore('.')?.toIntOrNull() ?: return false
    return major >= 107
  }

  fun close() {
    browserId = null
    launched = false
    sheet = false
    timeout?.let(handler::removeCallbacks)
    timeout = null
    disconnect()
    val complete = pending
    pending = null
    complete?.invoke(Result.failure(IllegalStateException("Authentication browser closed")))
  }

  fun dismiss(id: String) {
    if (browserId != id) return
    val wasLaunched = launched
    close()
    if (wasLaunched) {
      // The Custom Tab is above MainActivity in the same task.
      activity.startActivity(Intent(activity, MainActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      })
    }
  }

  private fun disconnect() {
    val previous = connection
    connection = null
    if (previous != null) runCatching { activity.unbindService(previous) }
  }
}

private val CHROME_PACKAGES = setOf(
  "com.android.chrome",
  "com.chrome.beta",
  "com.chrome.dev",
  "com.chrome.canary",
)

class AuthBrowserKeepAliveService : Service() {
  private val binder = Binder()
  override fun onBind(intent: Intent): IBinder = binder
}
