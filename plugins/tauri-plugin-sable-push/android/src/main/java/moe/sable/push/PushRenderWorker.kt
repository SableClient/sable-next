package moe.sable.push

import android.content.Context
import android.os.Build
import androidx.work.Data
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File
import java.util.UUID

class PushRenderWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val id = inputData.getString("payloadId") ?: return Result.failure()
        if (runCatching { UUID.fromString(id).toString() }.getOrNull() != id) return Result.failure()
        val file = File(applicationContext.noBackupFilesDir, "push-work/$id")
        val payload = runCatching { file.readText() }.getOrNull() ?: return Result.failure()
        val validation = runCatching { JSONObject(payload) }.getOrNull()
        if (validation?.has("ack_token") == true && validation.has("app_id") && !validation.has("notification")) {
            validation.put("operation", "activate")
            if (PushPayloadDecryptor.maintain(applicationContext, validation.toString())) {
                file.delete()
                return Result.success()
            }
            if (runAttemptCount < 3) return Result.retry()
            file.delete()
            return Result.failure()
        }
        if (!isStopped) PushNotifier.showFromPush(applicationContext, payload, inputData.getString("revision"))
        file.delete()
        return Result.success()
    }

    companion object {
        fun enqueue(context: Context, payload: String) {
            val notification = MatrixPushPayload.parse(payload)
            if (notification?.optJSONObject("counts")?.optInt("unread", -1) == 0) {
                PushNotifier.showFromPush(context, payload)
                return
            }
            val directory = File(context.noBackupFilesDir, "push-work").apply { mkdirs() }
            directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000L }?.forEach { it.delete() }
            val id = UUID.randomUUID().toString()
            val file = File(directory, id)
            file.writeText(payload)
            val data = Data.Builder().putString("payloadId", id)
            val activation = notification?.has("ack_token") == true && notification.has("app_id")
            val request = OneTimeWorkRequestBuilder<PushRenderWorker>()
                .addTag(if (activation) "push-activation" else "push-render")
            if (activation) {
                request.setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            }
            if (!activation) notification?.let { notification ->
                val room = notification.optString("room_id")
                val user = notification.optString("user_id")
                if (room.isNotEmpty() && user.isNotEmpty()) {
                    val notificationId = PushNotifier.roomNotificationId(user, room)
                    request.addTag("push-room:$notificationId")
                    data.putString("revision", PushNotificationGate.revision(context, notificationId))
                }
            }
            request.setInputData(data.build())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            }
            try { WorkManager.getInstance(context).enqueue(request.build()) }
            catch (error: Exception) { file.delete(); throw error }
        }
    }
}
