package moe.sable.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import java.io.File
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.FileProvider
import androidx.core.graphics.drawable.IconCompat
import app.tauri.Logger
import org.json.JSONObject
import kotlin.math.abs

object PushNotifier {
    private const val TAG = "PushNotifier"
    private const val MESSAGES_CHANNEL_ID = "messages.v2"
    private const val INVITES_CHANNEL_ID = "invites"
    private const val CALLS_CHANNEL_ID = "calls"
    private const val GROUP_KEY = "matrix_messages"
    /** Notification ids derive from non-negative hashes, so a negative id never names a conversation. */
    internal const val SUMMARY_ID = -1

    private const val RTC_NOTIFICATION_TYPE = "m.rtc.notification"
    private const val RTC_NOTIFICATION_TYPE_UNSTABLE = "org.matrix.msc4075.rtc.notification"
    private const val DEFAULT_RING_LIFETIME_MS = 30_000L
    private const val MAX_RING_LIFETIME_MS = 120_000L
    const val DIAGNOSTIC_EVENT_PREFIX = "\$sable-diagnostic-"
    private const val NOISY_KEY = "moe.sable.noisy"
    private const val ENCRYPTED_FLAG = "moe.sable.encrypted"
    private const val DIRECT_FLAG = "moe.sable.direct"
    private const val SENDER_NAME_KEY = "moe.sable.sender_name"
    private const val SENDER_AVATAR_KEY = "moe.sable.sender_avatar"
    private const val ROOM_AVATAR_KEY = "moe.sable.room_avatar"
    private const val OWN_AVATAR_KEY = "moe.sable.own_avatar"
    private const val OWN_NAME_KEY = "moe.sable.own_name"
    private const val IMAGE_KEY = "moe.sable.image"
    private const val IMAGE_TYPE_KEY = "moe.sable.image_type"
    private const val RECEIVED_AT_KEY = "moe.sable.received_at"
    internal const val NOTIFY_ONCE_WINDOW_MS = 5 * 60_000L

    fun show(context: Context, notification: JSONObject, receivedAt: Long = System.currentTimeMillis()) {
        val policy = PushPolicy(context)
        if (!policy.notificationsEnabled) return
        val roomId = notification.optString("room_id")
        val userId = notification.optString("user_id")
        if (roomId.isEmpty() || userId.isEmpty()) return
        notification.put(RECEIVED_AT_KEY, receivedAt)
        val id = roomNotificationId(userId, roomId)
        val encrypted = notification.optBoolean(ENCRYPTED_FLAG)
        val allowed = policy.showContent && (!encrypted || policy.showEncryptedContent)
        val body = if (allowed) PushPayloadDecryptor.previewBody(context, notification.optJSONObject("content")) else null
        val revision = PushNotificationGate.revision(context, id)
        attachMedia(context, notification, roomId,
            content = notification.optJSONObject("content")?.takeIf { allowed })
        PushNotificationGate.post(context, id, revision) {
            post(context, notification, body ?: "New message")
        }
    }

    fun showFromPush(
        context: Context,
        rawMessage: String,
        queuedRevision: String? = null,
        receivedAt: Long = System.currentTimeMillis(),
    ) {
        val notification = MatrixPushPayload.parse(rawMessage) ?: run {
            PushDiagnostics.record(context, PushOutcome.INVALID_PAYLOAD)
            return
        }
        val roomId = notification.optString("room_id")
        val store = PushPolicy(context)
        val userId = notification.optString("user_id")
            .ifEmpty { store.soleAccount().orEmpty() }
        if (userId.isNotEmpty()) notification.put("user_id", userId)
        val eventId = notification.optString("event_id")
        val trace = PushTrace(userId, roomId, eventId)
        if (eventId.startsWith(DIAGNOSTIC_EVENT_PREFIX)) {
            PushDiagnostics.record(context, PushOutcome.DIAGNOSTIC_RECEIVED, trace)
            return
        }
        if (!store.notificationsEnabled) {
            PushDiagnostics.record(context, PushOutcome.DISABLED, trace)
            return
        }
        val deviceId = store.deviceIdFor(userId)
        if (roomId.isEmpty()) {
            if (deviceId != null && notification.optJSONObject("counts")?.optInt("unread", -1) == 0) {
                if (!store.clearOnRead) {
                    PushDiagnostics.record(context, PushOutcome.READ_KEPT, trace)
                    return
                }
                PushDiagnostics.record(context, PushOutcome.ACCOUNT_READ_DISMISSED, trace)
                dismissAccount(context, userId)
                return
            }
            val manager = context.getSystemService(NotificationManager::class.java)
            if (store.clearOnRead && deviceId != null && reconcileRead(context, manager, userId, deviceId, roomId)) {
                PushDiagnostics.record(context, PushOutcome.READ_DISMISSED, trace)
            }
            PushDiagnostics.record(context, PushOutcome.MISSING_ROOM, trace)
            return
        }
        if (store.knowsAnyAccount() && deviceId == null) {
            PushDiagnostics.record(context, if (userId.isEmpty()) PushOutcome.MISSING_RECIPIENT else PushOutcome.WRONG_RECIPIENT, trace)
            return
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        if (store.clearOnRead && deviceId != null && reconcileRead(context, manager, userId, deviceId, roomId)) {
            PushDiagnostics.record(context, PushOutcome.READ_DISMISSED, trace)
        }
        val id = if (userId.isNotEmpty()) roomNotificationId(userId, roomId) else fallbackNotificationId(roomId)
        val revision = queuedRevision ?: PushNotificationGate.revision(context, id)
        if (eventId.isEmpty() && dismissReadUpdate(context, notification, id)) return
        if (eventId.isEmpty()) {
            PushDiagnostics.record(context, PushOutcome.NO_CONTENT, trace)
            return
        }
        if (isRedacted(notification)) {
            PushDiagnostics.record(context, PushOutcome.DISCARDED, trace)
            return
        }
        notification.put(RECEIVED_AT_KEY, receivedAt)
        if (synchronized(PushNotificationGate) { NotificationReceipts.shouldDrop(context, id, eventId) }) {
            PushDiagnostics.record(context, PushOutcome.REPLAY_DROPPED, trace)
            return
        }
        val rtcInvite = isRtcInvite(notification)
        if (rtcInvite && deviceId == null) {
            PushDiagnostics.record(context, PushOutcome.DISCARDED, trace)
            return
        }
        if ((notification.optString("type").isEmpty() || notification.optJSONObject("content") == null || rtcInvite) && deviceId != null) {
            when (val fetched = PushPayloadDecryptor.fetch(context, userId, deviceId, roomId, eventId)) {
                PushDecryptResult.Discard -> {
                    PushDiagnostics.record(context, PushOutcome.DISCARDED, trace)
                    return
                }
                PushDecryptResult.DiscardUnevaluated -> {
                    PushDiagnostics.record(context, PushOutcome.RULES_UNEVALUATED, trace)
                    return
                }
                is PushDecryptResult.Success -> {
                    val event = runCatching { JSONObject(fetched.clearEventJson) }.getOrNull()
                    if (event != null) {
                        mergeFetched(notification, event)
                        PushDiagnostics.record(context, PushOutcome.FETCHED, trace)
                        if (isRedacted(notification)) {
                            PushDiagnostics.record(context, PushOutcome.DISCARDED, trace)
                            return
                        }
                    } else {
                        PushDiagnostics.record(context, PushOutcome.FETCH_FAILED, trace)
                        if (rtcInvite) return
                    }
                }
                else -> {
                    PushDiagnostics.record(context, PushOutcome.FETCH_FAILED, trace)
                    if (rtcInvite) return
                }
            }
        }
        val encrypted = notification.optString("type") == "m.room.encrypted"
        if (!encrypted) {
            if (!isRtcInvite(notification) && dismissReadUpdate(context, notification, id)) return
            if (isRing(notification)) {
                attachMedia(context, notification, roomId, content = null)
                PushNotificationGate.post(context, id, revision) { postIncomingCall(context, notification, notification) }
                return
            }
            if (quietForActiveElsewhere(context, store, notification)) {
                PushDiagnostics.record(context, PushOutcome.ACTIVE_ELSEWHERE, trace)
                return
            }
            val previews = store.showContent &&
                (store.showEncryptedContent || !notification.optBoolean(ENCRYPTED_FLAG))
            attachMedia(context, notification, roomId,
                content = notification.optJSONObject("content")?.takeIf { previews })
            PushNotificationGate.post(context, id, revision) { post(context, notification, null) }
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
            PushDecryptResult.DiscardUnevaluated -> {
                PushDiagnostics.record(context, PushOutcome.RULES_UNEVALUATED, trace)
                return
            }
            is PushDecryptResult.Success -> {
                PushDiagnostics.record(context, PushOutcome.DECRYPTED, trace)
                val clear = runCatching { JSONObject(local.clearEventJson) }.getOrNull()
                if (clear == null && quietForActiveElsewhere(context, store, notification)) {
                    PushDiagnostics.record(context, PushOutcome.ACTIVE_ELSEWHERE, trace)
                    return
                }
                if (clear == null) {
                    if (dismissReadUpdate(context, notification, id)) return
                    attachMedia(context, notification, roomId, content = null)
                    PushNotificationGate.post(context, id, revision) { post(context, notification, "Encrypted message") }
                    return
                }
                showDecrypted(context, notification, clear, id, revision)
                return
            }
            else -> {}
        }
        val quietly = local is PushDecryptResult.NeedsKey && local.quietly
        val (clear, outcome) = if (deviceId != null) {
            decryptedEvent(context, notification, userId, deviceId)
        } else null to PushOutcome.DECRYPT_FAILED
        PushDiagnostics.record(context, outcome, trace)
        if (clear != null) {
            showDecrypted(context, notification, clear, id, revision)
        } else if (!quietly && outcome != PushOutcome.DISCARDED && outcome != PushOutcome.RULES_UNEVALUATED) {
            if (dismissReadUpdate(context, notification, id)) return
            if (quietForActiveElsewhere(context, store, notification)) {
                PushDiagnostics.record(context, PushOutcome.ACTIVE_ELSEWHERE, trace)
                return
            }
            attachMedia(context, notification, roomId, content = null)
            PushNotificationGate.post(context, id, revision) { post(context, notification, "Encrypted message") }
        }
    }

    private fun quietForActiveElsewhere(context: Context, store: PushPolicy, notification: JSONObject): Boolean {
        if (isInvite(notification) || !store.quietWhenActiveElsewhere) return false
        val userId = notification.optString("user_id")
        val deviceId = store.deviceIdFor(userId) ?: return false
        return PushPayloadDecryptor.activeElsewhere(context, userId, deviceId, notification.optString("room_id"))
    }

    private fun dismissReadUpdate(context: Context, notification: JSONObject, id: Int): Boolean {
        if (notification.optJSONObject("counts")?.optInt("unread", -1) != 0) return false
        if (PushPolicy(context).clearOnRead) {
            PushDiagnostics.record(context, PushOutcome.READ_DISMISSED, traceOf(notification))
            val manager = context.getSystemService(NotificationManager::class.java)
            PushNotificationGate.dismiss(context, id) { manager.cancel(id) }
            cancelOrphanedSummary(context)
        } else {
            PushDiagnostics.record(context, PushOutcome.READ_KEPT, traceOf(notification))
        }
        return true
    }

    private fun showDecrypted(
        context: Context,
        notification: JSONObject,
        clear: JSONObject,
        id: Int,
        revision: String,
    ) {
        val store = PushPolicy(context)
        if (!store.notificationsEnabled) return
        if (isRedacted(clear)) {
            PushDiagnostics.record(context, PushOutcome.DISCARDED, traceOf(notification))
            return
        }
        if (!isRtcInvite(clear) && dismissReadUpdate(context, notification, id)) return
        if (isRing(clear)) {
            attachMedia(context, notification, notification.optString("room_id"), content = null)
            PushNotificationGate.post(context, id, revision) {
                postIncomingCall(context, notification, clear)
            }
            return
        }
        if (quietForActiveElsewhere(context, store, notification)) {
            PushDiagnostics.record(context, PushOutcome.ACTIVE_ELSEWHERE, traceOf(notification))
            return
        }
        if (clear.optBoolean(NOISY_KEY)) notification.put(NOISY_KEY, true)
        val allowed = store.showContent && store.showEncryptedContent
        attachMedia(context, notification, notification.optString("room_id"),
            content = clear.optJSONObject("content")?.takeIf { allowed })
        val text = if (allowed) PushPayloadDecryptor.previewBody(context, clear.optJSONObject("content")) else null
        if (text == null && allowed) PushDiagnostics.record(context, PushOutcome.EMPTY_BODY, traceOf(notification))
        PushNotificationGate.post(context, id, revision) {
            post(context, notification, text ?: "Encrypted message")
        }
    }

    private fun attachMedia(
        context: Context,
        notification: JSONObject,
        roomId: String,
        content: JSONObject?,
    ) {
        val userId = notification.optString("user_id")
        val deviceId = PushPolicy(context).deviceIdFor(userId).orEmpty()
        val sender = notification.optString("sender").takeIf { it.isNotEmpty() }
        // Android 9 is where the system grants itself read access to a message's image URI.
        val image = content?.takeIf {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                (it.optString("msgtype") == "m.image" || it.optString("msgtype") == "m.video")
        }
        val media = PushPayloadDecryptor.media(context, userId, deviceId, roomId, sender,
            notification.optString("sender_display_name"), image) ?: return
        val fields = if (isInvite(notification)) {
            listOf("sender_name" to SENDER_NAME_KEY)
        } else {
            listOf(
                "sender_name" to SENDER_NAME_KEY,
                "sender" to SENDER_AVATAR_KEY,
                "room" to ROOM_AVATAR_KEY,
                "own_avatar" to OWN_AVATAR_KEY,
                "own_name" to OWN_NAME_KEY,
            )
        }
        for ((field, key) in fields) {
            if (!media.isNull(field)) notification.put(key, media.getString(field))
        }
        media.optJSONObject("image")?.let {
            notification.put(IMAGE_KEY, it.getString("path"))
            notification.put(IMAGE_TYPE_KEY, it.getString("mimetype"))
        }
    }

    private fun image(context: Context, notification: JSONObject): Pair<String, Uri>? {
        val path = notification.optString(IMAGE_KEY).takeIf { it.isNotEmpty() } ?: return null
        val uri = runCatching {
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", File(path))
        }.onFailure { Logger.warn(Logger.tags(TAG), "Push image not shareable: ${it.message}") }
            .getOrNull() ?: return null
        return notification.optString(IMAGE_TYPE_KEY) to uri
    }

    private fun avatar(notification: JSONObject, key: String): Bitmap? =
        notification.optString(key).takeIf { it.isNotEmpty() }?.let { BitmapFactory.decodeFile(it) }

    private fun self(userId: String, notification: JSONObject): Person =
        Person.Builder()
            .setName(notification.optString(OWN_NAME_KEY).ifEmpty { userId.ifEmpty { "You" } })
            .apply {
                if (userId.isNotEmpty()) setKey(userId)
                avatar(notification, OWN_AVATAR_KEY)?.let { setIcon(IconCompat.createWithBitmap(it)) }
            }
            .build()

    private fun person(name: String, notification: JSONObject): Person.Builder =
        Person.Builder().setName(name).apply {
            notification.optString("sender").takeIf { it.isNotEmpty() }?.let { setKey(it) }
            avatar(notification, SENDER_AVATAR_KEY)?.let { setIcon(IconCompat.createWithBitmap(it)) }
        }

    internal fun mergeFetched(notification: JSONObject, event: JSONObject) {
        for (key in event.keys()) {
            if ((key == "type" || key == "content" || !notification.has(key)) && !event.isNull(key)) {
                notification.put(key, event.get(key))
            }
        }
        if (event.optBoolean("noisy")) notification.put(NOISY_KEY, true)
        if (event.optBoolean("encrypted")) notification.put(ENCRYPTED_FLAG, true)
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

    private fun isRtcInvite(event: JSONObject): Boolean {
        val type = event.optString("type")
        return type == "m.rtc.invite" || type == RTC_NOTIFICATION_TYPE || type == RTC_NOTIFICATION_TYPE_UNSTABLE
    }

    internal fun isRing(event: JSONObject): Boolean =
        isRtcInvite(event) && event.optJSONObject("content")?.optString("notification_type") == "ring"

    private fun isRedacted(event: JSONObject): Boolean =
        event.optJSONObject("unsigned")?.has("redacted_because") == true

    private fun isInvite(event: JSONObject): Boolean =
        event.optString("type") == "m.room.member" &&
            event.optJSONObject("content")?.optString("membership") == "invite"

    private const val UNKNOWN_SENDER = "Someone"
    private const val ALERTED_AT_KEY = "sable.push.alerted-at"
    private const val EVENT_KEY = ConversationHistory.EVENT_KEY
    private const val ENCRYPTED_KEY = ConversationHistory.ENCRYPTED_KEY
    private const val ACCOUNT_KEY = ConversationHistory.ACCOUNT_KEY
    private const val ROOM_KEY = ConversationHistory.ROOM_KEY

    private fun dismissAccount(context: Context, userId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications
            .filter { it.tag == null && it.notification.extras.getString(ACCOUNT_KEY) == userId }
            .forEach { active -> PushNotificationGate.dismiss(context, active.id) { manager.cancel(active.id) } }
        cancelOrphanedSummary(context)
    }

    private fun reconcileRead(
        context: Context,
        manager: NotificationManager,
        userId: String,
        deviceId: String,
        currentRoomId: String,
    ): Boolean {
        val shown = manager.activeNotifications.filter {
            it.tag == null && it.notification.extras.getString(ACCOUNT_KEY) == userId
        }
        val rooms = shown.mapNotNull { it.notification.extras.getString(ROOM_KEY) }
            .filter { it.isNotEmpty() && it != currentRoomId }
            .distinct()
        if (rooms.isEmpty()) return false
        val read = PushPayloadDecryptor.readRooms(context, userId, deviceId, rooms.first(), rooms)
            ?: return false
        val readRooms = read.toSet()
        val dismissed = shown.filter { it.notification.extras.getString(ROOM_KEY) in readRooms }
        dismissed.forEach { active -> PushNotificationGate.dismiss(context, active.id) { manager.cancel(active.id) } }
        cancelOrphanedSummary(context)
        return dismissed.isNotEmpty()
    }

    private fun post(
        context: Context,
        notification: JSONObject,
        preview: String?,
    ) {
        if (!PushPolicy(context).notificationsEnabled) return
        val roomId = notification.optString("room_id")
        val eventId = notification.optString("event_id")
        val sender = notification.optString(SENDER_NAME_KEY)
            .ifEmpty { notification.optString("sender") }
        val isInvite = isInvite(notification)
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
                if (userId.isNotEmpty()) putString(ACCOUNT_KEY, userId)
                if (roomId.isNotEmpty()) putString(ROOM_KEY, roomId)
            })
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(cooling)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup(GROUP_KEY)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .apply {
                notification.optJSONObject("counts")?.optInt("unread", 0)?.takeIf { it > 0 }?.let { setNumber(it) }
            }
            .setPublicVersion(
                NotificationCompat.Builder(context, channelId)
                    .setSmallIcon(iconId)
                    .setContentTitle(if (isInvite) "New Invitation" else "New message")
                    .build()
            )

        var repeat = false

        val direct = roomName.isEmpty() || notification.optBoolean(DIRECT_FLAG)
        if (isInvite) {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        } else {
            builder.setCategory(NotificationCompat.CATEGORY_MESSAGE)
            val messages = ConversationHistory.read(context, notifId).toMutableList()
            val index = messages.indexOfFirst { eventId.isNotEmpty() && it.extras.getString(EVENT_KEY) == eventId }
            if (index >= 0 && state.showContent && state.showEncryptedContent) return
            if (index >= 0) builder.setSilent(true)
            repeat = index >= 0
            val stamp = if (!cooling && index < 0) now else alertedAt
            if (stamp != null) builder.addExtras(Bundle().apply { putLong(ALERTED_AT_KEY, stamp) })
            val incoming = NotificationCompat.MessagingStyle.Message(
                if (!state.showContent) "New message" else text.orEmpty(),
                if (index >= 0) messages[index].timestamp else notification.optLong(RECEIVED_AT_KEY, now),
                person(sender.ifEmpty { UNKNOWN_SENDER }, notification).build()
            ).also {
                image(context, notification)?.let { (mimetype, uri) -> it.setData(mimetype, uri) }
                it.extras.putString(EVENT_KEY, eventId)
                it.extras.putBoolean(ENCRYPTED_KEY, notification.optString("type") == "m.room.encrypted" || notification.optBoolean(ENCRYPTED_FLAG))
            }
            if (ConversationHistory.shows(context, notifId, eventId.ifEmpty { null }, incoming.text.toString())) return
            if (index < 0) messages.add(incoming)
            messages.sortBy { it.timestamp }
            val style = NotificationCompat.MessagingStyle(self(userId, notification))
            if (!direct) {
                style.conversationTitle = roomName
                style.isGroupConversation = true
            }
            messages.takeLast(ConversationHistory.LIMIT).forEach { style.addMessage(it) }
            messages.lastOrNull()?.let {
                builder.setWhen(it.timestamp)
                if (it !== incoming) {
                    builder.setContentText(buildBody(it.person?.name?.toString().orEmpty(), it.text.toString()))
                    builder.setSilent(true)
                }
            }
            actionEventId = messages.lastOrNull()?.extras?.getString(EVENT_KEY)?.takeIf { it.isNotEmpty() } ?: eventId
            builder.setStyle(style)
        }

        val intent = buildPushIntent(context, notifId, roomId, actionEventId, userId)
        builder.setContentIntent(PendingIntent.getActivity(context, notifId, intent, flags))
        if (!isInvite) {
            val icon = avatar(notification, ROOM_AVATAR_KEY) ?: avatar(notification, SENDER_AVATAR_KEY)
            icon?.let { builder.setLargeIcon(it) }
            val person = person(sender.ifEmpty { UNKNOWN_SENDER }, notification).build()
            if (userId.isNotEmpty()) {
                ConversationShortcuts.publish(context, userId, roomId, title, icon, person, intent, direct)?.let {
                    builder.setShortcutId(it)
                    builder.setLocusId(ConversationShortcuts.locus(userId, roomId))
                }
            }
        }
        if (isInvite) {
            addActions(context, builder, notifId, roomId, actionEventId, userId, flags, PushActions.INVITE_TYPE, PushActions.invite)
        } else {
            addActions(context, builder, notifId, roomId, actionEventId, userId, flags, PushActions.MESSAGE_TYPE, PushActions.message)
        }

        val built = builder.build()
        NotificationManagerCompat.from(context).notify(notifId, built)
        postSummary(context, iconId)
        NotificationReceipts.record(context, notifId, eventId)
        AlertLog.posted(
            context, "push", traceOf(notification), built,
            listOfNotNull(
                "notify-once".takeIf { cooling },
                "repeat".takeIf { repeat },
            ),
            listOf(
                "noisy=${isNoisy(notification)}",
                "notifyOnce=${state.notifyOnce}",
                "alertedAgoMs=${alertedAt?.let { now - it }}",
            ),
        )
    }

    /** One summary for every account, since they share [GROUP_KEY]. */
    private fun postSummary(context: Context, iconId: Int) {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        val summary = NotificationCompat.Builder(context, MESSAGES_CHANNEL_ID)
            .setSmallIcon(iconId)
            .setContentTitle("New messages")
            .setStyle(NotificationCompat.InboxStyle().setBigContentTitle("New messages"))
            .setGroup(GROUP_KEY)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setContentIntent(
                PendingIntent.getActivity(context, SUMMARY_ID, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            )
            .build()
        NotificationManagerCompat.from(context).notify(SUMMARY_ID, summary)
    }

    /** The summary of an emptied group is only noise, so it goes with the last conversation. */
    internal fun cancelOrphanedSummary(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val active = manager.activeNotifications.filter { it.tag == null && it.notification.group == GROUP_KEY }
        if (active.isNotEmpty() && active.all { it.id == SUMMARY_ID }) manager.cancel(SUMMARY_ID)
    }

    private fun postIncomingCall(context: Context, notification: JSONObject, event: JSONObject) {
        ensureChannels(context)

        val roomId = notification.optString("room_id")
        val userId = notification.optString("user_id")
        val eventId = event.optString("event_id").ifEmpty { notification.optString("event_id") }
        val caller = notification.optString(SENDER_NAME_KEY)
            .ifEmpty { notification.optString("sender") }
            .ifEmpty { notification.optString("room_name") }
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
                    person(caller, notification).setImportant(true).build(),
                    pending(PushActions.DECLINE_CALL),
                    pending(PushActions.ANSWER_CALL),
                )
            )
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            .setTimeoutAfter(ringLifetimeMs(event))

        val incoming = builder.build().apply {
            this.flags = this.flags or Notification.FLAG_INSISTENT
        }
        NotificationManagerCompat.from(context).notify(notifId, incoming)
        NotificationReceipts.record(context, roomNotificationId(userId, roomId), eventId)
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
            val pending = when {
                action.semantic != null -> {
                    val receiver = Intent(context, ConversationActionReceiver::class.java).putExtras(actionIntent)
                    PendingIntent.getBroadcast(context, requestCode, receiver, actionFlags)
                }
                !action.input && !action.foreground -> {
                    val receiver = Intent().setClassName(context, NotificationIntents.ACTION_RECEIVER).putExtras(actionIntent)
                    PendingIntent.getBroadcast(context, requestCode, receiver, actionFlags)
                }
                else -> PendingIntent.getActivity(context, requestCode, actionIntent, actionFlags)
            }
            val actionBuilder = NotificationCompat.Action.Builder(R.drawable.ic_transparent, action.title, pending)
            action.semantic?.let { actionBuilder.setSemanticAction(it).setShowsUserInterface(false) }
            if (action.input) {
                actionBuilder.addRemoteInput(
                    RemoteInput.Builder(NotificationIntents.REMOTE_INPUT).setLabel(action.title).build()
                )
            }
            builder.addAction(actionBuilder.build())
        }
    }

    /** Re-posting the conversation is also what ends the reply's progress spinner. */
    internal fun showReply(context: Context, notificationId: Int, text: String, sent: Boolean) {
        val active = context.getSystemService(NotificationManager::class.java)
            .activeNotifications.firstOrNull { it.id == notificationId && it.tag == null } ?: return
        val shown = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(active.notification) ?: return
        val messages = ConversationHistory.read(context, notificationId)
        val encrypted = messages.lastOrNull()?.extras?.getBoolean(ENCRYPTED_KEY, true) ?: true
        val body = if (ConversationHistory.hides(PushPolicy(context), encrypted)) "New message" else text
        val reply = NotificationCompat.MessagingStyle.Message(
            if (sent) body else "Not sent: $body", System.currentTimeMillis(), null as Person?,
        ).also {
            it.extras.putBoolean(ENCRYPTED_KEY, encrypted)
            it.extras.putBoolean(ConversationHistory.FAILED_KEY, !sent)
        }
        val style = NotificationCompat.MessagingStyle(shown.user)
            .setConversationTitle(shown.conversationTitle)
            .setGroupConversation(shown.isGroupConversation)
        (messages + reply).takeLast(ConversationHistory.LIMIT).forEach { style.addMessage(it) }
        val notification = NotificationCompat.Builder(context, active.notification)
            .setStyle(style)
            .setWhen(reply.timestamp)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()
        NotificationManagerCompat.from(context).notify(notificationId, notification)
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
        val policy = PushPolicy(context)
        if (!policy.showContent) return "New message"
        if (notification.optBoolean(ENCRYPTED_FLAG) && !policy.showEncryptedContent) {
            return "Encrypted message"
        }
        if (notification.optString("type") != "m.room.encrypted") {
            PushDiagnostics.record(context, PushOutcome.PLAINTEXT, traceOf(notification))
            return PushPayloadDecryptor.previewBody(context, notification.optJSONObject("content"))
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
            PushDecryptResult.DiscardUnevaluated -> return null to PushOutcome.RULES_UNEVALUATED
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
