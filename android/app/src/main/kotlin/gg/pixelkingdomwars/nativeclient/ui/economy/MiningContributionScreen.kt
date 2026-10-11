package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.runtime.Composable
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import java.math.BigInteger

internal fun miningResourceLabel(id: String) = when (id) { "shards" -> "SHARDS"; "forge_ingot" -> "Gold Ingots"
    else -> id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) } }
internal fun miningBasket(view: MiningContributionView, quantities: Map<String, String>): List<MiningContributionLine>? = runCatching {
    quantities.filterValues { it.isNotEmpty() && it != "0" }.map { (id, quantity) -> MiningContributionLine(id, quantity).also { it.validate() } }
        .also { lines -> require(lines.all { line -> line.quantity.toBigInteger() <= view.resources.single { it.resourceId == line.resourceId }.available.toBigInteger() }) }
}.getOrNull()
internal fun miningBasketTotal(view: MiningContributionView, lines: List<MiningContributionLine>): BigInteger =
    view.value(lines).fold(BigInteger.ZERO) { sum, line -> sum + line.value.toBigInteger() }
internal const val MINING_CONTRIBUTION_CONSENT = "Your basket is reserved now and cannot be cancelled. If this basket earns a KEEP allocation, the whole basket is permanently consumed. Otherwise, the whole basket is returned."
internal fun miningContributionPill(operation: MiningContributionOperation) = when {
    operation.proof?.settlement?.outcome == "consumed" -> PaymentPill("CONSUMED", PaymentTone.DONE)
    operation.proof?.settlement?.outcome == "returned" -> PaymentPill("RETURNED", PaymentTone.DONE)
    operation.proof != null -> PaymentPill("RESERVED", PaymentTone.SENT)
    operation.refusal != null -> PaymentPill("DECLINED", PaymentTone.TROUBLE)
    operation.attemptRevision != null -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED BASKET", PaymentTone.OPEN)
}

/** The route retains its original ViewModel and admission; the old visible page and review are retired. */
@Composable fun MiningContributionScreen(model: MiningContributionViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, onFindRaid: (() -> Unit)? = null, onGoWorkshop: (() -> Unit)? = null,
    onGoBuild: (() -> Unit)? = null, onBack: () -> Unit) =
    gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeSmeltOwner(model, wallet, selectedBase, generation,
        actionsAllowed, onFindRaid, onGoWorkshop, onGoBuild, onBack)
