package moe.sable.push

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat

internal object ConversationHistory {
    const val EVENT_KEY = "sable.push.event"
    const val ENCRYPTED_KEY = "sable.push.encrypted"
    const val ACCOUNT_KEY = "sable.push.account"
    const val LIMIT = 8

    private fun shown(context: Context, id: Int): List<NotificationCompat.MessagingStyle.Message> {
        val active = context.getSystemService(NotificationManager::class.java)
            .activeNotifications.firstOrNull { it.id == id && it.tag == null } ?: return emptyList()
        return NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(active.notification)
            ?.messages.orEmpty()
    }

    fun shows(context: Context, id: Int, eventId: String?, text: String): Boolean =
        eventId != null && shown(context, id).any {
            it.extras.getString(EVENT_KEY) == eventId && it.text.toString() == text
        }

    fun read(context: Context, id: Int): List<NotificationCompat.MessagingStyle.Message> {
        val state = PushPolicy(context)
        return shown(context, id).map { message ->
            val hidden = !state.showContent || (!state.showEncryptedContent &&
                message.extras.getBoolean(ENCRYPTED_KEY, true))
            NotificationCompat.MessagingStyle.Message(
                if (hidden) "New message" else message.text, message.timestamp, message.person
            ).also { it.extras.putAll(message.extras) }
        }
    }
}
