package moe.sable.push

import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkObject
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class PushRegistrationWorkerTest {
    private val context = RuntimeEnvironment.getApplication()

    @Test
    fun rotationsForDifferentAccountsDoNotReplaceEachOthersWork() {
        mockkObject(WorkManager.Companion)
        try {
            val manager = mockk<WorkManager>(relaxed = true)
            every { WorkManager.getInstance(any()) } returns manager
            val requests = mutableMapOf<String, OneTimeWorkRequest>()
            every { manager.enqueueUniqueWork(any(), ExistingWorkPolicy.REPLACE, any<OneTimeWorkRequest>()) } answers {
                requests[firstArg()] = thirdArg()
                mockk(relaxed = true)
            }
            PushRegistrationWorker.enqueue(context, "alice", "https://push.test/a", "key-a", "auth-a")
            PushRegistrationWorker.enqueue(context, "bob", "https://push.test/b", "key-b", "auth-b")
            assertEquals(setOf("push-registration:alice", "push-registration:bob"), requests.keys)
            assertEquals("bob", requests.getValue("push-registration:bob").workSpec.input.getString("instance"))
        } finally {
            unmockkObject(WorkManager.Companion)
        }
    }

    @Test
    fun rotationUsesItsSubscriptionInsteadOfTheFirstAccount() {
        PushPolicy(context).accounts = mapOf("@alice:one.test" to "A", "@bob:two.test" to "B")
        mockkObject(PushPayloadDecryptor)
        try {
            val operation = slot<String>()
            every { PushPayloadDecryptor.maintain(any(), capture(operation)) } returns true
            val parameters = mockk<WorkerParameters>(relaxed = true)
            every { parameters.inputData } returns Data.Builder()
                .putString("instance", "bob").putString("endpoint", "https://push.test/b").build()
            assertEquals(androidx.work.ListenableWorker.Result.success(), PushRegistrationWorker(context, parameters).doWork())
            val payload = JSONObject(operation.captured)
            assertEquals("bob", payload.getString("instance"))
            assertFalse(payload.has("user_id"))
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
    }

    @Test
    fun legacyWorkCannotGuessBetweenAccounts() {
        PushPolicy(context).accounts = mapOf("@alice:one.test" to "A", "@bob:two.test" to "B")
        val parameters = mockk<WorkerParameters>(relaxed = true)
        every { parameters.inputData } returns Data.Builder().putString("endpoint", "https://push.test/legacy").build()
        assertEquals(androidx.work.ListenableWorker.Result.failure(), PushRegistrationWorker(context, parameters).doWork())
    }
}
