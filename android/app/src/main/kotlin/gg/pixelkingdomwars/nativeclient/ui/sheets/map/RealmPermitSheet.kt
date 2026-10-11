package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState

/*
 * Design component: BUY REALM PERMIT (design/final/map/SPEC.md Round 2 §A + critic fixes; seeker-permit.png and its Seal
 * frame seeker-permit-seal.png). Registry row 83, `Destination.RealmPermit(spot)`. A half sheet over the Seeker island
 * scene: header (`seeker-site-active` 32, "REALM PERMIT", stone History, red close), the explainer well with the chosen
 * realm's crest, the seller line (kingdom face + "Kaly's spot 7 sells it. Kaly gets a share."), CHOOSE A REALM (4 × 2
 * RealmTiles, 56 tall; selected = gold 3 dp inner rim on `#FFF3C8`; home and not-sold dimmed), the price row (SOL
 * CostPill, "+7 DAYS" pill, quota line) and the gold BUY PERMIT ("Frostveil waters · 7 days") that opens the Seal.
 *
 * The Seal ([PermitSeal]) is the fine-print Seal: SOL → the crest well + "7 DAYS", the until line, "Bought from …", the
 * fine print (realm's cut + the at-most total with the network cost; "Paid from your wallet. You sign once.") and BUY
 * arming over 450 ms only once the quote is known. The Lodge path buys the same permit (critic fix); the server picks the
 * cheapest open spot that sells that realm and the Seal names it.
 *
 * Money rule: every amount is the data lane's string; the price is a [PriceUi] (SOL today; the currency is the server's).
 */

/** One RealmTile (§A `PermitRealmUi`). */
@Immutable data class PermitRealmUi(
    /** Realm id ("frostveil"). */
    val id: String,
    /** "Frostveil"; the eighth realm reads "Solana Reach" in full on two lines (critic fix). */
    val name: String,
    /** The realm's crest art (`pe_realm_crest_<id>` once authored); null draws the realm's initial (no crest set exists). */
    val crest: String?,
    val state: PermitRealmState,
    /** COVERED: the date the current permit runs to ("9 OCT"). */
    val coveredUntil: String?,
    /** The success receipt just landed for this realm: moss "OPEN" tag + a 1.06 crest pulse. */
    val justBought: Boolean = false,
)

/** The permit Seal's content (§A `PermitSealUi`). */
@Immutable data class PermitSealUi(
    /** "Frostveil". */
    val realmName: String,
    /** The quoted price; CHECKING keeps BUY from arming ("Checking the price…"). */
    val price: PriceUi,
    /** "Sat 10 Oct". */
    val until: String,
    /** The at-most total with the network cost ("0.0121 SOL"). */
    val maxTotal: String,
    /** The money sequence on BUY. */
    val stage: MoneyStage,
    /** The realm's crest art for the get well; null draws the initial. */
    val crest: String? = null,
    /** "7 DAYS". */
    val term: String = "7 DAYS",
    /** "Bought from Kaly's spot 7." (the server-picked spot on the Lodge path). */
    val sellerLine: String? = null,
    /** Wall-clock ms the quote arrived (the primary arms from here). */
    val armedAtMs: Long = 0L,
)

/** Everything the permit sheet draws (§A `RealmPermitUi`; fields after `load` were added with defaults). */
@Immutable data class RealmPermitUi(
    /** The selling spot's number. */
    val spotNo: Int,
    /** The seller kingdom's name ("Kaly"); never a wallet string. */
    val sellerName: String,
    /** The seller kingdom's face art (1 device px per art px); null draws none. */
    val sellerFace: String?,
    /** Eight tiles, the home realm included (dimmed). */
    val realms: List<PermitRealmUi>,
    /** The selected realm id; null until chosen (a Lodge hand-off pre-selects it). */
    val selected: String?,
    /** The price pill (SOL today; currency from the server). */
    val price: PriceUi,
    /** "7 days" (`permitDurationSec` through fmtDur). */
    val coverage: String,
    /** "6 of 10 left here today" (`paidContractsPerSpotDayMax`); null = unknown ("…"). */
    val quotaLine: String?,
    /** BUY PERMIT: caption, sub ("Frostveil waters · 7 days"), state, reason, price. The tap routes by [commandRoute]. */
    val primary: CommandUi,
    /** The Seal being shown; null when none. */
    val seal: PermitSealUi?,
    /** A saved request that needs a check (uncertain outcome): the row replaces nothing, it sits above the footer. */
    val recovery: RecoveryUi?,
    /** The read state: Loading keeps the last good tiles, price and quota read "…". */
    val load: LoadState,
    /** The spot has no permits left today: BUY off "Try another spot" + blue FIND A SPOT. */
    val soldOut: Boolean = false,
    /** The "+7 DAYS" timer pill text. */
    val coveragePill: String = "+7 DAYS",
    /** An authoritative refusal line ("No purchase was made."); only when `prepareRefusal` + confirmed absent. */
    val refusal: String? = null,
)

/** Permit sheet callbacks (§A; the ones after `onClose` were added for the SHORT / reason / empty doors). */
@Immutable data class RealmPermitActions(
    val onRealm: (String) -> Unit = {},
    /** BUY PERMIT (ENABLED or a CHECKING price: navigation into the Seal). */
    val onBuy: () -> Unit = {},
    val onSealBack: () -> Unit = {},
    val onSealConfirm: () -> Unit = {},
    /** CHECK SAVED OUTCOME. */
    val onCheckSaved: (String) -> Unit = {},
    /** History: permit receipts. */
    val onHistory: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** SHORT: Need-more ("Need 0.03 more SOL in your wallet" + GO to Profile › WALLET). */
    val onNeedMore: () -> Unit = {},
    /** A dimmed tile or a refused primary: show this line (toast), never silent. */
    val onExplain: (String) -> Unit = {},
    /** Sold out: FIND A SPOT (the island scene, filter ALL). */
    val onFindSpot: () -> Unit = {},
)

/**
 * The REALM PERMIT half sheet with its Seal.
 *
 * Pointer rule: a HALF sheet with no scrim (the island stays pannable above it); only the painted frame, the tiles, the
 * pills and the buttons take touches. [PermitSeal] carries its own 55 % scrim only while a seal is shown; mount it in the
 * OverlayHost layer ([RealmPermitSeal]), not inside this sheet's bounds.
 */
@Composable fun RealmPermitSheet(ui: RealmPermitUi, on: RealmPermitActions, modifier: Modifier = Modifier) {
    val selected = ui.realms.firstOrNull { it.id == ui.selected }
    MapSheetFrame("REALM PERMIT", "site:seeker-active", on.onClose, modifier, history = true, onHistory = on.onHistory,
        footer = { PermitFooter(ui, on) }) {
        Explainer(ui, selected)
        MapSectionHeader("CHOOSE A REALM")
        ui.realms.chunked(4).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { realm -> RealmTile(realm, realm.id == ui.selected, Modifier.weight(1f)) { tapRealm(realm, on) } }
                repeat(4 - row.size) { Box(Modifier.weight(1f)) }
            }
        }
        PriceRow(ui, on)
        ui.recovery?.let { RecoveryRow(it, on.onCheckSaved) }
    }
}

/**
 * The OverlayHost mount of the permit Seal (keep composing it with null through the exit).
 *
 * Pointer rule: full-screen only while the seal is shown or animating out ([FinePrintSeal]'s own 55 % scrim, tap = BACK);
 * with null nothing is composed, so the scene below keeps every touch.
 */
@Composable fun RealmPermitSeal(ui: RealmPermitUi, on: RealmPermitActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    FinePrintSeal(ui.seal?.let { permitSealContent(it, ui.sellerName, ui.spotNo) }, on.onSealConfirm, on.onSealBack, modifier, clock, onExitFinished)
}

/** The permit Seal's fine-print content (§A + critic fixes). Pure data. */
fun permitSealContent(seal: PermitSealUi, sellerName: String, spotNo: Int): FinePrintSealUi = FinePrintSealUi(
    title = "BUY ${seal.realmName.uppercase()} PERMIT",
    pay = seal.price,
    gets = SealGetUi(seal.crest, seal.term),
    lines = listOf("Your expeditions may sail into ${seal.realmName} until ${seal.until}."),
    secondary = seal.sellerLine ?: "Bought from ${bidderName(sellerName)}'s spot $spotNo.",
    finePrint = listOf("The price includes the realm's cut. With the network cost you approve at most ${seal.maxTotal.ifBlank { UNKNOWN }}.",
        "Paid from your wallet. You sign once."),
    confirmLabel = "BUY",
    armedAtMs = seal.armedAtMs,
    stage = seal.stage,
    canArm = permitSealCanArm(seal.price, seal.stage),
    waitLine = permitSealWaitLine(seal.price),
)

private fun tapRealm(realm: PermitRealmUi, on: RealmPermitActions) = when (permitTileTap(realm.state)) {
    PermitTileTap.SELECT -> on.onRealm(realm.id)
    PermitTileTap.NOT_SOLD -> on.onExplain(PERMIT_NOT_SOLD_LINE)
    PermitTileTap.HOME -> on.onExplain(PERMIT_HOME_LINE)
}

/** The explainer: a 64 well with the chosen crest at 48, VT 20 purpose, the seller's face + VT 18 seller line. */
@Composable private fun Explainer(ui: RealmPermitUi, selected: PermitRealmUi?) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ArtWell(64.dp, MapColors.seekerWell) { Crest(selected, 48.dp) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ParchLine("Lets your expeditions sail into one more realm for ${ui.coverage.ifBlank { UNKNOWN }}.", maxLines = 3)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ui.sellerFace?.let { PkwIcon(it, 24.dp) }
                val seller = bidderName(ui.sellerName)
                ParchLine("$seller's spot ${ui.spotNo} sells it. $seller gets a share.", secondary = true, maxLines = 2)
            }
        }
    }
}

/** A crest at [size], or the realm initial when no crest art exists; the selected realm pulses 1.06 on its receipt. */
@Composable private fun Crest(realm: PermitRealmUi?, size: androidx.compose.ui.unit.Dp) {
    val reduced = LocalReducedMotion.current
    val pulse by animateFloatAsState(if (realm?.justBought == true && !reduced) 1.06f else 1f,
        tween(PkwTokens.Motion.SELECT, easing = PkwTokens.Motion.Pop), label = "crestPulse")
    val crest = realm?.crest
    Box(Modifier.graphicsLayer { scaleX = pulse; scaleY = pulse }, contentAlignment = Alignment.Center) {
        when {
            crest != null -> R2MapIcon(crest, size)
            realm != null -> PkwText(realm.name.take(1).uppercase(), PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            else -> PkwText(UNKNOWN, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi)
        }
    }
}

/** One RealmTile (56 tall, ink S rim, cream; crest 24 + VT 18 name; selected = 3 dp gold inner rim on `#FFF3C8`, rim
 *  90 ms; dimmed = 45 % + "Home"). A tap selects or explains; each tile is a ≥ 48 dp target. */
@Composable private fun RealmTile(realm: PermitRealmUi, chosen: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val reduced = LocalReducedMotion.current
    val dim = permitTileDimmed(realm.state)
    val rim by animateColorAsState(if (chosen) PkwTokens.Colors.gold.face else PkwTokens.Colors.cream,
        tween(if (reduced) 0 else PkwTokens.Motion.RELEASE), label = "tileRim")
    val face = if (chosen) PkwTokens.Colors.selectedTint else PkwTokens.Colors.cream
    val tag = permitTileTag(realm.state, realm.coveredUntil, realm.justBought)
    val label = if (realm.state == PermitRealmState.HOME) "Home" else realm.name
    val said = listOfNotNull(realm.name, "home realm".takeIf { realm.state == PermitRealmState.HOME },
        PERMIT_NOT_SOLD_LINE.takeIf { realm.state == PermitRealmState.NOT_SOLD }, tag?.text).joinToString(", ")
    Box(modifier) {
        Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).graphicsLayer { alpha = if (dim) 0.45f else 1f }.sceneInputRegion()
            .clearAndSetSemantics { contentDescription = said; role = Role.Button; this.selected = chosen; this.onClick(label = null, action = { onClick(); true }) }
            .clickable(role = Role.Button, onClick = onClick)
            .drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
                insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                    drawRect(face)
                    val r = 3.dp.toPx()
                    drawRect(rim, Offset(i, i), Size(w - 2 * i, r)); drawRect(rim, Offset(i, h - i - r), Size(w - 2 * i, r))
                    drawRect(rim, Offset(i, i), Size(r, h - 2 * i)); drawRect(rim, Offset(w - i - r, i), Size(r, h - 2 * i))
                }
            }.padding(horizontal = 4.dp, vertical = 4.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { Crest(realm, 24.dp) }
            PkwText(label, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
        }
        tag?.let { RowTag(it, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-8).dp)) }
    }
}

/** The price row: SOL CostPill, the "+7 DAYS" timer pill, the quota line on the right ("…" while loading). */
@Composable private fun PriceRow(ui: RealmPermitUi, on: RealmPermitActions) {
    val loading = ui.load == LoadState.Loading
    val price = if (loading) ui.price.copy(status = PriceStatus.CHECKING) else ui.price
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PriceChip(price, onClick = if (price.status == PriceStatus.SHORT) on.onNeedMore else null)
        PriceChip(PriceUi(Currency.ITEM, ui.coveragePill, PriceStatus.OK, icon = "timer", description = "Adds ${ui.coverage}"))
        PkwText(if (loading) UNKNOWN else permitQuotaLine(ui.quotaLine, ui.soldOut), PkwTokens.Type.small, Modifier.weight(1f),
            color = if (ui.soldOut) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch2, maxLines = 2)
    }
}

/** BUY PERMIT, routed by [commandRoute] (design correction 7): ENABLED / CHECKING open the Seal, SHORT opens Need-more,
 *  DISABLED / LOCKED explain; sold out turns it off with "Try another spot" and adds the blue FIND A SPOT. */
@Composable private fun PermitFooter(ui: RealmPermitUi, on: RealmPermitActions) {
    val p = ui.primary
    if (ui.soldOut) {
        PrimaryButton(p.caption, { on.onExplain("Try another spot") }, Modifier.fillMaxWidth(), state = CommandState.DISABLED, reason = "Try another spot")
        SecondaryButton("FIND A SPOT", on.onFindSpot, Modifier.fillMaxWidth(), verb = Verb.BLUE, icon = "ui:seeker-navigation",
            contentDescription = "Find another spot that sells permits")
    } else {
        val state = commandDrawState(p)
        PrimaryButton(p.caption, {
            when (commandRoute(p)) {
                CommandRoute.OPEN -> on.onBuy()
                CommandRoute.NEED_MORE -> on.onNeedMore()
                CommandRoute.EXPLAIN -> on.onExplain(p.reason ?: p.caption)
                CommandRoute.IGNORE -> Unit
            }
        }, Modifier.fillMaxWidth(), sub = p.sub, state = state, reason = p.reason ?: if (p.price?.status == PriceStatus.UNAVAILABLE)
            "Permit terms aren't available right now" else null)
    }
    ui.refusal?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.shortText, textAlign = TextAlign.Center, maxLines = 2) }
}

// ---- Previews (seeker-permit.png / seeker-permit-seal.png numbers; every number is a placeholder) ----

private val previewRealms = listOf(
    PermitRealmUi("crownlands", "Crownlands", null, PermitRealmState.HOME, null),
    PermitRealmUi("frostveil", "Frostveil", null, PermitRealmState.OPEN, null),
    PermitRealmUi("elderwood", "Elderwood", null, PermitRealmState.OPEN, null),
    PermitRealmUi("sunscar", "Sunscar", null, PermitRealmState.COVERED, "9 OCT"),
    PermitRealmUi("stormcairn", "Stormcairn", null, PermitRealmState.OPEN, null),
    PermitRealmUi("thornwake", "Thornwake", null, PermitRealmState.OPEN, null),
    PermitRealmUi("cinderfall", "Cinderfall", null, PermitRealmState.NOT_SOLD, null),
    PermitRealmUi("seeker-reach", "Solana Reach", null, PermitRealmState.OPEN, null),
)

private fun sol(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SOL, amount, status)

private val previewBuy = CommandUi(FeatureId("island.seeker.permit"), "site:seeker-active", "BUY PERMIT", sol("0.01"), true, CommandState.ENABLED,
    null, null, sub = "Frostveil waters · 7 days")

private val previewPermit = RealmPermitUi(7, "Kaly", "ui_portrait_keep_t3", previewRealms, "frostveil", sol("0.01"), "7 days",
    "6 of 10 left here today", previewBuy, null, null, LoadState.Ready)

@Composable private fun PermitHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Permit (seeker-permit)", widthDp = 412, heightDp = 915)
@Composable private fun PermitPreview() { PermitHost { RealmPermitSheet(previewPermit, RealmPermitActions()) } }

@Preview(name = "Permit + Seal armed (seeker-permit-seal)", widthDp = 412, heightDp = 915)
@Composable private fun PermitSealPreview() {
    val ui = previewPermit.copy(seal = PermitSealUi("Frostveil", sol("0.01"), "Sat 10 Oct", "0.0121 SOL", MoneyStage.READY))
    Box(Modifier.fillMaxSize()) {
        PermitHost { RealmPermitSheet(ui, RealmPermitActions()) }
        RealmPermitSeal(ui, RealmPermitActions())
    }
}

@Preview(name = "Permit Seal: price CHECKING (never arms)", widthDp = 412, heightDp = 915)
@Composable private fun PermitSealCheckingPreview() {
    val ui = previewPermit.copy(price = sol(null, PriceStatus.CHECKING), primary = previewBuy.copy(price = sol(null, PriceStatus.CHECKING)),
        seal = PermitSealUi("Frostveil", sol(null, PriceStatus.CHECKING), "Sat 10 Oct", UNKNOWN, MoneyStage.READY))
    Box(Modifier.fillMaxSize()) { PermitHost { RealmPermitSheet(ui, RealmPermitActions()) }; RealmPermitSeal(ui, RealmPermitActions()) }
}

@Preview(name = "Permit Seal: sending", widthDp = 412, heightDp = 915)
@Composable private fun PermitSealSendingPreview() {
    val ui = previewPermit.copy(seal = PermitSealUi("Frostveil", sol("0.01"), "Sat 10 Oct", "0.0121 SOL", MoneyStage.SENDING))
    Box(Modifier.fillMaxSize()) { PermitHost { RealmPermitSheet(ui, RealmPermitActions()) }; RealmPermitSeal(ui, RealmPermitActions()) }
}

@Preview(name = "Permit: SHORT (red pill → Need-more)", widthDp = 412, heightDp = 915)
@Composable private fun PermitShortPreview() {
    PermitHost {
        RealmPermitSheet(previewPermit.copy(price = sol("0.01", PriceStatus.SHORT), primary = previewBuy.copy(price = sol("0.01", PriceStatus.SHORT))),
            RealmPermitActions())
    }
}

@Preview(name = "Permit: UNAVAILABLE / paused / sold out", widthDp = 412, heightDp = 915)
@Composable private fun PermitOffPreview() {
    PermitHost {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RealmPermitSheet(previewPermit.copy(price = sol(null, PriceStatus.UNAVAILABLE),
                primary = previewBuy.copy(price = sol(null, PriceStatus.UNAVAILABLE))), RealmPermitActions())
            RealmPermitSheet(previewPermit.copy(soldOut = true), RealmPermitActions())
        }
    }
}

@Preview(name = "Permit: paused (LOCKED) + uncertain purchase being checked", widthDp = 412, heightDp = 915)
@Composable private fun PermitPausedPreview() {
    PermitHost {
        RealmPermitSheet(previewPermit.copy(primary = previewBuy.copy(state = CommandState.LOCKED,
            reason = "New purchases are paused. Your saved requests stay in History."),
            recovery = RecoveryUi("permit-1", "Your purchase is being checked", "CHECK SAVED OUTCOME")), RealmPermitActions())
    }
}

@Preview(name = "Permit: loading (last tiles kept, price and quota …) + success tag", widthDp = 412, heightDp = 915)
@Composable private fun PermitLoadingPreview() {
    PermitHost {
        RealmPermitSheet(previewPermit.copy(load = LoadState.Loading,
            realms = previewRealms.map { if (it.id == "frostveil") it.copy(state = PermitRealmState.COVERED, coveredUntil = "10 OCT", justBought = true) else it }),
            RealmPermitActions())
    }
}
