package moe.sable.push

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MatrixPushPayloadTest {
    @Test
    fun routingOnlyDropsWhatAForgedPushCouldDisplay() {
        val raw = """{"notification":{"event_id":"${'$'}e","room_id":"!r:x","type":"m.room.message",""" +
            """"sender_display_name":"Mallory","room_name":"Bank","content":{"body":"pay me"},""" +
            """"counts":{"unread":2},"devices":[{"app_id":"moe.sable.up","pushkey":"https://ntfy.example/upA"}]}}"""

        val notification = JSONObject(MatrixPushPayload.routingOnly(raw)).getJSONObject("notification")

        assertEquals("${'$'}e", notification.getString("event_id"))
        assertEquals("!r:x", notification.getString("room_id"))
        assertEquals(2, notification.getJSONObject("counts").getInt("unread"))
        listOf("type", "content", "sender_display_name", "room_name").forEach { assertFalse(notification.has(it), it) }
    }
}
