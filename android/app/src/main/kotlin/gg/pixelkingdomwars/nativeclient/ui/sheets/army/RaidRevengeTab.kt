package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi

/*
 * Design component: the Raid chooser's REVENGE tab (design/final/army/SPEC.md R2.2 + critic fixes, raid-revenge.png;
 * registry row 98). REPLACES the round 1 private `RevengeTab` inside RaidChooserSheet.kt (its `DefenceRowUi` rows): the
 * same `ArmyTallSheet` (header art, energy chip, tabs) with REVENGE active; section line "THEY RAIDED YOU · answer them";
 * one 80 dp `RevengeRow` per answerable defence (keep well, name + time, stars + %, loss + trophies, stone replay, red
 * REVENGE caption-only, or the moss ANSWERED tag); a footer with no primary: the energy CostPill + the rule line.
 */

/** Everything the REVENGE tab draws (SPEC R2.2: `RaidChooserUi.revenge: List<DefenceRowUi>` + `energy`). */
@Immutable data class RaidRevengeUi(
    /** The defences the player can still (or did) answer, newest first (the Battle log's rows). */
    val rows: List<DefenceEntryUi>,
    /** The chooser's energy (the header chip keeps drawing it from `RaidChooserUi.energy`). */
    val energy: EnergyUi,
    /** One answer's energy price for the footer pill (SHORT → Need-more → SUPPLIES); null hides the pill. */
    val energyPrice: PriceUi?,
    /** A reason that turns every REVENGE off: "Energy 0 · next in 38m", "No troops ready"; null = answers allowed. */
    val gate: String?,
    /** True when the gate is "no troops ready": the ArmyCheckRow TRAIN door shows above the rows. */
    val armyEmpty: Boolean,
    /** "No one to answer. Your walls held." (§6); used when [rows] is empty and not loading. */
    val empty: EmptyStateUi?,
    /** Loading: skeleton rows when there is nothing to show yet. */
    val loading: Boolean,
    /** True only if the server confirms that attacking drops the player's shield (the second footer sentence). */
    val shieldDropsOnAttack: Boolean = false,
)

/** REVENGE tab callbacks (SPEC R2.2). */
class RaidRevengeActions(
    /** REVENGE / RETRY (row id): the pressed row goes stone + dots; success cuts to the scene. */
    val onRevenge: (String) -> Unit,
    /** The stone replay (replay id). */
    val onReplay: (String) -> Unit,
    /** The SHORT energy pill: Need-more → `BuildShop("SUPPLIES")`. */
    val onNeedMore: (PriceUi) -> Unit = {},
    /** "No troops ready": `Army(TRAIN)`. */
    val onTrain: () -> Unit = {},
    /** An EmptyState GO. */
    val onGo: (FeatureId) -> Unit = {},
    /** An off REVENGE: the host says why. */
    val onExplain: (String) -> Unit = {},
)

/**
 * The REVENGE tab body (raid-revenge.png), composed inside the chooser's `ArmyTallSheet` body column.
 *
 * Pointer rule: content of a painted sheet; no full-screen clickable, pointerInput, scrim or draggable here.
 */
@Composable fun ColumnScope.RaidRevengeTab(ui: RaidRevengeUi, on: RaidRevengeActions) {
    val c = PkwTokens.Colors
    if (ui.armyEmpty) NoticeRow("No troops ready", "TRAIN", on.onTrain)
    if (ui.rows.isEmpty()) {
        if (ui.loading) SkeletonGrid(1, 3, 80.dp) else ui.empty?.let { EmptyState(it, on.onGo) }
        return
    }
    SectionLine("THEY RAIDED YOU", "answer them")
    ui.rows.forEachIndexed { i, row ->
        RowStagger(i) { DefenceEntryRow(row, ui.gate, compact = true, onRevenge = on.onRevenge, onReplay = on.onReplay, onExplain = on.onExplain) }
    }
    if (ui.gate != null && !ui.armyEmpty) PkwText(ui.gate, PkwTokens.Type.small, color = c.textOnParch2)
}

/**
 * The REVENGE footer (no primary): the energy CostPill (a SHORT pill opens Need-more) + "Each answer costs one raid." and,
 * only when the server confirms it, "Your shield drops when you attack." Pass it as the chooser's footer on REVENGE.
 */
@Composable fun ColumnScope.RaidRevengeFooter(ui: RaidRevengeUi, on: RaidRevengeActions) {
    FooterFade()
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ui.energyPrice?.let { p -> PriceChip(p, onClick = needMoreTap(p, on.onNeedMore)) }
        PkwText(revengeFooterLine(ui.shieldDropsOnAttack), PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2, maxLines = 2)
    }
}

/** "Each answer costs one raid." + the classic shield rule only when the server confirms it. */
fun revengeFooterLine(shieldDropsOnAttack: Boolean): String =
    "Each answer costs one raid." + if (shieldDropsOnAttack) " Your shield drops when you attack." else ""

// ---- Previews (in the chooser's frame) ----

private val sampleRevenge = RaidRevengeUi(
    rows = BattleLogSamples.rows.map { it.copy(army = emptyList()) }, energy = EnergyUi(4, 5, 2_280),
    energyPrice = PriceUi(Currency.ITEM, "1", PriceStatus.OK, icon = "energy", description = "Costs 1 energy"), gate = null, armyEmpty = false,
    empty = EmptyStateUi("shield", "No one to answer.", "Your walls held.", null, null), loading = false,
)
private val previewActions = RaidRevengeActions(onRevenge = {}, onReplay = {})

@Composable private fun RevengePreviewFrame(ui: RaidRevengeUi) {
    SheetPreviewFrame(ArmySheetKind.RAID) { m ->
        ArmyTallSheet(RaidSamples.match.header, raidTabs(ui.rows.count { it.revenge != RevengeState.ANSWERED }), RAID_TAB_REVENGE, {}, {}, {}, m,
            headerChip = { HeaderChip(HeaderChipUi("energy", "${ui.energy.now ?: "…"} / ${ui.energy.max ?: "…"}", null)) },
            footer = { RaidRevengeFooter(ui, previewActions) }) {
            RaidRevengeTab(ui, previewActions)
        }
    }
}

@Preview(name = "Raid chooser: REVENGE (raid-revenge.png)", widthDp = 412, heightDp = 915)
@Composable private fun RevengeDefaultPreview() = RevengePreviewFrame(sampleRevenge)

@Preview(name = "Raid chooser: REVENGE no energy, no troops, empty, loading", widthDp = 1648, heightDp = 915)
@Composable private fun RevengeStatesPreview() {
    Row {
        Box(Modifier.weight(1f).fillMaxSize()) { RevengePreviewFrame(sampleRevenge.copy(gate = "Energy 0 · next in 38m", energy = EnergyUi(0, 5, 2_280),
            energyPrice = sampleRevenge.energyPrice?.copy(status = PriceStatus.SHORT))) }
        Box(Modifier.weight(1f).fillMaxSize()) { RevengePreviewFrame(sampleRevenge.copy(gate = "No troops ready", armyEmpty = true)) }
        Box(Modifier.weight(1f).fillMaxSize()) { RevengePreviewFrame(sampleRevenge.copy(rows = emptyList())) }
        Box(Modifier.weight(1f).fillMaxSize()) { RevengePreviewFrame(sampleRevenge.copy(rows = emptyList(), loading = true)) }
    }
}

@Preview(name = "Raid chooser: REVENGE busy, being checked, shielded target", widthDp = 412, heightDp = 915)
@Composable private fun RevengeBusyPreview() {
    val r = sampleRevenge.rows
    RevengePreviewFrame(sampleRevenge.copy(rows = listOf(r[0].copy(action = RowActionState.BUSY), r[1].copy(action = RowActionState.CHECKING),
        r[2].copy(revenge = RevengeState.UNAVAILABLE, unavailableNote = "SHIELDED · try in 2h"), r[3]), shieldDropsOnAttack = true))
}
