package moe.sable.next

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import androidx.core.view.WindowCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private external fun nativeInitSystemBars()

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
    runCatching { nativeInitSystemBars() }
    stageShareIntent(intent)
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
    var displayName = "shared-$index"
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (i >= 0) displayName = c.getString(i)
      }
    }
    val sanitized = displayName
      .replace("/", "_").replace("\\", "_").replace("\u0000", "")
      .take(120)
      .let { if (it.isEmpty() || it == "." || it == "..") "shared" else it }

    val fileName = "$index-$sanitized"
    val dest = File(batchDir, fileName)
    val input = resolver.openInputStream(uri)
    if (input == null) {
      android.util.Log.w("ShareTarget", "provider returned no stream for $uri")
      return
    }
    try {
      input.use { FileOutputStream(dest).use { output -> it.copyTo(output) } }
      items.put(JSONObject().apply {
        put("kind", "file")
        put("fileName", fileName)
        put("mime", resolver.getType(uri) ?: "application/octet-stream")
      })
    } catch (e: Exception) {
      android.util.Log.w("ShareTarget", "stage failed: ${e.message}")
      dest.delete()
    }
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
    fun setStatusBarLightNative(light: Boolean) {
      val activity = instance ?: return
      activity.runOnUiThread {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
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
  }
}
