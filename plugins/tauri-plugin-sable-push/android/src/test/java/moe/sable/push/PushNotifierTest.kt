package moe.sable.push

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.unmockkObject
import io.mockk.verify

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushNotifierTest {

    private lateinit var context: Context
    private lateinit var notificationManager: NotificationManager

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        PushPolicy(context).showContent = true
        notificationManager = context.getSystemService(NotificationManager::class.java)
        mockkObject(PushPayloadDecryptor)
        every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } answers {
            JSONObject().put("sender_name", arg<String?>(5).orEmpty())
        }
        every { PushPayloadDecryptor.previewBody(any(), match { it?.toString() == richContent().toString() }) } returns
            "Alice hi & welcome"

        val launchIntent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setPackage(context.packageName)
        shadowOf(context.packageManager).addResolveInfoForIntent(
            launchIntent,
            ResolveInfo().apply {
                activityInfo = ActivityInfo().apply {
                    packageName = context.packageName
                    name = "TestLauncherActivity"
                }
            }
        )
    }

    @After
    fun teardown() {
        unmockkObject(PushPayloadDecryptor)
    }

    private fun shadowNotificationManager() = shadowOf(notificationManager)

    private fun conversations() = notificationManager.activeNotifications.filter { it.id != PushNotifier.SUMMARY_ID }

    @Test
    fun successiveMessagesKeepHistoryAndDismissalClearsIt() {
        val room = "!history:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$one", "first"))
        PushNotifier.showFromPush(context, pushPayload(room, "\$two", "second"))
        fun texts(): List<String> = androidx.core.app.NotificationCompat.MessagingStyle
            .extractMessagingStyleFromNotification(conversations().single().notification)!!
            .messages.map { it.text.toString() }
        assertEquals(listOf("first", "second"), texts())
        PushNotifier.showFromPush(context, pushPayload(room, "\$two", "second"))
        assertEquals(listOf("first", "second"), texts())
        notificationManager.cancelAll()
        PushNotifier.showFromPush(context, pushPayload(room, "\$three", "third"))
        assertEquals(listOf("third"), texts())
    }

    @Test
    fun warmAndColdDeliveriesShareHistoryAndDoNotReAlertTheSameEvent() {
        val room = "!mixed:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$first", "first"))
        PushNotifier.show(context, warmNotification(room, "\$second", "second"))
        val alerted = conversations().single().notification
        PushNotifier.show(context, warmNotification(room, "\$second", "second"))
        PushNotifier.showFromPush(context, pushPayload(room, "\$second", "second"))
        val posted = conversations().single().notification
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted)!!
        assertEquals(listOf("first", "second"), style.messages.map { it.text.toString() })
        assertSame(alerted, posted)
    }

    @Test
    fun theRunningAppDoesNotRepostAnEventThePushAlreadyShowed() {
        val room = "!local:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$one", "hello"))
        val alerted = conversations().single().notification
        PushNotifier.show(context, warmNotification(room, "\$one", "hello"))
        assertSame(alerted, conversations().single().notification)
    }

    @Test
    fun historyIsBoundedAndHiddenPreviewsDoNotLeakEarlierMessages() {
        val room = "!history:example.org"
        for (i in 1..12) PushNotifier.showFromPush(context, pushPayload(room, "\$event$i", "body$i"))
        fun messages() = androidx.core.app.NotificationCompat.MessagingStyle
            .extractMessagingStyleFromNotification(conversations().single().notification)!!.messages
        assertEquals((5..12).map { "body$it" }, messages().map { it.text.toString() })
        PushPolicy(context).showContent = false
        PushNotifier.showFromPush(context, pushPayload(room, "\$event12", "body12"))
        assertTrue(messages().all { it.text.toString() == "New message" })
    }

    @Test
    fun dismissedEventDoesNotReturnFromEitherDeliveryPath() {
        val room = "!replay:example.org"
        val payload = pushPayload(room, "\$seen", "already seen")
        PushNotifier.showFromPush(context, payload)
        notificationManager.cancelAll()
        PushNotifier.showFromPush(context, payload)
        assertTrue(conversations().isEmpty())
        PushNotifier.show(context, warmNotification(room, "\$seen", "already seen"))
        assertTrue(conversations().isEmpty())
    }

    @Test
    fun eventEvictedFromPreviewHistoryDoesNotReturnAsNew() {
        val room = "!replay:example.org"
        for (i in 1..12) PushNotifier.showFromPush(context, pushPayload(room, "\$event$i", "body$i"))
        PushNotifier.showFromPush(context, pushPayload(room, "\$event1", "body1"))
        val messages = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
            conversations().single().notification)!!.messages
        assertEquals((5..12).map { "body$it" }, messages.map { it.text.toString() })
    }

    @Test
    fun decryptionFinishingOutOfOrderKeepsLatestMessageAndTargets() {
        val room = "!history:example.org"
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
                PushNotifier.showFromPush(context, pushPayload(room, "\$second", "second"), receivedAt = 2_000L)
                PushDecryptResult.Success("""{"content":{"body":"first"}}""")
            }
            val payload = JSONObject(pushPayload(room, "\$first"))
            payload.getJSONObject("notification").put("type", "m.room.encrypted")
            PushNotifier.showFromPush(context, payload.toString(), receivedAt = 1_000L)
            val posted = conversations().single().notification
            assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("second"))
            assertEquals(2_000L, posted.`when`)
            val messages = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
                conversations().single().notification)!!.messages
            assertEquals(listOf("first", "second"), messages.map { it.text.toString() })
            val intent = shadowOf(conversations().single().notification.contentIntent).savedIntent
            val target = JSONObject(intent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!).getJSONObject("extra")
            assertEquals("\$second", target.getString("event_id"))
            val actions = conversations().single().notification.actions
            assertEquals(2, actions.size)
            for (action in actions) {
                val actionIntent = shadowOf(action.actionIntent).savedIntent
                val extra = JSONObject(actionIntent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!).getJSONObject("extra")
                assertEquals("\$second", extra.getString("event_id"))
            }
        } finally { unmockkObject(PushPayloadDecryptor) }
    }

    @Test
    fun aWarmDeliveryDelayedByMediaKeepsReceiptOrder() {
        val room = "!warm-history:example.org"
        every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } answers {
            every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } returns null
            PushNotifier.showFromPush(context, pushPayload(room, "\$second", "second"), receivedAt = 2_000L)
            null
        }

        PushNotifier.show(context, warmNotification(room, "\$first", "first"), receivedAt = 1_000L)

        assertEquals(listOf("first", "second"), shownTexts())
        val posted = conversations().single().notification
        assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("second"))
        assertEquals(2_000L, posted.`when`)
    }

    @Test
    fun readClearIsAppliedBeforeNewMessagesAreQueued() {
        val user = "@alice:example.org"
        val room = "!room:example.org"
        val id = PushNotifier.roomNotificationId(user, room)
        val previous = PushNotificationGate.revision(context, id)
        PushRenderWorker.enqueue(context, JSONObject().put("notification", JSONObject()
            .put("user_id", user).put("room_id", room)
            .put("counts", JSONObject().put("unread", 0))).toString())
        val next = PushNotificationGate.revision(context, id)
        assertNotEquals(previous, next)
        PushNotifier.showFromPush(context, pushPayload(room, "\$new", userId = user), next)
        assertEquals(1, conversations().size)
    }

    @Test
    fun dismissedQueuedPushCannotPostButNewPushCan() {
        val user = "@alice:example.org"
        val room = "!room:example.org"
        val id = PushNotifier.roomNotificationId(user, room)
        val revision = PushNotificationGate.revision(context, id)
        val payload = pushPayload(room, "\$event", userId = user)
        PushNotificationGate.dismiss(context, id) { notificationManager.cancel(id) }
        PushNotifier.showFromPush(context, payload, revision)
        assertTrue(conversations().isEmpty())
        PushNotifier.showFromPush(context, payload, PushNotificationGate.revision(context, id))
        assertEquals(1, conversations().size)
    }

    @Test
    fun globalDismissalInvalidatesAllQueuedRoomsButRoomDismissalIsScoped() {
        val first = PushNotificationGate.revision(context, 1)
        val second = PushNotificationGate.revision(context, 2)
        PushNotificationGate.dismiss(context, 1) {}
        var posted = false
        PushNotificationGate.post(context, 2, second) { posted = true }
        assertTrue(posted)
        PushNotificationGate.dismiss(context, null) {}
        PushNotificationGate.post(context, 1, first) { fail("Dismissed room posted") }
        PushNotificationGate.post(context, 2, second) { fail("Cleared room posted") }
    }

    @Test
    fun recordsWhyARecipientBoundPushWasDropped() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE", "@bob:example.org" to "BOB")
        for ((recipient, outcome) in listOf(null to PushOutcome.MISSING_RECIPIENT, "@other:example.org" to PushOutcome.WRONG_RECIPIENT)) {
            PushNotifier.showFromPush(context, pushPayload("!room:example.org", "\$event", userId = recipient))
            assertEquals(outcome.name, PushDiagnostics.drain(context).lastOutcome)
            assertTrue(conversations().isEmpty())
        }
    }

    @Test
    fun aRoomPushWithoutARecipientGoesToTheOnlySignedInAccount() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE")

        PushNotifier.showFromPush(context, pushPayload("!room:example.org", "\$event", userId = null))

        assertEquals(
            listOf(PushNotifier.roomNotificationId("@alice:example.org", "!room:example.org")),
            conversations().map { it.id }
        )
    }

    @Test
    fun aSignedInAccountOtherThanTheActiveOneStillNotifies() {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "ALICE", "@bob:example.org" to "BOB")

        PushNotifier.showFromPush(
            context,
            pushPayload("!room:example.org", "\$bob", userId = "@bob:example.org")
        )
        assertEquals(1, conversations().size)

        PushNotifier.showFromPush(
            context,
            pushPayload("!other:example.org", "\$stranger", userId = "@carol:example.org")
        )
        assertEquals(PushOutcome.WRONG_RECIPIENT.name, PushDiagnostics.drain(context).lastOutcome)
        assertEquals(1, conversations().size)
    }

    @Test
    fun hiddenPlaintextNeverReachesTheNotification() {
        PushPolicy(context).showContent = false
        PushNotifier.showFromPush(context, pushPayload("!private:example.org", "$" + "private", "secret text"))
        val shown = conversations().single().notification
        assertFalse(shown.extras.toString().contains("secret text"))
    }

    @Test
    fun aDiagnosticPushIsRecordedAndNeverPosted() {
        PushDiagnostics.clearHistory(context)
        PushPolicy(context).notificationsEnabled = false

        PushNotifier.showFromPush(context, pushPayload("!diagnostic:sable.invalid", "${'$'}sable-diagnostic-abc"))

        assertTrue(conversations().isEmpty())
        val entry = PushDiagnostics.history(context).getJSONObject(0)
        assertEquals("DIAGNOSTIC_RECEIVED", entry.getString("outcome"))
        assertEquals("${'$'}sable-diagnostic-abc", entry.getString("eventId"))
        PushPolicy(context).notificationsEnabled = true
    }

    @Test
    fun aPostedPushIsTracedInTheHistory() {
        PushDiagnostics.clearHistory(context)

        PushNotifier.showFromPush(context, pushPayload("!traced:example.org", "${'$'}traced"))

        val outcomes = (0 until PushDiagnostics.history(context).length())
            .map { PushDiagnostics.history(context).getJSONObject(it) }
        val posted = outcomes.single { it.getString("outcome") == "POSTED" }
        assertEquals("!traced:example.org", posted.getString("roomId"))
        assertEquals("${'$'}traced", posted.getString("eventId"))
        assertEquals("@alice:example.org", posted.getString("userId"))
    }

    @Test
    fun messageNotificationsCarryTheAccountWideUnreadCount() {
        val payload = JSONObject(pushPayload("!count:example.org", "\$one"))
        payload.getJSONObject("notification").put("counts", JSONObject().put("unread", 7))
        PushNotifier.showFromPush(context, payload.toString())
        assertEquals(7, conversations().single().notification.number)

        PushNotifier.showFromPush(context, pushPayload("!plain:example.org", "\$two"))
        val plain = conversations().single { it.id != PushNotifier.roomNotificationId("@alice:example.org", "!count:example.org") }
        assertEquals(0, plain.notification.number)
    }

    @Test
    fun messageAndInviteNotificationsHideTheirContentOnTheLockScreen() {
        PushNotifier.showFromPush(context, pushPayload("!lock:example.org", "\$one", "secret text"))
        val invite = JSONObject(pushPayload("!invite:example.org", "\$invite"))
        invite.getJSONObject("notification").put("type", "m.room.member")
            .put("content", JSONObject().put("membership", "invite"))
        PushNotifier.showFromPush(context, invite.toString())

        val shown = conversations().map { it.notification }
        assertEquals(2, shown.size)
        for (notification in shown) {
            assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
            val public = notification.publicVersion!!
            assertEquals(notification.channelId, public.channelId)
            assertFalse(public.extras.toString().contains("secret text"))
            assertNull(public.extras.getCharSequence(Notification.EXTRA_TEXT))
        }
        assertEquals(
            setOf("New message", "New Invitation"),
            shown.map { it.publicVersion!!.extras.getCharSequence(Notification.EXTRA_TITLE).toString() }.toSet()
        )
    }

    @Test
    fun incomingCallsStayPublic() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"org.matrix.msc4075.rtc.notification","content":{"notification_type":"ring","lifetime":30000}}""")
        PushNotifier.showFromPush(context, ringPayload("!call:example.org", "\$ring"))
        val call = notificationManager.activeNotifications.single().notification
        assertEquals(Notification.VISIBILITY_PUBLIC, call.visibility)
        assertNull(call.publicVersion)
    }

    @Test
    fun oneSummaryGroupsEveryConversationAndOnlyChildrenAlert() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE", "@bob:example.org" to "BOB")
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))
        PushNotifier.showFromPush(context, pushPayload("!two:example.org", "\$two", userId = "@bob:example.org"))

        val summaries = notificationManager.activeNotifications.filter { it.id == PushNotifier.SUMMARY_ID }
        val summary = summaries.single().notification
        assertTrue(summary.flags and Notification.FLAG_GROUP_SUMMARY != 0)
        assertEquals(Notification.GROUP_ALERT_CHILDREN, summary.groupAlertBehavior)
        assertEquals("matrix_messages", summary.group)
        assertEquals(conversations()[0].notification.channelId, summary.channelId)
        assertTrue(conversations().all { it.notification.group == "matrix_messages" })
        assertTrue(conversations().none { it.id == PushNotifier.SUMMARY_ID })
    }

    @Test
    fun theSummaryGoesWhenTheLastConversationIsDismissed() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE", "@bob:example.org" to "BOB")
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))
        PushNotifier.showFromPush(context, pushPayload("!two:example.org", "\$two", userId = "@bob:example.org"))

        PushNotifier.showFromPush(context, accountReadPayload("@alice:example.org"))
        assertEquals(2, notificationManager.activeNotifications.size)

        PushNotifier.showFromPush(context, accountReadPayload("@bob:example.org"))
        assertTrue(notificationManager.activeNotifications.isEmpty())
    }

    @Test
    fun theSummaryGoesWhenAReadUpdateDismissesTheLastConversation() {
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))
        PushNotifier.showFromPush(context, """{"notification":{"user_id":"@alice:example.org","room_id":"!one:example.org","counts":{"unread":0}}}""")
        assertTrue(notificationManager.activeNotifications.isEmpty())
    }

    @Test
    fun theSummaryIdNeverNamesAConversation() {
        assertTrue(PushNotifier.SUMMARY_ID < 0)
        assertTrue(PushNotifier.roomNotificationId("@alice:example.org", "!r:example.org") >= 0)
        assertTrue(PushNotifier.fallbackNotificationId("!r:example.org") >= 0)
    }

    private fun pushPayload(
        roomId: String,
        eventId: String,
        body: String = "hello",
        userId: String? = "@alice:example.org"
    ): String {
        val notification = JSONObject()
            .put("room_id", roomId)
            .put("event_id", eventId)
            .put("room_name", "Room 1")
            .put("sender_display_name", "Alice")
            .put("type", "m.room.message")
            .put("content", JSONObject().put("body", body))
        return JSONObject()
            .put("notification", notification)
            .apply { if (userId != null) put("user_id", userId) }
            .toString()
    }

    private fun warmNotification(roomId: String, eventId: String, body: String) = JSONObject()
        .put("user_id", "@alice:example.org")
        .put("room_id", roomId)
        .put("event_id", eventId)
        .put("room_name", "Room 1")
        .put("sender_display_name", "Alice")
        .put("content", JSONObject().put("body", body))

    private fun shownTexts(): List<String> = androidx.core.app.NotificationCompat.MessagingStyle
        .extractMessagingStyleFromNotification(conversations().single().notification)!!
        .messages.map { it.text.toString() }

    private fun richContent() = JSONObject()
        .put("msgtype", "m.text")
        .put("body", "<a data-mention-type=\"user\" href=\"https://matrix.to/#/@alice:example.org\" contenteditable=\"false\">Alice</a> hi &amp; welcome")
        .put("format", "org.matrix.custom.html")
        .put("formatted_body", "<a href=\"https://matrix.to/#/@alice:example.org\">Alice</a> hi &amp; welcome")

    @Test
    fun richTextPushUsesPlainPreviewInNotificationAndHistory() {
        val payload = JSONObject(pushPayload("!rich:example.org", "\$rich"))
        payload.getJSONObject("notification").put("content", richContent())

        PushNotifier.showFromPush(context, payload.toString())

        assertEquals(listOf("Alice hi & welcome"), shownTexts())
        val posted = conversations().single().notification
        assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("Alice hi & welcome"))
        PushNotifier.show(context, warmNotification("!rich:example.org", "\$next", "next"))
        assertEquals(listOf("Alice hi & welcome", "next"), shownTexts())
    }

    @Test
    fun fetchedRichTextPushUsesPlainPreview() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE")
        val clear = JSONObject().put("type", "m.room.message").put("content", richContent())
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success(clear.toString())
        val payload = JSONObject(pushPayload("!rich:example.org", "\$rich"))
        payload.getJSONObject("notification").remove("content")

        PushNotifier.showFromPush(context, payload.toString())

        assertEquals(listOf("Alice hi & welcome"), shownTexts())
    }

    @Test
    fun locallyDecryptedRichTextPushUsesPlainPreview() {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        val clear = JSONObject().put("type", "m.room.message").put("content", richContent())
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success(clear.toString())
        val payload = JSONObject(pushPayload("!rich:example.org", "\$rich"))
        payload.getJSONObject("notification").put("type", "m.room.encrypted")

        PushNotifier.showFromPush(context, payload.toString())

        assertEquals(listOf("Alice hi & welcome"), shownTexts())
    }

    @Test
    fun decryptedRichTextPushUsesPlainPreview() {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        val clear = JSONObject().put("type", "m.room.message").put("content", richContent())
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success(clear.toString())
        val payload = JSONObject(pushPayload("!rich:example.org", "\$rich"))
        payload.getJSONObject("notification").put("type", "m.room.encrypted")

        PushNotifier.showFromPush(context, payload.toString())

        assertEquals(listOf("Alice hi & welcome"), shownTexts())
    }

    @Test
    fun plainTextPushKeepsLiteralMarkup() {
        val body = "<b>literal</b> &amp; text"
        for ((index, format) in listOf(null, "org.example.other", 5).withIndex()) {
            val payload = JSONObject(pushPayload("!literal:example.org", "\$literal$index", body))
            payload.getJSONObject("notification").getJSONObject("content")
                .put("format", format).put("formatted_body", "<b>formatted</b>")
            PushNotifier.showFromPush(context, payload.toString())
            assertEquals(List(index + 1) { body }, shownTexts())
        }
    }

    @Test
    fun unavailableRichTextPreviewUsesGenericMessage() {
        every { PushPayloadDecryptor.previewBody(any(), any()) } returns null
        val payload = JSONObject(pushPayload("!rich:example.org", "\$rich"))
        payload.getJSONObject("notification").put("content", richContent())

        PushNotifier.showFromPush(context, payload.toString())

        assertEquals(listOf("New message"), shownTexts())
    }

    @Test
    fun warmRichTextNotificationUsesPlainPreview() {
        val notification = warmNotification("!rich:example.org", "\$rich", "").put("content", richContent())
        PushNotifier.show(context, notification)
        assertEquals(listOf("Alice hi & welcome"), shownTexts())
    }

    @Test
    fun show_postsNothingWhileNotificationsAreDisabled() {
        PushPolicy(context).notificationsEnabled = false
        PushNotifier.show(context, warmNotification("!warm:example.org", "\$one", "hello"))
        assertTrue(conversations().isEmpty())
    }

    @Test
    fun show_hidesTheBodyWhenContentIsOff() {
        PushPolicy(context).showContent = false
        PushNotifier.show(context, warmNotification("!warm:example.org", "\$one", "secret"))
        assertEquals(listOf("New message"), shownTexts())
    }

    @Test
    fun show_hidesADecryptedBodyUnlessEncryptedContentIsAllowed() {
        val encrypted = warmNotification("!warm:example.org", "\$one", "secret").put("moe.sable.encrypted", true)
        PushNotifier.show(context, encrypted)
        assertEquals(listOf("New message"), shownTexts())
        notificationManager.cancelAll()
        PushPolicy(context).showEncryptedContent = true
        PushNotifier.show(context, warmNotification("!warm:example.org", "\$two", "secret").put("moe.sable.encrypted", true))
        assertEquals(listOf("secret"), shownTexts())
    }

    @Test
    fun show_aDirectChatHasNoConversationTitle() {
        PushNotifier.show(context, warmNotification("!dm:example.org", "\$one", "hi").put("moe.sable.direct", true))
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
            conversations().single().notification)!!
        assertNull(style.conversationTitle)
        assertFalse(style.isGroupConversation)
    }

    @Test
    fun show_aLineWithoutADisplayNameIsNeverTheReader() {
        val named = warmNotification("!room:example.org", "\$one", "hi")
        named.remove("sender_display_name")
        PushNotifier.show(context, named.put("sender", "@bob:example.org"))
        PushNotifier.show(context, warmNotification("!room:example.org", "\$two", "yo").apply { remove("sender_display_name") })
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
            conversations().single().notification)!!
        assertEquals(listOf("@bob:example.org", "Someone"), style.messages.map { it.person?.name?.toString() })
    }

    @Test
    fun show_aWarmInvitationHasAcceptAndDecline() {
        val invite = warmNotification("!invite:example.org", "", "").put("type", "m.room.member")
            .put("content", JSONObject().put("membership", "invite"))
        PushNotifier.show(context, invite)
        val posted = conversations().single().notification
        assertEquals("invites", posted.channelId)
        assertEquals(
            listOf(PushActions.ACCEPT_INVITE, PushActions.DECLINE_INVITE),
            posted.actions.map { shadowOf(it.actionIntent).savedIntent.getStringExtra(NotificationIntents.ACTION) },
        )
    }

    @Test
    fun show_keepsTheCanonicalIdSoAPushAndTheAppShareOneAlert() {
        PushNotifier.showFromPush(context, pushPayload("!same:example.org", "\$one", "first"))
        PushNotifier.show(context, warmNotification("!same:example.org", "\$two", "second"))
        assertEquals(listOf("first", "second"), shownTexts())
    }

    private fun ringPayload(
        roomId: String,
        eventId: String,
        notificationType: String = "ring",
        userId: String? = "@alice:example.org"
    ): String {
        val notification = JSONObject()
            .put("room_id", roomId)
            .put("event_id", eventId)
            .put("room_name", "Room 1")
            .put("sender_display_name", "Alice")
            .put("type", "org.matrix.msc4075.rtc.notification")
            .put(
                "content",
                JSONObject()
                    .put("notification_type", notificationType)
                    .put("lifetime", 30000)
            )
        return JSONObject()
            .put("notification", notification)
            .apply { if (userId != null) put("user_id", userId) }
            .toString()
    }

    private fun canonicalId(roomId: String, userId: String = "@alice:example.org") =
        PushNotifier.roomNotificationId(userId, roomId)

    @Test
    fun showFromPush_ntfyPayloadUsesRegisteredAccountForIdentityAndTap() {
        val payload = JSONObject(pushPayload("!ntfy:example.org", "\$ntfy", userId = null))
        payload.getJSONObject("notification").put("devices", org.json.JSONArray().put(
            JSONObject().put("pushkey", "https://ntfy.sh/up123?up=1").put("data",
                JSONObject().put("default_payload", JSONObject().put("user_id", "@alice:example.org")))
        ))
        PushNotifier.showFromPush(context, payload.toString())
        val posted = shadowNotificationManager().getNotification(null, canonicalId("!ntfy:example.org"))
        assertNotNull("ntfy delivery must use the same identity as warm enrichment", posted)
        val source = shadowOf(posted!!.contentIntent).savedIntent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!
        assertTrue(source.contains("@alice:example.org"))
    }

    @Test
    fun showFromPush_routesSupportedGatewayPayloadsToTheSameAccountAndRoom() {
        for (wrapper in listOf("flat", "object", "string")) {
            for (recipient in listOf("notification", "envelope", "device", "default_payload")) {
                val notification = JSONObject()
                    .put("room_id", "!contract:example.org")
                    .put("event_id", "\$contract-$wrapper-$recipient")
                    .put("type", "m.room.message")
                    .put("content", JSONObject().put("body", "contract message"))
                val envelope = when (wrapper) {
                    "flat" -> notification
                    else -> JSONObject()
                }
                when (recipient) {
                    "notification" -> notification.put("user_id", "@alice:example.org")
                    "envelope" -> envelope.put("user_id", "@alice:example.org")
                    else -> {
                        val data = JSONObject()
                        if (recipient == "device") data.put("user_id", "@alice:example.org")
                        else data.put("default_payload", JSONObject().put("user_id", "@alice:example.org"))
                        notification.put("devices", org.json.JSONArray().put(JSONObject().put("data", data)))
                    }
                }
                if (wrapper == "object") envelope.put("notification", notification)
                if (wrapper == "string") envelope.put("notification", notification.toString())
                notificationManager.cancelAll()
                PushNotifier.showFromPush(context, envelope.toString())
                val posted = shadowNotificationManager().getNotification(null, canonicalId("!contract:example.org"))
                assertNotNull("$wrapper / $recipient", posted)
                assertTrue(posted!!.extras.getString(Notification.EXTRA_TEXT)!!.contains("contract message"))
                val source = shadowOf(posted.contentIntent).savedIntent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!
                assertTrue(source.contains("@alice:example.org"))
            }
        }
    }

    @Test
    fun showFromPush_acceptsFlatMinimalPush() {
        val payload = JSONObject().put("room_id", "!flat:example.org")
            .put("event_id", "\$flat").put("user_id", "@alice:example.org").toString()
        PushNotifier.showFromPush(context, payload)
        assertNotNull(shadowNotificationManager().getNotification(null, canonicalId("!flat:example.org")))
    }

    @Test
    fun showFromPush_encryptedRoomKeepsConversationTitle() {
        assertConversationTitle("m.room.encrypted")
    }

    @Test
    fun showFromPush_unencryptedRoomKeepsConversationTitle() {
        assertConversationTitle("m.room.message")
    }

    private fun assertConversationTitle(eventType: String) {
        val payload = JSONObject(pushPayload("!named:example.org", "event"))
        payload.getJSONObject("notification").put("type", eventType)

        PushNotifier.showFromPush(context, payload.toString())

        val posted = shadowNotificationManager().getNotification(null, canonicalId("!named:example.org"))
        assertEquals("Room 1", posted.extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE))
        assertTrue(posted.extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION))
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted)!!
        assertEquals("Alice", style.messages.last().person?.name)
        assertEquals(if (eventType == "m.room.encrypted") "Encrypted message" else "hello", style.messages.last().text)
        val source = shadowOf(posted.contentIntent).savedIntent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!
        assertTrue(source.contains("@alice:example.org"))
        assertTrue(source.contains("!named:example.org"))
        assertTrue(source.contains("event"))
    }

    @Test
    fun showFromPush_waitsForNativeDecryptionBeforeAlerting() {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        var baselineWasVisible = false
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
                baselineWasVisible = shadowNotificationManager().getNotification(null, canonicalId("!enc:example.org")) != null
                PushDecryptResult.Success("""{"content":{"body":"decrypted"}}""")
            }
            val payload = JSONObject(pushPayload("!enc:example.org", "\$enc"))
            payload.getJSONObject("notification").put("type", "m.room.encrypted")
            PushNotifier.showFromPush(context, payload.toString())
            assertFalse(baselineWasVisible)
            val posted = shadowNotificationManager().getNotification(null, canonicalId("!enc:example.org"))!!
            assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("decrypted"))
            assertEquals("Room 1", posted.extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE))
            assertTrue(posted.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
    }

    @Test
    fun showFromPush_honorsPrivacyChangesDuringDecryption() {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
                state.showEncryptedContent = false
                PushDecryptResult.Success("""{"content":{"body":"private plaintext"}}""")
            }
            val payload = JSONObject(pushPayload("!enc:example.org", "\$enc"))
            payload.getJSONObject("notification").put("type", "m.room.encrypted")
            PushNotifier.showFromPush(context, payload.toString())
            val posted = shadowNotificationManager().getNotification(null, canonicalId("!enc:example.org"))!!
            assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("Encrypted message"))
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
    }

    private fun encryptedPush(room: String, event: String): String {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        val payload = JSONObject(pushPayload(room, event))
        payload.getJSONObject("notification").put("type", "m.room.encrypted")
        return payload.toString()
    }

    @Test
    fun showFromPush_postsNothingForAnEventThePushRulesSilence() {
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.Discard
            PushNotifier.showFromPush(context, encryptedPush("!quiet:example.org", "\$reaction"))
            assertTrue(shadowNotificationManager().allNotifications.isEmpty())
            verify(exactly = 0) { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) }
        } finally { unmockkObject(PushPayloadDecryptor) }
    }

    @Test
    fun showFromPush_recordsWhenThePushRulesCouldNotBeEvaluated() {
        PushDiagnostics.clearHistory(context)
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.DiscardUnevaluated
            PushNotifier.showFromPush(context, encryptedPush("!unknown:example.org", "\$unknown"))
            assertTrue(shadowNotificationManager().allNotifications.isEmpty())
            verify(exactly = 0) { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) }
            val history = PushDiagnostics.history(context)
            assertEquals("RULES_UNEVALUATED", history.getJSONObject(history.length() - 1).getString("outcome"))
        } finally { unmockkObject(PushPayloadDecryptor) }
    }

    @Test
    fun showFromPush_postsALocallyDecryptedMessageWithoutABaseline() {
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.Success("""{"content":{"body":"straight away"}}""")
            PushNotifier.showFromPush(context, encryptedPush("!fast:example.org", "\$fast"))
            val posted = shadowNotificationManager().getNotification(null, canonicalId("!fast:example.org"))!!
            assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("straight away"))
            verify(exactly = 0) { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) }
        } finally { unmockkObject(PushPayloadDecryptor) }
    }

    @Test
    fun showFromPush_aDecryptedEventWhoseRuleRingsIsNeverQuieted() {
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.Success("""{"content":{"body":"hi"},"moe.sable.noisy":true}""")
            PushNotifier.showFromPush(context, encryptedPush("!dm:example.org", "\$one"))
            PushNotifier.showFromPush(context, encryptedPush("!dm:example.org", "\$two"))
            val posted = shadowNotificationManager().getNotification(null, canonicalId("!dm:example.org"))!!
            assertTrue(posted.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)
        } finally { unmockkObject(PushPayloadDecryptor) }
    }

    @Test
    fun showFromPush_waitsForTheKeyWithoutABaselineWhenEveryEncryptedEventIsPushed() {
        mockkObject(PushPayloadDecryptor)
        try {
            var baselineWasVisible = true
            every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.NeedsKey(quietly = true)
            every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
                baselineWasVisible = shadowNotificationManager().allNotifications.isNotEmpty()
                PushDecryptResult.Discard
            }
            PushNotifier.showFromPush(context, encryptedPush("!msc4028:example.org", "\$edit"))
            assertFalse(baselineWasVisible)
            assertTrue(shadowNotificationManager().allNotifications.isEmpty())
        } finally { unmockkObject(PushPayloadDecryptor) }
    }

    @Test
    fun showFromPush_fetchesCallContentWhenTheGatewayOmitsIt() {
        val room = "!call-content:example.org"
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"m.rtc.notification","content":{"notification_type":"ring","lifetime":30000}}""")
        val notification = JSONObject().put("room_id", room).put("event_id", "\$ring")
            .put("user_id", "@alice:example.org").put("type", "m.rtc.notification")

        PushNotifier.showFromPush(context, notification.toString())

        val incoming = conversations().single()
        assertEquals(PushNotifier.callNotificationId("@alice:example.org", room), incoming.id)
        assertEquals(Notification.CATEGORY_CALL, incoming.notification.category)
    }

    @Test
    fun showFromPush_fetchesTheCallKeyWhenAllPreviewsAreHidden() {
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.NeedsKey(quietly = false)
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"m.rtc.notification","content":{"notification_type":"ring","lifetime":30000}}""")
        val room = "!private-call:example.org"
        val payload = encryptedPush(room, "\$ring")
        PushPolicy(context).showContent = false
        PushPolicy(context).showEncryptedContent = false

        PushNotifier.showFromPush(context, payload)

        val incoming = conversations().single()
        assertEquals(PushNotifier.callNotificationId("@alice:example.org", room), incoming.id)
        assertEquals(Notification.CATEGORY_CALL, incoming.notification.category)
        assertNotNull(incoming.notification.fullScreenIntent)
        assertTrue(incoming.notification.flags and Notification.FLAG_INSISTENT != 0)
    }

    @Test
    fun showFromPush_fetchesTheCallKeyWhenEncryptedPreviewsAreHidden() {
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.NeedsKey(quietly = false)
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"m.rtc.notification","content":{"notification_type":"ring","lifetime":30000}}""")
        val room = "!private-call:example.org"
        val payload = encryptedPush(room, "\$ring")
        PushPolicy(context).showContent = true
        PushPolicy(context).showEncryptedContent = false

        PushNotifier.showFromPush(context, payload)

        val incoming = conversations().single()
        assertEquals(PushNotifier.callNotificationId("@alice:example.org", room), incoming.id)
        assertEquals(Notification.CATEGORY_CALL, incoming.notification.category)
        assertNotNull(incoming.notification.fullScreenIntent)
        assertTrue(incoming.notification.flags and Notification.FLAG_INSISTENT != 0)
    }

    @Test
    fun showFromPush_fetchesTheCallKeyWhenMessagePreviewsAreHidden() {
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.NeedsKey(quietly = false)
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"m.rtc.notification","content":{"notification_type":"ring","lifetime":30000}}""")
        val room = "!private-call:example.org"
        val payload = encryptedPush(room, "\$ring")
        PushPolicy(context).showContent = false
        PushPolicy(context).showEncryptedContent = true

        PushNotifier.showFromPush(context, payload)

        val incoming = conversations().single()
        assertEquals(PushNotifier.callNotificationId("@alice:example.org", room), incoming.id)
        assertEquals(Notification.CATEGORY_CALL, incoming.notification.category)
        assertNotNull(incoming.notification.fullScreenIntent)
        assertTrue(incoming.notification.flags and Notification.FLAG_INSISTENT != 0)
    }

    @Test
    fun showFromPush_waitsForAMissingKeyBeforeAlerting() {
        mockkObject(PushPayloadDecryptor)
        try {
            var baselineWasVisible = false
            every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.NeedsKey(quietly = false)
            every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
                baselineWasVisible = shadowNotificationManager().allNotifications.isNotEmpty()
                PushDecryptResult.Success("""{"content":{"body":"after the key"}}""")
            }
            PushNotifier.showFromPush(context, encryptedPush("!slow:example.org", "\$slow"))
            assertFalse(baselineWasVisible)
            val posted = shadowNotificationManager().getNotification(null, canonicalId("!slow:example.org"))!!
            assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("after the key"))
        } finally { unmockkObject(PushPayloadDecryptor) }
    }

    @Test
    fun showFromPush_discardsARedactedRichPushWithoutFetching() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE")
        val notification = JSONObject(pushPayload("!redacted:example.org", "\$redacted")).getJSONObject("notification")
            .put("user_id", "@alice:example.org")
            .put("unsigned", JSONObject().put("redacted_because", JSONObject()))

        PushNotifier.showFromPush(context, notification.toString())

        assertTrue(conversations().isEmpty())
        verify(exactly = 0) { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) }
    }

    @Test
    fun showFromPush_discardsARedactedFetchedEvent() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"m.room.message","content":{},"unsigned":{"redacted_because":{}}}""")

        PushNotifier.showFromPush(context, """{"room_id":"!redacted:example.org","event_id":"${'$'}redacted","user_id":"@alice:example.org"}""")

        assertTrue(conversations().isEmpty())
    }

    @Test
    fun showFromPush_discardsARedactedLocallyDecryptedEvent() {
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"m.room.message","content":{},"unsigned":{"redacted_because":{}}}""")

        PushNotifier.showFromPush(context, encryptedPush("!redacted:example.org", "\$redacted"))

        assertTrue(conversations().isEmpty())
    }

    @Test
    fun showFromPush_discardsARedactedEventAfterFetchingItsKey() {
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.NeedsKey(quietly = false)
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
            assertTrue(conversations().isEmpty())
            PushDecryptResult.Success("""{"type":"m.room.message","content":{},"unsigned":{"redacted_because":{}}}""")
        }

        PushNotifier.showFromPush(context, encryptedPush("!redacted:example.org", "\$redacted"))

        assertTrue(conversations().isEmpty())
    }

    @Test
    fun showFromPush_doesNotFetchACompletePlainPush() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE")

        PushNotifier.showFromPush(context, pushPayload("!rich:example.org", "\$rich", "from the gateway"))

        assertEquals(listOf("from the gateway"), shownTexts())
        verify(exactly = 0) { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) }
    }

    @Test
    fun showFromPush_doesNotFilterEventTypesAllowedByTheSdk() {
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"org.example.alert","content":{"body":"Custom alert"}}""")

        PushNotifier.showFromPush(context, encryptedPush("!custom:example.org", "\$custom"))

        assertEquals(listOf("Custom alert"), shownTexts())
    }

    @Test
    fun showFromPush_doesNotAlertWhenAKeyFetchDiscardsTheEvent() {
        val room = "!existing:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$message"))
        val previous = conversations().single().notification
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.NeedsKey(quietly = false)
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
            assertSame(previous, conversations().single().notification)
            PushDecryptResult.Discard
        }

        PushNotifier.showFromPush(context, encryptedPush(room, "\$filtered"))

        assertSame(previous, conversations().single().notification)
    }

    @Test
    fun showFromPush_doesNotAlertWhenAKeyFetchCannotEvaluateTheRules() {
        val room = "!existing:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$message"))
        val previous = conversations().single().notification
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.NeedsKey(quietly = false)
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
            assertSame(previous, conversations().single().notification)
            PushDecryptResult.DiscardUnevaluated
        }

        PushNotifier.showFromPush(context, encryptedPush(room, "\$filtered"))

        assertSame(previous, conversations().single().notification)
    }

    @Test
    fun showFromPush_doesNotPostAFallbackWhenNotificationsAreDisabledDuringKeyFetch() {
        val payload = encryptedPush("!disabled:example.org", "\$disabled")
        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.NeedsKey(quietly = false)
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
            PushPolicy(context).notificationsEnabled = false
            PushDecryptResult.Failure(PushOutcome.DECRYPT_FAILED)
        }

        PushNotifier.showFromPush(context, payload)

        assertTrue(conversations().isEmpty())
    }

    @Test
    fun showFromPush_ignoresRoomCountUpdatesWithoutAnEvent() {
        PushNotifier.showFromPush(context, """{"room_id":"!counts:example.org","user_id":"@alice:example.org","counts":{"unread":5}}""")
        assertTrue(conversations().isEmpty())
    }

    @Test
    fun showFromPush_acceptsV2DeviceAccountMetadata() {
        val payload = JSONObject(pushPayload("!v2:example.org", "\$v2", userId = null))
        payload.getJSONObject("notification").put("devices", org.json.JSONArray().put(
            JSONObject().put("data", JSONObject().put("user_id", "@alice:example.org"))
        ))
        PushNotifier.showFromPush(context, payload.toString())
        assertNotNull(shadowNotificationManager().getNotification(null, canonicalId("!v2:example.org")))
    }

    @Test
    fun showFromPush_rejectsConflictingRecipientsAndControlMessages() {
        val payload = JSONObject(pushPayload("!conflict:example.org", "\$conflict"))
        payload.getJSONObject("notification").put("user_id", "@other:example.org")
        PushNotifier.showFromPush(context, payload.toString())
        PushNotifier.showFromPush(context, """{"notification":{"counts":{"unread":5}}}""")
        PushNotifier.showFromPush(context, """{"app_id":"app","ack_token":"token"}""")
        assertTrue(shadowNotificationManager().allNotifications.isEmpty())
    }

    @Test
    fun showFromPush_clearsReadRoomsWithoutPostingAnAlert() {
        PushNotifier.showFromPush(context, pushPayload("!read:example.org", "\$read"))
        PushNotifier.showFromPush(context, """{"notification":{"user_id":"@alice:example.org","room_id":"!read:example.org","counts":{"unread":0}}}""")
        assertTrue(shadowNotificationManager().allNotifications.isEmpty())
    }

    @Test
    fun showFromPush_keepsReadAlertsWhenClearingIsOff() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        PushPolicy(context).clearOnRead = false
        PushNotifier.showFromPush(context, pushPayload("!read:example.org", "\$read"))

        PushNotifier.showFromPush(context, """{"notification":{"user_id":"@alice:example.org","room_id":"!read:example.org","counts":{"unread":0}}}""")
        PushNotifier.showFromPush(context, accountReadPayload("@alice:example.org"))

        assertEquals(1, conversations().size)
    }

    @Test
    fun showFromPush_accountReadClearsThatAccountsAlertsOnly() {
        PushPolicy(context).accounts =
            mapOf("@alice:example.org" to "ALICE", "@bob:example.org" to "BOB")
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))
        PushNotifier.showFromPush(context, pushPayload("!two:example.org", "\$two", userId = "@bob:example.org"))
        PushNotifier.show(context, warmNotification("!warm:example.org", "\$warm", "warm"))
        assertEquals(3, conversations().size)

        PushNotifier.showFromPush(context, accountReadPayload("@alice:example.org"))

        assertEquals(
            listOf(PushNotifier.roomNotificationId("@bob:example.org", "!two:example.org")),
            conversations().map { it.id }
        )
    }

    @Test
    fun showFromPush_accountReadForAStrangerClearsNothing() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))

        PushNotifier.showFromPush(context, accountReadPayload("@stranger:example.org"))

        assertEquals(1, conversations().size)
    }

    @Test
    fun showFromPush_accountReadNamingNobodyClearsTheSoleAccount() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))

        PushNotifier.showFromPush(context, """{"notification":{"counts":{"unread":0}}}""")

        assertEquals(0, conversations().size)
    }

    private fun accountReadPayload(userId: String): String = JSONObject().put("notification", JSONObject()
        .put("counts", JSONObject().put("unread", 0))
        .put("devices", org.json.JSONArray().put(JSONObject().put("data", JSONObject().put("user_id", userId))))
    ).toString()

    @Test
    fun showFromPush_lateDecryptionDoesNotResurrectADismissedAlert() {
        val room = "!dismissed:example.org"
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
            PushNotificationGate.dismiss(context, canonicalId(room)) {
                notificationManager.cancel(canonicalId(room))
            }
            PushDecryptResult.Success("""{"content":{"body":"stale plaintext"}}""")
        }

        PushNotifier.showFromPush(context, encryptedPush(room, "\$old"))

        assertTrue(conversations().isEmpty())
    }

    @Test
    fun roomNotificationId_matchesDeployedJsAbsHashSemantics() {
        assertEquals(238601196, canonicalId("!r1:example.org")) // positive hash
        assertEquals(1475650254, canonicalId("!room-7:example.org")) // hash -1475650254
    }

    @Test
    fun roomNotificationId_mapsIntMinValueHashToZero() {
        val roomId = String(charArrayOf(0x00D9.toChar(), 0x001B.toChar(), 0x000C.toChar(), 0x0009.toChar(), 0x001E.toChar()))
        assertEquals(Int.MIN_VALUE, "AAA${0.toChar()}$roomId".hashCode())
        assertEquals(0, PushNotifier.roomNotificationId("AAA", roomId))
    }

    @Test
    fun fallbackNotificationId_fixedVectors() {
        assertEquals(461444550, PushNotifier.fallbackNotificationId("!r1:example.org"))
        assertEquals(708055431, PushNotifier.fallbackNotificationId("!room-2:example.org"))
        assertEquals(0, PushNotifier.fallbackNotificationId(""))
    }

    @Test
    fun showFromPush_postsUntaggedNotificationWithCanonicalIdWithExpectedFlags() {
        PushNotifier.showFromPush(context, pushPayload("!r1:example.org", "\$e1"))

        val id = canonicalId("!r1:example.org")
        val posted = shadowNotificationManager().getNotification(null, id)
        assertNotNull(posted)
        assertNull(shadowNotificationManager().getNotification("!r1:example.org", id))
        assertTrue(posted!!.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)
        assertTrue(posted.flags and Notification.FLAG_AUTO_CANCEL != 0)
    }

    @Test
    fun showFromPush_sameRoomUpdatesInPlace_andTapCarriesLatestEvent() {
        PushNotifier.showFromPush(context, pushPayload("!r1:example.org", "\$e1"))
        PushNotifier.showFromPush(context, pushPayload("!r1:example.org", "\$e2", "second"))

        assertEquals(1, conversations().size)

        val posted = shadowNotificationManager().getNotification(null, canonicalId("!r1:example.org"))!!
        val savedIntent = shadowOf(posted.contentIntent).savedIntent
        val sourceJson = savedIntent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!
        assertTrue(sourceJson.contains("\$e2"))
        assertFalse(sourceJson.contains("\$e1"))
        assertTrue(sourceJson.contains("!r1:example.org"))
    }

    @Test
    fun showFromPush_differentRoomsPostSeparatelyUntagged() {
        PushNotifier.showFromPush(context, pushPayload("!r1:example.org", "\$e1"))
        PushNotifier.showFromPush(context, pushPayload("!r2:example.org", "\$e2"))

        val shadow = shadowNotificationManager()
        assertNotNull(shadow.getNotification(null, canonicalId("!r1:example.org")))
        assertNotNull(shadow.getNotification(null, canonicalId("!r2:example.org")))
        assertEquals(2, conversations().size)
    }

    @Test
    fun showFromPush_withoutUserId_fallsBackToRoomKeyIdentity() {
        PushNotifier.showFromPush(
            context,
            pushPayload("!r3:example.org", "\$e9", userId = null)
        )

        val shadow = shadowNotificationManager()
        assertNotNull(shadow.getNotification(null, PushNotifier.fallbackNotificationId("!r3:example.org")))
        assertNull(shadow.getNotification(null, canonicalId("!r3:example.org")))
        assertEquals(1, conversations().size)
    }

    @Test
    fun ringIsRecognisedOnBothEventTypesAndOnlyForTheRingKind() {
        fun event(type: String, kind: String) = JSONObject()
            .put("type", type)
            .put("content", JSONObject().put("notification_type", kind))

        assertTrue(PushNotifier.isRing(event("m.rtc.invite", "ring")))
        assertFalse(PushNotifier.isRing(event("m.rtc.invite", "notification")))
        assertFalse(PushNotifier.isRing(JSONObject().put("type", "m.rtc.invite")))
        assertTrue(PushNotifier.isRing(event("m.rtc.notification", "ring")))
        assertTrue(PushNotifier.isRing(event("org.matrix.msc4075.rtc.notification", "ring")))
        assertFalse(PushNotifier.isRing(event("m.rtc.notification", "notification")))
        assertFalse(PushNotifier.isRing(event("m.room.message", "ring")))
        assertFalse(PushNotifier.isRing(JSONObject().put("type", "m.rtc.notification")))
    }

    @Test
    fun plaintextCallInvitesAreValidatedBeforeRinging() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns PushDecryptResult.Discard
        val notification = JSONObject()
            .put("user_id", "@alice:example.org").put("room_id", "!call:example.org")
            .put("event_id", "\$call").put("type", "m.rtc.invite")
            .put("content", JSONObject().put("notification_type", "ring"))
        PushNotifier.showFromPush(context, notification.toString())
        verify(exactly = 1) { PushPayloadDecryptor.fetch(any(), "@alice:example.org", "ALICE", "!call:example.org", "\$call") }
        assertTrue(conversations().isEmpty())
    }

    @Test
    fun validatedStableInvitesUseTheReceiverCallStyle() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"m.rtc.invite","content":{"notification_type":"ring","lifetime":1200}}""")
        val notification = JSONObject().put("user_id", "@alice:example.org")
            .put("room_id", "!stable:example.org").put("event_id", "\$stable")
            .put("type", "m.rtc.invite").put("content", JSONObject())
        PushNotifier.showFromPush(context, notification.toString())
        val posted = conversations().single().notification
        assertEquals(Notification.CATEGORY_CALL, posted.category)
        assertEquals(1200L, posted.timeoutAfter)
    }

    @Test
    fun showFromPush_eventIdOnlyPushIsFetchedBeforeItIsShown() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.fetch(any(), "@alice:example.org", "ALICE", "!bare:example.org", "\$bare") } returns
                PushDecryptResult.Success(
                    """{"type":"m.room.message","content":{"body":"fetched text"},"sender":"@bob:example.org",""" +
                        """"sender_display_name":"Bob","room_name":"Fetched room","room_avatar_url":null}"""
                )
            every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } returns
                JSONObject().put("sender_name", "Bob")
            val payload = JSONObject().put("room_id", "!bare:example.org").put("event_id", "\$bare")
                .put("user_id", "@alice:example.org").toString()

            PushNotifier.showFromPush(context, payload)

            val posted = shadowNotificationManager().getNotification(null, canonicalId("!bare:example.org"))!!
            assertEquals("Fetched room", posted.extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE))
            val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted)!!
            assertEquals("fetched text", style.messages.last().text)
            assertEquals("Bob", style.messages.last().person?.name)
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
    }

    @Test
    fun showFromPush_aFetchedEncryptedMessageHidesItsBodyUnlessEncryptedContentIsAllowed() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.Success(
                    """{"type":"m.room.message","content":{"body":"secret"},"sender":"@bob:example.org",""" +
                        """"sender_display_name":"Bob","room_name":"Room","encrypted":true}"""
                )
            every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } returns
                JSONObject().put("sender_name", "Bob")
            val payload = { event: String ->
                JSONObject().put("room_id", "!bare:example.org").put("event_id", event)
                    .put("user_id", "@alice:example.org").toString()
            }

            PushNotifier.showFromPush(context, payload("\$one"))
            assertEquals(listOf("Encrypted message"), shownTexts())

            notificationManager.cancelAll()
            PushPolicy(context).showEncryptedContent = true
            PushNotifier.showFromPush(context, payload("\$two"))
            assertEquals("secret", shownTexts().last())
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
    }

    @Test
    fun showFromPush_eventIdOnlyPushTheRulesSilenceIsDiscarded() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns PushDecryptResult.Discard
            val payload = JSONObject().put("room_id", "!quiet:example.org").put("event_id", "\$quiet")
                .put("user_id", "@alice:example.org").toString()

            PushNotifier.showFromPush(context, payload)

            assertNull(shadowNotificationManager().getNotification(null, canonicalId("!quiet:example.org")))
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
    }

    @Test
    fun showFromPush_eventIdOnlyPushWithUnevaluatedRulesIsRecorded() {
        PushDiagnostics.clearHistory(context)
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.DiscardUnevaluated
            val payload = JSONObject().put("room_id", "!unknown:example.org").put("event_id", "\$unknown")
                .put("user_id", "@alice:example.org").toString()

            PushNotifier.showFromPush(context, payload)

            assertNull(shadowNotificationManager().getNotification(null, canonicalId("!unknown:example.org")))
            val history = PushDiagnostics.history(context)
            assertEquals("RULES_UNEVALUATED", history.getJSONObject(history.length() - 1).getString("outcome"))
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
    }

    @Test
    fun aFetchedRingIsRecognisedAndNeverOverwritesThePayload() {
        val notification = JSONObject().put("room_id", "!call:example.org").put("event_id", "\$ring")
        val fetched = JSONObject()
            .put("type", "m.rtc.notification")
            .put("content", JSONObject().put("notification_type", "ring"))
            .put("room_id", "!other:example.org")
            .put("room_avatar_url", JSONObject.NULL)

        PushNotifier.mergeFetched(notification, fetched)

        assertTrue(PushNotifier.isRing(notification))
        assertEquals("!call:example.org", notification.getString("room_id"))
        assertFalse(notification.has("room_avatar_url"))
    }

    private fun imagePush(room: String): String {
        val notification = JSONObject()
            .put("room_id", room).put("event_id", "\$image").put("user_id", "@alice:example.org")
            .put("room_name", "Room 1").put("sender", "@bob:example.org").put("type", "m.room.message")
            .put("content", JSONObject().put("msgtype", "m.image").put("body", "cat.png")
                .put("url", "mxc://example.org/cat"))
        return JSONObject().put("notification", notification).toString()
    }

    private fun mediaRequests(room: String): List<JSONObject?> {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        val contents = mutableListOf<JSONObject?>()
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } answers {
                contents.add(arg(6))
                JSONObject().put("own_name", "Alice").put("own_avatar", JSONObject.NULL)
            }
            PushNotifier.showFromPush(context, imagePush(room))
        } finally {
            unmockkObject(PushPayloadDecryptor)
        }
        return contents
    }

    @Test
    fun anImageMessageAsksForItsPreview() {
        val contents = mediaRequests("!image:example.org")

        assertEquals("mxc://example.org/cat", contents.single()?.getString("url"))
        val posted = shadowNotificationManager().getNotification(null, canonicalId("!image:example.org"))!!
        val shortcut = ConversationShortcuts.id("@alice:example.org", "!image:example.org")
        assertEquals(shortcut, posted.shortcutId)
        assertEquals(shortcut, posted.locusId?.id)
        assertEquals(Notification.CATEGORY_MESSAGE, posted.category)
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted)!!
        assertEquals("@bob:example.org", style.messages.last().person?.key)
        assertEquals("@alice:example.org", style.user.key)
        assertEquals("Alice", style.user.name)
    }

    @Test
    fun senderNamesComeFromRustForEveryDelivery() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        PushPolicy(context).showEncryptedContent = true
        every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } returns
            JSONObject().put("sender_name", "Mum")
        val clear = JSONObject().put("type", "m.room.message")
            .put("content", JSONObject().put("body", "hello"))
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success(clear.toString())
        every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success(clear.toString())
        for (delivery in listOf("warm", "plain", "fetched", "placeholder", "malformed", "local", "remote", "invite", "ring", "encrypted-ring")) {
            notificationManager.cancelAll()
            val notification = warmNotification("!$delivery:example.org", "\$event", "hello")
                .put("sender", "@bob:example.org").put("sender_display_name", "Bob")
                .put("type", "m.room.message")
            every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                PushDecryptResult.Success(clear.toString())
            when (delivery) {
                "fetched" -> notification.remove("type")
                "placeholder", "malformed", "local", "remote", "encrypted-ring" -> {
                    notification.put("type", "m.room.encrypted")
                    if (delivery == "placeholder" || delivery == "remote") {
                        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                            PushDecryptResult.NeedsKey(quietly = false)
                    }
                    if (delivery == "malformed") {
                        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                            PushDecryptResult.Success("invalid")
                    }
                    if (delivery == "placeholder") PushPolicy(context).showEncryptedContent = false
                    if (delivery == "encrypted-ring") {
                        every { PushPayloadDecryptor.decryptLocally(any(), any(), any(), any(), any()) } returns
                            PushDecryptResult.Success(JSONObject().put("type", "m.rtc.notification")
                                .put("content", JSONObject().put("notification_type", "ring")).toString())
                    }
                }
                "invite" -> notification.put("type", "m.room.member")
                    .put("content", JSONObject().put("membership", "invite"))
                "ring" -> {
                    notification.put("type", "m.rtc.notification")
                        .put("content", JSONObject().put("notification_type", "ring"))
                    every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
                        PushDecryptResult.Success(notification.toString())
                }
            }
            if (delivery == "warm") PushNotifier.show(context, notification)
            else PushNotifier.showFromPush(context, notification.toString())
            val posted = conversations().single().notification
            when (delivery) {
                "invite" -> assertEquals("Mum invites you to Room 1", posted.extras.getString(Notification.EXTRA_TEXT))
                "ring", "encrypted-ring" -> assertEquals("Mum",
                    posted.extras.getParcelable("android.callPerson", android.app.Person::class.java)?.name)
                else -> {
                    val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted)!!
                    assertEquals(delivery, "Mum", style.messages.last().person?.name)
                }
            }
            verify(atLeast = 1) { PushPayloadDecryptor.media(any(), "@alice:example.org", "ALICE",
                "!$delivery:example.org", "@bob:example.org", "Bob", any()) }
            PushPolicy(context).showEncryptedContent = true
        }
    }

    @Test
    fun anUnavailableResolverUsesTheSenderId() {
        every { PushPayloadDecryptor.media(any(), any(), any(), any(), any(), any(), any()) } returns null
        val notification = warmNotification("!fallback:example.org", "\$fallback", "hello")
            .put("sender", "@bob:example.org").put("sender_display_name", "\u200b\u2800")
        PushNotifier.show(context, notification)
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
            conversations().single().notification)!!
        assertEquals("@bob:example.org", style.messages.last().person?.name)
    }

    @Test
    fun aConversationShortcutIdNamesItsAccountAndRoom() {
        val id = ConversationShortcuts.id("@alice:example.org", "!room:example.org")

        assertEquals("@alice:example.org" to "!room:example.org", ConversationShortcuts.parse(id))
        assertNull(ConversationShortcuts.parse("conversation-12345"))
        assertNull(ConversationShortcuts.parse("conversation:not base64:x"))
    }

    @Test
    @Config(sdk = [27])
    fun beforeAndroid9AnImageMessageAsksForNoPreview() {
        assertNull(mediaRequests("!old:example.org").single())
    }

    @Test
    fun aFetchedEventCarriesItsNoisyAndEncryptedFlags() {
        val notification = JSONObject().put("room_id", "!room:example.org")
        val fetched = JSONObject().put("type", "m.room.message").put("noisy", true).put("encrypted", true)

        PushNotifier.mergeFetched(notification, fetched)

        assertTrue(PushNotifier.isNoisy(notification))
        assertTrue(notification.getBoolean("moe.sable.encrypted"))
    }

    @Test
    fun callNotificationIdNeverCollidesWithTheRoomsConversation() {
        assertNotEquals(
            PushNotifier.roomNotificationId("@alice:example.org", "!r1:example.org"),
            PushNotifier.callNotificationId("@alice:example.org", "!r1:example.org")
        )
    }

    @Test
    fun incomingCallsRepeatOnTheRingtoneChannelUntilTheirTimeout() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"org.matrix.msc4075.rtc.notification","content":{"notification_type":"ring","lifetime":30000}}""")
        PushNotifier.showFromPush(context, ringPayload("!r1:example.org", "\$ring"))
        val id = PushNotifier.callNotificationId("@alice:example.org", "!r1:example.org")
        val posted = shadowNotificationManager().getNotification(null, id)!!
        assertTrue(posted.flags and Notification.FLAG_INSISTENT != 0)
        assertEquals(30_000L, posted.timeoutAfter)
        val channel = notificationManager.getNotificationChannel(posted.channelId)
        assertEquals(AudioAttributes.USAGE_NOTIFICATION_RINGTONE, channel.audioAttributes.usage)
        assertEquals(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), channel.sound)
        assertTrue(channel.shouldVibrate())
    }

    @Test
    fun callPushesWithZeroUnreadStillRingAfterFetchingTheirEvent() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"org.matrix.msc4075.rtc.notification","content":{"notification_type":"ring","lifetime":30000}}""")
        for (knownType in listOf(false, true)) {
            val roomId = "!call-$knownType:example.org"
            val payload = JSONObject(ringPayload(roomId, "\$ring-$knownType"))
            val notification = payload.getJSONObject("notification")
            notification.put("counts", JSONObject().put("unread", 0))
            if (!knownType) { notification.remove("type"); notification.remove("content") }
            PushNotifier.showFromPush(context, payload.toString())
            val id = PushNotifier.callNotificationId("@alice:example.org", roomId)
            assertNotNull(shadowNotificationManager().getNotification(null, id))
            notificationManager.cancel(id)
        }
    }

    @Test
    fun showFromPush_callAnnouncementStaysAnOrdinaryMessage() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        every { PushPayloadDecryptor.fetch(any(), any(), any(), any(), any()) } returns
            PushDecryptResult.Success("""{"type":"org.matrix.msc4075.rtc.notification","content":{"notification_type":"notification","lifetime":30000}}""")
        PushNotifier.showFromPush(
            context,
            ringPayload("!r1:example.org", "\$ann", notificationType = "notification")
        )

        val callId = PushNotifier.callNotificationId("@alice:example.org", "!r1:example.org")
        assertNull(shadowNotificationManager().getNotification(null, callId))
        assertNotNull(
            shadowNotificationManager().getNotification(null, canonicalId("!r1:example.org"))
        )
    }

    @Test
    fun showFromPush_postsMessagesOnHighImportanceMessagesChannel() {
        PushNotifier.showFromPush(context, pushPayload("!r1:example.org", "\$e1"))

        val posted = shadowNotificationManager().getNotification(null, canonicalId("!r1:example.org"))!!
        assertEquals("messages.v2", posted.channelId)
        assertEquals(
            NotificationManager.IMPORTANCE_HIGH,
            notificationManager.getNotificationChannel("messages.v2").importance
        )
        assertEquals(
            "android.app.Notification\$MessagingStyle",
            posted.extras.getString(Notification.EXTRA_TEMPLATE)
        )
    }

    @Test
    fun showFromPush_postsInvitesOnTheirOwnChannelWithAcceptAndDecline() {
        val notification = JSONObject()
            .put("room_id", "!r1:example.org")
            .put("event_id", "\$invite")
            .put("room_name", "Room 1")
            .put("sender_display_name", "Alice")
            .put("type", "m.room.member")
            .put("content", JSONObject().put("membership", "invite"))
        val payload = JSONObject()
            .put("notification", notification)
            .put("user_id", "@alice:example.org")
            .toString()

        PushNotifier.showFromPush(context, payload)

        val posted = shadowNotificationManager().getNotification(null, canonicalId("!r1:example.org"))!!
        assertEquals("invites", posted.channelId)
        assertEquals("New Invitation", posted.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Alice invites you to Room 1", posted.extras.getString(Notification.EXTRA_TEXT))
        val actions = posted.actions.map { action ->
            val intent = shadowOf(action.actionIntent).savedIntent
            JSONObject(intent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!).getString("actionTypeId") to
                intent.getStringExtra(NotificationIntents.ACTION)
        }
        assertEquals(
            listOf(
                PushActions.INVITE_TYPE to PushActions.ACCEPT_INVITE,
                PushActions.INVITE_TYPE to PushActions.DECLINE_INVITE,
            ),
            actions,
        )
    }

    @Test
    fun showFromPush_ignoresMalformedPayloads() {
        PushNotifier.showFromPush(context, "not json at all")
        PushNotifier.showFromPush(context, """{"foo": "bar"}""")

        assertTrue(shadowNotificationManager().allNotifications.isEmpty())
    }

    @Test
    fun showFromPush_encryptedRoom_keepsContentHiddenUnlessAllowed() {
        val encrypted = """{"notification":{"room_id":"!enc:example.org","event_id":"${'$'}e9",""" +
            """"type":"m.room.encrypted","sender":"@them:example.org",""" +
            """"content":{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"AAAA"},""" +
            """"user_id":"@me:example.org"}}"""

        PushPolicy(context).showEncryptedContent = false
        PushNotifier.showFromPush(context, encrypted)

        val posted = conversations().last().notification
        val text = posted.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        assertTrue("leaked content with the setting off: ${'$'}text", text.contains("Encrypted message"))
    }

    @Test
    fun showFromPush_encryptedRoom_defaultsToHidden() {
        assertTrue("must default to closed", !PushPolicy(context).showEncryptedContent)
    }

    @Test
    fun showFromPush_quietsARoomThatAlertedWithinTheNotifyOnceWindow() {
        val room = "!once:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "${'$'}one", "first"))
        val first = conversations().single().notification
        assertTrue(first.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)

        PushNotifier.showFromPush(context, pushPayload(room, "${'$'}two", "second"))
        val quiet = conversations().single().notification
        assertTrue(quiet.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)

        PushPolicy(context).notifyOnce = false
        PushNotifier.showFromPush(context, pushPayload(room, "${'$'}three", "third"))
        val loud = conversations().single().notification
        assertTrue(loud.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)
    }

    @Test
    fun showFromPush_aRuleThatRingsIsNeverQuieted() {
        val room = "!loud:example.org"
        fun noisy(eventId: String) = JSONObject(pushPayload(room, eventId)).apply {
            getJSONObject("notification").put(
                "devices",
                JSONArray().put(JSONObject().put("tweaks", JSONObject().put("sound", "default")))
            )
        }.toString()
        PushNotifier.showFromPush(context, noisy("${'$'}one"))
        PushNotifier.showFromPush(context, noisy("${'$'}two"))

        val loud = conversations().single().notification
        assertTrue(loud.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)
    }

    @Test
    fun aPostRecordsWhyItWasLoudOrQuiet() {
        val room = "!logged:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$one", "first"))
        PushNotifier.showFromPush(context, pushPayload(room, "\$two", "second"))
        val posted = (0 until PushDiagnostics.history(context).length())
            .map { PushDiagnostics.history(context).getJSONObject(it) }
            .filter { it.optString("outcome") == "POSTED" && it.optString("roomId") == room }
            .map { it.optString("detail") }
        assertTrue(posted[0].contains("path=push") && posted[0].contains("quiet=none"))
        assertTrue(posted[1].contains("quiet=notify-once") && posted[1].contains("onlyAlertOnce=true"))
        assertTrue(posted.all { it.contains("importance=4") && it.contains("channel=messages.v2") })
    }

    @Test
    fun alertCooling_endsWhenTheNotifyOnceWindowHasPassed() {
        val window = PushNotifier.NOTIFY_ONCE_WINDOW_MS
        assertTrue(!PushNotifier.alertCooling(null, 1_000))
        assertTrue(PushNotifier.alertCooling(1_000, 1_000 + window - 1))
        assertTrue(!PushNotifier.alertCooling(1_000, 1_000 + window))
        assertTrue(!PushNotifier.alertCooling(5_000, 1_000))
    }
}
