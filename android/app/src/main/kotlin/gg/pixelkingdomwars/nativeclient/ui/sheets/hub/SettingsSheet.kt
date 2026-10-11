package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi

/**
 * Design component: Settings (design/final/hub/settings.png, SPEC §2.6): the player's preferences; changes save at once
 * (optimistic, local DataStore), so there is no primary button. Destination: `Settings(tab)` (FULL card, child of
 * Profile: Back returns there). Tabs GAME · ACCOUNT · HELP.
 */

/** The HELP row id that runs "Fit base on screen" (routed to [SettingsActions.onFit]). */
const val SETTINGS_FIT_ROW = "fit"

/** One ToggleRow. Stored keys are kept: "CONFIRM KEEP SPENDS" keeps its key and only its label became "Ask before Gems". */
@Immutable data class ToggleRowUi(
    /** The stored preference key, or the id of a row with no stored key (the notification opt-in, a not-open row). */
    val key: String,
    /** Section title ("SOUND & FEEL", "PLAY", "TELL ME WHEN"; HELP's "FOR TESTERS"). */
    val section: String,
    /** VT 20 name ("Sound effects"). */
    val title: String,
    /** VT 18 consequence ("Taps, building and battle sounds"). */
    val consequence: String,
    val on: Boolean,
    /** Non-null = DISABLED: this reason replaces the consequence, in danger ("Off in Android settings"). */
    val enabledReason: String?,
    /** Which tab lists it ("GAME" or "HELP"). */
    val tab: String = "GAME",
)

/** Everything Settings draws (SPEC §2.6 State; fields after `helpRows` were added with defaults). */
@Immutable data class SettingsUi(
    /** "GAME", "ACCOUNT" or "HELP". */
    val tab: String,
    /** Every toggle; each tab draws its own, grouped by [ToggleRowUi.section] ([toggleSections]). */
    val toggles: List<ToggleRowUi>,
    /** "Version 0.6.5 (31)". */
    val version: String,
    /** ACCOUNT: security, linked sign-in, wallet link, SIGN OUT (a BUTTON row). */
    val accountRows: List<RowUi>,
    /** HELP: FEEDBACK, HELP & CODEX, ABOUT (OPEN rows) and FIT ([SETTINGS_FIT_ROW], a BUTTON row). */
    val helpRows: List<RowUi>,
    val tabs: List<TabUi> = settingsTabs(),
    /** The sign-out confirm being shown; null when none. */
    val confirm: ConfirmUi? = null,
)

/** GAME (star) · ACCOUNT (shield) · HELP (info). */
fun settingsTabs(): List<TabUi> = listOf(
    TabUi("GAME", "star", "GAME", null, false),
    TabUi("ACCOUNT", "shield", "ACCOUNT", null, false),
    TabUi("HELP", "info", "HELP", null, false),
)

/** Settings callbacks (SPEC §2.6; the ones after `onClose` were added with defaults). */
@Immutable data class SettingsActions(
    val onTab: (String) -> Unit = {},
    /** Flip a toggle (optimistic). Notification keys may answer by raising the Android permission prompt. */
    val onToggle: (key: String, on: Boolean) -> Unit = { _, _ -> },
    /** OPEN rows (Feedback, Help & Codex, About, Account security). */
    val onOpen: (HubLink) -> Unit = {},
    /** HELP › Fit base on screen. */
    val onFit: () -> Unit = {},
    /** Back to Profile. */
    val onBack: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** Other BUTTON rows by id ("signout" → raise the confirm, "copy-…"). */
    val onRowAction: (String) -> Unit = {},
    /** A DISABLED toggle was tapped (e.g. open the Android app settings). */
    val onDisabledToggle: (String) -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onConfirmBack: () -> Unit = {},
)

/**
 * The Settings card. [modifier] is the FULL-card area (see [HubCard]).
 * Toggle motion: knob 90 ms `out`, face cross-fade 90 ms (the [ToggleSwitch]).
 *
 * Pointer rule: the root is a plain Box (the [HubCard] Column plus the confirm); only painted rows and buttons take
 * touches. The confirm's scrim exists only while [SettingsUi.confirm] is set.
 */
@Composable fun SettingsSheet(ui: SettingsUi, on: SettingsActions, modifier: Modifier = Modifier) {
    Box(modifier) {
        HubCard(Modifier.fillMaxSize(), tabs = ui.tabs, selectedTab = ui.tab, onTab = on.onTab,
            header = { CompactHeader("SETTINGS", "settings", on.onClose, onBack = on.onBack) }) {
            SettingsBody(ui, on)
        }
        HubConfirmDialog(ui.confirm, on.onConfirm, on.onConfirmBack, Modifier.fillMaxSize())
    }
}

@Composable private fun ColumnScope.SettingsBody(ui: SettingsUi, on: SettingsActions) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when (ui.tab) {
            "ACCOUNT" -> ui.accountRows.forEach { HubRow(it, on.onOpen) { id -> if (id == SETTINGS_FIT_ROW) on.onFit() else on.onRowAction(id) } }
            "HELP" -> {
                ui.helpRows.forEach { HubRow(it, on.onOpen) { id -> if (id == SETTINGS_FIT_ROW) on.onFit() else on.onRowAction(id) } }
                ToggleSections(ui, "HELP", on)
                PkwText(ui.version, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(top = 12.dp), color = PkwTokens.Colors.textOnParch2,
                    textAlign = TextAlign.Center)
            }
            else -> ToggleSections(ui, "GAME", on)
        }
    }
}

@Composable private fun ToggleSections(ui: SettingsUi, tab: String, on: SettingsActions) {
    toggleSections(ui.toggles, tab).forEach { (section, rows) ->
        SectionHeader(section)
        rows.forEach { row ->
            ToggleRow(row.title, row.consequence, row.on, { on.onToggle(row.key, it) }, disabledReason = row.enabledReason,
                onDisabled = { on.onDisabledToggle(row.key) })
        }
    }
}

/**
 * A generic hub CardRow from a [RowUi]: OPEN rows are the whole target and show a Chevron; BUTTON rows carry a stone
 * button ([onAction] gets the row id); INFO rows are paint only.
 */
@Composable internal fun HubRow(row: RowUi, onOpen: (HubLink) -> Unit, onAction: (String) -> Unit) {
    val sub: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
        row.icon?.let { Well(it, light = true, iconSize = if (it.startsWith("ui:")) 32.dp else 24.dp) }
        RowText(row.title, row.sub, subColor = if (row.subDanger) PkwTokens.Colors.danger else PkwTokens.Colors.textOnParch2)
    }
    val link = row.link
    when {
        row.kind == RowKind.OPEN && link != null -> CardRow(onClick = { onOpen(link) }, description = listOfNotNull(row.title, row.sub).joinToString(". ")) {
            sub(); RowChevron()
        }
        row.kind == RowKind.BUTTON -> CardRow {
            sub()
            SecondaryButton(row.buttonLabel ?: "OPEN", { onAction(row.id) }, contentDescription = "${row.buttonLabel ?: "Open"}: ${row.title}")
        }
        else -> CardRow { sub() }
    }
}

// ---- Previews (settings.png numbers) ----

private val sampleToggles = listOf(
    // The rows settingsLiveUi emits, in the frame's order: rows with no owner yet are DISABLED with their reason.
    ToggleRowUi("skp_sound_fx", "SOUND & FEEL", "Sound effects", "Taps, building and battle sounds", true, null),
    ToggleRowUi("skp_music", "SOUND & FEEL", "Music", "Kingdom and battle themes", true, null),
    ToggleRowUi("skp_haptics", "SOUND & FEEL", "Haptics", "Taps you can feel", false, "Off in Android settings"),
    ToggleRowUi("skp_reduce_motion", "SOUND & FEEL", "Reduce motion", "No loops or fly-ins", false, null),
    ToggleRowUi("leftHanded", "PLAY", "Left-handed deck", "ATTACK moves to the right corner", false, "Not open in this version yet"),
    ToggleRowUi("skp_confirm_keep", "PLAY", "Ask before Gems", "Ask before a speed-up. Economy transfers always require their own review.", true, null),
    ToggleRowUi("batterySaver", "PLAY", "Battery saver", "30 fps, fewer world effects", false, "Not open in this version yet"),
    ToggleRowUi("notifications", "TELL ME WHEN", "Game notifications", "Raids, completed work, full mines and mail.", true, null),
    ToggleRowUi("notifyBuilder", "TELL ME WHEN", "A builder finishes", "One notification per building", true, "Follows Game notifications"),
    ToggleRowUi("notifyOutbid", "TELL ME WHEN", "I am outbid", "Seeker and Solana auction spots", false, "Auctions are not open yet"),
    ToggleRowUi("notifyAttacked", "TELL ME WHEN", "I am attacked", "Raids on your kingdom", true, "Follows Game notifications"),
    ToggleRowUi("skp_local_battle_reports", "FOR TESTERS", "Local battle reports", "Keep battle logs on this phone", false, null, tab = "HELP"),
    ToggleRowUi("skp_diag", "FOR TESTERS", "Diagnostics", "Send crash details with reports", true, null, tab = "HELP"),
)

private val sampleSettings = SettingsUi(
    tab = "GAME", toggles = sampleToggles, version = "Version 0.6.5 (31)",
    accountRows = listOf(
        RowUi("security", "shield", "Account security", "Passkey and recovery", link = sampleLink("settings.security")),
        RowUi("signin", "referral", "Linked sign-in", "Google · rowan@…", kind = RowKind.INFO),
        RowUi("wallet", "sol", "Wallet", "Linked · 7xKX…9fQa", kind = RowKind.INFO),
        RowUi("notifications-android", "info", "Android notification settings", "Sound, banners and lock screen",
            kind = RowKind.BUTTON, buttonLabel = "OPEN"),
        RowUi("signout", "close", "Sign out", "You can sign back in any time", kind = RowKind.BUTTON, buttonLabel = "SIGN OUT"),
    ),
    helpRows = listOf(
        RowUi("feedback", "info", "FEEDBACK", "Report a bug or an idea", link = sampleLink("settings.feedback")),
        RowUi("help", "info", "HELP & CODEX", "How every building works", link = sampleLink("settings.help")),
        RowUi("about", "info", "ABOUT", "Credits and licences", link = sampleLink("settings.about")),
        RowUi(SETTINGS_FIT_ROW, "locate", "Fit base on screen", "Or double-tap empty ground", kind = RowKind.BUTTON, buttonLabel = "FIT"),
    ),
)

@Preview(name = "Settings: GAME (settings.png)", widthDp = 412, heightDp = 915)
@Composable private fun SettingsPreview() { HubPreviewStage { SettingsSheet(sampleSettings, SettingsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Settings: ACCOUNT", widthDp = 412, heightDp = 915)
@Composable private fun SettingsAccountPreview() { HubPreviewStage { SettingsSheet(sampleSettings.copy(tab = "ACCOUNT"), SettingsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Settings: HELP", widthDp = 412, heightDp = 915)
@Composable private fun SettingsHelpPreview() { HubPreviewStage { SettingsSheet(sampleSettings.copy(tab = "HELP"), SettingsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Settings: sign-out confirm", widthDp = 412, heightDp = 915)
@Composable private fun SettingsSignOutPreview() {
    HubPreviewStage {
        SettingsSheet(sampleSettings.copy(tab = "ACCOUNT", confirm = ConfirmUi("SIGN OUT?", null, null, "You leave this phone signed out.",
            "Your kingdom stays exactly as it is.", "SIGN OUT")), SettingsActions(), Modifier.fillMaxSize())
    }
}
