package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the SOL stall (design/final/craft/market-sol.png; SPEC "E1.2 SOL stall", registry row 77
 * `Market(BUY, section = "sol")`). The BUY tab with the SOL STALL chip on (blue): "VEHICLES · priced in SOL · 12 ▸" and
 * 85 × 104 lot cards (vehicle 56, blue tier tag, SOL 24 + PS 11 price; selected = gold rim). SOL is never a HUD readout:
 * the price lives on each lot and in the Seal. BUY opens the Seal BEFORE any wallet step ([solBuySeal] → [MarketSealV2],
 * composed by the OverlayHost via [MarketSheetR2Seals]); the realm's cut appears only there.
 *
 * Pointer rule: drawn inside the Market sheet's painted panel; only the filter chips, the "12 ▸" door, the lot cards and
 * the footer buttons take touches (each ≥ 48 dp, a scene-input region). No scrim of its own.
 */

/** One vehicle lot (SPEC `SolLotUi`: id, art, tier, price, seller, tripsLeft; `name` was added for the Seal title). */
@Immutable data class SolLotUi(
    /** The lot id (handed back by `onLot` / `onBuy`). */
    val id: String,
    /** The vehicle idle (`voyage:veh-survey-balloon-t2`, 112 px drawn at 56 dp). */
    val art: String,
    /** The blue tier tag ("T2"). */
    val tier: String,
    /** The SOL price; CHECKING shows "…", UNAVAILABLE "unavailable" (kit `priceText`), never 0 without SERVER_ZERO. */
    val price: PriceUi,
    /** The seller's name ("Rook of Ashford"). */
    val seller: String,
    /** "10/10 trips". */
    val tripsLeft: String,
    /** Added: "Survey Balloon T2". */
    val name: String,
)

/** The money outcome under the primary (SPEC E1.2 states). */
@Immutable data class SolOutcomeUi(
    /** True only for a definite refusal ("Sold to someone else. Nothing was spent."). */
    val authoritative: Boolean,
    /** The sentence (uncertain: "the balloon appears in OWNED when the realm confirms"). */
    val line: String,
)

/** The SOL stall (SPEC `SolStallUi(filter, lots, selected, seal)`; fields after `seal` were added). */
@Immutable data class SolStallUi(
    /** The active filter chip id ([SOL_STALL_SECTION] here). */
    val filter: String,
    /** Vehicles on the stall, server order. */
    val lots: List<SolLotUi>,
    /** The selected lot id. */
    val selected: String?,
    /** The BUY Seal while it is up ([solBuySeal]); composed by the OverlayHost, not inside the sheet. */
    val seal: MarketSealUi?,
    /** The filter chips (MATERIALS, TOOLS, SOL STALL): the same ids as `MarketBuyUi.categories`. */
    val filters: List<MarketCategoryUi> = emptyList(),
    /** "12 ▸"; null = unknown ("…"). */
    val total: Int? = null,
    /** False: "SOL stall closed on this server" (the primary is hidden). */
    val available: Boolean = true,
    /** False: BUY is LOCKED "Link a wallet to buy". */
    val walletLinked: Boolean = true,
    /** The money sequence (READY → CHECK_WALLET → SENDING → SENT; FAILED with [outcome]). */
    val stage: MoneyStage = MoneyStage.READY,
    /** The refusal / uncertain sentence after FAILED; null otherwise. */
    val outcome: SolOutcomeUi? = null,
    /** Loading keeps the last lots with a 2 dp stone line; Error adds CHECK. */
    val load: CraftHydration = CraftHydration.Ready,
    /** Explicit reason from the host; absence of a client owner must not be labelled a server switch. */
    val unavailableReason: String = "SOL stall closed on this server",
)

/** SOL stall callbacks (SPEC: onFilter, onLot, onBuy, onSealConfirm, onBack, onRetry, onCheck; the rest were added). */
@Immutable data class SolStallActions(
    /** A filter chip (MATERIALS / TOOLS switch the BUY section back). */
    val onFilter: (String) -> Unit = {},
    /** A lot card (selects it). */
    val onLot: (String) -> Unit = {},
    /** BUY: raise the Seal ([solBuySeal]) before any wallet step. */
    val onBuy: (String) -> Unit = {},
    /** The Seal's armed BUY: the wallet payment. */
    val onSealConfirm: () -> Unit = {},
    /** The Seal's BACK / scrim / system Back. */
    val onBack: () -> Unit = {},
    /** RETRY after an authoritative, retryable refusal. */
    val onRetry: () -> Unit = {},
    /** CHECK after an uncertain result (the by-key read), or on the error row. */
    val onCheck: () -> Unit = {},
    /** "12 ▸": more lots. */
    val onMore: () -> Unit = {},
    /** "Link a wallet to buy" → Profile › WALLET. */
    val onLinkWallet: () -> Unit = {},
    /** A SHORT price → Need-more ("Add SOL in Profile › WALLET"). */
    val onNeedMore: (PriceUi) -> Unit = {},
    /** The empty state's blue "Craft one on Solana Island". */
    val onCraftLink: () -> Unit = {},
    /** A refused tap: toast the reason. */
    val onExplain: (String?) -> Unit = {},
)

/** The SOL stall body (BUY tab, section "sol"). */
@Composable internal fun ColumnScope.SolStallBody(ui: SolStallUi, on: SolStallActions) {
    val c = PkwTokens.Colors
    if (ui.filters.isNotEmpty()) {
        LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(end = 8.dp)) {
            items(ui.filters, key = { it.id }) { f -> StallFilterChip(f, f.id == ui.filter, on.onFilter) }
        }
    }
    if (ui.load is CraftHydration.Loading) Box(Modifier.fillMaxWidth().height(2.dp).background(c.stone.face))
    if (!ui.available) {
        CreamCard(Modifier.fillMaxWidth().heightIn(min = 56.dp), rim = CardRim.NOTE, contentPadding = PaddingValues(10.dp)) {
            PkwText(ui.unavailableReason, PkwTokens.Type.body, Modifier.align(Alignment.CenterStart), color = c.textOnParch, maxLines = 2)
        }
        return
    }
    if (ui.load is CraftHydration.Error) ErrorCheckRow("The stall can't reach the server", on.onCheck, "The last lots stay on screen")
    if (ui.lots.isEmpty() && ui.load !is CraftHydration.Loading) {
        EmptyState(EmptyStateUi("ui:market-menu", "No vehicles on the stall today", "Craft one on Solana Island", null, null), onGo = {})
        SecondaryButton("Craft one on Solana Island", on.onCraftLink, Modifier.fillMaxWidth(), verb = Verb.BLUE)
        return
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("VEHICLES", "priced in SOL", modifier = Modifier.weight(1f))
        QuietButton("${ui.total ?: "…"} ▸", on.onMore, onParchment = true, contentDescription = "More vehicles on the stall")
    }
    val selected = selectedSolLot(ui)
    ui.lots.chunked(4).forEach { row ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            row.forEach { lot -> SolLotCard(lot, lot.id == selected?.id, on.onLot, Modifier.weight(1f)) }
            repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

/** The SOL stall footer: the BUY primary (with its money sequence) and its note or outcome line. */
@Composable internal fun ColumnScope.SolStallFooter(ui: SolStallUi, on: SolStallActions) {
    val primary = solBuyPrimary(ui) ?: return
    val lot = selectedSolLot(ui)
    PrimaryButton(primary.label, {
        when (primary.action) {
            SolAction.BUY -> lot?.let { on.onBuy(it.id) }
            SolAction.LINK_WALLET -> on.onLinkWallet()
            SolAction.NEED_MORE -> lot?.let { on.onNeedMore(it.price) }
            SolAction.CHECK -> on.onCheck()
            SolAction.RETRY -> lot?.let { on.onBuy(it.id) }
            SolAction.EXPLAIN -> on.onExplain(primary.reason)
            SolAction.NONE -> Unit
        }
    }, Modifier.fillMaxWidth(), verb = primary.verb, sub = primary.sub, state = primary.state, reason = primary.reason)
    val outcome = solOutcomeLine(ui.outcome)
    if (outcome != null) FooterNote(outcome, danger = ui.outcome?.authoritative == true)
    else FooterNote("Paid from your wallet. You sign once.")
}

/** One 85 × 104 SOL lot card: blue tier tag top-right, vehicle 56, SOL 24 + PS 11 price; selected = gold rim. */
@Composable private fun SolLotCard(lot: SolLotUi, selected: Boolean, onClick: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    CreamCard(modifier.heightIn(min = 104.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = "${lot.name}, ${priceDescription(lot.price)}, from ${lot.seller}"
            role = Role.Button; this.selected = selected
            this.onClick(label = null, action = { onClick(lot.id); true })
        }
        .clickable(role = Role.Button) { onClick(lot.id) }, rim = if (selected) CardRim.SELECTED else CardRim.NONE, contentPadding = PaddingValues(4.dp)) {
        Tag(lot.tier, Verb.BLUE, Modifier.align(Alignment.TopEnd))
        Column(Modifier.align(Alignment.BottomCenter).padding(top = 22.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            MarketArt(lot.art, 56.dp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwIcon("sol", 24.dp)
                PkwText(priceText(lot.price), PkwTokens.Type.caption, color = if (lot.price.status == PriceStatus.SHORT) c.shortText else c.textOnParch)
            }
        }
    }
}

/** A filter chip like BUY's (a 40 dp face in a 48 dp hit area; active = blue): the SOL STALL chip carries the SOL icon. */
@Composable private fun StallFilterChip(cat: MarketCategoryUi, active: Boolean, onSelect: (String) -> Unit) {
    val c = PkwTokens.Colors
    Box(Modifier.heightIn(min = PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = cat.label; role = Role.Tab; selected = active
            this.onClick(label = null, action = { onSelect(cat.id); true })
        }
        .clickable(role = Role.Tab) { onSelect(cat.id) }, contentAlignment = Alignment.Center) {
        Row(Modifier.height(40.dp).drawBehind {
            val w = size.width; val h = size.height; val i = 2.dp.toPx()
            fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                drawRect(if (active) c.blue.face else c.cream)
                band(i, w - i, i, 2.dp.toPx(), if (active) c.blue.hi else c.parchmentHi)
                band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), if (active) c.blue.lo else c.creamLo)
            }
        }.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            cat.icon?.let { PkwIcon(it, 24.dp) }
            if (active) PkwText(cat.label, PkwTokens.Type.caption, color = c.label, outline = 1.dp)
            else PkwText(cat.label, PkwTokens.Type.caption, color = c.textOnParch)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

private fun solSheet(stall: SolStallUi) = CraftR2Samples.marketR2(MarketTab.BUY).copy(section = SOL_STALL_SECTION, solStall = stall)

@Preview(name = "Market › BUY › SOL stall (market-sol.png, Seal up)", widthDp = 412, heightDp = 811)
@Composable private fun SolStallPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall.copy(seal = CraftR2Samples.solSeal)), seals = true)

@Preview(name = "Market › SOL stall, lots", widthDp = 412, heightDp = 811)
@Composable private fun SolStallLotsPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall))

@Preview(name = "Market › SOL stall, no wallet (LOCKED)", widthDp = 412, heightDp = 811)
@Composable private fun SolStallNoWalletPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall.copy(walletLinked = false)))

@Preview(name = "Market › SOL stall, price checking", widthDp = 412, heightDp = 811)
@Composable private fun SolStallCheckingPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall.copy(lots = CraftR2Samples.solStall.lots.map {
    it.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING)) })))

@Preview(name = "Market › SOL stall, uncertain result (CHECK)", widthDp = 412, heightDp = 811)
@Composable private fun SolStallUncertainPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall.copy(stage = MoneyStage.FAILED,
    outcome = SolOutcomeUi(false, "the balloon appears in OWNED when the realm confirms"))))

@Preview(name = "Market › SOL stall, sold to someone else (authoritative)", widthDp = 412, heightDp = 811)
@Composable private fun SolStallRefusedPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall.copy(stage = MoneyStage.FAILED,
    outcome = SolOutcomeUi(true, "Sold to someone else. Nothing was spent."))))

@Preview(name = "Market › SOL stall, closed on this server", widthDp = 412, heightDp = 811)
@Composable private fun SolStallClosedPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall.copy(available = false)))

@Preview(name = "Market › SOL stall, empty", widthDp = 412, heightDp = 811)
@Composable private fun SolStallEmptyPreview() = MarketR2PreviewHost(solSheet(CraftR2Samples.solStall.copy(lots = emptyList(), total = 0)))
