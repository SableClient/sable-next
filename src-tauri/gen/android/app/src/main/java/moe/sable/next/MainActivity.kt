package moe.sable.next

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  private external fun nativeInitSystemBars()

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
    runCatching { nativeInitSystemBars() }
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  companion object {
    private var instance: MainActivity? = null

    // The bars stay transparent under edge-to-edge and the webview paints them,
    // so only the icon contrast is left. setStatusBarColor is a no-op from API 35.
    @JvmStatic
    fun setSystemBarsLightNative(light: Boolean) {
      val activity = instance ?: return
      activity.runOnUiThread {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
        controller.isAppearanceLightNavigationBars = light
      }
    }
  }
}
