package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.MiningClaimsState
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimsProtocolPolicy
import gg.pixelkingdomwars.nativeclient.miningcontribution.MiningContributionIdentity
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftItemUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.*
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant

/** Additive tab projections; the accepted shell remains byte-identical.
 * Current flags are separate owner witnesses, cleared on refresh failure, identity/base/generation change.
 * A null body MUST use the existing owner's truthful unavailable/recovery presentation, never a permanent loader.
 * No callbacks, intent, Seal, success or new mutation stage are manufactured here.
 */
internal fun goldForgeSmeltTabUi(
    state: MiningContributionState?, identity: MiningContributionIdentity?, selectedBaseId: String?,
    repositoryCurrent: Boolean = false, viewCurrent: Boolean = false,
    items: Map<String, CraftItemUi> = emptyMap(),
): SmeltUi? {
    if (!repositoryCurrent || !viewCurrent || identity == null || state == null || state.busy || !state.advertised ||
        state.journal.identity != identity || state.journal.operation != null || runCatching { identity.validate() }.isFailure) return null
    val view = state.view?.takeIf { it.wallet == identity.wallet && it.baseId == selectedBaseId &&
        runCatching { it.validate() }.isSuccess } ?: return null
    val phase = when {
        !view.developmentReady -> SmeltState.NOT_READY
        !view.acceptingContributions -> SmeltState.PAUSED
        else -> SmeltState.CHOOSING
    }
    val tiles = view.resources.filter { it.available.toBigInteger().signum() > 0 }.map { row ->
        val item = items[row.resourceId]
        SmeltTileUi(row.resourceId, item?.icon.orEmpty(), row.available, 0, row.unitValue,
            item?.source.orEmpty(), item?.name ?: row.resourceId, canAdd = false)
    }
    val fill = view.dailyCapValue?.let { cap ->
        BigDecimal(view.committedValue).divide(BigDecimal(cap), 6, RoundingMode.DOWN)
            .coerceIn(BigDecimal.ZERO, BigDecimal.ONE).toFloat()
    } ?: 0f // Visual fill only; a deed furnace has no cap. Never used as a money quantity.
    return SmeltUi(view.day, view.pool, view.committedValue, view.dailyCapValue, "0", 0f, fill,
        emptyList(), null, tiles, null, null, null, smeltPrimaryCommand(phase, 0), null, phase)
}

/** The existing MiningClaimsRegistration must own the CLAIM/CONTINUE handoff, original journal and Seal.
 * [ownerHandoffReady] is a host composition assertion, not a capability inferred from the status response.
 * The kit has no inert READY gate: without that assertion no body is returned. Saved originals take precedence
 * even when discovery/status is lost; they are never called collected or expired by this projection.
 */
internal fun goldForgeClaimTabUi(
    state: MiningClaimsState?, identity: StarterIdentity?, policy: MiningClaimsProtocolPolicy?,
    repositoryCurrent: Boolean = false, statusCurrent: Boolean = false, ownerHandoffReady: Boolean = false,
): ClaimUi? {
    if (!repositoryCurrent || !ownerHandoffReady || state == null || identity == null || state.busy ||
        runCatching { identity.validate() }.isFailure || state.journal?.identity != identity) return null
    fun body(ready: String, phase: ClaimPhase, saved: Boolean = false, lock: ClaimLockUi? = null) =
        ClaimUi(ready, null, null, null, null, lock, MoneyStage.READY, null, saved, phase)
    if (state.journal?.operation != null) return body(UNKNOWN, ClaimPhase.READY, saved = true)
    if (!statusCurrent || !state.loaded || state.error != null || policy == null) return null
    val status = state.status?.takeIf { it.wallet == identity.wallet && runCatching { it.validate(policy) }.isSuccess } ?: return null
    val amount = status.claimableBaseUnits?.let { BigDecimal(it.toBigInteger(), status.decimals).stripTrailingZeros().toPlainString() }
    return when (status.state) {
        "ready" -> body(requireNotNull(amount), ClaimPhase.READY)
        "claimed" -> body(requireNotNull(amount), ClaimPhase.COLLECTED)
        "no_allocation" -> body(requireNotNull(amount), ClaimPhase.READY)
        "delayed" -> {
            val date = runCatching { Instant.ofEpochSecond(requireNotNull(status.claimableAfterUnixTimestamp).toLong()).toString() }.getOrNull() ?: return null
            body(requireNotNull(amount), ClaimPhase.LOCKED, lock = ClaimLockUi(date, null))
        }
        else -> null // No kit state for paused/revoked/unavailable; do not pretend a date or zero exists.
    }
}

/** Existing GemsBuy owner handles BUY/CONTINUE and its fee/consent/Seal/recovery; this is never a payment approval.
 * Only wallet KEEP is eligible. No custodial KEEP fallback, fixed rate/bounds, guessed quick chips or swap door.
 * Unknown wallet funds withhold a new-purchase body because this kit otherwise presents an enabled BUY.
 */
internal fun goldForgeGemsTabUi(
    state: GemsBuyState?, identity: StarterIdentity?, repositoryCurrent: Boolean = false,
    capabilityCurrent: Boolean = false, ownerHandoffReady: Boolean = false, requestedKeep: Long? = null,
    walletFunds: WalletFunds? = null, walletCurrent: Boolean = false,
): GemsUi? {
    if (!repositoryCurrent || !ownerHandoffReady || state == null || identity == null || state.busy ||
        runCatching { identity.validate() }.isFailure) return null
    val saved = state.saved
    if (saved != null) {
        if (saved.draft.wallet != identity.wallet || saved.draft.origin != identity.origin || saved.draft.cluster != identity.cluster) return null
        return GemsUi(UNKNOWN, UNKNOWN, saved.draft.keepIn.toString(), UNKNOWN, UNKNOWN, emptyList(), null,
            UNKNOWN, UNKNOWN, null, null, MoneyStage.READY, pendingRecovery = true,
            toShardsAvailable = false, swapOffered = false)
    }
    // available is cleared before each capability probe. fresh/hydrated belong to saved payments and receipts.
    val cap = state.capability?.takeIf { capabilityCurrent && state.available && it.enabled && "wallet-keep" in it.sources } ?: return null
    val keep = requestedKeep?.takeIf { it in cap.minConvertKeep..cap.maxConvertKeepPerTx } ?: return null
    val gems = runCatching { Math.multiplyExact(keep, cap.gemsPerKeep) }.getOrNull() ?: return null
    val wallet = walletFunds?.takeIf { walletCurrent }?.tokens?.entries
        ?.singleOrNull { it.key.equals("KEEP", ignoreCase = true) }?.value?.takeIf(TAB_AMOUNT::matches)?.toBigDecimal() ?: return null
    val pay = keep.toBigDecimal()
    return GemsUi("1 KEEP = ${cap.gemsPerKeep} GEMS", gems.toString(), keep.toString(), wallet.toPlainString(),
        if (wallet >= pay) (wallet - pay).stripTrailingZeros().toPlainString() else UNKNOWN,
        emptyList(), null, cap.minConvertKeep.toString(), cap.maxConvertKeepPerTx.toString(), null, null,
        MoneyStage.READY, pendingRecovery = false, toShardsAvailable = false, swapOffered = false,
        walletShort = wallet < pay)
}

private val TAB_AMOUNT = Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")
