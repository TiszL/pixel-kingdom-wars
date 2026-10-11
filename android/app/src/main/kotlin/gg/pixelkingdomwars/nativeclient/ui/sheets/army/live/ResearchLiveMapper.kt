package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.network.ResearchChoice
import gg.pixelkingdomwars.nativeclient.network.TroopUnlock
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.researchChoices
import gg.pixelkingdomwars.nativeclient.network.researchConsentSupported
import gg.pixelkingdomwars.nativeclient.network.researchRemaining
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.troopStats
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.army.researchCurrentArmy
import gg.pixelkingdomwars.nativeclient.ui.army.researchFinishOffered
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.Dir8
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.DotColor
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.FooterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeaderArtUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeaderChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchDetailUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchJobUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SheetHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SpriteRef
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.StatDeltaUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.armyDuration
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.defaultResearchSelection
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/*
 * Live mapper of the Alchemy Lab sheet: `ArmyUiState` (what ResearchScreen receives today) -> the Opus `ResearchUi`.
 * The cards are the server-rule verdicts `researchChoices` already computes for ResearchScreen (one place, read here
 * verbatim); START is the same direct Shards order ResearchScreen sends; FINISH opens the existing review, which
 * determines Gems / KEEP and the maximum charge; a saved payment shows the existing recovery row.
 */

/** Everything the live Research sheet needs from the current state, resolved once (null while it is not loaded). */
internal data class ResearchLiveData(
    val army: gg.pixelkingdomwars.nativeclient.model.ArmyState,
    val baseId: String,
    val catalogue: JsonObject,
    val choices: List<ResearchChoice>,
    val active: List<JsonObject>,
    val supported: Boolean,
)

/** The loaded research inputs, exactly as ResearchScreen gathers them; null until army, base, catalogue and balances
 *  for the selected kingdom are all present. */
internal fun researchLiveData(state: ArmyUiState, baseGeneration: Long): ResearchLiveData? {
    val army = researchCurrentArmy(state, baseGeneration) ?: return null
    val base = state.home.base?.takeIf { it.baseId == state.baseId } ?: return null
    val catalogue = state.catalogue ?: return null
    val balances = state.home.balances ?: return null
    val baseId = state.baseId ?: return null
    val balanceTree = buildJsonObject { put("shards", balances.shards); put("keep", balances.keep) }
    return ResearchLiveData(army, baseId, catalogue, researchChoices(catalogue, base.raw, army.raw, balanceTree),
        army.raw.objects("research"), researchConsentSupported(army.raw))
}

/** The reason line ResearchScreen prints for a choice (its own wording); null when the choice can start. */
internal fun researchReasonLine(choice: ResearchChoice, researchingThis: Boolean, unlock: TroopUnlock): String? {
    val reason = choice.reason ?: return null
    return when {
        reason == "Forge is researching" -> if (researchingThis) "Research in progress" else "The Lab works on one troop at a time."
        reason.startsWith("Requires item_") -> (unlock as? TroopUnlock.Elite)?.label ?: "Unlock ${liveTroopName(choice.troop)} first"
        else -> reason
    }
}

/** A card's state from the server verdict: IN_LAB / BUSY while the Lab works, then MAX, LAB_CAP (needs a higher
 *  completed Lab), SHORT (not enough Shards), LOCKED (any other refusal), SELECTED, DEFAULT. */
internal fun researchCardState(choice: ResearchChoice, activeTroop: String?, selected: Boolean): ResearchCardState {
    val reason = choice.reason
    return when {
        activeTroop == choice.troop -> ResearchCardState.IN_LAB
        activeTroop != null -> ResearchCardState.BUSY
        reason == "Maximum level" -> ResearchCardState.MAX
        reason != null && reason.startsWith("Requires completed Forge level") -> ResearchCardState.LAB_CAP
        reason == "Insufficient SHARDS" -> ResearchCardState.SHORT
        reason != null -> ResearchCardState.LOCKED
        selected -> ResearchCardState.SELECTED
        else -> ResearchCardState.DEFAULT
    }
}

/** Why a tapped card does not select, in the sheet's words: the Lab level a lab-cap card needs (`researchChoices` asks for
 *  completed Forge level = the target, research.html "Upgrade the Alchemy Lab to Lv 7"), "Lab is upgrading" while the
 *  Lab's own upgrade makes every card a cap, ResearchScreen's own line for LOCKED / MAX; null for a card that selects. */
internal fun researchCardTapReason(choice: ResearchChoice, state: ResearchCardState, unlock: TroopUnlock, labUpgrade: String? = null): String? =
    when (state) {
        ResearchCardState.LAB_CAP -> labUpgrade ?: "Upgrade the Alchemy Lab to Lv ${choice.target}"
        ResearchCardState.LOCKED, ResearchCardState.MAX -> researchReasonLine(choice, false, unlock)
        else -> null
    }

/** The look a card keeps under a busy Lab's dim (research-busy.png). The server verdict says "Forge is researching" before
 *  it checks the Lab cap or the Shards, so only MAX and the earlier refusals (LOCKED) are known; anything else is DEFAULT. */
internal fun researchBusyLook(choice: ResearchChoice): ResearchCardState = when (choice.reason) {
    null, "Forge is researching" -> ResearchCardState.DEFAULT
    "Maximum level" -> ResearchCardState.MAX
    else -> ResearchCardState.LOCKED
}

/** The Lab's own upgrade and its time left ("3h"; "…" without a readable finish time). */
internal data class LabUpgrade(val timeLeft: String) {
    /** SPEC §4 "Lab is upgrading · 3h". */
    val line: String get() = "Lab is upgrading · $timeLeft"
}

/** The Lab's own upgrade: a `build` job on a forge, the same rule `researchChoices` uses to treat that Lab as absent;
 *  null while the Lab is not upgrading. */
internal fun researchLabUpgrade(state: ArmyUiState, nowMs: Long): LabUpgrade? {
    val base = state.home.base?.takeIf { it.baseId == state.baseId } ?: return null
    val forges = base.buildings.filter { it.type == "forge" }.map { it.id }.toSet()
    val job = base.jobs.firstOrNull { it.kind == "build" && it.buildingId in forges } ?: return null
    return LabUpgrade(armyDuration(secondsUntil(job.finishesAt, nowMs)))
}

/** The next level's Shards price on a card: SHORT on the server's "Insufficient SHARDS"; null when the card cannot be
 *  researched for any other reason (cap, max, locked). */
internal fun researchPrice(choice: ResearchChoice): PriceUi? {
    val cost = choice.cost ?: return null
    return when (choice.reason) {
        null -> shardsPrice(cost.toString())
        "Insufficient SHARDS" -> shardsPrice(cost.toString(), PriceStatus.SHORT)
        else -> null
    }
}

/** The START order ResearchScreen sends for [choice] (`action("start", …)`), byte for byte: Shards, no Seal. */
internal fun researchStartOrder(data: ResearchLiveData, choice: ResearchChoice): JsonObject? {
    val level = data.army.levels[choice.troop] ?: return null
    val cost = choice.cost ?: return null
    return buildJsonObject {
        put("action", "start"); put("troop", choice.troop); put("level", level); put("toLevel", choice.target)
        put("price", cost.toString()); put("baseId", data.baseId)
    }
}

/** HP / damage now and at the target level, scaled exactly like the Barracks cell (`TROOP_LEVELING.statMultPerLevel`,
 *  rounded); empty when the catalogue lacks the stat or the multiplier. */
internal fun researchStats(catalogue: JsonObject, troop: String, level: Int, target: Int): List<StatDeltaUi> {
    val stats = troopStats(catalogue, troop) ?: return emptyList()
    val mult = ((catalogue["constants"] as? JsonObject)?.get("TROOP_LEVELING") as? JsonObject)?.string("statMultPerLevel")?.toDoubleOrNull()
        ?: return emptyList()
    fun at(key: String, l: Int): String? = stats.string(key)?.toDoubleOrNull()?.let { "%,d".format(java.util.Locale.US, Math.round(it * Math.pow(mult, (l - 1).toDouble()))) }
    return listOfNotNull(
        at("hp", level)?.let { StatDeltaUi("Hitpoints", it, at("hp", target)) },
        at("dps", level)?.let { StatDeltaUi("Damage/s", it, at("dps", target)) },
    )
}

/** 0..1 of the running research from the pack's canonical duration (ResearchScreen's own rule); null when unknown. */
internal fun researchProgress(catalogue: JsonObject, target: Int, remainingSec: Long?): Float? {
    val leveling = (catalogue["constants"] as? JsonObject)?.get("TROOP_LEVELING") as? JsonObject
    val seconds = ((leveling?.get("researchTimeSec") as? JsonArray)?.getOrNull(target - 2) as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }
    return if (remainingSec == null || seconds == null) null else (1f - remainingSec.toFloat() / seconds).coerceIn(0f, 1f)
}

/** Why research orders are closed right now (ResearchScreen's `enabled` rule); null while they are open. */
internal fun researchBlockedReason(state: ArmyUiState, supported: Boolean, actionsAllowed: Boolean): String? = when {
    !supported -> "Research orders will be available when this server enables the compatible native update. Your levels and queue remain visible."
    state.interrupted.any { it.kind == IntentKind.RESEARCH && it.blocking } -> "A saved research payment is waiting. Check it first."
    state.domain.researchReview != null -> "Finish the open review first."
    else -> ordersBlockedReason(state.ordersAllowed, actionsAllowed)
}

/** `ArmyUiState` -> the Research sheet. [selected] is the sheet's own card selection (UI state, never sent). */
internal fun researchLiveUi(state: ArmyUiState, baseGeneration: Long, nowMs: Long, selected: String?, busy: Boolean, actionsAllowed: Boolean): ResearchUi {
    val data = researchLiveData(state, baseGeneration)
    val labLevel = completedLevel(state.home.base?.takeIf { it.baseId == state.baseId }?.buildings, "forge")
    val pending = if (state.interrupted.any { it.kind == IntentKind.RESEARCH })
        "A saved research payment is waiting. Check its receipt before another finish." else null
    val art = { walkers: List<String> -> HeaderArtUi(SpriteRef(buildingPortrait(state.catalogue, "forge", labLevel), 56), 1,
        troopWalkers(walkers, Dir8.S, 50, startDp = 300), buildingXDp = 200) }
    if (data == null) {
        // Army, kingdom and balances are read but there is no verified catalogue: the existing copy + REFRESH (SPEC §4
        // "no catalogue"), never a skeleton that waits forever.
        val noCatalogue = state.catalogue == null && researchCurrentArmy(state, baseGeneration) != null &&
            state.home.base?.baseId == state.baseId && state.home.balances != null
        return ResearchUi(SheetHeaderUi("ALCHEMY LAB", labLevel?.let { "LV $it" }, HeaderChipUi(null, "Lab", UNKNOWN), art(emptyList())),
            labLevel ?: 0, null, emptyList(), null,
            FooterUi(emptyList(), emptyList(), liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.DISABLED,
                if (noCatalogue) RESEARCH_NEEDS_CATALOGUE else "Research is still loading.")),
            loading = !noCatalogue, catalogueMissing = if (noCatalogue) researchCatalogueMissing(state.catalogue, labLevel) else null,
            pendingPayment = pending)
    }
    val activeRow = data.active.firstOrNull()
    val activeTroop = activeRow?.string("troop")
    val blocked = researchBlockedReason(state, data.supported, actionsAllowed)
    val labUpgrade = researchLabUpgrade(state, nowMs)
    val job = activeRow?.let { row ->
        val troop = row.string("troop") ?: return@let null
        val target = row.string("toLevel")?.toIntOrNull() ?: return@let null
        val remaining = researchRemaining(row, nowMs)
        val offered = researchFinishOffered(data.army.raw, row)
        val finish = when {
            busy -> liveCommand(ArmyLiveIds.RESEARCH_FINISH, "FINISH", CommandState.BUSY, verb = Verb.GREEN)
            blocked != null -> liveCommand(ArmyLiveIds.RESEARCH_FINISH, "FINISH", CommandState.DISABLED, blocked, verb = Verb.GREEN)
            !offered -> liveCommand(ArmyLiveIds.RESEARCH_FINISH, "FINISH", CommandState.DISABLED,
                "Paid finish needs a current compatible server quote. The research still finishes normally.", verb = Verb.GREEN)
            else -> liveCommand(ArmyLiveIds.RESEARCH_FINISH, "FINISH", CommandState.ENABLED, verb = Verb.GREEN, sub = "Price shown in review")
        }
        ResearchJobUi(troop, liveTroopName(troop), armyPortrait(data.catalogue, troop, data.army.levels[troop]), "L${target - 1}", "L$target",
            remaining, researchProgress(data.catalogue, target, remaining), finish)
    }
    val pick = if (job != null) null else selected
    val provisional = data.choices.map { researchCardState(it, activeTroop, false) }
    val defaultPick = defaultResearchSelection(data.choices.zip(provisional).map { (c, s) ->
        ResearchCardUi(c.troop, "", "", "", null, s) })
    val selection = pick?.takeIf { p -> data.choices.any { it.troop == p } } ?: if (job == null) defaultPick else null
    val cards = data.choices.map { c ->
        val state0 = researchCardState(c, activeTroop, c.troop == selection)
        val busyLook = if (state0 == ResearchCardState.BUSY) researchBusyLook(c) else null
        // Under a busy Lab the dimmed grid still reads each next level's catalogue price (research-busy.png); whether it
        // is affordable is not known until the Lab is free, so it is never drawn SHORT here.
        val price = if (busyLook == ResearchCardState.DEFAULT) c.cost?.let { shardsPrice(it.toString()) } else researchPrice(c)
        ResearchCardUi(c.troop, liveTroopName(c.troop), armyPortrait(data.catalogue, c.troop, c.level), "L${c.level}", price, state0,
            target = if (state0 == ResearchCardState.SELECTED) "L${c.target}" else null,
            reason = researchCardTapReason(c, state0, state.unlock(c.troop), labUpgrade?.line), busyLook = busyLook)
    }
    val chosen = data.choices.firstOrNull { it.troop == selection }
    val detail = chosen?.let { c ->
        ResearchDetailUi(c.troop, liveTroopName(c.troop), armyPortrait(data.catalogue, c.troop, c.target), "L${c.level}", "L${c.target}",
            researchStats(data.catalogue, c.troop, c.level, c.target), c.seconds,
            researchPrice(c) ?: PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE, description = "No price for this level"))
    }
    val footer = if (job != null) FooterUi(listOf("Skip the wait,", "or let it finish."), emptyList(), job.finish.copy(primary = true))
    else {
        val primary = when {
            busy -> liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.BUSY, sub = "Sending")
            blocked != null -> liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.DISABLED, blocked)
            // SPEC §4 "Lab upgrading": the primary's L state with the time; the server verdicts already refuse every card.
            labUpgrade != null -> liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.LOCKED, labUpgrade.line)
            chosen == null -> liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.DISABLED, "Pick a troop to research")
            chosen.reason == "Insufficient SHARDS" -> liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.ENABLED,
                price = researchPrice(chosen), sub = "${liveTroopName(chosen.troop)} to L${chosen.target}")
            chosen.reason != null -> liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.DISABLED, chosen.reason)
            else -> liveCommand(ArmyLiveIds.RESEARCH, "RESEARCH", CommandState.ENABLED, sub = "${liveTroopName(chosen.troop)} to L${chosen.target}")
        }
        FooterUi(listOfNotNull(chosen?.seconds?.let { "takes ${armyDuration(it)}" }), listOfNotNull(detail?.price), primary)
    }
    val chip = when {
        job != null -> HeaderChipUi("timer", "${job.name} ${job.to} in", armyDuration(job.remainingSec))
        // Never "Lab is free" while the Lab itself is upgrading.
        labUpgrade != null -> HeaderChipUi("timer", "Lab is upgrading", labUpgrade.timeLeft)
        else -> HeaderChipUi(null, "Lab is free", null, DotColor.GREEN)
    }
    return ResearchUi(
        header = SheetHeaderUi("ALCHEMY LAB", labLevel?.let { "LV $it" }, chip, art(listOfNotNull(job?.portrait ?: detail?.portrait))),
        labLevel = labLevel ?: 0,
        job = job,
        cards = cards,
        selected = if (job == null) detail else null,
        footer = footer,
        loading = false,
        catalogueMissing = if (data.choices.isEmpty()) researchCatalogueMissing(data.catalogue, labLevel) else null,
        pendingPayment = pending,
        // SPEC §4 "Lab upgrading": the panel at 60 % while nothing is running.
        paused = job == null && labUpgrade != null,
    )
}

/** ResearchScreen's own copy for a missing or unverified catalogue. */
private const val RESEARCH_NEEDS_CATALOGUE = "Research controls need the latest verified game catalogue."

/** The no-catalogue EmptyState (SPEC §4): the Lab's portrait, the existing copy and REFRESH. */
private fun researchCatalogueMissing(catalogue: JsonObject?, labLevel: Int?): EmptyStateUi =
    EmptyStateUi(buildingPortrait(catalogue, "forge", labLevel), "No research yet", RESEARCH_NEEDS_CATALOGUE, "REFRESH", ArmyLiveIds.RESEARCH)

/** The reason a tapped card explains (LOCKED / LAB_CAP / MAX), in ResearchScreen's words. */
internal fun researchCardReason(state: ArmyUiState, baseGeneration: Long, troop: String): String? {
    val data = researchLiveData(state, baseGeneration) ?: return null
    val choice = data.choices.firstOrNull { it.troop == troop } ?: return null
    return researchReasonLine(choice, data.active.any { it.string("troop") == troop }, state.unlock(troop))
}

/** The FINISH command the footer and job card share (exposed so the host routes the tap by its state). */
internal fun ResearchUi.finishCommand(): CommandUi? = job?.finish
