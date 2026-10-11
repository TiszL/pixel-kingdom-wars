package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.ops.HeroRecoverySpec
import gg.pixelkingdomwars.nativeclient.ops.HeroUpgradeSpec
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.ResearchSpec
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.roster.rosterHeroPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.armyDuration
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealKingdomLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealTimeFromNow

private fun gemsHave(value: String?): String = value?.takeIf { it.length <= 32 }?.let(::groupedAmount) ?: UNKNOWN

/** Gems on hand only from a Home read of the reviewed kingdom owned by the reviewed wallet: a balance read for another
 * kingdom or account (or before the owner is known) reads "…" beside the reviewed maximum, never its number. */
private fun reviewedGemsHave(home: BaseState, wallet: String, baseId: String?): String {
    val base = home.base ?: return UNKNOWN
    return if (baseId != null && base.baseId == baseId && base.player.wallet == wallet) gemsHave(home.balances?.gems) else UNKNOWN
}

/** Only an existing reviewed ceiling is displayed. The confirm owner revalidates funds; this does not introduce a
 * second affordability gate, choose another currency, infer an after-balance, or offer an unmounted top-up route. */
private fun reviewedGemsPrice(maximum: String, blocked: String?, busy: Boolean, decreases: Boolean): PriceUi =
    PriceUi(Currency.GEMS, if (maximum == "0") "0" else "Up to ${groupedAmount(maximum) ?: UNKNOWN}",
        when { blocked != null -> PriceStatus.UNAVAILABLE; maximum == "0" -> PriceStatus.SERVER_ZERO; else -> PriceStatus.OK },
        description = if (blocked != null || busy) null else "Pay up to $maximum Gems. This confirmation cannot switch to KEEP." +
            if (decreases) " The final charge may decrease as the timer runs." else "")

/** Presentation of ResearchSpec's original exact intent. [armedAtMs] is a local arming epoch, not a quote timestamp. */
internal fun researchGemSpendUi(state: ArmyUiState, baseGeneration: Long, actionsAllowed: Boolean, busy: Boolean,
    nowMs: Long, armedAtMs: Long): GemSpendUi? {
    val reviewed = state.domain.researchReview ?: return null
    val original = reviewed.intent
    val terms = runCatching { ResearchSpec.exact(original) }.getOrNull()?.takeIf { it.expectedCurrency == GameCurrency.GEMS } ?: return null
    if (state.wallet != original.wallet || state.baseId == null || state.baseId != terms.baseId || reviewed.generation != baseGeneration) return null
    val blocked = ordersBlockedReason(state.ordersAllowed, actionsAllowed)
    val remaining = secondsUntil(terms.finishesAt, nowMs)
    // Owner 2026-10-06 17:24 (SealWords.kt): the kingdom's name and the reviewed completion as time left, never the ids or
    // ISO instants; the frozen episode and completion stay in the saved request ResearchSpec compares and sends.
    val details = listOfNotNull(
        sealKingdomLine(state.home.base, terms.baseId),
        sealTimeFromNow(terms.finishesAt, nowMs)?.let { "Research completes $it" },
        "This payment keeps the reviewed currency and research episode. The charge may decrease as the timer runs.",
        if (original.attempted) "Retry the same saved payment and key. No replacement order will be created." else null,
    ).joinToString("\n")
    return GemSpendUi(
        kind = GemSpendKind.FINISH, title = "FINISH RESEARCH?",
        subjectArt = armyPortrait(state.catalogue, terms.troop, terms.currentLevel).ifBlank { "shape:unknown" },
        subjectName = liveTroopName(terms.troop), subjectLine = "Lv ${terms.currentLevel} → ${terms.toLevel}",
        progress = state.catalogue?.let { researchProgress(it, terms.toLevel, remaining) },
        timeLeft = remaining?.let(::armyDuration),
        price = reviewedGemsPrice(terms.maxCostKeep, blocked, busy, decreases = true),
        have = reviewedGemsHave(state.home, original.wallet, terms.baseId), after = null, short = null,
        quotedAtMs = armedAtMs, armedAtMs = armedAtMs, stage = if (busy) MoneyStage.SENDING else MoneyStage.READY,
        unavailableReason = blocked, consentDetails = details,
    )
}

/** Hero identity, level and injury come from the reviewed intent, never from the tab's mutable selectedHero.
 * RosterUiState exposes no account generation; its existing confirm owner remains the generation/wallet authority. */
internal fun heroGemSpendUi(state: RosterUiState, busy: Boolean, nowMs: Long, armedAtMs: Long): GemSpendUi? {
    val reviewed = state.domain.heroReview ?: return null
    val original = reviewed.intent.takeIf { it.expectedCurrency == GameCurrency.GEMS.name } ?: return null
    if (original.baseId == null || state.domain.heroesBaseId != original.baseId ||
        state.home.base?.baseId?.let { it != original.baseId } == true) return null
    val upgrade = original.kind == IntentKind.HERO_UPGRADE
    val parsed = runCatching {
        if (upgrade) {
            HeroUpgradeSpec.validateSend(original)
            Triple(HeroUpgradeSpec.hero(original), HeroUpgradeSpec.costKeep(original), HeroUpgradeSpec.level(original))
        } else {
            require(original.kind == IntentKind.HERO_RECOVERY)
            HeroRecoverySpec.validateSend(original)
            Triple(HeroRecoverySpec.hero(original), HeroRecoverySpec.costKeep(original), null)
        }
    }.getOrNull() ?: return null
    val (hero, maximum, level) = parsed
    val deadline: String?
    if (upgrade) deadline = null
    else deadline = runCatching { HeroRecoverySpec.recoveryUntil(original) }.getOrNull() ?: return null
    val remaining = deadline?.let { secondsUntil(it, nowMs) }
    val row = state.hero(hero)
    val name = row?.name ?: hero.replaceFirstChar { it.uppercase() }
    val blocked = when {
        state.heroesBlocked -> "A saved hero payment is still being checked. Open History to see it."
        else -> ordersBlockedReason(state.ordersAllowed, true)
    }
    val details = listOfNotNull(
        sealKingdomLine(state.home.base, original.baseId),
        "Pay with Gems. This confirmation cannot switch to KEEP.",
        deadline?.let { sealTimeFromNow(it, nowMs) }?.let { "The injury ends $it" },
        if (!upgrade) "Recovers this injury only. The final charge may decrease as the timer runs." else null,
    ).joinToString("\n")
    return GemSpendUi(
        kind = if (upgrade) GemSpendKind.BUY else GemSpendKind.FINISH,
        title = if (upgrade) "UPGRADE ${name.uppercase()}?" else "FINISH RECOVERY?",
        subjectArt = rosterHeroPortrait(state.catalogue, hero, if (upgrade) level?.minus(1) else row?.level).ifBlank { "shape:unknown" },
        subjectName = name.uppercase(), subjectLine = if (upgrade) "Lv ${requireNotNull(level) - 1} → $level" else "RECOVERY",
        progress = null, timeLeft = remaining?.let(::armyDuration),
        price = reviewedGemsPrice(maximum, blocked, busy, decreases = !upgrade),
        have = reviewedGemsHave(state.home, original.wallet, original.baseId), after = null, short = null,
        quotedAtMs = armedAtMs, armedAtMs = armedAtMs, stage = if (busy) MoneyStage.SENDING else MoneyStage.READY,
        unavailableReason = blocked, confirmLabel = if (upgrade) "UPGRADE" else null, showTiming = !upgrade, consentDetails = details,
    )
}
