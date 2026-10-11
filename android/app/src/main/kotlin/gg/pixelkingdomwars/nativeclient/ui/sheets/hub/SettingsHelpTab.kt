package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi

/**
 * Design component: Settings › HELP (design/final/hub/SPEC.md part two §B + critic fix; settings-help.png), the
 * reference shelf. CODEX "how everything works": four chapter tiles 96 tall (CreamCard, art + VT 20 label with 6 dp side
 * padding): BUILDINGS (Keep 28), ARMY (troop 28), ISLANDS (`seeker-navigation` 32), TREASURE (KEEP 24; chapter id
 * unchanged); "Every building's INFO opens its own page too." HELP: Feedback (red count of new replies, chevron →
 * Feedback MY REPORTS) and "Fit base on screen" + stone FIT. ABOUT: the game (version · network) and Terms and privacy.
 * FOR TESTERS: the existing diagnostic toggles. No primary: Settings saves at once.
 * Motion: tabs 120 (the card's); a chapter tile presses −2 dp; toggle knob 90 ms ([ToggleSwitch]).
 */

/** One Codex chapter (part two §B `ChapterUi`). */
@Immutable data class ChapterUi(
    /** "buildings", "army", "islands", "money" (TREASURE keeps the id "money"). */
    val id: String,
    /** Its art (a Keep portrait 28, a troop portrait 28, `ui:seeker-navigation` 32, `keep` 24). */
    val icon: String,
    /** "BUILDINGS", "ARMY", "ISLANDS", "TREASURE". */
    val label: String,
    /** The chapter's feature is off: "Opens later" under the label (the tile still explains itself on tap). */
    val locked: Boolean = false,
)

/** Everything HELP adds to [SettingsUi] (part two §B: `codexChapters`, `feedbackUnread`, `version`). */
@Immutable data class SettingsHelpUi(
    val codexChapters: List<ChapterUi>,
    /** New replies in MY REPORTS; null = not known (the count is hidden, or "…" while [feedbackLoading]). */
    val feedbackUnread: Int?,
    /** "Version 0.6.5 (31) · devnet alpha". */
    val version: String,
    /** Feedback › MY REPORTS. */
    val feedback: HubLink,
    /** About and Terms pages; null hides the row. */
    val about: HubLink?,
    val terms: HubLink?,
    /** The FOR TESTERS toggles (existing keys: local battle reports, diagnostics). */
    val testers: List<ToggleRowUi>,
    /** The unread count is still loading: "…". */
    val feedbackLoading: Boolean = false,
    /** "Same as double-tap on ground". */
    val fitLine: String = "Same as double-tap on ground",
    /** The game row's name. */
    val gameName: String = "Pixel Kingdom Wars",
)

/** HELP callbacks (part two §B). Back / close are the card's ([SettingsActions]). */
@Immutable data class SettingsHelpActions(
    /** A chapter: its Codex book page (a locked chapter still calls back, so the caller can say why). */
    val onChapter: (String) -> Unit = {},
    val onOpen: (HubLink) -> Unit = {},
    /** FIT: close the card and fit the camera (400 ms `out`). */
    val onFit: () -> Unit = {},
    val onToggle: (key: String, on: Boolean) -> Unit = { _, _ -> },
    val onDisabledToggle: (String) -> Unit = {},
)

/** CODEX chapter defaults (the four of settings-help.png; the mapper may pass its own). */
fun defaultCodexChapters(keepTier: Int = 3): List<ChapterUi> = listOf(
    ChapterUi("buildings", keepPortrait(keepTier), "BUILDINGS"),
    ChapterUi("army", "ui_portrait_highlander_t2", "ARMY"),
    ChapterUi("islands", "ui:seeker-navigation", "ISLANDS"),
    ChapterUi("money", "keep", "TREASURE"),
)

/**
 * The HELP tab body. Wire it as the Settings card's HELP branch ([SettingsSheetR2], or the one-line change in
 * MOUNT-r2-r2-map-hub.md).
 *
 * Pointer rule: only the painted tiles, rows, toggles and FIT take touches; nothing here is full-screen or a scrim.
 */
@Composable fun ColumnScope.SettingsHelpTab(ui: SettingsHelpUi, on: SettingsHelpActions) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionHeader("CODEX", note = "how everything works")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.codexChapters.forEach { ChapterTile(it, Modifier.weight(1f)) { on.onChapter(it.id) } }
        }
        PkwText("Every building's INFO opens its own page too.", PkwTokens.Type.small, Modifier.padding(top = 2.dp), color = PkwTokens.Colors.textOnParch2)

        SectionHeader("HELP")
        val unread = ui.feedbackUnread
        val sub = when {
            ui.feedbackLoading -> UNKNOWN
            unread != null && unread > 0 -> if (unread == 1) "1 new reply in MY REPORTS" else "$unread new replies in MY REPORTS"
            else -> "Report a bug or an idea"
        }
        // settings-help.png draws every HELP and ABOUT row 60 tall (the CardRow default is 56).
        CardRow(height = 60.dp, onClick = { on.onOpen(ui.feedback) }, description = "Feedback. $sub") {
            Well("info", light = true, iconSize = 24.dp)
            RowText("Feedback", sub)
            if (!ui.feedbackLoading) unread?.let { badgeCount(it) }?.let { Badge(BadgeUi(it, BadgeTone.COUNT, "$unread new replies")) }
            RowChevron()
        }
        CardRow(height = 60.dp) {
            Well("locate", light = true, iconSize = 24.dp)
            RowText("Fit base on screen", ui.fitLine)
            SecondaryButton("FIT", on.onFit, contentDescription = "Fit your base on the screen")
        }

        SectionHeader("ABOUT")
        val about = ui.about
        if (about != null) CardRow(height = 60.dp, onClick = { on.onOpen(about) }, description = "${ui.gameName}. ${ui.version}") {
            Well("ui_portrait_keep_t3", light = true, iconSize = 28.dp)
            RowText(ui.gameName, ui.version)
            RowChevron()
        } else CardRow(height = 60.dp) { Well("ui_portrait_keep_t3", light = true, iconSize = 28.dp); RowText(ui.gameName, ui.version) }
        ui.terms?.let { terms ->
            CardRow(height = 60.dp, onClick = { on.onOpen(terms) }, description = "Terms and privacy. What we keep and why") {
                Well("shield", light = true, iconSize = 24.dp)
                RowText("Terms and privacy", "What we keep and why")
                RowChevron()
            }
        }

        if (ui.testers.isNotEmpty()) SectionHeader("FOR TESTERS")
        ui.testers.forEach { row ->
            ToggleRow(row.title, row.consequence, row.on, { on.onToggle(row.key, it) }, disabledReason = row.enabledReason,
                onDisabled = { on.onDisabledToggle(row.key) })
        }
    }
}

/** The chapter art sizes of settings-help.png: `seeker-navigation` 32, the KEEP token 24, the portraits 28. */
private fun chapterArtSize(icon: String) = when {
    icon.startsWith("ui:") -> 32.dp
    icon == "keep" -> 24.dp
    else -> 28.dp
}

/** A chapter tile (CreamCard 96: art + VT 20 label with 6 dp side padding; locked "Opens later"); presses −2 dp. */
@Composable private fun ChapterTile(ui: ChapterUi, modifier: Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val drop by animateDpAsState(if (pressed) 2.dp else 0.dp, tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE),
        label = "chapterPress")
    val said = ui.label.lowercase().replaceFirstChar { it.uppercase() } + if (ui.locked) ", opens later" else ", Codex chapter"
    Box(modifier.heightIn(min = 96.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = said; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)) {
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 96.dp).offset(y = drop), blocksScene = false) {
            Column(Modifier.align(Alignment.Center).padding(horizontal = 6.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                HubArt(ui.icon, chapterArtSize(ui.icon), alpha = if (ui.locked) 0.45f else 1f)
                PkwText(ui.label, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center)
                if (ui.locked) PkwText("Opens later", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
        }
    }
}

// ---- Previews (settings-help.png numbers) ----

internal val sampleSettingsHelp = SettingsHelpUi(defaultCodexChapters(), feedbackUnread = 1, version = "Version 0.6.5 (31) · devnet alpha",
    feedback = sampleLink("settings.feedback"), about = sampleLink("settings.about"), terms = sampleLink("settings.terms"),
    testers = listOf(
        ToggleRowUi("localReports", "FOR TESTERS", "Local battle reports", "Keep battles on this phone", true, null, tab = "HELP"),
        ToggleRowUi("diagnostics", "FOR TESTERS", "Diagnostics", "Send crash details with reports", false, null, tab = "HELP"),
    ))

@Preview(name = "Settings HELP body", widthDp = 400, heightDp = 860)
@Composable private fun SettingsHelpBodyPreview() {
    HubPreviewStage {
        HubCard(Modifier.fillMaxSize(), tabs = settingsTabs(), selectedTab = "HELP",
            header = { CompactHeader("SETTINGS", "settings", onClose = {}, onBack = {}) }) { SettingsHelpTab(sampleSettingsHelp, SettingsHelpActions()) }
    }
}
