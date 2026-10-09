package moe.sable.push

import android.content.Context
import android.util.Base64
import java.security.MessageDigest

internal object NotificationReceipts {
    private const val LIMIT = 2048

    private fun key(id: Int, event: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$id\u0000$event".toByteArray(Charsets.UTF_8))
        return "event:" + Base64.encodeToString(digest, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)
    }

    fun shouldDrop(context: Context, id: Int, event: String?): Boolean {
        if (event.isNullOrEmpty()) return false
        val visible = ConversationHistory.read(context, id)
        if (visible.any { it.extras.getString(ConversationHistory.EVENT_KEY) == event }) return false
        return context.getSharedPreferences("notification-receipts", Context.MODE_PRIVATE).contains(key(id, event))
    }

    fun record(context: Context, id: Int, event: String?) {
        if (event.isNullOrEmpty()) return
        val prefs = context.getSharedPreferences("notification-receipts", Context.MODE_PRIVATE)
        val key = key(id, event)
        if (prefs.contains(key)) return
        val sequence = prefs.getLong("sequence", 0) + 1
        val editor = prefs.edit().putLong("sequence", sequence).putLong(key, sequence)
        val entries = prefs.all.filterKeys { it.startsWith("event:") }
        entries.entries.sortedBy { it.value as? Long ?: 0 }.take((entries.size + 1 - LIMIT).coerceAtLeast(0))
            .forEach { editor.remove(it.key) }
        editor.apply()
    }
}
