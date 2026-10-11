package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.notifications.NotificationSettings
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.more.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.*
import org.junit.Assert.*
import org.junit.Test

/** The designed Settings card replaces SettingsScreen: it must keep every stored choice, every old control and the sign-out owner. */
class SettingsHubMountTest {
    private val signedIn = AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(WALLET))

    @Test fun `every shown existing preference keeps its canonical key and current value`() {
        // Players' saved choices live under these keys; a renamed key or a design-only toggle would silently reset or fake them.
        // Rewritten for the hub settings slice (2026-10-06): settings.png also draws the designed rows that have no stored key
        // (Left-handed deck, Battery saver, TELL ME WHEN) as DISABLED rows. Rewritten again the same day for the portrait-only
        // rule (owner, AndroidManifest MainActivity): skp_landscape is no longer shown, because nothing reads it. The rule
        // kept: exactly the seven shown stored keys save, with their stored values, and every other row says why it cannot.
        val state = DeviceSettings(false, false, true, true, false, false, true, true)
        val ui = settingsLiveUi(state, "actual build", tab = "HELP")
        assertEquals("HELP", ui.tab)
        assertEquals("actual build", ui.version)
        val stored = setOf("skp_confirm_keep", "skp_haptics", "skp_reduce_motion",
            "skp_music", "skp_sound_fx", "skp_diag", "skp_local_battle_reports")
        val saving = ui.toggles.filter { it.key in stored }
        assertEquals(stored, saving.map { it.key }.toSet())
        assertTrue("the retired landscape lock is not a row", ui.toggles.none { it.key == "skp_landscape" })
        // Design order: SOUND & FEEL (sound effects, music, haptics, reduce motion), PLAY (Ask before Gems), FOR TESTERS.
        assertEquals(listOf(false, false, false, true, false, true, true), saving.map { it.on })
        assertTrue(ui.toggles.filter { it.key !in stored }.all { it.enabledReason != null })
        assertEquals(2, ui.toggles.count { it.tab == "HELP" })
    }

    @Test fun `system motion and haptic holds describe actual effects without changing stored choices`() {
        // Android and reduce motion win over the game switch; the row shows that effect but the player's stored choice survives.
        val state = DeviceSettings(haptics = true, reduceMotion = false)
        val ui = settingsLiveUi(state, "build", systemReduceMotion = true, systemHaptics = false)
        val haptics = ui.toggles.single { it.key == StoredDevicePreferences.HAPTICS_KEY }
        val motion = ui.toggles.single { it.key == StoredDevicePreferences.REDUCE_MOTION_KEY }
        assertFalse(haptics.on); assertNotNull(haptics.enabledReason)
        assertTrue(motion.on); assertNotNull(motion.enabledReason)
        assertTrue(state.haptics); assertFalse(state.reduceMotion)
        val local = settingsLiveUi(state.copy(reduceMotion = true), "build")
        assertNotNull(local.toggles.single { it.key == StoredDevicePreferences.HAPTICS_KEY }.enabledReason)
    }

    @Test fun `toggle dispatcher saves only the requested canonical preference and rejects unknown keys`() {
        // A design-only row (battery saver) has no stored key: tapping it must not write anything.
        val writes = mutableListOf<Pair<String, String>>()
        val preferences = StoredDevicePreferences({ null }, { key, value -> writes += key to value })
        assertTrue(applySettingsToggle(preferences, StoredDevicePreferences.MUSIC_KEY, false))
        assertEquals(listOf(StoredDevicePreferences.MUSIC_KEY to "0"), writes)
        assertFalse(preferences.music); assertTrue(preferences.soundFx)
        assertFalse(applySettingsToggle(preferences, "batterySaver", true))
        assertEquals(1, writes.size)
    }

    @Test fun `confirmation preference preserves speedup review and mandatory economy wording`() {
        // Only the label became Ask before Gems; the money-review promise and the local-report deletion warning must stay.
        val ui = settingsLiveUi(DeviceSettings(), "build")
        val row = ui.toggles.single { it.key == StoredDevicePreferences.KEEP_CONFIRM_KEY }
        assertEquals("Ask before Gems", row.title)
        assertTrue(row.consequence.contains("speed-up"))
        assertTrue(row.consequence.contains("Economy transfers always require their own review"))
        val reports = ui.toggles.single { it.key == StoredDevicePreferences.LOCAL_REPORTS_KEY }
        assertTrue(reports.consequence.contains("No automatic uploads"))
        assertTrue(reports.consequence.contains("deletes local reports"))
    }

    @Test fun `unread or signed out account has no fabricated linked identity or enabled sign out`() {
        // Without a signed-in identity there is nothing to link or sign out of; a live SIGN OUT would act on nobody.
        for (account in listOf(null, AccountState(phase = AccountPhase.SIGNED_OUT))) {
            val ui = settingsLiveUi(DeviceSettings(), "build", account = account, navigationAvailable = true, signOutAvailable = true)
            assertTrue(ui.accountRows.all { it.kind == RowKind.INFO })
            assertTrue(ui.accountRows.none { it.id == "signout" && it.kind == RowKind.BUTTON })
            assertFalse(ui.accountRows.any { it.sub?.contains("Linked ·") == true })
        }
        assertEquals("GAME", settingsLiveUi(DeviceSettings(), "build", tab = "unknown").tab)
    }

    @Test fun `help uses existing chapter ids and unknown feedback without fake counts`() {
        // Codex pages are found by these ids; an unread count the server never sent would be a fabricated badge.
        val help = settingsLiveHelpUi(DeviceSettings(), "Version real")
        assertEquals(listOf("buildings", "army", "islands", "money"), help.codexChapters.map { it.id })
        assertNull(help.feedbackUnread)
        assertFalse(help.feedbackLoading)
        assertEquals("Version real", help.version)
        assertEquals(2, help.testers.size)
        assertEquals("settings.feedback", help.feedback.feature.value)
    }

    @Test fun `navigation gate refuses unavailable or stale actions and dispatches admitted action once`() {
        // A door must act or say why; a stale card (account or lease changed) must never navigate.
        var current = true; var calls = 0; val reasons = mutableListOf<String>()
        val gate = SettingsActionGate({ current }, reasons::add)
        assertFalse(gate.run(false) { calls++ })
        current = false
        assertFalse(gate.run(true) { calls++ })
        assertEquals(0, calls); assertEquals(2, reasons.size)
        current = true
        assertTrue(gate.run(true) { calls++ }); assertEquals(1, calls)
        // The caller's own reason is what the player reads (for example FIT outside the kingdom).
        assertFalse(gate.run(false, "Open your kingdom to fit the base on screen.") { calls++ })
        assertEquals("Open your kingdom to fit the base on screen.", reasons.last()); assertEquals(1, calls)
    }

    @Test fun `sign out confirmation is single use and refuses changed identity or base generation`() {
        // The confirm was raised for one account; a replaced session or another selected kingdom must not be signed out by it.
        val session = Any(); val scope = SettingsAccountScope(session, "A", 4)
        val gate = SettingsSignOutGate(); var calls = 0
        gate.request(scope)
        assertFalse(gate.confirm(SettingsAccountScope(session, "A", 6), true) { calls++ })
        gate.request(scope)
        assertFalse(gate.confirm(SettingsAccountScope(Any(), "A", 4), true) { calls++ })
        gate.request(scope)
        assertFalse(gate.confirm(null, true) { calls++ })
        gate.request(scope)
        assertFalse(gate.confirm(scope, false) { calls++ })
        assertEquals(0, calls)
        gate.request(scope)
        assertTrue(gate.confirm(scope, true) { calls++ })
        assertFalse(gate.confirm(scope, true) { calls++ }); assertEquals(1, calls)
        gate.request(scope); gate.cancel()
        assertFalse(gate.confirm(scope, true) { calls++ }); assertEquals(1, calls)
    }

    @Test fun `signed in account rows open security and offer sign out only when the owner is free`() {
        // ACCOUNT replaces Profile's sign-out path: security is a real door, the wallet is the server identity, SIGN OUT needs a free owner.
        val ui = settingsLiveUi(DeviceSettings(), "build", account = signedIn, navigationAvailable = true, signOutAvailable = true)
        val security = ui.accountRows.single { it.id == "security" }
        assertEquals(RowKind.OPEN, security.kind)
        assertEquals(SETTINGS_SECURITY_FEATURE, security.link?.feature?.value)
        assertTrue(ui.accountRows.single { it.id == "wallet" }.sub!!.startsWith("Linked · "))
        assertEquals(RowKind.BUTTON, ui.accountRows.single { it.id == SETTINGS_SIGN_OUT_ROW }.kind)
        val busy = settingsLiveUi(DeviceSettings(), "build", account = signedIn, navigationAvailable = false, signOutAvailable = false)
        assertEquals(RowKind.INFO, busy.accountRows.single { it.id == SETTINGS_SIGN_OUT_ROW }.kind)
        assertEquals(RowKind.INFO, busy.accountRows.single { it.id == "security" }.kind)
        assertNull(busy.accountRows.single { it.id == "security" }.link)
    }

    @Test fun `old notification and local report controls stay reachable as account rows`() {
        // Retiring SettingsScreen must not drop NotificationSettingsCard or LocalReportControls; each control becomes one row.
        fun ids(notify: NotificationSettings?, reports: LocalBattleReports.Status?) =
            settingsLiveUi(DeviceSettings(), "build", account = signedIn, notifications = notify, localReports = reports).accountRows
        // Rewritten for the hub settings slice (2026-10-06): the TURN ON / TURN OFF buttons became the GAME "Game notifications"
        // toggle, which runs the same SETTINGS_NOTIFY_ON / OFF owner calls (SettingsDesignRowsTest); ACCOUNT keeps the Android door.
        val off = ids(NotificationSettings(supported = true, optedIn = false), null)
        assertTrue(off.none { it.id == SETTINGS_NOTIFY_ON || it.id == SETTINGS_NOTIFY_OFF })
        assertEquals(RowKind.BUTTON, off.single { it.id == SETTINGS_NOTIFY_ANDROID }.kind)
        assertEquals(SETTINGS_NOTIFY_ON, settingsToggleRowAction(SETTINGS_NOTIFY_TOGGLE, true))
        assertEquals(SETTINGS_NOTIFY_OFF, settingsToggleRowAction(SETTINGS_NOTIFY_TOGGLE, false))
        assertTrue(settingsLiveUi(DeviceSettings(), "build", account = signedIn,
            notifications = NotificationSettings(supported = true, optedIn = true)).toggles.single { it.key == SETTINGS_NOTIFY_TOGGLE }.on)
        // Unsupported or busy: no button that cannot act, but the Android settings door stays.
        for (state in listOf(NotificationSettings(supported = false), NotificationSettings(supported = true, busy = true))) {
            val rows = ids(state, null)
            assertTrue(rows.none { it.id == SETTINGS_NOTIFY_ON || it.id == SETTINGS_NOTIFY_OFF })
            assertEquals(RowKind.BUTTON, rows.single { it.id == SETTINGS_NOTIFY_ANDROID }.kind)
        }
        val ready = ids(null, LocalBattleReports.Status(enabled = true, records = 4))
        for (id in listOf(SETTINGS_REPORTS_RAW, SETTINGS_REPORTS_HISTORY, SETTINGS_REPORTS_EXPORT, SETTINGS_REPORTS_CLEAR))
            assertEquals(RowKind.BUTTON, ready.single { it.id == id }.kind)
        val busy = ids(null, LocalBattleReports.Status(enabled = true, busy = true))
        assertEquals(RowKind.INFO, busy.single { it.id == SETTINGS_REPORTS_EXPORT }.kind)
        assertTrue(ids(null, LocalBattleReports.Status(enabled = false)).none { it.id.startsWith("reports") })
        assertEquals(RowKind.BUTTON, ids(null, LocalBattleReports.Status(enabled = false, message = "Local reports cleared."))
            .single { it.id == SETTINGS_REPORTS_CLEAR }.kind)
    }

    @Test fun `held or unknown toggles explain instead of saving`() {
        // A tap on a held row must say why and must not overwrite the stored choice behind the hold.
        val held = settingsLiveUi(DeviceSettings(), "build", systemHaptics = false).toggles
        assertNotNull(settingsToggleRefusal(held, StoredDevicePreferences.HAPTICS_KEY))
        assertNull(settingsToggleRefusal(held, StoredDevicePreferences.MUSIC_KEY))
        assertNotNull(settingsToggleRefusal(held, "notifyBuilder"))
    }

    @Test fun `settings doors route only the registry rows this card owns`() {
        // HELP's terms row and About share the About page; any other id must be explained, never silently dropped.
        assertEquals(SettingsDoor.SECURITY, settingsDoor(HubLink(FeatureId("settings.security"))))
        assertEquals(SettingsDoor.FEEDBACK, settingsDoor(HubLink(FeatureId("settings.feedback"))))
        assertEquals(SettingsDoor.ABOUT, settingsDoor(HubLink(FeatureId("settings.about"))))
        assertNull(settingsDoor(HubLink(FeatureId("hud.quests"))))
        val help = settingsLiveHelpUi(DeviceSettings(), "build")
        assertEquals(SettingsDoor.FEEDBACK, settingsDoor(help.feedback))
        assertEquals(SettingsDoor.ABOUT, help.about?.let(::settingsDoor))
        assertEquals(SettingsDoor.ABOUT, help.terms?.let(::settingsDoor))
    }
}
