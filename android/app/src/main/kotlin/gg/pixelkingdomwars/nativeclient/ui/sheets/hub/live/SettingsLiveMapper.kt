package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.DevicePreferences
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.data.StoredDevicePreferences
import gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports
import gg.pixelkingdomwars.nativeclient.notifications.NotificationSettings
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.shortAddress
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChapterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SettingsHelpUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SettingsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ToggleRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.defaultCodexChapters

/**
 * The designed Settings card (settings.png, settings-help.png) from device state and the notification owner only. GAME
 * draws every designed row in the frame's order. The seven stored preferences it shows save at once; the retired
 * Landscape lock (skp_landscape; 2026-10-06 the game became portrait only) is neither shown nor written. "Game notifications" is
 * the one server opt-in (/native/notifications/v1).
 * Left-handed deck, Battery saver and the per-kind TELL ME WHEN rows have no owner: they are DISABLED with the reason and
 * are never written. `liveSettingsUi` / `liveSettingsHelpUi` in HubLiveMappers.kt stay as pinned by HubLiveMappersTest.
 */

private val SETTINGS_TAB_IDS = setOf("GAME", "ACCOUNT", "HELP")
internal const val SETTINGS_SECURITY_FEATURE = "settings.security"
internal const val SETTINGS_FEEDBACK_FEATURE = "settings.feedback"
internal const val SETTINGS_ABOUT_FEATURE = "settings.about"

/** The live TELL ME WHEN master toggle; SettingsHub runs it through the notification owner, never DevicePreferences. */
internal const val SETTINGS_NOTIFY_TOGGLE = "notifications"
/** The master toggle's reason after Android refused the permission (SPEC §2.6 States); its tap opens Android's settings. */
internal const val SETTINGS_NOTIFY_REFUSED = "Allow notifications in Android settings"
/** Designed rows with no owner in this version (no HUD deck mirror, no frame pacer, no per-kind server choice). */
internal const val SETTINGS_LEFT_HANDED = "leftHanded"
internal const val SETTINGS_BATTERY_SAVER = "batterySaver"
internal const val SETTINGS_NOTIFY_BUILDER = "notifyBuilder"
internal const val SETTINGS_NOTIFY_OUTBID = "notifyOutbid"
internal const val SETTINGS_NOTIFY_ATTACKED = "notifyAttacked"
private const val SETTINGS_NOT_OPEN = "Not open in this version yet"
private const val SETTINGS_FOLLOWS_NOTIFY = "Follows Game notifications"

/**
 * A held toggle shows what actually happens; the stored choice is never rewritten by a system hold. [notifications] is
 * null while signed out (or offline): the master toggle then says to sign in instead of claiming the server lacks it.
 */
private fun settingsToggles(
    state: DeviceSettings, systemReduceMotion: Boolean, systemHaptics: Boolean?,
    notifications: NotificationSettings?, notifyRefused: Boolean = false,
): List<ToggleRowUi> {
    val motionReduced = state.reduceMotion || systemReduceMotion
    val hapticsHold = when {
        systemHaptics == false -> "Off in Android settings"
        motionReduced -> "Reduce motion turns haptics off"
        else -> null
    }
    val motionHold = if (systemReduceMotion) "Android has turned off animations, so motion stays reduced" else null
    // The per-kind rows mirror the one server opt-in; a busy, refused or unsupported opt-in is said, never flipped.
    val notifyOn = notifications?.optedIn == true
    val notifyHold = when {
        notifications == null -> "Sign in to manage notifications."
        notifications.busy -> "Updating…"
        notifyRefused && !notifications.optedIn -> SETTINGS_NOTIFY_REFUSED
        notifications.error != null && !notifications.supported -> notifications.error
        !notifications.supported -> "Notifications are not available on this server yet."
        else -> null
    }
    return listOf(
        // The SFX key gates UI taps, building placement and battle sounds (NativeAudioBus admits all three on it).
        ToggleRowUi(StoredDevicePreferences.SFX_KEY, "SOUND & FEEL", "Sound effects", "Taps, building and battle sounds", state.soundFx, null),
        ToggleRowUi(StoredDevicePreferences.MUSIC_KEY, "SOUND & FEEL", "Music", "Kingdom and battle themes", state.music, null),
        ToggleRowUi(StoredDevicePreferences.HAPTICS_KEY, "SOUND & FEEL", "Haptics", "Taps you can feel",
            state.haptics && hapticsHold == null, hapticsHold),
        ToggleRowUi(StoredDevicePreferences.REDUCE_MOTION_KEY, "SOUND & FEEL", "Reduce motion", "No loops or fly-ins", motionReduced, motionHold),
        ToggleRowUi(SETTINGS_LEFT_HANDED, "PLAY", "Left-handed deck", "ATTACK moves to the right corner", false, SETTINGS_NOT_OPEN),
        // The stored key is unchanged; only its label became "Ask before Gems" (SettingsSheet.kt ToggleRowUi note). The
        // frame's "Confirm every Gems spend" is not used: KeepSpendConfirm asks before speed-ups and the hero level only.
        ToggleRowUi(StoredDevicePreferences.KEEP_CONFIRM_KEY, "PLAY", "Ask before Gems",
            "Ask before a speed-up. Economy transfers always require their own review.", state.keepConfirm, null),
        ToggleRowUi(SETTINGS_BATTERY_SAVER, "PLAY", "Battery saver", "30 fps, fewer world effects", false, SETTINGS_NOT_OPEN),
        // No Landscape lock row (2026-10-06: the game is portrait only, the DECISION on MainActivity in AndroidManifest.xml): settings.png
        // never drew it, and a switch that can no longer rotate the game would be a lie.
        ToggleRowUi(SETTINGS_NOTIFY_TOGGLE, "TELL ME WHEN", "Game notifications",
            notifications?.error ?: "Raids, completed work, full mines and mail.", notifyOn, notifyHold),
        ToggleRowUi(SETTINGS_NOTIFY_BUILDER, "TELL ME WHEN", "A builder finishes", "One notification per building", notifyOn, SETTINGS_FOLLOWS_NOTIFY),
        ToggleRowUi(SETTINGS_NOTIFY_OUTBID, "TELL ME WHEN", "I am outbid", "Seeker and Solana auction spots", false, "Auctions are not open yet"),
        ToggleRowUi(SETTINGS_NOTIFY_ATTACKED, "TELL ME WHEN", "I am attacked", "Raids on your kingdom", notifyOn, SETTINGS_FOLLOWS_NOTIFY),
        ToggleRowUi(StoredDevicePreferences.LOCAL_REPORTS_KEY, "FOR TESTERS", "Local battle reports",
            "Save stall and exit information on this device. No automatic uploads. Turning off deletes local reports.",
            state.localBattleReports, null, tab = "HELP"),
        ToggleRowUi(StoredDevicePreferences.DIAGNOSTICS_KEY, "FOR TESTERS", "Diagnostics",
            "Performance overlay and anonymous performance summaries", state.diagnostics, null, tab = "HELP"),
    )
}

/** ACCOUNT rows. Without a signed-in identity every row is paint only: no linked identity, no sign out. */
private fun settingsAccountRows(
    account: AccountState?, navigationAvailable: Boolean, signOutAvailable: Boolean,
    notifications: NotificationSettings?, localReports: LocalBattleReports.Status?, rawTraces: Boolean,
): List<RowUi> {
    val identity = account?.identity
    if (account == null || account.phase != AccountPhase.SIGNED_IN || identity == null) {
        return listOf(RowUi("account", "shield", "Account", "Sign in to manage your account.", kind = RowKind.INFO))
    }
    val security = account.security
    return buildList {
        add(RowUi("security", "shield", "Account security",
            if (!navigationAvailable) "Open Settings from your kingdom to manage security."
            else when {
                security == null -> "Two-step sign-in and recovery"
                security.reenrollmentRequired -> "Two-step sign-in needs setting up again"
                security.totpEnabled -> "Two-step sign-in is on"
                else -> "Two-step sign-in is off"
            },
            kind = if (navigationAvailable) RowKind.OPEN else RowKind.INFO,
            link = if (navigationAvailable) HubLink(FeatureId(SETTINGS_SECURITY_FEATURE)) else null))
        add(RowUi("signin", "referral", "Linked sign-in", when {
            security == null -> UNKNOWN
            security.email == null -> "No email linked"
            security.emailVerified -> "Email · verified"
            else -> "Email · not verified"
        }, kind = RowKind.INFO))
        add(RowUi("wallet", "sol", "Wallet", "Linked · ${shortAddress(identity.wallet)}", kind = RowKind.INFO))
        if (notifications != null) addAll(settingsNotificationRows())
        localReports?.let { addAll(settingsLocalReportRows(it, rawTraces)) }
        add(RowUi(SETTINGS_SIGN_OUT_ROW, "close", "Sign out",
            if (signOutAvailable) "You can sign back in any time" else "Sign out opens when your account is not busy.",
            kind = if (signOutAvailable) RowKind.BUTTON else RowKind.INFO, buttonLabel = "SIGN OUT"))
    }
}

/**
 * ACCOUNT keeps the Android notification settings door, where a refused permission points. The opt-in itself moved to
 * the GAME toggle [SETTINGS_NOTIFY_TOGGLE] (same NativeNotifications calls); SETTINGS_NOTIFY_ON / OFF remain its row ids.
 */
private fun settingsNotificationRows(): List<RowUi> = listOf(
    RowUi(SETTINGS_NOTIFY_ANDROID, "info", "Android notification settings", "Sound, banners and lock screen",
        kind = RowKind.BUTTON, buttonLabel = "OPEN"),
)

/** The rows of the old LocalReportControls; the same four calls (inspect, export, clear, raw traces switch). */
private fun settingsLocalReportRows(state: LocalBattleReports.Status, rawTraces: Boolean): List<RowUi> {
    if (!state.enabled) return state.message?.let { message ->
        listOf(RowUi(SETTINGS_REPORTS_CLEAR, "alert", "Local battle reports", message, kind = RowKind.BUTTON, buttonLabel = "CLEAR"))
    }.orEmpty()
    val action = if (state.busy) RowKind.INFO else RowKind.BUTTON
    return listOf(
        RowUi("reports", "alert", "Local battle reports", "${state.records} records · saved here for 7 days", kind = RowKind.INFO),
        RowUi(SETTINGS_REPORTS_RAW, null, "Optional Android traces",
            if (rawTraces) "Included. Raw traces can contain private app data. Check the file before sharing." else "Not included",
            kind = action, buttonLabel = if (rawTraces) "REMOVE" else "INCLUDE", subDanger = rawTraces),
        RowUi(SETTINGS_REPORTS_HISTORY, null, "Recent exit history", "Check older exits on this phone", kind = action, buttonLabel = "CHECK"),
        RowUi(SETTINGS_REPORTS_EXPORT, null, "Export local report", "Save a file you choose to share", kind = action, buttonLabel = "EXPORT"),
        RowUi(SETTINGS_REPORTS_CLEAR, null, "Clear local reports", state.message ?: "Delete what is saved on this phone",
            kind = RowKind.BUTTON, buttonLabel = "CLEAR"),
    )
}

internal const val SETTINGS_SIGN_OUT_ROW = "signout"
internal const val SETTINGS_NOTIFY_ON = "notifications-on"
internal const val SETTINGS_NOTIFY_OFF = "notifications-off"
internal const val SETTINGS_NOTIFY_ANDROID = "notifications-android"
internal const val SETTINGS_REPORTS_RAW = "reports-raw"
internal const val SETTINGS_REPORTS_HISTORY = "reports-history"
internal const val SETTINGS_REPORTS_EXPORT = "reports-export"
internal const val SETTINGS_REPORTS_CLEAR = "reports-clear"

/**
 * GAME · ACCOUNT · HELP from the seven shown stored preferences, the Android holds, the notification owner and the signed-in
 * account only. [notificationPermissionRefused] is the Android permission prompt's own refusal (SettingsHub's launcher).
 */
internal fun settingsLiveUi(
    state: DeviceSettings, version: String, tab: String = "GAME",
    systemReduceMotion: Boolean = false, systemHaptics: Boolean? = null,
    account: AccountState? = null, navigationAvailable: Boolean = false, signOutAvailable: Boolean = false,
    notifications: NotificationSettings? = null, localReports: LocalBattleReports.Status? = null, rawTraces: Boolean = false,
    confirm: ConfirmUi? = null, notificationPermissionRefused: Boolean = false,
): SettingsUi = SettingsUi(
    tab = tab.takeIf { it in SETTINGS_TAB_IDS } ?: "GAME",
    // The opt-in belongs to a signed-in account (the owner refuses otherwise), so signed out the toggle says to sign in.
    toggles = settingsToggles(state, systemReduceMotion, systemHaptics,
        notifications.takeIf { account != null && account.phase == AccountPhase.SIGNED_IN && account.identity != null },
        notificationPermissionRefused),
    version = version,
    accountRows = settingsAccountRows(account, navigationAvailable, signOutAvailable, notifications, localReports, rawTraces),
    // SettingsSheetR2 draws HELP from SettingsHelpUi; no generic HELP rows are needed.
    helpRows = emptyList(),
    confirm = confirm,
)

/**
 * HELP: the existing Codex chapter ids, Feedback, About (terms live on the same About page) and the two tester toggles.
 * [network] is the build's network ([settingsNetworkLabel]); the ABOUT row reads "version · network" (settings-help.png).
 */
internal fun settingsLiveHelpUi(
    state: DeviceSettings, version: String,
    feedbackUnread: Int? = null, feedbackLoading: Boolean = false,
    chapters: List<ChapterUi> = defaultCodexChapters(),
    about: HubLink? = HubLink(FeatureId(SETTINGS_ABOUT_FEATURE)), terms: HubLink? = HubLink(FeatureId(SETTINGS_ABOUT_FEATURE)),
    systemReduceMotion: Boolean = false, systemHaptics: Boolean? = null, network: String? = null,
): SettingsHelpUi = SettingsHelpUi(
    codexChapters = chapters,
    feedbackUnread = feedbackUnread?.takeIf { it >= 0 },
    version = network?.let { "$version · $it" } ?: version,
    feedback = HubLink(FeatureId(SETTINGS_FEEDBACK_FEATURE)),
    about = about,
    terms = terms,
    // HELP lists only the tester toggles, so no notification owner is needed here.
    testers = settingsToggles(state, systemReduceMotion, systemHaptics, null).filter { it.tab == "HELP" },
    feedbackLoading = feedbackLoading,
)

/**
 * Saves one stored preference by its canonical key; an unknown key writes nothing. The rows with no stored key (Left-handed
 * deck, Battery saver, the TELL ME WHEN rows) are never written here; the notification toggle goes to its owner. The
 * retired Landscape lock key is refused too: nothing reads it since the game became portrait only (2026-10-06).
 */
internal fun applySettingsToggle(preferences: DevicePreferences, key: String, on: Boolean): Boolean {
    when (key) {
        StoredDevicePreferences.KEEP_CONFIRM_KEY -> preferences.keepConfirm = on
        StoredDevicePreferences.HAPTICS_KEY -> preferences.haptics = on
        StoredDevicePreferences.REDUCE_MOTION_KEY -> preferences.reduceMotion = on
        StoredDevicePreferences.MUSIC_KEY -> preferences.music = on
        StoredDevicePreferences.SFX_KEY -> preferences.soundFx = on
        StoredDevicePreferences.DIAGNOSTICS_KEY -> preferences.diagnostics = on
        StoredDevicePreferences.LOCAL_REPORTS_KEY -> preferences.localBattleReports = on
        else -> return false
    }
    return true
}

/**
 * Why a toggle tap must not save: the row is unknown, held by Android / reduce motion, or has no owner yet. Null = save
 * it. A reason that already ends a sentence is not given a second full stop.
 */
internal fun settingsToggleRefusal(toggles: List<ToggleRowUi>, key: String): String? {
    val row = toggles.firstOrNull { it.key == key } ?: return "This setting is not available on this phone yet."
    return row.enabledReason?.let { if (it.endsWith(".") || it.endsWith("…")) it else "$it." }
}

/** The row action a toggle tap runs instead of a preference write: the notification opt-in is the old card's ON / OFF. */
internal fun settingsToggleRowAction(key: String, on: Boolean): String? = when (key) {
    SETTINGS_NOTIFY_TOGGLE -> if (on) SETTINGS_NOTIFY_ON else SETTINGS_NOTIFY_OFF
    else -> null
}

/** A tap on a DISABLED toggle: a refused notification permission opens Android's notification settings; null = say why. */
internal fun settingsHeldRowAction(toggles: List<ToggleRowUi>, key: String): String? =
    if (key == SETTINGS_NOTIFY_TOGGLE && toggles.firstOrNull { it.key == key }?.enabledReason == SETTINGS_NOTIFY_REFUSED) SETTINGS_NOTIFY_ANDROID
    else null

/** The ABOUT row's network from the build's Solana cluster id: devnet is this game's alpha ("devnet alpha"). */
internal fun settingsNetworkLabel(clusterId: String): String = if (clusterId == "devnet") "devnet alpha" else clusterId
