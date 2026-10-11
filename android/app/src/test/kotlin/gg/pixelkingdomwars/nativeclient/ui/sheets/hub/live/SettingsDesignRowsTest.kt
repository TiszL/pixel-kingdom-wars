package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.data.StoredDevicePreferences
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.notifications.NotificationSettings
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ToggleRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.toggleSections
import org.junit.Assert.*
import org.junit.Test

/**
 * settings.png and settings-help.png drawn from the real owners: every designed GAME row in the frame's order, honest
 * DISABLED rows where no owner exists yet, and the one server notification opt-in as the TELL ME WHEN master toggle.
 */
class SettingsDesignRowsTest {
    private val signedIn = AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(WALLET))
    private val notifyReady = NotificationSettings(supported = true)

    private fun gameRows(notify: NotificationSettings? = notifyReady, account: AccountState? = signedIn, refused: Boolean = false) =
        settingsLiveUi(DeviceSettings(), "build", account = account, notifications = notify, notificationPermissionRefused = refused)
            .toggles.filter { it.tab == "GAME" }
    private fun List<ToggleRowUi>.row(key: String) = single { it.key == key }

    @Test fun `game rows are the frame rows in its order with no landscape lock`() {
        // The player reads Settings against the designed card; a reordered or missing row is a different screen.
        // Rewritten 2026-10-06: PLAY used to end with "Landscape lock", a web-parity row settings.png never drew. The game is
        // now portrait only (owner, AndroidManifest MainActivity), so that switch could no longer do anything and is gone.
        val ui = settingsLiveUi(DeviceSettings(), "build", account = signedIn, notifications = notifyReady)
        assertEquals(listOf("SOUND & FEEL", "PLAY", "TELL ME WHEN"), toggleSections(ui.toggles, "GAME").map { it.first })
        val game = ui.toggles.filter { it.tab == "GAME" }
        assertEquals(listOf("Sound effects", "Music", "Haptics", "Reduce motion"), game.filter { it.section == "SOUND & FEEL" }.map { it.title })
        assertEquals(listOf("Left-handed deck", "Ask before Gems", "Battery saver"), game.filter { it.section == "PLAY" }.map { it.title })
        assertEquals(listOf("Game notifications", "A builder finishes", "I am outbid", "I am attacked"),
            game.filter { it.section == "TELL ME WHEN" }.map { it.title })
        // Stored keys never change (SPEC §5.9): a renamed key would silently reset a player's saved choice.
        assertEquals(listOf(StoredDevicePreferences.SFX_KEY, StoredDevicePreferences.MUSIC_KEY, StoredDevicePreferences.HAPTICS_KEY,
            StoredDevicePreferences.REDUCE_MOTION_KEY, SETTINGS_LEFT_HANDED, StoredDevicePreferences.KEEP_CONFIRM_KEY, SETTINGS_BATTERY_SAVER,
            SETTINGS_NOTIFY_TOGGLE, SETTINGS_NOTIFY_BUILDER, SETTINGS_NOTIFY_OUTBID, SETTINGS_NOTIFY_ATTACKED),
            game.map { it.key })
    }

    @Test fun `the retired landscape lock is neither shown nor written even for a player who had it on`() {
        // A player who stored "Landscape lock" ON before the portrait-only rule must not see a switch that no longer rotates
        // the game, and no tap may write a choice nothing reads (DeviceExperience.gameOrientation ignores it).
        val rows = settingsLiveUi(DeviceSettings(landscape = true), "build").toggles
        assertTrue(rows.none { it.key == StoredDevicePreferences.LANDSCAPE_KEY })
        assertEquals("This setting is not available on this phone yet.", settingsToggleRefusal(rows, StoredDevicePreferences.LANDSCAPE_KEY))
        val writes = mutableListOf<Pair<String, String>>()
        assertFalse(applySettingsToggle(StoredDevicePreferences({ null }, { key, value -> writes += key to value }), StoredDevicePreferences.LANDSCAPE_KEY, false))
        assertTrue(writes.isEmpty())
    }

    @Test fun `the seven shown stored preferences keep their keys and values among the designed rows`() {
        // The new designed rows must not shift or fake a saved choice: each stored key still shows exactly its stored value.
        // (Eight before 2026-10-06; the retired Landscape lock is covered by the test above.)
        val state = DeviceSettings(keepConfirm = false, haptics = false, reduceMotion = true, landscape = true,
            music = false, soundFx = false, diagnostics = true, localBattleReports = true)
        val rows = settingsLiveUi(state, "build").toggles
        assertFalse(rows.row(StoredDevicePreferences.SFX_KEY).on)
        assertFalse(rows.row(StoredDevicePreferences.MUSIC_KEY).on)
        assertFalse(rows.row(StoredDevicePreferences.HAPTICS_KEY).on)
        assertTrue(rows.row(StoredDevicePreferences.REDUCE_MOTION_KEY).on)
        assertFalse(rows.row(StoredDevicePreferences.KEEP_CONFIRM_KEY).on)
        assertTrue(rows.row(StoredDevicePreferences.DIAGNOSTICS_KEY).on)
        assertTrue(rows.row(StoredDevicePreferences.LOCAL_REPORTS_KEY).on)
        assertEquals(listOf(StoredDevicePreferences.LOCAL_REPORTS_KEY, StoredDevicePreferences.DIAGNOSTICS_KEY),
            rows.filter { it.tab == "HELP" }.map { it.key })
    }

    @Test fun `frame sub-lines are used only where they state what the stored key does`() {
        // The SFX key gates taps, building and battle sounds; the confirm key asks before speed-ups, not before every Gems spend.
        val rows = gameRows()
        assertEquals("Taps, building and battle sounds", rows.row(StoredDevicePreferences.SFX_KEY).consequence)
        assertEquals("Kingdom and battle themes", rows.row(StoredDevicePreferences.MUSIC_KEY).consequence)
        assertEquals("No loops or fly-ins", rows.row(StoredDevicePreferences.REDUCE_MOTION_KEY).consequence)
        val confirm = rows.row(StoredDevicePreferences.KEEP_CONFIRM_KEY)
        assertEquals("Ask before Gems", confirm.title)
        assertNotEquals("Confirm every Gems spend", confirm.consequence)
        assertTrue(confirm.consequence.contains("Economy transfers always require their own review"))
    }

    @Test fun `left-handed deck and battery saver say why they cannot act and are never written`() {
        // A door that cannot act must say why; a design-only row must never write a fake stored preference.
        val writes = mutableListOf<Pair<String, String>>()
        val preferences = StoredDevicePreferences({ null }, { key, value -> writes += key to value })
        val rows = gameRows()
        for (key in listOf(SETTINGS_LEFT_HANDED, SETTINGS_BATTERY_SAVER)) {
            val row = rows.row(key)
            assertFalse(row.on)
            assertEquals("Not open in this version yet", row.enabledReason)
            assertEquals("Not open in this version yet.", settingsToggleRefusal(rows, key))
            assertFalse(applySettingsToggle(preferences, key, true))
            assertNull(settingsToggleRowAction(key, true))
            assertNull(settingsHeldRowAction(rows, key))
        }
        assertTrue(writes.isEmpty())
    }

    @Test fun `tell me when rows follow the one server opt-in and outbid stays off`() {
        // The server keeps one notification choice; per-kind rows may only mirror it, never pretend to be separate switches.
        for (opted in listOf(true, false)) {
            val rows = gameRows(NotificationSettings(supported = true, optedIn = opted))
            val master = rows.row(SETTINGS_NOTIFY_TOGGLE)
            assertEquals(opted, master.on)
            assertNull(master.enabledReason)
            assertEquals("Raids, completed work, full mines and mail.", master.consequence)
            assertNull(settingsToggleRefusal(rows, SETTINGS_NOTIFY_TOGGLE))
            for (key in listOf(SETTINGS_NOTIFY_BUILDER, SETTINGS_NOTIFY_ATTACKED)) {
                assertEquals(opted, rows.row(key).on)
                assertEquals("Follows Game notifications", rows.row(key).enabledReason)
                assertEquals("Follows Game notifications.", settingsToggleRefusal(rows, key))
            }
            // Auctions do not exist yet, so "I am outbid" can never read ON.
            assertFalse(rows.row(SETTINGS_NOTIFY_OUTBID).on)
            assertEquals("Auctions are not open yet", rows.row(SETTINGS_NOTIFY_OUTBID).enabledReason)
        }
    }

    @Test fun `the master toggle runs the old notification on and off owner calls and never a device preference`() {
        // Turning notifications on needs the Android permission and the server opt-in; a stored flag would do neither.
        assertEquals(SETTINGS_NOTIFY_ON, settingsToggleRowAction(SETTINGS_NOTIFY_TOGGLE, true))
        assertEquals(SETTINGS_NOTIFY_OFF, settingsToggleRowAction(SETTINGS_NOTIFY_TOGGLE, false))
        assertNull(settingsToggleRowAction(StoredDevicePreferences.MUSIC_KEY, false))
        val writes = mutableListOf<Pair<String, String>>()
        assertFalse(applySettingsToggle(StoredDevicePreferences({ null }, { key, value -> writes += key to value }), SETTINGS_NOTIFY_TOGGLE, true))
        assertTrue(writes.isEmpty())
    }

    @Test fun `the master toggle is disabled while busy unsupported refused or signed out`() {
        // Each hold names the real reason; a tap that cannot act explains instead of silently doing nothing.
        val busy = gameRows(NotificationSettings(supported = true, busy = true))
        assertEquals("Updating…", busy.row(SETTINGS_NOTIFY_TOGGLE).enabledReason)
        assertEquals("Updating…", settingsToggleRefusal(busy, SETTINGS_NOTIFY_TOGGLE))
        val unsupported = gameRows(NotificationSettings(supported = false))
        assertEquals("Notifications are not available on this server yet.", unsupported.row(SETTINGS_NOTIFY_TOGGLE).enabledReason)
        // A reason that is already a sentence gets no second full stop.
        assertEquals("Notifications are not available on this server yet.", settingsToggleRefusal(unsupported, SETTINGS_NOTIFY_TOGGLE))
        // Signed out the owner's empty state must not read as "this server has no notifications".
        for (account in listOf(null, AccountState(phase = AccountPhase.SIGNED_OUT))) {
            val rows = gameRows(NotificationSettings(), account = account)
            assertEquals("Sign in to manage notifications.", rows.row(SETTINGS_NOTIFY_TOGGLE).enabledReason)
            assertFalse(rows.row(SETTINGS_NOTIFY_TOGGLE).on)
        }
        assertEquals("Sign in to manage notifications.", gameRows(null).row(SETTINGS_NOTIFY_TOGGLE).enabledReason)
    }

    @Test fun `a refused android permission holds the toggle and its tap opens android notification settings`() {
        // SPEC §2.6 States: after a refused prompt the row says where to fix it, and the tap goes there.
        val refused = gameRows(refused = true)
        assertEquals(SETTINGS_NOTIFY_REFUSED, refused.row(SETTINGS_NOTIFY_TOGGLE).enabledReason)
        assertEquals(SETTINGS_NOTIFY_ANDROID, settingsHeldRowAction(refused, SETTINGS_NOTIFY_TOGGLE))
        // Any other hold (busy) explains instead of leaving the card.
        val busy = gameRows(NotificationSettings(supported = true, busy = true), refused = true)
        assertNull(settingsHeldRowAction(busy, SETTINGS_NOTIFY_TOGGLE))
        assertNull(settingsHeldRowAction(gameRows(), SETTINGS_NOTIFY_BUILDER))
    }

    @Test fun `a failed notification check stays tappable when the server supports it`() {
        // The player can retry a failed opt-in; only an unsupported server holds the row with the error as its reason.
        val error = "Notification settings could not be confirmed. Try again when connected."
        val retry = gameRows(NotificationSettings(supported = true, error = error)).row(SETTINGS_NOTIFY_TOGGLE)
        assertNull(retry.enabledReason)
        assertEquals(error, retry.consequence)
        assertEquals(error, gameRows(NotificationSettings(supported = false, error = error)).row(SETTINGS_NOTIFY_TOGGLE).enabledReason)
    }

    @Test fun `account keeps android notification settings but no longer the on and off button`() {
        // The opt-in moved to GAME; ACCOUNT keeps only the door a refused permission points to.
        for (notify in listOf(NotificationSettings(supported = true), NotificationSettings(supported = true, optedIn = true))) {
            val rows = settingsLiveUi(DeviceSettings(), "build", tab = "ACCOUNT", account = signedIn, notifications = notify).accountRows
            assertTrue(rows.none { it.id == SETTINGS_NOTIFY_ON || it.id == SETTINGS_NOTIFY_OFF || it.title == "Game notifications" })
            val android = rows.single { it.id == SETTINGS_NOTIFY_ANDROID }
            assertEquals(RowKind.BUTTON, android.kind)
            assertEquals("OPEN", android.buttonLabel)
        }
    }

    @Test fun `help about row reads version and build network and help lists only tester toggles`() {
        // settings-help.png ABOUT shows "version · network"; the network comes from the build, never a guess.
        assertEquals("devnet alpha", settingsNetworkLabel("devnet"))
        assertEquals("mainnet-beta", settingsNetworkLabel("mainnet-beta"))
        val help = settingsLiveHelpUi(DeviceSettings(), "Version from build", network = settingsNetworkLabel("devnet"))
        assertEquals("Version from build · devnet alpha", help.version)
        assertEquals("Version from build", settingsLiveHelpUi(DeviceSettings(), "Version from build").version)
        assertEquals(listOf(StoredDevicePreferences.LOCAL_REPORTS_KEY, StoredDevicePreferences.DIAGNOSTICS_KEY), help.testers.map { it.key })
    }
}
