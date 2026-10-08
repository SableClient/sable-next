package moe.sable.push

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal enum class PushOutcome {
    DISABLED,
    INVALID_PAYLOAD,
    MISSING_ROOM,
    MISSING_RECIPIENT,
    WRONG_RECIPIENT,
    READ_DISMISSED,
    ACCOUNT_READ_DISMISSED,
    DECRYPTED,
    PLAINTEXT,
    HIDDEN_BY_SETTING,
    NO_ACCOUNT,
    NO_CONTENT,
    NO_NATIVE_LIB,
    DECRYPT_FAILED,
    EMPTY_BODY,
    REPLAY_DROPPED,
    EMBEDDED_STARTED,
    EMBEDDED_READY,
    EMBEDDED_SOCKET_FAILED,
    EMBEDDED_HTTP_REJECTED,
    EMBEDDED_CLOSED,
    EMBEDDED_MESSAGE_RECEIVED,
    EMBEDDED_DECRYPTED,
    EMBEDDED_DECRYPT_FAILED,
    EMBEDDED_REGISTRATION_TIMEOUT,
    DISCARDED,
    FETCHED,
    FETCH_FAILED,
    DIAGNOSTIC_RECEIVED,
    POSTED,
}

internal data class PushTrace(
    val userId: String,
    val roomId: String,
    val eventId: String,
)

internal data class PushDiagnosticsSnapshot(
    val counts: Map<String, Int>,
    val lastOutcome: String?,
    val lastAt: Long,
)

internal object PushDiagnostics {
    private const val PREFS = "sable-push"
    private const val KEY_PREFIX = "push-outcome-"
    private const val KEY_LAST = "push-outcome-last"
    private const val KEY_LAST_AT = "push-outcome-last-at"
    private const val KEY_HISTORY = "push-history"
    const val HISTORY_LIMIT = 200

    @Synchronized
    fun record(context: Context, outcome: PushOutcome, trace: PushTrace? = null, detail: String? = null) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val key = KEY_PREFIX + outcome.name
        val at = System.currentTimeMillis()
        val entry = JSONObject()
            .put("at", at)
            .put("outcome", outcome.name)
        trace?.let {
            if (it.userId.isNotEmpty()) entry.put("userId", it.userId)
            if (it.roomId.isNotEmpty()) entry.put("roomId", it.roomId)
            if (it.eventId.isNotEmpty()) entry.put("eventId", it.eventId)
        }
        detail?.let { entry.put("detail", it) }
        val history = readHistory(prefs.getString(KEY_HISTORY, null))
        history.put(entry)
        prefs.edit()
            .putInt(key, prefs.getInt(key, 0) + 1)
            .putString(KEY_LAST, outcome.name)
            .putLong(KEY_LAST_AT, at)
            .putString(KEY_HISTORY, trimmed(history).toString())
            .apply()
    }

    @Synchronized
    fun history(context: Context): JSONArray {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return readHistory(prefs.getString(KEY_HISTORY, null))
    }

    @Synchronized
    fun clearHistory(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_HISTORY).apply()
    }

    private fun readHistory(stored: String?): JSONArray =
        stored?.let { runCatching { JSONArray(it) }.getOrNull() } ?: JSONArray()

    private fun trimmed(history: JSONArray): JSONArray {
        if (history.length() <= HISTORY_LIMIT) return history
        val kept = JSONArray()
        for (index in history.length() - HISTORY_LIMIT until history.length()) {
            kept.put(history.get(index))
        }
        return kept
    }

    @Synchronized
    fun drain(context: Context): PushDiagnosticsSnapshot {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val counts = PushOutcome.entries.associate { outcome ->
            outcome.name to prefs.getInt(KEY_PREFIX + outcome.name, 0)
        }.filterValues { it > 0 }

        val snapshot = PushDiagnosticsSnapshot(
            counts = counts,
            lastOutcome = prefs.getString(KEY_LAST, null),
            lastAt = prefs.getLong(KEY_LAST_AT, 0L),
        )

        prefs.edit().apply {
            PushOutcome.entries.forEach { remove(KEY_PREFIX + it.name) }
            remove(KEY_LAST)
            remove(KEY_LAST_AT)
        }.apply()

        return snapshot
    }
}
