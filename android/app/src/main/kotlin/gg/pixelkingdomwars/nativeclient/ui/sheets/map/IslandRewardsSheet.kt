package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ErrorRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState

/*
 * Design component: ISLAND REWARDS (design/final/map/SPEC.md Round 2 §B + critic fixes; seeker-rewards.png), registry
 * row 84, `Destination.IslandRewards("seeker")`. A TALL sheet over the parked island scene: the living header (the island
 * around your spot, your spot sprite with the gold "7 YOURS" tag, VeilChip "Term ends 5d 20h"), the tabs MATERIALS ·
 * SHARDS · REALM'S CUT (green "!" on a tab with something ready), then per tab: the intro, "SPOT 7 · THIS TERM" tiles
 * (92 tall, icon 32, PS 12 count, VT 18 name; sideways scroll past four), EARLIER TERMS rows, the INTO kingdom row with
 * CHANGE, the footnote; REALM'S CUT lists rounds and pays KEEP to the wallet through the fine-print Seal (every SOL line
 * lives only in that Seal's fine print). Footer: gold CLAIM "no wallet needed" with the green "!" while a row is ready (the
 * frame's CLAIM ALL would be untrue: the owners claim one row per review, owner 2026-10-06).
 *
 * Success motion (tiles fly to the readouts 450 ms `in`, readouts pulse 1.06 and count up 600 ms) is the host's: it sets
 * the readouts' `ResourceChipUi.gain` on the receipt. The realm's-cut Celebration is raised only after the receipt.
 */

/** One reward tile (§B `RewardTileUi`). */
@Immutable data class RewardTileUi(
    /** 64 px art (`craft:inv_crownsteel`) at 32, or a 24 px currency (`shards`). */
    val icon: String,
    /** "12"; "…" unknown; "0" only from the server. */
    val amount: String,
    /** "Crownsteel". */
    val name: String,
    /** An estimate: sub-line "Estimated share · not yet yours"; the tile is not claimable. */
    val estimate: Boolean,
)

/** One EARLIER TERMS row (§B). */
@Immutable data class RewardTermRowUi(
    val id: String,
    /** 32 dp art of what is still yours. */
    val icon: String,
    /** "Spot 7 · 21-28 Sep". */
    val title: String,
    /** "6 Embercore still yours". */
    val sub: String,
    val state: TermState,
    /** CHECKING: the saved claim's key for CHECK SAVED RECEIPT. */
    val recoveryKey: String? = null,
)

/** One REALM'S CUT round row (§B "rows per operating round and spot"). */
@Immutable data class TaxRoundRowUi(
    val id: String,
    /** "Round 41 · Spot 7". */
    val title: String,
    /** "4 permits sold". */
    val sub: String,
    /** The KEEP owed for this round (a PriceUi so unknown reads "…"). */
    val amount: PriceUi,
    val state: TermState,
    val recoveryKey: String? = null,
)

/** The realm's-cut Seal (§B "Seal: KEEP amount → your wallet"; "SET UP ONCE" when a setup is needed first). */
@Immutable data class TaxSealUi(
    /** What arrives (KEEP). */
    val amount: PriceUi,
    /** The first Seal is the one-time wallet setup. */
    val setupOnce: Boolean,
    /** At most n SOL for the setup; null = unknown (the line says so without a number). */
    val setupMaxSol: String?,
    /** At most n SOL network cost. */
    val networkMaxSol: String?,
    val stage: MoneyStage,
    /** Wall-clock ms the quote was ready (the primary arms from here). */
    val armedAtMs: Long,
)

/** Everything ISLAND REWARDS draws (§B `IslandRewardsUi`, critic-fix tab enum; fields after `paused` were added). */
@Immutable data class IslandRewardsUi(
    /** "seeker". */
    val island: String,
    val tab: RewardsTab,
    /** Build with [islandRewardsTabs] (ready badges, locked tabs). */
    val tabs: List<TabUi>,
    /** The term left for the header chip ("5d 20h"); null hides the chip. */
    val termLine: String?,
    /** The selected tab's THIS TERM tiles (MATERIALS / SHARDS). */
    val current: List<RewardTileUi>,
    /** EARLIER TERMS (MATERIALS / SHARDS). */
    val earlier: List<RewardTermRowUi>,
    /** REALM'S CUT rounds. */
    val taxRounds: List<TaxRoundRowUi>,
    /** INTO: where materials / Shards land; null on REALM'S CUT (it goes to the wallet). */
    val destination: KingdomPickUi?,
    /** CLAIM (MATERIALS / SHARDS, one row per review) / REVIEW CLAIM (REALM'S CUT): caption, sub, state, reason, badge. */
    val primary: CommandUi,
    /** The realm's-cut Seal; null when none. */
    val seal: TaxSealUi?,
    /** Saved claims with no outcome yet (each its own row; never "nothing was spent"). */
    val recovery: List<RecoveryUi>,
    val load: LoadState,
    /** New claims paused: the primary is LOCKED with the reason (mapper); kept for the mount. */
    val paused: Boolean,
    /** The host's crop of the island around your spot; null fills the stage colour. */
    val headerArt: ImageBitmap? = null,
    /** "7 YOURS" under your spot sprite; null hides it. */
    val spotTag: String? = null,
    /** "SPOT 7 · THIS TERM". */
    val sectionTitle: String = "THIS TERM",
    /** A locked tab's body line ("Not open on this server yet"); null draws the tab. */
    val lockedLine: String? = null,
    /** REALM'S CUT: the money sequence on the primary after the Seal. */
    val claimMoney: MoneyStage = MoneyStage.READY,
)

/** ISLAND REWARDS callbacks (§B; `onRetry` / `onReport` / `onExplain` added for the error row and refusals). */
@Immutable data class IslandRewardsActions(
    val onTab: (String) -> Unit = {},
    val onChangeKingdom: () -> Unit = {},
    val onClaim: () -> Unit = {},
    val onSealConfirm: () -> Unit = {},
    val onSealBack: () -> Unit = {},
    val onCheckSaved: (String) -> Unit = {},
    val onHistory: () -> Unit = {},
    val onClose: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
    val onExplain: (String) -> Unit = {},
)

/** MATERIALS (`ui:workshop-menu` stand-in, see MOUNT) · SHARDS (shard 24) · REALM'S CUT (KEEP 24); green "!" on [ready],
 *  padlock on [locked] (a locked tab still calls back). */
fun islandRewardsTabs(ready: Set<RewardsTab> = emptySet(), locked: Set<RewardsTab> = emptySet()): List<TabUi> = RewardsTab.entries.map { t ->
    val (icon, label) = when (t) {
        RewardsTab.MATERIALS -> "ui:workshop-menu" to "MATERIALS"
        RewardsTab.SHARDS -> "shards" to "SHARDS"
        RewardsTab.REALMS_CUT -> "keep" to "REALM'S CUT"
    }
    TabUi(rewardsTabId(t), icon, label, if (t in ready && t !in locked) BadgeUi("!", BadgeTone.READY, "$label ready to claim") else null, t in locked)
}

/** seeker-rewards.png critic fix: the sheet's top edge on the 412 x 915 phone, and so its designed height (to the bottom). */
private const val ISLAND_REWARDS_TOP_DP = 254f
private const val ISLAND_REWARDS_HEIGHT_DP = 915f - ISLAND_REWARDS_TOP_DP

/** The host's top edge for a viewport [viewportHeightDp] tall: 254 on the designed phone; a shorter screen keeps the
 *  designed sheet height by starting higher, never above the system tall-sheet top (104). */
fun islandRewardsSheetTopDp(viewportHeightDp: Float): Float =
    (viewportHeightDp - ISLAND_REWARDS_HEIGHT_DP).coerceIn(PkwTokens.Dims.tallSheetTop.value, ISLAND_REWARDS_TOP_DP)

/**
 * The ISLAND REWARDS tall sheet. Host geometry (critic fix): the sheet starts at y 254 ([islandRewardsSheetTopDp]), not
 * 104, so the primary never floats over empty parchment; the island scene stays parked under the 40 % TALL scrim and only
 * the SHARDS / KEEP readouts show top-right (BACK and the title plate hide while it is open).
 *
 * Pointer rule: the root is the kit SheetFrame (a painted panel); only its frame, tabs, rows and buttons take touches.
 * The TALL scrim is the SheetHost's, under this sheet, only while shown; the realm's-cut Seal ([IslandRewardsSeal]) has
 * its own scrim only while a seal is shown.
 */
@Composable fun IslandRewardsSheet(ui: IslandRewardsUi, on: IslandRewardsActions, modifier: Modifier = Modifier) {
    SheetFrame(SheetFrameUi("ISLAND REWARDS", null, SheetSize.TALL, ui.tabs, rewardsTabId(ui.tab), history = true),
        on.onClose, modifier, onTab = on.onTab, onHistory = on.onHistory,
        header = {
            HeaderArtCrop(ui.headerArt, Modifier.fillMaxSize())
            Column(Modifier.align(Alignment.BottomEnd).padding(end = 120.dp, bottom = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                MapIcon("site:seeker-active", 64.dp)
                ui.spotTag?.let { Tag(it, Verb.GOLD) }
            }
            ui.termLine?.let { VeilChip("Term ends", Modifier.align(Alignment.BottomStart).padding(6.dp), icon = "timer", emphasis = it) }
        },
        footer = { RewardsFooter(ui, on) }) {
        RewardsBody(ui, on)
    }
}

/**
 * The OverlayHost mount of the realm's-cut Seal (keep composing it with null through the exit).
 *
 * Pointer rule: full-screen only while the seal is shown or animating out ([FinePrintSeal]'s own 55 % scrim, tap = BACK);
 * with null nothing is composed, so the scene below keeps every touch.
 */
@Composable fun IslandRewardsSeal(ui: IslandRewardsUi, on: IslandRewardsActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    FinePrintSeal(ui.seal?.let(::realmsCutSealContent), on.onSealConfirm, on.onSealBack, modifier, clock, onExitFinished)
}

/** The realm's-cut Seal content (§B): KEEP → your wallet; the SOL lines only in the fine print. Pure data. */
fun realmsCutSealContent(seal: TaxSealUi): FinePrintSealUi = FinePrintSealUi(
    title = if (seal.setupOnce) "SET UP ONCE" else "CLAIM THE REALM'S CUT",
    pay = seal.amount,
    gets = SealGetUi(null, "TO YOUR WALLET", well = false),
    lines = listOf(if (seal.setupOnce) "Your wallet needs a one-time setup before KEEP can arrive. Then you claim."
        else "KEEP goes to your wallet."),
    secondary = null,
    finePrint = listOf(realmsCutFinePrint(seal.setupMaxSol, seal.networkMaxSol), "Paid from your wallet. You sign once."),
    confirmLabel = if (seal.setupOnce) "SET UP" else "CLAIM",
    armedAtMs = seal.armedAtMs,
    stage = seal.stage,
    canArm = permitSealCanArm(seal.amount, seal.stage),
    waitLine = when (seal.amount.status) {
        PriceStatus.CHECKING -> "Checking the amount…"
        PriceStatus.UNAVAILABLE -> "The amount isn't available right now"
        else -> null
    },
)

@Composable private fun RewardsBody(ui: IslandRewardsUi, on: IslandRewardsActions) {
    (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
    ui.recovery.forEach { RecoveryRow(it, on.onCheckSaved) }
    val locked = ui.lockedLine
    if (locked != null) {
        ParchLine(locked, center = true)
        return
    }
    ParchLine(rewardsIntro(ui.tab), maxLines = 3)
    val asOf = when (val l = ui.load) { is LoadState.Stale -> l.asOf; is LoadState.Error -> l.asOf; else -> null }
    val loading = ui.load == LoadState.Loading
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        MapSectionHeader(ui.sectionTitle, Modifier.weight(1f))
        if (asOf != null) Tag("as of $asOf", Verb.STONE)
    }
    if (ui.tab == RewardsTab.REALMS_CUT) {
        if (ui.taxRounds.isEmpty()) ParchLine(if (loading) UNKNOWN else "No permits sold this term yet.", secondary = true)
        ui.taxRounds.forEach { r -> TaxRow(r, loading, on) }
    } else {
        if (ui.current.isNotEmpty()) TileStrip(ui.current, loading)
        if (ui.earlier.isNotEmpty()) {
            MapSectionHeader("EARLIER TERMS")
            ui.earlier.forEach { TermRow(it, on) }
        }
        ui.destination?.let { MapSectionHeader("INTO"); KingdomPickRow(it, on.onChangeKingdom) }
    }
    ParchLine(rewardsFootnote(ui.tab), secondary = true, center = true)
}

/** Up to four 92-tall tiles side by side; more scroll sideways with the next one peeking. */
@Composable private fun TileStrip(tiles: List<RewardTileUi>, loading: Boolean) {
    val scroll = if (tiles.size > 4) Modifier.horizontalScroll(rememberScrollState()) else Modifier
    Row(Modifier.fillMaxWidth().then(scroll), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        tiles.forEach { t ->
            val amount = if (loading) UNKNOWN else t.amount.ifBlank { UNKNOWN }
            val said = listOfNotNull("$amount ${t.name}", "estimated share, not yet yours".takeIf { t.estimate }).joinToString(", ")
            val width = if (tiles.size > 4) Modifier.width(86.dp) else Modifier.weight(1f)
            Plate(PlateKind.CREAM, width.heightIn(min = 92.dp).clearAndSetSemantics { contentDescription = said }, blocksScene = false) {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    R2MapIcon(t.icon, if (t.icon.startsWith("craft:") || t.icon.startsWith("ui:")) 32.dp else 24.dp)
                    PkwText(amount, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                    PkwText(t.name, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    if (t.estimate) PkwText("Estimated share · not yet yours", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2,
                        textAlign = TextAlign.Center, maxLines = 2)
                }
            }
        }
    }
}

/** An EARLIER TERMS row: icon 32, title / sub, and READY / SENT, or "Being checked" with CHECK SAVED RECEIPT (that row
 *  cannot be claimed again). seeker-rewards.png draws every row cream with the 2 dp ink rim; only the tag says READY. */
@Composable private fun TermRow(row: RewardTermRowUi, on: IslandRewardsActions) {
    MapRow {
        R2MapIcon(row.icon, 32.dp)
        RowText(row.title, if (row.state == TermState.CHECKING) "Being checked" else row.sub)
        val key = row.recoveryKey
        if (row.state == TermState.CHECKING && key != null) SecondaryButton("CHECK", { on.onCheckSaved(key) }, Modifier.widthIn(min = 88.dp),
            contentDescription = "Check the saved receipt for ${row.title}")
        else termTag(row.state)?.let { RowTag(it) }
    }
}

/** A REALM'S CUT round row: KEEP pill, title / sub, and its tag (or the check). */
@Composable private fun TaxRow(row: TaxRoundRowUi, loading: Boolean, on: IslandRewardsActions) {
    MapRow {
        PkwIcon("keep", 24.dp)
        RowText(row.title, if (row.state == TermState.CHECKING) "Being checked" else row.sub)
        PriceChip(if (loading) row.amount.copy(status = PriceStatus.CHECKING) else row.amount)
        val key = row.recoveryKey
        if (row.state == TermState.CHECKING && key != null) SecondaryButton("CHECK", { on.onCheckSaved(key) }, Modifier.widthIn(min = 88.dp),
            contentDescription = "Check the saved receipt for ${row.title}")
        else termTag(row.state)?.let { RowTag(it) }
    }
}

/** The footer: REALM'S CUT after its Seal runs the money sequence; otherwise the gold primary routed by [commandRoute]
 *  (BUSY = stone dots "Claiming"; DISABLED = "Nothing to claim yet · next share at 00:00 UTC"). */
@Composable private fun RewardsFooter(ui: IslandRewardsUi, on: IslandRewardsActions) {
    val p = ui.primary
    if (ui.tab == RewardsTab.REALMS_CUT && ui.claimMoney != MoneyStage.READY) {
        MoneyButton(ui.claimMoney, p.caption, on.onClaim)
        return
    }
    PrimaryButton(p.caption, {
        when (commandRoute(p)) {
            CommandRoute.OPEN -> on.onClaim()
            CommandRoute.NEED_MORE, CommandRoute.EXPLAIN -> on.onExplain(p.reason ?: p.caption)
            CommandRoute.IGNORE -> Unit
        }
    }, Modifier.fillMaxWidth(), sub = p.sub, state = commandDrawState(p), reason = p.reason, badge = p.badge)
}

// ---- Previews (seeker-rewards.png numbers; every number is a placeholder) ----

private val previewTiles = listOf(
    RewardTileUi("craft:inv_crownsteel", "12", "Crownsteel", false), RewardTileUi("craft:inv_frostglass", "8", "Frostglass", false),
    RewardTileUi("craft:inv_thornsilk", "5", "Thornsilk", false), RewardTileUi("craft:inv_stormalloy", "3", "Stormalloy", false),
)

private val previewClaimAll = CommandUi(FeatureId("island.seeker.rewards.claim"), "ui:ready-status", "CLAIM", null, true, CommandState.ENABLED,
    null, BadgeUi("!", BadgeTone.READY, "Rewards ready"), sub = "no wallet needed")

private val previewRewards = IslandRewardsUi("seeker", RewardsTab.MATERIALS, islandRewardsTabs(setOf(RewardsTab.SHARDS, RewardsTab.REALMS_CUT)),
    "5d 20h", previewTiles, listOf(RewardTermRowUi("t40", "craft:inv_embercore", "Spot 7 · 21-28 Sep", "6 Embercore still yours", TermState.READY)),
    emptyList(), KingdomPickUi("Ironhold", "Crownlands · Keep 12", "ui_portrait_keep_t3"), previewClaimAll, null, emptyList(), LoadState.Ready,
    paused = false, spotTag = "7 YOURS", sectionTitle = "SPOT 7 · THIS TERM")

@Composable private fun TallHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage)) {
        Box(Modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.SHEET_TALL))
            .padding(start = 4.dp, end = 4.dp, top = islandRewardsSheetTopDp(915f).dp)) { content() }
    }
}

@Preview(name = "Island rewards: MATERIALS (seeker-rewards)", widthDp = 412, heightDp = 915)
@Composable private fun RewardsPreview() { TallHost { IslandRewardsSheet(previewRewards, IslandRewardsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Island rewards: SHARDS, estimate tile + uncertain claim", widthDp = 412, heightDp = 915)
@Composable private fun RewardsShardsPreview() {
    TallHost {
        IslandRewardsSheet(previewRewards.copy(tab = RewardsTab.SHARDS, current = listOf(RewardTileUi("shards", "1,840", "Spot 7", false),
            RewardTileUi("shards", "620", "Spot 42", true)),
            earlier = listOf(RewardTermRowUi("t39", "shards", "Spot 7 · 14-21 Sep", "1,200 Shards", TermState.CHECKING, "claim-39")),
            primary = previewClaimAll), IslandRewardsActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Island rewards: REALM'S CUT + Seal", widthDp = 412, heightDp = 915)
@Composable private fun RewardsCutPreview() {
    val ui = previewRewards.copy(tab = RewardsTab.REALMS_CUT, destination = null,
        taxRounds = listOf(TaxRoundRowUi("r41", "Round 41 · Spot 7", "4 permits sold", PriceUi(Currency.KEEP, "12.5", PriceStatus.OK), TermState.READY)),
        primary = previewClaimAll.copy(caption = "CLAIM REALM'S CUT", sub = "to your wallet"),
        seal = TaxSealUi(PriceUi(Currency.KEEP, "12.5", PriceStatus.OK), setupOnce = false, setupMaxSol = "0.0021", networkMaxSol = "0.0001", MoneyStage.READY, 0L))
    Box(Modifier.fillMaxSize()) { TallHost { IslandRewardsSheet(ui, IslandRewardsActions(), Modifier.fillMaxSize()) }; IslandRewardsSeal(ui, IslandRewardsActions()) }
}

@Preview(name = "Island rewards: empty / loading / error / busy / locked tab", widthDp = 412, heightDp = 915)
@Composable private fun RewardsStatesPreview() {
    TallHost {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            IslandRewardsSheet(previewRewards.copy(current = emptyList(), earlier = emptyList(), load = LoadState.Error("Can't reach the island.", asOf = "14:02"),
                primary = previewClaimAll.copy(state = CommandState.DISABLED, badge = null, reason = "Nothing to claim yet · next share at 00:00 UTC")),
                IslandRewardsActions(), Modifier.weight(1f))
            IslandRewardsSheet(previewRewards.copy(load = LoadState.Loading, primary = previewClaimAll.copy(caption = "Claiming", state = CommandState.BUSY)),
                IslandRewardsActions(), Modifier.weight(1f))
        }
    }
}

@Preview(name = "Island rewards: locked tab, kingdom gone", widthDp = 412, heightDp = 915)
@Composable private fun RewardsLockedPreview() {
    TallHost {
        IslandRewardsSheet(previewRewards.copy(tabs = islandRewardsTabs(locked = setOf(RewardsTab.REALMS_CUT)),
            destination = KingdomPickUi("Saltmarsh", "Crownlands · Keep 4", "ui_portrait_keep_t1", gone = true)), IslandRewardsActions(), Modifier.fillMaxSize())
    }
}
