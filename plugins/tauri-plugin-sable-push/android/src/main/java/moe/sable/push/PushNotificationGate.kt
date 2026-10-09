package moe.sable.push

import android.content.Context
import java.util.UUID

internal object PushNotificationGate {
    private fun preferences(context: Context) =
        context.getSharedPreferences("push-dismissals", Context.MODE_PRIVATE)

    @Synchronized
    fun revision(context: Context, id: Int): String {
        val preferences = preferences(context)
        return "${preferences.getString("all", "")}:${preferences.getString(id.toString(), "")}"
    }

    @Synchronized
    fun post(context: Context, id: Int, revision: String, action: () -> Unit) {
        if (revision(context, id) == revision) action()
    }

    @Synchronized
    fun dismiss(context: Context, id: Int?, action: () -> Unit) {
        val editor = preferences(context).edit()
        if (id == null) editor.clear()
        editor.putString(id?.toString() ?: "all", UUID.randomUUID().toString()).apply()
        action()
    }
}
