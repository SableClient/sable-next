package moe.sable.push

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.work.Data
import androidx.work.ListenableWorker.Result
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.WorkerParameters
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkAll
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConversationActionsTest {
    private val user = "@alice:example.org"
    private val room = "!actions:example.org"

    private lateinit var context: Context
    private lateinit var notificationManager: NotificationManager
    private val requests = mutableListOf<WorkRequest>()

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        PushPolicy(context).showContent = true
        PushPolicy(context).showEncryptedContent = true
        notificationManager = context.getSystemService(NotificationManager::class.java)
        val launchIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName)
        shadowOf(context.packageManager).addResolveInfoForIntent(
            launchIntent,
            ResolveInfo().apply {
                activityInfo = ActivityInfo().apply {
                    packageName = context.packageName
                    name = "TestLauncherActivity"
                }
            },
        )
        mockkObject(WorkManager.Companion)
        val manager = mockk<WorkManager>(relaxed = true)
        every { WorkManager.getInstance(any()) } returns manager
        val request = slot<WorkRequest>()
        every { manager.enqueue(capture(request)) } answers { requests.add(request.captured); mockk(relaxed = true) }
    }

    @After
    fun teardown() = unmockkAll()

    private fun post(body: String = "hello", eventId: String = "\$notified") {
        val notification = JSONObject()
            .put("room_id", room)
            .put("event_id", eventId)
            .put("room_name", "Room 1")
            .put("sender", "@bob:example.org")
            .put("sender_display_name", "Bob")
            .put("type", "m.room.message")
            .put("content", JSONObject().put("body", body))
        PushNotifier.showFromPush(context, JSONObject().put("notification", notification).put("user_id", user).toString())
    }

    private fun posted() = notificationManager.activeNotifications
        .single { it.id != PushNotifier.SUMMARY_ID }.notification

    private fun texts() = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted())!!
        .messages.map { it.text.toString() }

    private fun actionIntent(semantic: Int, reply: String? = null): Intent {
        val action = (0 until NotificationCompat.getActionCount(posted()))
            .map { NotificationCompat.getAction(posted(), it)!! }
            .single { it.semanticAction == semantic }
        val intent = Intent(shadowOf(action.actionIntent).savedIntent)
        if (reply != null) {
            RemoteInput.addResultsToIntent(
                action.remoteInputs!!,
                intent,
                Bundle().apply { putCharSequence(NotificationIntents.REMOTE_INPUT, reply) },
            )
        }
        return intent
    }

    private fun runQueued(): Result {
        val parameters = mockk<WorkerParameters>(relaxed = true)
        every { parameters.inputData } returns requests.single().workSpec.input
        return ConversationActionWorker(context, parameters).doWork()
    }

    @Test
    fun replyAndMarkAsReadRunWithoutOpeningTheApp() {
        post()

        val actions = (0 until NotificationCompat.getActionCount(posted())).map { NotificationCompat.getAction(posted(), it)!! }

        assertEquals(
            listOf(NotificationCompat.Action.SEMANTIC_ACTION_REPLY, NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ),
            actions.map { it.semanticAction },
        )
        for (action in actions) {
            assertFalse(action.showsUserInterface)
            assertEquals(
                ConversationActionReceiver::class.java.name,
                shadowOf(action.actionIntent).savedIntent.component!!.className,
            )
        }
    }

    @Test
    fun aSentReplyJoinsTheConversationAsYou() {
        post()
        PushPolicy(context).accounts = mapOf(user to "A")
        PushPolicy(context).privateReceipts = true
        mockkObject(PushPayloadDecryptor)
        val sent = slot<ConversationAction>()
        every { PushPayloadDecryptor.reply(any(), capture(sent), "A", true) } returns true

        ConversationActionReceiver().onReceive(context, actionIntent(NotificationCompat.Action.SEMANTIC_ACTION_REPLY, "on my way"))

        assertEquals(Result.success(), runQueued())
        assertEquals("on my way", sent.captured.text)
        assertEquals("\$notified", sent.captured.eventId)
        assertEquals(listOf("hello", "on my way"), texts())
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted())!!
        assertNull(style.messages.last().person)
        assertEquals(2, NotificationCompat.getActionCount(posted()))
        assertEquals(ConversationShortcuts.id(user, room), NotificationCompat.getShortcutId(posted()))
    }

    @Test
    fun aFailedReplyIsShownAsNotSent() {
        post()
        PushPolicy(context).accounts = mapOf(user to "A")
        mockkObject(PushPayloadDecryptor)
        every { PushPayloadDecryptor.reply(any(), any(), any(), any()) } returns false

        ConversationActionReceiver().onReceive(context, actionIntent(NotificationCompat.Action.SEMANTIC_ACTION_REPLY, "on my way"))

        assertEquals(Result.failure(), runQueued())
        assertEquals(listOf("hello", "Not sent: on my way"), texts())
        assertEquals(
            androidx.work.NetworkType.NOT_REQUIRED,
            requests.single().workSpec.constraints.requiredNetworkType,
        )

        post("again", "\$next")
        assertEquals(listOf("hello", "again"), texts())
    }

    @Test
    fun aReplyFollowsTheHiddenContentPolicy() {
        post()
        PushPolicy(context).showContent = false
        PushNotifier.showReply(context, PushNotifier.roomNotificationId(user, room), "secret", sent = true)

        assertEquals(listOf("New message", "New message"), texts())
    }

    @Test
    fun markAsReadDismissesAtOnceAndSendsTheReceiptLater() {
        post()

        ConversationActionReceiver().onReceive(context, actionIntent(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ))

        assertTrue(notificationManager.activeNotifications.isEmpty())
        PushPolicy(context).accounts = mapOf(user to "A")
        mockkObject(PushPayloadDecryptor)
        val read = slot<ConversationAction>()
        every { PushPayloadDecryptor.markRead(any(), capture(read), "A", false) } returns true
        assertEquals(Result.success(), runQueued())
        assertEquals(room, read.captured.roomId)
        assertEquals("\$notified", read.captured.eventId)
    }
}
