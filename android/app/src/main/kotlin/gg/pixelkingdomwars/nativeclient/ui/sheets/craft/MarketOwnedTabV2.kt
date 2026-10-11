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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * Design component: Market › OWNED, round 2 (design/final/craft/market-owned.png; SPEC "E1.1 Market OWNED", registry
 * row 78 `Market(tab = "COLLECTION")`, fallback host Keep › STORES). Supersedes §3.5 / `MarketOwnedTab.kt` (deeds only):
 * what you hold that the stall can sell, split by what it sells for — "IN YOUR STORES · sell for KEEP" (85 × 104 lot
 * cards; tap = SELL with that item), "IN YOUR WALLET · sell for SOL" (60 dp OwnedRows with CAN SELL / IN USE / INSTALLED,
 * the selected one gold-rimmed), the 72 dp detail card ("Others sold for about 0.06 SOL", recent sales, never a promise),
 * and the footer: blue INSTALL "at the Berth" + gold SELL ("set your price next"), "Nothing leaves your wallet until you
 * sign the Seal." A spare deed that trades only on outside marketplaces gets a blue OPEN ↗ (system browser) instead.
 *
 * Pointer rule: drawn inside the Market sheet's painted parchment panel; only the lot cards, the "16 ▸" door, the wallet
 * rows and the buttons take touches (each its own ≥ 48 dp target, a scene-input region). No scrim, no full-screen
 * clickable.
 */

/** What an owned wallet thing can do here (SPEC E1.1 `OwnedRowUi.State`; LISTING / ON_SALE are the busy / success
 *  states of the same rows). */
enum class OwnedState {
    /** Green CAN SELL: SELL opens the SELL tab in SOL mode. */
    CAN_SELL,
    /** Stone IN USE: the home deed, an applied awning. */
    IN_USE,
    /** Stone INSTALLED: a vehicle at the Berth ("take it out to sell"). */
    INSTALLED,
    /** A spare deed while deeds trade only on outside marketplaces: CAN SELL + blue OPEN ↗. */
    OUTSIDE_ONLY,
    /** Added: a listing is being made (stone dots in place of the tag). */
    LISTING,
    /** Added: listed; blue ON SALE (OFFERS gets a badge). */
    ON_SALE,
}

/** One stores lot card (85 × 104: item 64 + PS 11 "×14"); tap = SELL with it selected. */
@Immutable data class LotUi(
    /** Catalogue item id (handed back by `onStoresItem`). */
    val id: String,
    /** 64 px item art (`craftItemIcon(id)`). */
    val icon: String,
    /** "×14", "…" while unknown (never "×0" for unknown). */
    val count: String,
    /** "Frostglass, 14 in your stores". */
    val description: String,
)

/** One wallet row (SPEC `OwnedRowUi`: 48 well with the art, VT 20 name, VT 18 where it is, right tag). */
@Immutable data class OwnedRowUi(
    /** The asset id (handed back by every wallet callback). */
    val id: String,
    /** Its art: "ui_portrait_keep_t3" (home deed), "itm_deed_earth", "voyage:veh-survey-balloon-t1", "craft:awning_t2". */
    val art: String,
    /** "Ironhold deed", "Survey Balloon T1". */
    val name: String,
    /** "your home kingdom", "in your wallet", "at the Berth", "on this Market". */
    val where: String,
    /** CAN_SELL · IN_USE · INSTALLED · OUTSIDE_ONLY (+ LISTING, ON_SALE). */
    val state: OwnedState,
    /** Exact observation label when a receipt does not admit one of the action states. */
    val observedLabel: String? = null,
)

/** The 72 dp detail card of the selected wallet row. */
@Immutable data class OwnedDetailUi(
    /** The selected row's id. */
    val id: String,
    /** Its art (56 dp well). */
    val art: String,
    /** PS 12 name ("SURVEY BALLOON T1"). */
    val name: String,
    /** VT 18 ("10/10 trips · spare, not installed"). */
    val line: String,
    /** VT 18 recent sales ("Others sold for about 0.06 SOL"), labelled as recent sales; null when none. */
    val recentSales: String?,
    /** The selected row's state (drives where the primary goes). */
    val state: OwnedState,
)

/** Market › OWNED state (SPEC E1.1 `OwnedUi`; fields after `walletLinked` were added). */
@Immutable data class OwnedUi(
    /** The stores lots that sell for KEEP (the first four are drawn). */
    val stores: List<LotUi>,
    /** All stores lots, for "16 ▸"; null = unknown ("…"). */
    val storesTotal: Int?,
    /** Wallet things that sell for SOL (deeds, vehicles, awnings). */
    val wallet: List<OwnedRowUi>,
    /** The selected wallet row's detail; null = none selected (no footer). */
    val selected: OwnedDetailUi?,
    /** Gold SELL ("SELL BALLOON" / "set your price next"), or blue OPEN ↗ for an outside-only deed ([CommandUi.verb] BLUE).
     *  Its [CommandUi.state] / reason come from the mapper; a CHECKING price stays enabled navigation. */
    val primary: CommandUi?,
    /** Blue INSTALL "at the Berth" (the in-game alternative); null hides it. */
    val secondary: CommandUi?,
    /** False: the wallet section reads "Link a wallet to see deeds and vehicles" + blue WALLET. */
    val walletLinked: Boolean,
    /** Loading keeps the last good view with a 2 dp stone line; Error adds "Updated n min ago" + CHECK. */
    val load: CraftHydration = CraftHydration.Ready,
    /** "2 min ago" for the error row; null = unknown. */
    val updatedAgo: String? = null,
    /** The empty state's GO (Solana Island workshop or the Workshop), from the registry. */
    val emptyGo: FeatureId? = null,
    /** Missing scopes are unknown, never evidence that the wallet or stores are empty. */
    val storesKnown: Boolean = true,
    val walletKnown: Boolean = true,
)

/** Market › OWNED callbacks (SPEC E1.1; the last four were added). */
@Immutable data class OwnedActions(
    /** A stores lot → SELL tab with that item selected. */
    val onStoresItem: (itemId: String) -> Unit = {},
    /** "16 ▸" → the full stores list. */
    val onMoreStores: () -> Unit = {},
    /** A wallet row (selects it). */
    val onWalletItem: (assetId: String) -> Unit = {},
    /** SELL → SELL tab in SOL mode with the price stepper. */
    val onSell: (assetId: String) -> Unit = {},
    /** INSTALL → Berth FLEET with that vehicle. */
    val onInstall: (assetId: String) -> Unit = {},
    /** OPEN ↗ → the outside marketplace in the system browser. */
    val onOpenOutside: (assetId: String) -> Unit = {},
    /** "Link a wallet" → Profile › WALLET. */
    val onLinkWallet: () -> Unit = {},
    /** CHECK on the error row (refresh). */
    val onCheck: () -> Unit = {},
    /** The empty state's GO. */
    val onEmptyGo: (FeatureId) -> Unit = {},
    /** A refused primary / secondary tap: toast the reason (never silent). */
    val onExplain: (reason: String?) -> Unit = {},
)

/** The OWNED body. */
@Composable internal fun ColumnScope.MarketOwnedV2Body(ui: OwnedUi, on: OwnedActions) {
    val c = PkwTokens.Colors
    if (ui.load is CraftHydration.Loading) Box(Modifier.fillMaxWidth().height(2.dp).background(c.stone.face))
    if (ui.storesKnown && ui.walletKnown && ownedIsEmpty(ui)) {
        EmptyState(EmptyStateUi("itm_deed_earth", "Nothing to sell yet", "Craft on Solana Island or refine at the Workshop",
            if (ui.emptyGo != null) "GO" else null, ui.emptyGo), onGo = on.onEmptyGo)
        if (!ui.walletLinked) LinkWalletRow(on)
        return
    }
    if (ui.load is CraftHydration.Error) ErrorCheckRow("Updated ${ui.updatedAgo ?: "…"}", on.onCheck)

    // IN YOUR STORES · sell for KEEP · 16 ▸
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("IN YOUR STORES", "sell for KEEP", modifier = Modifier.weight(1f))
        QuietButton("${ui.storesTotal ?: "…"} ▸", on.onMoreStores, onParchment = true, contentDescription = "See all ${ui.storesTotal ?: ""} in your stores")
    }
    if (!ui.storesKnown) PkwText("Stores have not been observed for this kingdom.", PkwTokens.Type.small, color = c.textOnParch2)
    else if (ui.stores.isEmpty()) PkwText("Nothing in your stores sells for KEEP yet.", PkwTokens.Type.small, color = c.textOnParch2)
    else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ui.stores.take(4).forEach { lot -> StoresLotCard(lot, on.onStoresItem, Modifier.weight(1f)) }
        repeat(4 - ui.stores.take(4).size) { Spacer(Modifier.weight(1f)) }
    }

    // IN YOUR WALLET · sell for SOL
    SectionLabel("IN YOUR WALLET", "sell for SOL")
    if (!ui.walletKnown) PkwText("Wallet collection is unavailable in this view.", PkwTokens.Type.small, color = c.textOnParch2)
    else if (!ui.walletLinked) LinkWalletRow(on)
    else if (ui.wallet.isEmpty()) PkwText("No deeds or vehicles in your wallet.", PkwTokens.Type.small, color = c.textOnParch2)
    else ui.wallet.forEach { row -> OwnedRow(row, row.id == ui.selected?.id, on.onWalletItem) }

    ui.selected?.let { DetailCard(it) }
}

/** The OWNED footer: blue INSTALL + gold SELL (or blue OPEN ↗), then "Nothing leaves your wallet until you sign the Seal." */
@Composable internal fun ColumnScope.MarketOwnedV2Footer(ui: OwnedUi, on: OwnedActions) {
    val selected = ui.selected ?: return
    val primary = ui.primary
    val secondary = ui.secondary
    if (primary == null && secondary == null) return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        secondary?.let { cmd ->
            PrimaryButton(cmd.caption, { routeOwned(cmd, selected, on, install = true) }, Modifier.width(112.dp), verb = Verb.BLUE,
                sub = cmd.sub, state = commandDrawState(cmd))
        }
        primary?.let { cmd ->
            PrimaryButton(cmd.caption, { routeOwned(cmd, selected, on, install = false) }, Modifier.weight(1f),
                verb = if (cmd.verb == Verb.STONE) Verb.GOLD else cmd.verb, sub = cmd.sub, state = commandDrawState(cmd), reason = cmd.reason)
        }
    }
    FooterNote("Nothing leaves your wallet until you sign the Seal.")
}

/** One tap on an OWNED command: an enabled one opens its door; anything else explains (never silent). */
private fun routeOwned(cmd: CommandUi, selected: OwnedDetailUi, on: OwnedActions, install: Boolean) {
    when (commandRoute(cmd)) {
        CommandRoute.OPEN -> if (install) on.onInstall(selected.id) else when (ownedRoute(selected.state)) {
            OwnedRoute.SELL -> on.onSell(selected.id)
            OwnedRoute.OPEN_OUTSIDE -> on.onOpenOutside(selected.id)
            OwnedRoute.EXPLAIN -> on.onExplain(cmd.reason ?: ownedReason(selected.state))
        }
        CommandRoute.NEED_MORE, CommandRoute.EXPLAIN -> on.onExplain(cmd.reason ?: ownedReason(selected.state))
        CommandRoute.IGNORE -> Unit
    }
}

/** An 85 × 104 stores lot card: 64 dp item art + PS 11 "×14". Its own ≥ 48 dp target. */
@Composable private fun StoresLotCard(lot: LotUi, onClick: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    CreamCard(modifier.heightIn(min = 104.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "${lot.description}. Sell it"; role = Role.Button
            this.onClick(label = null, action = { onClick(lot.id); true }) }
        .clickable(role = Role.Button) { onClick(lot.id) }, contentPadding = PaddingValues(4.dp)) {
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            CraftIcon(lot.icon, 64.dp)
            PkwText(lot.count, PkwTokens.Type.caption, color = c.textOnParch)
        }
    }
}

/** A 60 dp OwnedRow: 48 well, VT 20 name, VT 18 where, the right tag (or dots while listing). Selected = gold rim. */
@Composable private fun OwnedRow(row: OwnedRowUi, selected: Boolean, onClick: (String) -> Unit) {
    val c = PkwTokens.Colors
    val tag = ownedTag(row.state)
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 60.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = listOfNotNull(row.name, row.where, row.observedLabel ?: tag?.first ?: "being listed").joinToString(", ")
            role = Role.Button; this.selected = selected
            this.onClick(label = null, action = { onClick(row.id); true })
        }
        .clickable(role = Role.Button) { onClick(row.id) }, rim = if (selected) CardRim.SELECTED else CardRim.NONE,
        contentPadding = PaddingValues(start = 6.dp, top = 4.dp, end = 8.dp, bottom = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(48.dp, flat = WELL_DARK) { MarketArt(row.art, 40.dp) }
            Column(Modifier.weight(1f)) {
                PkwText(row.name, PkwTokens.Type.body, color = c.textOnParch)
                PkwText(row.where, PkwTokens.Type.small, color = c.textOnParch2)
            }
            if (row.observedLabel != null) PkwText(row.observedLabel, PkwTokens.Type.small, color = c.textOnParch2)
            else if (tag != null) Tag(tag.first, tag.second) else BusyDots()
        }
    }
}

/** The 72 dp detail card: 56 dp art in a dark well, PS 12 name, the trips line and the recent-sales line. */
@Composable private fun DetailCard(d: OwnedDetailUi) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 72.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(64.dp, flat = WELL_DARK) { MarketArt(d.art, 56.dp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(d.name.uppercase(Locale.US), PkwTokens.Type.label, color = c.textOnParch)
                PkwText(d.line, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                d.recentSales?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2) }
            }
        }
    }
}

/** "Link a wallet to see deeds and vehicles" + blue WALLET (→ Profile › WALLET). */
@Composable private fun LinkWalletRow(on: OwnedActions) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 56.dp), rim = CardRim.INFO, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText("Link a wallet to see deeds and vehicles", PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch, maxLines = 2)
            GoButton(on.onLinkWallet, "Open Profile, Wallet, to link a wallet", Modifier.size(96.dp, 48.dp), label = "WALLET")
        }
    }
}

/** The error row (SPEC: last good + "Updated n min ago" + CHECK): never a blank tab. Shared by the round-2 tabs. */
@Composable internal fun ErrorCheckRow(line: String, onCheck: () -> Unit, sub: String = "Couldn't reach the Market") {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth(), rim = CardRim.NOTE, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                PkwText(line, PkwTokens.Type.body, color = c.textOnParch)
                PkwText(sub, PkwTokens.Type.small, color = c.textOnParch2)
            }
            SecondaryButton("CHECK", onCheck, Modifier.width(104.dp), contentDescription = "Check again")
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Market › OWNED (market-owned.png)", widthDp = 412, heightDp = 811)
@Composable private fun OwnedV2Preview() = MarketR2PreviewHost(CraftR2Samples.marketR2(MarketTab.OWNED))

@Preview(name = "Market › OWNED, outside-only deed (OPEN ↗)", widthDp = 412, heightDp = 811)
@Composable private fun OwnedOutsidePreview() = MarketR2PreviewHost(CraftR2Samples.marketR2(MarketTab.OWNED).let { r ->
    r.copy(owned = CraftR2Samples.ownedOutside) })

@Preview(name = "Market › OWNED, no wallet linked", widthDp = 412, heightDp = 811)
@Composable private fun OwnedNoWalletPreview() = MarketR2PreviewHost(CraftR2Samples.marketR2(MarketTab.OWNED).let { r ->
    r.copy(owned = CraftR2Samples.owned.copy(walletLinked = false, wallet = emptyList(), selected = null)) })

@Preview(name = "Market › OWNED, listing (busy) then ON SALE", widthDp = 412, heightDp = 811)
@Composable private fun OwnedBusyPreview() = MarketR2PreviewHost(CraftR2Samples.marketR2(MarketTab.OWNED).let { r ->
    r.copy(owned = CraftR2Samples.owned.copy(wallet = CraftR2Samples.owned.wallet.mapIndexed { i, w ->
        when (i) { 1 -> w.copy(state = OwnedState.LISTING); 3 -> w.copy(state = OwnedState.ON_SALE); else -> w } })) })

@Preview(name = "Market › OWNED, loading", widthDp = 412, heightDp = 811)
@Composable private fun OwnedLoadingPreview() = MarketR2PreviewHost(CraftR2Samples.marketR2(MarketTab.OWNED).let { r ->
    r.copy(owned = CraftR2Samples.owned.copy(load = CraftHydration.Loading)) })

@Preview(name = "Market › OWNED, error (last good + CHECK)", widthDp = 412, heightDp = 811)
@Composable private fun OwnedErrorPreview() = MarketR2PreviewHost(CraftR2Samples.marketR2(MarketTab.OWNED).let { r ->
    r.copy(owned = CraftR2Samples.owned.copy(load = CraftHydration.Error("The Market can't reach the server."), updatedAgo = "3 min ago")) })

@Preview(name = "Market › OWNED, empty", widthDp = 412, heightDp = 811)
@Composable private fun OwnedEmptyV2Preview() = MarketR2PreviewHost(CraftR2Samples.marketR2(MarketTab.OWNED).let { r ->
    r.copy(owned = OwnedUi(emptyList(), 0, emptyList(), null, null, null, walletLinked = true, emptyGo = FeatureId("island.solana.workshop"))) })
