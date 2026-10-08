package moe.sable.push

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushDiagnosticsTest {

    private lateinit var context: Context

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        PushDiagnostics.clearHistory(context)
    }

    @Test
    fun theHistoryKeepsOnlyTheNewestEntries() {
        repeat(PushDiagnostics.HISTORY_LIMIT + 5) { index ->
            PushDiagnostics.record(context, PushOutcome.POSTED, PushTrace("@a:b", "!r:b", "${'$'}$index"))
        }

        val history = PushDiagnostics.history(context)
        assertEquals(PushDiagnostics.HISTORY_LIMIT, history.length())
        assertEquals("${'$'}5", history.getJSONObject(0).getString("eventId"))
        assertEquals("${'$'}${PushDiagnostics.HISTORY_LIMIT + 4}", history.getJSONObject(history.length() - 1).getString("eventId"))
    }

    @Test
    fun drainingTheCountsLeavesTheHistory() {
        PushDiagnostics.record(context, PushOutcome.DISABLED)

        PushDiagnostics.drain(context)

        assertEquals(1, PushDiagnostics.history(context).length())
    }
}
