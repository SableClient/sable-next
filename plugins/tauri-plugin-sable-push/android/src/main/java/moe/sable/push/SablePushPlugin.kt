package moe.sable.push

import android.app.Activity
import android.app.NotificationManager
import androidx.work.WorkManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import org.json.JSONObject

@InvokeArg
class PostArgs {
    var userId: String = ""
    var roomId: String = ""
    var eventId: String? = null
    var roomName: String = ""
    var senderName: String? = null
    var body: String = ""
    var encrypted: Boolean = false
    var direct: Boolean = false
    var noisy: Boolean = false
}

@InvokeArg
class DismissArgs {
    var ids: List<Int> = emptyList()
}

@InvokeArg
class AccountArgs {
    var userId: String = ""
    var deviceId: String = ""
}

@InvokeArg
class AccountsArgs {
    var accounts: List<AccountArgs> = emptyList()
}

@InvokeArg
class PolicyArgs {
    var enabled: Boolean = false
    var content: Boolean = false
    var encryptedContent: Boolean = false
    var sounds: Boolean = true
    var notifyOnce: Boolean = true
}

@TauriPlugin
class SablePushPlugin(private val activity: Activity) : Plugin(activity) {
    private val manager = activity.getSystemService(NotificationManager::class.java)

    @Command
    fun post(invoke: Invoke) {
        val args = invoke.parseArgs(PostArgs::class.java)
        PushNotifier.show(
            activity,
            JSONObject()
                .put("user_id", args.userId)
                .put("room_id", args.roomId)
                .put("event_id", args.eventId.orEmpty())
                .put("room_name", args.roomName)
                .put("sender_display_name", args.senderName.orEmpty())
                .put("content", JSONObject().put("body", args.body))
                .put("moe.sable.encrypted", args.encrypted)
                .put("moe.sable.direct", args.direct)
                .put("moe.sable.noisy", args.noisy),
        )
        invoke.resolve()
    }

    @Command
    fun dismiss(invoke: Invoke) {
        dismiss(invoke.parseArgs(DismissArgs::class.java).ids)
        invoke.resolve()
    }

    @Command
    fun dismissShown(invoke: Invoke) {
        val shown = manager.activeNotifications.filter { it.tag == null }.map { it.id }.toSet()
        dismiss(invoke.parseArgs(DismissArgs::class.java).ids.filter { it in shown })
        invoke.resolve()
    }

    @Command
    fun dismissAll(invoke: Invoke) {
        dismissAll()
        invoke.resolve()
    }

    @Command
    fun setAccounts(invoke: Invoke) {
        PushPolicy(activity).accounts = invoke.parseArgs(AccountsArgs::class.java).accounts
            .filter { it.userId.isNotEmpty() && it.deviceId.isNotEmpty() }
            .associate { it.userId to it.deviceId }
        invoke.resolve()
    }

    @Command
    fun setPolicy(invoke: Invoke) {
        val args = invoke.parseArgs(PolicyArgs::class.java)
        val policy = PushPolicy(activity)
        policy.notificationsEnabled = args.enabled
        policy.showContent = args.content
        policy.showEncryptedContent = args.encryptedContent
        policy.notificationSounds = args.sounds
        policy.notifyOnce = args.notifyOnce
        if (!args.enabled || !args.content) dismissAll()
        invoke.resolve()
    }

    @Command
    fun pushHistory(invoke: Invoke) {
        val data = JSObject()
        data.put("entries", JSArray(PushDiagnostics.history(activity.applicationContext).toString()))
        invoke.resolve(data)
    }

    @Command
    fun clearPushHistory(invoke: Invoke) {
        PushDiagnostics.clearHistory(activity.applicationContext)
        invoke.resolve()
    }

    @Command
    fun takePushDiagnostics(invoke: Invoke) {
        val snapshot = PushDiagnostics.drain(activity.applicationContext)
        val counts = JSObject()
        snapshot.counts.forEach { (outcome, count) -> counts.put(outcome, count) }
        val data = JSObject()
        data.put("counts", counts)
        snapshot.lastOutcome?.let { data.put("lastOutcome", it) }
        data.put("lastAt", snapshot.lastAt)
        invoke.resolve(data)
    }

    private fun dismiss(ids: List<Int>) {
        for (id in ids) {
            WorkManager.getInstance(activity).cancelAllWorkByTag("push-room:$id")
            PushNotificationGate.dismiss(activity, id) { manager.cancel(id) }
        }
    }

    private fun dismissAll() {
        WorkManager.getInstance(activity).cancelAllWorkByTag("push-render")
        PushNotificationGate.dismiss(activity, null) { manager.cancelAll() }
    }
}
