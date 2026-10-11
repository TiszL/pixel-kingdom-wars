package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the Raid chooser (design/final/army/SPEC.md §6; raid.png, campaign.png): one tall sheet for every
 * way to fight. MATCH: the army check row, the FIND A MATCH card, the WORLD MAP row and recent raids, with the energy +
 * Shards pills and the red FIND A MATCH primary. CAMPAIGN: the act header, the five-node stage road around the frontier,
 * the stage card (garrison, bring, first-3★ reward), SCOUT / ARMY, and the red ATTACK primary; the header becomes the
 * campaign map with a MAP button. REVENGE: defence rows, each with its own red button and no footer primary.
 */

/** Energy (SPEC §6 `EnergyUi`). */
@Immutable data class EnergyUi(
    /** Points now; null = unknown ("…"). */
    val now: Int?,
    /** Maximum points; null = unknown. */
    val max: Int?,
    /** Seconds until the next point; null when full or unknown. */
    val nextInSec: Long?,
)

/** The army check row (SPEC §6 `ArmyCheckRow`). */
@Immutable data class ArmyCheckUi(
    /** Ready points; null = "…". */
    val ready: Int?,
    /** Camp capacity; null = "…". */
    val capacity: Int?,
    /** Up to 5 troop portraits. */
    val preview: List<String>,
    /** Ready heroes' portraits (gold-lo border). */
    val heroesReady: List<String>,
    /** No troops ready: blood rim, "No troops ready" and a blue TRAIN. */
    val empty: Boolean,
)

/** The FIND A MATCH card (SPEC §6 `MatchCard`); informational, the primary acts. */
@Immutable data class MatchCardUi(
    /** VT 20 league name ("Gold league"). */
    val league: String,
    /** 40 px crest ("league-gold"). */
    val crest: String,
    /** Formatted trophies ("1,284", "…"). */
    val trophies: String,
    /** False: landless copy ("Auto-match another landless keep…", native). */
    val landOwned: Boolean,
    /** The VT 18 sentence under it ("We pick a base near your trophies. The fastest fight." or the landless copy). */
    val note: String,
)

/** One recent raid (SPEC §6 `RecentRaidRow`). */
@Immutable data class RaidRecordUi(
    /** Stable row id. */
    val id: String,
    /** Opponent name ("Ironjaw"); drawn as "vs Ironjaw". */
    val opponent: String,
    /** "2h ago". */
    val ago: String,
    /** Stars earned (0-3). */
    val stars: Int,
    /** "+8,200 Shards", "defeat" or "LOOT REDACTED" verbatim; the sign tones it. */
    val lootLabel: String,
    /** "+14 trophies", "-9 trophies". */
    val trophyDelta: String,
    /** The replay to open; null hides the button. */
    val replayId: String?,
    val starsKnown: Boolean = true,
)

/** The act header (SPEC §6 CAMPAIGN). */
@Immutable data class ActUi(
    /** "ACT 4 · ELDERWOOD". */
    val title: String,
    /** "5 of 10 cleared". */
    val cleared: String,
    /** VT 20 chapter name ("The Rootbound Covenant"). */
    val chapter: String,
    /** VT 18 epithet ("Listen beneath the stone."). */
    val epithet: String,
)

/** A stage node's state (SPEC §6 `StageRoad`). */
enum class StageNodeState { CLEARED, NEXT, LOCKED }

/** One node of the stage road. */
@Immutable data class StageNodeUi(
    /** Stage number (handed back by `onStage`). */
    val stage: Int,
    val state: StageNodeState,
    /** Stars earned (CLEARED). */
    val stars: Int,
    /** The selected stage (drawn at 60 dp, like NEXT). */
    val selected: Boolean,
)

/** The selected stage's card (SPEC §6 `StageCard`). */
@Immutable data class StageCardUi(
    val stage: Int,
    /** "STAGE 36". */
    val title: String,
    /** "OUTPOST", "BREACH", "FORTRESS", "MINI BOSS", "BOSS". */
    val profile: String,
    /** True for mini boss / boss (red tag). */
    val boss: Boolean,
    /** "Keep Lv 8". */
    val keepLevel: String,
    /** VT 24 stage name (presentation `names`, else the catalogue name). */
    val name: String,
    /** VT 18 lore line. */
    val lore: String,
    /** Defence portraits (28 dp). */
    val garrison: List<String>,
    /** "+ 8 more · 11 traps". */
    val garrisonNote: String,
    /** Recommended troop portraits. */
    val bring: List<String>,
    /** "about 40 pts". */
    val bringNote: String,
    /** The first-3★ reward, paid once; null when none. */
    val reward: PriceUi?,
    /** Already paid: "Stars can still be improved." replaces the reward line. */
    val rewardClaimed: Boolean,
    /** The ARMY button label ("ARMY 42/50"). */
    val armyLabel: String,
)

/** The CAMPAIGN tab (SPEC §6 `CampaignUi`). */
@Immutable data class CampaignUi(val stars: Int, val maxStars: Int, val act: ActUi, val road: List<StageNodeUi>, val selected: StageCardUi)

/** One defence the player can answer (SPEC §6 REVENGE). */
@Immutable data class DefenceRowUi(
    val id: String,
    /** Attacker name. */
    val attacker: String,
    /** Seeker crest art, if any. */
    val crest: String?,
    /** "3h ago". */
    val ago: String,
    /** Stars against you. */
    val stars: Int,
    /** Loot lost ("-4,100 Shards"), red. */
    val lootLost: String,
    /** "REVENGE", or "ATTACK BACK" after `revengeLockHours` (native `revengeLabel`). */
    val action: CommandUi,
)

/** Everything the Raid chooser draws (SPEC §6 `RaidChooserUi`). */
@Immutable data class RaidChooserUi(
    /** MATCH, CAMPAIGN or REVENGE (landless accounts default to CAMPAIGN). */
    val tab: String,
    /** "ATTACK" (no level tag); the army marching east. */
    val header: SheetHeaderUi,
    val energy: EnergyUi,
    val army: ArmyCheckUi,
    /** Null hides the card. */
    val match: MatchCardUi?,
    /** WORLD MAP row: caption = title ("WORLD MAP" / "WORLD MAP — LOOK ONLY"), sub = the sentence; GO flies to the globe. */
    val worldMap: CommandUi,
    val recent: List<RaidRecordUi>,
    /** Null while the campaign is unknown (skeletons). */
    val campaign: CampaignUi?,
    val revenge: List<DefenceRowUi>,
    /** MATCH: energy + Shards pills (`raidEntryCostLabel`), red FIND A MATCH (BUSY "Finding a base"; DISABLED "PVP OFF" /
     *  "PVP ENTRY COST UNKNOWN" / "Energy 0 · next in 38m"). CAMPAIGN: "Free · no energy" / "Base never at risk", red
     *  ATTACK "stage 36". REVENGE: null (each row has its own button). */
    val footer: FooterUi?,
    /** A server-saved march is waiting: the blue row's text; null hides it. */
    val marchWaiting: String? = null,
    /** REVENGE empty: "No one to answer. Your walls held." */
    val revengeEmpty: EmptyStateUi? = null,
    /** Loading: skeletons when there is no last good view. */
    val loading: Boolean = false,
)

/** Raid chooser callbacks (SPEC §1.2 + §6). */
@Immutable data class RaidActions(
    val onClose: () -> Unit = {},
    val onHistory: () -> Unit = {},
    val onTab: (String) -> Unit = {},
    val onResourceRow: (FeatureId) -> Unit = {},
    /** FIND A MATCH: busy, then the scene cuts to battle / scout. */
    val onFind: () -> Unit = {},
    /** WORLD MAP GO: closes the sheet and flies to the globe. */
    val onWorldMap: () -> Unit = {},
    /** ARMY: the sheet switches to `Army(ARMY)`. */
    val onArmy: () -> Unit = {},
    /** TRAIN (empty camp): `Army(TRAIN)`. */
    val onTrain: () -> Unit = {},
    val onReplay: (String) -> Unit = {},
    /** A stage node (never past the frontier). */
    val onStage: (Int) -> Unit = {},
    val onScout: (Int) -> Unit = {},
    val onCampaignAttack: (Int) -> Unit = {},
    /** MAP: the full campaign map scene (FantasyCampaignScreen). */
    val onOpenCampaignMap: () -> Unit = {},
    /** A defence row's REVENGE / ATTACK BACK (row id). */
    val onRevenge: (String) -> Unit = {},
    /** RECOVER on the march-waiting row (existing flow). */
    val onRecoverMarch: () -> Unit = {},
    /** A SHORT pill: energy → Build shop › SUPPLIES; Shards → Gold Forge › GEMS. */
    val onNeedMore: (PriceUi) -> Unit = {},
    val onRefused: (CommandUi) -> Unit = {},
    val onGo: (FeatureId) -> Unit = {},
)

/**
 * The Raid chooser sheet (raid.png / campaign.png). [campaignMap] is the campaign map renderer's crop for the CAMPAIGN
 * header (the existing FantasyCampaignScreen route art); null draws the header art from [RaidChooserUi.header].
 *
 * Pointer rule: a painted panel inside the SheetHost; no full-screen clickable, pointerInput, scrim or draggable here.
 */
@Composable fun RaidChooserSheet(ui: RaidChooserUi, on: RaidActions, modifier: Modifier = Modifier,
    campaignMap: (@Composable BoxScope.() -> Unit)? = null,
    revengeTab: (@Composable ColumnScope.() -> Unit)? = null,
    revengeFooter: (@Composable ColumnScope.() -> Unit)? = null,
    revengeBadgeCount: Int? = null) {
    val campaignTab = ui.tab == RAID_TAB_CAMPAIGN
    val campaign = ui.campaign
    val footer = ui.footer
    ArmyTallSheet(ui.header, raidTabs(revengeBadgeCount ?: ui.revenge.size), ui.tab, on.onClose, on.onHistory, on.onTab, modifier,
        headerScene = if (campaignTab) campaignMap else null,
        headerChip = if (campaignTab && campaign != null) ({ StarsChip(campaign) }) else ({ EnergyChip(ui.energy) }),
        headerTrailing = if (campaignTab) ({ MapButton(on.onOpenCampaignMap) }) else null,
        footer = if (ui.tab == RAID_TAB_REVENGE) revengeFooter else if (footer == null) null else ({
            if (campaignTab) ArmyFooter(footer, { campaign?.let { on.onCampaignAttack(it.selected.stage) } }, on.onNeedMore, on.onRefused,
                infoWidth = 140.dp, firstInfoColor = ArmyInk.gain, infoColor = PkwTokens.Colors.textOnParch)
            else ArmyFooter(footer, on.onFind, on.onNeedMore, on.onRefused, infoWidth = 96.dp)
        })) {
        ui.marchWaiting?.let { NoticeRow(it, "RECOVER", on.onRecoverMarch) }
        when (ui.tab) {
            RAID_TAB_CAMPAIGN -> CampaignTab(ui, on)
            RAID_TAB_REVENGE -> if (revengeTab != null) revengeTab() else RevengeTab(ui, on)
            else -> MatchTab(ui, on)
        }
    }
}

/** The chip's refill words: "+1 in 38m" only when the server states the refill; "full" at max; null (nothing drawn) when
 *  energy is below max and no refill time was sent (raid.png's "+1 in" is never invented). */
internal fun energyChipLine(e: EnergyUi): String? =
    if (e.now != null && e.max != null && e.now < e.max && e.nextInSec == null) null else energyLine(e.now, e.max, e.nextInSec)

/** A cost pill's tap: only a SHORT pill is a door, and it hands its own [price] to Need-more (energy -> Build shop
 *  SUPPLIES, Shards -> Gold Forge, routed by the host); any other pill is a label, not a button. */
internal fun needMoreTap(price: PriceUi, onNeedMore: (PriceUi) -> Unit): (() -> Unit)? =
    if (price.status == PriceStatus.SHORT) ({ onNeedMore(price) }) else null

/** EnergyPips chip: energy icon, one 12 × 16 pip per point (sky = full, veil-hi = spent) and "+1 in 38m" when known. */
@Composable private fun EnergyChip(e: EnergyUi) {
    val pips = energyPips(e.now, e.max)
    val line = energyChipLine(e)
    Plate(PlateKind.VEIL, Modifier.heightIn(min = 30.dp).clearAndSetSemantics {
        contentDescription = listOfNotNull("Energy ${e.now ?: UNKNOWN} of ${e.max ?: UNKNOWN}", line).joinToString(", ")
    }, contentPadding = PaddingValues(start = 4.dp, top = 2.dp, end = 8.dp, bottom = 2.dp), blocksScene = false) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwIcon("energy", 24.dp)
            if (pips == null) PkwText(UNKNOWN, PkwTokens.Type.body, color = PkwTokens.Colors.text)
            else pips.forEach { full ->
                Box(Modifier.size(12.dp, 16.dp).background(PkwTokens.Colors.ink).padding(2.dp)
                    .background(if (full) PkwTokens.Colors.blue.hi else PkwTokens.Colors.veilHi))
            }
            line?.let { PkwText(it, PkwTokens.Type.body, Modifier.padding(start = 4.dp), color = PkwTokens.Colors.text, outline = 1.dp) }
        }
    }
}

/** campaign.png's chip: star 24 + PS 11 "101" (outlined) + VT 20 "/ 300 stars" in muted, on the header veil. */
@Composable private fun StarsChip(c: CampaignUi) {
    Plate(PlateKind.VEIL, Modifier.heightIn(min = 30.dp).clearAndSetSemantics { contentDescription = "${c.stars} of ${c.maxStars} campaign stars" },
        contentPadding = PaddingValues(start = 4.dp, top = 2.dp, end = 8.dp, bottom = 2.dp), blocksScene = false) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwIcon("star", 24.dp)
            PkwText(c.stars.toString(), PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
            PkwText("/ ${c.maxStars} stars", PkwTokens.Type.body, color = PkwTokens.Colors.muted)
        }
    }
}

/** The blue MAP button (96 × 48) at the CAMPAIGN header's bottom-right: map icon 24 + PS 11 "MAP"; opens the full
 *  campaign map scene (FantasyCampaignScreen). */
@Composable private fun MapButton(onClick: () -> Unit) {
    ChunkyBox(PkwTokens.Colors.blue, onClick, "Open the campaign map", Modifier.size(96.dp, 48.dp)) {
        Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwIcon("map", 24.dp)
            PkwText("MAP", PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

// --- MATCH ------------------------------------------------------------------------------------------------------------

@Composable private fun ColumnScope.MatchTab(ui: RaidChooserUi, on: RaidActions) {
    val c = PkwTokens.Colors
    ArmyCheckRow(ui.army, on)
    if (ui.loading && ui.match == null) SkeletonGrid(1, 2, 96.dp)
    ui.match?.let { MatchCard(it) }
    WorldMapRow(ui.worldMap, on)
    SectionLine("RECENT RAIDS")
    if (ui.recent.isEmpty()) PkwText(if (ui.loading) UNKNOWN else "No raids yet.", PkwTokens.Type.small, color = c.textOnParch2)
    ui.recent.forEach { RecentRaidRow(it, on) }
}

/** ArmyCheckRow (64): "YOUR ARMY 42/50", mini portraits (heroes gold-lo), stone ARMY; empty: blood rim + blue TRAIN. */
@Composable private fun ArmyCheckRow(a: ArmyCheckUi, on: RaidActions) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 64.dp), rim = if (a.empty) c.blood else null, rimWidth = 2.dp,
        padding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText("YOUR ARMY", PkwTokens.Type.caption, color = c.textOnParch)
                    PkwText(readyOfCapacity(a.ready, a.capacity), PkwTokens.Type.caption, color = if (a.empty) c.shortText else ArmyInk.gain)
                }
                if (a.empty) PkwText("No troops ready", PkwTokens.Type.small, color = c.shortText)
                else Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    a.preview.take(5).forEach { MiniPortrait(it) }
                    a.heroesReady.forEach { MiniPortrait(it, hero = true) }
                }
            }
            if (a.empty) SecondaryButton("TRAIN", on.onTrain, Modifier.size(84.dp, 48.dp), verb = Verb.BLUE)
            else SecondaryButton("ARMY", on.onArmy, Modifier.size(84.dp, 48.dp))
        }
    }
}

/** MatchCard: 3 dp red inner rim on the selected tint (#FFF3C8), padding 10; crest well, FIND A MATCH, league + trophies,
 *  the sentence. */
@Composable private fun MatchCard(m: MatchCardUi) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth(), body = c.selectedTint, rim = c.red.face, rimWidth = 3.dp, padding = PaddingValues(10.dp),
        description = "Find a match. ${m.league}, ${m.trophies} trophies. ${m.note}") {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(64.dp).background(c.ink).padding(2.dp).background(ArmyInk.well), contentAlignment = Alignment.Center) { PkwIcon(m.crest, 40.dp) }
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    PkwText("FIND A MATCH", PkwTokens.Type.label, color = c.textOnParch)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText(m.league, PkwTokens.Type.body, color = c.textOnParch)
                        PkwIcon("trophy", 24.dp)
                        PkwText(m.trophies, PkwTokens.Type.caption, color = c.textOnParch)
                    }
                }
            }
            PkwText(m.note, PkwTokens.Type.small, color = c.textOnParch, maxLines = 3)
        }
    }
}

/** WorldMapRow (72): blue well with the map icon, title + sentence, blue GO (routed: a locked row explains). */
@Composable private fun WorldMapRow(cmd: CommandUi, on: RaidActions) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 72.dp), padding = PaddingValues(start = 6.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(52.dp).background(c.ink).padding(2.dp).background(c.blue.face), contentAlignment = Alignment.Center) { PkwIcon(cmd.icon.ifBlank { "map" }, 36.dp) }
            Column(Modifier.weight(1f)) {
                PkwText(cmd.caption, PkwTokens.Type.caption, color = c.textOnParch)
                cmd.sub?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch, maxLines = 2) }
                if (effectiveState(cmd) != CommandState.ENABLED) cmd.reason?.let { PkwText(it, PkwTokens.Type.small, color = c.shortText, maxLines = 2) }
            }
            GoButton({ routeCommand(cmd, on.onWorldMap, on.onNeedMore, on.onRefused) }, "Open the world map", Modifier.size(58.dp, 48.dp))
        }
    }
}

/** RecentRaidRow (56): the shared [RaidRecordRow] (raid.png row grammar, stone replay 58 × 44). */
@Composable private fun RecentRaidRow(r: RaidRecordUi, on: RaidActions) {
    RaidRecordRow(r, on.onReplay)
}

// --- CAMPAIGN ---------------------------------------------------------------------------------------------------------

@Composable private fun ColumnScope.CampaignTab(ui: RaidChooserUi, on: RaidActions) {
    val c = PkwTokens.Colors
    val campaign = ui.campaign
    if (campaign == null) { SkeletonGrid(1, 3, 96.dp); return }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        PkwText(campaign.act.title, PkwTokens.Type.caption, Modifier.weight(1f), color = c.textOnParch)
        PkwText(campaign.act.cleared, PkwTokens.Type.small, color = c.textOnParch2)
    }
    // The chapter line comes from the bundled presentation; without it nothing is drawn (never an invented chapter).
    if (campaign.act.chapter.isNotBlank() || campaign.act.epithet.isNotBlank()) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            PkwText(campaign.act.chapter, PkwTokens.Type.body, color = c.textOnParch)
            PkwText(campaign.act.epithet, PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
        }
    }
    StageRoad(campaign.road, on)
    StageCard(campaign.selected)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SecondaryButton("SCOUT", { on.onScout(campaign.selected.stage) }, Modifier.weight(1f), icon = "scout",
            contentDescription = "Scout ${campaign.selected.title}")
        SecondaryButton(campaign.selected.armyLabel, on.onArmy, Modifier.weight(1f), icon = "ui_icon_warhorn")
    }
    CentredNote("Retries are free. The first 3-star win pays the reward once.")
}

/** The stage road: up to five nodes joined by a 4 dp dashed parch-dk line at the node centre; cleared green with stars,
 *  NEXT gold (bouncing 6 dp: 900 ms then a 2 s pause), locked flat. Locked nodes cannot be selected. */
@Composable private fun StageRoad(road: List<StageNodeUi>, on: RaidActions) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
        road.forEachIndexed { i, node ->
            if (i > 0) DashedRule(Modifier.weight(1f).padding(top = 26.dp, start = 2.dp, end = 2.dp), thickness = 4.dp)
            StageNode(node, on)
        }
    }
}

@Composable private fun StageNode(n: StageNodeUi, on: RaidActions) {
    val c = PkwTokens.Colors
    val big = n.selected || n.state == StageNodeState.NEXT
    val face = when (n.state) { StageNodeState.CLEARED -> c.green.face; StageNodeState.NEXT -> c.gold.face; StageNodeState.LOCKED -> ArmyInk.lockedBody }
    val hi = when (n.state) { StageNodeState.CLEARED -> c.green.hi; StageNodeState.NEXT -> c.gold.hi; StageNodeState.LOCKED -> ArmyInk.lockedBody }
    val selectable = canSelectStage(n)
    val bounce = n.state == StageNodeState.NEXT && !LocalReducedMotion.current && !LocalInspectionMode.current
    val dy: Float = if (!bounce) 0f else {
        val loop = rememberInfiniteTransition(label = "next-node")
        val v by loop.animateFloat(0f, 0f, infiniteRepeatable(keyframes {
            durationMillis = PkwTokens.Motion.READY_BOUNCE_LOOP + PkwTokens.Motion.READY_BOUNCE_PAUSE
            0f at 0
            -6f at PkwTokens.Motion.READY_BOUNCE_LOOP / 2 using PkwTokens.Motion.Out
            0f at PkwTokens.Motion.READY_BOUNCE_LOOP using PkwTokens.Motion.In
        }), label = "next-bounce")
        v
    }
    val spoken = "Stage ${n.stage}, " + when (n.state) {
        StageNodeState.CLEARED -> "cleared, ${n.stars} stars"
        StageNodeState.NEXT -> "next"
        StageNodeState.LOCKED -> "locked"
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(if (big) 60.dp else 52.dp).graphicsLayer { translationY = dy * density }.sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = spoken; role = Role.Button; selected = n.selected
                if (selectable) onClick(label = "Select", action = { on.onStage(n.stage); true })
            }
            .then(if (selectable) Modifier.clickable(role = Role.Button) { on.onStage(n.stage) } else Modifier)
            .drawBehind {
                fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, c.ink)
                val i = 3.dp.toPx()
                fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, face)
                fillStepped(i, i, size.width - i, i + 3.dp.toPx(), CornerProfiles.S, hi)
            }, contentAlignment = Alignment.Center) {
            PkwText(n.stage.toString(), PkwTokens.Type.title,
                color = if (n.state == StageNodeState.LOCKED) c.textOnParch2 else if (n.state == StageNodeState.NEXT) c.textOnParch else c.label,
                outline = if (n.state == StageNodeState.CLEARED) 1.dp else 0.dp)
        }
        when (n.state) {
            StageNodeState.CLEARED -> StarRow(n.stars, 3, 16.dp, gap = 1.dp)
            StageNodeState.NEXT -> PkwText("NEXT", PkwTokens.Type.caption, color = ArmyInk.nextText)
            StageNodeState.LOCKED -> Unit
        }
    }
}

/** StageCard: red inner rim; "STAGE 36" + profile tag + "Keep Lv 8"; name, lore; GARRISON / BRING rows; dashed rule;
 *  the first-3★ reward pill (green body), or "Stars can still be improved." once paid. */
@Composable private fun StageCard(s: StageCardUi) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth(), body = c.selectedTint, rim = c.red.face, padding = PaddingValues(12.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(s.title, PkwTokens.Type.label, color = c.textOnParch)
                Tag(s.profile, if (s.boss) Verb.RED else Verb.STONE)
                Box(Modifier.weight(1f))
                PkwText(s.keepLevel, PkwTokens.Type.small, color = c.textOnParch)
            }
            PkwText(s.name, PkwTokens.Type.lead, color = c.textOnParch)
            PkwText(s.lore, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3)
            PortraitLine("GARRISON", s.garrison, s.garrisonNote)
            PortraitLine("BRING", s.bring, s.bringNote)
            DashedRule(Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StarRow(3, 3, 24.dp)
                if (s.rewardClaimed || s.reward == null) {
                    PkwText("Stars can still be improved.", PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
                } else {
                    PkwText("first 3 stars, once:", PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch)
                    RewardPill(s.reward)
                }
            }
        }
    }
}

@Composable private fun PortraitLine(label: String, portraits: List<String>, note: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwText(label, PkwTokens.Type.caption, Modifier.width(96.dp), color = PkwTokens.Colors.textOnParch)
        portraits.take(3).forEach { MiniPortrait(it) }
        PkwText(note, PkwTokens.Type.small, Modifier.padding(start = 4.dp), color = PkwTokens.Colors.textOnParch)
    }
}

/** The reward cost pill with the green-tinted body (#E9F5D6): ink S rim, 24 dp icon, the amount. "0" only for a server
 *  zero (kit [priceText]). */
@Composable private fun RewardPill(price: PriceUi) {
    Row(Modifier.heightIn(min = PkwTokens.Dims.costPillH).clearAndSetSemantics { contentDescription = "Reward: " + priceDescription(price).removePrefix("Costs ") }
        .drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
            val i = 2.dp.toPx()
            fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, ArmyInk.rewardBody)
        }.padding(start = 3.dp, end = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwIcon(currencyIcon(price.currency, price.icon), PkwTokens.Dims.costPillIcon)
        PkwText(priceText(price).let { if (it == UNKNOWN || it.startsWith("+")) it else "+$it" }, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
    }
}

// --- REVENGE ----------------------------------------------------------------------------------------------------------

@Composable private fun ColumnScope.RevengeTab(ui: RaidChooserUi, on: RaidActions) {
    val c = PkwTokens.Colors
    if (ui.revenge.isEmpty()) {
        if (ui.loading) SkeletonGrid(1, 3, 64.dp)
        else ui.revengeEmpty?.let { EmptyState(it, on.onGo) }
        return
    }
    SectionLine("RAIDS ON YOU", "answer one")
    ui.revenge.forEach { row ->
        ArmyCard(Modifier.fillMaxWidth().heightIn(min = 64.dp), padding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.crest?.let { PkwIcon(it, 32.dp) }
                Column(Modifier.weight(1f).clearAndSetSemantics { contentDescription = "${row.attacker}, ${row.ago}, ${row.stars} stars against you, ${row.lootLost}" }) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PkwText(row.attacker, PkwTokens.Type.body, color = c.textOnParch)
                        StarRow(row.stars, 3, 16.dp, gap = 1.dp)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        PkwText("${row.ago} ·", PkwTokens.Type.small, color = c.textOnParch2)
                        ToneText(row.lootLost, DeltaTone.LOSS)
                    }
                }
                val off = effectiveState(row.action) != CommandState.ENABLED
                SecondaryButton(row.action.caption, { routeCommand(row.action, { on.onRevenge(row.id) }, on.onNeedMore, on.onRefused) },
                    Modifier.width(104.dp), verb = if (off) Verb.OFF else Verb.RED,
                    contentDescription = listOfNotNull(row.action.caption, row.attacker, row.action.reason?.takeIf { off }).joinToString(". "))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------------------------------

internal object RaidSamples {
    private val header = SheetHeaderUi("ATTACK", null, null,
        HeaderArtUi(null, 1, ArmySamples.walkers(listOf("ui_portrait_highlander_t3", "ui_portrait_bowman_t1", "ui_portrait_mage_t1",
            "ui_portrait_tunneler_t1", "ui_portrait_highlander_t3", "ui_portrait_kegrunner_t1"), Dir8.E, 50, start = 60, step = 40) +
            WalkerUi(SpriteRef("hero_vex_idle_f1", 48), Dir8.E, 300, 36, 3)))
    private val campaign = CampaignUi(101, 300, ActUi("ACT 4 · ELDERWOOD", "5 of 10 cleared", "The Rootbound Covenant", "Listen beneath the stone."),
        listOf(StageNodeUi(34, StageNodeState.CLEARED, 2, false), StageNodeUi(35, StageNodeState.CLEARED, 3, false),
            StageNodeUi(36, StageNodeState.NEXT, 0, true), StageNodeUi(37, StageNodeState.LOCKED, 0, false), StageNodeUi(38, StageNodeState.LOCKED, 0, false)),
        StageCardUi(36, "STAGE 36", "OUTPOST", false, "Keep Lv 8", "Dreamwood Passage", "A living network of roots links the abandoned keeps.",
            listOf("ui_portrait_cannon_t2", "ui_portrait_mortar_t2"), "+ 8 more · 11 traps",
            listOf("ui_portrait_kegrunner_t1", "ui_portrait_highlander_t3", "ui_portrait_bowman_t1"), "about 40 pts",
            PriceUi(Currency.SHARDS, "2,400", PriceStatus.OK), rewardClaimed = false, armyLabel = "ARMY 42/50"))
    val match = RaidChooserUi(
        tab = RAID_TAB_MATCH, header = header, energy = EnergyUi(4, 5, 2_280),
        army = ArmyCheckUi(42, 50, listOf("ui_portrait_highlander_t3", "ui_portrait_bowman_t1", "ui_portrait_kegrunner_t1", "ui_portrait_mage_t1",
            "ui_portrait_tunneler_t1"), listOf("hero_vex_portrait"), empty = false),
        match = MatchCardUi("Gold league", "league-gold", "1,284", true, "We pick a base near your trophies. The fastest fight."),
        worldMap = CommandUi(FeatureId("hud.map"), "map", "WORLD MAP", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE,
            sub = "Choose any base on the globe. Scout first."),
        recent = listOf(RaidRecordUi("r1", "Ironjaw", "2h ago", 2, "+8,200 Shards", "+14 trophies", "replay-1"),
            RaidRecordUi("r2", "Saltmere", "1d ago", 0, "defeat", "-9 trophies", "replay-2")),
        campaign = campaign,
        revenge = listOf(DefenceRowUi("d1", "Grimtusk", null, "3h ago", 2, "-4,100 Shards",
            CommandUi(FeatureId("raid.revenge"), "", "REVENGE", null, false, CommandState.ENABLED, null, null, verb = Verb.RED))),
        footer = FooterUi(emptyList(), listOf(PriceUi(Currency.ITEM, "1", PriceStatus.OK, icon = "energy", description = "Costs 1 energy"),
            ArmySamples.shards("120")), ArmySamples.cmd("raid.find", "FIND A MATCH", Verb.RED, icon = "attack")),
        revengeEmpty = EmptyStateUi("shield", "No one to answer.", "Your walls held.", null, null),
    )
    val campaignTab = match.copy(tab = RAID_TAB_CAMPAIGN,
        header = header.copy(title = "CAMPAIGN"),
        footer = FooterUi(listOf("Free · no energy", "Base never at risk"), emptyList(), ArmySamples.cmd("raid.campaign", "ATTACK", Verb.RED, sub = "stage 36")))
}

@Preview(name = "Raid chooser: MATCH (raid.png)", widthDp = 412, heightDp = 915)
@Composable private fun RaidMatchPreview() {
    SheetPreviewFrame(ArmySheetKind.RAID) { RaidChooserSheet(RaidSamples.match, RaidActions(), it) }
}

@Preview(name = "Raid chooser: CAMPAIGN (campaign.png)", widthDp = 412, heightDp = 915)
@Composable private fun RaidCampaignPreview() {
    SheetPreviewFrame(ArmySheetKind.RAID) { RaidChooserSheet(RaidSamples.campaignTab, RaidActions(), it) }
}

@Preview(name = "Raid chooser: REVENGE list and empty", widthDp = 824, heightDp = 915)
@Composable private fun RaidRevengePreview() {
    Row(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.RAID) { RaidChooserSheet(RaidSamples.match.copy(tab = RAID_TAB_REVENGE), RaidActions(), it) } }
        Box(Modifier.weight(1f)) {
            SheetPreviewFrame(ArmySheetKind.RAID) { RaidChooserSheet(RaidSamples.match.copy(tab = RAID_TAB_REVENGE, revenge = emptyList()), RaidActions(), it) }
        }
    }
}

@Preview(name = "Raid chooser: no energy + empty camp + march waiting", widthDp = 412, heightDp = 915)
@Composable private fun RaidBlockedPreview() {
    val ui = RaidSamples.match.copy(energy = EnergyUi(0, 5, 2_280), marchWaiting = "A server-saved march is waiting",
        army = ArmyCheckUi(0, 50, emptyList(), emptyList(), empty = true),
        footer = FooterUi(emptyList(), listOf(PriceUi(Currency.ITEM, "1", PriceStatus.SHORT, icon = "energy", description = "Costs 1 energy, none left"),
            ArmySamples.shards("120")), ArmySamples.cmd("raid.find", "FIND A MATCH", Verb.RED, CommandState.DISABLED,
            reason = "Energy 0 · next in 38m", icon = "attack")))
    SheetPreviewFrame(ArmySheetKind.RAID) { RaidChooserSheet(ui, RaidActions(), it) }
}

@Preview(name = "Raid chooser: searching (busy), PvP off, loading", widthDp = 1236, heightDp = 915)
@Composable private fun RaidStatesPreview() {
    val busy = RaidSamples.match.copy(footer = RaidSamples.match.footer?.copy(primary = ArmySamples.cmd("raid.find", "Finding a base", Verb.RED, CommandState.BUSY)))
    val pvpOff = RaidSamples.match.copy(footer = FooterUi(emptyList(), listOf(PriceUi(Currency.ITEM, null, PriceStatus.UNAVAILABLE, icon = "energy")),
        ArmySamples.cmd("raid.find", "FIND A MATCH", Verb.RED, CommandState.DISABLED, reason = "PVP OFF", icon = "attack")))
    val loading = RaidSamples.match.copy(loading = true, match = null, recent = emptyList(), energy = EnergyUi(null, null, null),
        army = ArmyCheckUi(null, null, emptyList(), emptyList(), empty = false),
        footer = FooterUi(emptyList(), listOf(ArmySamples.shards(null, PriceStatus.CHECKING)), ArmySamples.cmd("raid.find", "FIND A MATCH", Verb.RED, icon = "attack")))
    Row(Modifier.fillMaxSize()) {
        listOf(busy, pvpOff, loading).forEach { ui ->
            Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.RAID) { RaidChooserSheet(ui, RaidActions(), it) } }
        }
    }
}

@Preview(name = "Stage road + card", widthDp = 400, heightDp = 480)
@Composable private fun StageRoadPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val c = RaidSamples.match.campaign!!
        StageRoad(c.road, RaidActions())
        StageCard(c.selected)
        Box(Modifier.size(1.dp).background(Color.Transparent))
    }
}
