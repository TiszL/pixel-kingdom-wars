package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketBuyPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketSellPrimary

/*
 * Design component: the Market tall sheet with the round-2 tabs composed in (craft/SPEC.md "Round 2 additions" and
 * "Round 2 critic fixes"; UX-ARCHITECTURE §7.3 `Destination.Market(tab, section)`). An EXTENSION of the committed
 * `MarketSheet.kt` (not an edit of it): the same frame (`CraftSheetFrame`, header stage, review half sheet) and the
 * round-1 BUY tab, plus
 * - BUY with section "sol" → the SOL stall ([SolStallBody] / [SolStallFooter]), registry row 77;
 * - SELL → the re-done SELL ([MarketSellV2Body]: "Others sell it for about …", the realm's cut on the earnings line, the
 *   LIST Seal), replacing `MarketSellTab.kt`'s body;
 * - MY ORDERS (visible label OFFERS) → the stall ([MarketOffersBody]), replacing `MarketOrdersTab.kt`;
 * - COLLECTION (OWNED) → stores + wallet ([MarketOwnedV2Body]), replacing `MarketOwnedTab.kt` (§3.5).
 * Where a round-2 state is null the round-1 body of that tab is drawn, so the integrator can switch tab by tab.
 *
 * Pointer rule: the root is the painted wood frame (a scene-input region), never full-screen, with no scrim of its own
 * (the TALL 40 % scrim is the SheetHost's). The SOL BUY and LIST Seals and their 55 % scrims are the OverlayHost's
 * ([MarketSheetR2Seals]), composed only while shown. The review half sheet has no scrim.
 */

/** The Market sheet with its round-2 tab states. */
@Immutable data class MarketSheetR2Ui(
    /** The round-1 sheet: frame (title, LV, live chip "2 on your stall", History, tabs, selected tab), header, BUY state,
     *  the round-1 fallbacks and the review half sheet. Its frame's tab labels are shown as `marketTabsR2`. */
    val base: MarketSheetUi,
    /** The Destination's section ("sol" = the SOL stall on BUY; otherwise a BUY category id). */
    val section: String? = null,
    /** BUY › SOL stall (row 77). */
    val solStall: SolStallUi? = null,
    /** SELL, re-done. */
    val sellV2: MarketSellV2Ui? = null,
    /** OFFERS (tab id MY ORDERS), re-done as a stall. */
    val offers: MarketOffersUi? = null,
    /** OWNED (tab id COLLECTION), round 2 (row 78). */
    val owned: OwnedUi? = null,
    /** An existing owner's read-only mount. Its original receipts retain all financial commands. */
    val observation: MarketObservationUi? = null,
    /** The KEEP owner's command mode (BUY reservation, LIST, TAKE BACK in place); null = observation or a preview. */
    val command: MarketCommandUi? = null,
)

/** Command-mode facts the designed footers and rows need (KeepMarketCommandMapper decides them). */
@Immutable data class MarketCommandUi(
    /** Why BUY cannot start now (no deeded kingdom, paused orders, a saved request); null = it can. */
    val buyBlock: String? = null,
    /** Why LIST cannot start now; null = it can. */
    val listBlock: String? = null,
    /** A saved request waiting for its check (SPEC §5 recovery row); CHECK opens the original owner. */
    val waiting: SavedOpUi? = null,
    /** The selected completed listing / return with its explicit archive. */
    val completed: MarketCompletedUi? = null,
    /** The owner is working: an enabled primary shows busy dots instead. */
    val busy: Boolean = false,
)

/** A completed KEEP listing or return still held in the device journal: "Sell Frostglass" · "LISTED". */
@Immutable data class MarketCompletedUi(val key: String, val title: String, val status: String, val archiving: Boolean = false)

@Immutable data class MarketObservationUi(
    val message: String, val canRefresh: Boolean, val checking: Boolean = false,
    val recoveryLabel: String? = null,
    val unavailable: String? = null,
    val stallNotice: String? = null,
    /** Null means the book is not current; zero means a current book contains no omitted wallet-custody lots. */
    val omittedWalletLots: Int? = null,
    /** A separate navigation door when History opens receipts rather than the existing review owner. */
    val originalOwnerLabel: String? = null,
)

/** These states must not fall through to ready-empty inventory/stall copy. */
internal fun marketObservationBodyNotice(ui: MarketSheetR2Ui): String? {
    val observation = ui.observation ?: return null
    observation.unavailable?.let { return it }
    return when (ui.base.frame.selectedTab) {
        MarketTab.BUY -> if ((observation.omittedWalletLots ?: 0) > 0 && ui.base.buy?.offers?.isEmpty() == true)
            "This partial book omits wallet-held lots. Open ORIGINAL MARKET to see them." else null
        MarketTab.ORDERS -> observation.stallNotice ?: when {
            ui.offers == null || ui.offers.load == CraftHydration.Loading -> "Your stall has not been observed yet."
            ui.offers.load is CraftHydration.Error && ui.offers.places.isEmpty() -> ui.offers.load.message
            else -> null
        }
        else -> null
    }
}

/** The observation footer replaces action footers, so it must retain their current read-error evidence. */
internal fun marketObservationError(ui: MarketSheetR2Ui): String? {
    if (ui.observation == null || ui.observation.unavailable != null) return null
    val hydration = when (ui.base.frame.selectedTab) {
        MarketTab.BUY -> ui.base.buy?.hydration
        MarketTab.SELL -> ui.sellV2?.sell?.hydration ?: ui.base.sell?.hydration
        else -> null
    }
    return (hydration as? CraftHydration.Error)?.message
}

/** The Market sheet's callbacks: round 1 ([base]) plus each round-2 tab's. */
@Immutable data class MarketSheetR2Actions(
    val base: MarketSheetActions = MarketSheetActions(),
    val sol: SolStallActions = SolStallActions(),
    val sell: MarketSellV2Actions = MarketSellV2Actions(),
    val offers: MarketOffersActions = MarketOffersActions(),
    val owned: OwnedActions = OwnedActions(),
    val onOriginal: () -> Unit = {},
    /** CHECK on the recovery row: the waiting request's key (opens it in the original owner). */
    val onCheckSaved: (String) -> Unit = {},
    /** ARCHIVE COMPLETED RECORD on the completed row: the record's key. */
    val onArchive: (String) -> Unit = {},
)

/**
 * The Market tall sheet, round 2. [modifier] must give it a bounded height (SheetHost: y 104 to the bottom edge).
 *
 * Pointer rule: the root is the painted wood frame, never full-screen; no clickable, pointerInput, draggable or scrim on
 * it. Only painted kit pieces inside take touches. The TALL scrim belongs to the SheetHost; the Seals to the OverlayHost.
 */
@Composable fun MarketSheetR2(ui: MarketSheetR2Ui, on: MarketSheetR2Actions, modifier: Modifier = Modifier) {
    val base = ui.base
    val tab = base.frame.selectedTab
    val sol = ui.solStall?.takeIf { tab == MarketTab.BUY && ui.section == SOL_STALL_SECTION }
    val frame = base.frame.copy(tabs = base.frame.tabs.map { if (it.id == MarketTab.ORDERS) it.copy(label = "OFFERS") else it })
    val toSell: () -> Unit = { on.base.onTab(MarketTab.SELL) }
    val offersOn = on.offers.copy(onFreePlace = { on.offers.onFreePlace(); toSell() })
    val command = ui.command
    val buy = base.buy
    val sellV2 = ui.sellV2
    CraftSheetFrame(frame, on.base.onClose, on.base.onTab, on.base.onHistory, modifier,
        headerArt = { HeaderStage(base.header, null, null, 180.dp, (-28).dp, "The Market") },
        footer = {
            if (ui.observation != null) {
                marketObservationError(ui)?.let { FooterNote(it, danger = true) }
                FooterNote("Purchase and listing review is unavailable in this view.")
                if (ui.observation.canRefresh) SecondaryButton("CHECK", on.base.onRetry)
                else if (ui.observation.checking) PkwText(CHECKING_TEXT, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                ui.observation.recoveryLabel?.let { SecondaryButton(it, on.base.onHistory) }
                ui.observation.originalOwnerLabel?.let { SecondaryButton(it, on.onOriginal) }
            } else {
            when (tab) {
                MarketTab.BUY -> when {
                    // E1.2 UNAVAILABLE: the BUY primary is X with the plain reason; no Seal, no wallet step.
                    sol != null && !sol.available -> CraftPrimaryButton(offPrimary("BUY", null, sol.unavailableReason), {}, Modifier.fillMaxWidth())
                    sol != null -> SolStallFooter(sol, on.sol)
                    buy != null -> MarketBuyFooter(buy, on.base,
                        if (command != null) keepMarketBuyPrimary(buy, command.buyBlock, command.busy) else buyPrimary(buy))
                    else -> PendingR2Footer()
                }
                MarketTab.SELL -> when {
                    sellV2 != null -> MarketSellV2Footer(sellV2, on.base,
                        if (command != null) keepMarketSellPrimary(sellV2.sell, command.listBlock) else sellPrimary(sellV2.sell))
                    base.sell != null -> MarketSellFooter(base.sell, on.base, sellPrimary(base.sell))
                    else -> PendingR2Footer()
                }
                MarketTab.ORDERS -> when {
                    ui.offers != null -> MarketOffersFooter(ui.offers, offersOn, toSell)
                    base.orders != null -> MarketOrdersFooter(base.orders, on.base)
                    else -> PendingR2Footer()
                }
                MarketTab.OWNED -> ui.owned?.let { MarketOwnedV2Footer(it, on.owned) }
                else -> Unit
            }
            }
        },
        panelOverlay = { ReviewHalfSheet(base.review, emptyList(), null, on.base.onReviewBack, on.base.onReviewConfirm) },
    ) {
        // SPEC §5: the recovery row sits at the top of the panel; a completed record offers its explicit archive.
        command?.waiting?.let { RecoveryRow(it, on.onCheckSaved) }
        command?.completed?.let { CompletedRecordRow(it, on.onArchive) }
        ui.observation?.let { PkwText(it.message, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
        val observationNotice = marketObservationBodyNotice(ui)
        if (ui.observation?.unavailable != null) {
            EmptyState(EmptyStateUi("ui:market-menu", "Market unavailable", ui.observation.unavailable, null, null), onGo = {})
        } else if (observationNotice != null) {
            PkwText(observationNotice, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
        } else when (tab) {
            MarketTab.BUY -> when {
                sol != null -> SolStallBody(sol, on.sol)
                // A failed read is never the ready-empty "No lots right now" (observation and command mode alike).
                buy != null && buy.hydration is CraftHydration.Error && buy.offers.isEmpty() ->
                    PkwText("Lots are unavailable until the Market refreshes.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
                buy != null -> MarketBuyBody(buy, on.base, offersLabel = "OFFERS")
                else -> PendingR2Body()
            }
            MarketTab.SELL -> when {
                (sellV2?.sell ?: base.sell)?.let { it.hydration is CraftHydration.Error && it.sellable.isEmpty() } == true ->
                    PkwText("Stores are unavailable until the Market refreshes.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
                sellV2 != null -> MarketSellV2Body(sellV2, on.base, on.sell.onPriceText)
                base.sell != null -> MarketSellBody(base.sell, on.base)
                else -> if (ui.observation == null) PendingR2Body() else PkwText("No current sellable stock is available to this view.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
            }
            MarketTab.ORDERS -> when {
                ui.offers != null -> MarketOffersBody(ui.offers, offersOn)
                base.orders != null -> MarketOrdersBody(base.orders, on.base)
                else -> PendingR2Body()
            }
            MarketTab.OWNED -> when {
                ui.owned != null -> MarketOwnedV2Body(ui.owned, on.owned)
                base.owned != null -> MarketOwnedBody(base.owned, on.base)
                else -> PendingR2Body()
            }
            else -> PendingR2Body()
        }
    }
}

/**
 * The round-2 Market Seals for the OverlayHost, in one call: the SOL stall BUY Seal and the LIST Seal, each composed
 * only from its state's `seal` field. Keep composing it (with the seals cleared) through the exits; [onExitFinished]
 * fires once per seal that leaves.
 *
 * Pointer rule: a seal root is full-screen (its 55 % scrim, a tap = BACK) only while that seal is shown or animating out;
 * with no seal up nothing is painted and nothing takes touches.
 */
@Composable fun MarketSheetR2Seals(ui: MarketSheetR2Ui?, on: MarketSheetR2Actions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    MarketSealV2(ui?.solStall?.seal, MarketSealActions(onConfirm = on.sol.onSealConfirm, onBack = on.sol.onBack, onRetry = on.sol.onRetry,
        onCheck = on.sol.onCheck), modifier, clock, onExitFinished)
    MarketSealV2(ui?.sellV2?.listSeal, MarketSealActions(onConfirm = on.sell.onListConfirm, onBack = on.sell.onListBack), modifier, clock, onExitFinished)
}

/** A completed listing / return still held in the device journal (title + status) and its explicit archive: the
 *  journal keeps a limited number of saved requests and RECEIPTS has no archive control. Never archived without a tap. */
@Composable private fun CompletedRecordRow(ui: MarketCompletedUi, onArchive: (String) -> Unit) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth(), rim = CardRim.NOTE, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText(ui.title, PkwTokens.Type.body, color = c.textOnParch, maxLines = 2)
            PkwText(ui.status, PkwTokens.Type.small, color = c.textOnParch2)
            SecondaryButton("ARCHIVE COMPLETED RECORD", { if (!ui.archiving) onArchive(ui.key) }, Modifier.fillMaxWidth(),
                enabled = !ui.archiving, contentDescription = "Archive the completed record: ${ui.title}")
        }
    }
}

@Composable private fun PendingR2Body() {
    PkwText(CHECKING_TEXT, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
}

@Composable private fun PendingR2Footer() {
    CraftPrimaryButton(busyPrimary(CHECKING_TEXT), {})
}

/** Renders the round-2 Market sheet the way the SheetHost does on the 412 × 915 phone (y 104 → bottom); [seals] also
 *  composes the OverlayHost's Seals over it. */
@Composable internal fun MarketR2PreviewHost(ui: MarketSheetR2Ui, seals: Boolean = false) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        MarketSheetR2(ui, MarketSheetR2Actions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp))
        if (seals) MarketSheetR2Seals(ui, MarketSheetR2Actions(), clock = { 10_000L })
    }
}
