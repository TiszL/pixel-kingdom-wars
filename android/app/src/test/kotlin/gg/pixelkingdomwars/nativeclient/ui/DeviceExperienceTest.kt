package gg.pixelkingdomwars.nativeclient.ui

import android.content.pm.ActivityInfo
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import org.junit.Assert.*
import gg.pixelkingdomwars.nativeclient.renderer.HapticPattern
import org.junit.Test

class DeviceExperienceTest {
    @Test fun `neither app OFF nor OS OFF can be overridden by the other motion control`() {
        for (app in listOf(false, true)) for (os in listOf(false, true)) {
            val system = SystemExperience(animatorScale = if (os) 0f else 1f)
            assertEquals(app || os, effectiveReducedMotion(DeviceSettings(reduceMotion = app), system))
        }
    }
    @Test fun `nonzero Android motion speed remains intact and restoring motion respects the system`() {
        val system = SystemExperience(animatorScale = 2f)
        assertEquals(2f, motionDurationScale(DeviceSettings(), system), 0f)
        assertEquals(0f, motionDurationScale(DeviceSettings(reduceMotion = true), system), 0f)
        assertEquals(2f, motionDurationScale(DeviceSettings(reduceMotion = false), system), 0f)
        assertEquals(0f, motionDurationScale(DeviceSettings(), SystemExperience(animatorScale = 0f)), 0f)
    }
    @Test fun `haptics need current foreground consent and both Android accessibility gates`() {
        var legacyReads = 0
        assertNull(readLegacyHapticSetting(android.os.Build.VERSION_CODES.TIRAMISU) { legacyReads++; false })
        assertEquals("Modern Android must apply its own feedback policy, not a stale legacy bit", 0, legacyReads)
        assertEquals(false, readLegacyHapticSetting(android.os.Build.VERSION_CODES.S_V2) { false })
        val active = SystemExperience(foreground = true)
        assertTrue(gameHapticsAllowed(DeviceSettings(), active))
        assertFalse(gameHapticsAllowed(DeviceSettings(haptics = false), active))
        assertFalse(gameHapticsAllowed(DeviceSettings(reduceMotion = true), active))
        assertFalse(gameHapticsAllowed(DeviceSettings(), active.copy(haptics = false)))
        assertFalse(gameHapticsAllowed(DeviceSettings(), active.copy(animatorScale = 0f)))
        assertFalse("A wallet handoff or translucent activity can PAUSE without STOP", gameHapticsAllowed(DeviceSettings(), active.copy(foreground = false)))
    }
    @Test fun `Android waveform adds an initial off segment while preserving every source on and pause duration`() {
        val pattern=HapticPattern(listOf(35,30,45))
        assertArrayEquals(longArrayOf(0,35,30,45),androidHapticTimings(pattern))
        assertArrayEquals(longArrayOf(0,10),androidHapticTimings(HapticPattern(listOf(10))))
    }
    @Test fun `later light replaces heavy and old surface cancellation cannot stop a newer owner`() {
        val trace=mutableListOf<String>();val old=Any();val current=Any()
        val delivery=OwnedHapticDelivery({trace+="stop"},{trace+=it.timings.joinToString()})
        delivery.play(old,HapticPattern(listOf(35,30,45)));delivery.play(current,HapticPattern(listOf(10)))
        assertEquals(listOf("stop","35, 30, 45","stop","10"),trace)
        delivery.cancel(old);assertEquals(4,trace.size)
        delivery.cancel(current);assertEquals("stop",trace.last());assertEquals(5,trace.size)
        delivery.cancel(current);assertEquals(5,trace.size)
    }
    @Test fun `platform pause or disabled feedback cancels the active owner without resuming its tail`() {
        var active:HapticPattern?=null;val token=Any()
        val delivery=OwnedHapticDelivery({active=null},{active=it})
        delivery.play(token,HapticPattern(listOf(35,30,45)));assertNotNull(active)
        delivery.cancelAll();assertNull(active)
        delivery.cancel(token);assertNull(active)
    }
    // Rewritten 2026-10-06 (owner rule: portrait only). It used to pin the web-parity "Landscape lock": OFF followed the
    // phone's rotation, ON forced landscape. A rotated Seeker then drew Home and the Clan sheet in a landscape layout that
    // was never designed, and the sheet was cut off. The runtime request also overrides the manifest, so it must be portrait
    // too, or one resume would undo MainActivity's userPortrait.
    // Rewritten again 2026-10-06 16:53 (owner: the demo runs over scrcpy in landscape): the game follows the user's rotation
    // in every orientation (FULL_USER, the manifest's fullUser). Never a forced orientation in either direction: a forced
    // landscape broke the portrait Seeker this morning, and the forced portrait removed the owner's landscape demo. The
    // landscape sheet layouts are their own fixes (K-night-A11), not a reason to lock the device.
    @Test fun `the game follows the user's rotation and never forces an orientation`() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_FULL_USER, gameOrientation())
        for (forced in listOf(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT,
                ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT,
                ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
                ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE, ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE,
                ActivityInfo.SCREEN_ORIENTATION_NOSENSOR, ActivityInfo.SCREEN_ORIENTATION_LOCKED))
            assertNotEquals("No request may force the phone into one orientation", forced, gameOrientation())
    }
}
