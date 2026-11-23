package moe.sable.client

import android.view.ContextThemeWrapper
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ThemeTest {
  private fun selectionHandleColor(): Int {
    val theme = ContextThemeWrapper(RuntimeEnvironment.getApplication(), R.style.Theme_app).theme
    val values = theme.obtainStyledAttributes(intArrayOf(android.R.attr.colorControlActivated))
    return values.getColor(0, 0).also { values.recycle() }
  }

  @Test
  fun selectionHandlesMatchTheLightSelectionColor() {
    assertEquals(0xFF6E56CF.toInt(), selectionHandleColor())
  }

  @Test
  @Config(qualifiers = "night")
  fun selectionHandlesMatchTheDarkSelectionColor() {
    assertEquals(0xFFBDB6EC.toInt(), selectionHandleColor())
  }
}
