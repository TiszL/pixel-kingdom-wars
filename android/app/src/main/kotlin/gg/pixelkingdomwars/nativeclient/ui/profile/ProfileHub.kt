package gg.pixelkingdomwars.nativeclient.ui.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.home.LocalHomePassportOwner
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.more.AccountViewModel
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.*
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first

/** One designed surface, including the legacy AccountRoute entry. */
enum class ProfileTab { PROFILE, KINGDOMS, WALLET, ACCOUNT }

/** Match the source's deed/location pairing. The compatibility scalar cannot identify a selected deed. */
internal fun profileDeed(account: AccountState): Pair<String, BaseSummary?>? {
    val directory = account.directory
    if (directory?.enabled == true) {
        val active = directory.bases.filter { it.status == "active" && it.slot != null }
        val selected = active.firstOrNull { it.id == account.selectedBaseId } ?: active.singleOrNull()
        return selected?.deedAssetId?.let { it to selected }
    }
    return account.identity?.deedAssetId?.let { id -> id to directory?.bases?.firstOrNull { it.deedAssetId == id } }
}

/** The actual owner reference and generation prevent both same-wallet replacement and A -> B -> A revival. */
internal class ProfileHubScope(private val session: Any, private val baseId: String?, private val generation: Long) {
    fun isCurrent(session: Any?, baseId: String?, generation: Long): Boolean =
        this.session === session && this.baseId == baseId && this.generation == generation

    fun act(session: Any?, baseId: String?, generation: Long, allowed: Boolean, action: () -> Unit): Boolean {
        if (!allowed || !isCurrent(session, baseId, generation)) return false
        action()
        return true
    }
}

/** SAVE is a check then explicit confirmation; the existing repository still owns validation and the mutation. */
internal fun profileRenameReady(state: ProfileState, draft: String, rulesKnown: Boolean, busy: Boolean): Boolean =
    rulesKnown && !busy && !state.needsRefresh && state.profile?.cooldownDays == 0 &&
        state.availability?.let { it.input == draft && it.available } == true

/**
 * The purchase kind the land gate opens with from Profile (`LandGateRoute(kind = …)`). Landless and unknown owners buy the
 * entry; a landed owner buys what the deed directory names next ("deed" when the server names nothing, BasesScreen's
 * rule), so a player who already paid is never sent to buy an entry twice. Only the two kinds the land owner accepts
 * (`LandRepository`: "entry" / "deed") pass through; anything else is "deed".
 */
internal fun profileLandKind(account: AccountState): String =
    if (landOwnedLive(account) != true) "entry"
    else account.directory?.nextLandPurchaseKind?.takeIf { it == "entry" || it == "deed" } ?: "deed"

/**
 * The Home read Profile shows at once (owner 2026-10-06 "always loading"): this session's last base read when it is the
 * selected kingdom's, so the PROFILE tab and the header level open with last known data and the tab refresh only updates.
 */
internal fun profileLastNews(home: BaseState, selectedBaseId: String?): BaseState? =
    home.takeIf { it.base != null && (selectedBaseId == null || it.base.baseId == selectedBaseId) }

/**
 * The PROFILE tab's load state. A routine refresh over news already shown stays [LoadState.Ready] (no skeleton, no veil);
 * only an open with no news at all is [LoadState.Loading]; a failed read keeps the news under its error row.
 */
internal fun profileNewsLoad(news: BaseState?, valid: Boolean, readError: String?, asOf: String?): LoadState = when {
    readError != null -> LoadState.Error(readError, asOf = asOf)
    !valid || news == null -> LoadState.Loading
    else -> LoadState.Ready
}

/**
 * The PROFILE tab's Renown (owner 2026-10-11 "where is EXP and Renown?"): the server's published cumulative Renown from
 * the account's Realm Passport read (`GET /realm-passport/mining/current`, the number the Lodge PASSPORT tab shows).
 * Null hides the card: never read, an `unavailable` answer (SOURCE_UNAVAILABLE / SOURCE_CONFLICT / NOT_CONFIGURED) or a
 * refused read (503 REALM_PASSPORT_UNAVAILABLE, a network failure) is not a number, so no dash, zero or placeholder is
 * drawn. Only a read in flight keeps [previous], so a routine refresh does not make the card blink.
 */
internal fun profileRenown(current: PassportSection<PassportCurrent>?, previous: String?): String? {
    val served = current?.observation?.data?.published?.cumulativeRenown
    return when {
        served != null -> compactAmount(served)
        current != null && current.busy && current.observation == null && current.error == null -> previous
        else -> null
    }
}

/**
 * Only observed Home facts become news. Missing progression/expedition/auction facts do not become sample values. EXP
 * stays hidden: neither the Home read (`PlayerSummary`) nor any other native read carries player experience (2026-10-11).
 */
internal fun profileHubBody(home: BaseState?, load: LoadState, allowDailyCache: Boolean = true, renown: String? = null): ProfileTabV2Ui {
    fun link(id: String) = HubLink(FeatureId(id))
    val player = home?.base?.player
    val daily = home?.quests?.quests?.filter { it.scope == "daily" }
    val clanHallReady = home?.base?.buildings?.any { it.type == "clanhall" && it.level > 0 && !it.underConstruction } == true
    val cards = buildList {
        if (allowDailyCache && home?.mine?.cache?.claimable == true) add(NowCardUi("chest", "sunrays", "DAILY CACHE", "ready to claim · your kingdom", true, link("hud.dailyCache")))
        val base = home?.base
        if (base != null && base.raw.containsKey("freeBuilders") && base.freeBuilders > 0)
            add(NowCardUi("builder", "card", "BUILDERS READY", "${base.freeBuilders} idle · your kingdom", false, link("hud.builders")))
        if (daily?.any { it.completed && !it.claimed } == true)
            add(NowCardUi("quest", "card", "QUEST REWARD", "ready to claim · daily quests", true, link("hud.quests")))
    }
    val league = player?.league?.takeIf { it.isNotBlank() }
    val crest = when (league?.lowercase()) { "gold" -> "league-gold"; "silver" -> "league-silver"; "bronze" -> "league-bronze"; else -> "trophy" }
    return ProfileTabV2Ui(
        league = LeagueStatUi(crest, player?.trophies?.let { exactAmount(it) } ?: UNKNOWN, league?.let { "$it league" } ?: UNKNOWN, link("hud.leagues")),
        exp = null, renown = renown, rightNow = cards,
        week = daily?.let { listOf(WeekRowUi("quests", "quest", "Daily quests", it.count { quest -> quest.completed }, it.size,
            null, destination = link("hud.quests"))) }.orEmpty(),
        clanBadge = null, clanDoor = DoorUi("clan", "itm_banner", "CLAN", Verb.BLUE, if (clanHallReady) link("clan.open") else null,
            lockedReason = if (clanHallReady) null
                else "Build a Clan Hall to open your clan."),
        leagueDoor = DoorUi("league", "trophy", "LEAGUE", Verb.STONE, link("hud.leagues")),
        // The designed History card (WalletHistory) reads the journals once the kingdom is known; until then it says why.
        historyDoor = if (home?.base != null) DoorUi("history", "replay", "HISTORY", Verb.STONE, link("profile.history"))
            else DoorUi("history", "replay", "HISTORY", Verb.STONE, null, lockedReason = "Your kingdom is still loading. Try again in a moment."),
        // SPEC §0.4: INVITE is a PROFILE door (hub.png). It opens the existing referral owner (`profile.invite` ->
        // onReferrals); like HISTORY it waits for the kingdom read, so an unread Home does not advertise it.
        inviteDoor = if (home?.base != null) DoorUi("invite", "referral", "INVITE", Verb.STONE, link("profile.invite")) else null,
        load = load, quietLine = "Explore your kingdom.",
    )
}

/** Existing owner-backed sheets. Home supplies its panel/lease; standalone routes use the same card and callbacks. */
@Composable fun ProfileHub(graph: AppGraph, session: SessionGraph, profileModel: ProfileViewModel, accountModel: AccountViewModel,
    wallet: WalletLogin?, onBack: () -> Unit, onEditProfile: () -> Unit, onSecurity: () -> Unit, onSeeker: () -> Unit,
    onRaidLog: () -> Unit, onClans: () -> Unit, onReferrals: () -> Unit, onBases: () -> Unit, initialTab: ProfileTab = ProfileTab.PROFILE,
    modifier: Modifier = Modifier.fillMaxSize(), hosted: Boolean = false, selectedTab: String? = null,
    onTab: ((String) -> Unit)? = null, canRead: () -> Boolean = { true },
    onFeature: ((HubLink) -> Unit)? = null, onSettings: (() -> Unit)? = null, onDeedClaim: (() -> Unit)? = null,
    skrFaucet: FaucetUi = FaucetUi.Hidden, onSkrFaucet: (() -> Unit)? = null, onLand: ((String) -> Unit)? = null,
) {
    val account by graph.account.state.collectAsState()
    val scope = remember(session, account.selectedBaseId, account.baseSelectionGeneration) {
        ProfileHubScope(session.session, account.selectedBaseId, account.baseSelectionGeneration)
    }
    key(scope) {
        ProfileHubContent(graph, session, profileModel, accountModel, wallet, scope, account,
            onBack, onEditProfile, onSecurity, onSeeker, onRaidLog, onClans, onReferrals, onBases, initialTab,
            modifier, hosted, selectedTab, onTab, canRead, onFeature, onSettings, onDeedClaim, skrFaucet, onSkrFaucet, onLand)
    }
}

@Composable private fun ProfileHubContent(graph: AppGraph, session: SessionGraph, profileModel: ProfileViewModel,
    accountModel: AccountViewModel, wallet: WalletLogin?, owner: ProfileHubScope, account: AccountState,
    onBack: () -> Unit, onEditProfile: () -> Unit, onSecurity: () -> Unit, onSeeker: () -> Unit,
    onRaidLog: () -> Unit, onClans: () -> Unit, onReferrals: () -> Unit, onBases: () -> Unit, initialTab: ProfileTab,
    modifier: Modifier, hosted: Boolean, selectedTab: String?, onTab: ((String) -> Unit)?, canRead: () -> Boolean,
    onFeature: ((HubLink) -> Unit)?, onSettings: (() -> Unit)?, onDeedClaim: (() -> Unit)?,
    skrFaucet: FaucetUi, onSkrFaucet: (() -> Unit)?, onLand: ((String) -> Unit)?,
) {
    val content by graph.content.state.collectAsState()
    val currentHome by session.base.state.collectAsState()
    val profile by profileModel.state.collectAsState()
    val profileNotice by profileModel.notice.collectAsState()
    val accountNotice by accountModel.notice.collectAsState()
    val profileBusy by profileModel.busy.collectAsState()
    val accountBusy by accountModel.busy.collectAsState()
    var localTab by rememberSaveable { mutableStateOf(initialTab.name) }
    val tab = selectedTab ?: localTab
    var refresh by remember { mutableIntStateOf(0) }
    var reading by remember { mutableStateOf(true) }
    var readError by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    // Every read below starts from this session's last known answer (owner 2026-10-06 "always loading"): the card opens
    // with the kingdom's news, wallet readout, deed directory and security status already drawn, and each tab's refresh
    // only updates them. A failed refresh keeps them on screen under the notice row; nothing blanks.
    var news by remember { mutableStateOf(profileLastNews(session.base.state.value, account.selectedBaseId)) }
    var newsAsOf by remember { mutableStateOf<String?>(null) }
    var funds by remember { mutableStateOf(skrFaucetKeptFunds(null, session.economy.state.value)) }
    var directoryRead by remember { mutableStateOf(account.directory != null) }
    var securityRead by remember { mutableStateOf(account.security != null) }
    var nameDraft by remember(profile.profile?.name) { mutableStateOf(profile.profile?.name.orEmpty()) }
    var rename by remember { mutableStateOf<String?>(null) }
    var signOut by remember { mutableStateOf(false) }
    var disconnect by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val clipboard = LocalClipboardManager.current
    val liveCanRead = rememberUpdatedState(canRead)
    fun current(): Boolean {
        val now = graph.account.state.value
        return graph.sessionGraph.value === session && now.session === session.session && owner.isCurrent(graph.holder.current, now.selectedBaseId, now.baseSelectionGeneration)
    }
    fun act(action: () -> Unit) {
        val now = graph.account.state.value
        if (!owner.act(graph.holder.current, now.selectedBaseId, now.baseSelectionGeneration,
                graph.sessionGraph.value === session && now.session === session.session && !now.busy && liveCanRead.value(), action))
            feedback = "Your kingdom changed or is busy. Open Profile again when it is ready."
    }
    fun feature(id: String) = act {
        when (id) {
            "clan.open" -> {
                val base = session.base.state.value.base
                if (base != null && base.baseId == graph.account.state.value.selectedBaseId && base.buildings.any { it.type == "clanhall" && it.level > 0 && !it.underConstruction }) onClans()
                else feedback = "Build a Clan Hall to open your clan."
            }
            "profile.invite" -> onReferrals()
            else -> onFeature?.invoke(HubLink(FeatureId(id))) ?: run { feedback = "Open this destination from your kingdom." }
        }
    }
    LaunchedEffect(owner, tab, refresh, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            reading = true; readError = null
            try {
                check(current() && liveCanRead.value()) { "Your kingdom is not ready. Try again." }
                when (tab) {
                    PROFILE_TAB -> {
                        session.base.refreshWithoutJourneys()
                        check(current()) { "Your kingdom changed." }
                        session.base.refreshQuests()
                        check(current()) { "Your kingdom changed." }
                        session.base.refreshMine()
                        val observed = session.base.state.value
                        check(current() && observed.base != null && (account.selectedBaseId == null || observed.base.baseId == account.selectedBaseId)) { "Your kingdom changed." }
                        news = observed
                        newsAsOf = java.time.Instant.now().atOffset(java.time.ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"))
                    }
                    KINGDOMS_TAB -> { graph.account.refreshDirectory(); if (current()) directoryRead = true }
                    WALLET_TAB -> {
                        session.economy.refresh(EconomyPage.WALLET)
                        val observed = session.economy.state.value
                        observed.errors["/wallet/balances"]?.let { error(it) }
                        if (current()) funds = observed.wallet ?: funds
                    }
                    ACCOUNT_TAB -> {
                        if (profileModel.busy.value) profileModel.busy.first { !it }
                        check(current() && liveCanRead.value()) { "Your kingdom changed." }
                        profileModel.refresh()?.join()
                        profileModel.notice.value?.takeIf { it.error }?.let { error(it.message) }
                        check(current()) { "Your kingdom changed." }
                        graph.account.loadSecurity()
                        if (current()) securityRead = true
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (current()) readError = error.message ?: "Profile could not be refreshed." }
            finally { if (current()) reading = false }
            awaitCancellation()
        }
    }
    // Renown rides the account's Passport owner (the Lodge's), read here on its own: a refused Passport hides the card and
    // never turns into the PROFILE tab's error row.
    val passportOwner = LocalHomePassportOwner.current?.takeIf { it.session === session }
    val passportCurrent = passportOwner?.model?.state?.collectAsState()?.value?.current
    val heldRenown = remember(passportOwner) { HeldRenown() }
    val renown = profileRenown(passportCurrent.takeIf { passportOwner?.current() == true }, heldRenown.value).also { heldRenown.value = it }
    LaunchedEffect(owner, tab, refresh, lifecycle, passportOwner) {
        if (tab != PROFILE_TAB || passportOwner == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (current() && liveCanRead.value() && passportOwner.current()) {
                passportOwner.model.awaitIdle()
                if (current() && liveCanRead.value() && passportOwner.current()) passportOwner.model.refreshCurrent()?.join()
            }
            awaitCancellation()
        }
    }
    val dismissConfirm = { rename = null; signOut = false; disconnect = false }
    BackHandlerAt(BackPriority.CONFIRM, rename != null || signOut || disconnect) { dismissConfirm() }
    BackHandlerAt(BackPriority.SCREEN, !hosted && rename == null && !signOut && !disconnect) {
        if (tab != PROFILE_TAB) { localTab = PROFILE_TAB; onTab?.invoke(PROFILE_TAB) } else onBack()
    }
    val valid = current()
    val knownAccount = if (valid) account else AccountState()
    val headerAccount = if (news == null && knownAccount.directory?.enabled == true)
        knownAccount.copy(identity = knownAccount.identity?.copy(keepLevel = null)) else knownAccount
    val header = profileHeaderLiveUi(headerAccount, news.takeIf { valid }?.base?.player?.keepLevel, null, content.catalogue, snapshot = null)
    // A directory refresh in flight no longer turns every SWITCH into busy dots: only the account owner's own action does.
    val kingdoms = kingdomsLiveUi(if (directoryRead) knownAccount else knownAccount.copy(directory = null), content.catalogue).let { ui ->
        if (accountBusy) ui.copy(kingdoms = ui.kingdoms.map { it.copy(switching = true) }) else ui
    }
    val testSolAvailable = BuildConfig.SOLANA_CLUSTER == "devnet" && onFeature != null
    // HISTORY is a working door only where a host routes `profile.history` (Home: the designed WalletHistory card).
    val walletUi = walletLiveUi(knownAccount, funds.takeIf { valid }, BuildConfig.SOLANA_CLUSTER == "devnet", null,
        faucet = skrFaucet, testSolAvailable = testSolAvailable, historyAvailable = onFeature != null, catalogue = content.catalogue)
    val nameError = when {
        profile.needsRefresh -> "Refresh your profile before changing it again."
        (profile.profile?.cooldownDays ?: 0) > 0 -> "You can rename in ${profile.profile?.cooldownDays} days."
        profile.availability?.let { it.input == nameDraft.trim() } == true ->
            if (profile.availability?.available == true) "Name available. Tap SAVE to review it." else "That name is not available. Choose another."
        else -> profileNotice?.message
    }
    val accountUi = accountLiveUi(if (securityRead) knownAccount else knownAccount.copy(security = null), nameDraft.takeIf { valid }, profileBusy,
        nameError.takeIf { valid }, accountBusy, null).copy(nameEditingEnabled = valid && readError == null && profile.profile != null && !profile.needsRefresh &&
            profile.profile?.cooldownDays == 0 && profileModel.bounds != null)
    val nav = AccountLiveNav(
        selectBase = { id -> act { if (!accountModel.busy.value) accountModel.selectBase(id) } },
        seeOnMap = { feature("hud.map") }, openDeedClaim = { act { (onDeedClaim ?: onBases)() } },
        copyAddress = { act { graph.account.state.value.wallet?.let { address ->
            feedback = runCatching { clipboard.setText(AnnotatedString(address)); "Address copied." }
                .getOrElse { "Copy failed. Try again." }
        } } },
        openSeekerIsland = { feature("profile.seekerIsland") }, openGoldForge = { feature("goldforge.open") },
        openTestSol = if (testSolAvailable) ({ feature("profile.faucet") }) else null,
        openHistory = { feature("profile.history") },
        linkWallet = { act { feedback = "Connect your wallet from the title screen." } },
        nameDraft = { name -> act { if (!profileModel.busy.value) { nameDraft = name; rename = null } } },
        saveName = { name -> act {
            val state = profileModel.state.value
            if (profileRenameReady(state, name, profileModel.bounds != null, profileModel.busy.value)) rename = name
            else if (!profileModel.busy.value && state.profile?.cooldownDays == 0 && !state.needsRefresh && profileModel.bounds != null) {
                profileModel.checkName(name); feedback = "Check the name result, then tap SAVE to review it."
            } else feedback = "Refresh your profile and check the name before saving."
        } },
        confirmUnlink = { act { feedback = "Manage your sign-in methods in Account Security."; onSecurity() } },
        openSecurity = { act(onSecurity) }, confirmSignOut = { act { if (!accountModel.busy.value) signOut = true } },
        // Only an unbound TEST SOL still reports the mapper's internal hold; the player reads the card's own reason.
        explain = { feedback = if (it == MONEY_WIRING_PENDING) "Test SOL is unavailable in this card." else it },
        // Navigation only: the land gate and the SKR faucet sheet own their own consent, wording and money.
        openLand = onLand?.let { land -> { act { land(profileLandKind(graph.account.state.value)) } } },
        openSkrFaucet = onSkrFaucet?.let { open -> { act(open) } },
    )
    val status = listOfNotNull(readError, feedback, accountNotice?.message).distinct().joinToString("\n").takeIf { it.isNotBlank() }
    val ui = profileCardLiveUi(header, tab, kingdoms, walletUi, accountUi).copy(notice = status, refreshing = reading)
    val actions = profileCardLiveActions(nav, ui,
        onTab = { next -> act { if (next in ProfileTab.entries.map { it.name }) { localTab = next; onTab?.invoke(next); feedback = null } } },
        onSettings = { act { (onSettings ?: onEditProfile)() } }, onClose = onBack).copy(onRefresh = { act { refresh++ } })
    val load = profileNewsLoad(news, valid, readError, newsAsOf)
    Box(modifier.then(if (hosted) Modifier else Modifier.background(PkwTokens.Colors.charcoal)
        .windowInsetsPadding(WindowInsets.safeDrawing).imePadding().padding(8.dp))) {
        ProfileCard(ui, actions, Modifier.fillMaxSize(), profileTab = {
            ProfileTabV2(profileHubBody(news.takeIf { valid }, load, allowDailyCache = hosted, renown = renown.takeIf { valid }), ProfileTabV2Actions(
                onGo = { feature(it.feature.value) }, onOpen = { feature(it.feature.value) },
                onLocked = { reason, _ -> feedback = reason }, onRetry = { act { refresh++ } }, onReport = { feature("profile.feedback") }))
        }, accountExtras = {
            SectionHeader("ACCOUNT OPTIONS")
            ProfileUtility("PROFILE IMAGE", "Change your profile image") { act(onEditProfile) }
            ProfileUtility("SEEKER IDENTITY", "Link and identity details") { act(onSeeker) }
            ProfileUtility("YOUR BASES", "Deeds, activation and base selection") { act(onBases) }
            ProfileUtility("RAID LOG & REPLAYS", "Battle history") { act(onRaidLog) }
            // The PROFILE tab's INVITE door (SPEC §0.4) opens this same owner once the kingdom is read; this row keeps it
            // reachable while Home is unread or failed.
            ProfileUtility("REFERRALS", "Your referral code and saved requests") { act(onReferrals) }
            val moreDestinations = "All screens. MENU there: faucet, shields, energy, daily cache"
            CardRow(height = 96.dp, onClick = { feature("profile.more") }, description = "MORE DESTINATIONS. $moreDestinations") {
                Column(Modifier.weight(1f)) {
                    PkwText("MORE DESTINATIONS", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                    PkwText(moreDestinations, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
                }
            }
            ProfileUtility("REPLAY TUTORIAL", null) { act { if (!accountModel.busy.value) accountModel.tutorialAction("reset") } }
            currentHome.takeIf { valid && news != null && it.base?.baseId == account.selectedBaseId }?.tutorial?.let { tutorial ->
                ProfileUtility(if (tutorial.guideSkipped) "RESUME GUIDANCE" else "PAUSE GUIDANCE", "Show where to tap") {
                    act { if (!accountModel.busy.value) accountModel.tutorialAction(if (tutorial.guideSkipped) "guide/resume" else "guide/skip") }
                }
            }
            ProfileUtility("CHECK CONTENT UPDATES", content.updateNotice) {
                act { if (!accountModel.busy.value && !content.checking) accountModel.checkContentUpdates() }
            }
            ProfileUtility("ABOUT, LEGAL & SUPPORT", null) { feature("profile.about") }
            ProfileUtility("DISCONNECT WALLET", "Keep your saved sign-in and return to the title") {
                act { if (!accountModel.busy.value) disconnect = true }
            }
            ProfileUtility("REFRESH PROFILE", if (reading) "Refreshing…" else null) { act { if (!reading) refresh++ } }
        })
        val confirm = when {
            rename != null -> ConfirmUi("CHANGE PLAYER NAME?", null, null, "Use $rename?",
                "Another rename is available after ${profileModel.bounds?.renameCooldownDays ?: UNKNOWN} days.", "SAVE NAME", Verb.GREEN)
            disconnect -> ConfirmUi("DISCONNECT WALLET?", null, null, "Keep your saved sign-in.",
                "Return to the title screen. Saved requests stay available when you reconnect.", "DISCONNECT", Verb.STONE)
            signOut -> ConfirmUi("SIGN OUT?", null, null, "Your kingdom stays.",
                "Saved requests stay on this device for recovery. Sign in again with your wallet or Google.", "SIGN OUT", Verb.STONE)
            else -> null
        }
        HubConfirmDialog(confirm, onConfirm = { act {
            val confirmed = rename
            if (confirmed != null) {
                if (confirmed == nameDraft.trim() && profileRenameReady(profileModel.state.value, confirmed, profileModel.bounds != null, profileModel.busy.value)) {
                    rename = null; profileModel.rename(confirmed)
                } else { rename = null; feedback = "Check your current name again before saving." }
            } else if (disconnect && !accountModel.busy.value) { disconnect = false; accountModel.unlink(wallet) }
            else if (signOut && !accountModel.busy.value) { signOut = false; accountModel.logout(wallet) }
        } }, onBack = dismissConfirm, modifier = Modifier.fillMaxSize())
    }
}

/** Secondary existing owners remain reachable below the designed ACCOUNT form. */
@Composable private fun ProfileUtility(label: String, detail: String?, action: () -> Unit) {
    CardRow(height = 72.dp, onClick = action, description = label) { RowText(label, detail) }
}

/** The last Renown shown; a plain holder, so remembering it never schedules another composition. */
private class HeldRenown { var value: String? = null }
