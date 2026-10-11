package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.network.basePurchaseOffer
import gg.pixelkingdomwars.nativeclient.network.expansionOffer
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.NamePlateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.shortfall
import kotlinx.serialization.json.JsonObject

/*
 * The Home command-bar adapter (UX-ARCHITECTURE §3; MOUNT-COMMAND.md; lead rulings 001dc59c / 281b1c34 B4-B5), drawn to
 * design final/buildings/SPEC.md §1 (1.3 layout, 1.4 per-type rows, 1.5 states, 1.6 data) and selected.png,
 * buildings/commands-1..5.png and buildings/states.png.
 *
 * Existing commands are read from [BuildingGates] (the gate and price copy the current BuildingSheet itself uses,
 * never a second derivation), the ids are the canonical UX-ARCHITECTURE §6.2 row ids, and [routeBuildingCommand] forwards each id to
 * an EXISTING owner callback. No spend path lives here: UPGRADE opens the review sheet, REARM / COLLECT / FINISH call
 * exactly what the sheet's footer called, EXPAND opens the Expand half sheet whose owner raises the Seal. The plate line,
 * badges and primary values come from BuildingBarFacts.kt (server or catalogue state only). b47d0a95 adds the Phase E
 * doors by borrowing C3's registry projection and single live door; it does not replace the existing command or spend owners.
 */

/** Which form of the current BuildingSheet is open behind the bar: INFO (stats, job + CANCEL, codex; no actions) or
 * FULL (the review UPGRADE / REARM open: the same sheet as before the mount, with its action footer). */
internal enum class BuildingSheetMode { INFO, FULL }

internal object BuildingCommandIds {
    val INFO = FeatureId("building.info")
    val UPGRADE = FeatureId("building.upgrade")
    val FINISH = FeatureId("building.finish")
    val REARM = FeatureId("trap.rearm")
    val TRAIN = FeatureId("barracks.train")
    val RESEARCH = FeatureId("forge.research")
    val ARMY = FeatureId("camp.army")
    val FORGE = FeatureId("goldforge.open")
    val COLLECT = FeatureId("mine.collect")
    val HERO_VEX = FeatureId("hero.vex")
    val HERO_THEODOR = FeatureId("hero.theodor")
    val ROW = FeatureId("wall.row")
    /** ROW mode's UPGRADE ROW. TODO(MS-C2): §6.2 has no own row for it (row 51 says "row mode -> WallRowQuote"). */
    val ROW_UPGRADE = FeatureId("wall.rowUpgrade")
    /** Keep STORES (§6.2 row 33): the Keep stores sheet. */
    val STORES = FeatureId("keep.stores")
    /** Keep EXPAND (§6.2 row 34): the Expand half sheet; its owner raises the SOL Seal. */
    val EXPAND = FeatureId("keep.expand")
    /** Hero Altar / Siege Stool GEAR (§6.2 row 46): the Heroes sheet on its GEAR tab. */
    val GEAR = FeatureId("hero.gear")
    /** Clan Hall CLAN (§6.2 row 47). */
    val CLAN = FeatureId("clan.open")
}

private val HERO_TYPES = setOf("heroaltar", "siegestool")

/** Why a spend command is off right now; the bar shows it in its reason pill (a DISABLED command must carry one). */
private fun blockedReason(state: KingdomUiState, busy: Boolean): String = when {
    !state.ordersAllowed || !state.deedActionsAllowed -> "Orders are paused here"
    state.constructionBlocked -> "Check the saved payment first"
    busy -> "Working…"
    else -> "Not available now"
}

private fun command(id: FeatureId, icon: String, caption: String, enabled: Boolean, reason: String?, primary: Boolean = false,
    price: PriceUi? = null, verb: Verb = Verb.STONE, sub: String? = null, badge: BadgeUi? = null) = CommandUi(id, icon, caption, price, primary,
    if (enabled) CommandState.ENABLED else CommandState.DISABLED, if (enabled) null else reason, badge, verb, sub)

/** A building still being built (SPEC §1.5 "Under construction": INFO · FINISH only). */
private fun underConstruction(building: Building, job: BaseJob?): Boolean = building.underConstruction || job?.kind == "build"

/**
 * The bar of one selected building, left to right: INFO, the secondaries, the primary last (SPEC §1.4; the kit bar
 * re-orders and trims to 4 in portrait with `orderCommands`). Existing states and prices come from [gates]; the plate
 * facts, badges and primary values from [extras] and BuildingBarFacts.kt; Phase E doors from C3 ([phaseE]). [sent] is the
 * id of the in-place order this bar last sent (COLLECT or REARM): that command shows its busy dots while [busy].
 */
internal fun buildingCommandBar(state: KingdomUiState, building: Building, gates: BuildingGates, busy: Boolean, now: Long,
    phaseE: PhaseEBuildingCommands? = null, extras: BuildingBarExtras = BuildingBarExtras(), sent: FeatureId? = null): CommandBarUi {
    val blocked = blockedReason(state, busy)
    val job = gates.job
    val repair = gates.repair
    val type = building.type
    val use = buildingUse(type)
    val rowMode = type == "wall" && state.local.wallRow
    val construction = underConstruction(building, job)
    val phaseEType = phaseEBuildingFeature(type) != null
    val list = mutableListOf(command(BuildingCommandIds.INFO, "info", "INFO", enabled = true, reason = null, verb = Verb.BLUE))
    if (construction) {
        job?.let { list += finishCommand(state, it, gates, blocked, now) }
        return mergePhaseEBuildingCommands(CommandBarUi(building.id, list), building,
            phaseEBuildingSelection(state.base?.baseId, building), phaseE, phaseEFact(type, extras))
    }
    // The gate's own rule (a catalogue cost for the next level, no job, not spent): at max level there is no UPGRADE.
    val upgradeShown = gates.canShowUpgrade
    // The Keep's own doors (commands-1): STORES, then EXPAND priced in SOL. At max level STORES takes the primary.
    if (type == "keep") {
        list += command(BuildingCommandIds.STORES, "bag", "STORES", true, null, primary = !upgradeShown && job == null)
        expandCommand(state)?.let { list += it }
    }
    if (type in HERO_TYPES) list += command(BuildingCommandIds.GEAR, "itm_helm", "GEAR", true, null,
        badge = if (extras.gearNew) BadgeUi("NEW", BadgeTone.REWARD, "New gear in the bag") else null)
    if (type == "wall") list += command(BuildingCommandIds.ROW,
        state.catalogue?.let { sheetBuildingPortrait(it, "wall", building.level) } ?: "shape:plus",
        if (rowMode) "SINGLE" else "ROW", enabled = !busy, reason = blocked)
    val fact = when (type) {
        "barracks" -> barracksBarFact(state, now)
        "camp" -> campBarFact(state)
        "forge" -> extras.research
        "mine" -> mineBarFact(state)
        "goldforge" -> extras.goldForge
        else -> null
    }
    val primaryIsUse = job == null && repair == null && !rowMode && use != null
    fun useCommand(primary: Boolean): CommandUi? = when (use) {
        BuildingUse.TRAIN -> command(BuildingCommandIds.TRAIN, "army", "TRAIN", true, null, primary, badge = fact?.badge)
        BuildingUse.RESEARCH -> command(BuildingCommandIds.RESEARCH, fact?.icon ?: "energy", "RESEARCH", true, null, primary)
            .copy(timer = fact?.timer)
        BuildingUse.ARMY -> command(BuildingCommandIds.ARMY, "army", "ARMY", true, null, primary).copy(meter = fact?.progress)
        BuildingUse.FORGE -> command(BuildingCommandIds.FORGE, "keep", "FORGE", true, null, primary, badge = fact?.badge)
        BuildingUse.HERO -> command(if (type == "heroaltar") BuildingCommandIds.HERO_VEX else BuildingCommandIds.HERO_THEODOR,
            if (type == "heroaltar") "hero_vex_portrait" else "hero_theo_portrait", "HERO", true, null, primary)
        BuildingUse.COLLECT -> {
            val mining = state.home.mine?.mining
            if (sent == BuildingCommandIds.COLLECT && busy) CommandUi(BuildingCommandIds.COLLECT, "shards", "COLLECT", null, primary,
                CommandState.BUSY, null, fact?.badge, value = fact?.value)
            else command(BuildingCommandIds.COLLECT, "shards", "COLLECT", gates.enabled && mining != null,
                if (mining == null) (if (busy) "Loading mining…" else "Mining unavailable") else blocked, primary, badge = fact?.badge)
                .copy(value = fact?.value)
        }
        null -> null
    }
    // While a builder job runs the type's action stays visible but off, and says why (SPEC §1.5 Upgrading).
    if (use != null && job != null && !rowMode) useCommand(false)?.let {
        list += it.copy(state = CommandState.DISABLED, reason = "${sentenceName(trayLabel(type))} is ${if (job.kind == "upgrade") "upgrading" else "busy"}")
    }
    // Clan Hall: its own job is CLAN (gold), so UPGRADE is a secondary there.
    val clanPrimary = type == "clanhall" && job == null && repair == null
    if (upgradeShown) list += upgradeCommand(state, gates, blocked, primary = use == null && !phaseEType && type != "clanhall")
    if (type == "clanhall") list += command(BuildingCommandIds.CLAN, "itm_banner", "CLAN", true, null, primary = clanPrimary)
    when {
        job != null -> list += finishCommand(state, job, gates, blocked, now)
        repair != null -> list += rearmCommand(state, building, gates, busy, sent, blocked)
        rowMode -> list += command(BuildingCommandIds.ROW_UPGRADE, "shape:up", "UPGRADE", !busy && !state.wallRowBlocked && state.ordersAllowed && state.deedActionsAllowed,
            if (state.wallRowBlocked) "Resolve the saved row purchase first" else blocked, primary = true, verb = Verb.GREEN)
        primaryIsUse -> useCommand(true)?.let { list += it }
    }
    val merged = mergePhaseEBuildingCommands(CommandBarUi(building.id, list), building,
        phaseEBuildingSelection(state.base?.baseId, building), phaseE, phaseEFact(type, extras))
    // A Phase E building whose door is not projected keeps UPGRADE as its primary (the bar before C3 was mounted).
    if (merged.commands.any { it.primary }) return merged
    return merged.copy(commands = merged.commands.map {
        if (it.id == BuildingCommandIds.UPGRADE && phaseEType) it.copy(primary = true) else it
    })
}

/** The Phase E door's fact for [type] (commands-4 / commands-5): badge, COLLECT caption, value, timer. */
private fun phaseEFact(type: String, extras: BuildingBarExtras): BarDoorFact? = when (type) {
    "workshop" -> extras.workshop
    "lodge" -> extras.lodge
    "market" -> extras.market
    "harvester" -> extras.harvester
    "berth" -> extras.berth
    else -> null
}

/** UPGRADE: green always (SPEC §1.3: green primary on Keep / defences / walls, green secondary elsewhere) with the
 *  catalogue Shards price. The pill goes SHORT only when the known Shards balance is below the cost; an unknown balance
 *  is never SHORT. A SOL step keeps its Shards pill and says SOL follows in the review. */
private fun upgradeCommand(state: KingdomUiState, gates: BuildingGates, blocked: String, primary: Boolean): CommandUi {
    val sol = gates.upgradeSol?.takeIf { it > 0 }
    val amount = gates.upgradeCost?.let(::fmtN)
    val seconds = (if (sol != null) gates.paidOffer?.seconds?.toLongOrNull() else gates.price?.seconds?.toLongOrNull())
    val short = amount != null && shortfall(state.home.balances?.shards, gates.upgradeCost) != null
    val price = PriceUi(Currency.SHARDS, amount, when { amount == null -> PriceStatus.CHECKING; short -> PriceStatus.SHORT; else -> PriceStatus.OK },
        description = if (sol != null && amount != null) "$amount Shards plus SOL, review before paying" else null)
    return command(BuildingCommandIds.UPGRADE, "shape:up", "UPGRADE",
        gates.enabled && (if (sol != null) gates.paidOffer != null else gates.price != null), blocked,
        primary = primary, price = price, verb = Verb.GREEN, sub = seconds?.let { fmtDur(it) })
}

/** FINISH (SPEC §1.5): the time left drawn beside the icon. Gems are shown only once the server's own review terms for
 *  THIS job say Gems (`builderFinishReviewTerms`, amount = its `maxCostKeep`); before that there is no currency and no
 *  pill, never a guessed Gems or KEEP price. */
private fun finishCommand(state: KingdomUiState, job: BaseJob, gates: BuildingGates, blocked: String, now: Long): CommandUi {
    val canFinish = gates.finishPrice == "0" || builderFinishCanReview(job)
    val terms = builderFinishReviewTerms(state)?.takeIf { it.jobId == job.id && it.expectedCurrency == GameCurrency.GEMS }
    val price = terms?.let { PriceUi(Currency.GEMS, fmtN(it.consent.maxCostKeep), PriceStatus.OK) }
    return command(BuildingCommandIds.FINISH, if (price != null) "gem-32" else "timer", "FINISH", gates.enabled && canFinish,
        if (!canFinish) "Finish price unavailable" else blocked, primary = true, price = price,
        sub = if (price == null && builderFinishCanReview(job)) "Price shown in review" else null)
        .copy(value = jobSecondsLeft(job, now)?.let(::fmtDur) ?: UNKNOWN)
}

/** REARM (commands-3): gold primary with the catalogue rearm price; SHORT when the known Shards balance is below it;
 *  busy dots only while this bar's own REARM is in flight. */
private fun rearmCommand(state: KingdomUiState, building: Building, gates: BuildingGates, busy: Boolean, sent: FeatureId?,
    blocked: String): CommandUi {
    val repair = requireNotNull(gates.repair)
    val cost = repair.costShards.toString()
    val short = shortfall(state.home.balances?.shards, cost) != null
    val icon = state.catalogue?.let { sheetBuildingPortrait(it, building.type, building.level) } ?: "shape:hammer"
    val price = PriceUi(Currency.SHARDS, fmtN(repair.costShards), if (short) PriceStatus.SHORT else PriceStatus.OK)
    if (sent == BuildingCommandIds.REARM && busy) return CommandUi(BuildingCommandIds.REARM, icon, "REARM", price, true,
        CommandState.BUSY, null, null, sub = fmtDur(repair.repairSec))
    return command(BuildingCommandIds.REARM, icon, "REARM", gates.enabled, blocked, primary = true, price = price,
        sub = fmtDur(repair.repairSec))
}

/** Keep EXPAND (commands-1): the SOL pill of the catalogue's next ring (`basePurchaseOffer(.., "expansion")`, the offer the
 *  Expand sheet and its Seal use). Omitted once every ring is bought; UNAVAILABLE (off, with why) without an offer. */
private fun expandCommand(state: KingdomUiState): CommandUi? {
    val base = state.base
    val catalogue = state.catalogue
    val expansions = base?.player?.expansions
    val max = ((catalogue?.get("constants") as? JsonObject)?.get("CAPS") as? JsonObject)?.string("expansionsMax")?.toIntOrNull()
    if (expansions != null && max != null && expansions >= max) return null
    val offer = if (base != null && catalogue != null) basePurchaseOffer(catalogue, base, "expansion") else null
    val price = offer?.let { PriceUi(Currency.SOL, basePurchaseSol(it.amountLamports), PriceStatus.OK) }
        ?: PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE)
    val readOnly = !state.ordersAllowed || !state.deedActionsAllowed
    val required = if (offer == null && catalogue != null && expansions != null) expansionOffer(catalogue, expansions)?.requiredKeepLevel else null
    val keepLevel = base?.player?.keepLevel
    val reason = when {
        readOnly -> "Orders are paused here"
        offer != null -> null
        required != null && keepLevel != null && keepLevel < required -> "Needs Keep Lv $required"
        else -> "Land expansion is unavailable right now"
    }
    return CommandUi(BuildingCommandIds.EXPAND, "itm_deed_earth", "EXPAND", price, false,
        if (readOnly) CommandState.DISABLED else CommandState.ENABLED, reason, null)
}

/** The plate over the selected building (SPEC §1.5 / §1.6): name, level tag ("LV 3", "NEW" gold, "LV 2>3", "MAX"), one
 *  state line, and the meter (striped green while built, green for upgrades and the camp fill, blue for working jobs).
 *  With [state] the plate carries the type's line from BuildingBarFacts.kt; without it, only the job and spent lines. */
internal fun buildingNamePlate(building: Building, gates: BuildingGates, now: Long, state: KingdomUiState? = null,
    extras: BuildingBarExtras = BuildingBarExtras()): NamePlateUi {
    val job = gates.job
    val construction = underConstruction(building, job)
    val left = job?.let { jobSecondsLeft(it, now) }?.let(::fmtDur) ?: UNKNOWN
    val jobProgress = job?.let { baseJobProgress(it.startedAt, it.finishesAt, now)?.fraction }
    val maxed = !construction && gates.level >= gates.max
    val doing = when (job?.kind) { "build" -> "Building"; "upgrade" -> "Upgrading"; "clear_obstacle" -> "Clearing"; null -> null; else -> "Working" }
    val fact = if (job == null && gates.repair == null && !construction && state != null) buildingBarFact(state, building, extras, now) else null
    val line = when {
        construction -> "Building · $left"
        doing != null -> "$doing · $left"
        gates.repair != null -> "Spent · rearm it"
        else -> fact?.stateLine ?: if (maxed) "Max level" else null
    }
    val level = when {
        construction -> "NEW"
        job?.kind == "upgrade" -> "LV ${gates.level}>${gates.level + 1}"
        maxed -> "MAX"
        else -> "LV ${gates.level}"
    }
    val progress = if (job != null) jobProgress else fact?.progress
    return NamePlateUi(trayLabel(building.type).uppercase(), level, line, progress,
        levelVerb = if (construction) Verb.GOLD else null,
        progressVerb = if (job == null && fact?.progress != null && building.type != "camp") Verb.BLUE else Verb.GREEN,
        progressStriped = construction && progress != null)
}

/** The existing owner callbacks, one per command. The first eleven are the BuildingSheet's own; the rest were added with
 *  the designed bar (2026-10-06). Their defaults keep an older caller compiling and never leave a dead door: an unwired
 *  door explains itself through [explain]. TODO(MS-C2): replace with the registry dispatcher. */
internal class BuildingCommandRoutes(
    val info: () -> Unit, val review: () -> Unit, val finish: () -> Unit, val collect: () -> Unit,
    val train: () -> Unit, val research: () -> Unit, val army: () -> Unit, val forge: () -> Unit, val heroes: () -> Unit,
    val toggleRow: () -> Unit, val quoteRow: () -> Unit,
    /** Shows a short reason (a toast): a LOCKED command's requirement, an unwired door. Defaults to the app toast queue. */
    val explain: (String) -> Unit = { Toasts.post(it) },
    val stores: () -> Unit = { explain("Keep stores are not open here yet.") },
    val expand: () -> Unit = { explain("Land expansion is not open here yet.") },
    val gear: () -> Unit = heroes,
    /** The Hero Altar / Siege Stool UPGRADE: the hero's own upgrade in the Heroes sheet. */
    val heroUpgrade: () -> Unit = heroes,
    /** REARM in place (the server call, no sheet). */
    val rearm: () -> Unit = review,
    /** REARM when short of Shards: the Need-more sheet; never spends. */
    val rearmShort: () -> Unit = review,
    val clan: () -> Unit = { explain("The Clan Hall is not open here yet.") },
)

/**
 * Routes a tap on [id] (it must be in the rendered [bar]). The Phase E doors defer every non-BUSY tap to C3, including
 * a locked feature whose existing legacy screen may still be available under C3's live admission guard. Otherwise:
 * OPEN runs or opens the command; SHORT opens the review (UPGRADE, the sheet in its short state) or Need-more (REARM),
 * never a spend; LOCKED explains its requirement; DISABLED is already explained by the bar (shake + reason pill);
 * BUSY does nothing, so an order is never sent twice.
 */
internal fun routeBuildingCommand(id: FeatureId, bar: CommandBarUi?, routes: BuildingCommandRoutes,
    phaseE: PhaseEBuildingCommands? = null, selection: BuildingSelection? = null) {
    val currentBar = bar ?: return
    val ui = currentBar.commands.firstOrNull { it.id == id } ?: return
    // The kit delivers LOCKED/DISABLED taps too. These three read-only doors must reach C3's
    // typed-sheet/legacy/refusal decision; a local OPEN-only guard would strand the fallback.
    // Preserve the rendered selection: C3, not this producer, checks whether it is still current.
    if (phaseE != null && selection != null && selection.buildingId == currentBar.buildingId &&
        id in phaseEBuildingFeatures(selection.type)) {
        if (ui.state != CommandState.BUSY) phaseE.openBuildingDoor(id, selection)
        return
    }
    // The hero buildings' UPGRADE is the hero's own upgrade (the Heroes sheet), told by the rendered selection or bar.
    val heroBuilding = selection?.type?.let { it in HERO_TYPES } == true ||
        currentBar.commands.any { it.id == BuildingCommandIds.HERO_VEX || it.id == BuildingCommandIds.HERO_THEODOR }
    when (commandRoute(ui)) {
        CommandRoute.IGNORE -> return
        CommandRoute.EXPLAIN -> {
            if (commandDrawState(ui) == CommandState.LOCKED) ui.reason?.takeIf { it.isNotBlank() }?.let(routes.explain)
            return
        }
        CommandRoute.NEED_MORE -> {
            when (id) {
                BuildingCommandIds.UPGRADE -> if (heroBuilding) routes.heroUpgrade() else routes.review()
                BuildingCommandIds.REARM -> routes.rearmShort()
            }
            return
        }
        CommandRoute.OPEN -> Unit
    }
    when (id) {
        BuildingCommandIds.INFO -> routes.info()
        BuildingCommandIds.UPGRADE -> if (heroBuilding) routes.heroUpgrade() else routes.review()
        BuildingCommandIds.REARM -> routes.rearm()
        BuildingCommandIds.FINISH -> routes.finish()
        BuildingCommandIds.COLLECT -> routes.collect()
        BuildingCommandIds.TRAIN -> routes.train()
        BuildingCommandIds.RESEARCH -> routes.research()
        BuildingCommandIds.ARMY -> routes.army()
        BuildingCommandIds.FORGE -> routes.forge()
        BuildingCommandIds.HERO_VEX, BuildingCommandIds.HERO_THEODOR -> routes.heroes()
        BuildingCommandIds.ROW -> routes.toggleRow()
        BuildingCommandIds.ROW_UPGRADE -> routes.quoteRow()
        BuildingCommandIds.STORES -> routes.stores()
        BuildingCommandIds.EXPAND -> routes.expand()
        BuildingCommandIds.GEAR -> routes.gear()
        BuildingCommandIds.CLAN -> routes.clan()
    }
}
