package gg.pixelkingdomwars.nativeclient.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Canonical menu.tsx/juice.ts/mobileShell.ts: preferences belong to the device, not a wallet.
 * The installed Solana Mobile shell defaults haptics ON; motion reduction and landscape are opt-in. */
data class DeviceSettings(val keepConfirm: Boolean = true, val haptics: Boolean = true,
                          val reduceMotion: Boolean = false, val landscape: Boolean = false,
                          val music: Boolean = true, val soundFx: Boolean = true,
                          val diagnostics: Boolean = false, val localBattleReports: Boolean = false)

interface DevicePreferences {
    val state: StateFlow<DeviceSettings>
    var keepConfirm: Boolean
    var haptics: Boolean
    var reduceMotion: Boolean
    var landscape: Boolean
    var music: Boolean
    var soundFx: Boolean
    var diagnostics: Boolean
    var localBattleReports: Boolean
}

/** Read once, then publish every local change, including changes made by the speed-up dialog.
 * A storage failure keeps the explicit choice for this process; an unreadable KEEP value always asks. */
open class StoredDevicePreferences(read: (String) -> String?, private val write: (String, String) -> Unit) : DevicePreferences {
    private fun readSafely(read: (String) -> String?, key: String): String? = try { read(key) } catch (_: Exception) { null }
    private val current = MutableStateFlow(DeviceSettings(
        keepConfirm = readSafely(read, KEEP_CONFIRM_KEY) != "0",
        haptics = readSafely(read, HAPTICS_KEY)?.let { it == "1" } ?: true,
        reduceMotion = readSafely(read, REDUCE_MOTION_KEY) == "1",
        landscape = readSafely(read, LANDSCAPE_KEY) == "1",
        // Canonical audio.ts musicOn(): default ON, with an explicit persisted OFF.
        music = readSafely(read, MUSIC_KEY) != "0",
        soundFx = readSafely(read, SFX_KEY) != "0",
        diagnostics = readSafely(read, DIAGNOSTICS_KEY) == "1",
        localBattleReports = readSafely(read, LOCAL_REPORTS_KEY) == "1",
    ))
    override val state: StateFlow<DeviceSettings> = current.asStateFlow()
    override var keepConfirm: Boolean
        get() = current.value.keepConfirm
        set(on) = change(KEEP_CONFIRM_KEY, on) { copy(keepConfirm = on) }
    override var haptics: Boolean
        get() = current.value.haptics
        set(on) = change(HAPTICS_KEY, on) { copy(haptics = on) }
    override var reduceMotion: Boolean
        get() = current.value.reduceMotion
        set(on) = change(REDUCE_MOTION_KEY, on) { copy(reduceMotion = on) }
    override var landscape: Boolean
        get() = current.value.landscape
        set(on) = change(LANDSCAPE_KEY, on) { copy(landscape = on) }
    override var music: Boolean
        get() = current.value.music
        set(on) = change(MUSIC_KEY, on) { copy(music = on) }
    override var soundFx: Boolean
        get() = current.value.soundFx
        set(on) = change(SFX_KEY, on) { copy(soundFx = on) }
    override var diagnostics: Boolean
        get() = current.value.diagnostics
        set(on) = change(DIAGNOSTICS_KEY, on) { copy(diagnostics = on) }
    override var localBattleReports: Boolean
        get() = current.value.localBattleReports
        set(on) = change(LOCAL_REPORTS_KEY, on) { copy(localBattleReports = on) }
    @Synchronized private fun change(key: String, on: Boolean, update: DeviceSettings.() -> DeviceSettings) {
        current.value = current.value.update()
        try { write(key, if (on) "1" else "0") } catch (_: Exception) { /* Explicit session choice remains effective. */ }
    }
    companion object {
        const val KEEP_CONFIRM_KEY = "skp_confirm_keep"
        const val HAPTICS_KEY = "skp_haptics"
        const val REDUCE_MOTION_KEY = "skp_reduce_motion"
        const val LANDSCAPE_KEY = "skp_landscape"
        const val MUSIC_KEY = "skp_music"
        const val SFX_KEY = "skp_sound_fx"
        const val DIAGNOSTICS_KEY = "skp_diag"
        const val LOCAL_REPORTS_KEY = "skp_local_battle_reports"
    }
}

class SharedDevicePreferences private constructor(store: SharedPreferences) : StoredDevicePreferences(
    { key -> store.getString(key, null) }, { key, value -> store.edit().putString(key, value).apply() },
) {
    constructor(context: Context) : this(context.getSharedPreferences("pkw-device-preferences", Context.MODE_PRIVATE))
}

class MemoryDevicePreferences(keepConfirm: Boolean = true) : StoredDevicePreferences(
    { key -> if (key == StoredDevicePreferences.KEEP_CONFIRM_KEY && !keepConfirm) "0" else null }, { _, _ -> },
)
