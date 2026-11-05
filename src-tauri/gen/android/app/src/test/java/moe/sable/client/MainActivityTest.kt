package moe.sable.client

import android.content.Intent
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowActivity

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [ShadowTauriActivity::class])
class MainActivityTest {
  @Test
  fun notificationTapIsRetainedBeforeTauriDispatch() {
    val controller = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN))
    val activity = controller.get()
    val notification = Intent(Intent.ACTION_MAIN)
      .putExtra("NotificationId", 42)
      .putExtra("NotificationUserAction", "tap")
      .putExtra(
        "LocalNotficationObject",
        """{"extra":{"user_id":"@me:example.org","room_id":"!room:example.org","event_id":"${'$'}event"}}"""
      )

    controller.newIntent(notification)

    val target = JSONObject(activity.intent.getStringExtra("LocalNotficationObject")!!)
      .getJSONObject("extra")
    assertEquals("@me:example.org", target.getString("user_id"))
    assertEquals("!room:example.org", target.getString("room_id"))
    assertEquals("\$event", target.getString("event_id"))
    val forwarded = Shadow.extract<ShadowTauriActivity>(activity)
    assertSame(notification, forwarded.intentDuringDispatch)
  }
}

@Implements(TauriActivity::class, isInAndroidSdk = false)
class ShadowTauriActivity : ShadowActivity() {
  @RealObject
  private lateinit var activity: TauriActivity
  var intentDuringDispatch: Intent? = null

  @Implementation
  fun onNewIntent(intent: Intent) {
    intentDuringDispatch = activity.intent
  }
}
