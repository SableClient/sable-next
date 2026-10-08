package moe.sable.push

import android.content.Context
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class NotificationReceiptsTest {
    @Test
    fun receiptsAreBoundedOpaqueAndScopedToTheirNotification() {
        val context = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences("notification-receipts", Context.MODE_PRIVATE)
        val editor = preferences.edit().putLong("sequence", 2048)
        for (i in 1..2048) editor.putLong("event:seed$i", i.toLong())
        editor.commit()
        NotificationReceipts.record(context, 1, "\$private-event")
        assertEquals(2048, preferences.all.keys.count { it.startsWith("event:") })
        assertFalse(preferences.contains("event:seed1"))
        assertFalse(preferences.all.toString().contains("private-event"))
        assertTrue(NotificationReceipts.shouldDrop(context, 1, "\$private-event"))
        assertFalse(NotificationReceipts.shouldDrop(context, 2, "\$private-event"))
        assertFalse(NotificationReceipts.shouldDrop(context, 1, "\$new-event"))
    }
}
