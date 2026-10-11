package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.VehicleCraftSelection
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTallSheetHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageIcon
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleCraftProtocol

/*
 * Design component: the vehicle crafting tall sheet. It replaces the old dark "VEHICLES & EXPEDITIONS › CRAFT" plate
 * (ui/phasee/VehicleCraftPanel, owner screenshot 2026-10-06 04:50Z) with the craft cluster's sheet (craft/SPEC.md §1): wood
 * frame, grass header with the vehicle at world density and the input well, CRAFT · HISTORY tabs, a family row and a tier
 * row (the STYLE TierPicker grammar, §2.7), the PreviewCard with the server's chance and fee, YOU NEED ingredient rows
 * (§1 IngredientRow) and one primary row.
 *
 * Owner: the one existing VehicleViewModel / VehicleCraftRepository (quote, history, recover). This sheet adds no client,
 * no request kind, no signing and no spend: the check and the outcome recovery are reads, and the craft primary stays off
 * because the server ABI offers no new vehicle crafting. Picking a vehicle checks its ingredients on its own (once per
 * selection, only while the owner is idle), so the player never has to find a CHECK button first; a re-check keeps the
 * last rows drawn instead of blanking them.
 */

/**
 * The vehicle crafting sheet over its own TALL host (scrim + sheet from y 104). [tiers] are the content policy's vehicle
 * tiers (`VehiclePolicy.tiers`); [initialFamily] pre-selects a family (the Public Workshop's "YOU CAN CRAFT" cards);
 * [onOpenRefine] opens Workshop REFINE for a short refined input (null hides the GO). Back and the scrim close it.
 */
@Composable fun VehicleCraftSheet(model: VehicleViewModel, selectedBase: String?, tiers: List<Long>, onClose: () -> Unit,
    modifier: Modifier = Modifier, initialFamily: String? = null, onOpenRefine: ((itemId: String) -> Unit)? = null) {
    val close: () -> Unit = { model.dismiss(); onClose() }
    BackHandlerAt(BackPriority.SHEET) { close() }
    LiveTallSheetHost(onScrimTap = close, modifier = modifier) { placed ->
        VehicleCraftContent(model, selectedBase, tiers, close, placed, initialFamily, onOpenRefine)
    }
}

/** The sheet itself, for a host that already places tall sheets. */
@Composable internal fun VehicleCraftContent(model: VehicleViewModel, selectedBase: String?, tiers: List<Long>, onClose: () -> Unit,
    modifier: Modifier, initialFamily: String? = null, onOpenRefine: ((itemId: String) -> Unit)? = null) {
    val families = VehicleCraftProtocol.families
    var tab by rememberSaveable { mutableStateOf(VehicleCraftTab.CRAFT) }
    var family by rememberSaveable(initialFamily) { mutableStateOf(initialFamily?.takeIf { it in families } ?: families.first()) }
    var tier by rememberSaveable { mutableStateOf<Long?>(null) }
    val selectedTier = tier?.takeIf { it in tiers } ?: tiers.firstOrNull()
    val running by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val flow = model.craftState
    if (flow == null) {
        VehicleCraftUnavailable(tab, { tab = it }, onClose, modifier)
        return
    }
    val state by flow.collectAsState()
    val idle = !state.busy && !running
    val selection = if (selectedBase != null && selectedTier != null) VehicleCraftSelection(selectedBase, family, selectedTier) else null
    LaunchedEffect(selection) { model.craftSelection(selection) }
    LaunchedEffect(model) { model.craftForeground() }
    val fresh = vehicleQuoteUi(state.quote, selectedBase, family, selectedTier)
    // A re-check clears the owner's quote while it runs; the last rows for this selection stay drawn (never blank).
    val retained = remember(selection) { arrayOfNulls<VehicleQuoteUi>(1) }
    if (fresh != null) retained[0] = fresh
    val error = notice?.takeIf { it.error }?.message ?: state.error
    val shown = fresh ?: retained[0]?.takeIf { !idle || error != null }
    val blocked = vehicleCheckBlocked(selectedBase, tiers)
    val check: () -> Unit = { if (vehicleCheckBlocked(selectedBase, tiers) == null) model.craftQuote() }
    // Picking a vehicle checks it: once per selection, after the owner applied it and only while nothing else runs.
    var autoChecked by remember { mutableStateOf<VehicleCraftSelection?>(null) }
    LaunchedEffect(selection, idle, state.selection, fresh == null) {
        if (selection != null && blocked == null && idle && state.selection == selection && fresh == null && autoChecked != selection) {
            if (model.craftQuote() != null) autoChecked = selection
        }
    }
    val familyName = vehicleFamilyName(family)
    val art = vehicleCraftArt(family, selectedTier)
    val records = vehicleCraftRecords(state.records)
    CraftSheetFrame(
        CraftFrameUi("CRAFT VEHICLE", null, vehicleCraftLive(!idle, shown), false, vehicleCraftTabs(), tab, stackedTabs = false),
        onClose, { tab = it }, {}, modifier,
        headerArt = { VehicleHeaderArt(art, shown?.lines?.firstOrNull(), "$familyName, tier ${selectedTier ?: "unknown"}") },
        footer = {
            if (tab == VehicleCraftTab.HISTORY) {
                CraftPrimaryButton(if (idle) CraftPrimaryUi("REFRESH HISTORY", null, CommandState.ENABLED, Verb.BLUE, null, null, PrimaryAction.START)
                    else busyPrimary(CHECKING_TEXT), { action -> if (action == PrimaryAction.START) model.craftHistory() })
                if (error != null) FooterNote(error, danger = true)
            } else {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (fresh != null) IconSquare("replay", Verb.STONE, check, "Check ingredients again", enabled = idle)
                    CraftPrimaryButton(vehicleCraftPrimary(selectedBase, tiers, !idle, fresh, family, selectedTier),
                        { action -> if (action == PrimaryAction.START || action == PrimaryAction.RETRY) check() }, Modifier.weight(1f))
                }
                when {
                    error != null -> FooterNote(error, danger = true)
                    fresh != null -> FooterNote("Ingredients last checked ${fresh.checkedAt}.")
                    blocked == null -> FooterNote("A preview does not hold or spend anything.")
                }
            }
        },
    ) {
        if (tab == VehicleCraftTab.HISTORY) VehicleHistoryBody(records, state.loaded, idle, state.nextCursor != null,
            onCheck = { key -> if (idle) model.craftRecover(key) },
            onMore = { state.nextCursor?.let { cursor -> if (idle) model.craftHistory(cursor) } })
        else VehicleCraftBody(families, family, { family = it }, tiers, selectedTier, { tier = it }, shown, idle, onOpenRefine)
    }
}

/** The header: the vehicle's idle sprite at world density where the building stands, and the first input's well. */
@Composable private fun VehicleHeaderArt(art: String, input: IngredientLine?, description: String) {
    VoyageIcon(art, 168.dp, Modifier.offset(x = 177.dp, y = (-20).dp), contentDescription = description)
    if (input != null) {
        Row(Modifier.offset(x = 116.dp, y = 52.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Well(44.dp, flat = WELL_DARK) {
                CraftIcon(input.icon, 32.dp, alpha = if (input.short) 0.45f else 1f, contentDescription = "Input: ${input.name}")
            }
            PkwIcon("shape:go", 18.dp, tint = PkwTokens.Colors.label)
        }
    }
}

/** CRAFT: family row, tier row, preview card with the server's chance and fee, and YOU NEED. */
@Composable private fun ColumnScope.VehicleCraftBody(families: List<String>, family: String, onFamily: (String) -> Unit, tiers: List<Long>,
    selectedTier: Long?, onTier: (Long) -> Unit, quote: VehicleQuoteUi?, idle: Boolean, onOpenRefine: ((String) -> Unit)?) {
    val c = PkwTokens.Colors
    SectionLabel("VEHICLE", "choose what to build", families.size.toString())
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        families.forEach { f -> FamilyCard(f, selectedTier, f == family, { onFamily(f) }, Modifier.weight(1f)) }
    }
    if (tiers.isNotEmpty()) {
        SectionLabel("TIER", "the vehicle's tier", tiers.size.toString())
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            tiers.forEach { t -> TierCard(t, t == selectedTier, { onTier(t) }, Modifier.weight(1f)) }
        }
    }
    VehiclePreviewCard(family, selectedTier, quote)
    if (quote != null) {
        PkwText(VEHICLE_NOT_QUOTED_LINE, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 3)
        PkwText(VEHICLE_OUTCOME_LINE, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 3)
    }
    SectionLabel("YOU NEED", "for ${vehicleFamilyName(family)} T${selectedTier ?: "…"}")
    if (quote != null) {
        quote.lines.forEach { line ->
            IngredientRow(line, onGo = { onOpenRefine?.invoke(it.itemId) },
                showGo = onOpenRefine != null && vehicleIngredientRefinable(line.itemId))
        }
    } else {
        DashedBox {
            PkwText(if (idle) VEHICLE_PREVIEW_LINE else CHECKING_TEXT, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch2,
                textAlign = TextAlign.Center, maxLines = 4)
        }
    }
}

/** One family: its sprite at the selected tier (112 art at k = 1) and its name; the selected card has the gold rim. */
@Composable private fun FamilyCard(family: String, tier: Long?, selected: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val name = vehicleFamilyName(family)
    CreamCard(modifier.height(108.dp).sceneInputRegion()
        .semantics { contentDescription = name; this.selected = selected }
        .clickable(role = Role.Button, onClick = onClick),
        rim = if (selected) CardRim.SELECTED else CardRim.NONE, contentPadding = PaddingValues(4.dp)) {
        Column(Modifier.align(Alignment.Center).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            VoyageIcon(vehicleCraftArt(family, tier), 56.dp)
            PkwText(name, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center,
                maxLines = 2)
        }
    }
}

/** One tier: its roman numeral; the selected card has the gold rim. */
@Composable private fun TierCard(tier: Long, selected: Boolean, onClick: () -> Unit, modifier: Modifier) {
    CreamCard(modifier.height(60.dp).sceneInputRegion()
        .semantics { contentDescription = "Tier $tier"; this.selected = selected }
        .clickable(role = Role.Button, onClick = onClick),
        rim = if (selected) CardRim.SELECTED else CardRim.NONE, contentPadding = PaddingValues(2.dp)) {
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText(romanTier(tier.toInt()), PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch)
            PkwText("tier", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
    }
}

/** PreviewCard (SPEC §2.7): the vehicle on a grass well, its name, and the server's chance and fee ("…" until checked). */
@Composable private fun VehiclePreviewCard(family: String, tier: Long?, quote: VehicleQuoteUi?) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 124.dp), contentPadding = PaddingValues(start = 4.dp, top = 4.dp, end = 8.dp, bottom = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(116.dp).drawBehind {
                val i = 2.dp.toPx()
                fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, c.ink)
                insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) { drawGrass() }
            }, contentAlignment = Alignment.Center) {
                VoyageIcon(vehicleCraftArt(family, tier), 112.dp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwText(vehicleCraftTitle(family, tier), PkwTokens.Type.label, color = c.textOnParch, maxLines = 2)
                StatLine("Success chance", quote?.odds ?: "…")
                StatLine("Application fee", quote?.fee ?: "…")
            }
        }
    }
}

@Composable private fun StatLine(label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwText(label, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        PkwText(value, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
    }
}

/** HISTORY: the saved original crafting records, newest first, each with its own outcome check. */
@Composable private fun ColumnScope.VehicleHistoryBody(records: List<VehicleCraftRecordUi>, loaded: Boolean, idle: Boolean, hasMore: Boolean,
    onCheck: (String) -> Unit, onMore: () -> Unit) {
    val c = PkwTokens.Colors
    PkwText(VEHICLE_HISTORY_LINE, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 3)
    when {
        !loaded && !idle -> DashedBox {
            PkwText("Loading saved originals…", PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center)
        }
        records.isEmpty() -> EmptyState(EmptyStateUi("ui:workshop-menu", "No original crafting records have been loaded.",
            "Tap REFRESH HISTORY to check again.", null, null), onGo = {})
        else -> records.forEach { row -> VehicleRecordCard(row, idle) { onCheck(row.key) } }
    }
    if (hasMore) SecondaryButton("MORE ORIGINAL HISTORY", onMore, Modifier.fillMaxWidth(), enabled = idle)
}

@Composable private fun VehicleRecordCard(row: VehicleCraftRecordUi, idle: Boolean, onCheck: () -> Unit) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Well(72.dp) { VoyageIcon(row.art, 64.dp) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText(row.title, PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = c.textOnParch)
                        Tag(row.tag, row.tagVerb)
                    }
                    PkwText(row.status, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                    PkwText(row.reserved, PkwTokens.Type.small, color = c.textOnParch2)
                    PkwText(row.inputs, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                }
            }
            row.note?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch, maxLines = 2) }
            SecondaryButton("CHECK ORIGINAL OUTCOME", onCheck, Modifier.fillMaxWidth(), enabled = idle,
                contentDescription = "Check the original outcome of ${row.title}")
        }
    }
}

/** The owner's crafting storage could not be opened: the same frame, the sentence, and the close door. */
@Composable private fun VehicleCraftUnavailable(tab: String, onTab: (String) -> Unit, onClose: () -> Unit, modifier: Modifier) {
    CraftSheetFrame(CraftFrameUi("CRAFT VEHICLE", null, null, false, vehicleCraftTabs(), tab, stackedTabs = false), onClose, onTab, {}, modifier,
        footer = { CraftPrimaryButton(offPrimary("CHECK INGREDIENTS", null, VEHICLE_UNAVAILABLE_LINE), {}) }) {
        EmptyState(EmptyStateUi("ui:workshop-menu", VEHICLE_UNAVAILABLE_LINE, "Saved originals were preserved.", null, null), onGo = {})
    }
}
