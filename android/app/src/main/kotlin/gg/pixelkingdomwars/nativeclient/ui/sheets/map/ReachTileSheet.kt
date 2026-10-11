package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the Solana Reach Seeker-tile unlock half sheet (design/final/account/SPEC.md §6.2-§6.3,
 * reach-tile.png, reach-seal.png, reach-done.png): the tile thumbnail, "SEEKER TILE 1,204" with the SOLANA REACH and
 * DEVNET PRICE tags, the one-line rule, PRICE vs YOUR SKR cards (green rim when enough; short-pill body + red text when
 * short), the Kingdom Deed requirement row, and the foot: stone INFO + gold UNLOCK TILE (the money sequence after the
 * Seal), or blue GET SKR / GET LAND, or BUY BASE HERE once the tile is yours. Feature off: the sheet says so with no
 * buttons (hidden, not disabled). The Seal is `reachUnlockSealUi`; the done moment is `reachUnlockedCelebration`.
 *
 * Money rule: price, balance and the "Need n more" line are strings from the data lane; "Free" only from a server zero.
 */

/** Everything the Reach tile sheet draws (account SPEC §6.2 `ReachTileUiState`, plus presentation fields). */
@Immutable data class ReachTileUi(
    /** "1,204". */
    val tileLabel: String,
    val allocation: ReachAllocation,
    /** The unlock price (SKR); null while unknown. */
    val price: PriceUi?,
    /** Your SKR; status SHORT when the data lane says it is not enough. */
    val mySkr: PriceUi?,
    /** Null while unknown. */
    val hasDeed: Boolean?,
    val status: ReachStatus,
    /** Devnet: the DEVNET PRICE tag and the test-SKR fine print. */
    val devnet: Boolean,
    /** Short: "Need 18,760 more · Daily test SKR: 1,000 a day". */
    val shortLine: String? = null,
    /** UNLOCK's money stage. */
    val money: MoneyStage = MoneyStage.READY,
    val failure: MoneyFailureUi? = null,
    /** The tile thumbnail art (the realm map around the tile); null draws the select square on the realm's ground. */
    val thumbnail: String? = null,
)

/** Reach tile callbacks (account SPEC §6.2). */
@Immutable data class ReachTileActions(
    /** UNLOCK TILE: raise `reachUnlockSealUi`. */
    val onUnlock: () -> Unit = {},
    val onInfo: () -> Unit = {},
    /** GET SKR (short): the faucet in the resource drawer. */
    val onGetSkr: () -> Unit = {},
    /** GET LAND (no deed): the land gate. */
    val onGetLand: () -> Unit = {},
    /** BUY BASE HERE: the existing deed rail, this tile preselected. */
    val onBuyBase: () -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The Reach Seeker-tile sheet (account SPEC §6.2).
 *
 * Pointer rule: a HALF sheet with no scrim (the realm map stays pannable above it); only the painted frame and its
 * buttons take touches. The unlock Seal carries its own 55 % scrim, only while shown.
 */
@Composable fun ReachTileSheet(ui: ReachTileUi, on: ReachTileActions, modifier: Modifier = Modifier) {
    val short = isShort(ui.price, ui.mySkr)
    val layout = reachLayout(ui.status, ui.hasDeed, short)
    MapSheetFrame("SEEKER TILE ${ui.tileLabel}", "skr", on.onClose, modifier, footer = { ReachFooter(ui, layout, on) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ArtWell(72.dp, PkwTokens.Colors.surface) {
                val thumb = ui.thumbnail
                if (thumb != null) MapIcon(thumb, 68.dp)
                Box(Modifier.size(30.dp).border(3.dp, PkwTokens.Colors.gold.hi).background(PkwTokens.Colors.gold.face.copy(alpha = 0.2f)))
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Tag("SOLANA REACH", Verb.GREEN)
                    if (ui.devnet) Tag("DEVNET PRICE", Verb.STONE)
                }
            }
        }
        if (ui.status == ReachStatus.AVAILABLE) ParchLine("Seeker tiles open with SKR. Unlock this one, then buy the base on it. Nobody else can.")
        layout.line?.let { ParchLine(it, center = ui.status == ReachStatus.OFF) }
        if (layout.cards) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ValueCard("PRICE", ui.price?.let { if (it.status == PriceStatus.SERVER_ZERO) "Free" else priceText(it) } ?: UNKNOWN,
                    Modifier.weight(1f), state = null)
                ValueCard("YOUR SKR", ui.mySkr?.let(::priceText) ?: UNKNOWN, Modifier.weight(1f), state = if (ui.mySkr == null) null else !short)
            }
            DeedRow(ui.hasDeed)
        }
    }
}

/** A value card 84 (PRICE / YOUR SKR): cream; [state] true = green rim (enough), false = short-pill body + red text. */
@Composable private fun ValueCard(label: String, amount: String, modifier: Modifier, state: Boolean?) {
    val rim = when (state) { true -> PkwTokens.Colors.green.face; false -> PkwTokens.Colors.shortText; null -> PkwTokens.Colors.ink }
    val body = if (state == false) PkwTokens.Colors.shortPill else PkwTokens.Colors.cream
    Column(modifier.heightIn(min = 84.dp).background(body).border(if (state == null) 2.dp else 3.dp, rim).padding(8.dp)
        .clearAndSetSemantics { contentDescription = "$label $amount SKR" + if (state == false) ", not enough" else "" }) {
        PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwIcon("skr", 24.dp)
            PkwText(amount, PkwTokens.Type.numeralL, color = if (state == false) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch)
        }
    }
}

/** The requirement row: deed icon, "You hold a Kingdom Deed" + green OK, or the red "Needs a Kingdom Deed" row. */
@Composable private fun DeedRow(hasDeed: Boolean?) {
    MapRow(tint = if (hasDeed == false) MapColors.missBody else PkwTokens.Colors.cream, rim = if (hasDeed == false) PkwTokens.Colors.blood else PkwTokens.Colors.ink) {
        PkwIcon("itm_deed_earth", 36.dp)
        RowText(when (hasDeed) { true -> "You hold a Kingdom Deed"; false -> "Needs a Kingdom Deed"; null -> "Kingdom Deed $UNKNOWN" },
            if (hasDeed == false) "Buy land once, then unlock tiles" else null)
        when (hasDeed) {
            true -> Tag("OK", Verb.GREEN)
            false -> Tag("NO DEED", Verb.RED)
            null -> Unit
        }
    }
}

/** The foot: stone INFO 68 × 60 + the primary for the layout (none when the feature is off). */
@Composable private fun ReachFooter(ui: ReachTileUi, layout: ReachLayout, on: ReachTileActions) {
    if (layout.primary == ReachPrimary.NONE && !layout.info) return
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (layout.info) ChunkyBox(PkwTokens.Colors.stone, on.onInfo, "About Seeker tiles", Modifier.size(68.dp, 60.dp)) { PkwIcon("info", 24.dp) }
        val m = Modifier.weight(1f)
        when (layout.primary) {
            ReachPrimary.UNLOCK -> if (ui.money == MoneyStage.READY) PrimaryButton("UNLOCK TILE", on.onUnlock, m,
                sub = "${ui.price?.let(::priceText) ?: UNKNOWN} SKR from your wallet")
                else MoneyButton(ui.money, "UNLOCK TILE", on.onUnlock, m)
            ReachPrimary.GET_SKR -> PrimaryButton("GET SKR", on.onGetSkr, m, verb = Verb.BLUE, sub = ui.shortLine)
            ReachPrimary.GET_LAND -> PrimaryButton("GET LAND", on.onGetLand, m, verb = Verb.BLUE, icon = "itm_deed_earth")
            ReachPrimary.BUY_BASE -> PrimaryButton("BUY BASE HERE", on.onBuyBase, m, sub = "only you can build here")
            ReachPrimary.NONE -> Box(m)
        }
    }
    ui.failure?.let { f ->
        moneyNote(true, f.action, f.authoritative, f.serverReason)?.let { line ->
            PkwText(line, PkwTokens.Type.small, Modifier.fillMaxWidth(), textAlign = TextAlign.Center, maxLines = 2,
                color = if (f.authoritative) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch2)
        }
    }
}

// ---- Previews ----

private fun skr(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SKR, amount, status)

private val base = ReachTileUi("1,204", ReachAllocation.SEEKER, skr("20,000"), skr("21,240"), true, ReachStatus.AVAILABLE, devnet = true)

@Composable private fun Host(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Available, enough SKR (reach-tile)", widthDp = 412, heightDp = 915)
@Composable private fun ReachPreview() { Host { ReachTileSheet(base, ReachTileActions()) } }

@Preview(name = "Short of SKR; no deed", widthDp = 412, heightDp = 1300)
@Composable private fun ReachShortPreview() {
    Host {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ReachTileSheet(base.copy(mySkr = skr("1,240", PriceStatus.SHORT), shortLine = "Need 18,760 more · Daily test SKR: 1,000 a day"), ReachTileActions())
            ReachTileSheet(base.copy(hasDeed = false), ReachTileActions())
        }
    }
}

@Preview(name = "Held by another / mine / feature off / uncertain unlock", widthDp = 412, heightDp = 1700)
@Composable private fun ReachStatesPreview() {
    Host {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ReachTileSheet(base.copy(status = ReachStatus.UNLOCKED_BY_OTHER), ReachTileActions())
            ReachTileSheet(base.copy(status = ReachStatus.UNLOCKED_BY_ME), ReachTileActions())
            ReachTileSheet(base.copy(status = ReachStatus.OFF), ReachTileActions())
            ReachTileSheet(base.copy(money = MoneyStage.FAILED, failure = MoneyFailureUi("unlock", authoritative = false)), ReachTileActions())
        }
    }
}
