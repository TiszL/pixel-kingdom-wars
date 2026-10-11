package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the Berth tall sheet (design/final/voyage SPEC §0.2 skeleton, §7 FLEET, §8 install picker, §9
 * SERVICE, §10 starter): the living `Quay` header (owner 2026-10-06: one slot per Berth the player placed on the base, plus a
 * "+" slot that places a new one; the selected one in a dashed gold frame), the FLEET · SERVICE tabs (SERVICE carries a red
 * count of vehicles with ≤ 1 trip left) and the active panel with its pinned primary. It renders `Destination.Berth(tab, section)`; tab ids "FLEET" / "SERVICE"; section "starter"
 * opens the starter panel, "install" the wallet picker.
 *
 * Which FLEET panel shows: [BerthSheetUi.install] (the picker, cross-fading in place), then [BerthSheetUi.starter] while
 * the starter is not installed, else [BerthSheetUi.fleet]. The Berth spends no game resource, so it has no world-strip
 * stack (SPEC §0.2 item 4); SOL fees appear only in [VoyageSeal].
 *
 * Pointer rule: the root is the kit [SheetFrame], a painted wood panel; nothing here is a full-screen clickable, pointer
 * input or scrim. The TALL sheet's 40 % scrim belongs to the SheetHost, under this frame, only while the sheet is shown;
 * the seal's 55 % scrim belongs to [VoyageSeal], only while a seal is up. Quay slots are ≥ 48 dp targets.
 */
@Immutable data class BerthSheetUi(
    /** "LV 5", "…". */
    val level: String,
    /** "FLEET" or "SERVICE". */
    val tab: String,
    /** The header: exactly one slot per family, starter first (EMPTY when no vehicle). */
    val quay: List<VehicleUi>,
    /** The selected family (dashed frame; rows select it too). */
    val selectedFamily: VehicleFamily?,
    /** FLEET; null while it has no snapshot (the starter or the picker shows). */
    val fleet: BerthFleetUi?,
    /** The starter panel; shown while non-null and not installed. */
    val starter: StarterFleetUi?,
    /** Non-null: FLEET shows the wallet picker for an empty family. */
    val install: InstallUi?,
    /** SERVICE. */
    val service: BerthServiceUi,
    val history: Boolean = true,
    /** SERVICE gated by the server (padlock; still calls back). */
    val serviceLocked: Boolean = false,
    /** Policy absent or service held: honest non-actionable body, never an invented empty fleet. */
    val unavailable: EmptyStateUi? = null,
    /** No completed read for this base yet: no invented empty slots or "nothing to service". */
    val loading: Boolean = false,
    /** Safe host copy; drawn inside this sheet with a read-only retry. */
    val readError: String? = null,
    /** Crafted install/service lack an admitted reviewed Seal: their taps go to the host's existing Vehicle controls (or this
     *  refusal when it has none). Nothing extra is drawn for it. The existing free starter review is independent. */
    val reviewUnavailable: String? = null,
    /** Owner 2026-10-06 (free placement): the vacant Berth an INSTALL goes into; its quay slot gets the dashed frame. */
    val selectedBerthId: String? = null,
    /** A trailing "+" quay slot that places a new Berth on the base (the building placement flow). */
    val placeSlot: Boolean = false,
    /** Owner Seeker 2026-10-06 (v7-berth-fleet): the crafted read is still running under a starter card drawn from what is
     *  already known; only the 2 dp refresh line says so (voyage SPEC §0.5), never skeleton rows. */
    val refreshing: Boolean = false,
) {
    /** The panel shown (for the host's Back: Back on the picker returns to FLEET). */
    val panelKey: String get() = when {
        // Crafted vehicles closed, starter panel kept (owner Seeker 2026-10-06): SERVICE shows the honest closed copy.
        unavailable != null && starter != null && tab != TAB_SERVICE -> "FLEET_STARTER"
        unavailable != null -> PANEL_UNAVAILABLE
        tab == TAB_SERVICE -> TAB_SERVICE
        install != null -> "FLEET_INSTALL"
        starter != null && (!starter.installed || fleet == null) -> "FLEET_STARTER"
        else -> TAB_FLEET
    }

    companion object {
        const val TAB_FLEET = "FLEET"
        const val TAB_SERVICE = "SERVICE"
        const val PANEL_UNAVAILABLE = "UNAVAILABLE"
    }
}

/** The Berth sheet's callbacks. */
@Immutable data class BerthSheetActions(
    val onTab: (tabId: String) -> Unit = {},
    /** History → WalletHistory(berth). */
    val onHistory: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** A quay slot (selects that family; rows and slots select each other). */
    val onSlot: (VehicleFamily) -> Unit = {},
    val fleet: BerthFleetActions = BerthFleetActions(),
    val starter: StarterFleetActions = StarterFleetActions(),
    val install: InstallActions = InstallActions(),
    val service: BerthServiceActions = BerthServiceActions(),
    val onRetry: () -> Unit = {},
    /** A vacant Berth's quay slot: install into that Berth. */
    val onBerthSlot: (berthId: String) -> Unit = {},
    /** The "+" quay slot: place a new Berth on the base. */
    val onPlaceBerth: () -> Unit = {},
)

/** FLEET (lodge-menu) and SERVICE (+ red count of vehicles with ≤ 1 trip left). */
fun berthTabs(ui: BerthSheetUi): List<TabUi> {
    val count = badgeCount(serviceBadgeCount(ui.quay))
    return listOf(
        TabUi(BerthSheetUi.TAB_FLEET, "ui:lodge-menu", "FLEET", null, false),
        // fastener-set is copied (pkw_ui_item_fastener_set) but the kit TabStrip resolves only kit names; see MOUNT-VOYAGE.md.
        TabUi(BerthSheetUi.TAB_SERVICE, SERVICE_TAB_ICON, "SERVICE", count?.let { BadgeUi(it, BadgeTone.COUNT, "$it vehicles need service soon") }, ui.serviceLocked),
    )
}

/** The SERVICE tab icon until the kit's PkwIcon whitelist learns `fastener-set`. */
const val SERVICE_TAB_ICON = "ui:expedition-kit"

/**
 * The Berth sheet. [modifier] must give it a bounded height (the SheetHost: TALL, from y 104 to the bottom).
 *
 * Pointer rule: the root is the kit [SheetFrame] (a painted wood panel); no full-screen clickable, pointerInput, scrim or
 * draggable here. The TALL 40 % scrim is the SheetHost's, only while shown; quay slots are the only header targets.
 */
@Composable fun BerthSheet(ui: BerthSheetUi, on: BerthSheetActions, modifier: Modifier = Modifier) {
    val key = ui.panelKey
    // FLEET ↔ picker ↔ starter swap in place: a 120 ms fade-in (SPEC §8 motion), never a new page.
    val reduced = LocalReducedMotion.current
    val fade = remember { Animatable(1f) }
    var lastKey by remember { mutableStateOf(key) }
    LaunchedEffect(key) {
        if (lastKey != key) {
            lastKey = key
            fade.snapTo(0f)
            fade.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH))
        }
    }
    val footerContent: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit = {
        // No separate REVIEW primary (berth-install.png, berth-service.png): the designed primary itself acts, and while
        // the sheet has no reviewed Seal the host hands crafted money taps to the existing Vehicle controls.
        when (key) {
            // Round 2 part two: the sub-line says what is used up; the network cost lives only in the Seal.
            BerthSheetUi.TAB_SERVICE -> BerthServiceFooterV2(ui.service, on.service)
            "FLEET_STARTER" -> ui.starter?.let { BerthStarterFooter(it, on.starter) }
            BerthSheetUi.TAB_FLEET -> ui.fleet?.let { BerthFleetFooter(it, on.fleet) }
            else -> Unit
        }
    }
    val hasFooter = !ui.loading && (ui.unavailable == null || key == "FLEET_STARTER") && key != "FLEET_INSTALL" && !(key == BerthSheetUi.TAB_FLEET && ui.fleet == null) &&
        !(key == BerthSheetUi.TAB_SERVICE && ui.service.installed.isEmpty())
    val serviceShown = key == BerthSheetUi.TAB_SERVICE ||
        (key == BerthSheetUi.PANEL_UNAVAILABLE && ui.starter != null && ui.tab == BerthSheetUi.TAB_SERVICE)
    SheetFrame(SheetFrameUi("BERTH", null, SheetSize.TALL, berthTabs(ui), if (serviceShown) BerthSheetUi.TAB_SERVICE else BerthSheetUi.TAB_FLEET,
        titleTag = ui.level, history = ui.history), onClose = on.onClose, modifier = modifier, onTab = on.onTab, onHistory = on.onHistory,
        header = { if (ui.unavailable == null && (ui.quay.isNotEmpty() || ui.placeSlot))
            Quay(ui.quay, ui.selectedFamily, ui.selectedBerthId, ui.placeSlot, on.onSlot, on.onBerthSlot, on.onPlaceBerth) else QuaySea() },
        footer = if (hasFooter) footerContent else null) {
        Column(Modifier.fillMaxWidth().graphicsLayer { alpha = fade.value }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ui.readError?.let { message ->
                EmptyState(EmptyStateUi("ui:lodge-menu", "FLEET", message, null, null), onGo = {})
                SecondaryButton("RETRY", on.onRetry, Modifier.fillMaxWidth(), verb = Verb.BLUE)
            }
            if (ui.refreshing && !ui.loading) RefreshLine(true)
            if (ui.loading) {
                // SPEC §0.5 / §7 loading: a first load with no snapshot shows skeleton rows (unknown, never EMPTY).
                RefreshLine(true)
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    repeat(VehicleFamily.entries.size) { BerthSkeletonRow() }
                }
            }
            else if (ui.readError != null && ui.fleet == null && ui.unavailable == null && key != "FLEET_STARTER") Unit
            else when (key) {
                BerthSheetUi.PANEL_UNAVAILABLE -> ui.unavailable?.let { EmptyState(it, onGo = {}) }
                BerthSheetUi.TAB_SERVICE -> BerthServiceBody(ui.service, on.service)
                // SPEC §8: tapping a card is the action; there is no separate primary on the picker.
                "FLEET_INSTALL" -> ui.install?.let { BerthInstallBody(it, on.install) }
                "FLEET_STARTER" -> ui.starter?.let { BerthStarterBody(it, on.starter) }
                else -> ui.fleet?.let { BerthFleetBody(it, on.fleet) }
            }
        }
    }
}

/**
 * The `Quay` header (SPEC §7 item 2): the sea with waves and five berth slots in one continuous quay, each an 82 × 114
 * window (scaled to the header width) bottom-anchored on the authored berth art at k 2. Docked: berth + vehicle; away: the
 * empty berth + a blue time tag; empty: the berth greyed + a stone "+"; worn out: the vehicle dimmed + a red "!". The
 * selected slot gets the 3 dp dashed gold frame (84 × 84 on the slot's lower part, over the art; the "+" sits at its
 * centre, as in berth-fleet.html). Each slot is a ≥ 48 dp target. SheetFrame's title plate, History and close draw over
 * the top ~30 dp (only balloons and airships rise into that band).
 */
@Composable private fun Quay(slots: List<VehicleUi>, selected: VehicleFamily?, selectedBerth: String?, placeSlot: Boolean,
    onSlot: (VehicleFamily) -> Unit, onBerth: (String) -> Unit, onPlace: () -> Unit) {
    // Owner 2026-10-06: no pre-chosen spots. The slots are the player's own Berths (one building each, placed on the base),
    // in [slots] order; a vacant one is a Berth to install into, and the trailing "+" places a new Berth.
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = maxWidth.value
        val stride = (w - 4f) / QUAY_SLOTS
        QuaySea()
        val shown = slots.take(QUAY_SLOTS)
        shown.forEachIndexed { i, v ->
            val family = v.family
            val status = v.status
            val empty = status == VehicleStatus.EMPTY
            val worn = !empty && isWornOut(v)
            val isSelected = if (empty) v.berthId.isNotEmpty() && v.berthId == selectedBerth else family == selected
            val spoken = "${if (empty) "Empty" else familyName(family)} berth, ${when {
                empty -> "install a vehicle here"
                status == VehicleStatus.AWAY -> "at sea, back in ${v.returnsAt ?: UNKNOWN}"
                worn -> "needs service"
                else -> "docked"
            }}${if (isSelected) ", selected" else ""}"
            val tap: () -> Unit = { if (empty) onBerth(v.berthId) else onSlot(family) }
            Box(Modifier.offset(x = (2f + i * stride).dp, y = 19.dp).size((stride + 3f).dp, 114.dp)
                .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; this.selected = isSelected
                    onClick(label = null, action = { tap(); true }) }
                .clickable(role = Role.Button) { tap() }) {
                PixelSprite(berthArt(family), 2, Modifier.fillMaxSize(), 56f, 54f, bottomArtY = 94,
                    dim = if (empty) EMPTY_SLOT_DIM else null)
                if (status == VehicleStatus.DOCKED || status == VehicleStatus.WORN_OUT || status == VehicleStatus.BUSY_SERVICE) {
                    VehicleSprite(family, v.tier, 2, Modifier.fillMaxSize().offset(y = 8.dp), alpha = if (worn) 0.6f else 1f)
                }
                when {
                    empty -> Tag("+", Verb.STONE, Modifier.align(Alignment.Center).offset(y = QUAY_FRAME_CENTRE_DROP))
                    status == VehicleStatus.AWAY -> Tag(v.returnsAt ?: UNKNOWN, Verb.BLUE, Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp))
                    worn -> Tag("!", Verb.RED, Modifier.align(Alignment.TopEnd).padding(top = 30.dp, end = 4.dp))
                }
                if (isSelected) Box(Modifier.align(Alignment.BottomCenter).requiredSize(QUAY_FRAME).dashedFrame(true))
            }
        }
        if (placeSlot && shown.size < QUAY_SLOTS) {
            val i = shown.size
            Box(Modifier.offset(x = (2f + i * stride).dp, y = 19.dp).size((stride + 3f).dp, 114.dp)
                .clearAndSetSemantics { contentDescription = "Place a new Berth on your base"; role = Role.Button
                    onClick(label = null, action = { onPlace(); true }) }
                .clickable(role = Role.Button) { onPlace() }) {
                Tag("+", Verb.GOLD, Modifier.align(Alignment.Center).offset(y = QUAY_FRAME_CENTRE_DROP))
                Tag("NEW", Verb.STONE, Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp))
            }
        }
    }
}

/** The quay header's slot count at the designed stride (berth-fleet.html): one per Berth the base may hold. */
private const val QUAY_SLOTS = 5

/** berth-fleet.html: the selection frame is 84 × 84 dp, bottom-aligned on the 114 dp slot; its centre is 14 dp below the
 *  slot's, where the empty slot's "+" sits. */
private val QUAY_FRAME = 84.dp
private val QUAY_FRAME_CENTRE_DROP = 14.dp

/** The quay's sea and wave marks without slots: drawn from local art while no fleet snapshot exists (SPEC §0.5), so no
 *  berth is claimed empty or docked. Paint only. */
@Composable private fun QuaySea() {
    Canvas(Modifier.fillMaxSize().background(VoyageColors.seaHdr)) { drawWaves(31) }
}

// ---------- previews (sample data; every number is a placeholder) ----------

private val quayStarter = previewStarter
private val quayBalloonEmpty = VehicleUi(VehicleFamily.SURVEY_BALLOON, null, null, "berth-balloon", VehicleStatus.EMPTY, null, null, null, 0)
private val quayCutter = previewCutter.copy(tripsLeft = 1)
private val quayAirship = previewAirship
private val quayBargeEmpty = VehicleUi(VehicleFamily.EXPEDITION_BARGE, null, null, "berth-barge", VehicleStatus.EMPTY, null, null, null, 0)
private val sampleQuay = listOf(quayStarter, quayBalloonEmpty, quayCutter, quayAirship, quayBargeEmpty)

private val sampleService = BerthServiceUi(listOf(quayCutter, quayAirship), quayCutter.installationId, listOf(
    ServiceOptionUi(ServiceOp.RESTORE_USES, true, null, null, 10), ServiceOptionUi(ServiceOp.UPGRADE, true, null, 3, null)),
    ServiceOp.RESTORE_USES, OwnedVehicleUi("asset-cutter-2", 2), 1, "0.00002", VoyageSealState.IDLE)

private val sampleBerth = BerthSheetUi("LV 5", BerthSheetUi.TAB_FLEET, sampleQuay, VehicleFamily.SURVEY_BALLOON,
    BerthFleetUi("LV 5", sampleQuay, VehicleFamily.SURVEY_BALLOON, mapOf(VehicleFamily.SURVEY_BALLOON to 0), ordersAllowed = true),
    StarterFleetUi(available = true, installed = true, reason = null, pending = false), null, sampleService)

@Composable private fun BerthPreviewHost(ui: BerthSheetUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        BerthSheet(ui, BerthSheetActions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}

@Preview(name = "Berth › FLEET (berth-fleet.png)", widthDp = 412, heightDp = 915)
@Composable private fun BerthFleetPreview() = BerthPreviewHost(sampleBerth)

@Preview(name = "Berth › FLEET, docked selected (SEND FROM LODGE)", widthDp = 412, heightDp = 915)
@Composable private fun BerthFleetDockedPreview() = BerthPreviewHost(sampleBerth.copy(selectedFamily = VehicleFamily.CARGO_CUTTER,
    fleet = sampleBerth.fleet?.copy(selectedFamily = VehicleFamily.CARGO_CUTTER)))

@Preview(name = "Berth › FLEET, away selected (no primary)", widthDp = 412, heightDp = 915)
@Composable private fun BerthFleetAwayPreview() = BerthPreviewHost(sampleBerth.copy(selectedFamily = VehicleFamily.COURIER_AIRSHIP,
    fleet = sampleBerth.fleet?.copy(selectedFamily = VehicleFamily.COURIER_AIRSHIP)))

@Preview(name = "Berth › FLEET, wallet not linked (LOCKED)", widthDp = 412, heightDp = 915)
@Composable private fun BerthFleetNoWalletPreview() = BerthPreviewHost(sampleBerth.copy(fleet = sampleBerth.fleet?.copy(walletLinked = false)))

@Preview(name = "Berth › FLEET, install in flight (CHECK)", widthDp = 412, heightDp = 915)
@Composable private fun BerthFleetPendingPreview() = BerthPreviewHost(sampleBerth.copy(fleet = sampleBerth.fleet?.copy(pendingInstallFamily = VehicleFamily.SURVEY_BALLOON)))

@Preview(name = "Berth › FLEET, loading (unknown counts)", widthDp = 412, heightDp = 915)
@Composable private fun BerthFleetLoadingPreview() = BerthPreviewHost(sampleBerth.copy(level = UNKNOWN,
    fleet = sampleBerth.fleet?.copy(berths = sampleQuay.map { it.copy(tripsLeft = null, tripsMax = null) }, walletAssetsByFamily = null)))

@Preview(name = "Berth › starter, first visit (berth-starter.png)", widthDp = 412, heightDp = 915)
@Composable private fun BerthStarterPreview() = BerthPreviewHost(sampleBerth.copy(level = "LV 1", selectedFamily = VehicleFamily.STARTER,
    quay = listOf(quayStarter) + VehicleFamily.entries.drop(1).map { VehicleUi(it, null, null, "b-$it", VehicleStatus.EMPTY, null, null, null, 0) },
    starter = StarterFleetUi(available = true, installed = false, reason = null, pending = false)))

@Preview(name = "Berth › starter, installing", widthDp = 412, heightDp = 915)
@Composable private fun BerthStarterBusyPreview() = BerthPreviewHost(sampleBerth.copy(selectedFamily = VehicleFamily.STARTER,
    starter = StarterFleetUi(available = true, installed = false, reason = null, pending = true)))

@Preview(name = "Berth › starter, unavailable (LOCKED)", widthDp = 412, heightDp = 915)
@Composable private fun BerthStarterLockedPreview() = BerthPreviewHost(sampleBerth.copy(selectedFamily = VehicleFamily.STARTER,
    starter = StarterFleetUi(available = false, installed = false, reason = "The starter berth is not available on this server yet", pending = false)))

@Preview(name = "Berth › CHOOSE A BALLOON (berth-install.png, picker)", widthDp = 412, heightDp = 915)
@Composable private fun BerthInstallPreview() = BerthPreviewHost(sampleBerth.copy(install = InstallUi(VehicleFamily.SURVEY_BALLOON,
    listOf(OwnedVehicleUi("asset-b1", 1), OwnedVehicleUi("asset-b2", 2)), cursor = null, selectedAssetId = "asset-b2", feeSol = "0.00002",
    sealState = VoyageSealState.ARMED)))

@Preview(name = "Berth › CHOOSE A BALLOON, none in wallet", widthDp = 412, heightDp = 915)
@Composable private fun BerthInstallEmptyPreview() = BerthPreviewHost(sampleBerth.copy(install = InstallUi(VehicleFamily.SURVEY_BALLOON,
    emptyList(), null, null, null, VoyageSealState.IDLE)))

@Preview(name = "Berth › SERVICE (berth-service.png)", widthDp = 412, heightDp = 915)
@Composable private fun BerthServicePreview() = BerthPreviewHost(sampleBerth.copy(tab = BerthSheetUi.TAB_SERVICE, selectedFamily = VehicleFamily.CARGO_CUTTER))

@Preview(name = "Berth › SERVICE, hand-in missing", widthDp = 412, heightDp = 915)
@Composable private fun BerthServiceMissingPreview() = BerthPreviewHost(sampleBerth.copy(tab = BerthSheetUi.TAB_SERVICE,
    service = sampleService.copy(handIn = null, walletCount = 0)))

@Preview(name = "Berth › SERVICE, sending / uncertain", widthDp = 412, heightDp = 915)
@Composable private fun BerthServiceBusyPreview() = BerthPreviewHost(sampleBerth.copy(tab = BerthSheetUi.TAB_SERVICE,
    service = sampleService.copy(sealState = VoyageSealState.ERROR, error = VoyageMoneyErrorUi("The server didn't answer", authoritative = false))))

@Preview(name = "Berth › SERVICE, nothing to service", widthDp = 412, heightDp = 915)
@Composable private fun BerthServiceEmptyPreview() = BerthPreviewHost(sampleBerth.copy(tab = BerthSheetUi.TAB_SERVICE,
    service = sampleService.copy(installed = emptyList())))
