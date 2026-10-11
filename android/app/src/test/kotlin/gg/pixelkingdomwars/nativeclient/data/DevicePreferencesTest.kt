package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.ui.DeviceKeepConfirmPreference
import gg.pixelkingdomwars.nativeclient.ui.KeepSpendConfirmState
import gg.pixelkingdomwars.nativeclient.ui.KeepSpendIntent
import org.junit.Assert.*
import org.junit.Test

class DevicePreferencesTest {
    private class Disk {
        val values = mutableMapOf<String, String>()
        fun open() = StoredDevicePreferences({ values[it] }, { key, value -> values[key] = value })
    }
    @Test fun `installed shell defaults and unreadable money preference are safe`() {
        assertEquals(DeviceSettings(), Disk().open().state.value)
        val unreadable = StoredDevicePreferences({ error("unreadable") }, { _, _ -> })
        assertTrue(unreadable.keepConfirm)
        assertTrue(unreadable.haptics)
        assertFalse(unreadable.reduceMotion)
        assertFalse(unreadable.landscape)
        assertTrue(unreadable.music); assertTrue(unreadable.soundFx)
    }
    @Test fun `all explicit choices survive recreation without a wallet namespace`() {
        val disk = Disk(); val first = disk.open()
        first.keepConfirm = false; first.haptics = false; first.reduceMotion = true; first.landscape = true; first.music = false; first.soundFx = false
        assertEquals(DeviceSettings(false, false, true, true, false, false), disk.open().state.value)
        val second = disk.open()
        second.keepConfirm = true; second.haptics = true; second.reduceMotion = false; second.landscape = false; second.music = true; second.soundFx = true
        assertEquals(DeviceSettings(), disk.open().state.value)
    }
    @Test fun `corrupt stored sensory values never enable haptics or orientation`() {
        val disk = Disk()
        for (key in listOf(StoredDevicePreferences.HAPTICS_KEY, StoredDevicePreferences.LANDSCAPE_KEY,
            StoredDevicePreferences.REDUCE_MOTION_KEY, StoredDevicePreferences.KEEP_CONFIRM_KEY)) disk.values[key] = "unexpected"
        val state = disk.open().state.value
        assertTrue(state.keepConfirm); assertFalse(state.haptics); assertFalse(state.landscape); assertFalse(state.reduceMotion)
    }
    @Test fun `failed persistence still applies explicit sensory OFF immediately`() {
        val preferences = StoredDevicePreferences({ null }, { _, _ -> error("disk full") })
        preferences.haptics = false; preferences.reduceMotion = true; preferences.music = false; preferences.soundFx = false
        assertFalse(preferences.state.value.haptics); assertTrue(preferences.state.value.reduceMotion)
        assertFalse(preferences.state.value.music); assertFalse(preferences.state.value.soundFx)
    }
    @Test fun `music and sound effects have independent canonical device keys across sessions`() {
        val disk = Disk(); val first = disk.open()
        first.soundFx = false
        assertEquals("0", disk.values["skp_sound_fx"]); assertNull(disk.values["skp_music"])
        val nextIdentity = disk.open()
        assertTrue(nextIdentity.music); assertFalse(nextIdentity.soundFx)
        nextIdentity.music = false; nextIdentity.soundFx = true
        assertEquals("0", disk.values["skp_music"]); assertEquals("1", disk.values["skp_sound_fx"])
        assertFalse(disk.open().music); assertTrue(disk.open().soundFx)
    }
    @Test fun `settings rearm the existing speedup guard and observe dialog opt-out`() {
        val preferences = Disk().open(); val guard = KeepSpendConfirmState(DeviceKeepConfirmPreference(preferences)); var spent = 0
        fun intent() = KeepSpendIntent("5", "FINISH TRAINING") { spent++ }
        guard.confirm(intent()); guard.optOut = true; guard.accept()
        assertFalse(preferences.state.value.keepConfirm); assertEquals(1, spent)
        preferences.keepConfirm = true
        guard.confirm(intent())
        assertNotNull("Settings must undo an earlier DON'T ASK AGAIN", guard.pending)
        assertEquals(1, spent)
        guard.cancel(); assertTrue(preferences.keepConfirm)
    }
    @Test fun `settings opt-out never disarms mandatory economy review`() {
        val preferences = Disk().open(); preferences.keepConfirm = false
        val guard = KeepSpendConfirmState(DeviceKeepConfirmPreference(preferences)); var spent = 0
        guard.confirm(KeepSpendIntent("5", "CONVERT", alwaysReview = true) { spent++ })
        assertNotNull(guard.pending); assertEquals(0, spent)
    }
}
