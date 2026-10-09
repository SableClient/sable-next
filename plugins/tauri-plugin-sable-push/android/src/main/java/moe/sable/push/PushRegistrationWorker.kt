package moe.sable.push

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject

class PushRegistrationWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val policy = PushPolicy(applicationContext)
        if (!policy.notificationsEnabled) return Result.success()
        val (user, device) = policy.accounts.entries.firstOrNull() ?: return Result.failure()
        val endpoint = inputData.getString(ENDPOINT) ?: return Result.failure()
        val operation = JSONObject().put("operation", "rotate")
            .put("user_id", user).put("device_id", device).put("endpoint", endpoint)
            .put("p256dh", inputData.getString(P256DH)).put("auth", inputData.getString(AUTH))
        return if (PushPayloadDecryptor.maintain(applicationContext, operation.toString())) Result.success()
        else if (runAttemptCount < 5) Result.retry() else Result.failure()
    }

    companion object {
        private const val ENDPOINT = "endpoint"
        private const val P256DH = "p256dh"
        private const val AUTH = "auth"

        fun enqueue(context: Context, endpoint: String, p256dh: String?, auth: String?) {
            val request = OneTimeWorkRequestBuilder<PushRegistrationWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(
                    Data.Builder().putString(ENDPOINT, endpoint).putString(P256DH, p256dh).putString(AUTH, auth).build()
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("push-registration", ExistingWorkPolicy.REPLACE, request)
        }
    }
}
