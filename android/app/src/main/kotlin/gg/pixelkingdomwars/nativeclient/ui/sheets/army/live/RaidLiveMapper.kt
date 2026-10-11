package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.BattleDomainState
import gg.pixelkingdomwars.nativeclient.model.CampaignStage
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignArtwork
import gg.pixelkingdomwars.nativeclient.ui.attack.campaignReward
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.army.trainingCurrentArmy
import gg.pixelkingdomwars.nativeclient.ui.roster.rosterHeroPortrait
import gg.pixelkingdomwars.nativeclient.ui.attack.campaignSelection
import gg.pixelkingdomwars.nativeclient.ui.attack.opponentLabel
import gg.pixelkingdomwars.nativeclient.ui.attack.pvpAttackShardCost
import gg.pixelkingdomwars.nativeclient.ui.attack.raidChoices
import gg.pixelkingdomwars.nativeclient.ui.attack.raidEntryCostLabel
import gg.pixelkingdomwars.nativeclient.ui.attack.relTime
import gg.pixelkingdomwars.nativeclient.ui.attack.settledLootLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ActUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyCheckUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.CampaignUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.Dir8
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.EnergyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.FooterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeaderArtUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.MatchCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RAID_TAB_CAMPAIGN
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RAID_TAB_MATCH
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RaidChooserUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RaidRecordUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SheetHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SpriteRef
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.StageCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.StageNodeState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.StageNodeUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.WalkerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.readyOfCapacity
import kotlinx.serialization.json.JsonObject

/*
 * Live mapper of the Raid chooser's MATCH and CAMPAIGN tabs: what AttackScreen receives today (`BattleDomainState`, the
 * Home `BaseState`, land ownership, the catalogue constants) -> the Opus `RaidChooserUi`. The PvP entry ante is the
 * catalogue table `raidEntryCostLabel` reads (energy + Shards, no KEEP / Gems); a pack without it keeps FIND A MATCH
 * DISABLED "PVP ENTRY COST UNKNOWN", exactly like the current chooser. REVENGE uses the shared BattleRecord mapper in BattleLogLiveMapper; its row ids preserve replay authority.
 * CAMPAIGN names its act, chapter and stages from the bundled presentation (CampaignPresentationLive.kt) when it is
 * available; progress, rewards and unlocks stay the server's. A SHORT pill hands its own PriceUi to `onNeedMore`, which
 * the Home mount routes by the pill (energy -> Build shop SUPPLIES, Shards -> Gold Forge).
 */

/** A decorative header and army summary from the existing selected-base read, never the sample formation. */
internal data class RaidArmyPreview(val army: ArmyCheckUi, val walkers: List<WalkerUi>)

internal fun raidArmyPreview(state: ArmyUiState?, selectedBaseId: String?, baseGeneration: Long?): RaidArmyPreview? {
    if (state == null || selectedBaseId == null || baseGeneration == null || state.baseId != selectedBaseId ||
        state.home.base?.baseId != selectedBaseId) return null
    val army = trainingCurrentArmy(state, baseGeneration) ?: return null
    val countsKnown = army.raw["counts"] is JsonObject && army.counts.values.all { it >= 0 }
    val order = (state.trainTable + army.counts.keys).distinct()
    val portraits = if (!countsKnown) emptyList() else order.filter { (army.counts[it] ?: 0) > 0 }
        .map { armyPortrait(state.catalogue, it, army.levels[it]) }
    // The roster's available field has a legacy true default. Require this Home snapshot's explicit readiness too;
    // a stale roster must not put a recovering hero into the next army or silently revive it after a base switch.
    val homeHeroes = state.home.base?.raw?.objects("heroes").orEmpty()
    val heroes = state.domain.heroes?.takeIf { state.domain.heroesBaseId == selectedBaseId }?.heroes.orEmpty()
        .filter { it.recruited && it.available }
        .mapNotNull { hero ->
            val current = homeHeroes.firstOrNull { it.string("hero") == hero.hero && it.string("available") == "true" }
                ?: return@mapNotNull null
            rosterHeroPortrait(state.catalogue, hero.hero, current.string("level")?.toIntOrNull()).takeIf { it.isNotBlank() }
        }.distinct()
    val ready = army.rosterPts.takeIf { army.raw.containsKey("rosterPts") && it >= 0 }
    val capacity = army.campCapacityPts.takeIf { army.raw.containsKey("campCapacityPts") && it >= 0 }
    val summary = ArmyCheckUi(ready, capacity, portraits.take(5), heroes,
        empty = countsKnown && army.counts.values.none { it > 0 } && heroes.isEmpty())
    val walkers = troopWalkers(portraits.take(4), Dir8.E, 44, startDp = 12, stepDp = 52) +
        heroes.take(2).mapIndexed { index, portrait ->
            WalkerUi(SpriteRef(portrait, 48), Dir8.E, (if (heroes.size > 1) 248 else 300) + index * 76, 36, 3)
        }
    return RaidArmyPreview(summary, walkers)
}

/** The landless / onboarding default tab, in the native `raidChoices` order (CAMPAIGN leads for a landless keep). */
internal fun raidDefaultTab(landOwned: Boolean, onboarding: Boolean): String =
    if (raidChoices(landOwned, onboarding).first().id == "campaign") RAID_TAB_CAMPAIGN else RAID_TAB_MATCH

/** The five road nodes around [selected] (clamped to the list), states from the server's stars / unlocks. */
internal fun stageRoad(stages: List<CampaignStage>, selected: Int): List<StageNodeUi> {
    if (stages.isEmpty()) return emptyList()
    val index = stages.indexOfFirst { it.stage == selected }.coerceAtLeast(0)
    val start = (index - 2).coerceIn(0, (stages.size - 5).coerceAtLeast(0))
    return stages.drop(start).take(5).map { s ->
        val state = when { s.bestStars > 0 -> StageNodeState.CLEARED; s.unlocked -> StageNodeState.NEXT; else -> StageNodeState.LOCKED }
        StageNodeUi(s.stage, state, s.bestStars.coerceIn(0, 3), s.stage == selected)
    }
}

/** The selected stage's card. Garrison / bring portraits are not in the campaign read: their notes carry the server's
 *  threat line and recommended points instead (never invented portraits). With the bundled [artwork] the name is the
 *  presentation's stage name (SPEC §6: falls back to the catalogue name) and a stage without a server tactic reads its
 *  chapter's lore; without it the card is exactly the server's. */
internal fun stageCard(stage: CampaignStage, constants: JsonObject?, ready: Int?, capacity: Int?,
    artwork: CampaignArtwork? = null, perAct: Int? = null): StageCardUi {
    val profile = stage.profile?.replace('_', ' ')?.uppercase() ?: UNKNOWN
    val reward = campaignReward(constants, stage)?.let { shardsPrice(it) }
    val chapter = artwork?.chapter(stage)
    return StageCardUi(stage.stage, "STAGE ${stage.stage}", profile, boss = profile.contains("BOSS"),
        keepLevel = stage.keepLevel?.let { "Keep Lv $it" } ?: "Keep Lv $UNKNOWN", name = artwork?.name(stage, perAct) ?: stage.name,
        lore = stage.tactic?.takeIf { it.isNotBlank() } ?: chapter?.lore ?: "", garrison = emptyList(), garrisonNote = stage.threat ?: "",
        bring = emptyList(), bringNote = stage.recommendedArmyPoints?.let { "about $it pts" } ?: "about $UNKNOWN pts",
        reward = reward, rewardClaimed = stage.firstThreeStarClaimed, armyLabel = "ARMY ${readyOfCapacity(ready, capacity)}")
}

/** The act header (campaign.png): "ACT 4 · ELDERWOOD" + the chapter's name and epithet from the bundled presentation's
 *  chapter whose id is the stage's act. An act the presentation does not know keeps "ACT n" and a blank chapter line. */
internal fun actHeader(stage: CampaignStage, cleared: String, artwork: CampaignArtwork?): ActUi {
    val act = stage.act ?: return ActUi("CAMPAIGN", cleared, "", "")
    val chapter = artwork?.chapter(stage)
    val region = chapter?.let { artwork?.regions?.get(it.region) }?.name?.takeIf { it.isNotBlank() }
    return ActUi(if (region != null) "ACT $act · ${region.uppercase()}" else "ACT $act", cleared, chapter?.name ?: "", chapter?.epithet ?: "")
}

/** The CAMPAIGN tab; null while the selected base's campaign has not been read (skeletons). */
internal fun campaignLiveUi(stages: List<CampaignStage>, selected: Int?, constants: JsonObject?, ready: Int?, capacity: Int?,
    artwork: CampaignArtwork? = null, perAct: Int? = null): CampaignUi? {
    val chosen = campaignSelection(stages, selected) ?: return null
    val act = chosen.act
    val inAct = if (act == null) stages else stages.filter { it.act == act }
    val cleared = inAct.count { it.bestStars > 0 }
    return CampaignUi(stages.sumOf { it.bestStars.coerceIn(0, 3) }, stages.size * 3,
        actHeader(chosen, "$cleared of ${inAct.size} cleared", artwork),
        stageRoad(stages, chosen.stage), stageCard(chosen, constants, ready, capacity, artwork, perAct))
}

/** The footer of MATCH (energy + Shards pills, red FIND A MATCH with the attack icon) and CAMPAIGN (free, red ATTACK).
 *  [shardsBalance] is the Home read's exact Shards balance: below the catalogue ante the Shards pill is SHORT, so its tap
 *  opens Need-more (Gold Forge); an unknown balance keeps the pill as it was (the server stays the gate). */
internal fun raidFooter(tab: String, constants: JsonObject?, keepLevel: Int?, energyFree: Int?, campaign: CampaignUi?, stages: List<CampaignStage>,
    busy: Boolean, actionsAllowed: Boolean, shardsBalance: String? = null): FooterUi {
    val blocked = ordersBlockedReason(true, actionsAllowed)
    if (tab == RAID_TAB_CAMPAIGN) {
        val stage = campaign?.selected?.stage
        val row = stages.firstOrNull { it.stage == stage }
        val primary = when {
            row == null -> liveCommand(ArmyLiveIds.CAMPAIGN_ATTACK, "ATTACK", CommandState.DISABLED, "The campaign is still loading.", verb = Verb.RED)
            busy -> liveCommand(ArmyLiveIds.CAMPAIGN_ATTACK, "ATTACK", CommandState.BUSY, verb = Verb.RED)
            !row.unlocked -> liveCommand(ArmyLiveIds.CAMPAIGN_ATTACK, "ATTACK", CommandState.LOCKED, "Clear the stage before it first.", verb = Verb.RED)
            blocked != null -> liveCommand(ArmyLiveIds.CAMPAIGN_ATTACK, "ATTACK", CommandState.DISABLED, blocked, verb = Verb.RED)
            else -> liveCommand(ArmyLiveIds.CAMPAIGN_ATTACK, if (row.bestStars > 0) "REPLAY" else "ATTACK", CommandState.ENABLED,
                verb = Verb.RED, sub = "stage ${row.stage}")
        }
        return FooterUi(listOf("Free · no energy", "Base never at risk"), emptyList(), primary)
    }
    val label = raidEntryCostLabel(constants, keepLevel)
    val perRaid = (constants?.get("RAID_ENERGY") as? JsonObject)?.string("perRaid")
    // Energy is an integer count. Compare the catalogue's exact positive cost without narrowing it to Int;
    // missing or malformed facts cannot establish affordability. The existing entry/action gate stays below.
    val energyCost = perRaid?.takeIf { it.matches(Regex("[1-9][0-9]*")) }?.toBigIntegerOrNull()
    val energyStatus = when {
        energyCost == null -> PriceStatus.UNAVAILABLE
        energyFree == null || energyFree < 0 -> PriceStatus.CHECKING
        energyFree.toBigInteger() < energyCost -> PriceStatus.SHORT
        else -> PriceStatus.OK
    }
    val pills = if (label == null) emptyList() else listOfNotNull(
        perRaid?.let { PriceUi(Currency.ITEM, it, energyStatus, icon = "energy", description = when (energyStatus) {
            PriceStatus.UNAVAILABLE -> "Energy cost unavailable."
            PriceStatus.CHECKING -> "$it energy. Checking available energy."
            PriceStatus.SHORT -> "$it energy. Not enough energy."
            else -> "$it energy"
        }) },
        shardsAntePrice(pvpAttackShardCost(constants, keepLevel), shardsBalance),
    )
    val primary = when {
        busy -> liveCommand(ArmyLiveIds.FIND_MATCH, "FIND A MATCH", CommandState.BUSY, verb = Verb.RED, sub = "Finding a base", icon = "attack")
        label == null -> liveCommand(ArmyLiveIds.FIND_MATCH, "FIND A MATCH", CommandState.DISABLED, "PVP ENTRY COST UNKNOWN", verb = Verb.RED, icon = "attack")
        blocked != null -> liveCommand(ArmyLiveIds.FIND_MATCH, "FIND A MATCH", CommandState.DISABLED, blocked, verb = Verb.RED, icon = "attack")
        else -> liveCommand(ArmyLiveIds.FIND_MATCH, "FIND A MATCH", CommandState.ENABLED, verb = Verb.RED, icon = "attack")
    }
    return FooterUi(if (label == null) listOf("PVP OFF") else emptyList(), pills, primary)
}

/** The Shards ante pill: the catalogue amount ([shardsPrice]), SHORT only when the Home read's exact [balance] is known
 *  and below it. Never a price this client made up; an unknown cost stays CHECKING ("…"). */
internal fun shardsAntePrice(cost: String?, balance: String?): PriceUi {
    val price = shardsPrice(cost)
    if (price.status != PriceStatus.OK) return price
    val need = cost?.toBigDecimalOrNull() ?: return price
    val have = balance?.toBigDecimalOrNull() ?: return price
    return if (have < need) price.copy(status = PriceStatus.SHORT, description = "${price.amount} Shards. Not enough Shards.") else price
}

/** MATCH card and WORLD MAP sentences of raid.png for a landowner; a landless keep keeps the native copy (SPEC §6). */
internal const val MATCH_NOTE_LANDOWNER = "We pick a base near your trophies. The fastest fight."
internal const val WORLD_MAP_SUB_LANDOWNER = "Choose any base on the globe. Scout first."

/** What AttackScreen receives -> the Raid chooser on [tab] (MATCH or CAMPAIGN). [selectedStage] is the sheet's own
 *  stage pick (never past the frontier: only unlocked nodes can be picked). [campaignArt] is the bundled campaign
 *  presentation ([rememberCampaignPresentation]); null keeps the server's stage names and a blank chapter line. */
internal fun raidLiveUi(tab: String, battle: BattleDomainState, home: BaseState?, selectedBaseId: String?, landOwned: Boolean, onboarding: Boolean,
    constants: JsonObject?, nowMs: Long, selectedStage: Int?, busy: Boolean, actionsAllowed: Boolean,
    armyState: ArmyUiState? = null, baseGeneration: Long? = null, campaignArt: CampaignArtwork? = null): RaidChooserUi {
    val base = home?.base?.takeIf { selectedBaseId == null || it.baseId == selectedBaseId }
    val energy = base?.energy
    val status = base?.armyStatus
    val liveArmy = raidArmyPreview(armyState, selectedBaseId, baseGeneration)
    val army = liveArmy?.army ?: ArmyCheckUi(status?.readyPts, status?.campCapacityPts, emptyList(), emptyList(),
        empty = status != null && status.readyTroopCount == 0)
    val stages = battle.campaign?.takeIf { selectedBaseId == null || it.baseId == selectedBaseId }?.stages.orEmpty()
    val campaign = campaignLiveUi(stages, selectedStage, constants, army.ready, army.capacity, campaignArt, campaignPerAct(constants))
    val auto = raidChoices(landOwned, onboarding).first { it.id == "auto" }
    val map = raidChoices(landOwned, onboarding).first { it.id == "map" }
    val history = battle.history.takeIf { selectedBaseId == null || it.baseId == selectedBaseId }
    // raid.png draws two RECENT RAIDS rows; the Battle log's ATTACK tab holds the rest.
    val recent = history?.deed.orEmpty().filter { it.role == "attacker" }.take(2).map { attackLiveRow(it, nowMs) }
    val player = base?.player
    return RaidChooserUi(
        tab = tab,
        // campaign.png titles the sheet CAMPAIGN on its own tab; raid.png and raid-revenge.png say ATTACK.
        header = SheetHeaderUi(if (tab == RAID_TAB_CAMPAIGN) "CAMPAIGN" else "ATTACK", null, null, HeaderArtUi(null, 1, liveArmy?.walkers.orEmpty())),
        // The server sends no refill time: the chip draws the pips only, never an invented "+1 in".
        energy = EnergyUi(energy?.free, energy?.max, null),
        army = army,
        match = MatchCardUi(player?.league?.replaceFirstChar { it.uppercase() }?.let { "$it league" } ?: UNKNOWN,
            player?.league?.let { "league-${it.lowercase()}" } ?: "attack",
            groupedAmount(player?.trophies) ?: UNKNOWN, landOwned, if (landOwned) MATCH_NOTE_LANDOWNER else auto.sub),
        worldMap = liveCommand(ArmyLiveIds.WORLD_MAP, map.title, CommandState.ENABLED, primary = false, verb = Verb.BLUE,
            sub = if (landOwned) WORLD_MAP_SUB_LANDOWNER else map.sub, icon = "map"),
        recent = recent,
        campaign = campaign,
        revenge = emptyList(),
        footer = raidFooter(tab, constants, player?.keepLevel, energy?.free, campaign, stages, busy, actionsAllowed,
            shardsBalance = home?.balances?.shards?.takeIf { base != null }),
        marchWaiting = if (history?.pending?.isNotEmpty() == true) "A server-saved march is waiting." else null,
        loading = (tab == RAID_TAB_CAMPAIGN && campaign == null) && (battle.loading || battle.campaign == null),
    )
}
