package moe.sable.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.work.WorkManager
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.unmockkObject
import io.mockk.verify
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppDismissalsTest {

    private lateinit var context: Context
    private lateinit var manager: NotificationManager
    private val me = "@me:example.org"
    private val room = "!room:example.org"
    private val id get() = PushNotifier.roomNotificationId(me, room)
    private val now = Executor { it.run() }

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("test", "test", NotificationManager.IMPORTANCE_HIGH))
        manager.cancelAll()
        PushDiagnostics.clearHistory(context)
        PushPolicy(context).accounts = mapOf(me to "DEVICE")
        AppDismissals.opened(context, null, null, foreground = false)
        mockkObject(WorkManager.Companion, PushPayloadDecryptor)
        every { WorkManager.getInstance(any()) } returns mockk(relaxed = true)
    }

    @After
    fun teardown() {
        unmockkObject(WorkManager.Companion, PushPayloadDecryptor)
    }

    private fun post(vararg events: String = arrayOf("\$one")) {
        val extras = Bundle().apply {
            putString(ConversationHistory.ACCOUNT_KEY, me)
            putString(ConversationHistory.ROOM_KEY, room)
        }
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("me").build())
        events.forEachIndexed { index, event ->
            style.addMessage(NotificationCompat.MessagingStyle.Message("hi", index.toLong(), Person.Builder().setName("them").build())
                .also { it.extras.putString(ConversationHistory.EVENT_KEY, event) })
        }
        manager.notify(id, NotificationCompat.Builder(context, "test")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setStyle(style)
            .addExtras(extras)
            .build())
    }

    private fun serverReads(rooms: List<String>?) {
        every { PushPayloadDecryptor.readRooms(any(), me, "DEVICE", any(), any()) } returns rooms
    }

    private fun shown() = manager.activeNotifications.any { it.id == id }

    private fun outcomes() = PushDiagnostics.history(context).let { history ->
        (0 until history.length()).map { history.getJSONObject(it).getString("outcome") }
    }

    @Test
    fun theOpenRoomClearsAtOnceInTheForeground() {
        post()
        AppDismissals.opened(context, me, room, foreground = false)
        val revision = PushNotificationGate.revision(context, id)

        AppDismissals.dismiss(context, listOf(id), foreground = true, background = {})

        assertFalse(shown())
        assertEquals(listOf(PushOutcome.APP_DISMISSED.name), outcomes())
        assertNotEquals(revision, PushNotificationGate.revision(context, id))
        verify(exactly = 0) { PushPayloadDecryptor.readRooms(any(), any(), any(), any(), any()) }
    }

    @Test
    fun anotherRoomInTheForegroundWaitsForTheServer() {
        post()
        serverReads(emptyList())

        AppDismissals.dismiss(context, listOf(id), foreground = true, background = now)

        assertTrue(shown())
        assertEquals(listOf(PushOutcome.APP_DISMISS_IGNORED.name), outcomes())
    }

    @Test
    fun theOpenRoomWaitsForTheServerInTheBackground() {
        post()
        AppDismissals.opened(context, me, room, foreground = false)
        serverReads(emptyList())

        AppDismissals.dismiss(context, listOf(id), foreground = false, background = now)

        assertTrue(shown())
        assertEquals(listOf(PushOutcome.APP_DISMISS_IGNORED.name), outcomes())
    }

    @Test
    fun anAlertTheServerReportsReadClearsWithoutDroppingARenderInFlight() {
        post()
        serverReads(listOf(room))
        val rendering = PushNotificationGate.revision(context, id)

        AppDismissals.dismiss(context, listOf(id), foreground = false, background = now)

        assertFalse(shown())
        assertEquals(listOf(PushOutcome.READ_DISMISSED.name), outcomes())
        var posted = false
        PushNotificationGate.post(context, id, rendering) { posted = true }
        assertTrue(posted)
    }

    @Test
    fun anAlertStaysWhenTheServerCannotBeAsked() {
        post()
        serverReads(null)

        AppDismissals.dismiss(context, listOf(id), foreground = false, background = now)

        assertTrue(shown())
        assertEquals(listOf(PushOutcome.APP_DISMISS_IGNORED.name), outcomes())
    }

    @Test
    fun anAlertStaysWithoutADeviceToAskFor() {
        post()
        PushPolicy(context).accounts = emptyMap()

        AppDismissals.dismiss(context, listOf(id), foreground = false, background = now)

        assertTrue(shown())
        verify(exactly = 0) { PushPayloadDecryptor.readRooms(any(), any(), any(), any(), any()) }
    }

    @Test
    fun aMessagePostedWhileTheServerAnswersStays() {
        post("\$one")
        every { PushPayloadDecryptor.readRooms(any(), me, "DEVICE", any(), any()) } answers {
            post("\$one", "\$two")
            listOf(room)
        }

        AppDismissals.dismiss(context, listOf(id), foreground = false, background = now)

        assertTrue(shown())
        assertEquals(listOf(PushOutcome.APP_DISMISS_IGNORED.name), outcomes())
    }

    @Test
    fun aRequestWhileTheServerIsAskedRunsOnceTheCheckEnds() {
        post()
        serverReads(emptyList())
        val queued = mutableListOf<Runnable>()
        val later = Executor { queued.add(it) }

        AppDismissals.dismiss(context, listOf(id), foreground = false, background = later)
        AppDismissals.dismiss(context, listOf(id), foreground = false, background = later)
        assertEquals(1, queued.size)

        queued.removeAt(0).run()
        assertTrue(shown())
        assertEquals(1, queued.size)
        serverReads(listOf(room))
        queued.removeAt(0).run()

        assertFalse(shown())
        assertTrue(queued.isEmpty())
    }

    @Test
    fun openingARoomInTheForegroundClearsItsAlert() {
        post()

        AppDismissals.opened(context, me, room, foreground = true)

        assertFalse(shown())
        assertEquals(listOf(PushOutcome.APP_DISMISSED.name), outcomes())
    }

    @Test
    fun openingARoomInTheBackgroundKeepsItsAlert() {
        post()

        AppDismissals.opened(context, me, room, foreground = false)

        assertTrue(shown())
    }

    @Test
    fun resendingAnUnchangedPolicyKeepsShownAlerts() {
        val policy = PushPolicy(context)
        policy.notificationsEnabled = true
        policy.showContent = false
        assertFalse(AppDismissals.hidesShown(policy, enabled = true, content = false))

        policy.notificationsEnabled = false
        assertFalse(AppDismissals.hidesShown(policy, enabled = false, content = false))
    }

    @Test
    fun turningContentOrAlertsOffClearsShownAlerts() {
        val policy = PushPolicy(context)
        policy.notificationsEnabled = true
        policy.showContent = true

        assertTrue(AppDismissals.hidesShown(policy, enabled = true, content = false))
        assertTrue(AppDismissals.hidesShown(policy, enabled = false, content = true))
    }

    @Test
    fun clearingEverythingRecordsEachShownAlert() {
        post()

        AppDismissals.dismissAll(context)

        assertTrue(manager.activeNotifications.isEmpty())
        assertEquals(listOf(PushOutcome.ALL_DISMISSED.name), outcomes())
    }
}
