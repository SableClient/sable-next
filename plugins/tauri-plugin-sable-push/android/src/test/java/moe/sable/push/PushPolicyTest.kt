package moe.sable.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class PushPolicyTest {
    private val policy = PushPolicy(RuntimeEnvironment.getApplication())

    @Test
    fun anAccountTheAppDroppedIsNoLongerRecognised() {
        policy.accounts = mapOf("@a:example.org" to "DEVICEA", "@b:example.org" to "DEVICEB")
        policy.accounts = mapOf("@b:example.org" to "DEVICEB")

        assertNull(policy.deviceIdFor("@a:example.org"))
        assertEquals("DEVICEB", policy.deviceIdFor("@b:example.org"))
    }

    @Test
    fun noAccountsMeansNoneIsKnown() {
        assertFalse(policy.knowsAnyAccount())
        assertNull(policy.deviceIdFor(""))
        policy.accounts = mapOf("@a:example.org" to "DEVICEA")
        assertTrue(policy.knowsAnyAccount())
    }

    @Test
    fun defaultsAlertWithoutShowingContent() {
        assertTrue(policy.notificationsEnabled)
        assertFalse(policy.showContent)
        assertFalse(policy.showEncryptedContent)
        assertTrue(policy.notificationSounds)
        assertTrue(policy.notifyOnce)
    }
}
