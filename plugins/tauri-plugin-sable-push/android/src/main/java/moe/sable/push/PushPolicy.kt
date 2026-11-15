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

    var clearOnRead: Boolean
        get() = prefs.getBoolean("clear-on-read", true)
        set(value) = prefs.edit().putBoolean("clear-on-read", value).apply()

    var privateReceipts: Boolean
        get() = prefs.getBoolean("private-receipts", false)
        set(value) = prefs.edit().putBoolean("private-receipts", value).apply()

    var quietWhenActiveElsewhere: Boolean
        get() = prefs.getBoolean("quiet-when-active-elsewhere", false)
        set(value) = prefs.edit().putBoolean("quiet-when-active-elsewhere", value).apply()

    var inAppBanners: Boolean
        get() = prefs.getBoolean("in-app-banners", false)
        set(value) = prefs.edit().putBoolean("in-app-banners", value).apply()

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

    fun soleAccount(): String? = accounts.keys.singleOrNull()
}
