package moe.sable.push

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallAnswerTest {
    private fun action(id: String?) = Intent(Intent.ACTION_MAIN).apply {
        if (id != null) putExtra(NotificationIntents.ACTION, id)
    }

    private fun activity(locked: Boolean, keyguard: KeyguardManager = mockk(relaxed = true)): Activity {
        every { keyguard.isKeyguardLocked } returns locked
        return mockk(relaxed = true) {
            every { getSystemService(KeyguardManager::class.java) } returns keyguard
        }
    }

    @Test
    fun onlyTheAnswerActionCountsAsAcceptingACall() {
        assertTrue(CallAnswer.accepts(action(PushActions.ANSWER_CALL)))
        assertFalse(CallAnswer.accepts(action(PushActions.DECLINE_CALL)))
        assertFalse(CallAnswer.accepts(action(NotificationIntents.DEFAULT_PRESS)))
        assertFalse(CallAnswer.accepts(action(PushActions.ACCEPT_INVITE)))
        assertFalse(CallAnswer.accepts(action(null)))
        assertFalse(CallAnswer.accepts(null))
    }

    @Test
    fun answeringWaitsForUnlockOnlyWhileTheKeyguardIsLocked() {
        val answer = action(PushActions.ANSWER_CALL)
        assertTrue(CallAnswer.waitsForUnlock(activity(locked = true), answer))
        assertFalse(CallAnswer.waitsForUnlock(activity(locked = false), answer))
        assertFalse(CallAnswer.waitsForUnlock(activity(locked = true), action(PushActions.DECLINE_CALL)))
    }

    @Test
    fun theAnswerProceedsOnlyOnceTheKeyguardIsDismissed() {
        val keyguard = mockk<KeyguardManager>(relaxed = true)
        val host = activity(locked = true, keyguard = keyguard)
        val intent = action(PushActions.ANSWER_CALL)
        val callback = slot<KeyguardManager.KeyguardDismissCallback>()
        every { keyguard.requestDismissKeyguard(host, capture(callback)) } returns Unit
        val answered = mutableListOf<Intent>()

        CallAnswer.answerAfterUnlock(host, intent) { answered += it }
        verify { host.setTurnScreenOn(true) }
        assertTrue(answered.isEmpty())

        callback.captured.onDismissSucceeded()
        assertEquals(listOf(intent), answered)
        verify { host.setTurnScreenOn(false) }
    }

    @Test
    fun aCancelledOrFailedUnlockAnswersNothing() {
        for (outcome in listOf<(KeyguardManager.KeyguardDismissCallback) -> Unit>(
            { it.onDismissCancelled() },
            { it.onDismissError() },
        )) {
            val keyguard = mockk<KeyguardManager>(relaxed = true)
            val host = activity(locked = true, keyguard = keyguard)
            val callback = slot<KeyguardManager.KeyguardDismissCallback>()
            every { keyguard.requestDismissKeyguard(host, capture(callback)) } returns Unit
            val answered = mutableListOf<Intent>()

            CallAnswer.answerAfterUnlock(host, action(PushActions.ANSWER_CALL)) { answered += it }
            outcome(callback.captured)

            assertTrue(answered.isEmpty())
            verify { host.setTurnScreenOn(false) }
        }
    }
}
