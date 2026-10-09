package moe.sable.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import java.util.UUID
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import app.tauri.Logger
import org.json.JSONObject
import kotlin.math.abs

object PushNotifier {
    private const val TAG = "PushNotifier"
    private const val MESSAGES_CHANNEL_ID = "messages.v2"
    private const val INVITES_CHANNEL_ID = "invites"
    private const val CALLS_CHANNEL_ID = "calls"
    private const val GROUP_KEY = "matrix_messages"

    private const val RTC_NOTIFICATION_TYPE = "m.rtc.notification"
    private const val RTC_NOTIFICATION_TYPE_UNSTABLE = "org.matrix.msc4075.rtc.notification"
    private const val DEFAULT_RING_LIFETIME_MS = 30_000L
    private const val MAX_RING_LIFETIME_MS = 120_000L
    const val DIAGNOSTIC_EVENT_PREFIX = "\$sable-diagnostic-"
    private const val NOISY_KEY = "moe.sable.noisy"
    private const val ENCRYPTED_FLAG = "moe.sable.encrypted"
    private const val DIRECT_FLAG = "moe.sable.direct"
    internal const val NOTIFY_ONCE_WINDOW_MS = 5 * 60_000L

    fun show(context: Context, notification: JSONObject) {
        val policy = PushPolicy(context)
        if (!policy.notificationsEnabled) return
        val roomId = notification.optString("room_id")
        val userId = notification.optString("user_id")
        if (roomId.isEmpty() || userId.isEmpty()) return
        val id = roomNotificationId(userId, roomId)
        val encrypted = notification.optBoolean(ENCRYPTED_FLAG)
        val allowed = policy.showContent && (!encrypted || policy.showEncryptedContent)
        val body = notification.optJSONObject("content")?.optString("body")?.takeIf { it.isNotEmpty() }
        val revision = PushNotificationGate.revision(context, id)
        PushNotificationGate.post(context, id, revision) {
            post(context, notification, body.takeIf { allowed } ?: "New message", UUID.randomUUID().toString())
        }
    }

    fun showFromPush(context: Context, rawMessage: String, queuedRevision: String? = null) {
        val notification = MatrixPushPayload.parse(rawMessage) ?: run {
            PushDiagnostics.record(context, PushOutcome.INVALID_PAYLOAD)
            return
        }
        val roomId = notification.optString("room_id")
        val userId = notification.optString("user_id")
        val eventId = notification.optString("event_id")
        val trace = PushTrace(userId, roomId, eventId)
        if (eventId.startsWith(DIAGNOSTIC_EVENT_PREFIX)) {
            PushDiagnostics.record(context, PushOutcome.DIAGNOSTIC_RECEIVED, trace)
            return
        }
        if (!PushPolicy(context).notificationsEnabled) {
            PushDiagnostics.record(context, PushOutcome.DISABLED, trace)
            return
        }
        val store = PushPolicy(context)
        val deviceId = store.deviceIdFor(userId)
        if (roomId.isEmpty()) {
            if (deviceId != null && notification.optJSONObject("counts")?.optInt("unread", -1) == 0) {
                PushDiagnostics.record(context, PushOutcome.ACCOUNT_READ_DISMISSED, trace)
                dismissAccount(context, userId)
                return
            }
            PushDiagnostics.record(context, PushOutcome.MISSING_ROOM, trace)
            return
        }
        if (store.knowsAnyAccount() && deviceId == null) {
            PushDiagnostics.record(context, if (userId.isEmpty()) PushOutcome.MISSING_RECIPIENT else PushOutcome.WRONG_RECIPIENT, trace)
            return
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        val id = if (userId.isNotEmpty()) roomNotificationId(userId, roomId) else fallbackNotificationId(roomId)
        val revision = queuedRevision ?: PushNotificationGate.revision(context, id)
        if (notification.optJSONObject("counts")?.optInt("unread", -1) == 0) {
            PushDiagnostics.record(context, PushOutcome.READ_DISMISSED, trace)
            PushNotificationGate.dismiss(context, id) { manager.cancel(id) }
            return
        }
        if (synchronized(PushNotificationGate) { NotificationReceipts.shouldDrop(context, id, eventId) }) {
            PushDiagnostics.record(context, PushOutcome.REPLAY_DROPPED, trace)
            return
        }
        val generation = manager.activeNotifications.firstOrNull { it.id == id && it.tag == null }
            ?.notification?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?.messages?.firstOrNull { eventId.isNotEmpty() && it.extras.getString(EVENT_KEY) == eventId }
            ?.extras?.getString(GENERATION_KEY) ?: UUID.randomUUID().toString()
        if (!notification.has("type") && eventId.isNotEmpty() && deviceId != null) {
            when (val fetched = PushPayloadDecryptor.fetch(context, userId, deviceId, roomId, eventId)) {
                PushDecryptResult.Discard -> {
                    PushDiagnostics.record(context, PushOutcome.DISCARDED, trace)
                    return
                }
                is PushDecryptResult.Success -> {
                    val event = runCatching { JSONObject(fetched.clearEventJson) }.getOrNull()
                    if (event != null) mergeFetched(notification, event)
                    PushDiagnostics.record(context, if (event != null) PushOutcome.FETCHED else PushOutcome.FETCH_FAILED, trace)
                }
                else -> PushDiagnostics.record(context, PushOutcome.FETCH_FAILED, trace)
            }
        }
        val encrypted = notification.optString("type") == "m.room.encrypted"
        if (!encrypted) {
            if (isRing(notification)) {
                PushNotificationGate.post(context, id, revision) { postIncomingCall(context, notification, notification) }
                return
            }
            PushNotificationGate.post(context, id, revision) { post(context, notification, null, generation) }
            return
        }
        val event = encryptedEvent(notification)
        val local = if (deviceId != null && event != null) {
            PushPayloadDecryptor.decryptLocally(context, userId, deviceId, roomId, event)
        } else null
        when (local) {
            PushDecryptResult.Discard -> {
                PushDiagnostics.record(context, PushOutcome.DISCARDED, trace)
                return
            }
            is PushDecryptResult.Success -> {
                PushDiagnostics.record(context, PushOutcome.DECRYPTED, trace)
                val clear = runCatching { JSONObject(local.clearEventJson) }.getOrNull()
                if (clear == null) {
                    PushNotificationGate.post(context, id, revision) { post(context, notification, "Encrypted message", generation) }
                    return
                }
                showDecrypted(context, notification, clear, id, revision, generation, replacing = false)
                return
            }
            else -> {}
        }
        val quietly = local is PushDecryptResult.NeedsKey && local.quietly
        if (!quietly) {
            PushNotificationGate.post(context, id, revision) { post(context, notification, "Encrypted message", generation) }
            if (!store.showContent || !store.showEncryptedContent) {
                PushDiagnostics.record(context, PushOutcome.HIDDEN_BY_SETTING, trace)
                return
            }
        }
        if (deviceId == null) return
        val (clear, outcome) = decryptedEvent(context, notification, userId, deviceId)
        PushDiagnostics.record(context, outcome, trace)
        if (clear == null) return
        showDecrypted(context, notification, clear, id, revision, generation, replacing = !quietly)
    }

    private fun showDecrypted(
        context: Context,
        notification: JSONObject,
        clear: JSONObject,
        id: Int,
        revision: String,
        generation: String,
        replacing: Boolean,
    ) {
        val store = PushPolicy(context)
        if (!store.notificationsEnabled) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (isRing(clear)) {
            PushNotificationGate.post(context, id, revision) {
                if (replacing) manager.cancel(id)
                postIncomingCall(context, notification, clear)
            }
            return
        }
        if (clear.optBoolean(NOISY_KEY)) notification.put(NOISY_KEY, true)
        val allowed = store.showContent && store.showEncryptedContent
        val text = clear.optJSONObject("content")
            ?.optString("body")
            ?.takeIf { it.isNotEmpty() }
        if (text == null && allowed) PushDiagnostics.record(context, PushOutcome.EMPTY_BODY, traceOf(notification))
        val body = text?.takeIf { allowed }
        if (!replacing) {
            PushNotificationGate.post(context, id, revision) {
                post(context, notification, body ?: "Encrypted message", generation)
            }
            return
        }
        if (body == null) return
        PushNotificationGate.post(context, id, revision) {
            val stillCurrent = manager.activeNotifications.any {
                it.id == id && it.tag == null &&
                    NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification)
                        ?.messages?.any { message -> message.extras.getString(GENERATION_KEY) == generation } == true
            }
            if (stillCurrent) post(context, notification, body, generation, silent = true)
        }
    }

    internal fun mergeFetched(notification: JSONObject, event: JSONObject) {
        for (key in event.keys()) {
            if (!notification.has(key) && !event.isNull(key)) notification.put(key, event.get(key))
        }
    }

    internal fun alertCooling(alertedAt: Long?, now: Long): Boolean =
        alertedAt != null && now >= alertedAt && now - alertedAt < NOTIFY_ONCE_WINDOW_MS

    internal fun isNoisy(notification: JSONObject): Boolean {
        if (notification.optBoolean(NOISY_KEY)) return true
        val devices = notification.optJSONArray("devices") ?: return false
        for (index in 0 until devices.length()) {
            val tweaks = devices.optJSONObject(index)?.optJSONObject("tweaks") ?: continue
            if (tweaks.has("sound") || tweaks.optBoolean("highlight")) return true
        }
        return false
    }

    internal fun isRing(event: JSONObject): Boolean {
        val type = event.optString("type")
        if (type != RTC_NOTIFICATION_TYPE && type != RTC_NOTIFICATION_TYPE_UNSTABLE) return false
        return event.optJSONObject("content")?.optString("notification_type") == "ring"
    }

    private const val GENERATION_KEY = "sable.push.generation"
    private const val ALERTED_AT_KEY = "sable.push.alerted-at"
    private const val EVENT_KEY = ConversationHistory.EVENT_KEY
    private const val ENCRYPTED_KEY = ConversationHistory.ENCRYPTED_KEY
    private const val ACCOUNT_KEY = ConversationHistory.ACCOUNT_KEY

    private fun dismissAccount(context: Context, userId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications
            .filter { it.tag == null && it.notification.extras.getString(ACCOUNT_KEY) == userId }
            .forEach { active -> PushNotificationGate.dismiss(context, active.id) { manager.cancel(active.id) } }
    }

    private fun post(
        context: Context,
        notification: JSONObject,
        preview: String?,
        generation: String,
        silent: Boolean = false,
    ) {
        val roomId = notification.optString("room_id")
        val eventId = notification.optString("event_id")
        val sender = notification.optString("sender_display_name")
        val isInvite = notification.optString("type") == "m.room.member" &&
            notification.optJSONObject("content")?.optString("membership") == "invite"
        val roomName = notification.optString("room_name")
        val title = if (isInvite) {
            "New Invitation"
        } else {
            roomName.ifEmpty { sender.ifEmpty { "New message" } }
        }
        val text = if (isInvite) null else preview ?: messageText(context, notification)
        val body = if (isInvite) buildInviteBody(sender, roomName) else buildBody(sender, text.orEmpty())
        val channelId = if (isInvite) INVITES_CHANNEL_ID else MESSAGES_CHANNEL_ID

        val userId = notification.optString("user_id")

        ensureChannels(context)

        val iconId = context.resources
            .getIdentifier("notification_icon", "drawable", context.packageName)
            .takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info

        val notifId = if (userId.isNotEmpty() && roomId.isNotEmpty()) {
            roomNotificationId(userId, roomId)
        } else {
            Logger.warn(
                Logger.tags(TAG),
                "Push payload has no user_id; cold notification will not match warm identity"
            )
            fallbackNotificationId(roomId.ifEmpty { eventId })
        }

        if (NotificationReceipts.shouldDrop(context, notifId, eventId)) {
            PushDiagnostics.record(context, PushOutcome.REPLAY_DROPPED, traceOf(notification))
            return
        }
        var actionEventId = eventId

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

        val state = PushPolicy(context)
        val alertedAt = context.getSystemService(NotificationManager::class.java)
            .activeNotifications.firstOrNull { it.id == notifId && it.tag == null }
            ?.notification?.extras?.getLong(ALERTED_AT_KEY)?.takeIf { it > 0 }
        val now = System.currentTimeMillis()
        val cooling = state.notifyOnce && !isNoisy(notification) && alertCooling(alertedAt, now)
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(iconId)
            .addExtras(Bundle().apply {
                putString(GENERATION_KEY, generation)
                if (userId.isNotEmpty()) putString(ACCOUNT_KEY, userId)
            })
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(silent || cooling)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup(GROUP_KEY)

        if (silent || !state.notificationSounds) builder.setSilent(true)
        val alerts = !silent && !cooling
        var repeat = false

        if (isInvite) {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        } else {
            val messages = ConversationHistory.read(context, notifId).toMutableList()
            val index = messages.indexOfFirst { eventId.isNotEmpty() && it.extras.getString(EVENT_KEY) == eventId }
            if (index >= 0 && !silent && state.showContent && state.showEncryptedContent) return
            if (index >= 0) builder.setSilent(true)
            repeat = index >= 0
            val stamp = if (alerts && index < 0) now else alertedAt
            if (stamp != null) builder.addExtras(Bundle().apply { putLong(ALERTED_AT_KEY, stamp) })
            val incoming = NotificationCompat.MessagingStyle.Message(
                if (!state.showContent) "New message" else text.orEmpty(),
                if (index >= 0) messages[index].timestamp else System.currentTimeMillis(),
                sender.takeIf { it.isNotEmpty() }?.let { Person.Builder().setName(it).build() }
            ).also {
                it.extras.putString(EVENT_KEY, eventId)
                it.extras.putString(GENERATION_KEY, generation)
                it.extras.putBoolean(ENCRYPTED_KEY, notification.optString("type") == "m.room.encrypted" || notification.optBoolean(ENCRYPTED_FLAG))
            }
            if (ConversationHistory.shows(context, notifId, eventId.ifEmpty { null }, incoming.text.toString())) return
            if (index >= 0) {
                if (silent) messages[index] = incoming
            } else messages.add(incoming)
            val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
            if (roomName.isNotEmpty() && !notification.optBoolean(DIRECT_FLAG)) {
                style.conversationTitle = roomName
                style.isGroupConversation = true
            }
            messages.takeLast(ConversationHistory.LIMIT).forEach { style.addMessage(it) }
            messages.lastOrNull()?.let { builder.setWhen(it.timestamp) }
            actionEventId = messages.lastOrNull()?.extras?.getString(EVENT_KEY)?.takeIf { it.isNotEmpty() } ?: eventId
            builder.setStyle(style)
        }

        val intent = buildPushIntent(context, notifId, roomId, actionEventId, userId)
        builder.setContentIntent(PendingIntent.getActivity(context, notifId, intent, flags))
        if (isInvite) {
            addActions(context, builder, notifId, roomId, actionEventId, userId, flags, PushActions.INVITE_TYPE, PushActions.invite)
        } else {
            addActions(context, builder, notifId, roomId, actionEventId, userId, flags, PushActions.MESSAGE_TYPE, PushActions.message)
        }

        val built = builder.build()
        NotificationManagerCompat.from(context).notify(notifId, built)
        NotificationReceipts.record(context, notifId, eventId)
        AlertLog.posted(
            context, "push", traceOf(notification), built,
            listOfNotNull(
                "replacement".takeIf { silent },
                "notify-once".takeIf { cooling },
                "sounds-off".takeIf { !state.notificationSounds },
                "repeat".takeIf { repeat },
            ),
            listOf(
                "noisy=${isNoisy(notification)}",
                "notifyOnce=${state.notifyOnce}",
                "alertedAgoMs=${alertedAt?.let { now - it }}",
            ),
        )
    }

    private fun postIncomingCall(context: Context, notification: JSONObject, event: JSONObject) {
        ensureChannels(context)

        val roomId = notification.optString("room_id")
        val userId = notification.optString("user_id")
        val eventId = event.optString("event_id").ifEmpty { notification.optString("event_id") }
        val caller = notification.optString("sender_display_name")
            .ifEmpty { notification.optString("room_name") }
            .ifEmpty { notification.optString("sender") }
            .ifEmpty { "Unknown caller" }

        val notifId = callNotificationId(userId, roomId)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        fun pending(action: String) = PendingIntent.getActivity(
            context,
            notifId + action.hashCode(),
            buildPushIntent(context, notifId, roomId, eventId, userId, action, PushActions.CALL_TYPE),
            flags,
        )

        val iconId = context.resources
            .getIdentifier("notification_icon", "drawable", context.packageName)
            .takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info
        val fullScreen = pending(NotificationIntents.DEFAULT_PRESS)

        val builder = NotificationCompat.Builder(context, CALLS_CHANNEL_ID)
            .setSmallIcon(iconId)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    Person.Builder().setName(caller).setImportant(true).build(),
                    pending(PushActions.DECLINE_CALL),
                    pending(PushActions.ANSWER_CALL),
                )
            )
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            .setTimeoutAfter(ringLifetimeMs(event))

        NotificationManagerCompat.from(context).notify(notifId, builder.build())
        PushDiagnostics.record(context, PushOutcome.POSTED, traceOf(notification))
    }

    private fun ringLifetimeMs(event: JSONObject): Long {
        val lifetime = event.optJSONObject("content")?.optLong("lifetime", 0L) ?: 0L
        if (lifetime <= 0L) return DEFAULT_RING_LIFETIME_MS
        return lifetime.coerceAtMost(MAX_RING_LIFETIME_MS)
    }

    internal fun callNotificationId(userId: String, roomId: String): Int =
        roomNotificationId(userId, roomId + '\u0000' + "call")

    private fun addActions(
        context: Context,
        builder: NotificationCompat.Builder,
        notifId: Int,
        roomId: String,
        eventId: String,
        userId: String,
        flags: Int,
        actionTypeId: String,
        actions: List<PushAction>,
    ) {
        for (action in actions) {
            val actionIntent = buildPushIntent(context, notifId, roomId, eventId, userId, action.id, actionTypeId)
            val actionFlags = when {
                !action.input -> flags
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                else -> PendingIntent.FLAG_UPDATE_CURRENT
            }
            val requestCode = notifId + action.id.hashCode()
            val pending = if (!action.input && !action.foreground) {
                val receiver = Intent().setClassName(context, NotificationIntents.ACTION_RECEIVER).putExtras(actionIntent)
                PendingIntent.getBroadcast(context, requestCode, receiver, actionFlags)
            } else {
                PendingIntent.getActivity(context, requestCode, actionIntent, actionFlags)
            }
            val actionBuilder = NotificationCompat.Action.Builder(R.drawable.ic_transparent, action.title, pending)
            if (action.input) {
                actionBuilder.addRemoteInput(
                    RemoteInput.Builder(NotificationIntents.REMOTE_INPUT).setLabel(action.title).build()
                )
            }
            builder.addAction(actionBuilder.build())
        }
    }

    internal fun roomNotificationId(userId: String, roomId: String): Int {
        val hash = userId + '\u0000' + roomId
        return hash.hashCode().let { if (it == Int.MIN_VALUE) 0 else abs(it) }
    }

    internal fun fallbackNotificationId(roomOrEventKey: String): Int =
        roomOrEventKey.hashCode() and Int.MAX_VALUE

    private fun buildPushIntent(
        context: Context,
        notifId: Int,
        roomId: String,
        eventId: String,
        userId: String,
        action: String = NotificationIntents.DEFAULT_PRESS,
        actionTypeId: String = PushActions.MESSAGE_TYPE
    ): Intent {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent(Intent.ACTION_MAIN).setPackage(context.packageName)
        intent.action = Intent.ACTION_MAIN
        intent.addCategory(Intent.CATEGORY_LAUNCHER)
        intent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        intent.putExtra(NotificationIntents.NOTIFICATION_ID, notifId)
        intent.putExtra(NotificationIntents.ACTION, action)
        intent.putExtra(NotificationIntents.REMOVABLE, true)

        val extraJson = JSONObject().apply {
            put("room_id", roomId)
            put("event_id", eventId)
            if (userId.isNotEmpty()) put("user_id", userId)
            put("instance", NotificationIntents.INSTANCE)
        }
        val sourceJson = JSONObject().apply {
            put("id", notifId)
            put("extra", extraJson)
            put("actionTypeId", actionTypeId)
        }.toString()
        intent.putExtra(NotificationIntents.NOTIFICATION_OBJECT, sourceJson)

        return intent
    }

    private fun traceOf(notification: JSONObject) = PushTrace(
        notification.optString("user_id"),
        notification.optString("room_id"),
        notification.optString("event_id"),
    )

    private fun messageText(context: Context, notification: JSONObject): String {
        if (!PushPolicy(context).showContent) return "New message"
        if (notification.optString("type") != "m.room.encrypted") {
            PushDiagnostics.record(context, PushOutcome.PLAINTEXT, traceOf(notification))
            return notification.optJSONObject("content")
                ?.optString("body")
                ?.takeIf { it.isNotEmpty() }
                ?: "New message"
        }

        return "Encrypted message"
    }

    private fun encryptedEvent(notification: JSONObject): String? {
        val roomId = notification.optString("room_id").takeIf { it.isNotEmpty() } ?: return null
        val content = notification.optJSONObject("content") ?: return null
        return JSONObject()
            .put("type", "m.room.encrypted")
            .put("room_id", roomId)
            .put("content", content)
            .put("event_id", notification.optString("event_id"))
            .put("sender", notification.optString("sender"))
            .put("origin_server_ts", System.currentTimeMillis())
            .toString()
    }

    private fun decryptedEvent(
        context: Context,
        notification: JSONObject,
        userId: String,
        deviceId: String
    ): Pair<JSONObject?, PushOutcome> {
        val roomId = notification.optString("room_id")
        val event = encryptedEvent(notification) ?: return null to PushOutcome.NO_CONTENT

        val clear = when (
            val result = PushPayloadDecryptor.decrypt(context, userId, deviceId, roomId, event)
        ) {
            is PushDecryptResult.Success -> result.clearEventJson
            PushDecryptResult.Discard -> return null to PushOutcome.DISCARDED
            is PushDecryptResult.NeedsKey -> return null to PushOutcome.DECRYPT_FAILED
            is PushDecryptResult.Failure -> return null to result.outcome
        }

        val clearEvent = try {
            JSONObject(clear)
        } catch (_: Exception) {
            null
        }

        return if (clearEvent == null) {
            null to PushOutcome.EMPTY_BODY
        } else {
            clearEvent to PushOutcome.DECRYPTED
        }
    }

    private fun buildBody(sender: String, text: String): String {
        val prefix = if (sender.isNotEmpty()) "$sender: " else ""
        return "$prefix$text"
    }

    private fun buildInviteBody(sender: String, roomName: String): String = when {
        sender.isNotEmpty() && roomName.isNotEmpty() -> "$sender invites you to $roomName"
        sender.isNotEmpty() -> "from $sender"
        roomName.isNotEmpty() -> "to $roomName"
        else -> ""
    }

    private fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        ensureChannel(
            manager,
            MESSAGES_CHANNEL_ID,
            "Messages",
            "Matrix message notifications",
            NotificationManager.IMPORTANCE_HIGH
        )
        ensureChannel(
            manager,
            INVITES_CHANNEL_ID,
            "Invitations",
            "Room and space invitations",
            NotificationManager.IMPORTANCE_DEFAULT
        )
        ensureChannel(
            manager,
            CALLS_CHANNEL_ID,
            "Calls",
            "Incoming calls",
            NotificationManager.IMPORTANCE_HIGH
        ) { channel ->
            channel.setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            channel.enableVibration(true)
            channel.lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
        }
    }

    private fun ensureChannel(
        manager: NotificationManager,
        id: String,
        name: String,
        channelDescription: String,
        importance: Int,
        configure: (NotificationChannel) -> Unit = {}
    ) {
        if (manager.getNotificationChannel(id) != null) return
        manager.createNotificationChannel(
            NotificationChannel(id, name, importance).apply {
                description = channelDescription
                configure(this)
            }
        )
    }
}
