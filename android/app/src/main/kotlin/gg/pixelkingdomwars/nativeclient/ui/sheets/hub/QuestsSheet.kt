package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: Quests (design/final/hub/quests.png, SPEC §2.3). Daily and kingdom quests, each a door to where it
 * is done; the whole pool shows as live rows, never collapsed. Destination: `Quests(tab)` (FULL card). Tabs DAILY ·
 * KINGDOM with green claimable counts. The per-row claim is the green "ready" grammar; the one gold primary is CLAIM n.
 */

/** Where a quest stands. */
enum class QuestState {
    /** Done, not yet claimed: `ready` row + green CLAIM tag; the whole row claims it. */
    READY,
    /** In progress: blue GO to the quest's place. */
    GO,
    /** Claimed: dim row at 55 % + moss DONE, sorted last. */
    DONE,
    /** Server-gated: Well dimmed, charcoal padlock GO; a tap says why. */
    LOCKED,
}

/** The daily bonus card. */
@Immutable data class QuestBonusUi(
    /** Quests done today; null = unknown (no pips, "…"). */
    val done: Int?,
    /** Quests in the bonus; null = unknown. */
    val total: Int?,
    /** The bonus shard pill; null hides it. */
    val reward: PriceUi?,
    /** "6h 12m" until new quests; null hides the line. */
    val resetsIn: String?,
)

/** One QuestRow (CardRow 64). */
@Immutable data class QuestRowUi(
    val id: String,
    /** The place's icon in a light Well (32 or 36 dp). */
    val icon: String,
    /** VT 20 ("Train 20 troops"). */
    val title: String,
    /** Progress have / need, formatted ("12", "20"; "…" when unknown). */
    val have: String,
    val need: String,
    /** 0..1 for the 84 × 12 meter; null draws an empty track. */
    val progress: Float?,
    /** The reward (icon 24 + amount); null hides it (the protocol does not always carry it — never invent one). */
    val reward: PriceUi?,
    val state: QuestState,
    /** Where GO flies (`FocusBuilding("barracks", then = Army(TRAIN))`); null for READY / DONE. */
    val destination: HubLink?,
    /** Why a LOCKED quest is locked ("Unlocks at Keep 8"). */
    val lockedReason: String? = null,
    /** The land objective opens a purchase flow: BUY must not be confused with claiming an earned reward. */
    val goLabel: String = "GO",
)

/** Everything Quests draws (SPEC §2.3 State; fields after `busyIds` were added with defaults). */
@Immutable data class QuestsUi(
    /** "DAILY" or "KINGDOM". */
    val tab: String,
    /** Claimable count per tab id, for the green tab badges. */
    val tabBadges: Map<String, Int>,
    val bonus: QuestBonusUi,
    /** Rows in any order; drawn through [orderQuests]. */
    val rows: List<QuestRowUi>,
    /** The footer CLAIM n; hidden when null or n = 0. */
    val claimAll: ClaimAllUi?,
    /** Rows whose claim is in flight: their tag shows stone dots and the row takes no tap. */
    val busyIds: Set<String>,
    /** SHARDS + GEMS (the currencies quests pay out). */
    val readouts: List<ResourceChipUi> = emptyList(),
    /** The KINGDOM tab icon's Keep tier; null uses a neutral quest icon instead of inventing a tier. */
    val keepTier: Int? = null,
    /** "All done for today" / "New quests in 6h" (no button); shown when [rows] is empty. */
    val empty: EmptyStateUi? = null,
    /** CLAIM n is waiting for its receipt. */
    val claimAllBusy: Boolean = false,
    val load: LoadState = LoadState.Ready,
    /** Owner/refusal/busy status remains visible even when there is no current row to carry it. */
    val notice: String? = null,
)

/** DAILY (timer) · KINGDOM (keep portrait), each with a green count badge of claimable quests. */
fun questsTabs(tabBadges: Map<String, Int>, keepTier: Int?): List<TabUi> = listOf("DAILY" to "timer", "KINGDOM" to (keepTier?.let(::keepPortrait) ?: "quest")).map { (id, icon) ->
    val n = tabBadges[id] ?: 0
    TabUi(id, icon, id, badgeCount(n)?.let { BadgeUi(it, BadgeTone.READY, "$n ready to claim") }, false)
}

/** Quests callbacks. */
@Immutable data class QuestsActions(
    val onTab: (String) -> Unit = {},
    /** Claim one READY quest (the whole row). */
    val onClaim: (String) -> Unit = {},
    val onClaimAll: () -> Unit = {},
    /** GO flies to the quest's place. */
    val onGo: (HubLink) -> Unit = {},
    val onClose: () -> Unit = {},
    /** A LOCKED quest was tapped: show the reason. */
    val onLocked: (String) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
)

/**
 * The Quests card. [modifier] is the FULL-card area (see [HubCard]).
 * Claim motion: green tag → dots at once; after the receipt the row turns DONE and re-sorts with a 160 ms slide; the
 * coins and count-up belong to the readouts (`ResourceChipUi.gain`) and the OverlayHost.
 *
 * Pointer rule: the root is the plain [HubCard] Column; only painted rows and buttons take touches.
 */
@Composable fun QuestsSheet(ui: QuestsUi, on: QuestsActions, modifier: Modifier = Modifier) {
    val claimAll = ui.claimAll
    HubCard(modifier, readouts = ui.readouts, tabs = questsTabs(ui.tabBadges, ui.keepTier), selectedTab = ui.tab, onTab = on.onTab,
        footer = if (claimAll != null && claimAllShown(claimAll)) ({
            PrimaryButton("CLAIM ${claimAll.count}", on.onClaimAll, Modifier.weight(1f), sub = claimAll.summary,
                state = if (ui.claimAllBusy) CommandState.BUSY else CommandState.ENABLED)
        }) else null,
        // quests.html / SPEC §2.3: the quest icon is 36 dp, overhanging the 44 dp title plate (CSS margin −6) rather than
        // growing it; the CompactHeader default draws 24.
        header = { CompactHeader("QUESTS", "quest", on.onClose, iconContent = {
            Box(Modifier.size(36.dp, 24.dp), contentAlignment = Alignment.Center) { HubArt("quest", 36.dp, Modifier.requiredSize(36.dp)) }
        }) }) {
        ui.notice?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(bottom = 4.dp),
            color = PkwTokens.Colors.textOnParch2, maxLines = 4) }
        QuestsBody(ui, on)
    }
}

@Composable private fun ColumnScope.QuestsBody(ui: QuestsUi, on: QuestsActions) {
    val view = boardView(ui.load, ui.rows.isNotEmpty())
    if (view == BoardView.ERROR_KEPT || view == BoardView.ERROR_EMPTY) (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport, Modifier.padding(bottom = 4.dp)) }
    val empty = ui.empty
    when {
        view == BoardView.SKELETON -> Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (ui.tab == "DAILY") BonusCard(ui.bonus); repeat(4) { SkeletonRow(height = 64.dp) }
        }
        ui.rows.isEmpty() && empty != null -> Column(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ui.tab == "DAILY") BonusCard(ui.bonus)
            // SPEC §3.5: the hub EmptyState inside the card body (no second parchment plate) and, for Quests, no button.
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) { HubEmptyState(empty.headline, empty.reason, icon = empty.icon) }
        }
        else -> LazyColumn(Modifier.fillMaxWidth().weight(1f).graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // The daily bonus counts dailies only (quests.png DAILY tab); KINGDOM is the tutorial chain.
            if (ui.tab == "DAILY") item(key = "bonus") { BonusCard(ui.bonus) }
            items(orderQuests(ui.rows), key = { it.id }) { row ->
                QuestRow(row, row.id in ui.busyIds, on,
                    Modifier.animateItem(fadeInSpec = null, placementSpec = tween<IntOffset>(PkwTokens.Motion.PLATE_IN), fadeOutSpec = null))
            }
        }
    }
}

/** The daily bonus card (CreamCard 72, selected tint): star, "DAILY BONUS 4/6", Pips, reset line, shard pill. */
@Composable private fun BonusCard(bonus: QuestBonusUi) {
    val spoken = listOfNotNull("Daily bonus ${fractionText(bonus.done, bonus.total)}", bonus.resetsIn?.let { "New quests in $it" },
        bonus.reward?.let(::priceDescription)).joinToString(". ")
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 72.dp).clearAndSetSemantics { contentDescription = spoken },
        tint = PkwTokens.Colors.selectedTint, blocksScene = false) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HubArt("star", 36.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                PkwText("DAILY BONUS ${fractionText(bonus.done, bonus.total)}", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                pipFills(bonus.done, bonus.total)?.let { Pips(it, "") }
                bonus.resetsIn?.let { PkwText("New quests in $it", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
            }
            bonus.reward?.let { PriceChip(it) }
        }
    }
}

@Composable private fun QuestRow(row: QuestRowUi, busy: Boolean, on: QuestsActions, modifier: Modifier) {
    val reward = row.reward
    val spokenReward = reward?.let(::priceDescription)?.replace("Costs", "Pays")
    when (row.state) {
        QuestState.READY -> CardRow(modifier, variant = RowVariant.READY, height = 64.dp, onClick = { on.onClaim(row.id) }, enabled = !busy,
            description = listOfNotNull(row.title, if (busy) "claiming" else "ready to claim", spokenReward).joinToString(", ")) {
            QuestWell(row, dim = false)
            QuestMiddle(row, Verb.GREEN)
            if (busy) StatusTag("", Verb.STONE, tall = true, dots = true) else StatusTag("CLAIM", Verb.GREEN, tall = true)
        }
        QuestState.GO -> CardRow(modifier, height = 64.dp) {
            QuestWell(row, dim = false)
            QuestMiddle(row, Verb.GOLD)
            row.destination?.let { dest -> GoButton({ on.onGo(dest) }, contentDescription = "${row.goLabel}: ${row.title}",
                modifier = Modifier.width(58.dp), label = row.goLabel) }
        }
        QuestState.LOCKED -> CardRow(modifier, height = 64.dp) {
            QuestWell(row, dim = true)
            QuestMiddle(row, Verb.GOLD)
            val reason = row.lockedReason ?: "Locked"
            ChunkyBox(PkwTokens.Colors.charcoalRamp, { on.onLocked(reason) }, "${row.title}, locked. $reason", Modifier.size(58.dp, 48.dp)) {
                PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
            }
        }
        QuestState.DONE -> Box(modifier.graphicsLayer { alpha = HubMotion.DONE_ALPHA }) {
            CardRow(variant = RowVariant.DIM, height = 64.dp) {
                QuestWell(row, dim = false)
                QuestMiddle(row, Verb.GREEN)
                StatusTag("DONE", Verb.MOSS, tall = true)
            }
        }
    }
}

@Composable private fun QuestWell(row: QuestRowUi, dim: Boolean) {
    Well(row.icon, light = true, iconSize = if (row.icon.startsWith("ui:")) 32.dp else 36.dp, alpha = if (dim) 0.4f else 1f)
}

/** Title, then the 84 × 12 meter, "n/m", and the reward icon + amount. */
@Composable private fun androidx.compose.foundation.layout.RowScope.QuestMiddle(row: QuestRowUi, meter: Verb) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        PkwText(row.title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ProgressBar(row.progress, "${row.have} of ${row.need}", Modifier.width(84.dp), verb = meter, height = 12.dp)
            PkwText("${row.have}/${row.need}", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
            // quests.html: the reward icon sits 4 dp further out and its amount is the secondary ink (`#6E5034`).
            row.reward?.let { reward ->
                HubArt(currencyIcon(reward.currency, reward.icon), 24.dp, Modifier.padding(start = 4.dp))
                PkwText(priceText(reward), PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
            }
        }
    }
}

// ---- Previews (quests.png numbers) ----

private fun shards(n: String) = PriceUi(Currency.SHARDS, n, PriceStatus.OK)
private fun gems(n: String) = PriceUi(Currency.GEMS, n, PriceStatus.OK)

private val sampleQuests = QuestsUi(
    tab = "DAILY", tabBadges = mapOf("DAILY" to 2, "KINGDOM" to 1),
    bonus = QuestBonusUi(4, 6, shards("500"), "6h 12m"),
    rows = listOf(
        QuestRowUi("upgrade", "itm_hammer", "Upgrade any building", "1", "1", 1f, shards("200"), QuestState.DONE, null),
        QuestRowUi("train", "ui_portrait_highlander_t2", "Train 20 troops", "12", "20", 0.6f, shards("250"), QuestState.GO, sampleLink("barracks.train")),
        QuestRowUi("raids", "attack", "Win 2 raids", "2", "2", 1f, shards("300"), QuestState.READY, null),
        QuestRowUi("mine", "shards", "Collect at a Mine 3 times", "3", "3", 1f, gems("10"), QuestState.READY, null),
        QuestRowUi("smelt", "ui:queue-status", "Smelt an ingot", "0", "1", 0f, shards("400"), QuestState.GO, sampleLink("goldforge.smelt")),
        QuestRowUi("expedition", "ui:lodge-menu", "Send an expedition", "0", "1", 0f, gems("5"), QuestState.GO, sampleLink("lodge.expedition")),
        QuestRowUi("seeker", "ui:seeker-navigation", "Visit Seeker Island", "0", "1", 0f, gems("5"), QuestState.LOCKED, null, "Unlocks at Keep 8"),
    ),
    claimAll = ClaimAllUi(2, "300 Shards · 10 Gems"), busyIds = emptySet(), readouts = sampleReadouts, keepTier = 3,
)

@Preview(name = "Quests (quests.png)", widthDp = 412, heightDp = 915)
@Composable private fun QuestsPreview() { HubPreviewStage { QuestsSheet(sampleQuests, QuestsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Quests: one claim busy", widthDp = 412, heightDp = 915)
@Composable private fun QuestsBusyPreview() { HubPreviewStage { QuestsSheet(sampleQuests.copy(busyIds = setOf("raids")), QuestsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Quests: all claimed (success, no footer)", widthDp = 412, heightDp = 915)
@Composable private fun QuestsClaimedPreview() {
    HubPreviewStage {
        QuestsSheet(sampleQuests.copy(tabBadges = emptyMap(), claimAll = null,
            rows = sampleQuests.rows.map { if (it.state == QuestState.READY) it.copy(state = QuestState.DONE) else it }), QuestsActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Quests: empty (All done for today)", widthDp = 412, heightDp = 915)
@Composable private fun QuestsEmptyPreview() {
    HubPreviewStage {
        QuestsSheet(sampleQuests.copy(rows = emptyList(), claimAll = null, tabBadges = emptyMap(),
            empty = EmptyStateUi("quest", "All done for today", "New quests in 6h", null, null)), QuestsActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Quests: loading", widthDp = 412, heightDp = 915)
@Composable private fun QuestsLoadingPreview() {
    HubPreviewStage {
        QuestsSheet(sampleQuests.copy(rows = emptyList(), claimAll = null, bonus = QuestBonusUi(null, null, null, null), load = LoadState.Loading),
            QuestsActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Quests: error with kept rows", widthDp = 412, heightDp = 915)
@Composable private fun QuestsErrorPreview() {
    HubPreviewStage {
        QuestsSheet(sampleQuests.copy(load = LoadState.Error("Can't reach the quest board.", asOf = "14:02")), QuestsActions(), Modifier.fillMaxSize())
    }
}
