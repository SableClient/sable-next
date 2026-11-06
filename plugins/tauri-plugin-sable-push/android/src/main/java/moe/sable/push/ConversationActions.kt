package moe.sable.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** [id] is also the reply's transaction id, so a retried reply is sent once. */
internal data class ConversationAction(
    val id: String,
    val kind: String,
    val notificationId: Int,
    val userId: String,
    val roomId: String,
    val eventId: String,
    val text: String?,
) {
    fun toJson(): String = JSONObject()
        .put("id", id)
        .put("kind", kind)
        .put("notification_id", notificationId)
        .put("user_id", userId)
        .put("room_id", roomId)
        .put("event_id", eventId)
        .put("text", text)
        .toString()

    companion object {
        fun parse(json: String): ConversationAction? = runCatching {
            val value = JSONObject(json)
            ConversationAction(
                value.getString("id"),
                value.getString("kind"),
                value.getInt("notification_id"),
                value.getString("user_id"),
                value.getString("room_id"),
                value.getString("event_id"),
                value.optString("text").takeIf { value.has("text") },
            )
        }.getOrNull()

        fun fromIntent(intent: Intent): ConversationAction? {
            val notificationId = intent.getIntExtra(NotificationIntents.NOTIFICATION_ID, Int.MIN_VALUE)
            val kind = intent.getStringExtra(NotificationIntents.ACTION)
            if (notificationId == Int.MIN_VALUE || (kind != PushActions.REPLY && kind != PushActions.MARK_READ)) return null
            val extra = intent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)
                ?.let { runCatching { JSONObject(it).getJSONObject("extra") }.getOrNull() } ?: return null
            val userId = extra.optString("user_id")
            val roomId = extra.optString("room_id")
            if (userId.isEmpty() || roomId.isEmpty()) return null
            val text = RemoteInput.getResultsFromIntent(intent)
                ?.getCharSequence(NotificationIntents.REMOTE_INPUT)?.toString()?.takeIf { it.isNotBlank() }
            if (kind == PushActions.REPLY && text == null) return null
            return ConversationAction(
                UUID.randomUUID().toString(), kind, notificationId, userId, roomId, extra.optString("event_id"), text,
            )
        }
    }
}

class ConversationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = ConversationAction.fromIntent(intent) ?: return
        if (action.kind == PushActions.MARK_READ) {
            PushNotificationGate.dismiss(context, action.notificationId) {
                NotificationManagerCompat.from(context).cancel(action.notificationId)
            }
            PushNotifier.cancelOrphanedSummary(context)
            if (action.eventId.isEmpty()) return
        }
        ConversationActionWorker.enqueue(context, action)
    }
}

class ConversationActionWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val id = inputData.getString(ACTION_ID) ?: return Result.failure()
        if (runCatching { UUID.fromString(id).toString() }.getOrNull() != id) return Result.failure()
        val file = File(applicationContext.noBackupFilesDir, "$DIRECTORY/$id")
        val action = runCatching { file.readText() }.getOrNull()?.let(ConversationAction::parse)
            ?: return Result.failure()
        val policy = PushPolicy(applicationContext)
        val deviceId = policy.deviceIdFor(action.userId)
        val done = deviceId != null && when (action.kind) {
            PushActions.REPLY -> PushPayloadDecryptor.reply(applicationContext, action, deviceId, policy.privateReceipts)
            else -> PushPayloadDecryptor.markRead(applicationContext, action, deviceId, policy.privateReceipts)
        }
        // The reply's spinner shows until the notification is re-posted, so only receipts retry.
        if (!done && action.kind == PushActions.MARK_READ && runAttemptCount < MAX_RETRIES) return Result.retry()
        action.text?.let { PushNotifier.showReply(applicationContext, action.notificationId, it, done) }
        file.delete()
        return if (done) Result.success() else Result.failure()
    }

    companion object {
        private const val ACTION_ID = "actionId"
        private const val DIRECTORY = "conversation-actions"
        private const val MAX_RETRIES = 3

        internal fun enqueue(context: Context, action: ConversationAction) {
            val directory = File(context.noBackupFilesDir, DIRECTORY).apply { mkdirs() }
            directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000L }?.forEach { it.delete() }
            val file = File(directory, action.id)
            file.writeText(action.toJson())
            val request = OneTimeWorkRequestBuilder<ConversationActionWorker>()
                .setInputData(Data.Builder().putString(ACTION_ID, action.id).build())
            // An offline reply must fail while its spinner shows, not send hours later.
            if (action.kind == PushActions.MARK_READ) {
                request.setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            }
            try { WorkManager.getInstance(context).enqueue(request.build()) }
            catch (error: Exception) { file.delete(); throw error }
        }
    }
}
