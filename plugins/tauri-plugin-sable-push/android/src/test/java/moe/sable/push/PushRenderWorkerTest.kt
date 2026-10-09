package moe.sable.push

import androidx.work.Data
import androidx.work.ListenableWorker.Result
import androidx.work.WorkerParameters
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class PushRenderWorkerTest {
    @Test
    fun activationWorkIsNotTaggedForNotificationDismissal() {
        val context = RuntimeEnvironment.getApplication()
        io.mockk.mockkObject(androidx.work.WorkManager.Companion)
        try {
            val manager = mockk<androidx.work.WorkManager>(relaxed = true)
            every { androidx.work.WorkManager.getInstance(any()) } returns manager
            val request = io.mockk.slot<androidx.work.WorkRequest>()
            every { manager.enqueue(capture(request)) } returns mockk(relaxed = true)
            PushRenderWorker.enqueue(context, """{"app_id":"app","ack_token":"token"}""")
            assertTrue(request.captured.tags.contains("push-activation"))
            assertEquals(androidx.work.NetworkType.CONNECTED, request.captured.workSpec.constraints.requiredNetworkType)
            assertFalse(request.captured.tags.contains("push-render"))
            assertFalse(request.captured.tags.any { it.startsWith("push-room:") })
        } finally {
            io.mockk.unmockkObject(androidx.work.WorkManager.Companion)
        }
    }

    private fun worker(id: String): PushRenderWorker {
        val parameters = mockk<WorkerParameters>(relaxed = true)
        every { parameters.inputData } returns Data.Builder().putString("payloadId", id).build()
        return PushRenderWorker(RuntimeEnvironment.getApplication(), parameters)
    }

    @Test
    fun rejectsPathsOutsideThePayloadDirectory() {
        assertEquals(Result.failure(), worker("../session.json").doWork())
    }

    @Test
    fun largeQueuedPayloadIsRemovedWhenNotificationsAreDisabled() {
        val context = RuntimeEnvironment.getApplication()
        PushPolicy(context).notificationsEnabled = false
        val id = UUID.randomUUID().toString()
        val file = File(context.noBackupFilesDir, "push-work/$id")
        file.parentFile!!.mkdirs()
        file.writeText("{\"body\":\"${"x".repeat(20_000)}\"}")
        assertEquals(Result.success(), worker(id).doWork())
        assertFalse(file.exists())
    }
}
