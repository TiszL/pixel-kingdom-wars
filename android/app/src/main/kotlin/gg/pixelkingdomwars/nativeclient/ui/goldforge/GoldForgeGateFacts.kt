package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.EconomyState
import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact

internal data class GoldForgeGateFacts(
    val serverFeatures: Map<String, GateFact>,
    val history: Map<String, GateFact>,
)

/** Navigation observations only; every existing owner still admits its own reads and commands.
 * [current] must witness the exact session (including origin/cluster) and selected-base generation
 * from which the supplied owner states came. EconomyState has no wallet field of its own.
 * [balanceCurrent] additionally witnesses a successful fresh balance read for this exact snapshot;
 * a retained positive number alone cannot establish saved KEEP. Neither witness is inferred here.
 */
internal fun goldForgeGateFacts(
    wallet: String,
    baseId: String?,
    current: Boolean,
    gemsSupported: Boolean? = null,
    gemsBuy: GemsBuyState? = null,
    contribution: MiningContributionState? = null,
    economy: EconomyState? = null,
    balanceCurrent: Boolean = false,
): GoldForgeGateFacts {
    val owned = current && wallet.isNotBlank()
    val selectedBase = baseId?.takeIf { it.isNotBlank() }
    val savedPurchase = owned && gemsBuy?.saved?.draft?.wallet == wallet
    val smelt = owned && selectedBase != null && contribution?.advertised == true && !contribution.busy &&
        contribution.journal.identity.wallet == wallet && contribution.view?.let {
            it.wallet == wallet && it.baseId == selectedBase
        } == true
    // History remains discoverable through an unrelated read failure or a base switch. The Legacy
    // adapter separately checks each row before displaying an outcome; this grants no return action.
    val owed = owned && !economy?.withdrawals.isNullOrEmpty()
    val savedKeep = owned && selectedBase != null && balanceCurrent && economy != null && economy.baseId == selectedBase &&
        !economy.loading && economy.errors["/balances"] == null && economy.balances?.keep?.let {
            GOLD_FORGE_CUSTODIAL_AMOUNT.matches(it) && it.toBigDecimalOrNull()?.signum() == 1
        } == true
    fun fact(proved: Boolean): GateFact = if (proved) GateFact.Allowed else GateFact.Unknown
    return GoldForgeGateFacts(
        serverFeatures = mapOf(
            "gems" to fact(owned && gemsSupported == true),
            "gems.buyPending" to fact(savedPurchase),
            "phaseE.miningContribution" to fact(smelt),
        ),
        history = mapOf("forge.owed" to fact(owed), "forge.saved" to fact(savedKeep)),
    )
}

private val GOLD_FORGE_CUSTODIAL_AMOUNT = Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")
