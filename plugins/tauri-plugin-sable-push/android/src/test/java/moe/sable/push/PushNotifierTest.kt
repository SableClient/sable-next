package moe.sable.push

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
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

    private fun shadowNotificationManager() = shadowOf(notificationManager)

    @Test
    fun successiveMessagesKeepHistoryAndDismissalClearsIt() {
        val room = "!history:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$one", "first"))
        PushNotifier.showFromPush(context, pushPayload(room, "\$two", "second"))
        fun texts(): List<String> = androidx.core.app.NotificationCompat.MessagingStyle
            .extractMessagingStyleFromNotification(notificationManager.activeNotifications.single().notification)!!
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
        val alerted = notificationManager.activeNotifications.single().notification
        PushNotifier.show(context, warmNotification(room, "\$second", "second"))
        PushNotifier.showFromPush(context, pushPayload(room, "\$second", "second"))
        val posted = notificationManager.activeNotifications.single().notification
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted)!!
        assertEquals(listOf("first", "second"), style.messages.map { it.text.toString() })
        assertSame(alerted, posted)
    }

    @Test
    fun theRunningAppDoesNotRepostAnEventThePushAlreadyShowed() {
        val room = "!local:example.org"
        PushNotifier.showFromPush(context, pushPayload(room, "\$one", "hello"))
        val alerted = notificationManager.activeNotifications.single().notification
        PushNotifier.show(context, warmNotification(room, "\$one", "hello"))
        assertSame(alerted, notificationManager.activeNotifications.single().notification)
    }

    @Test
    fun historyIsBoundedAndHiddenPreviewsDoNotLeakEarlierMessages() {
        val room = "!history:example.org"
        for (i in 1..12) PushNotifier.showFromPush(context, pushPayload(room, "\$event$i", "body$i"))
        fun messages() = androidx.core.app.NotificationCompat.MessagingStyle
            .extractMessagingStyleFromNotification(notificationManager.activeNotifications.single().notification)!!.messages
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
        assertTrue(notificationManager.activeNotifications.isEmpty())
        PushNotifier.show(context, warmNotification(room, "\$seen", "already seen"))
        assertTrue(notificationManager.activeNotifications.isEmpty())
    }

    @Test
    fun eventEvictedFromPreviewHistoryDoesNotReturnAsNew() {
        val room = "!replay:example.org"
        for (i in 1..12) PushNotifier.showFromPush(context, pushPayload(room, "\$event$i", "body$i"))
        PushNotifier.showFromPush(context, pushPayload(room, "\$event1", "body1"))
        val messages = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
            notificationManager.activeNotifications.single().notification)!!.messages
        assertEquals((5..12).map { "body$it" }, messages.map { it.text.toString() })
    }

    @Test
    fun decryptionFinishingOutOfOrderUpdatesItsOwnMessage() {
        val room = "!history:example.org"
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        mockkObject(PushPayloadDecryptor)
        try {
            every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
                PushNotifier.showFromPush(context, pushPayload(room, "\$second", "second"))
                PushDecryptResult.Success("""{"content":{"body":"first"}}""")
            }
            val payload = JSONObject(pushPayload(room, "\$first"))
            payload.getJSONObject("notification").put("type", "m.room.encrypted")
            PushNotifier.showFromPush(context, payload.toString())
            val messages = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
                notificationManager.activeNotifications.single().notification)!!.messages
            assertEquals(listOf("first", "second"), messages.map { it.text.toString() })
            val intent = shadowOf(notificationManager.activeNotifications.single().notification.contentIntent).savedIntent
            val target = JSONObject(intent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!).getJSONObject("extra")
            assertEquals("\$second", target.getString("event_id"))
            val actions = notificationManager.activeNotifications.single().notification.actions
            assertEquals(2, actions.size)
            for (action in actions) {
                val actionIntent = shadowOf(action.actionIntent).savedIntent
                val extra = JSONObject(actionIntent.getStringExtra(NotificationIntents.NOTIFICATION_OBJECT)!!).getJSONObject("extra")
                assertEquals("\$second", extra.getString("event_id"))
            }
        } finally { unmockkObject(PushPayloadDecryptor) }
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
        assertEquals(1, notificationManager.activeNotifications.size)
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
        assertTrue(notificationManager.activeNotifications.isEmpty())
        PushNotifier.showFromPush(context, payload, PushNotificationGate.revision(context, id))
        assertEquals(1, notificationManager.activeNotifications.size)
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
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "DEVICE")
        for ((recipient, outcome) in listOf(null to PushOutcome.MISSING_RECIPIENT, "@other:example.org" to PushOutcome.WRONG_RECIPIENT)) {
            PushNotifier.showFromPush(context, pushPayload("!room:example.org", "\$event", userId = recipient))
            assertEquals(outcome.name, PushDiagnostics.drain(context).lastOutcome)
            assertTrue(notificationManager.activeNotifications.isEmpty())
        }
    }

    @Test
    fun aSignedInAccountOtherThanTheActiveOneStillNotifies() {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "ALICE", "@bob:example.org" to "BOB")

        PushNotifier.showFromPush(
            context,
            pushPayload("!room:example.org", "\$bob", userId = "@bob:example.org")
        )
        assertEquals(1, notificationManager.activeNotifications.size)

        PushNotifier.showFromPush(
            context,
            pushPayload("!other:example.org", "\$stranger", userId = "@carol:example.org")
        )
        assertEquals(PushOutcome.WRONG_RECIPIENT.name, PushDiagnostics.drain(context).lastOutcome)
        assertEquals(1, notificationManager.activeNotifications.size)
    }

    @Test
    fun hiddenPlaintextNeverReachesTheNotification() {
        PushPolicy(context).showContent = false
        PushNotifier.showFromPush(context, pushPayload("!private:example.org", "$" + "private", "secret text"))
        val shown = notificationManager.activeNotifications.single().notification
        assertFalse(shown.extras.toString().contains("secret text"))
    }

    @Test
    fun aDiagnosticPushIsRecordedAndNeverPosted() {
        PushDiagnostics.clearHistory(context)
        PushPolicy(context).notificationsEnabled = false

        PushNotifier.showFromPush(context, pushPayload("!diagnostic:sable.invalid", "${'$'}sable-diagnostic-abc"))

        assertTrue(notificationManager.activeNotifications.isEmpty())
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
        .extractMessagingStyleFromNotification(notificationManager.activeNotifications.single().notification)!!
        .messages.map { it.text.toString() }

    @Test
    fun show_postsNothingWhileNotificationsAreDisabled() {
        PushPolicy(context).notificationsEnabled = false
        PushNotifier.show(context, warmNotification("!warm:example.org", "\$one", "hello"))
        assertTrue(notificationManager.activeNotifications.isEmpty())
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
            notificationManager.activeNotifications.single().notification)!!
        assertNull(style.conversationTitle)
        assertFalse(style.isGroupConversation)
    }

    @Test
    fun show_aWarmInvitationHasAcceptAndDecline() {
        val invite = warmNotification("!invite:example.org", "", "").put("type", "m.room.member")
            .put("content", JSONObject().put("membership", "invite"))
        PushNotifier.show(context, invite)
        val posted = notificationManager.activeNotifications.single().notification
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
    fun showFromPush_postsBaselineBeforeNativeDecryption() {
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
            assertTrue("a slow native decrypt must not delay notification delivery", baselineWasVisible)
            val posted = shadowNotificationManager().getNotification(null, canonicalId("!enc:example.org"))!!
            assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("decrypted"))
            assertEquals("Room 1", posted.extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE))
            assertTrue(posted.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
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
    fun showFromPush_keepsTheBaselineWhileAMissingKeyIsFetched() {
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
            assertTrue(baselineWasVisible)
            val posted = shadowNotificationManager().getNotification(null, canonicalId("!slow:example.org"))!!
            assertTrue(posted.extras.getString(Notification.EXTRA_TEXT)!!.contains("after the key"))
        } finally { unmockkObject(PushPayloadDecryptor) }
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
    fun showFromPush_accountReadClearsThatAccountsAlertsOnly() {
        PushPolicy(context).accounts =
            mapOf("@alice:example.org" to "ALICE", "@bob:example.org" to "BOB")
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))
        PushNotifier.showFromPush(context, pushPayload("!two:example.org", "\$two", userId = "@bob:example.org"))
        PushNotifier.show(context, warmNotification("!warm:example.org", "\$warm", "warm"))
        assertEquals(3, notificationManager.activeNotifications.size)

        PushNotifier.showFromPush(context, accountReadPayload("@alice:example.org"))

        assertEquals(
            listOf(PushNotifier.roomNotificationId("@bob:example.org", "!two:example.org")),
            notificationManager.activeNotifications.map { it.id }
        )
    }

    @Test
    fun showFromPush_accountReadForAStrangerOrNobodyClearsNothing() {
        PushPolicy(context).accounts = mapOf("@alice:example.org" to "ALICE")
        PushNotifier.showFromPush(context, pushPayload("!one:example.org", "\$one"))

        PushNotifier.showFromPush(context, accountReadPayload("@stranger:example.org"))
        PushNotifier.showFromPush(context, """{"notification":{"counts":{"unread":0}}}""")

        assertEquals(1, notificationManager.activeNotifications.size)
    }

    private fun accountReadPayload(userId: String): String = JSONObject().put("notification", JSONObject()
        .put("counts", JSONObject().put("unread", 0))
        .put("devices", org.json.JSONArray().put(JSONObject().put("data", JSONObject().put("user_id", userId))))
    ).toString()

    @Test
    fun showFromPush_lateDecryptionDoesNotResurrectDismissedOrSupersededAlerts() {
        val state = PushPolicy(context)
        state.accounts = mapOf("@alice:example.org" to "DEVICE")
        state.showEncryptedContent = true
        mockkObject(PushPayloadDecryptor)
        try {
            for (supersede in listOf(false, true)) {
                every { PushPayloadDecryptor.decrypt(any(), any(), any(), any(), any()) } answers {
                    notificationManager.cancel(canonicalId("!enc:example.org"))
                    if (supersede) PushNotifier.showFromPush(context,
                        pushPayload("!enc:example.org", "\$new", "newer message"))
                    PushDecryptResult.Success("""{"content":{"body":"stale plaintext"}}""")
                }
                val payload = JSONObject(pushPayload("!enc:example.org", "\$old-$supersede"))
                payload.getJSONObject("notification").put("type", "m.room.encrypted")
                PushNotifier.showFromPush(context, payload.toString())
                val posted = shadowNotificationManager().getNotification(null, canonicalId("!enc:example.org"))
                if (supersede) assertTrue(posted!!.extras.getString(Notification.EXTRA_TEXT)!!.contains("newer message"))
                else assertNull(posted)
            }
        } finally { unmockkObject(PushPayloadDecryptor) }
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

        assertEquals(1, shadowNotificationManager().allNotifications.size)

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
        assertEquals(2, shadow.allNotifications.size)
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
        assertEquals(1, shadow.allNotifications.size)
    }

    @Test
    fun ringIsRecognisedOnBothEventTypesAndOnlyForTheRingKind() {
        fun event(type: String, kind: String) = JSONObject()
            .put("type", type)
            .put("content", JSONObject().put("notification_type", kind))

        assertTrue(PushNotifier.isRing(event("m.rtc.notification", "ring")))
        assertTrue(PushNotifier.isRing(event("org.matrix.msc4075.rtc.notification", "ring")))
        assertFalse(PushNotifier.isRing(event("m.rtc.notification", "notification")))
        assertFalse(PushNotifier.isRing(event("m.room.message", "ring")))
        assertFalse(PushNotifier.isRing(JSONObject().put("type", "m.rtc.notification")))
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

    @Test
    fun callNotificationIdNeverCollidesWithTheRoomsConversation() {
        assertNotEquals(
            PushNotifier.roomNotificationId("@alice:example.org", "!r1:example.org"),
            PushNotifier.callNotificationId("@alice:example.org", "!r1:example.org")
        )
    }

    @Test
    fun showFromPush_callAnnouncementStaysAnOrdinaryMessage() {
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

        val posted = shadowNotificationManager().allNotifications.last()
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
        val first = notificationManager.activeNotifications.single().notification
        assertTrue(first.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)

        PushNotifier.showFromPush(context, pushPayload(room, "${'$'}two", "second"))
        val quiet = notificationManager.activeNotifications.single().notification
        assertTrue(quiet.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)

        PushPolicy(context).notifyOnce = false
        PushNotifier.showFromPush(context, pushPayload(room, "${'$'}three", "third"))
        val loud = notificationManager.activeNotifications.single().notification
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

        val loud = notificationManager.activeNotifications.single().notification
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
