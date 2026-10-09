package moe.sable.push

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log

internal object AlertLog {
    private const val TAG = "SableAlert"

    fun posted(
        context: Context,
        path: String,
        trace: PushTrace,
        notification: Notification,
        quiet: List<String>,
        facts: List<String> = emptyList(),
    ) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        val channel = if (modern) manager.getNotificationChannel(notification.channelId) else null
        val detail = listOf(
            "path=$path",
            "quiet=${quiet.joinToString(",").ifEmpty { "none" }}",
            "onlyAlertOnce=${notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0}",
            "groupAlert=${if (modern) notification.groupAlertBehavior else null}",
            "channel=${channel?.id}",
            "importance=${channel?.importance}",
            "sound=${channel?.sound != null}",
            "vibrate=${channel?.shouldVibrate()}",
            "dnd=${manager.currentInterruptionFilter}",
            "enabled=${manager.areNotificationsEnabled()}",
        ).plus(facts).joinToString(" ")
        write(context, PushOutcome.POSTED, trace, detail)
    }

    fun skipped(context: Context, path: String, trace: PushTrace, reason: String) {
        write(context, PushOutcome.REPLAY_DROPPED, trace, "path=$path skipped=$reason")
    }

    private fun write(context: Context, outcome: PushOutcome, trace: PushTrace, detail: String) {
        Log.i(TAG, "${outcome.name} room=${trace.roomId} event=${trace.eventId} $detail")
        PushDiagnostics.record(context, outcome, trace, detail)
    }
}
