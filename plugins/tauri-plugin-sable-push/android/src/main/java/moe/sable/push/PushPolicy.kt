package moe.sable.push

import android.content.Context
import org.json.JSONObject

internal class PushPolicy(context: Context) {
    private val prefs = context.getSharedPreferences("sable-push", Context.MODE_PRIVATE)

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean("enabled", true)
        set(value) = prefs.edit().putBoolean("enabled", value).apply()

    var showContent: Boolean
        get() = prefs.getBoolean("show-content", false)
        set(value) = prefs.edit().putBoolean("show-content", value).apply()

    var showEncryptedContent: Boolean
        get() = prefs.getBoolean("show-encrypted", false)
        set(value) = prefs.edit().putBoolean("show-encrypted", value).apply()

    var notificationSounds: Boolean
        get() = prefs.getBoolean("sounds", true)
        set(value) = prefs.edit().putBoolean("sounds", value).apply()

    var notifyOnce: Boolean
        get() = prefs.getBoolean("notify-once", true)
        set(value) = prefs.edit().putBoolean("notify-once", value).apply()

    var accounts: Map<String, String>
        get() = runCatching {
            val stored = JSONObject(prefs.getString("accounts", "{}") ?: "{}")
            stored.keys().asSequence()
                .associateWith { stored.optString(it) }
                .filterValues { it.isNotEmpty() }
        }.getOrDefault(emptyMap())
        set(value) = prefs.edit().putString("accounts", JSONObject(value).toString()).apply()

    fun deviceIdFor(userId: String): String? = if (userId.isEmpty()) null else accounts[userId]

    fun knowsAnyAccount(): Boolean = accounts.isNotEmpty()
}
