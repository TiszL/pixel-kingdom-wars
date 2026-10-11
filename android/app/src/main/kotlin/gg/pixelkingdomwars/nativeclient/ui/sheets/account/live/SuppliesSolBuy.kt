package gg.pixelkingdomwars.nativeclient.ui.sheets.account.live

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BEING_CHECKED
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.HomeSolPurchase
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.SOL_BUILDERS_STAY
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.SOL_SIGN_ONCE
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.SolPurchaseFlow
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.rememberSolPurchase
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.solFeeLine

/*
 * BUILD › SUPPLIES SOL offers bought in place (account/shop.png: "`CostPill(SOL 0.1)` → SOL Seal"; owner 2026-10-06 "I
 * should not see any even 1 of old screens"). Before this, a SOL shield, builder or raid-energy BUY left the designed shelf
 * for the old dark PURCHASES page (`BasePurchaseRoute`). Now the tap raises the designed SOL Seal over the shelf and the
 * money sequence runs on the shelf's own status row; nothing stacks a second sheet over it.
 *
 * Money rule: this file adds no quote, signature, submission or payment code. Every step is the EXISTING Home purchase
 * flow (`rememberSolPurchase` / `SolPurchaseOverlay` over `BasePurchaseViewModel` + `BasePurchaseWallet`, the same owner
 * and sender HIRE BUILDER, Keep EXPAND and the Mine SOL step already use). The Seal lines are existing sentences: the Seal
 * grammar's "Paid from your wallet. You sign once.", the owner screen's fee line, builders.png's hire line and the
 * purchase screen's own shield facts (BasePurchaseScreen `BasePurchaseOfferFacts`, verbatim).
 */

/** A second SOL tap while one buy is still in flight or needs its recovery door (a status line, not consent wording). */
internal const val SUPPLIES_SOL_OPEN = "Finish the open purchase first."

/** One SOL supply the player chose: the owner's purchase [kind] for [baseId] and the Seal's [title]. */
internal data class SuppliesSolBuy(val kind: String, val baseId: String, val title: String)

/** The Seal title for an offer row ("HIRE A BUILDER" stays a hire; every other row reads "BUY <ROW>"). Its first word is
 *  the Seal's confirm label (HIRE / BUY). */
internal fun suppliesSolTitle(offerTitle: String?): String {
    val row = offerTitle?.trim()?.takeIf { it.isNotEmpty() }?.uppercase() ?: return "BUY"
    return if (row.startsWith("HIRE") || row.startsWith("BUY")) row else "BUY $row"
}

/** The buy for a SOL target and the offer row the player tapped. */
internal fun suppliesSolBuy(target: SupplyTarget.BasePurchase, offerTitle: String?): SuppliesSolBuy =
    SuppliesSolBuy(target.kind, target.baseId, suppliesSolTitle(offerTitle))

/** The purchase screen's own facts for a kind (BasePurchaseScreen `BasePurchaseOfferFacts`, verbatim); null for none. */
internal fun suppliesSolKindNote(kind: String): String? = when (kind) {
    "builder" -> SOL_BUILDERS_STAY
    "shield" -> "Extends your current shield. If the shield breaks or ends before the payment settles, it cannot be extended. Shields are down during Warzones."
    "warzone_shield" -> "Only during an active Warzone. Warzone shields do not stack."
    else -> null
}

/** The Seal's lines: what the purchase does, the sign-once line, then the owner's fee line once its review arrived. */
internal fun suppliesSolLines(kind: String, review: BasePurchaseOffer?): List<String> =
    listOfNotNull(suppliesSolKindNote(kind), SOL_SIGN_ONCE, solFeeLine(review))

/** One composed SOL buy: the owner flow and the Seal's lines. */
internal class SuppliesSolVisit(val buy: SuppliesSolBuy, val flow: SolPurchaseFlow, val lines: List<String>) {
    /** Something is in flight or needs its recovery door: the visit must not be replaced by another tap. */
    val moving: Boolean get() = flow.sealUp || flow.view.uncertain || flow.view.stage != MoneyStage.READY || flow.recovery
}

/**
 * Composes the existing purchase flow for [buy] and raises its Seal once (this tap IS the request for consent, as
 * `LivePaidUpgradeSeal` does). [onEnd] runs when the purchase finished, the Seal was backed out of, or the owner refused
 * it with nothing in flight (its reason went to [explain], which the shelf shows on its info card).
 */
@Composable internal fun rememberSuppliesSolVisit(purchase: HomeSolPurchase, buy: SuppliesSolBuy, onEnd: () -> Unit,
    explain: (String) -> Unit): SuppliesSolVisit {
    val end by rememberUpdatedState(onEnd)
    val say by rememberUpdatedState(explain)
    var refused by remember { mutableStateOf(false) }
    val flow = rememberSolPurchase(purchase, buy.kind, buy.baseId, null, onFinished = { end() },
        explain = { message -> say(message); refused = true }, onSealCancel = { end() })
    val raise by rememberUpdatedState(flow.primary)
    LaunchedEffect(Unit) { raise() }
    val visit = SuppliesSolVisit(buy, flow, suppliesSolLines(buy.kind, flow.review))
    val moving = visit.moving
    LaunchedEffect(refused, moving) { if (refused && !moving) end() }
    return visit
}

/**
 * The shelf's status row for a SOL buy in flight (shop.png has no second sheet): the owner's own sentences, the money
 * sequence on a kit MoneyButton (Check wallet → Sending → SENT, RETRY), "Being checked" + CHECK for an uncertain answer,
 * and the stone DETAILS door ([onDetails]: the purchase screen's recovery) only while a saved purchase needs it.
 */
@Composable internal fun SuppliesSolStatus(visit: SuppliesSolVisit, onDetails: () -> Unit) {
    val flow = visit.flow
    val view = flow.view
    flow.messages.forEach { line ->
        PkwText(line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
    }
    val label = visit.buy.title.substringBefore(' ')
    when {
        view.uncertain -> PrimaryButton("CHECK", flow.check, Modifier.fillMaxWidth(), verb = Verb.STONE, sub = BEING_CHECKED)
        view.stage != MoneyStage.READY -> MoneyButton(view.stage, label, flow.retry, Modifier.fillMaxWidth())
        else -> Unit
    }
    if (flow.recovery) SecondaryButton("DETAILS", onDetails, Modifier.fillMaxWidth())
}
