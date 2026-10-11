package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.builderFinishReviewTerms
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ownsBuildingArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealKingdomLine

/** GfIcon reaches the kit's PkwIcon, which now draws every building art the shared rule owns (BuildingIconArt.kt:
 *  Phase E tiers, the Keep strip, pack tier sprites). Any other `ui:` name is still unresolvable there (5fcd68e0 F1),
 *  so it keeps the unknown glyph: never an empty well. */
internal fun gemSpendSubjectArt(art: String?): String =
    art?.takeIf { it.isNotBlank() && (!it.startsWith("ui:") || ownsBuildingArt(it)) } ?: "shape:unknown"

/** Presentation of the existing original consent, not a live quote or a payment owner. The repository re-reads
 * the job and currency coverage on confirm. Its charge may decrease, so neither a post-spend balance nor FREE
 * is inferred here. [armedAtMs] is the review's local arming epoch, not a claimed server quote timestamp. */
internal fun gemSpendUi(state: KingdomUiState, busy: Boolean, now: Long, armedAtMs: Long,
    scene: BaseScene? = null): GemSpendUi? {
    val terms = builderFinishReviewTerms(state)?.takeIf { it.expectedCurrency == GameCurrency.GEMS } ?: return null
    val maximum = terms.consent.maxCostKeep.takeIf { it.matches(Regex("[1-9][0-9]*")) }?.toBigIntegerOrNull()
    val have = state.home.balances?.gems?.takeIf { it.length <= 32 && it.matches(Regex("0|[1-9][0-9]*")) }
        ?.toBigIntegerOrNull()
    val short = if (maximum != null && have != null && have < maximum) maximum - have else null
    val unavailable = when {
        !state.ordersAllowed || !state.deedActionsAllowed -> "Game orders are paused"
        maximum == null -> "Review the current builder job again"
        have == null -> "Gems balance unavailable"
        short != null -> "Not enough Gems. Top-up is unavailable here"
        else -> null
    }
    val building = state.base?.takeIf { it.baseId == terms.baseId }?.buildings
        ?.singleOrNull { it.id == terms.consent.buildingId }
    val facts = building?.let { readBuildingFacts(state, it, busy, now, scene) }
    val progress = baseJobProgress(terms.consent.startedAt, terms.consent.finishesAt, now)
    val saved = state.home.builderFinishReview?.intent?.attempted == true
    return GemSpendUi(
        kind = GemSpendKind.FINISH,
        title = "FINISH NOW?",
        subjectArt = gemSpendSubjectArt(facts?.artNow),
        subjectName = building?.let { trayLabel(it.type) } ?: if (terms.consent.kind == "clear_obstacle") "CLEAR OBSTACLE" else "BUILDER JOB",
        subjectLine = if (saved) "Same saved payment" else terms.consent.kind.replace('_', ' ').uppercase(),
        progress = progress?.fraction,
        timeLeft = progress?.remaining?.removeSuffix(" remaining"),
        price = PriceUi(Currency.GEMS, maximum?.let { "Up to ${fmtN(it.toString())}" },
            if (unavailable == null) PriceStatus.OK else PriceStatus.UNAVAILABLE,
            description = if (unavailable == null && !busy) "Pay up to ${terms.consent.maxCostKeep} Gems. The charge may decrease as this job finishes naturally." else null),
        have = have?.let { fmtN(it.toString()) } ?: "…",
        after = null,
        short = short?.let { fmtN(it.toString()) },
        quotedAtMs = armedAtMs,
        armedAtMs = armedAtMs,
        stage = if (busy) MoneyStage.SENDING else MoneyStage.READY,
        unavailableReason = unavailable?.let { "$it. Maximum: ${terms.consent.maxCostKeep} Gems" },
    )
}

/** The KEEP builder-finish confirm's identity line in player words (owner 2026-10-06 17:24, SealWords.kt): the kingdom's
 * name, then the job's building as the Gems Seal names it (else the job kind in words). The frozen job, building id and
 * instants stay in the saved request [builderFinishReviewTerms] reads; this never prints them. */
internal fun builderFinishSubjectLine(state: KingdomUiState, terms: gg.pixelkingdomwars.nativeclient.model.BuilderJobSpeedupIntent): String {
    val building = state.base?.takeIf { it.baseId == terms.baseId }?.buildings?.singleOrNull { it.id == terms.consent.buildingId }
    val job = terms.consent.kind.replace('_', ' ')
    return sealKingdomLine(state.base, terms.baseId) + "\n" + (building?.let { "${trayLabel(it.type)} · $job" } ?: job.replaceFirstChar { it.uppercase() })
}
