package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.model.TroopCount
import gg.pixelkingdomwars.nativeclient.network.TrainingScheduling
import gg.pixelkingdomwars.nativeclient.network.TroopUnlock
import gg.pixelkingdomwars.nativeclient.network.manualTrainingRoom
import gg.pixelkingdomwars.nativeclient.network.nextTrainingCancelTarget
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.trainingCancelTarget
import gg.pixelkingdomwars.nativeclient.network.troopPoints
import gg.pixelkingdomwars.nativeclient.network.troopStats
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.army.trainingCurrentArmy
import gg.pixelkingdomwars.nativeclient.ui.army.trainingFinishOffered
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.roster.rosterHeroPortrait
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.Dir8
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.DotColor
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.FooterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeaderArtUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeaderChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HousingUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.QueueGroupUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SavedArmyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SheetHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SpriteRef
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TrainUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TroopCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TroopCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.armyDuration
import java.math.BigInteger
import java.math.BigDecimal

/*
 * Live mappers of the Army sheet (TRAIN + ARMY tabs): `ArmyUiState` (what ArmyScreen receives today) -> the Opus
 * `TrainUi` / `ArmyUi`. Pure: every figure is the server's `/army` + `/base` read or a catalogue lookup the current
 * screen already prints (troopCostLine, troopPoints, armyPortrait); nothing here re-derives a server rule. The only
 * money on these tabs is the training FINISH (Gems / KEEP): it carries no price of its own ("Price shown in review", the
 * A5 pattern) and its tap asks for the EXISTING review, or it is FREE only on the server's own free-finish offer.
 * LOAD and SAVE of a saved army only fill the local draft or write a wallet plan; neither buys anything.
 */

/** Why the TRAIN composer is closed right now, in the current screen's words; null while it is open. */
internal fun trainComposerReason(state: ArmyUiState): String? = when {
    state.trainingBlocked -> "A saved training order is still being checked. Open History to see it."
    state.domain.reviewed != null || state.domain.trainingFinishReview != null -> "Finish the open review first."
    state.domain.scheduling == TrainingScheduling.UNSUPPORTED -> "Training requires a compatible app update. Existing troops and training are preserved."
    !state.ordersAllowed -> ordersBlockedReason(false, true)
    else -> null
}

/** The lock line of a troop card (rollout message first, then the unlock path); null when the troop is open. */
internal fun troopLockReason(state: ArmyUiState, troop: String): String? {
    val rollout = state.rollout(troop)
    if (rollout.locked) return rollout.message ?: "Coming soon"
    return when (val unlock = state.unlock(troop)) {
        is TroopUnlock.Elite -> unlock.label
        is TroopUnlock.Keep -> unlock.label
        TroopUnlock.Open -> null
    }
}

/** The training queue as the strip draws it: one group per troop in queue order, counting only rows no −1 tap has
 *  already spoken for (the current screen's own grouping, D-096). */
internal fun trainQueueGroups(state: ArmyUiState, army: ArmyState, nowMs: Long): List<QueueGroupUi> {
    val counts = LinkedHashMap<String, Int>()
    army.queue.forEach { counts[it.troop] = (counts[it.troop] ?: 0) + if (it.id in state.pendingCancelIds) 0 else 1 }
    val head = army.queue.firstOrNull()
    return counts.entries.mapIndexed { i, (troop, count) ->
        val name = liveTroopName(troop)
        val refund = trainingCancelTarget(army.queue, troop)?.let { target ->
            (nextTrainingCancelTarget(army.queue, troop, state.pendingCancelIds) ?: target).refundShards
        }
        val isHead = i == 0 && head != null
        val remaining = if (isHead) secondsUntil(head?.finishesAt, nowMs) else null
        val progress = if (isHead) baseJobProgress(head?.startedAt, head?.finishesAt, nowMs)?.fraction else null
        val spoken = buildString {
            append("$count $name in the queue")
            if (isHead) append(", next in ${armyDuration(remaining)}")
            append(if (refund != null) ". Tap to cancel one for ${groupedAmount(refund) ?: UNKNOWN} Shards back" else ". Finishes normally")
        }
        QueueGroupUi(troop, armyPortrait(state.catalogue, troop, army.levels[troop]), count, remaining, progress, spoken)
    }
}

/** The training FINISH button: FREE only on the server's free-finish offer; a paid finish carries no pill (the price
 *  is only the existing review's: "Price shown in review", as research and hero FINISH after A5) and its tap asks for
 *  that review; null with an empty queue. */
internal fun trainFinishCommand(state: ArmyUiState, army: ArmyState, busy: Boolean, actionsAllowed: Boolean): CommandUi? {
    if (army.queue.isEmpty()) return null
    val free = army.freeFinishAllOffer != null
    val paid = trainingFinishOffered(army.raw)
    val blocked = trainComposerReason(state) ?: ordersBlockedReason(state.ordersAllowed, actionsAllowed)
    val price = if (free) serverFreePrice() else null
    return when {
        busy -> liveCommand(ArmyLiveIds.TRAIN_FINISH, "FINISH", CommandState.BUSY, price = price, primary = false, verb = Verb.GREEN)
        blocked != null -> liveCommand(ArmyLiveIds.TRAIN_FINISH, "FINISH", CommandState.DISABLED, blocked, price, false, Verb.GREEN)
        !free && !paid -> liveCommand(ArmyLiveIds.TRAIN_FINISH, "FINISH", CommandState.DISABLED,
            "Paid finish needs a current compatible server quote. Your troops still train normally.", null, false, Verb.GREEN)
        free -> liveCommand(ArmyLiveIds.TRAIN_FINISH, "FINISH", CommandState.ENABLED, price = price, primary = false, verb = Verb.GREEN)
        else -> liveCommand(ArmyLiveIds.TRAIN_FINISH, "FINISH", CommandState.ENABLED, primary = false, verb = Verb.GREEN,
            sub = "Price shown in review")
    }
}

private fun troopCost(state: ArmyUiState, troop: String): String? = troopStats(state.catalogue, troop)?.string("costKeep")
    ?.takeIf { groupedAmount(it) != null }

/** A locked card's two short lines (train.png: "Unlocks at / Barracks 8", "Needs an / unlock item"): the Keep level
 *  from the catalogue, the unlock item for an elite troop, the server's rollout message; null when the troop is open.
 *  The troop's Info half sheet keeps the full unlock path ([troopLockReason]). */
internal fun troopCardLockLine(state: ArmyUiState, troop: String): String? {
    val rollout = state.rollout(troop)
    if (rollout.locked) return rollout.message ?: "Coming soon"
    return when (val unlock = state.unlock(troop)) {
        is TroopUnlock.Keep -> "Unlocks at\nKeep ${unlock.requiresKeepLevel}"
        is TroopUnlock.Elite -> "Needs an\nunlock item"
        TroopUnlock.Open -> null
    }
}

/** A known SHORT amount is a display hint only (a tap explains it on the Barracks). The existing server review still
 *  prices every training order. */
internal fun troopCard(state: ArmyUiState, army: ArmyState?, troop: String, short: PriceUi? = null): TroopCardUi {
    val chosen = state.quantities[troop]?.toIntOrNull()?.coerceAtLeast(0) ?: 0
    val lock = troopCardLockLine(state, troop)
    val cost = troopCost(state, troop)
    val price = if (cost == null) PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE,
        description = "This troop has no price in the game catalogue") else shardsPrice(cost, if (short != null) PriceStatus.SHORT else PriceStatus.OK)
    val cardState = when {
        lock != null -> TroopCardState.LOCKED
        army != null && state.capacityReason(troop) != null -> TroopCardState.NO_ROOM
        short != null -> TroopCardState.SHORT
        chosen > 0 -> TroopCardState.CHOSEN
        else -> TroopCardState.DEFAULT
    }
    val level = army?.levels?.get(troop)
    return TroopCardUi(troop, liveTroopName(troop), armyPortrait(state.catalogue, troop, level), levelTag(level),
        troopPoints(state.catalogue, troop)?.toString() ?: UNKNOWN, price, cardState, chosen, lock, null)
}

private fun draftCostAmount(state: ArmyUiState): BigInteger? {
    val lines = state.draftComposition
    var total = BigInteger.ZERO
    for (line in lines) {
        val cost = troopCost(state, line.troop)?.toBigIntegerOrNull() ?: return null
        total += cost * line.count.toBigInteger()
    }
    return total
}

/** The displayed draft estimate never replaces the quote's actual price. */
internal fun draftTotal(state: ArmyUiState): PriceUi = shardsPrice(draftCostAmount(state)?.toString())

/** (cost of this draft plus one [troop], the observed Shards balance) only when this current base is short. */
private fun trainShortfall(state: ArmyUiState, baseGeneration: Long, troop: String): Pair<BigInteger, BigDecimal>? {
    trainingCurrentArmy(state, baseGeneration) ?: return null
    if (state.home.base?.baseId != state.baseId || state.home.loading) return null
    val have = state.home.balances?.shards?.toBigDecimalOrNull()?.takeIf { it >= BigDecimal.ZERO } ?: return null
    val unit = troopCost(state, troop)?.toBigIntegerOrNull() ?: return null
    val total = (draftCostAmount(state) ?: return null) + unit
    return if (have < total.toBigDecimal()) total to have else null
}

/** Cost of this draft plus one troop, only when this current base has an observed Shards shortfall. */
internal fun trainShortPrice(state: ArmyUiState, baseGeneration: Long, troop: String): PriceUi? =
    trainShortfall(state, baseGeneration, troop)?.let { (total, _) -> shardsPrice(total.toString(), PriceStatus.SHORT) }

/** Owner 2026-10-11 (Seeker, code 33): a troop tap the observed Shards balance cannot cover says so on the Barracks and
 *  names the shortfall; it never sends the player to the Gold Forge. Null when the balance covers it or is unknown (the
 *  server quote stays the gate; its INSUFFICIENT_SHARDS refusal is the funds sheet over this page).
 *  The whole line must fit the two-line toast (Feedback.kt Toast maxLines = 2, about 38 characters a line on a phone;
 *  Theme.kt owner rule 2026-10-06), so it names the order total and the gap only: the balance is the gap's complement
 *  and is on the HUD. "need" is the whole draft plus this troop, which is why a 12-Shard tap can need 24. */
internal fun trainShortMessage(state: ArmyUiState, baseGeneration: Long, troop: String): String? {
    val (total, have) = trainShortfall(state, baseGeneration, troop) ?: return null
    fun shown(v: BigDecimal) = v.stripTrailingZeros().toPlainString().let { groupedAmount(it) ?: it }
    return "Not enough Shards for a ${liveTroopName(troop)}: need ${shown(total.toBigDecimal())}, " +
        "${shown(total.toBigDecimal() - have)} short."
}

/** Catalogue training work, not an ETA: scheduling may overlap troops and only the quote owns that schedule. */
internal fun draftTrainingWork(state: ArmyUiState): String? {
    val draft = state.draftComposition.takeIf { it.isNotEmpty() } ?: return null
    var seconds = BigDecimal.ZERO
    for (line in draft) {
        val perUnit = troopStats(state.catalogue, line.troop)?.string("trainSec")?.toBigDecimalOrNull()
            ?.takeIf { it > BigDecimal.ZERO } ?: return null
        seconds += perUnit * line.count.toBigDecimal()
    }
    val whole = runCatching { seconds.longValueExact() }.getOrNull()
    return whole?.let(::armyDuration) ?: "${seconds.stripTrailingZeros().toPlainString()}s"
}

/** A missing or malformed tail timestamp is unknown; an empty queue is the only unconditional zero. */
internal fun trainQueueCompletion(army: ArmyState, nowMs: Long): Long? =
    if (army.queue.isEmpty()) 0L else secondsUntil(army.queue.last().finishesAt, nowMs)?.coerceAtLeast(0)

/** `ArmyUiState` -> the TRAIN tab. [baseGeneration] / [actionsAllowed] / [busy] are what ArmyScreen receives today. */
internal fun trainLiveUi(state: ArmyUiState, baseGeneration: Long, nowMs: Long, busy: Boolean, actionsAllowed: Boolean): TrainUi {
    val army = trainingCurrentArmy(state, baseGeneration)
    val room = state.room
    val buildings = state.home.base?.takeIf { it.baseId == state.baseId }?.buildings
    val level = completedLevel(buildings, "barracks")
    val queue = army?.let { trainQueueGroups(state, it, nowMs) }.orEmpty()
    val loading = army == null && (state.domain.loading || busy)
    val troops = if (loading) emptyList() else state.trainTable.map { troopCard(state, army, it, trainShortPrice(state, baseGeneration, it)) }
    val housing = if (army == null || room == null) HousingUi(0, 0, 0, 0, 0, full = false, known = false)
        else HousingUi(army.rosterPts, room.queuePts, room.draftPts, army.campCapacityPts, army.barracksQueuePts,
            full = room.campFreePts <= 0 || room.queueFreePts <= 0)
    val chip = when {
        army == null -> HeaderChipUi("timer", "Barracks", UNKNOWN)
        army.queue.isEmpty() -> HeaderChipUi(null, "Barracks ready", null, DotColor.GREEN)
        else -> HeaderChipUi("timer", "All ready in", armyDuration(trainQueueCompletion(army, nowMs)))
    }
    val art = HeaderArtUi(SpriteRef(buildingPortrait(state.catalogue, "barracks", level), 56), 1,
        troopWalkers(state.trainTable.take(4).map { armyPortrait(state.catalogue, it, army?.levels?.get(it)) }, Dir8.W, 54),
        buildingXDp = 250, buildingYDp = 4)
    val composer = trainComposerReason(state)
    val blocked = composer ?: ordersBlockedReason(state.ordersAllowed, actionsAllowed)
    val units = state.draftUnits
    val primary = when {
        army == null -> liveCommand(ArmyLiveIds.TRAIN, "TRAIN", CommandState.DISABLED, "Your army is still loading.")
        busy -> liveCommand(ArmyLiveIds.TRAIN, "TRAIN", CommandState.BUSY, sub = "Sending")
        state.domain.scheduling == TrainingScheduling.UNSUPPORTED -> liveCommand(ArmyLiveIds.TRAIN, "TRAIN", CommandState.LOCKED, composer)
        blocked != null -> liveCommand(ArmyLiveIds.TRAIN, "TRAIN", CommandState.DISABLED, blocked)
        units == 0 && housing.full -> liveCommand(ArmyLiveIds.TRAIN, "TRAIN", CommandState.DISABLED, "Camp and queue are full. FINISH or raid.")
        units == 0 -> liveCommand(ArmyLiveIds.TRAIN, "TRAIN", CommandState.DISABLED, "Tap troops to add them")
        else -> liveCommand(ArmyLiveIds.TRAIN, "TRAIN $units", CommandState.ENABLED, sub = "joins the queue")
    }
    // train.png footer: the draft's Shards pill and ONE VT line, housing points and the catalogue training work. An
    // empty draft has no info block, so the off TRAIN and its reason span the footer (train-full.png).
    val info = if (units == 0) emptyList()
        else listOf("+${room?.draftPts ?: UNKNOWN} pts · ${draftTrainingWork(state) ?: UNKNOWN}")
    val lastArmy = when {
        army == null -> null
        busy -> liveCommand(ArmyLiveIds.LAST_ARMY, "LAST ARMY", CommandState.DISABLED, "Waiting for the server.", primary = false, verb = Verb.STONE)
        blocked != null -> liveCommand(ArmyLiveIds.LAST_ARMY, "LAST ARMY", CommandState.DISABLED, blocked, primary = false, verb = Verb.STONE)
        else -> liveCommand(ArmyLiveIds.LAST_ARMY, "LAST ARMY", CommandState.ENABLED, primary = false, verb = Verb.STONE)
    }
    return TrainUi(
        header = SheetHeaderUi("BARRACKS", level?.let { "LV $it" }, chip, art),
        housing = housing,
        queue = queue,
        finish = army?.let { trainFinishCommand(state, it, busy, actionsAllowed) },
        freeFinish = army?.freeFinishAllOffer != null,
        troops = troops,
        lastArmy = lastArmy,
        footer = FooterUi(info, if (units == 0) emptyList() else listOf(draftTotal(state)), primary),
        loading = loading,
        // No authoritative pause capability is exposed by the current /army contract. An upgrade alone is not proof.
        paused = false,
        armyTabPortrait = state.trainTable.firstOrNull()?.let { armyPortrait(state.catalogue, it, army?.levels?.get(it)) } ?: "ui_portrait_highlander_t1",
    )
}

/** One hero row of the ARMY tab from the roster the shared army repository already holds. */
internal fun heroRow(state: ArmyUiState, hero: Hero, nowMs: Long): HeroRowUi {
    val remaining = secondsUntil(hero.recoveryUntil, nowMs)?.takeIf { it > 0 }
    val heroState = when {
        !hero.recruited -> HeroState.NOT_RECRUITED
        !hero.available -> HeroState.RESTING
        else -> HeroState.READY
    }
    // army.png: a ready hero's line is its home ("Hero Altar"); the READY tag says the rest. The rest meter's progress
    // stays null: the roster has no recovery start time, and a meter is never drawn from invented progress.
    val line = when (heroState) {
        HeroState.NOT_RECRUITED -> "Not recruited"
        HeroState.RESTING -> if (remaining != null) "Resting · back in ${armyDuration(remaining)}" else "Resting · checking"
        else -> heroHome(hero)
    }
    return HeroRowUi(hero.hero, hero.name.uppercase(), rosterHeroPortrait(state.catalogue, hero.hero, hero.level),
        levelTag(hero.level), heroState, if (heroState == HeroState.RESTING) remaining else null, null, ArmyLiveIds.hero(hero.hero), line)
}

/** `ArmyUiState` -> the ARMY tab (camp, heroes, saved armies, ATTACK). [savingSlot] is the empty slot whose SAVE the
 *  host sent; only that row shows the dots while the view model is busy. */
internal fun armyLiveUi(state: ArmyUiState, baseGeneration: Long, nowMs: Long, busy: Boolean, savingSlot: Int? = null): ArmyUi {
    val army = trainingCurrentArmy(state, baseGeneration)
    val buildings = state.home.base?.takeIf { it.baseId == state.baseId }?.buildings
    val level = completedLevel(buildings, "camp")
    val order = state.trainTable + army?.counts?.keys.orEmpty().filter { it !in state.trainTable }
    val troops = army?.let { a -> order.mapNotNull { troop ->
        val n = a.counts[troop]?.takeIf { it > 0 } ?: return@mapNotNull null
        val l = a.levels[troop]
        ArmyTileUi(troop, armyPortrait(state.catalogue, troop, l), levelTag(l), "x$n", "$n ${liveTroopName(troop)}, level ${l ?: UNKNOWN}")
    } }.orEmpty()
    val queuedPts = state.room?.queuePts ?: army?.queuedPts ?: 0
    val housing = if (army == null) HousingUi(0, 0, 0, 0, 0, full = false, known = false)
        else HousingUi(army.rosterPts, queuedPts, 0, army.campCapacityPts, army.barracksQueuePts, full = false)
    val heroes = state.domain.heroes?.heroes.orEmpty().map { heroRow(state, it, nowMs) }
    val recruited = heroes.filter { it.state != HeroState.NOT_RECRUITED }
    val rules = state.presetRules
    val saved = if (rules == null || state.domain.presets == null) emptyList()
        else (1..rules.slots).map { slot ->
            val preset = state.domain.presets?.firstOrNull { it.slot == slot }
            SavedArmyUi(slot, preset?.name, preset?.composition.orEmpty().take(3).map { armyPortrait(state.catalogue, it.troop, army?.levels?.get(it.troop)) },
                empty = preset == null, busy = busy && savingSlot == slot)
        }
    val empty = army != null && troops.isEmpty()
    val ready = army?.rosterPts
    // army.png: the red ATTACK carries the attack icon.
    val primary = when {
        army == null -> liveCommand(ArmyLiveIds.ATTACK, "ATTACK", CommandState.DISABLED, "Your army is still loading.", verb = Verb.RED, icon = "attack")
        empty -> liveCommand(ArmyLiveIds.ATTACK, "ATTACK", CommandState.DISABLED, "Train troops first", verb = Verb.RED, icon = "attack")
        else -> liveCommand(ArmyLiveIds.ATTACK, "ATTACK", CommandState.ENABLED, verb = Verb.RED, icon = "attack")
    }
    val heroLine = if (state.domain.heroes == null) "Heroes $UNKNOWN" else "Heroes ${recruited.count { it.state == HeroState.READY }}/${recruited.size} ready"
    val chip = when {
        army == null -> HeaderChipUi("ui_icon_warhorn", "Camp", UNKNOWN)
        empty -> HeaderChipUi("ui_icon_warhorn", "Camp is empty", null)
        else -> HeaderChipUi("ui_icon_warhorn", "Ready to raid ·", "${army.rosterPts}/${army.campCapacityPts}", emphasisGreen = true)
    }
    return ArmyUi(
        header = SheetHeaderUi("ARMY CAMP", level?.let { "LV $it" }, chip,
            HeaderArtUi(SpriteRef(buildingPortrait(state.catalogue, "camp", level), 56), 1,
                troopWalkers(troops.take(4).map { it.portrait }, Dir8.S, 50), buildingXDp = 250, buildingYDp = 10)),
        housing = housing,
        trainingDoneInSec = army?.takeIf { it.queue.isNotEmpty() }?.let { trainQueueCompletion(it, nowMs) },
        troops = troops,
        heroes = heroes,
        saved = saved,
        footer = FooterUi(listOf("${ready ?: UNKNOWN} / ${army?.campCapacityPts ?: UNKNOWN}", heroLine), emptyList(), primary),
        loading = army == null && (state.domain.loading || busy),
        emptyCamp = if (empty) EmptyStateUi("ui_icon_warhorn", "No troops yet", "Train them at the Barracks", "GO TO BARRACKS", ArmyLiveIds.TRAIN) else null,
        queuedGroups = army?.let { trainQueueGroups(state, it, nowMs).size } ?: 0,
        armyTabPortrait = state.trainTable.firstOrNull()?.let { armyPortrait(state.catalogue, it, army?.levels?.get(it)) } ?: "ui_portrait_highlander_t1",
    )
}

/** What LOAD puts into the TRAIN draft: troop -> count in the saved army's order, and how many saved troops did not fit
 *  ("3 troops didn't fit"). */
internal data class SavedArmyFill(val quantities: Map<String, Int>, val dropped: Int)

/**
 * LOAD of a saved army (SPEC §3 `onLoadSaved`): the saved composition trimmed to what a manual draft can hold right
 * now, with the composer's own rules (ArmyUiState.capacityReason / selectOne): each troop takes its housing points from
 * both the camp room and the queue room of `manualTrainingRoom` (the draft starts empty, LOAD replaces it), the
 * saved-army unit limit caps the count, and a locked, unknown or unpriced-housing troop does not fit. It spends nothing;
 * TRAIN still sends the draft through the server quote. Null when this base's army or the saved slot is not known.
 */
internal fun savedArmyFill(state: ArmyUiState, baseGeneration: Long, slot: Int): SavedArmyFill? {
    val army = trainingCurrentArmy(state, baseGeneration) ?: return null
    val preset = state.domain.presets?.firstOrNull { it.slot == slot } ?: return null
    val room = manualTrainingRoom(state.catalogue, army.queue, army.rosterPts, army.campCapacityPts, army.barracksQueuePts, emptyList())
    var campLeft = room.campFreePts
    var queueLeft = room.queueFreePts
    var unitsLeft = state.presetRules?.maxCompositionUnits ?: Int.MAX_VALUE
    val kept = LinkedHashMap<String, Int>()
    var dropped = 0
    for (line in preset.composition) {
        val wanted = line.count.coerceAtLeast(0)
        val pts = troopPoints(state.catalogue, line.troop)?.takeIf { it > 0 }
        val open = line.troop in state.trainTable && !state.unlock(line.troop).locked && !state.rollout(line.troop).locked
        val fits = if (pts == null || !open) 0 else minOf(wanted, campLeft / pts, queueLeft / pts, unitsLeft).coerceAtLeast(0)
        if (pts != null && fits > 0) {
            kept[line.troop] = (kept[line.troop] ?: 0) + fits
            campLeft -= fits * pts; queueLeft -= fits * pts; unitsLeft -= fits
        }
        dropped += wanted - fits
    }
    return SavedArmyFill(kept, dropped)
}

/**
 * SAVE on an empty slot ("save today's army"): the troops ready in this base's camp, in TRAIN table order, as the
 * server's saved-army rules accept them (trainable troops only, at most `maxCompositionUnits` units, the last troop
 * trimmed). Null while this base's army or the rules are unknown, or when the camp is empty.
 */
internal fun currentArmyPresetComposition(state: ArmyUiState, baseGeneration: Long): List<TroopCount>? {
    val army = trainingCurrentArmy(state, baseGeneration) ?: return null
    val rules = state.presetRules ?: return null
    var unitsLeft = rules.maxCompositionUnits
    val composition = state.trainTable.mapNotNull { troop ->
        val count = minOf(army.counts[troop] ?: 0, unitsLeft)
        if (count <= 0) null else TroopCount(troop, count).also { unitsLeft -= count }
    }
    return composition.takeIf { it.isNotEmpty() }
}

/** The doors a hero row's GO opens: the hero sheet for a recruited hero, the build tray (altar) otherwise. */
internal fun heroRowDoor(row: HeroRowUi): FeatureId = if (row.state == HeroState.NOT_RECRUITED) FeatureId("hud.build") else row.door

/** Read-only troop details; [focusBuildingId] is a real current base id, never a fabricated upgrade command. */
internal data class ArmyTroopInfoUi(val troop: String, val name: String, val portrait: String, val level: String,
    val prose: List<String>, val stats: List<Pair<String, String>>, val lockReason: String?,
    val focusBuildingId: String?, val goLabel: String?)

internal fun armyTroopInfo(state: ArmyUiState, baseGeneration: Long, troop: String): ArmyTroopInfoUi? {
    val army = trainingCurrentArmy(state, baseGeneration)
    if (troop !in state.trainTable && troop !in army?.counts.orEmpty()) return null
    val level = army?.levels?.get(troop)?.takeIf { it > 0 }
    val catalogue = state.catalogue
    val numbers = if (level != null) CodexData.troopStats(catalogue, troop, level) else null
    val raw = troopStats(catalogue, troop)
    val codex = CodexData.troop(catalogue, troop)
    val lock = troopLockReason(state, troop)
    val type = if (army == null || state.rollout(troop).locked) null else when (state.unlock(troop)) {
        is TroopUnlock.Keep -> "keep"
        is TroopUnlock.Elite -> "goldforge"
        TroopUnlock.Open -> null
    }
    val focus = state.home.base?.takeIf { it.baseId == state.baseId }?.buildings?.firstOrNull { it.type == type }?.id
    return ArmyTroopInfoUi(troop, liveTroopName(troop), armyPortrait(catalogue, troop, level), levelTag(level),
        listOfNotNull(codex?.who, codex?.strat), listOf(
            "Research level" to (level?.toString() ?: UNKNOWN),
            "Hitpoints" to (numbers?.hp?.toString() ?: UNKNOWN),
            "Damage/s" to (numbers?.dmg?.toString() ?: UNKNOWN),
            "Speed" to (raw?.string("speedTilesPerSec") ?: UNKNOWN),
            "Range" to (raw?.string("range")?.let { if (it == "melee") "Melee" else it } ?: UNKNOWN),
            "Housing" to (troopPoints(catalogue, troop)?.toString() ?: UNKNOWN)),
        lock, focus, focus?.let { if (type == "keep") "GO TO KEEP" else "GO TO GOLD FORGE" })
}
