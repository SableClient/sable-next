package moe.sable.push

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.graphics.Bitmap
import android.util.Base64
import androidx.core.app.Person
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import app.tauri.Logger

object ConversationShortcuts {
    private const val TAG = "ConversationShortcuts"
    private const val PREFIX = "conversation:"
    private const val LEGACY_PREFIX = "conversation-"
    private const val SEND_MESSAGE = "actions.intent.SEND_MESSAGE"

    /** The share-target category in the app's `res/xml/shortcuts.xml` must be this string. */
    const val SHARE_TARGET_CATEGORY = "moe.sable.category.SHARE_TARGET"

    private const val ENCODING = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING

    private fun encode(value: String): String = Base64.encodeToString(value.toByteArray(), ENCODING)

    fun id(userId: String, roomId: String): String = "$PREFIX${encode(userId)}:${encode(roomId)}"

    /** The account and room of a conversation shortcut id. */
    fun parse(id: String): Pair<String, String>? {
        val parts = id.removePrefix(PREFIX).takeIf { it != id }?.split(':') ?: return null
        if (parts.size != 2) return null
        return runCatching {
            String(Base64.decode(parts[0], ENCODING)) to String(Base64.decode(parts[1], ENCODING))
        }.getOrNull()?.takeIf { (userId, roomId) -> userId.isNotEmpty() && roomId.isNotEmpty() }
    }

    fun locus(userId: String, roomId: String): LocusIdCompat = LocusIdCompat(id(userId, roomId))

    fun forgetRooms(context: Context, userId: String, roomIds: Set<String>) = remove(context) { id ->
        parse(id)?.let { (user, room) -> user == userId && room in roomIds } ?: false
    }

    /** Also drops the ids older builds published, which name no account. */
    fun retainAccounts(context: Context, userIds: Set<String>) = remove(context) { id ->
        parse(id)?.let { (user, _) -> user !in userIds } ?: id.startsWith(LEGACY_PREFIX)
    }

    private fun remove(context: Context, stale: (String) -> Boolean) {
        val ids = runCatching {
            ShortcutManagerCompat.getDynamicShortcuts(context) +
                ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_CACHED)
        }.getOrDefault(emptyList()).map { it.id }.distinct().filter(stale)
        if (ids.isEmpty()) return
        runCatching { ShortcutManagerCompat.removeLongLivedShortcuts(context, ids) }
            .onFailure { Logger.warn(Logger.tags(TAG), "Conversation shortcuts not removed: ${it.message}") }
    }

    fun publish(
        context: Context,
        userId: String,
        roomId: String,
        label: String,
        icon: Bitmap?,
        person: Person,
        intent: Intent,
        direct: Boolean,
    ): String? {
        val id = id(userId, roomId)
        val shortcut = ShortcutInfoCompat.Builder(context, id)
            .setShortLabel(label)
            .setLongLabel(label)
            .setIntent(intent)
            .setIsConversation()
            .setLongLived(true)
            .setLocusId(LocusIdCompat(id))
            .setCategories(setOf(ShortcutInfo.SHORTCUT_CATEGORY_CONVERSATION, SHARE_TARGET_CATEGORY))
            .apply {
                // A group's shortcut would otherwise take the face of whoever wrote last.
                if (direct) {
                    setPerson(person)
                    addCapabilityBinding(SEND_MESSAGE)
                } else {
                    addCapabilityBinding(SEND_MESSAGE, "message.recipient.@type", listOf("Audience"))
                }
                icon?.let { setIcon(IconCompat.createWithBitmap(it)) }
            }
            .build()
        return runCatching { ShortcutManagerCompat.pushDynamicShortcut(context, shortcut) }
            .onFailure { Logger.warn(Logger.tags(TAG), "Conversation shortcut not published: ${it.message}") }
            .getOrNull()?.let { id }
    }
}
