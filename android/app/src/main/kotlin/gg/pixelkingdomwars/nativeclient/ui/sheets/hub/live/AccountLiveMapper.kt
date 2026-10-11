package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import androidx.compose.ui.graphics.ImageBitmap
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.KingdomCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.KingdomStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.KingdomsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.KingdomsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.PROFILE_TAB
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProfileCardActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProfileCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProfileHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProviderKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProviderRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.WalletActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.WalletTokenRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.WalletUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.canUnlink
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.profileCardTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.shortAddress
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Live mapper of the Profile card (`ProfileCardUi` / `ProfileCardActions`, K/ui/sheets/account/ProfileCard.kt) and its
 * KINGDOMS (`KingdomsUi`), WALLET (`WalletUi`) and ACCOUNT (`AccountUi`) tabs: land-deed state, land ownership, the
 * wallet / identity summary. No purchase here: CLAIM YOUR LAND / ADD A KINGDOM navigate to the existing land gate owner
 * (`LandGateRoute`, money in `LandViewModel`), the DAILY TEST SKR row to the SKR faucet sheet and TEST SOL to the existing
 * SOL faucet, each only when the caller binds it; an unbound door explains itself in a player sentence.
 *
 * State sources (read by the caller, handed in as data):
 * - `AccountRepository.state` (`AccountState`: `identity` = `GET /me`, `directory` = `GET /bases`, `selectedBaseId`,
 *   `security` = `GET /2fa/status`); observed today by `K/ui/profile/ProfileHub.kt` and `K/ui/more/BasesScreen.kt`.
 * - `EconomyRepository.state.wallet` (`WalletFunds` = `GET /wallet/balances`), read by ProfileHub's WALLET tab.
 * - the Home `BaseRepository.state.base.player.keepLevel` for the header level, the content catalogue for the art tier.
 *
 * Land ownership is `Identity.entryPaid` (the server's `/me.entryPaid`, i.e. `entryPaidAt != null`; the money-moved-is-
 * money-honoured rule): `false` = landless teaser; absent with an unread directory = unknown → a "…" kingdom card, never
 * the teaser (a paying player must never be told to buy land again).
 */

/** Land ownership as the sheet needs it: true / false when the server said, null while unknown. `entryPaid` absent on
 *  an old server falls back to the deed directory (any paid / deeded base = owned, an empty read directory = landless). */
internal fun landOwnedLive(account: AccountState): Boolean? {
    val identity = account.identity ?: return null
    identity.entryPaid?.let { return it }
    val bases = account.directory?.bases ?: return null
    return bases.any { it.landPaidAt != null || it.deedAssetId != null }
}

/** The base being played: the selected one, else the only active one (`profileDeed` rule in ProfileHub.kt). */
internal fun playingBase(account: AccountState): BaseSummary? {
    val active = account.directory?.bases.orEmpty().filter { it.selectable }
    return active.firstOrNull { it.id == account.selectedBaseId } ?: active.singleOrNull()
}

/** "SLOT 2": the server names no kingdom per base, so a card is named by its active slot (BasesScreen's words). */
internal fun kingdomCardName(base: BaseSummary): String = base.slot?.let { "SLOT $it" } ?: "DEED"

/** A base's realm line: the fantasy realm's full name, "Earth" for a legacy earth cell, "…" while unplaced. */
internal fun kingdomRealmName(base: BaseSummary?): String = when {
    base?.fantasyRealmId != null -> liveRealmName(base.fantasyRealmId)
    base?.earthCellId != null -> "Earth"
    else -> UNKNOWN
}

/** The tile fact: "4,812" for a numeric tile id, the raw id otherwise, "…" while unplaced. */
internal fun kingdomTile(base: BaseSummary?): String {
    val tile = base?.fantasyTileId ?: base?.earthCellId ?: return UNKNOWN
    return if (tile.isNotEmpty() && tile.all(Char::isDigit)) exactAmount(tile) else tile
}

/** A placeholder card while ownership or the directory is unread: every value "…", no SWITCH, no DEED tag. */
internal fun unknownKingdomCard(): KingdomCardUi =
    KingdomCardUi("unknown", UNKNOWN, UNKNOWN, null, UNKNOWN, 1, KingdomStatus.PLAYING, hasDeed = false)

/**
 * KINGDOMS. Active bases only (an inactive deed needs ACTIVATE, which this sheet has no control for: it stays on the
 * legacy BasesScreen). RECOVER / DEED_ELSEWHERE is never produced: the deed directory lists this wallet's deeds only.
 * [switchingId] is the base whose SWITCH is loading.
 */
internal fun kingdomsLiveUi(account: AccountState, catalogue: JsonObject?, switchingId: String? = null): KingdomsUi {
    val owned = landOwnedLive(account)
    if (owned == false) return KingdomsUi(emptyList(), landless = true, addPrice = null, activeName = null, tile = null, tileThumb = null,
        shield = null, landPrice = solPriceChecking())
    val directory = account.directory
    if (owned == null || directory == null) return KingdomsUi(listOf(unknownKingdomCard()), landless = false, addPrice = null,
        activeName = null, tile = null, tileThumb = null, shield = null)
    if (!directory.enabled) {
        // A server without the deed directory (one base per wallet): the identity is the only deed record.
        val identity = account.identity
        val legacy = KingdomCardUi("legacy", "YOUR KINGDOM", UNKNOWN, null, identity?.keepLevel?.toString() ?: UNKNOWN,
            keepTierOf(identity?.keepLevel, catalogue), KingdomStatus.PLAYING, hasDeed = identity?.deedAssetId != null)
        return KingdomsUi(listOf(legacy), landless = false, addPrice = null, activeName = legacy.name, tile = UNKNOWN, tileThumb = null,
            shield = UNKNOWN)
    }
    val playing = playingBase(account)
    val cards = directory.activeBases.sortedBy { it.slot ?: Int.MAX_VALUE }.map { base ->
        KingdomCardUi(
            id = base.id,
            name = kingdomCardName(base),
            realmName = kingdomRealmName(base),
            realmThumb = null,
            keepLevel = base.keepLevel?.toString() ?: UNKNOWN,
            keepTier = keepTierOf(base.keepLevel, catalogue),
            status = if (base.id == playing?.id) KingdomStatus.PLAYING else KingdomStatus.AVAILABLE,
            hasDeed = base.deedAssetId != null,
            needsYou = null,
            switching = base.id == switchingId,
        )
    }.ifEmpty { listOf(unknownKingdomCard()) }
    // ADD A KINGDOM only where the server serves land reservations (BasesScreen's BUY ANOTHER DEED gate); its price is
    // only known after a reservation, so it is "…" (CHECKING), never "free" (that needs a server zero).
    val addPrice = if (directory.capabilities?.cellReservations == true) solPriceChecking() else null
    return KingdomsUi(
        kingdoms = cards,
        landless = false,
        addPrice = addPrice,
        activeName = playing?.let(::kingdomCardName),
        tile = playing?.let(::kingdomTile),
        tileThumb = null,
        shield = playing?.let { UNKNOWN },
    )
}

/** One wallet amount for a ValueTile: compact decimal ("312.5", "1.2M"), "…" when the read did not carry it. */
internal fun walletAmount(value: String?): String = compactAmount(value)

/** The catalogue's `constants.WALLET_HUB.tokens` symbols, in catalogue order; null when the catalogue is unread or the
 *  table is missing or malformed (then no row can be told apart from a catalogue row). */
internal fun walletHubSymbols(catalogue: JsonObject?): List<String>? {
    val tokens = ((catalogue?.get("constants") as? JsonObject)?.get("WALLET_HUB") as? JsonObject)?.get("tokens") as? JsonArray ?: return null
    return tokens.map { row -> ((row as? JsonObject)?.get("symbol") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null }
}

/** The server's extra-row symbol rule (api `assertExtraGameTokens`); a row outside it is skipped, never drawn. */
private val EXTRA_TOKEN_SYMBOL = Regex("[A-Za-z0-9]{1,12}")

/**
 * The rows the server's wallet read sent beyond the catalogue's tokens (the QA chain lane's test SKR; production sends
 * none), in server order, amounts formatted exactly as the tiles format theirs. No symbol or mint is known here: a row is
 * extra only because the catalogue does not list it. With the catalogue unread nothing is extra, so a catalogue row the
 * tab does not draw (USDC, USDT) can never surface as one.
 */
internal fun walletExtraTokens(funds: WalletFunds?, catalogue: JsonObject?): List<WalletTokenRowUi> {
    val listed = walletHubSymbols(catalogue)?.toSet() ?: return emptyList()
    return funds?.tokens.orEmpty().filterKeys { it !in listed && EXTRA_TOKEN_SYMBOL.matches(it) }
        .map { (symbol, amount) -> WalletTokenRowUi(symbol, walletAmount(amount)) }
}

/** What an unbound land door says (no "MS-M3" jargon reaches players): the World tab's land plate is the other door. */
internal const val PROFILE_LAND_UNBOUND: String = "Buy land from Your land on the map."
/** What the DAILY TEST SKR row says when no SKR faucet sheet is bound. */
internal const val PROFILE_SKR_FAUCET_CLOSED: String = "Daily test SKR is not open yet."

/**
 * WALLET. Amounts are the server's `/wallet/balances` read (`WalletFunds`; tokens keyed by symbol, "SKR" / "KEEP"); a
 * missing read or a null token is "…". Gems are not here (game currency, not the wallet). [faucet] is the caller's
 * SKR faucet state (the faucet lane's mapper); [FaucetUi.Hidden] draws no row, and mainnet never draws one, never an
 * invented state. TEST SOL is available only when the caller binds its existing navigation owner. [historyAvailable] is
 * true only when the caller routes `profile.history` to the designed WalletHistory card; otherwise the door is drawn in
 * its designed UNAVAILABLE state rather than promising a page that would not open. [catalogue] tells the catalogue's
 * token rows from the extra rows a host adds ([walletExtraTokens]).
 */
internal fun walletLiveUi(account: AccountState, funds: WalletFunds?, devnet: Boolean, walletApp: String?,
    faucet: FaucetUi = FaucetUi.Hidden, historyNeedsYou: Int? = null, historyDone: Int? = null,
    testSolAvailable: Boolean = false, historyAvailable: Boolean = false, catalogue: JsonObject? = null): WalletUi = WalletUi(
    linked = account.wallet != null,
    walletName = walletApp?.takeIf { it.isNotBlank() }?.uppercase() ?: "WALLET",
    shortAddress = shortAddress(account.wallet),
    deviceNote = null,
    devnet = devnet,
    skr = walletAmount(funds?.tokens?.get("SKR")),
    keep = walletAmount(funds?.tokens?.get("KEEP")),
    sol = walletAmount(funds?.sol),
    faucet = if (devnet) faucet else FaucetUi.Hidden,
    historyNeedsYou = historyNeedsYou,
    historyDone = historyDone,
    testSolBusy = false,
    // SEEKER ISLAND opens the globe on the island's panel (`WorldEntry.SeekerIsland`, owner 2026-10-06); the door is live.
    seekerUnavailable = null,
    historyUnavailable = if (historyAvailable) null else "Open a building to view its saved requests and receipts.",
    testSolUnavailable = if (devnet && testSolAvailable) null else "Test SOL is unavailable in this card.",
    extraTokens = walletExtraTokens(funds, catalogue),
)

/**
 * ACCOUNT. The NAME field is the caller's hoisted draft (defaults to the saved name). SIGN IN WITH lists the methods the
 * native state can prove: the wallet always; a social method only when the caller passes [socialKind] (the Privy
 * binding of this wallet). The 2-step toggle is "…" until `/2fa/status` was read.
 */
internal fun accountLiveUi(account: AccountState, draft: String?, saving: Boolean, nameError: String?, signingOut: Boolean,
    walletApp: String?, socialKind: ProviderKind? = null, socialLabel: String? = null): AccountUi {
    val saved = account.identity?.name?.takeIf { it.isNotBlank() }.orEmpty()
    val wallet = account.wallet
    val walletRow = ProviderRowUi(ProviderKind.WALLET,
        label = if (wallet == null) "not linked" else listOfNotNull(walletApp?.takeIf { it.isNotBlank() }, shortAddress(wallet)).joinToString(" · "),
        linked = wallet != null)
    val social = socialKind?.takeIf { it != ProviderKind.WALLET }?.let { ProviderRowUi(it, socialLabel ?: UNKNOWN, linked = true) }
    return AccountUi(
        nameDraft = draft ?: saved,
        savedName = saved,
        nameError = nameError,
        nameSaving = saving,
        providers = listOfNotNull(walletRow, social),
        totpEnabled = account.security?.totpEnabled,
        backupCodesLeft = null,
        signingOut = signingOut,
    )
}

/** The Profile header: kingdom label = the account display name (`Identity.displayName`, "Your kingdom" when unnamed),
 *  player = the saved name or "…", level from the Home base read, else `/me.keepLevel`. */
internal fun profileHeaderLiveUi(account: AccountState, homeKeepLevel: Int?, seekerMemberNumber: String?, catalogue: JsonObject?,
    snapshot: ImageBitmap?): ProfileHeaderUi {
    val identity = account.identity
    val level = homeKeepLevel ?: identity?.keepLevel
    val seeker = identity?.seeker?.takeIf { it.verified }?.let { "SEEKER" + (seekerMemberNumber?.let { n -> " #$n" } ?: "") }
    return ProfileHeaderUi(
        kingdomName = identity?.displayName?.uppercase() ?: UNKNOWN,
        playerName = identity?.name?.takeIf { it.isNotBlank() } ?: UNKNOWN,
        keepLevel = level?.toString() ?: UNKNOWN,
        keepTier = keepTierOf(level, catalogue),
        seekerMember = seeker,
        snapshot = snapshot,
    )
}

/** The whole Profile card for [tab] (PROFILE · KINGDOMS · WALLET · ACCOUNT); the PROFILE body is the hub's and comes in
 *  through `ProfileCard(profileTab = …)`, not from here. */
internal fun profileCardLiveUi(header: ProfileHeaderUi, tab: String?, kingdoms: KingdomsUi, wallet: WalletUi, account: AccountUi): ProfileCardUi =
    ProfileCardUi(header, tab ?: PROFILE_TAB, kingdoms, wallet, account, profileCardTabs(header.keepTier))

// ------------------------------------------------------------------------------------------------------------- actions

/** The existing handlers the Profile card's live actions route to (ProfileHub / BasesScreen / AccountViewModel today).
 *  Every lambda is navigation or an existing non-money call; none of them charges. */
internal data class AccountLiveNav(
    /** `AccountRepository.selectBase(id)` + Home base re-read (BasesViewModel.open). */
    val selectBase: (String) -> Unit,
    /** The realm map centred on the playing kingdom. */
    val seeOnMap: () -> Unit,
    /** The existing `BaseClaimRoute` screen (claim a transferred deed; its own flow and consent). */
    val openDeedClaim: () -> Unit,
    /** Copy the full wallet address, toast "Copied". */
    val copyAddress: () -> Unit,
    val openSeekerIsland: () -> Unit,
    val openGoldForge: () -> Unit,
    /** Push `WalletHistory`. */
    val openHistory: () -> Unit,
    /** Wallet connect from the title flow (no payment). */
    val linkWallet: () -> Unit,
    /** Keep the hoisted NAME draft. */
    val nameDraft: (String) -> Unit,
    /** The existing profile name save (ProfileViewModel). */
    val saveName: (String) -> Unit,
    /** Raise the hub ConfirmDialog for unlinking [ProviderKind]. */
    val confirmUnlink: (ProviderKind) -> Unit,
    /** `SecurityRoute` (2-step code, backup codes). */
    val openSecurity: () -> Unit,
    /** Raise the stone/stone sign-out ConfirmDialog. */
    val confirmSignOut: () -> Unit,
    /** The kit reason toast. */
    val explain: (String) -> Unit,
    /** Navigation only: the existing FaucetRoute owns its own consent and claim. */
    val openTestSol: (() -> Unit)? = null,
    /** Navigation only: the existing designed land gate (`LandGateRoute`: gate, realm picker, Seal, done; the money stays
     *  in `LandViewModel`). The caller picks the purchase kind (`profileLandKind`). */
    val openLand: (() -> Unit)? = null,
    /** Navigation only: the SKR faucet sheet (its own state, wording and claim owner). */
    val openSkrFaucet: (() -> Unit)? = null,
)

/** KINGDOMS callbacks: CLAIM YOUR LAND and ADD A KINGDOM open the existing land gate owner when bound, else they explain
 *  where land is bought ([PROFILE_LAND_UNBOUND]); nothing here charges. SWITCH only for an AVAILABLE card that is not
 *  already loading. */
internal fun kingdomsLiveActions(nav: AccountLiveNav, ui: KingdomsUi): KingdomsActions = KingdomsActions(
    onSwitch = { id ->
        val card = ui.kingdoms.firstOrNull { it.id == id }
        if (card != null && card.status == KingdomStatus.AVAILABLE && !card.switching) nav.selectBase(id)
    },
    onAddKingdom = { nav.openLand?.invoke() ?: nav.explain(PROFILE_LAND_UNBOUND) },
    onSeeOnMap = nav.seeOnMap,
    onClaimDeed = nav.openDeedClaim,
    onRecover = { nav.explain("Deed recovery is not available here yet.") },
    onClaimLand = { nav.openLand?.invoke() ?: nav.explain(PROFILE_LAND_UNBOUND) },
)

/** TEST SOL may navigate to the existing SOL faucet owner and the DAILY TEST SKR row to the SKR faucet sheet; an unbound
 *  door explains itself and never charges. */
internal fun walletLiveActions(nav: AccountLiveNav): WalletActions = WalletActions(
    onCopyAddress = nav.copyAddress,
    onSeekerIsland = nav.openSeekerIsland,
    onGoldForge = nav.openGoldForge,
    onTestSol = { nav.openTestSol?.invoke() ?: nav.explain(MONEY_WIRING_PENDING) },
    onClaimFaucet = { nav.openSkrFaucet?.invoke() ?: nav.explain(PROFILE_SKR_FAUCET_CLOSED) },
    onHistory = nav.openHistory,
    onLinkWallet = nav.linkWallet,
)

/** ACCOUNT callbacks. Unlink is refused for the last linked method (`canUnlink`, SPEC §4.3: never lock a player out),
 *  here as well as in the sheet; linking Google / X / email has no native flow on this screen. */
internal fun accountLiveActions(nav: AccountLiveNav, ui: AccountUi): AccountActions {
    val linked = ui.providers.associate { it.kind to it.linked }
    return AccountActions(
        onNameDraft = nav.nameDraft,
        onSaveName = nav.saveName,
        onLink = { kind -> if (kind == ProviderKind.WALLET) nav.linkWallet() else nav.explain("Linking another sign-in is not available here yet.") },
        onUnlink = { kind -> if (canUnlink(linked, kind)) nav.confirmUnlink(kind) else nav.explain("Keep one way to sign in. Link another first.") },
        onToggleTotp = { nav.openSecurity() },
        onViewBackupCodes = nav.openSecurity,
        onSignOut = nav.confirmSignOut,
    )
}

/** The Profile card's callbacks: the frame's own plus each tab's live actions. */
internal fun profileCardLiveActions(nav: AccountLiveNav, ui: ProfileCardUi, onTab: (String) -> Unit, onSettings: () -> Unit,
    onClose: () -> Unit): ProfileCardActions = ProfileCardActions(
    onTab = onTab,
    onSettings = onSettings,
    onClose = onClose,
    kingdoms = kingdomsLiveActions(nav, ui.kingdoms),
    wallet = walletLiveActions(nav),
    account = accountLiveActions(nav, ui.account),
)
