package moe.sable.push

import android.content.Context
import app.tauri.notification.PushDelegate

class SablePushDelegate : PushDelegate {
    override fun isActivation(payload: String): Boolean =
        MatrixPushPayload.parse(payload)?.optString("ack_token")?.isNotEmpty() == true

    override fun render(context: Context, payload: String, encrypted: Boolean) =
        PushNotifier.showFromPush(context, if (encrypted) payload else MatrixPushPayload.routingOnly(payload))

    override fun schedule(context: Context, payload: String, encrypted: Boolean) =
        PushRenderWorker.enqueue(context, if (encrypted) payload else MatrixPushPayload.routingOnly(payload))

    override fun endpointChanged(context: Context, endpoint: String, p256dh: String?, auth: String?) =
        PushRegistrationWorker.enqueue(context, null, endpoint, p256dh, auth)

    override fun endpointChanged(context: Context, instance: String, endpoint: String, p256dh: String?, auth: String?) =
        PushRegistrationWorker.enqueue(context, instance, endpoint, p256dh, auth)

    override fun record(context: Context, outcome: String) {
        PushOutcome.entries.firstOrNull { it.name == outcome }?.let { PushDiagnostics.record(context, it) }
    }
}
