package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority

/*
 * Design component: the craft cluster's records page (craft/SPEC.md §5 "The archive lives in History"; the header's
 * stone History button). It replaces the old dark chrome AlertDialogs ("ORIGINAL REFINING REQUESTS", "WORKSHOP
 * RECEIPTS", "APPEARANCE REVIEWS & RECEIPTS") that each owner opened from that button. It is drawn over the craft sheet
 * in the sheet's own bounds (wood frame, charcoal title plate, red close, parchment panel of cream record cards, one
 * pinned stone footer), so nothing overlays the world or another sheet. It holds no state and starts nothing on its own:
 * every button is a player tap that runs the owner's existing verb with the owner's existing enabled rule and label.
 *
 * Pointer rule: the painted frame takes every touch inside its bounds (the sheet underneath never receives a tap through
 * it); nothing outside the sheet's bounds is covered.
 */

/** One label / value line of a record ("Original request" · key). */
@Immutable internal data class CraftRecordDetail(val label: String, val value: String)

/** One owner verb on a record or in the footer: its existing label, whether it can run now, and the call it makes. */
@Immutable internal data class CraftRecordAction(
    val label: String,
    val enabled: Boolean,
    val onClick: () -> Unit,
    val verb: Verb = Verb.STONE,
)

/** One record card: a title with a state tag, the owner's sentences, the label / value details and the owner's buttons. */
@Immutable internal data class CraftRecordUi(
    val title: String,
    val tag: String? = null,
    val tagVerb: Verb = Verb.STONE,
    val icon: String? = null,
    val lines: List<String> = emptyList(),
    val details: List<CraftRecordDetail> = emptyList(),
    val actions: List<CraftRecordAction> = emptyList(),
    /** The record that needs the player's attention (the saved request) gets the note tint. */
    val attention: Boolean = false,
)

/** One titled group of records; [empty] is said when the group has none (null hides an empty group). */
@Immutable internal data class CraftRecordSection(
    val title: String,
    val sub: String? = null,
    val records: List<CraftRecordUi> = emptyList(),
    val empty: String? = null,
)

/** The whole records page. [switches] are page choices drawn as a row of stone buttons above the sections (the STYLE
 *  page's AWNINGS / AURORA); [notes] are owner sentences under the sections; [footer] is the pinned refresh. */
@Immutable internal data class CraftRecordsUi(
    val title: String,
    val intro: String? = null,
    val sections: List<CraftRecordSection> = emptyList(),
    val notes: List<String> = emptyList(),
    val footer: CraftRecordAction? = null,
    val switches: List<CraftRecordAction> = emptyList(),
    /** True while the owner reads: the footer shows dots, the cards stay drawn (never blank). */
    val busy: Boolean = false,
)

/**
 * The records page over a craft sheet. [ui] null = closed (it slides down in 160 ms; it slides up in 220 ms when shown).
 * Back and the close square call [onClose]. Place it as the last child of a Box that holds the sheet, with the sheet's
 * own bounds as [modifier].
 */
@Composable internal fun CraftRecordsOverlay(ui: CraftRecordsUi?, onClose: () -> Unit, modifier: Modifier = Modifier) {
    BackHandlerAt(BackPriority.CONFIRM, ui != null) { onClose() }
    Presence(ui, PkwTokens.Motion.SHEET_IN, PkwTokens.Motion.SHEET_OUT) { shown, progress, active, reduced ->
        val c = PkwTokens.Colors
        Plate(PlateKind.WOOD, modifier
            .graphicsLayer {
                val p = progress()
                alpha = p
                if (!reduced) translationY = (1f - p) * size.height * 0.25f
            }
            // The page owns every touch inside its bounds: a tap between cards never reaches the sheet below.
            .pointerInput(Unit) { detectTapGestures { } }
            .semantics { paneTitle = shown.title },
            contentPadding = PaddingValues(start = 3.dp, top = 3.dp, end = 3.dp, bottom = 4.dp)) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(start = 6.dp, top = 6.dp, end = 5.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Plate(PlateKind.CHARCOAL, Modifier.weight(1f).heightIn(min = 44.dp).semantics(mergeDescendants = true) { heading() },
                        blocksScene = false) {
                        Row(Modifier.align(Alignment.CenterStart).padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PkwIcon("replay", 24.dp)
                            PkwText(shown.title, PkwTokens.Type.title, Modifier.weight(1f, fill = false), color = c.gold.hi, outline = 1.dp)
                        }
                    }
                    CloseSquare({ if (active) onClose() })
                }
                Box(Modifier.fillMaxWidth().weight(1f).padding(start = 8.dp, end = 8.dp)) {
                    Plate(PlateKind.PARCHMENT, Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 10.dp, top = 10.dp, end = 10.dp),
                        blocksScene = false) {
                        Column(Modifier.fillMaxSize()) {
                            Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
                                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                shown.intro?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 4) }
                                if (shown.switches.isNotEmpty()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    shown.switches.forEach { s ->
                                        SecondaryButton(s.label, { if (active && s.enabled) s.onClick() }, Modifier.weight(1f), verb = s.verb,
                                            enabled = s.enabled)
                                    }
                                }
                                shown.sections.forEach { section ->
                                    if (section.records.isNotEmpty() || section.empty != null) {
                                        SectionLabel(section.title, section.sub, if (section.records.isEmpty()) null else section.records.size.toString())
                                        if (section.records.isEmpty()) section.empty?.let {
                                            DashedBox { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2,
                                                textAlign = TextAlign.Center, maxLines = 4) }
                                        }
                                        section.records.forEach { RecordCard(it, active) }
                                    }
                                }
                                shown.notes.forEach { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 4) }
                            }
                            shown.footer?.let { footer ->
                                Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(top = 8.dp, bottom = 22.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally) {
                                    if (shown.busy) Box(Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.secondaryH), contentAlignment = Alignment.Center) {
                                        BusyDots()
                                    } else SecondaryButton(footer.label, { if (active && footer.enabled) footer.onClick() }, Modifier.fillMaxWidth(),
                                        verb = footer.verb, enabled = footer.enabled)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** One record: cream card (note tint when it needs attention), title + tag, the owner's lines, details, buttons. */
@Composable private fun RecordCard(record: CraftRecordUi, active: Boolean) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth(), rim = if (record.attention) CardRim.NOTE else CardRim.NONE,
        contentPadding = PaddingValues(start = 10.dp, top = 8.dp, end = 10.dp, bottom = 10.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                record.icon?.let { Well(40.dp, flat = WELL_DARK) { CraftIcon(it, 32.dp) } }
                PkwText(record.title, PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch, maxLines = 2)
                record.tag?.let { Tag(it, record.tagVerb) }
            }
            record.lines.forEach { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 4) }
            record.details.forEach { d ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(d.label, PkwTokens.Type.small, color = c.textOnParch2)
                    PkwText(d.value, PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch, textAlign = TextAlign.End, maxLines = 2)
                }
            }
            record.actions.forEach { a ->
                SecondaryButton(a.label, { if (active && a.enabled) a.onClick() }, Modifier.fillMaxWidth().padding(top = 2.dp), verb = a.verb,
                    enabled = a.enabled)
            }
        }
    }
}

@Preview(name = "Craft records page", widthDp = 412, heightDp = 811)
@Composable private fun CraftRecordsPreview() {
    Box(Modifier.fillMaxSize()) {
        CraftRecordsOverlay(CraftRecordsUi("WORKSHOP RECORDS", "Original requests and receipts stay here.",
            listOf(CraftRecordSection("SAVED REQUEST", records = listOf(CraftRecordUi("Saved refining request", "START ACCEPTED", Verb.BLUE,
                craftItemIcon("frostglass"), listOf("6 Frostglass", "Start accepted. Output is delivered automatically."),
                listOf(CraftRecordDetail("Original request", "op-7")), listOf(CraftRecordAction("CHECK ORIGINAL RECEIPT", true, {})), attention = true))),
                CraftRecordSection("ARCHIVE", empty = "Archived starts appear here.")),
            footer = CraftRecordAction("REFRESH STOCK & RECEIPTS", true, {})), {}, Modifier.fillMaxSize())
    }
}
