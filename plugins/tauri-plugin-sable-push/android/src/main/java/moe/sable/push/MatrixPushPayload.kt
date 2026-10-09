package moe.sable.push

import org.json.JSONObject

internal object MatrixPushPayload {
    fun parse(raw: String): JSONObject? {
        val root = try { JSONObject(raw) } catch (_: Exception) { return null }
        val notification = when (val nested = root.opt("notification")) {
            null -> root
            is JSONObject -> nested
            is String -> try { JSONObject(nested) } catch (_: Exception) { return null }
            else -> return null
        }
        val recipients = mutableSetOf<String>()
        fun add(value: Any?) {
            if (value is String && value.isNotBlank()) recipients.add(value.trim())
        }
        add(root.opt("user_id"))
        add(notification.opt("user_id"))
        val devices = notification.optJSONArray("devices")
        for (index in 0 until (devices?.length() ?: 0)) {
            val data = devices?.optJSONObject(index)?.optJSONObject("data") ?: continue
            add(data.opt("user_id"))
            add(data.optJSONObject("default_payload")?.opt("user_id"))
        }
        if (recipients.size > 1) return null
        recipients.singleOrNull()?.let { notification.put("user_id", it) }
        return notification
    }
}
