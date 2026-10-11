package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.GemsState
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimStatusView
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimsProtocolPolicy
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimLockUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.goldForgeDefaultTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.goldForgeTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.goldForgeMoneySheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.goldForgeSmeltTabUi
import java.math.BigDecimal
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Detached observations only. Each current flag is supplied by the existing read owner after a
 * successful read in this session/base/generation. Retained snapshots and timestamps are insufficient.
 * The host withdraws the witness on invalidation/failure and supplies a per-read failure separately.
 * No field grants permission to prepare, sign, submit, continue or finish a money operation. */
internal data class GoldForgeHomeData(
    val identity: HomeRouteIdentity,
    val wallet: String,
    val building: Building? = null,
    val buildingCurrent: Boolean = false,
    val contribution: MiningContributionState? = null,
    val contributionCurrent: Boolean = false,
    val gems: GemsState? = null,
    val gemsCurrent: Boolean = false,
    val buy: GemsBuyState? = null,
    val buyCurrent: Boolean = false,
    /** The host completed a normal authenticated capability read for this current owner snapshot.
     * An exception, an idle default snapshot or an old read never establishes this witness. */
    val buyCapabilityObserved: Boolean = false,
    val walletFunds: WalletFunds? = null,
    val walletCurrent: Boolean = false,
    val claimStatus: MiningClaimStatusView? = null,
    val claimPolicy: MiningClaimsProtocolPolicy? = null,
    val claimsCurrent: Boolean = false,
    val loading: Boolean = false,
    val failures: Map<String, String> = emptyMap(),
)

/** Notices are keyed by SMELT, CLAIM and GEMS. A null body must render its notice in the sheet bridge,
 * never the kit's indefinite checking fallback. Non-null bodies also retain the read-only notice. */
internal data class GoldForgeHomeUi(val sheet: GoldForgeSheetUi, val notices: Map<String, String>)

private const val READ_ONLY = "This Gold Forge view is read-only."
private val AMOUNT = Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")

/** A projection onto the existing single Home stack; defaults preserve BUILD and normal Home. */
internal fun goldForgeHomeHud(
    ui: gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi,
    resources: List<gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi>?,
    hideChrome: Boolean,
): gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi = if (resources == null && !hideChrome) ui else ui.copy(
    resources = resources ?: ui.resources,
    deckVisible = ui.deckVisible && !hideChrome, toolsOpen = ui.toolsOpen && !hideChrome,
    herald = if (hideChrome) null else ui.herald, context = if (hideChrome) null else ui.context,
)

/** Pure A6 presentation. CLAIM uses the validated status GET directly: no MiningClaimsJournal,
 * MiningClaimsState, client, repository or signing owner is constructed to satisfy another mapper.
 * A Gems amount is only a display preview; absent an explicit selection it uses the server minimum.
 * Every spend gate remains false, every Seal remains null, and no receipt celebration is produced. */
internal fun goldForgeHomeUi(
    data: GoldForgeHomeData,
    currentIdentity: HomeRouteIdentity?,
    requestedTab: String? = null,
    selectedTab: String? = null,
    requestedKeep: Long? = null,
): GoldForgeHomeUi {
    val sessionWallet = (data.identity.session as? AccountSession)?.wallet
    val current = data.identity == currentIdentity && data.wallet.isNotBlank() &&
        (sessionWallet == null || sessionWallet == data.wallet)
    fun failure(vararg names: String): String? = data.failures.entries.firstOrNull { row ->
        names.any { it.equals(row.key, ignoreCase = true) } && row.value.isNotBlank()
    }?.value
    val smeltFailure = failure(GoldForgeTabs.SMELT, "contribution")
    val claimFailure = failure(GoldForgeTabs.CLAIM, "claims")
    val gemsFailure = failure(GoldForgeTabs.GEMS)
    val buyFailure = failure("buy")
    val walletFailure = failure("wallet")
    val notices = linkedMapOf<String, String>()
    fun absent(tab: String, failed: String? = null): String = when {
        !current -> "Open the Gold Forge for the current kingdom."
        failed != null -> failed
        data.loading -> "Checking the forge…"
        tab == GoldForgeTabs.SMELT -> "Smelting details are unavailable for this kingdom."
        tab == GoldForgeTabs.CLAIM -> "Mint status is unavailable."
        else -> "Gems purchase details are unavailable."
    }

    val contribution = data.contribution?.takeIf {
        current && data.contributionCurrent && it.journal.identity.wallet == data.wallet &&
            runCatching { it.journal.identity.validate() }.isSuccess
    }
    val savedContribution = contribution?.journal?.operation != null
    val smelt = if (smeltFailure == null && contribution != null && !savedContribution) {
        goldForgeSmeltTabUi(contribution, contribution.journal.identity, data.identity.baseId,
            repositoryCurrent = true, viewCurrent = true)?.let { observed ->
            // The accepted mapper already withholds basket selection. Make the reason explicit;
            // a real development/server lock keeps its authoritative explanation.
            if (observed.state == SmeltState.CHOOSING && observed.primary.state == CommandState.DISABLED) observed.copy(primary = observed.primary.copy(
                reason = READ_ONLY, verb = Verb.OFF)) else observed
        }
    } else null
    notices[GoldForgeTabs.SMELT] = when {
        savedContribution -> "A saved smelting request needs attention in its original receipt controls."
        smelt != null -> READ_ONLY
        else -> absent(GoldForgeTabs.SMELT, smeltFailure)
    }
    // SPEC §1 hero: the next coins come at 00:00 UTC after the server's mining day, counted from the server's own
    // clock in that same admitted view (never the device clock). Unknown stays null and reads "…".
    val nextCoinsIn = contribution?.view?.takeIf { smeltFailure == null && it.wallet == data.wallet &&
        it.baseId == data.identity.baseId && runCatching { it.validate() }.isSuccess }
        ?.let { goldForgeNextCoinsIn(it.day, it.serverNow) }

    val policy = data.claimPolicy
    val status = data.claimStatus?.takeIf {
        current && data.claimsCurrent && claimFailure == null && policy != null && it.wallet == data.wallet &&
            runCatching { it.validate(policy) }.isSuccess
    }
    val claim = when {
        !current -> null
        claimFailure != null -> claimBody(UNKNOWN, ClaimPhase.ERROR)
        status == null -> null
        // No claim owner can act from this sheet (no independent signing pins; the journal owner stays under Bases),
        // so the ready CLAIM stays on its face, off, and says plainly that collecting is not open yet.
        status.state == "ready" -> claimBody(requireNotNull(claimAmount(status)), ClaimPhase.READY,
            nextCoinsIn = nextCoinsIn, closedReason = GOLD_FORGE_CLAIM_CLOSED)
        status.state == "claimed" -> claimBody(requireNotNull(claimAmount(status)), ClaimPhase.COLLECTED, nextCoinsIn = nextCoinsIn)
        // `claim-locked.png` "Wed 14 Oct". The server reason is a technical code (never player copy) and the SPEC
        // forbids mock text, so the tray's reason line stays hidden.
        status.state == "delayed" -> runCatching {
            val date = goldForgeClaimLockDate(requireNotNull(status.claimableAfterUnixTimestamp).toLong())
            claimBody(requireNotNull(claimAmount(status)), ClaimPhase.LOCKED, ClaimLockUi(date, null), nextCoinsIn)
        }.getOrNull()
        else -> null
    }
    notices[GoldForgeTabs.CLAIM] = when {
        !current -> absent(GoldForgeTabs.CLAIM)
        claimFailure != null -> claimFailure
        status?.state == "no_allocation" -> "The tray is empty. No KEEP is ready to collect."
        status?.state == "paused" -> "The mint is paused. $READ_ONLY"
        status?.state == "revoked" -> "Minted coins are unavailable for this account. Check the original claim records."
        status?.state == "unavailable" -> claimUnavailable(status.reason)
        claim != null -> READ_ONLY
        else -> absent(GoldForgeTabs.CLAIM)
    }
    val claimReady = status?.state == "ready" && claim?.phase == ClaimPhase.READY &&
        status.claimableBaseUnits?.toBigIntegerOrNull()?.signum() == 1

    val buy = data.buy?.takeIf { current && data.buyCurrent &&
        (it.saved == null || it.saved.draft.wallet == data.wallet) }
    // A saved original can need receipt checks after a wallet attempt or a credited response.
    // Leaving the body null avoids GemsBody's misleading "waiting for your wallet" callout.
    val savedBuy = buy?.saved != null
    val wallet = data.walletFunds?.takeIf { current && data.walletCurrent && walletFailure == null }
    val walletAmount = wallet?.tokens?.entries?.singleOrNull { it.key.equals("KEEP", ignoreCase = true) }
        ?.value?.takeIf(AMOUNT::matches)?.toBigDecimalOrNull()
    val capabilityOff = buyFailure == null && data.buyCapabilityObserved && buy != null &&
        !buy.available && buy.capability == null && !savedBuy && !buy.busy
    val gems = if (capabilityOff) gemsOffBody() else if (buyFailure == null && walletFailure == null && buy != null && !savedBuy && !buy.busy) {
        val cap = buy.capability?.takeIf { buy.available && it.enabled && "wallet-keep" in it.sources &&
            it.gemsPerKeep > 0 && it.minConvertKeep > 0 && it.maxConvertKeepPerTx >= it.minConvertKeep }
        val keep = (requestedKeep ?: cap?.minConvertKeep)?.takeIf { cap != null &&
            it in cap.minConvertKeep..cap.maxConvertKeepPerTx }
        if (cap != null && keep != null && walletAmount != null) runCatching {
            val amount = Math.multiplyExact(keep, cap.gemsPerKeep)
            val pay = keep.toBigDecimal()
            GemsUi("1 KEEP = ${cap.gemsPerKeep} GEMS", amount.toString(), keep.toString(),
                walletAmount.toPlainString(), if (walletAmount >= pay) (walletAmount - pay).stripTrailingZeros().toPlainString() else UNKNOWN,
                emptyList(), null, cap.minConvertKeep.toString(), cap.maxConvertKeepPerTx.toString(),
                null, null, MoneyStage.READY, pendingRecovery = false, toShardsAvailable = false,
                swapOffered = false, walletShort = walletAmount < pay, actionsAllowed = false)
        }.getOrNull() else null
    } else null
    notices[GoldForgeTabs.GEMS] = when {
        savedBuy -> "A saved Gems purchase needs attention in its original receipt controls."
        capabilityOff -> requireNotNull(gems?.offReason)
        gems != null -> READ_ONLY
        else -> absent(GoldForgeTabs.GEMS, buyFailure ?: walletFailure)
    }

    val shell = goldForgeMoneySheetUi(
        building = data.building, buildingCurrent = current && data.buildingCurrent,
        gems = data.gems, gemsCurrent = current && data.gemsCurrent && gemsFailure == null,
        buy = buy, walletFunds = wallet, walletCurrent = wallet != null,
        requestedTab = requestedTab, selectedTab = selectedTab, nextCoinsIn = nextCoinsIn,
    )
    // `error.png`: a finished read pass with any failed read says "Reconnecting to the forge…" (the same rule as the
    // error toast, [goldForgeHomeAlert]); a read still in flight keeps the building's own status.
    val heroStatus = if (goldForgeHomeAlert(data) != null) HeroStatusUi(HeroStatusKind.RECONNECTING) else shell.heroStatus
    val tabs = goldForgeTabs(claimReady, gemsWaiting = if (savedBuy) 1 else 0, legacy = false).map { tab ->
        if (tab.id == GoldForgeTabs.GEMS && tab.badge != null)
            tab.copy(badge = tab.badge.copy(description = "A saved Gems purchase needs attention.")) else tab
    }
    val ids = tabs.map { it.id }
    val selected = ids.firstOrNull { it.equals(selectedTab, ignoreCase = true) }
        ?: goldForgeDefaultTab(requestedTab, ids, claimReady) ?: GoldForgeTabs.SMELT
    return GoldForgeHomeUi(shell.copy(heroStatus = heroStatus, tabs = tabs, selectedTab = selected, smelt = smelt,
        claim = claim, gems = gems), notices)
}

private fun claimBody(amount: String, phase: ClaimPhase, lock: ClaimLockUi? = null, nextCoinsIn: String? = null,
    closedReason: String? = null) =
    ClaimUi(amount, null, null, null, null, lock, MoneyStage.READY, nextCoinsIn,
        canResumeSaved = false, phase = phase, actionsAllowed = false, closedReason = closedReason)

/** Seconds from the server's [serverNow] to 00:00 UTC after the mining [day] ("2026-10-05"), as D-070 `fmtDur`
 *  ("6h 20m"). Null when either value does not parse; never the device clock. */
internal fun goldForgeNextCoinsIn(day: String, serverNow: String): String? = runCatching {
    val next = LocalDate.parse(day).plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
    fmtDur(Duration.between(Instant.parse(serverNow), next).seconds)
}.getOrNull()

/** The mint's opening day from the server's unlock second, as the frame writes it ("Wed 14 Oct", `claim-locked.png`),
 *  in the player's zone and language. */
internal fun goldForgeClaimLockDate(epochSecond: Long, zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault()): String =
    DateTimeFormatter.ofPattern("EEE d MMM", locale).withZone(zone).format(Instant.ofEpochSecond(epochSecond))

private fun gemsOffBody() = GemsUi(
    rate = UNKNOWN, amount = UNKNOWN, pay = UNKNOWN, walletKeep = UNKNOWN, walletAfter = UNKNOWN,
    quick = emptyList(), selectedQuick = null, min = UNKNOWN, max = UNKNOWN, short = null, shortfallFor = null,
    stage = MoneyStage.READY, pendingRecovery = false, toShardsAvailable = false, swapOffered = false,
    phase = GemsPhase.OFF, offReason = "Wallet Gems purchases are unavailable on this server.", actionsAllowed = false,
)

private fun claimAmount(status: MiningClaimStatusView): String? = status.claimableBaseUnits?.let {
    BigDecimal(it.toBigInteger(), status.decimals).stripTrailingZeros().toPlainString()
}

private fun claimUnavailable(reason: String?): String = when (reason) {
    "DISABLED" -> "The mint is not available on this server."
    "NOT_PROJECTED" -> "Minted coins are not available yet."
    "BUSY" -> "The mint is busy. Check again shortly."
    "TIMEOUT", "SOURCE_UNAVAILABLE" -> "The forge cannot load minted coins right now."
    "INVALID_WALLET" -> "Mint status is unavailable for this wallet."
    else -> "Mint status is unavailable. Original claim records remain with their receipt controls."
}
