package moe.sable.push

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build

object CallAnswer {
    fun accepts(intent: Intent?): Boolean =
        intent?.getStringExtra(NotificationIntents.ACTION) == PushActions.ANSWER_CALL

    fun waitsForUnlock(activity: Activity, intent: Intent?): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && accepts(intent) &&
            activity.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true

    // The keyguard is dismissed rather than shown over, so no room is visible to whoever holds the locked phone.
    fun answerAfterUnlock(activity: Activity, intent: Intent, answer: (Intent) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return answer(intent)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) activity.setTurnScreenOn(true)
        activity.getSystemService(KeyguardManager::class.java).requestDismissKeyguard(
            activity,
            UnlockForAnswer(activity, intent, answer),
        )
    }
}

internal class UnlockForAnswer(
    private val activity: Activity,
    private val intent: Intent,
    private val answer: (Intent) -> Unit,
) : KeyguardManager.KeyguardDismissCallback() {
    override fun onDismissSucceeded() {
        release()
        answer(intent)
    }

    override fun onDismissCancelled() = release()

    override fun onDismissError() = release()

    private fun release() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) activity.setTurnScreenOn(false)
    }
}
