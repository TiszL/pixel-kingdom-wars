package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi

/*
 * Design component: the Workshop tall sheet (craft/SPEC.md §2; UX-ARCHITECTURE §7.3 `Destination.Workshop(tab)`), tabs
 * REFINE · INGOTS · TOOLS · STYLE (ids REFINE · INGOTS · EQUIPMENT · COSMETICS), on the shared CraftSheetFrame with the
 * grass header and working stage, the review half sheet and the BATCH DONE celebration.
 */

/** Existing owner navigation and catalogue admission supplied at the registration seam. This carries no
 * repository or lifetime; each owner retains its own read and original review. Absent currentness fails closed.
 * [headerTier] is the selected base's Workshop art tier from the catalogue's level mapping (`craftBuildingArtTier`) and
 * [titleTag] its "LV n"; a sheet without its own sprite or level tag draws these, and null draws neither. */
data class WorkshopOwnerHost(
    val selectedTab: String,
    val onTab: (String) -> Unit,
    val onClose: () -> Unit,
    val benchCapacity: Int? = null,
    val current: () -> Boolean = { false },
    val headerTier: Int? = null,
    val titleTag: String? = null,
)
val LocalWorkshopOwnerHost = staticCompositionLocalOf<WorkshopOwnerHost?> { null }

/** An observation surface has no transaction controls, review or unbound destination doors. A separately proven
 * owner completion may overlay it; observations themselves never create completion evidence. The host
 * supplies actual loading/recovery outcomes; an unavailable sibling tab is never an empty bench or an in-flight job.
 */
@Immutable data class WorkshopObservationUi(
    val message: String,
    val loading: Boolean = false,
    val canRetry: Boolean = false,
    val canOpenOriginal: Boolean = false,
    /** Navigation to the already registered owner; never opens a review or submits from this observation. */
    val canOpenControls: Boolean = false,
)

/** Everything the Workshop sheet draws. Only the selected tab's state is needed; the others may be null. */
@Immutable data class WorkshopSheetUi(
    /** Title "WORKSHOP", "LV n", live chip (null: derived from the bench), History on, the four stacked tabs. */
    val frame: CraftFrameUi,
    /** The bench sprite (`workshopHeader(tier, state)`). Its input / output wells, when null, follow the selected tab. */
    val header: CraftHeaderUi,
    val refine: WorkshopRefineUi? = null,
    val ingots: WorkshopIngotsUi? = null,
    val tools: WorkshopToolsUi? = null,
    val style: WorkshopStyleUi? = null,
    /** The in-sheet review half sheet; null = closed. Back closes it before the sheet (SPEC §5). */
    val review: CraftReviewUi? = null,
    /** BATCH DONE for an unseen auto-delivered job (plays on open, SPEC 0.2); null = none. */
    val celebration: CraftCelebrationUi? = null,
    /** The one resource row shown top-right while the sheet is open (SPEC §1: SHARDS with its storage bar). Drawn by
     *  the host's ResourceStack, not by this sheet. */
    val spend: ResourceChipUi? = null,
    /** Non-null mounts the explicit observation presentation. Existing command-mode callers are unchanged. */
    val observation: WorkshopObservationUi? = null,
    /** False when the host has not bound cross-feature destination callbacks. */
    val destinationsAvailable: Boolean = true,
)

/** The Workshop sheet's callbacks. Every lambda is a no-op by default. */
@Immutable data class WorkshopSheetActions(
    /** Close (the X and Back with nothing above). The building stays selected. */
    val onClose: () -> Unit = {},
    /** A tab tap (the registry id: REFINE, INGOTS, EQUIPMENT, COSMETICS). */
    val onTab: (String) -> Unit = {},
    /** The header History button → `WalletHistory(workshop)`. */
    val onHistory: () -> Unit = {},
    /** "Try again" after a load error. */
    val onRetry: () -> Unit = {},
    /** A SHORT price → the system Need-more half sheet. */
    val onNeedMore: (PriceUi) -> Unit = {},
    /** The recovery row's CHECK (saved operation id). */
    val onCheckSaved: (String) -> Unit = {},
    /** The review half sheet's BACK. */
    val onReviewBack: () -> Unit = {},
    /** The review half sheet's START: send the start request for the reviewed job. */
    val onReviewConfirm: () -> Unit = {},
    /** The celebration ended (NICE, tap, or 2 s): `markSeen(jobId)` — client-only, idempotent. */
    val onCelebrationDone: (jobId: String) -> Unit = {},
    /** A missing input this Workshop makes, from TOOLS / STYLE: open REFINE with that recipe selected. */
    val onGoRecipe: (recipeId: String) -> Unit = {},
    /** A missing input made elsewhere: `Destination.Harvester` of its realm, or Market BUY filtered to it. */
    val onGo: (itemId: String) -> Unit = {},
    val refine: WorkshopRefineActions = WorkshopRefineActions(),
    val ingots: WorkshopIngotsActions = WorkshopIngotsActions(),
    val tools: WorkshopToolsActions = WorkshopToolsActions(),
    val style: WorkshopStyleActions = WorkshopStyleActions(),
    /** Existing owner's original-request route, only shown for an admitted saved request. Never starts a new order. */
    val onOpenOriginal: (() -> Unit)? = null,
    /** Existing owner's designed screen, where its original review and consent remain in force. */
    val onOpenControls: (() -> Unit)? = null,
    /** The one owner door under a saved request's recovery row ([savedRequestDoor]); null draws none. */
    val savedDoor: SavedRequestDoorUi? = null,
)

/** A saved request's owner door (SPEC §5): the owner's existing label ("ARCHIVE ACCEPTED START", "REVIEW SAVED REQUEST",
 *  "ORIGINAL REQUEST"), what a screen reader says, whether it can act now, and the owner verb it runs. */
@Immutable data class SavedRequestDoorUi(
    val label: String,
    val description: String,
    val enabled: Boolean,
    val onClick: () -> Unit,
)

/**
 * The Workshop tall sheet. [modifier] must give it a bounded height (the SheetHost: y 104 to the bottom edge, x 4..408);
 * the sheet pads its own footer above the gesture inset. [clock] is the device wall clock (countdowns tick each second).
 *
 * Pointer rule: the root is the painted wood frame (a scene-input region); it is never full-screen and draws no world
 * scrim (the TALL sheet's 40 % scrim is the SheetHost's, only while shown). The BATCH DONE scrim covers the sheet only and
 * exists only while the celebration shows. The review half sheet has no scrim.
 */
@Composable fun WorkshopSheet(ui: WorkshopSheetUi, on: WorkshopSheetActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }) {
    val now = rememberNow(clock)
    ui.observation?.let { observation ->
        WorkshopObservedSheet(ui, observation, on, modifier, now)
        return
    }
    val tab = ui.frame.selectedTab
    val primary: CraftPrimaryUi? = when (tab) {
        WorkshopTab.REFINE -> ui.refine?.let { refinePrimary(it, now) }
        WorkshopTab.INGOTS -> ui.ingots?.let { ingotsPrimary(it, now) }
        WorkshopTab.EQUIPMENT -> ui.tools?.let { toolsPrimary(it, now) }
        WorkshopTab.COSMETICS -> ui.style?.let { if (it.ownerControls != null) it.ownerControls.primary else stylePrimary(it, now) }
        else -> null
    }
    val wells = workshopWells(ui)
    val reviewRows: List<IngredientLine> = when (tab) {
        WorkshopTab.REFINE -> ui.refine?.let(::refineLines).orEmpty()
        WorkshopTab.EQUIPMENT -> ui.tools?.let(::toolLines).orEmpty()
        WorkshopTab.COSMETICS -> ui.style?.let(::styleLines).orEmpty()
        else -> emptyList()
    }
    // The footer behind an open review is closed, so a recipe's Shards are read from the recipe itself.
    val reviewPrice = primary?.price ?: if (tab == WorkshopTab.REFINE) ui.refine?.let(::refineShardsPrice) else null
    val host = LocalWorkshopOwnerHost.current
    val header = workshopHeaderArt(ui, host?.headerTier)
    CraftSheetFrame(ui.frame.copy(live = workshopLive(ui, now), titleTag = ui.frame.titleTag ?: host?.titleTag), on.onClose, on.onTab,
        on.onHistory, modifier,
        headerArt = { HeaderStage(header, header.input ?: wells.first, header.output ?: wells.second, 177.dp, (-36).dp, "The Workshop") },
        footer = {
            when (tab) {
                WorkshopTab.REFINE -> ui.refine?.let { WorkshopRefineFooter(it, on, primary) } ?: PendingFooter()
                WorkshopTab.INGOTS -> ui.ingots?.let { WorkshopIngotsFooter(it, on, primary ?: ingotsPrimary(it, now)) } ?: PendingFooter()
                WorkshopTab.EQUIPMENT -> ui.tools?.let { WorkshopToolsFooter(it, on, primary) } ?: PendingFooter()
                WorkshopTab.COSMETICS -> ui.style?.let { WorkshopStyleFooter(it, on, primary) } ?: PendingFooter()
                else -> PendingFooter()
            }
        },
        panelOverlay = { WorkshopReviewSheet(ui.review, reviewRows, reviewPrice, on.onReviewBack, on.onReviewConfirm) },
        frameOverlay = { CraftCelebrationOverlay(ui.celebration, on.onCelebrationDone) },
    ) {
        when (tab) {
            WorkshopTab.REFINE -> ui.refine?.let { WorkshopRefineBody(it, on, now, destinationsAvailable = ui.destinationsAvailable) } ?: PendingBody()
            WorkshopTab.INGOTS -> ui.ingots?.let { WorkshopIngotsBody(it, on, now, destinationsAvailable = ui.destinationsAvailable) } ?: PendingBody()
            WorkshopTab.EQUIPMENT -> ui.tools?.let { WorkshopToolsBody(it, on, now, destinationsAvailable = ui.destinationsAvailable) } ?: PendingBody()
            WorkshopTab.COSMETICS -> ui.style?.let { WorkshopStyleBody(it, on, destinationsAvailable = ui.destinationsAvailable) } ?: PendingBody()
            else -> PendingBody()
        }
    }
}

/** The same designed frame and independently admitted owner bodies. Unavailable sibling tabs remain explicit;
 * local browsing never creates an order, a delivery acknowledgement, or a cross-feature destination callback. */
@Composable private fun WorkshopObservedSheet(ui: WorkshopSheetUi, observation: WorkshopObservationUi,
    on: WorkshopSheetActions, modifier: Modifier, now: Long) {
    val wells = workshopWells(ui)
    val host = LocalWorkshopOwnerHost.current
    val header = workshopHeaderArt(ui, host?.headerTier)
    CraftSheetFrame(ui.frame.copy(titleTag = ui.frame.titleTag ?: host?.titleTag), on.onClose, on.onTab, on.onHistory, modifier,
        headerArt = { HeaderStage(header, header.input ?: wells.first, header.output ?: wells.second, 177.dp, (-36).dp, "The Workshop") },
        footer = {
            if (ui.frame.selectedTab == WorkshopTab.REFINE) ui.refine?.let { refine ->
                if (refine.recipes.isNotEmpty() && refine.pendingJobs.isEmpty()) {
                    val qty = refineQuantity(refine)
                    QtyStepper(qty.toString(), "max ${refine.maxBatch}", { on.refine.onQty(-1) },
                        { on.refine.onQty(1) }, "Recipe quantity", minusEnabled = qty > 1, plusEnabled = qty < refine.maxBatch)
                }
            }
            CraftPrimaryButton(if (observation.loading) busyPrimary(CHECKING_TEXT)
                else offPrimary("REVIEW UNAVAILABLE", null, "Crafting and collection reviews are unavailable here."), {})
            if (observation.canRetry) SecondaryButton("TRY AGAIN", on.onRetry, Modifier.fillMaxWidth(),
                contentDescription = "Retry reading Workshop information")
            val original = on.onOpenOriginal
            if (observation.canOpenOriginal && original != null) SecondaryButton("ORIGINAL REQUEST", original,
                Modifier.fillMaxWidth(), contentDescription = "Open the existing owner's original Workshop request")
            // The saved request's own door, unless it is the same History door just drawn.
            on.savedDoor?.takeIf { !(observation.canOpenOriginal && original != null && it.label == "ORIGINAL REQUEST") }
                ?.let { SavedDoorButton(it) }
            val controls = on.onOpenControls
            if (observation.canOpenControls && controls != null) {
                val label = when (ui.frame.selectedTab) {
                    WorkshopTab.REFINE -> "OPEN REFINING"
                    WorkshopTab.EQUIPMENT -> "OPEN TOOLS"
                    else -> "OPEN INGOTS"
                }
                SecondaryButton(label, controls, Modifier.fillMaxWidth(),
                    contentDescription = "Open the existing Workshop owner and its reviewed controls")
            }
        },
        frameOverlay = { CraftCelebrationOverlay(ui.celebration, on.onCelebrationDone) },
    ) {
        CreamCard(Modifier.fillMaxWidth()) {
            PkwText(observation.message, PkwTokens.Type.body, Modifier.fillMaxWidth(),
                color = PkwTokens.Colors.textOnParch, maxLines = 4)
        }
        when (ui.frame.selectedTab) {
            WorkshopTab.INGOTS -> ui.ingots?.let { WorkshopIngotsBody(it, on, now, destinationsAvailable = false) }
            WorkshopTab.REFINE -> ui.refine?.let { WorkshopRefineBody(it, on, now, destinationsAvailable = false) }
        }
    }
}

/** The header wells for the selected tab (input → output). */
private fun workshopWells(ui: WorkshopSheetUi): Pair<CraftWellUi?, CraftWellUi?> = when (ui.frame.selectedTab) {
    WorkshopTab.REFINE -> ui.refine?.let(::refineWells) ?: (null to null)
    WorkshopTab.INGOTS -> ui.ingots?.let { ingots ->
        val casting = ingots.job?.state == IngotJobState.RUNNING
        CraftWellUi("shards", if (casting) 0.35f else 1f, "Input: Shards") to
            CraftWellUi("craft:inv_forge_ingot", if (casting) 0.5f else 1f, "Output: Forge Ingots")
    } ?: (null to null)
    WorkshopTab.EQUIPMENT -> ui.tools?.let { t ->
        val tool = selectedTool(t)
        val first = toolLines(t).firstOrNull()
        first?.let { CraftWellUi(it.icon, if (it.short) 0.45f else 1f, "Input: ${it.name}") } to
            tool?.let { CraftWellUi(it.icon, 1f, "Output: ${it.name}") }
    } ?: (null to null)
    WorkshopTab.COSMETICS -> ui.style?.let { s ->
        val first = styleLines(s).firstOrNull()
        first?.let { CraftWellUi(it.icon, if (it.short) 0.45f else 1f, "Input: ${it.name}") } to
            CraftWellUi(if (s.wakeSelected) "craft:item_aurora_wake" else "craft:item_awning", 1f, "Output: a look")
    } ?: (null to null)
    else -> null to null
}

/** Shown while a tab's state has never arrived (no last snapshot to keep). */
@Composable private fun ColumnScope.PendingBody() {
    PkwText(CHECKING_TEXT, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
}

@Composable private fun ColumnScope.PendingFooter() {
    CraftPrimaryButton(busyPrimary(CHECKING_TEXT), {})
}

/**
 * The Workshop's review half sheet: the shared ReviewHalfSheet's exact parts and motion (wood over parchment, the same
 * ingredient rows, the Shards pill, stone BACK 100 + gold confirm, no scrim), except that the consent line is never cut
 * short. Tapping the confirm is the explicit consent that today's checkbox was, so the whole SHARDS ingredient sentence,
 * the refund terms and any resend notice must stay readable; the shared part ellipsises its line after three lines.
 * Rule 7: fold this back into CraftParts.ReviewHalfSheet once its line cap is raised there.
 */
@Composable private fun BoxScope.WorkshopReviewSheet(review: CraftReviewUi?, rows: List<IngredientLine>, price: PriceUi?, onBack: () -> Unit,
    onConfirm: () -> Unit) {
    val c = PkwTokens.Colors
    Presence(review, PkwTokens.Motion.HALF_SHEET_IN, PkwTokens.Motion.HALF_SHEET_OUT) { shown, progress, active, reduced ->
        Plate(PlateKind.WOOD, Modifier.align(Alignment.BottomCenter).fillMaxWidth()
            .graphicsLayer {
                val p = progress()
                if (reduced) alpha = p else translationY = (1f - p) * size.height
            }
            .semantics { paneTitle = shown.title }) {
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(4.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(shown.title, PkwTokens.Type.title, Modifier.fillMaxWidth(), color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                    rows.forEach { IngredientRow(it, onGo = {}, showGo = false) }
                    if (price != null) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                            PkwText("Spends", PkwTokens.Type.small, color = c.textOnParch2)
                            PriceChip(price)
                        }
                    }
                    PkwText(shown.line, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center,
                        maxLines = REVIEW_LINE_MAX_LINES)
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton(shown.backLabel, { if (active) onBack() }, Modifier.width(PkwTokens.Dims.sealBackW))
                        PrimaryButton(shown.confirmLabel, { if (active && !shown.sending) onConfirm() }, Modifier.weight(1f),
                            state = if (shown.sending) CommandState.BUSY else CommandState.ENABLED)
                    }
                }
            }
        }
    }
}

/** Room for the longest Workshop consent (ingredient consent, refund terms and the resend notice) at a large font. */
private const val REVIEW_LINE_MAX_LINES = 10

/** A saved request's owner door: a full-width stone button under the recovery row (or in the observation footer). */
@Composable internal fun SavedDoorButton(door: SavedRequestDoorUi, modifier: Modifier = Modifier) {
    SecondaryButton(door.label, { if (door.enabled) door.onClick() }, modifier.fillMaxWidth(), enabled = door.enabled,
        contentDescription = door.description)
}

/** Renders a Workshop sheet the way the SheetHost does on the 412 × 915 phone (y 104 → bottom), with a fixed clock. */
@Composable internal fun WorkshopPreviewHost(ui: WorkshopSheetUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        WorkshopSheet(ui, WorkshopSheetActions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp), clock = { CraftSamples.NOW })
    }
}

@Preview(name = "Workshop sheet, nothing loaded yet", widthDp = 412, heightDp = 811)
@Composable private fun WorkshopPendingPreview() = WorkshopPreviewHost(CraftSamples.workshop())
