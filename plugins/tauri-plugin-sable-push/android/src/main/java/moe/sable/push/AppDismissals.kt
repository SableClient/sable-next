package moe.sable.push

import android.app.NotificationManager
import android.content.Context
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.WorkManager
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The UI's unread counts can lag the push that posted an alert, so the UI only
 * clears an alert outright for the room the user has open in the foreground.
 * Any other request waits for the server to confirm the room is read.
 */
internal object AppDismissals {
    private const val TAG = "AppDismissals"
    private val serverCheck: Executor = Executors.newSingleThreadExecutor()
    private val checking = mutableSetOf<Int>()
    private val requestedAgain = mutableSetOf<Int>()

    @Volatile
    private var openConversation: Int? = null

    fun opened(
        context: Context,
        userId: String?,
        roomId: String?,
        foreground: Boolean = PushNotifier.appInForeground(),
    ) {
        val id = if (userId != null && roomId != null) PushNotifier.roomNotificationId(userId, roomId) else null
        openConversation = id
        if (id != null && foreground) clearOpen(context, context.getSystemService(NotificationManager::class.java), id)
    }

    fun dismiss(
        context: Context,
        ids: List<Int>,
        foreground: Boolean = PushNotifier.appInForeground(),
        background: Executor = serverCheck,
    ) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val open = openConversation?.takeIf { foreground && it in ids }
        if (open != null) clearOpen(context, manager, open)
        val shown = manager.activeNotifications.filter { it.tag == null && it.id in ids && it.id != open }
        val fresh = synchronized(this) {
            shown.filter { alert ->
                if (checking.add(alert.id)) true else { requestedAgain.add(alert.id); false }
            }
        }
        if (fresh.isNotEmpty()) check(context, manager, fresh, background)
    }

    private fun clearOpen(context: Context, manager: NotificationManager, id: Int) {
        WorkManager.getInstance(context).cancelAllWorkByTag("push-room:$id")
        manager.activeNotifications.filter { it.tag == null && it.id == id }
            .forEach { AlertLog.dismissal(context, PushOutcome.APP_DISMISSED, it) }
        PushNotificationGate.dismiss(context, id) { manager.cancel(id) }
        PushNotifier.cancelOrphanedSummary(context)
    }

    private fun check(context: Context, manager: NotificationManager, alerts: List<StatusBarNotification>, background: Executor) {
        val ids = alerts.map { it.id }
        try {
            background.execute {
                try {
                    clearServerRead(context, manager, alerts)
                } catch (error: RuntimeException) {
                    Log.w(TAG, "Could not check read rooms", error)
                } finally {
                    finish(context, manager, ids, background)
                }
            }
        } catch (error: RejectedExecutionException) {
            synchronized(this) {
                checking.removeAll(ids.toSet())
                requestedAgain.removeAll(ids.toSet())
            }
        }
    }

    /** A request that came in while its room was being checked may follow a newer read, so it is checked again. */
    private fun finish(context: Context, manager: NotificationManager, ids: List<Int>, background: Executor) {
        val retry = synchronized(this) {
            val requested = ids.filter { requestedAgain.remove(it) }.toSet()
            val shown = manager.activeNotifications.filter { it.tag == null && it.id in requested }
            checking.removeAll(ids.toSet() - shown.map { it.id }.toSet())
            shown
        }
        if (retry.isNotEmpty()) check(context, manager, retry, background)
    }

    private fun clearServerRead(context: Context, manager: NotificationManager, shown: List<StatusBarNotification>) {
        val policy = PushPolicy(context)
        shown.groupBy { it.notification.extras.getString(ConversationHistory.ACCOUNT_KEY).orEmpty() }
            .forEach { (userId, alerts) ->
                val rooms = alerts.mapNotNull { room(it) }.distinct()
                val deviceId = policy.deviceIdFor(userId)
                val read = if (deviceId == null || rooms.isEmpty()) emptySet() else {
                    PushPayloadDecryptor.readRooms(context, userId, deviceId, rooms.first(), rooms).orEmpty().toSet()
                }
                for (alert in alerts) {
                    // The revision stays, so a message still rendering when the server answered still posts.
                    val cleared = room(alert) in read && synchronized(PushNotificationGate) {
                        val unchanged = manager.activeNotifications.any {
                            it.id == alert.id && it.tag == null && it.postTime == alert.postTime && events(it) == events(alert)
                        }
                        if (unchanged) manager.cancel(alert.id)
                        unchanged
                    }
                    val outcome = if (cleared) PushOutcome.READ_DISMISSED else PushOutcome.APP_DISMISS_IGNORED
                    AlertLog.dismissal(context, outcome, alert)
                }
            }
        PushNotifier.cancelOrphanedSummary(context)
    }

    private fun events(alert: StatusBarNotification): List<String?> =
        NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(alert.notification)
            ?.messages.orEmpty().map { it.extras.getString(ConversationHistory.EVENT_KEY) }

    private fun room(alert: StatusBarNotification): String? =
        alert.notification.extras.getString(ConversationHistory.ROOM_KEY)?.takeIf { it.isNotEmpty() }

    /** Resending an unchanged policy must keep what is shown. */
    fun hidesShown(current: PushPolicy, enabled: Boolean, content: Boolean): Boolean =
        (current.notificationsEnabled && !enabled) || (current.showContent && !content)

    fun dismissAll(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag == null && it.id != PushNotifier.SUMMARY_ID }
            .forEach { AlertLog.dismissal(context, PushOutcome.ALL_DISMISSED, it) }
        WorkManager.getInstance(context).cancelAllWorkByTag("push-render")
        PushNotificationGate.dismiss(context, null) { manager.cancelAll() }
    }
}
