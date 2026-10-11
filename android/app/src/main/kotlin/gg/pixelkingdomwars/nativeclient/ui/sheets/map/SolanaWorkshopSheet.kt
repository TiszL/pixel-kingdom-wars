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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: a licensed workshop on Solana Island (design/final/map/SPEC.md §4, §4.2, §4.3; solana-licensed.png,
 * solana-draw.png). Owner decision 2026-10-02: Solana licences are a DRAW, not an auction; nothing here bids, raises,
 * outbids or withdraws, and there is no BidStepper. The sheet draws the five licence states (NONE: no draw on this server
 * yet, OPEN: entries open, DRAWN, MINE, OCCUPIED), the `draw_steps` strip, the entries / your-entry cards, the holder of
 * an occupied licence, the earnings row, the blue door to the Public Workshop, and the ENTER DRAW / ENTERED / CLAIM /
 * locked primary. A paid entry raises `drawEntrySealUi`; a free entry (no price) enters directly.
 *
 * Money rule: the entry price, the entries count and the earnings figures are strings from the data lane; nothing is
 * computed here.
 */

/** Everything the workshop sheet draws (SPEC §4.3 `SolanaWorkshopUi`, plus the added fields at the end). */
@Immutable data class SolanaWorkshopUi(
    /** The workshop number. */
    val no: Int,
    /** The licence state; null while loading (reads like NONE but with "…"). A server with no draw passes NONE. */
    val state: LicenceState?,
    /** OPEN: time until the draw ("2d 4h"). */
    val closesIn: String? = null,
    /** OPEN: entries for this workshop ("42"; "…" unknown). */
    val entries: String = UNKNOWN,
    /** OPEN: whether you entered (null = unknown). */
    val yourEntry: Boolean? = null,
    /** OCCUPIED: the holder (face + kingdom name). */
    val holder: KingdomRefUi? = null,
    /** MINE / OCCUPIED: the term left ("5d 20h"). */
    val term: String? = null,
    /** The entry price; null = a free entry (no pill; the tap enters directly). Undecided in the record (SPEC §4.3). */
    val entryPrice: PriceUi? = null,
    /** ENTER DRAW's money stage. */
    val entryMoney: MoneyStage = MoneyStage.READY,
    /** "Licence holders earn 70% of each try" (record numbers, from constants). */
    val earnLine: String = "",
    /** "Every crafting try here costs 0.05 SOL" / "Price and term are set by the server". */
    val earnSub: String = "",
    /** MINE: the claim block (same pattern as the Seeker mine sheet). */
    val claim: SpotClaimUi? = null,
    /** DRAWN: "Drawn · you were not picked". */
    val drawResult: String? = null,
    /** The sprite look. */
    val look: SpotLook = SpotLook.AVAILABLE,
    /** Fixture data: stone TEST DATA; ENTRIES OPEN is never drawn live. */
    val testData: Boolean = false,
    val failure: MoneyFailureUi? = null,
)

/** Workshop sheet callbacks (SPEC §4.3). */
@Immutable data class SolanaWorkshopActions(
    /** ENTER DRAW: a paid entry raises the Seal (`drawEntrySealUi`); a free one enters with a success toast. */
    val onEnterDraw: (Int) -> Unit = {},
    /** The blue PUBLIC workshop door: select the Public Workshop (280 ms camera). */
    val onPublicWorkshop: () -> Unit = {},
    val onClaim: () -> Unit = {},
    /** A SHORT entry pill: Need-more ("SOL comes from your wallet" + Profile › WALLET). */
    val onNeedMore: () -> Unit = {},
    /** A locked / entered primary's tap: its reason (toast). */
    val onExplain: (String) -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The licensed-workshop sheet (SPEC §4.2, §4.3).
 *
 * Pointer rule: a HALF sheet with no scrim (the island stays pannable above it); only the painted frame and its buttons
 * take touches.
 */
@Composable fun SolanaWorkshopSheet(ui: SolanaWorkshopUi, on: SolanaWorkshopActions, modifier: Modifier = Modifier) {
    val action = licenceAction(ui.state, ui.yourEntry, ui.closesIn, ui.claim != null && ui.claim.nothingLine == null)
    MapSheetFrame("WORKSHOP ${ui.no}", siteArt(IslandKind.SOLANA, ui.look), on.onClose, modifier,
        footer = { WorkshopFooter(ui, action, on) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ArtWell(72.dp, MapColors.seekerWell) { MapIcon(siteArt(IslandKind.SOLANA, ui.look), 64.dp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    val head = licenceHeadTag(ui.state, ui.testData)
                    Tag(if (ui.state == null) UNKNOWN else head.text, head.verb)
                    when (ui.state) {
                        LicenceState.OPEN -> Tag(ui.closesIn ?: UNKNOWN, Verb.STONE)
                        LicenceState.MINE, LicenceState.OCCUPIED -> ui.term?.let { Tag(it, Verb.STONE) }
                        else -> Unit
                    }
                    if (ui.testData) Tag("TEST DATA", Verb.STONE)
                }
                when (ui.state) {
                    null -> ParchLine(UNKNOWN)
                    LicenceState.NONE -> ParchLine("Licences here are drawn, not auctioned.")
                    LicenceState.OPEN -> ParchLine("Enter the draw for this licence. Picked at random, no bidding.")
                    LicenceState.DRAWN -> ParchLine(ui.drawResult ?: "Drawn · results are being shown")
                    LicenceState.MINE -> ParchLine("You hold this licence for the term.")
                    LicenceState.OCCUPIED -> {
                        ParchLine("Held by another kingdom this term.")
                        ui.holder?.let { KingdomRef(it) }
                    }
                }
            }
        }
        MapSectionHeader(if (ui.state == null || ui.state == LicenceState.NONE) "HOW A LICENCE WORKS" else "LICENCE DRAW")
        LicenceSteps(litLicenceStep(ui.state))
        if (ui.state == LicenceState.OPEN) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatCard("ui:queue-status", "ENTRIES", ui.entries, Modifier.weight(1f))
                StatCard(siteArt(IslandKind.SOLANA, SpotLook.AVAILABLE), "YOUR ENTRY",
                    when (ui.yourEntry) { true -> "in"; false -> "none yet"; null -> UNKNOWN }, Modifier.weight(1f))
            }
        }
        if (ui.state == LicenceState.MINE) ui.claim?.let { claim ->
            MapSectionHeader("READY TO CLAIM")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                claim.tiles.take(4).forEach { t -> StatCard(t.icon, "", t.amount, Modifier.weight(1f)) }
            }
            ParchLine(if (claim.estimate) "Estimated share · not yet yours" else claim.line, secondary = true)
        }
        if (ui.earnLine.isNotBlank()) MapRow(tint = PkwTokens.Colors.selectedTint) {
            PkwIcon("sol", 24.dp)
            RowText(ui.earnLine, ui.earnSub.ifBlank { null })
        }
    }
}

/** The `draw_steps` strip (SPEC §4): OPEN › DRAWN › MINE › OCCUPIED on 30 dp chips; the current one lit green, all quiet
 *  with no draw (the strip is then the explainer). Paint only; read as one sentence. */
@Composable private fun LicenceSteps(lit: LicenceState?) {
    val said = "Licence steps: open, drawn, mine, occupied." + (lit?.let { " Now: ${it.name.lowercase()}." } ?: " No draw yet.")
    Row(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = said }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        LICENCE_STEPS.forEachIndexed { i, step ->
            val on = step == lit
            Box(Modifier.weight(1f).heightIn(min = 30.dp).border(2.dp, if (on) PkwTokens.Colors.ink else PkwTokens.Colors.creamLo)
                .background(if (on) PkwTokens.Colors.green.face else PkwTokens.Colors.cream), contentAlignment = Alignment.Center) {
                PkwText(step.name, PkwTokens.Type.small, color = if (on) PkwTokens.Colors.label else PkwTokens.Colors.textOnParch2,
                    outline = if (on) 1.dp else 0.dp)
            }
            if (i < LICENCE_STEPS.lastIndex) PkwText("›", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
        }
    }
}

/** The command row (SPEC §4.2 / §4.3): blue "PUBLIC workshop" 120 × 60, then the primary for the licence action. */
@Composable private fun WorkshopFooter(ui: SolanaWorkshopUi, action: LicenceAction, on: SolanaWorkshopActions) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        BlueDoorButton("PUBLIC", "workshop", "Go to the Public Workshop", on.onPublicWorkshop,
            Modifier.padding(top = if (action.primary == LicencePrimary.ENTER && ui.entryPrice != null) 20.dp else 0.dp))
        val m = Modifier.weight(1f)
        when (action.primary) {
            LicencePrimary.LOCKED -> PrimaryButton("ENTER DRAW", { on.onExplain(action.reason ?: "") }, m, state = CommandState.LOCKED, reason = action.reason)
            LicencePrimary.ENTERED -> PrimaryButton("ENTERED", { on.onExplain(action.reason ?: "") }, m, verb = Verb.STONE,
                state = CommandState.DISABLED, reason = action.reason)
            LicencePrimary.ENTER -> {
                val price = ui.entryPrice
                val short = price?.status == PriceStatus.SHORT
                when {
                    ui.entryMoney != MoneyStage.READY -> MoneyButton(ui.entryMoney, "ENTER DRAW", { on.onEnterDraw(ui.no) }, m)
                    else -> PrimaryButton("ENTER DRAW", { if (short) on.onNeedMore() else on.onEnterDraw(ui.no) }, m,
                        sub = "drawn in ${ui.closesIn ?: UNKNOWN}", state = if (short) CommandState.SHORT else CommandState.ENABLED,
                        price = price, onPrice = if (short) on.onNeedMore else null)
                }
            }
            LicencePrimary.CLAIM -> {
                val stage = ui.claim?.money ?: MoneyStage.READY
                if (stage == MoneyStage.READY) PrimaryButton("CLAIM", on.onClaim, m, sub = ui.claim?.sub,
                    badge = BadgeUi("!", BadgeTone.READY, "Earnings ready to claim"))
                else MoneyButton(stage, "CLAIM", on.onClaim, m)
            }
            LicencePrimary.NONE -> Box(m)
        }
    }
    ui.failure?.let { f ->
        moneyNote(true, f.action, f.authoritative, f.serverReason)?.let { line ->
            PkwText(line, PkwTokens.Type.small, Modifier.fillMaxWidth(), textAlign = TextAlign.Center, maxLines = 2,
                color = if (f.authoritative) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch2)
        }
    }
}

/** A blue two-line door (SPEC §4.2 "PUBLIC workshop", §6 "GO TO LODGE"): 120 × 60, PS label + VT sub. Blue = go to a place. */
@Composable internal fun BlueDoorButton(label: String, sub: String?, contentDescription: String, onClick: () -> Unit,
    modifier: Modifier = Modifier, width: Dp = 120.dp) {
    ChunkyBox(PkwTokens.Colors.blue, onClick, contentDescription, modifier.size(width, 60.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
            if (sub != null) PkwText(sub, PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

// ---- Previews ----

private fun sol(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SOL, amount, status)

@Composable private fun Host(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

private val base = SolanaWorkshopUi(3, LicenceState.NONE, earnLine = "Licence holders earn 70% of each try",
    earnSub = "Every crafting try here costs 0.05 SOL")

@Preview(name = "NONE: no draw yet (solana-licensed)", widthDp = 412, heightDp = 915)
@Composable private fun WorkshopNonePreview() { Host { SolanaWorkshopSheet(base, SolanaWorkshopActions()) } }

@Preview(name = "OPEN: entries open, paid entry (solana-draw)", widthDp = 412, heightDp = 915)
@Composable private fun WorkshopOpenPreview() {
    Host {
        SolanaWorkshopSheet(base.copy(state = LicenceState.OPEN, closesIn = "2d 4h", entries = "42", yourEntry = false,
            entryPrice = sol("0.10 / entry"), earnSub = "Price and term are set by the server"), SolanaWorkshopActions())
    }
}

@Preview(name = "OPEN: entered; uncertain entry result", widthDp = 412, heightDp = 915)
@Composable private fun WorkshopEnteredPreview() {
    Host {
        SolanaWorkshopSheet(base.copy(state = LicenceState.OPEN, closesIn = "2d 4h", entries = "43", yourEntry = true,
            failure = MoneyFailureUi("draw entry", authoritative = false)), SolanaWorkshopActions())
    }
}

@Preview(name = "DRAWN / MINE / OCCUPIED", widthDp = 412, heightDp = 1400)
@Composable private fun WorkshopResultPreview() {
    Host {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SolanaWorkshopSheet(base.copy(state = LicenceState.DRAWN, drawResult = "Drawn · you were not picked"), SolanaWorkshopActions())
            SolanaWorkshopSheet(base.copy(state = LicenceState.MINE, term = "6d 2h", look = SpotLook.ACTIVE,
                claim = SpotClaimUi(listOf(ClaimTileUi("sol", "0.35", "0.35 SOL")), "Your share of tries since your last claim.",
                    sub = "licence earnings")), SolanaWorkshopActions())
            SolanaWorkshopSheet(base.copy(state = LicenceState.OCCUPIED, term = "3d 1h", look = SpotLook.OCCUPIED,
                holder = KingdomRefUi("Milisdor", "ui_portrait_keep_t2"), testData = true), SolanaWorkshopActions())
        }
    }
}
