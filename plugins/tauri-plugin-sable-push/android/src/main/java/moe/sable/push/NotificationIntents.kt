package moe.sable.push

internal object NotificationIntents {
    const val NOTIFICATION_ID = "NotificationId"
    const val NOTIFICATION_OBJECT = "LocalNotficationObject"
    const val ACTION = "NotificationUserAction"
    const val REMOVABLE = "NotificationRepeating"
    const val REMOTE_INPUT = "NotificationRemoteInput"
    const val DEFAULT_PRESS = "tap"
    const val ACTION_RECEIVER = "app.tauri.notification.NotificationActionReceiver"
    const val INSTANCE = "default"
}

internal data class PushAction(
    val id: String,
    val title: String,
    val input: Boolean = false,
    val foreground: Boolean = true,
)

internal object PushActions {
    const val MESSAGE_TYPE = "sable-message"
    const val CALL_TYPE = "sable-call"
    const val INVITE_TYPE = "sable-invite"
    const val REPLY = "sable-reply"
    const val MARK_READ = "sable-mark-read"
    const val ANSWER_CALL = "sable-call-answer"
    const val DECLINE_CALL = "sable-call-decline"
    const val ACCEPT_INVITE = "sable-invite-accept"
    const val DECLINE_INVITE = "sable-invite-decline"

    val message = listOf(
        PushAction(REPLY, "Reply", input = true),
        PushAction(MARK_READ, "Mark as read", foreground = false),
    )
    val invite = listOf(
        PushAction(ACCEPT_INVITE, "Accept"),
        PushAction(DECLINE_INVITE, "Decline", foreground = false),
    )
}
