package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.DivineFragmentState
import gg.pixelkingdomwars.nativeclient.data.DivineTrialState
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsState
import gg.pixelkingdomwars.nativeclient.data.RealmSalesSavedPolicy
import gg.pixelkingdomwars.nativeclient.data.RealmSalesState
import gg.pixelkingdomwars.nativeclient.data.SeekerResourceClaimsState
import gg.pixelkingdomwars.nativeclient.data.SeekerShardsClaimsState
import gg.pixelkingdomwars.nativeclient.model.ClanMembership
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineDoorUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FragmentSource
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FragmentSourceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RecoveryUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RewardTermRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RewardTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SourceState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TermState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TrialBestUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.divineSelectedDoor
import gg.pixelkingdomwars.nativeclient.ui.phasee.realmSalesPhase
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningTaxClaimsPhase
import java.math.BigInteger
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** Display only: no callback, quote creation, repository effect, or admission authority.
 * Ui-facing decimal strings use the shared groupedAmount contract. Wrapper fields explicitly named
 * Lamports/BaseUnits remain exact protocol quantities; the owner flow supplies monetary review formatting. */
internal data class MapActionHint(val reason: String) {
    val state: CommandState get() = CommandState.DISABLED
}

internal data class RealmPermitDisplay(
    /** Grouped one-based display number; never a protocol spot id. */
    val spotNumber: String,
    /** Catalogue lamports, never floating point. */
    val priceLamports: String?,
    val durationSeconds: Long?,
    /** Original retained quote, not a current quote or signing authority. */
    val quoteTotalLamports: String?,
    val quotaLine: String?,
    val recovery: RecoveryUi?,
    val primary: MapActionHint,
)

/** Missing offer/seller/coverage discovery cannot be inferred from valid wire indexes. */
internal fun realmPermitDisplay(state: RealmSalesState?, spot: Int, selectedRealm: Long?, policy: RealmSalesSavedPolicy?): RealmPermitDisplay {
    val op = state?.journal?.operation
    val preparation = op?.preparation?.takeIf { it.spot == spot.toLong() && it.realm == selectedRealm }
    return RealmPermitDisplay(
        spot.takeIf { it >= 0 }?.let { displayAmount((it.toLong() + 1).toString()) } ?: UNKNOWN,
        policy?.protocol?.permitPriceLamports?.toString(), policy?.protocol?.permitDurationSec,
        preparation?.quote?.requiredLamports,
        preparation?.let { "${displayAmount(it.quote.quotaRemaining.toString())} of ${displayAmount(op?.policy?.protocol?.quotaMax?.toString())} in the saved quote" },
        op?.let { RecoveryUi(it.request.idempotencyKey, realmSalesPhase(it, state?.journal?.settlementHeld == true),
            "CHECK SAVED OUTCOME", state?.busy == true) },
        MapActionHint(if (op != null) "Check the saved purchase in the existing permit flow."
            else "Realm availability is unavailable. Open the existing permit flow to review a purchase."),
    )
}

internal data class SeekerRewardsDisplay(
    /** Explicit current term on this page only; never a claim-all amount. */
    val current: List<RewardTileUi>,
    /** Source-addressed rows; mount under scopeLine, not a claim of chronological history. */
    val earlier: List<RewardTermRowUi>,
    val scopeLine: String,
    val hasMore: Boolean,
    val sourceUnavailable: Boolean,
    val recovery: List<RecoveryUi>,
    val primary: MapActionHint,
)

private data class ShareRow(val term: String, val spot: Int, val resource: String, val due: String) {
    val id: String get() = "$term:$spot:$resource"
}
private fun displayAmount(value: String?): String = groupedAmount(value) ?: UNKNOWN
private fun shareName(id: String): String = if (id == "SHARDS") "Shards"
    else id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
private fun shareIcon(id: String): String = if (id == "SHARDS") "shards" else "bag"
private fun originalShareState(receipt: Boolean, attempted: Boolean): TermState? = when {
    receipt -> TermState.CLAIMED
    attempted -> TermState.CHECKING
    else -> null
}
private fun shareRecovery(key: String, receipt: Boolean, attempted: Boolean, busy: Boolean) = RecoveryUi(key,
    when {
        receipt -> "Original receipt saved. Refresh its destination kingdom in the existing claim flow."
        attempted -> "Your original claim is being checked."
        else -> "Your original claim review is saved."
    }, "CHECK SAVED RECEIPT", busy)

private fun sharesDisplay(rows: List<ShareRow>, available: Boolean, enabled: Boolean, currentTermId: String?,
    hasMore: Boolean, savedRowId: String?, savedState: TermState?, recovery: List<RecoveryUi>): SeekerRewardsDisplay {
    val observed = if (available) rows else emptyList()
    // Discovery can lag a receipt; omit the active original's stale amount from current tiles.
    val current = observed.filter { currentTermId != null && it.term == currentTermId && it.id != savedRowId }
        .groupBy { it.resource }.map { (resource, values) ->
            val sum = values.fold(BigInteger.ZERO) { total, row -> total + row.due.toBigInteger() }
            RewardTileUi(shareIcon(resource), displayAmount(sum.toString()), shareName(resource), estimate = false)
        }
    val rendered = observed.map { row ->
        val saved = row.id == savedRowId
        val status = if (saved && savedState != null) savedState else if (row.due != "0") TermState.READY else TermState.NONE
        RewardTermRowUi(row.id, shareIcon(row.resource), "Spot ${displayAmount((row.spot.toLong() + 1).toString())} · ${row.term}",
            when (status) {
                TermState.CHECKING -> "Original ${shareName(row.resource)} claim is being checked"
                TermState.CLAIMED -> "Original ${shareName(row.resource)} receipt is saved"
                else -> "${displayAmount(row.due)} ${shareName(row.resource)} available on this page"
            }, status, if (saved && status == TermState.CHECKING) recovery.firstOrNull()?.key else null)
    }
    return SeekerRewardsDisplay(current, rendered, "Shares on this page", hasMore, !available, recovery,
        MapActionHint(when {
            recovery.isNotEmpty() -> "Check the saved claim in the existing island rewards flow."
            !available -> "Share history is unavailable. Check saved receipts in the existing flow."
            !enabled -> "New claims are paused. Saved shares and receipts remain available."
            else -> "Review one share at a time in the existing island rewards flow."
        }))
}

internal fun seekerMaterialsDisplay(state: SeekerResourceClaimsState?, currentTermId: String? = null): SeekerRewardsDisplay {
    val view = state?.view
    val op = state?.journal?.operation
    val request = op?.command?.request
    return sharesDisplay(view?.rows.orEmpty().map { ShareRow(it.termId, it.spotId, it.resourceId, it.dueQuantity) },
        view?.status == "available", view?.claimsEnabled == true, currentTermId, view?.nextCursor != null,
        request?.let { "${it.termId}:${it.spotId}:${it.resourceId}" },
        op?.let { originalShareState(it.receipt != null, it.attemptRevision != null) },
        op?.let { listOf(shareRecovery(it.command.key, it.receipt != null, it.attemptRevision != null, state?.busy == true)) }.orEmpty())
}

internal fun seekerShardsDisplay(state: SeekerShardsClaimsState?, currentTermId: String? = null): SeekerRewardsDisplay {
    val view = state?.view
    val op = state?.journal?.operation
    val request = op?.command?.request
    return sharesDisplay(view?.rows.orEmpty().map { ShareRow(it.termId, it.spotId, "SHARDS", it.dueQuantity) },
        view?.status == "available", view?.claimsEnabled == true, currentTermId, view?.nextCursor != null,
        request?.let { "${it.termId}:${it.spotId}:SHARDS" },
        op?.let { originalShareState(it.receipt != null, it.attemptRevision != null) },
        op?.let { listOf(shareRecovery(it.command.key, it.receipt != null, it.attemptRevision != null, state?.busy == true)) }.orEmpty())
}

/** One original tax operation. This is not a discovery feed of payable rounds. */
internal data class RealmCutDisplay(
    /** Original protocol round identifier, for host addressing rather than a formatted caption. */
    val round: String?,
    val spotNumber: String?,
    /** Exact unscaled amounts; never imply a KEEP display denomination from base units. */
    val proposedKeepBaseUnits: String?,
    val paidKeepBaseUnits: String?,
    val originalMaxFeeLamports: String?,
    val originalMaxRentLamports: String?,
    val originalMaxTotalLamports: String?,
    val phase: String?,
    val recovery: RecoveryUi?,
    val primary: MapActionHint,
) {
    val discoveryUnavailable: Boolean get() = true
}

internal fun realmCutDisplay(state: MiningTaxClaimsState?): RealmCutDisplay {
    val op = state?.journal?.operation
    val phase = op?.let { miningTaxClaimsPhase(it, state?.journal?.settlementHeld == true) }
    // Setup-only envelopes and contradictory/held outcomes must never look like KEEP paid.
    val paid = op?.takeIf { state?.journal?.settlementHeld != true && !it.failureObserved && it.failure == null &&
        !it.continuationObserved && it.continuation == null && !it.unattributedObserved }
        ?.settlement?.takeIf { it.status == "settled" }?.settlement
        ?.takeIf { it.claimFinalized && it.receipt.phase == "settled" }?.receipt?.paidKeepBaseUnits
    return RealmCutDisplay(op?.request?.round, op?.request?.spot?.let { displayAmount((it + 1).toString()) },
        op?.preparation?.intended?.claimBaseUnits, paid, op?.request?.caps?.maxFeeLamports,
        op?.request?.caps?.maxRentLamports, op?.request?.caps?.maxTotalLamports, phase,
        op?.let { RecoveryUi(it.request.idempotencyKey, phase.orEmpty(), "CHECK SAVED OUTCOME", state?.busy == true) },
        MapActionHint(if (op == null) "Round discovery is unavailable. Open the existing tax claim flow."
            else "Continue this original tax claim in the existing flow; setup and payment remain separate."))
}

internal data class DivineTrialsDisplay(
    val eventId: String?,
    /** Exact event timestamp for host formatting; time never grants an attempt. */
    val playEndsAt: String?,
    val army: List<ArmyTileUi>,
    val hero: String?,
    val triesLeft: Int?,
    val triesMax: Int?,
    val cutoff: Int?,
    val best: TrialBestUi?,
    val replayAttemptId: String?,
    /** Existing admitted attempt only; use the original controller's planner. */
    val planAttemptId: String?,
    val recovery: List<RecoveryUi>,
    val primary: MapActionHint,
)

private fun JsonObject.obj(key: String): JsonObject? = get(key) as? JsonObject
private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonObject.number(key: String): Int? = (get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
private fun JsonObject.rows(key: String): List<JsonObject> = (get(key) as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
private fun JsonObject.decimal(key: String): String? = text(key)?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }
private data class CompletedTrial(val id: String, val stars: Int, val destruction: Int)

/** A request response is persisted before participant refresh, which can fail independently. */
private fun attemptEvidenceAhead(evidence: JsonObject, attempts: List<JsonObject>): Boolean {
    val id = evidence.text("id") ?: return false
    val observed = attempts.singleOrNull { it.text("id") == id } ?: return true
    return when (val status = evidence.text("status")) {
        "admitted" -> false // A later participant state may already contain completion or abandonment.
        "committed" -> observed.text("status") == "admitted"
        "completed", "abandoned", "expired" -> observed.text("status") != status
        else -> false
    }
}

/** Input is validated saved state. Portraits are host-resolved; troop level is not an art tier. */
internal fun divineTrialsDisplay(state: DivineTrialState?, portraits: Map<String, String> = emptyMap()): DivineTrialsDisplay {
    val saved = state?.selected
    val policy = saved?.rules?.obj("policy")
    val army = policy?.obj("army")?.map { (troop, quantity) ->
        val count = displayAmount((quantity as? JsonPrimitive)?.content)
        val level = displayAmount(policy?.obj("levels")?.number(troop)?.toString())
        ArmyTileUi(troop, portraits[troop].orEmpty(), "L$level", "x$count", "$count ${shareName(troop)}, level $level")
    }.orEmpty()
    val participant = saved?.participant
    val attempts = participant?.rows("attempts").orEmpty()
    val commands = saved?.commands.orEmpty()
    val unreflected = commands.filter { command ->
        command.kind in listOf("attempts", "submit", "abandon") &&
            listOfNotNull(command.response, command.supersededBy).any { attemptEvidenceAhead(it, attempts) }
    }
    val allowance = policy?.number("attemptsPerWallet")
    val left = if (participant != null && allowance != null && attempts.size <= allowance && unreflected.isEmpty())
        allowance - attempts.size else null
    val best = attempts.filter { it.text("status") == "completed" }.mapNotNull { attempt ->
        val result = attempt.obj("result") ?: return@mapNotNull null
        CompletedTrial(attempt.text("id") ?: return@mapNotNull null, result.number("stars") ?: return@mapNotNull null,
            result.number("destruction") ?: return@mapNotNull null)
    }.maxWithOrNull(compareBy<CompletedTrial> { it.stars }.thenBy { it.destruction })
    val terminal = saved?.event?.obj("terminal")
    val finalRank = terminal?.rows("rankings")?.indexOfFirst {
        it.text("wallet") == state?.journal?.identity?.wallet && it.text("attemptId") == best?.id
    }?.takeIf { it >= 0 }?.plus(1)
    val recoveryCommands = commands.filter { it.retryable || it in unreflected }
    val representedAttempts = recoveryCommands.mapNotNull { it.attemptId ?: it.response?.text("id") }.toSet()
    val recovery = buildList<RecoveryUi> {
        recoveryCommands.forEach {
            add(RecoveryUi(it.id, if (it.retryable) "Your original trial request is being checked"
                else "Refresh participation to show the saved trial outcome", "CHECK RESULT", state?.busy == true))
        }
        attempts.filter { it.text("status") == "committed" }.forEach { attempt ->
            attempt.text("id")?.let { id -> if (id !in representedAttempts && none { it.key == id })
                add(RecoveryUi(id, "Your attempt is being checked", "CHECK RESULT", state?.busy == true)) }
        }
        if (saved != null && saved.held.isNotEmpty()) add(RecoveryUi(saved.id, "Saved trial evidence needs verification", "CHECK RESULT", state?.busy == true))
    }
    val plan = if (saved != null && terminal == null && recovery.isEmpty())
        attempts.singleOrNull { it.text("status") == "admitted" }?.text("id") else null
    return DivineTrialsDisplay(saved?.id, saved?.event?.text("playEndsAt"), army, null, left, allowance,
        policy?.number("divineSites"), best?.let { TrialBestUi(it.stars, "${it.destruction}%", displayAmount(finalRank?.toString()), UNKNOWN) },
        best?.id, plan, recovery, MapActionHint(when {
            recovery.isNotEmpty() -> "Check the original trial result before another action."
            plan != null -> "Continue the saved attempt in the existing trial planner."
            terminal != null -> "This trial has final results. Open its saved history."
            participant == null -> "Refresh trial participation in the existing trial flow."
            left == 0 -> "No attempts remain for this trial."
            else -> "Open the existing trial flow to review entry and plan an attempt."
        }))
}

internal data class FragmentWaitingRow(val key: String, val ui: FragmentSourceUi)
internal data class DivineFragmentsDisplay(
    val inKingdom: String,
    val waiting: List<FragmentWaitingRow>,
    /** A complete-wallet total is absent from this paginated controller state. */
    val totalWaiting: String?,
    val scopeLine: String,
    val recovery: List<RecoveryUi>,
    val featureOff: Boolean,
    val primary: MapActionHint,
)

internal fun divineFragmentsDisplay(state: DivineFragmentState?, selectedBaseId: String?, featureOn: Boolean): DivineFragmentsDisplay {
    val commands = state?.journal?.commands.orEmpty()
    val pending = commands.filter { it.unresolved }
    val recovery = pending.map { RecoveryUi(it.key,
        if (it.sent) "This original request may already be accepted. Check its outcome." else "Your original destination and review are saved.",
        "CHECK OUTCOME", state?.busy == true) }
    val stock = displayAmount(state?.stock?.takeIf { selectedBaseId != null && it.text("baseId") == selectedBaseId }?.decimal("available"))
    val waiting = buildList {
        state?.awards?.rows("rows")?.forEach { row ->
            if (row["delivery"] != JsonNull) return@forEach
            val award = row.obj("award") ?: return@forEach
            val id = award.text("eventId") ?: return@forEach
            // The awards page may predate a receipt already retained by this same controller.
            if (commands.any { it.kind == "delivery" && it.receipt != null && it.consent.text("eventId") == id }) return@forEach
            val amount = award.decimal("net")?.takeIf { it != "0" } ?: return@forEach
            val clan = award.obj("clan") != null
            val original = pending.firstOrNull { it.kind == "delivery" && it.consent.text("eventId") == id }
            val area = displayAmount(award.text("site")?.substringAfterLast('-')?.toIntOrNull()?.toString())
            add(FragmentWaitingRow("award:$id", FragmentSourceUi(if (clan) FragmentSource.CLAN else FragmentSource.SOLO,
                if (clan) "Clan citadel $area" else "Solo area $area",
                if (original != null) "Check the saved original request" else "${displayAmount(amount)} from the original settled occupation",
                if (original != null) null else displayAmount(amount), if (original != null) SourceState.NONE else SourceState.READY, null)))
        }
        state?.claims?.rows("rows")?.forEach { row ->
            val term = row.text("termId") ?: return@forEach
            val spot = row.number("spotId") ?: return@forEach
            val amount = row.decimal("claimable")?.takeIf { it != "0" } ?: return@forEach
            // Claim receipts are cumulative. Hide a stale page, but retain newly accrued shares
            // once discovery's previous total includes the highest matching accepted receipt.
            val acceptedTotal = commands.filter { it.kind == "claim" }.mapNotNull { it.receipt }
                .filter { it.text("termId") == term && it.number("spotId") == spot && it.text("termHash") == row.text("termHash") }
                .mapNotNull { it.decimal("cumulativeTotal")?.toBigInteger() }.maxOrNull()
            if (acceptedTotal != null && row.decimal("previousTotal")?.toBigInteger()?.let { it >= acceptedTotal } != true) return@forEach
            val original = pending.firstOrNull { c -> c.kind == "claim" && c.termHash == row.text("termHash") && c.consent.obj("request")?.let {
                it.text("termId") == term && it.number("spotId") == spot
            } == true }
            add(FragmentWaitingRow("share:$term:$spot", FragmentSourceUi(FragmentSource.SEEKER, "Seeker spot ${displayAmount((spot.toLong() + 1).toString())}",
                if (original != null) "Check the saved original request" else "Original term $term",
                if (original != null) null else displayAmount(amount), if (original != null) SourceState.NONE else SourceState.READY, null)))
        }
    }
    return DivineFragmentsDisplay(stock, waiting, null, "Earnings shown on these pages", recovery,
        !featureOn && commands.isEmpty(), MapActionHint(when {
            recovery.isNotEmpty() -> "Check the saved original delivery before another action."
            !featureOn -> "New fragment deliveries are unavailable. Saved history remains accessible."
            selectedBaseId == null -> "Choose a kingdom in the existing fragment flow."
            else -> "Review one earning or Seeker share at a time in the existing fragment flow."
        }))
}

internal data class DivineSceneDoors(val selected: DivineDoor?, val west: DivineDoorUi, val east: DivineDoorUi)

/** Navigation display only; registry, scene ownership and lifecycle remain with the host. */
internal fun divineSceneDoors(trialsAvailable: Boolean?, citadelsAvailable: Boolean?, membership: ClanMembership?,
    trial: DivineTrialState?, picked: DivineDoor? = null, entered: Boolean = false): DivineSceneDoors {
    val trials = divineTrialsDisplay(trial)
    val westReason = when (trialsAvailable) { true -> null; false -> "Opens later on this server"; null -> "Checking trial availability" }
    val eastReason = when {
        citadelsAvailable == null -> "Checking citadel availability"
        !citadelsAvailable -> "Opens later on this server"
        membership == null -> "Checking clan membership"
        membership.clan == null -> "Join a clan at the Clan Hall"
        else -> null
    }
    val selectedTrial = trial?.selected
    val trialOpen = trialsAvailable == true && selectedTrial != null && selectedTrial.event.obj("terminal") == null
    return DivineSceneDoors(divineSelectedDoor(picked, entered, trialOpen),
        DivineDoorUi(DivineDoor.WEST, "SOLO TRIALS", null,
            if (trials.triesLeft != null && trials.triesMax != null) "${displayAmount(trials.triesLeft.toString())} of ${displayAmount(trials.triesMax.toString())} tries left for this trial" else UNKNOWN,
            westReason != null, westReason),
        DivineDoorUi(DivineDoor.EAST, "CITADELS", null, eastReason, eastReason != null, eastReason))
}
