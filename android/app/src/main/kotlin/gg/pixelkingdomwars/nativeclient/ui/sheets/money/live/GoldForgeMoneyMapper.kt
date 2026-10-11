package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.GemsState
import gg.pixelkingdomwars.nativeclient.data.MiningClaimsState
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.goldForgeDefaultTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.goldForgeTabs

/**
 * Display-only shell for the existing Gold Forge sheet at Opus 1a1eb4bc.
 *
 * Each `*Current` flag is an explicit assertion by the observing owner that its input belongs to the current
 * account/base and its read is current. Merely retaining a repository snapshot or WalletFunds.asOf cannot establish
 * this. Flags default closed; the owner clears them on invalidation, failed refresh or identity change. [buy] must
 * also come from the current account's repository, but its saved original survives failed discovery and refresh.
 *
 * This base has no GoldForgeHost or MS-E balance-band/HomeRequest.GoldForge types. No substitute DTO or host is
 * declared here. All money-tab Uis remain null: the eventual owner must supply the documented GoldForgeSheet bridge
 * to the existing contribution, mining-claim and Gems bodies, with outer scroll disabled for a scrolling bridge.
 * Those bodies retain original-request recovery, fee/rent review, consent, signing and receipt/hydration gates.
 * This function creates no Seal, action callback, success state, receipt celebration or ledger-to-wallet conversion.
 * LEGACY remains outside this shell until its custody/recovery owner supplies a separate accepted projection.
 *
 * [buildingCurrent] also means the owner has admitted a live building; Building has no destroyed flag. Timers arrive
 * already formatted from their owning observation. No deadline or money amount is calculated from a client clock.
 * [historyAvailable] is true only when the host binds the real history destination.
 */
internal fun goldForgeMoneySheetUi(
    building: Building? = null,
    buildingCurrent: Boolean = false,
    gems: GemsState? = null,
    gemsCurrent: Boolean = false,
    buy: GemsBuyState? = null,
    claims: MiningClaimsState? = null,
    claimsCurrent: Boolean = false,
    walletFunds: WalletFunds? = null,
    walletCurrent: Boolean = false,
    requestedTab: String? = null,
    selectedTab: String? = null,
    nextCoinsIn: String? = null,
    constructionRemaining: String? = null,
    historyAvailable: Boolean = false,
): GoldForgeSheetUi {
    val forge = building?.takeIf { buildingCurrent && it.type.equals("goldforge", ignoreCase = true) && it.level >= 0 }
    val working = forge != null && forge.level > 0 && !forge.underConstruction
    val hero = when {
        forge == null -> HeroStatusUi(HeroStatusKind.RECONNECTING)
        forge.underConstruction -> HeroStatusUi(HeroStatusKind.UNDER_CONSTRUCTION, constructionRemaining?.takeIf { it.isNotBlank() })
        working -> HeroStatusUi(HeroStatusKind.FORGING, nextCoinsIn?.takeIf { it.isNotBlank() })
        else -> HeroStatusUi(HeroStatusKind.AT_REST)
    }
    val gemsAmount = gems?.takeIf { gemsCurrent && it.supported && !it.busy && it.unavailable == null }
        ?.overview?.gems?.takeIf(GOLD_FORGE_AMOUNT::matches)
    // No fallback to GemsState.balances.keep: that is custodial KEEP, never wallet KEEP.
    val walletAmount = walletFunds?.takeIf { walletCurrent }?.tokens?.entries
        ?.singleOrNull { it.key.equals("KEEP", ignoreCase = true) }?.value?.takeIf(GOLD_FORGE_AMOUNT::matches)
    val status = claims?.takeIf { claimsCurrent && it.loaded && !it.busy && it.error == null }?.status
    val claimReady = status?.let {
        it.state == "ready" && it.preparationAllowed && it.claimableBaseUnits?.matches(GOLD_FORGE_POSITIVE_INTEGER) == true
    } == true
    // A saved original remains discoverable until its repository owner archives/finishes it.
    val tabs = goldForgeTabs(claimReady, gemsWaiting = if (buy?.saved != null) 1 else 0, legacy = false).map { tab ->
        // An attempted or credited original may need receipt checks or finishing, not another wallet approval.
        if (tab.id == GoldForgeTabs.GEMS && tab.badge != null)
            tab.copy(badge = tab.badge.copy(description = "A saved Gems purchase needs attention."))
        else tab
    }
    val tabIds = tabs.map { it.id }
    val selected = tabIds.firstOrNull { it.equals(selectedTab, ignoreCase = true) }
        ?: goldForgeDefaultTab(requestedTab, tabIds, claimReady) ?: GoldForgeTabs.SMELT
    return GoldForgeSheetUi(
        level = forge?.let { "LV ${it.level}" } ?: UNKNOWN,
        heroStatus = hero,
        sceneWorking = working,
        tabs = tabs,
        selectedTab = selected,
        stack = listOf(
            ResourceChipUi(HudIds.GEMS, "gem", compactAmount(gemsAmount), null, false, null,
                name = "Gems", accent = ResourceAccent.GEMS, exactDescription = "Gems ${exactAmount(gemsAmount)}"),
            ResourceChipUi(HudIds.KEEP, "keep", compactAmount(walletAmount), null, false, null,
                name = "Wallet KEEP", accent = ResourceAccent.KEEP, exactDescription = "Wallet KEEP ${exactAmount(walletAmount)}"),
        ),
        smelt = null,
        claim = null,
        gems = null,
        legacy = null,
        history = historyAvailable,
    )
}

private val GOLD_FORGE_AMOUNT = Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")
private val GOLD_FORGE_POSITIVE_INTEGER = Regex("[1-9][0-9]*")
