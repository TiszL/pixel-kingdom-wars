package gg.pixelkingdomwars.nativeclient

import android.app.Application
import android.util.Log
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.notifications.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountScope
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import gg.pixelkingdomwars.nativeclient.update.bindUpdateChannel
import gg.pixelkingdomwars.nativeclient.wallet.ChainAddresses
import gg.pixelkingdomwars.nativeclient.wallet.PrivyPublicConfig
import gg.pixelkingdomwars.nativeclient.wallet.LocalCredentialRelease
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleFailureTrust
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.MiningTaxClaimsSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.MiningTaxClaimsSigningPolicy
import gg.pixelkingdomwars.nativeclient.wallet.PrivySocialLogin
import gg.pixelkingdomwars.nativeclient.wallet.PrivyWalletAdapter
import gg.pixelkingdomwars.nativeclient.wallet.SocialBinding
import gg.pixelkingdomwars.nativeclient.wallet.SocialLogin
import gg.pixelkingdomwars.nativeclient.wallet.SocialLoginMarker
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import gg.pixelkingdomwars.nativeclient.wallet.WalletSigner
import gg.pixelkingdomwars.nativeclient.wallet.RecentAuthPurpose
import gg.pixelkingdomwars.nativeclient.wallet.WalletRecentAuth
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** Everything that lives exactly as long as one signed-in identity. Built when the account
 * repository installs a session; discarded (its scope already cancelled) when identity changes. */
class SessionGraph(
    val session: AccountSession,
    val scope: AccountScope,
    val api: ApiClient,
    val intents: PendingIntentStore,
    val observer: ReceiptObserver,
    val base: BaseRepository,
    val army: ArmyRepository,
    val battle: BattleRepository,
    val world: WorldRepository,
    val land: LandRepository,
    val economy: EconomyRepository,
    val gems: GemsRepository,
    val gemsBuy: GemsBuyRepository,
    val gemsBuyPayment: gg.pixelkingdomwars.nativeclient.wallet.GemsBuyPayment,
    val gemsBuyBalances: GemsBuyBalances,
    val forgeClaims: ForgeClaimsRepository,
    val withdrawalUnwind: WithdrawalUnwindRepository,
    val faucet: FaucetRepository,
    val referrals: ReferralRepository,
    val community: CommunityRepository,
    val chat: LiveChatRepository,
    val clans: LiveClansRepository,
    val feedback: LiveFeedbackRepository,
    val deposits: KeepDepositRepository,
    val tester: LiveTesterRepository,
    val market: MarketRepository,
    val marketTrades: MarketTransactionsRepository,
    val seeker: SeekerRepository,
    val playtest: LivePlaytestRepository,
    /** Selected-deed defender interlock (D-036): Home collects it while STARTED. */
    val interlock: LiveDeedInterlock,
    val heroRecruitment: HeroRecruitmentRepository,
    val wallBatch: WallBatchRepository,
    val basePurchases: BasePurchaseRepository,
    val baseClaims: BaseClaimRepository,
    val candidateExpansions: CandidateExpansionRepository? = null,
    private val workshopFactory: () -> WorkshopRepository,
    private val ordinaryCraftingFactory: () -> OrdinaryCraftingRepository,
    private val boundCosmeticWorkshopFactory: () -> BoundCosmeticWorkshopRepository,
    val boundCosmeticArt: BoundCosmeticArtAdmission,
    val boundCosmeticArtGeneration: StateFlow<Long>,
    private val miningContributionFactory: () -> MiningContributionRepository,
    private val starterFleetFactory: () -> StarterFleetRepository,
    private val starterExpeditionFactory: () -> StarterExpeditionRepository,
    private val harvesterFactory: () -> HarvesterRepository,
    private val freeBasePurchaseFactory: () -> FreeBasePurchaseRepository,
    private val seekerResourceClaimsFactory: () -> SeekerResourceClaimsRepository,
    private val boundCosmeticWakeWorkshopFactory: () -> BoundCosmeticWakeWorkshopRepository = { error("Wake recovery is unavailable") },
    val boundCosmeticWakeSourcePreview: BoundCosmeticWakeSourcePreview? = null,
    val fleetJourneys: FleetJourneyPublication? = null,
    val fleetJourneyDepartures: FleetJourneyDepartures? = null,
) {
    /** A corrupt isolated journal must remain visible without preventing other game screens. */
    val workshop: WorkshopRepository by lazy(workshopFactory)
    val ordinaryCrafting: OrdinaryCraftingRepository by lazy(ordinaryCraftingFactory)
    val boundCosmeticWorkshop: BoundCosmeticWorkshopRepository by lazy(boundCosmeticWorkshopFactory)
    val boundCosmeticWakeWorkshop: BoundCosmeticWakeWorkshopRepository by lazy(boundCosmeticWakeWorkshopFactory)
    val miningContribution: MiningContributionRepository by lazy(miningContributionFactory)
    val starterFleet: StarterFleetRepository by lazy(starterFleetFactory)
    val starterExpedition: StarterExpeditionRepository by lazy(starterExpeditionFactory)
    val harvester: HarvesterRepository by lazy(harvesterFactory)
    val freeBasePurchase: FreeBasePurchaseRepository by lazy(freeBasePurchaseFactory)
    val seekerResourceClaims: SeekerResourceClaimsRepository by lazy(seekerResourceClaimsFactory)
}

class SecurityGraph(val access: SecurityAccess, val repository: SecurityRepository, val confirmations: SecurityWalletConfirmation, val walletAuthenticator: WalletAuthenticatorRepository)

class RealmSalesClient(val repository: RealmSalesRepository, val wallet: RealmSalesWallet, val newActionsConfigured: Boolean, val policy: () -> RealmSalesSavedPolicy?)
class MiningClaimsClient(val repository: MiningClaimsRepository, val wallet: MiningClaimsWallet, val newActionsConfigured: Boolean)
class MiningTaxClaimsClient(val repository: MiningTaxClaimsRepository, val wallet: MiningTaxClaimsWallet,
    val policy: () -> MiningTaxClaimsAppPolicy?)

/** AppGraph owns this delegate once, not once per SessionGraph. All wallets share its
 * transaction monitor, including late evidence from a retired authenticated session.
 * The opener retains the existing origin namespace and legacy migration format. */
internal fun unifiedPendingIntents(open: (String) -> SecretStore): Lazy<PendingIntentStore> = lazy {
    PendingIntentStore(open("pending-intents"), LegacyPendingStores(
        training = open("pending-training"), construction = open("pending-construction"),
        cancellation = open("training-cancellation"), research = open("pending-research")))
}

/** Hand-written dependency wiring created once in [PkwApplication]. No DI framework. */
class AppGraph(val application: Application, val mode: LaunchMode) {
    val origin: String = BuildConfig.API_ORIGIN
    val walletIdentityOrigin: String = gg.pixelkingdomwars.nativeclient.wallet.WalletIdentity.origin(BuildConfig.WALLET_IDENTITY_ORIGIN)
    val debug: Boolean = BuildConfig.DEBUG
    val versionCode: Int = BuildConfig.VERSION_CODE
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val routing = ApiRouting()
    val back = BackRegistry()
    val homeRequests = HomeRequests()
    /** "ASK BEFORE SPENDING KEEP" (web lib/keepConfirm.ts): defaults on, reversible, fails safe when unreadable. */
    val keepConfirm: gg.pixelkingdomwars.nativeclient.ui.KeepConfirmPreference by lazy { gg.pixelkingdomwars.nativeclient.ui.DeviceKeepConfirmPreference(preferences) }
    /** The economy cluster of this build (web `lib/cluster.ts`); every wallet request names it explicitly. */
    val cluster: SolanaCluster = SolanaCluster.parse(BuildConfig.SOLANA_CLUSTER)
    /** This build's devnet chain pins ([ChainPins]): -Ppkw* in a test-origin debug build, the tracked
     *  app/chain-pins.release.properties otherwise; null offline, unpinned, or while the tracked set is blank or partial.
     *  The faucet mount passes `chainPins?.chainProfile` (lit only by its own pkwSkrFaucet switch) to [skrFaucetClient]. */
    internal val chainPins: ChainPinSet? get() = if (mode.offline) null else ChainPins.current
    val holder = AccountSessionHolder(appScope.coroutineContext[kotlinx.coroutines.Job])
    /** Session-bound observers may differ; durable journal transaction ownership must not. */
    private val pendingIntents by unifiedPendingIntents(::store)
    /** One process-shared lock/store across reauthentication, isolated from legacy money journals. */
    private val gemsIntents by lazy { PendingIntentStore(store("gems-intents-${cluster.id}")) }
    private val gemsBuyStores by lazy { GemsBuyStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "gems-buy-$chain-$wallet"))
    } }
    /** Mining evidence and unfinished RPC fences survive replacement of a session or screen. */
    private val miningClaimsStores by lazy { MiningClaimsStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "mining-claims-$chain-$wallet"))
    } }
    private val miningClaimsRpcGate by lazy { MiningClaimsRpcGate() }
    private val realmSalesRpcGate by lazy { RealmSalesRpcGate() }
    /** Shared across reauthentication; Workshop UI/repository wiring follows its adapter review. */
    val workshopStores by lazy { WorkshopStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "workshop-$chain-$wallet"))
    } }
    /** Original ordinary receipts retain one process-wide identity lock across reauthentication. */
    val ordinaryCraftingStores by lazy { OrdinaryCraftingStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "ordinary-crafting-$chain-$wallet"))
    } }
    val boundCosmeticWorkshopStores by lazy { BoundCosmeticWorkshopStores.withWakeStores { apiOrigin, purpose ->
        EncryptedStore(application, storageNamespace(apiOrigin, purpose))
    } }
    val miningContributionStores by lazy { MiningContributionStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "mining-contribution-$chain-$wallet"))
    } }
    /** Independent original starter journals survive session replacement without blocking each other. */
    val starterFleetStores by lazy { StarterFleetStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "starter-fleet-$chain-$wallet"))
    } }
    val starterExpeditionStores by lazy { StarterExpeditionStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "starter-expedition-$chain-$wallet"))
    } }
    // Phase E: process-wide recovery lock across sessions, scoped to origin/cluster/wallet.
    val freeBasePurchaseStores by lazy { FreeBasePurchaseStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "free-base-purchase-$chain-$wallet"))
    } }
    val seekerResourceClaimStores by lazy { SeekerResourceClaimStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "seeker-resource-claims-$chain-$wallet"))
    } }
    private var seekerShardsStores: SeekerShardsClaimStores? = null
    @Synchronized fun seekerShardsClaimStore(session: SessionGraph, policy: gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimsPolicy): gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimStore {
        holder.requireCurrent(session.session); gameApi.requireCurrentSession(session.session.token)
        val stores = seekerShardsStores ?: SeekerShardsClaimStores(policy) { apiOrigin, chain, wallet ->
            EncryptedStore(application, storageNamespace(apiOrigin, "seeker-shards-claims-$chain-$wallet"))
        }.also { seekerShardsStores = it }
        return stores.forIdentity(origin, cluster.id, session.session.wallet)
    }
    fun seekerShardsClaimsStored(session: SessionGraph): Boolean {
        holder.requireCurrent(session.session); gameApi.requireCurrentSession(session.session.token)
        return EncryptedStore(application, storageNamespace(origin, "seeker-shards-claims-${cluster.id}-${session.session.wallet}")).hasStoredData()
    }
    val harvesterStores by lazy { HarvesterStores { apiOrigin, chain, wallet ->
        EncryptedStore(application, storageNamespace(apiOrigin, "harvester-$chain-$wallet"))
    } }
    val serviceContent: ServiceContent by lazy { ServiceContent(File(application.noBackupFilesDir, storageNamespace(origin, "service-content")), origin) }
    /** Shares the existing service owner and permission observation (matched MS-A/MS-C retirement). */
    internal val constructionContentAdmissions: ConstructionContentAdmissions = ConstructionContentAdmissions()
    /** D-NEXT world kill switch: every capabilities read (this content check and the update channel's) records `worldV2`
     *  for the next World visit ([gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineAdmission]). */
    private val worldV2 by lazy { gg.pixelkingdomwars.nativeclient.scene.world.WorldV2Switch.of(application) }
    /** The content check is session-bound (both `checkUpdates` callers pass the SessionGraph's [SessionApiClient]), so its
     *  answer goes in as session-bound, the `onCapabilities` default, and may clear an offer. */
    val content: LiveContentRepository = LiveContentRepository(application, mode, origin, debug, versionCode) { worldV2.onCapabilities(it); updates.onCapabilities(it) }
    /** False while a battle or replay scene is on screen; the update download never runs then (M45 §5). */
    private val updateActivation = MutableStateFlow(true)
    /** MainActivity.onStart: the update channel asks again when the app returns to the screen (rate-limited there). */
    private val foreground = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST)
    fun onForeground() { foreground.tryEmit(Unit) }
    /** M45 §5 in-app update channel: offers arrive with the capabilities check; installs always need the player's confirmation. */
    val updates: gg.pixelkingdomwars.nativeclient.update.UpdateRepository = gg.pixelkingdomwars.nativeclient.update.UpdateRepository(appScope, origin,
        { gg.pixelkingdomwars.nativeclient.update.runningIdentity(application, versionCode.toLong()) },
        gg.pixelkingdomwars.nativeclient.update.UpdateDownloader(File(application.cacheDir, "updates")),
        gg.pixelkingdomwars.nativeclient.update.UpdateVerifier(gg.pixelkingdomwars.nativeclient.update.AndroidArchiveInspector(application.packageManager)),
        gg.pixelkingdomwars.nativeclient.update.UpdateInstaller(gg.pixelkingdomwars.nativeclient.update.AndroidInstallSessions(application)),
        isMetered = { application.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: true },
        activation = updateActivation, marker = gg.pixelkingdomwars.nativeclient.update.SharedInstallMarker(application),
    ).also { gg.pixelkingdomwars.nativeclient.update.NativeUpdateRuntime.repository = it }
    /** Owner 2026-09-27: every launch looks for a newer build on the loading screen, before the game opens, through a
     *  session-less read that no later capabilities change can break (BootViewModel starts it; PkwApp routes on it). */
    val bootUpdates = gg.pixelkingdomwars.nativeclient.update.BootUpdateGate(appScope, updates,
        { gameApi.getPublic("/native/capabilities") }, versionCode.toLong(), enabled = !mode.offline)
    val worldContent: WorldContent by lazy { WorldContent(File(application.noBackupFilesDir, storageNamespace(origin, "world-content")), origin) }
    val preferences: DevicePreferences by lazy { SharedDevicePreferences(application) }
    val notifications: NativeNotifications by lazy {
        NativeNotifications(NativeNotificationRuntime.journal(application), FirebaseNotificationTokens(),
            { holder.current }, { SessionApiClient(gameApi, it.token, routing) }, holder::requireCurrent,
            { NativeNotificationRuntime.permitted(application) }, BuildConfig.NATIVE_FCM_CONFIGURED && !mode.offline,
            application.packageName, { NativeNotificationRuntime.cancelShown(application) })
    }
    private fun store(name: String) = EncryptedStore(application, storageNamespace(origin, name))
    // Share the journal monitor across reauthentication of the same wallet so a
    // retired session's slow storage work cannot overwrite a newer request.
    private val candidateExpansionStores = mutableMapOf<String, CandidateExpansionStore>()
    /** A cancelled session may still be finishing a durable command write. All sessions for this
     * origin share the entire journal transaction lock, not just individual encrypted reads. */
    private val pendingBattles: PendingBattleStore by lazy { PendingBattleStore(store("pending-battles")) }
    val gameApi: GameApi by lazy { NativeNotificationRuntime.api(application, { content.simVersion() }, { content.state.value.rendererContract }) }
    val walletStore: SecretStore by lazy { store("mwa") }
    /** Public Privy identity for the social-login track (plan decision 3). The adapter is
     * initialized only by that track; carrying the config here does not start Privy. */
    val privy: PrivyPublicConfig? = PrivyPublicConfig.from(BuildConfig.PRIVY_APP_ID, BuildConfig.PRIVY_APP_CLIENT_ID)
    val socialMarker: SocialLoginMarker by lazy { SocialLoginMarker(store("privy-intent")) }
    val socialBinding: SocialBinding by lazy { SocialBinding(store("privy-binding")) }
    private var socialLogin: SocialLogin? = null
    /** The Privy SDK starts only here: on the first social option chosen, or a social account's sign-out.
     * Main thread (the SDK requires it); MWA is untouched. Null when the build carries no Privy client. */
    fun social(): SocialLogin? {
        val config = privy ?: return null
        return socialLogin ?: PrivySocialLogin(requireNotNull(PrivyWalletAdapter.create(application, config)), gameApi, socialMarker, socialBinding, PRIVY_APP_URL_SCHEME)
            .also { socialLogin = it }
    }
    /** After the server session is released: forget the MWA authorization and end the Privy session (web
     * apps/web/src/auth/useSignOut.ts: server logout, then Privy logout so another account can sign in).
     * [wallet] is null when the account signing out never installed a session (the alpha gate turned it
     * away); LocalCredentialRelease then decides from the device's social binding. */
    suspend fun releaseLocalCredentials(mwa: WalletLogin?, wallet: String?) =
        LocalCredentialRelease(socialBinding) { social() }.release({ mwa?.clearAuthorization() }, if (privy == null) null else wallet)
    private val _sessionGraph = MutableStateFlow<SessionGraph?>(null)
    val sessionGraph: StateFlow<SessionGraph?> = _sessionGraph.asStateFlow()
    private var catalogCache: Pair<File, FantasyCatalog>? = null
    /** The frozen fantasy geography of the active content generation, parsed once per assets directory. */
    @Synchronized fun fantasyCatalog(): FantasyCatalog? {
        val state = content.state.value
        val assets = state.assets ?: return null; val catalogue = state.catalogue ?: return null
        catalogCache?.takeIf { it.first == assets }?.let { return it.second }
        return runCatching { FantasyCatalog.load(assets, catalogue) }.onFailure { if (debug) Log.w("PKWWorld", "fantasy catalog unavailable: ${it.message}") }.getOrNull()?.also { catalogCache = assets to it }
    }
    val account: LiveAccountRepository by lazy {
        LiveAccountRepository(gameApi, origin, holder, store("base-selection"), routing) { session ->
            if (!mode.offline) notifications.identityChanged(session)
            _sessionGraph.value = buildSession(session)
        }.also { if (!mode.offline) {
            it.beforeLogout = notifications::beforeLogout
            it.beforeIdentityChange = notifications::blockLocally
        } }
    }

    /** Admission has an authenticated cookie, but deliberately no gameplay session graph. */
    fun admissionSeeker(pending: PendingAdmission): AdmissionSeekerRepository {
        val guard = {
            gameApi.requireCurrentSession(pending.token)
            if (account.state.value.phase != AccountPhase.ALPHA || account.state.value.admission !== pending) throw SessionSupersededException()
        }
        guard()
        val bound = SessionApiClient(gameApi, pending.token, routing)
        val client = object : ApiClient by bound {
            override suspend fun post(path: String, body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject =
                try { bound.post(path, body) } catch (error: ApiException) {
                    if (error.status == 401) account.discardAdmission(pending, error)
                    throw error
                }
        }
        return AdmissionSeekerRepository(pending, origin, client,
            SeekerJournal(store("seeker-action-${pending.wallet}"), pending.wallet, origin),
            { SeekerBounds.from(content.state.value.catalogue) }, guard, { account.resumeAdmission(pending) })
    }

    private val legalDocuments by lazy { PublicLegalDocuments() }
    fun legal() = LegalRepository(mode.offline, legalDocuments::load)

    /** Created for a security destination, never as a tokenless account singleton. */
    fun security(mwa: WalletLogin?): SecurityGraph {
        val access = SecurityAccess(account.state.value, gameApi.sessionToken(), { account.state.value }, gameApi::requireCurrentSession)
        access.requireCurrent()
        val confirmations = walletConfirmations(access, mwa)
        // Security handles a revoked full/pending cookie itself so it can release only this identity's
        // credentials and preserve the recovery notice, before global routing discards the holder.
        val client = SessionApiClient(gameApi, access.token, ApiRouting())
        val repository = LiveSecurityRepository(client, access::requireCurrent, confirmations::authorize,
            SecurityRecoveryStore(store("security-recovery-${access.wallet}"), access.wallet, origin),
            onSessionEnded = { message -> account.endSecuritySession(access, message) { releaseLocalCredentials(mwa, access.wallet) } },
            loginRecovery = access.loginRecovery)
        val authenticator = WalletAuthenticatorRepository(access.wallet, access::requireCurrent,
            isEmbedded = { socialBinding.isBoundForSecurity(access.wallet) },
            read = { guard -> requireNotNull(social()).walletTotpEnrolled(access.wallet, access.token, guard) },
            begin = { guard -> requireNotNull(social()).beginWalletTotp(access.wallet, access.token, guard) },
            finish = { setup, code, guard -> requireNotNull(social()).finishWalletTotp(setup, access.token, code, guard) })
        return SecurityGraph(access, repository, confirmations, authenticator)
    }

    fun withdrawalConfirmations(mwa: WalletLogin?): SecurityWalletConfirmation {
        val access = SecurityAccess(account.state.value, gameApi.sessionToken(), { account.state.value }, gameApi::requireCurrentSession)
        access.requireCurrent(); check(!access.loginRecovery) { "Finish signing in before withdrawing." }
        return walletConfirmations(access, mwa)
    }
    fun depositWallet(session: SessionGraph, mwa: WalletLogin?): KeepDepositWallet {
        holder.requireCurrent(session.session)
        return KeepDepositWallet(session.session, holder, socialBinding::isBoundForSecurity, ::social, mwa?.let { walletPayer(session, it) },
            SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) }, cluster, session.deposits::requirePaymentWindow)
    }
    fun gemsBuyWallet(session: SessionGraph, mwa: WalletLogin?): GemsBuyWallet {
        holder.requireCurrent(session.session)
        val payer = mwa?.let { login -> GemsBuyPayer { transaction, chain, wallet, onSent, onSigned, guard ->
            login.payWithEvidence(transaction, chain, wallet, session.session.token, onSent, onSigned) {
                holder.requireCurrent(session.session); guard()
            }
        } }
        return GemsBuyWallet(session.session, holder, origin, cluster, session.gemsBuyPayment,
            socialBinding::isBoundForSecurity, ::social, payer, session.gemsBuy::requirePaymentWindow)
    }
    fun marketWallet(session: SessionGraph, mwa: WalletLogin?): MarketPurchaseWallet {
        holder.requireCurrent(session.session)
        return MarketPurchaseWallet(session.session, holder, socialBinding::isBoundForSecurity, ::social, mwa?.let { walletPayer(session, it) },
            SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) }, cluster, session.marketTrades::requirePaymentWindow)
    }
    /** Deployment pins are independently injected. Production has none until its separate activation gate. */
    fun miningClaimsClient(session: SessionGraph, mwa: WalletLogin?, lifecycle: () -> MiningClaimsLifecycle,
        independentPins: MiningClaimSigningTrust? = null): MiningClaimsClient {
        holder.requireCurrent(session.session)
        val store = miningClaimsStores.forIdentity(origin, cluster.id, session.session.wallet)
        val external = mwa?.let { login -> MiningClaimsExternalSigner { prepared, chain, retain, guard ->
            login.signTransactionOnlyWithEvidence(prepared, chain, session.session.token, retain) {
                holder.requireCurrent(session.session); guard()
            }
        } }
        val wallet = MiningClaimsWallet(session.session, holder, origin, cluster,
            socialBinding::isBoundForSecurity, ::social, external)
        val ports = MiningClaimsAppPorts(session.session, holder, session.api, store,
            catalogue = { content.state.value.catalogue }, pins = { independentPins }, lifecycle = lifecycle,
            rpc = SolanaMiningClaimsRpcReads(SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) }),
            rpcGate = miningClaimsRpcGate,
            signer = { prepared, guard, retain -> wallet.sign(prepared, retain, guard); Unit },
            monotonicMs = android.os.SystemClock::elapsedRealtime,
            timeoutMs = LandCheckoutBounds.from(content.state.value.catalogue)?.requestTimeoutMs ?: 30_000)
        return MiningClaimsClient(MiningClaimsRepository(store, ports), wallet, independentPins != null)
    }
    /** No production pins until independent activation. History needs no live provider. */
    fun miningTaxClaimsStored(session: SessionGraph): Boolean {
        holder.requireCurrent(session.session); gameApi.requireCurrentSession(session.session.token)
        return EncryptedStore(application, storageNamespace(origin, "mining-tax-claims-${cluster.id}-${session.session.wallet}")).hasStoredData()
    }
    /** Pins/day unit are independently supplied; neither cookies nor history create authority.
     * Pass the historical day unit explicitly if canonical content later changes it. */
    fun miningTaxClaimsClient(session: SessionGraph, mwa: WalletLogin?, lifecycle: () -> MiningTaxClaimsLifecycle,
        independentPins: MiningTaxClaimsSigningTrust? = null, historicalPolicy: MiningTaxClaimsSigningPolicy? = null,
        miningEnabled: () -> Boolean = { false }): MiningTaxClaimsClient {
        holder.requireCurrent(session.session); gameApi.requireCurrentSession(session.session.token)
        val pins = requireNotNull(independentPins).copy(); require(pins.genesisHash == cluster.genesisHash)
        val rules = requireNotNull(historicalPolicy ?: miningTaxClaimsPolicy(content.state.value.catalogue)?.signing()).copy().also { it.validate() }
        val identity = gg.pixelkingdomwars.nativeclient.starter.StarterIdentity(origin.trimEnd('/'), cluster.id, session.session.wallet)
        val store = MiningTaxClaimsStore(EncryptedStore(application, storageNamespace(origin, "mining-tax-claims-${cluster.id}-${session.session.wallet}")), identity, pins, rules)
        val external = mwa?.let { login -> MiningTaxClaimsExternalSigner { prepared, chain, retain, guard ->
            login.signTransactionOnlyWithEvidence(prepared, chain, session.session.token, retain) {
                holder.requireCurrent(session.session); guard()
            }
        } }
        val wallet = MiningTaxClaimsWallet(session.session, holder, identity.origin, cluster, socialBinding::isBoundForSecurity, ::social, external)
        val ports = MiningTaxClaimsAppPorts(session.session, holder, identity.origin, cluster, gameApi.miningTaxClaimsPort(identity, session.session.token),
            store, { content.state.value.catalogue }, miningEnabled, lifecycle, wallet,
            SolanaMiningClaimsRpcReads(SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) }), miningClaimsRpcGate,
            android.os.SystemClock::elapsedRealtime, independentPins = { pins })
        return MiningTaxClaimsClient(MiningTaxClaimsRepository(store, ports), wallet, ports::appPolicy)
    }
    /** No production pins until independent activation. History needs no live provider. */
    fun realmSalesClient(session: SessionGraph, mwa: WalletLogin?, lifecycle: () -> RealmSalesLifecycle,
        independentPins: RealmSaleSigningTrust? = null, independentFailurePins: RealmSaleFailureTrust? = null): RealmSalesClient {
        holder.requireCurrent(session.session)
        val store = RealmSalesStore(EncryptedStore(application, storageNamespace(origin, "realm-sales-${cluster.id}-${session.session.wallet}")),
            gg.pixelkingdomwars.nativeclient.starter.StarterIdentity(origin.trimEnd('/'), cluster.id, session.session.wallet), independentFailurePins)
        val external = mwa?.let { login -> RealmSalesExternalSigner { prepared, chain, retain, guard ->
            login.signTransactionOnlyWithEvidence(prepared, chain, session.session.token, retain) {
                holder.requireCurrent(session.session); guard()
            }
        } }
        val wallet = RealmSalesWallet(session.session, holder, origin, cluster, socialBinding::isBoundForSecurity, ::social, external)
        val ports = RealmSalesAppPorts(session.session, holder, session.api, store,
            catalogue = { content.state.value.catalogue }, pins = { independentPins }, lifecycle = lifecycle,
            rpc = SolanaRealmSalesRpcReads(SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) }),
            rpcGate = realmSalesRpcGate, signer = { prepared, guard, retain -> wallet.sign(prepared, retain, guard); Unit },
            walletReady = wallet::requireAvailable,
            monotonicMs = android.os.SystemClock::elapsedRealtime,
            timeoutMs = LandCheckoutBounds.from(content.state.value.catalogue)?.requestTimeoutMs ?: 30_000)
        return RealmSalesClient(RealmSalesRepository(store, ports), wallet, independentPins != null, ports::policy)
    }
    /** Every external payment is ONE Mobile Wallet Adapter association ([WalletLogin.pay]): the wallet's own send,
     * with the same-session sign-only fallback. The identity guard runs inside each wallet call. */
    internal fun walletPayer(session: SessionGraph, mwa: WalletLogin) = WalletPayer { transaction, cluster, wallet, onSent ->
        mwa.pay(transaction, cluster, wallet, session.session.token, onSent) { holder.requireCurrent(session.session) }
    }
    /** The land rail ([LandPaymentWallet]). Built in composition, so the identity guard runs inside the wallet call rather than here. */
    fun landWallet(session: SessionGraph, mwa: WalletLogin): LandPaymentWallet =
        LandPaymentWallet(walletPayer(session, mwa), SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) })
    fun basePurchaseWallet(session: SessionGraph, mwa: WalletLogin?): BasePurchaseWallet {
        holder.requireCurrent(session.session)
        return BasePurchaseWallet(session.session, holder, socialBinding::isBoundForSecurity, ::social, mwa?.let { walletPayer(session, it) },
            SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) }, cluster, session.basePurchases::requirePaymentWindow)
    }
    private fun walletConfirmations(access: SecurityAccess, mwa: WalletLogin?): SecurityWalletConfirmation {
        val proof = WalletRecentAuth(gameApi, access.token)
        return SecurityWalletConfirmation(access, socialBinding::isBoundForSecurity, ::social, external = {
            val wallet = requireNotNull(mwa) { "A compatible wallet app is needed to confirm this action." }
            object : WalletSigner {
                override val address = access.wallet
                override suspend fun signMessage(message: ByteArray): ByteArray =
                    wallet.signMessage(message, access.wallet, access.token, access::requireCurrent)
            }
        }, prove = { purpose, signer, intent, guard -> proof.prove(purpose, signer, access.wallet, intent, guard).grant },
            proveWithdrawal = { signer, intent, guard -> proof.prove(RecentAuthPurpose.WITHDRAWAL, signer, access.wallet, intent, guard) })
    }

    init {
        require(debug || !mode.offline)
        NativeNotificationRuntime.offline = mode.offline
        if (!mode.offline) {
            appScope.launch { account.state.collectLatest { value ->
                when (value.phase) {
                    AccountPhase.SIGNED_OUT -> notifications.signOut()
                    AccountPhase.SIGNED_IN -> if (!value.busy) notifications.refresh()
                    else -> Unit
                }
            } }
            appScope.launch { NativeNotificationRuntime.tokenChanges.collect { notifications.refresh() } }
        }
        if (!mode.offline) {
            // Stable rows are public: the startup and signed-out checks carry no session, so the concurrent restore (and a
            // signed-out player's 401) cannot discard them. A signed-in wallet's check is bound to its session (tester rows)
            // or fails as superseded, never silently public; a check that still fails is retried once the restore settles.
            appScope.bindUpdateChannel(updates, holder.session.map { it?.wallet },
                { caller -> gg.pixelkingdomwars.nativeclient.update.updateCapabilities(gameApi, caller?.let { wallet -> holder.current?.takeIf { it.wallet == wallet }?.token ?: throw SessionSupersededException() }).also { worldV2.onCapabilities(it) } },
                settled = account.state.map { it.phase != AccountPhase.RESTORING && !it.busy }, foreground = foreground,
                blockOrders = content::blockOrdersForUpdate)
            appScope.launch { sessionGraph.collectLatest { graph ->
                updateActivation.value = true
                graph?.battle?.state?.collect { updateActivation.value = !it.battleVisible && it.replay == null && it.spectator == null }
            } }
        }
        appScope.launch { holder.session.collect { session -> if (session == null) _sessionGraph.value = null } }
        appScope.launch { routing.events.collect { event ->
            if (event is RoutingEvent.SessionExpired) holder.current?.let { account.discardSession(it, null) }
        } }
    }

    companion object {
        /** OAuth callback scheme registered on the Privy Android app client (docs/PRIVY_ANDROID.md; the owner
         * confirmed it in the dashboard on 2026-09-11 as the allowed URL scheme, with both application IDs and
         * the release + debug key hashes). The manifest's PrivyRedirectActivity filter carries the same scheme;
         * a test pins the two together. */
        const val PRIVY_APP_URL_SCHEME = "pixelkingdomwars"
    }

    private fun buildSession(session: AccountSession): SessionGraph {
        val scope = requireNotNull(holder.scopeOf(session)) { "The session has no active scope" }
        val api = SessionApiClient(gameApi, session.token, routing)
        val intents = pendingIntents
        val observer = ReceiptObserver(intents)
        val baseId = { account.state.value.selectedBaseId }
        val interlock = LiveDeedInterlock(session, holder, gameApi, api, account.state.map { it.selectedBaseId to (it.directory?.stableMutations == true) })
        val fleetJourneys = FleetJourneyPublication(session, holder)
        val base = LiveBaseRepository(session, holder, api, intents, observer, baseId,
            catalogue = { content.state.value.catalogue },
            refreshAccount = { account.refreshIdentity(); account.refreshDirectory() },
            baseGeneration = { account.state.value.baseSelectionGeneration },
            builderActionsAllowed = { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
            fleetJourneys = fleetJourneys)
        val fleetJourneyDepartures = FleetJourneyDepartures(session.wallet, fleetJourneys, { base.state.value.base },
            baseId, { account.state.value.baseSelectionGeneration }, diagnosticOriginal = { guard ->
                guard(); holder.requireCurrent(session)
                val raw = gameApi.getBoundCosmetic("/bound-cosmetics/wakes/v1/workshop", emptyMap(), session.token, guard)
                holder.requireCurrent(session); guard()
                gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeWorkshopView.from(raw, session.wallet, null) {
                    error("Account-only diagnostic must not need a selected catalogue")
                }.original
            }) { path, query, guard ->
            guard(); holder.requireCurrent(session)
            val raw = when {
                path.startsWith("/bound-cosmetics/wakes/v1/") -> gameApi.getBoundCosmetic(path, query, session.token, guard)
                path == "/starter-expeditions" -> gameApi.getStarterExpedition(path, query, session.token, guard)
                path == "/vehicles/fleet" -> gameApi.get(path, query, session.token)
                else -> error("Unknown journey presentation read")
            }
            holder.requireCurrent(session); guard(); raw
        }
        // The Home SHARDS/KEEP chips read this repository; every accepted KEEP/Shards mutation made elsewhere ends with it.
        val refreshHud = homeHudRefresh { base.refreshWithoutJourneys() }
        val army = LiveArmyRepository(session, holder, api, intents, observer, baseId, { content.state.value.catalogue }, { base.state.value }, { base.refreshWithoutJourneys() },
            refreshAccount = { account.refreshIdentity(); account.refreshDirectory() },
            baseGeneration = { account.state.value.baseSelectionGeneration },
            heroActionsAllowed = { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
            hydrateResearchHome = base::refreshForResearch,
            hydrateTrainingFinishHome = base::refreshForWorkshop)
        scope.launch {
            combine(content.state, interlock.state) { contentState, raid -> contentState.allowsGameOrders(versionCode) && raid.actionsAllowed }
                .distinctUntilChanged().collect { allowed -> if (!allowed) { base.retireBuilderFinishReview(); army.dismissHeroReview(); army.dismissResearchReview(); army.dismissTrainingFinishReview() } }
        }
        val constants = { (content.state.value.catalogue?.get("constants") as? kotlinx.serialization.json.JsonObject) }
        val commandSelection = java.util.concurrent.atomic.AtomicLong()
        scope.launch { account.state.map { it.selectedBaseId }.distinctUntilChanged().collect { commandSelection.incrementAndGet() } }
        val commandOwner = java.util.concurrent.atomic.AtomicReference<Pair<BattleCoordinator, gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports.CommandLease>?>(null)
        val battle = LiveBattleRepository(session, holder, scope, api, gameApi, pendingBattles, baseId,
            { content.simVersion() }, { content.allowsGameOrders(versionCode) }, { base.refreshWithoutJourneys() },
            { error -> account.discardSession(session, error) }, { if (debug) Log.i("PKWVisual", it) },
            stableSelector = { account.state.value.directory?.selectorAvailable == true },
            // Every game number from the catalogue by its constants.ts name; a missing key fails closed (null).
            campaignStages = { (constants()?.get("CAMPAIGN") as? kotlinx.serialization.json.JsonObject)?.get("tierByStage")?.let { it as? kotlinx.serialization.json.JsonArray }?.size },
            scoutPreviewSec = { (constants()?.get("RAID_RULES") as? kotlinx.serialization.json.JsonObject)?.string("scoutPreviewSec")?.toIntOrNull() },
            archivedSimSupported = { sim->archivedReplaySupported(sim,content.simVersion(),content.state.value.renderCatalogue) },
            commandTiming = { coordinator -> commandOwner.get()?.takeIf { it.first === coordinator }?.second },
            coordinatorFactory = { base, sim ->
                val timing = gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports.commandTiming(
                    current = { holder.isCurrent(session) && baseId() == base }, selection = commandSelection::get)
                scope.coroutineContext[kotlinx.coroutines.Job]?.invokeOnCompletion { timing.close() }
                BattleCoordinator(session.wallet, base, sim, pendingBattles, gameApi, session.token, timing).also {
                    commandOwner.getAndSet(it to timing)?.second?.close()
                }
            })
        val world = LiveWorldRepository(session, holder, api, baseId, { content.state.value.catalogue }, { fantasyCatalog() })
        // RPC reads ride the session-bound relay (`/rpc/solana/<cluster>`); no provider key is ever in the APK.
        val rpc = { cluster: SolanaCluster -> SolanaRpc { request -> api.post("/rpc/solana/${cluster.id}", request) } }
        val land = LiveLandRepository(session, holder, scope, api, intents, observer, LandPurchaseStore(store("land-checkout")), cluster, rpc,
            { c -> ChainAddresses.forCluster(c) }, { LandCheckoutBounds.from(content.state.value.catalogue) }, { android.os.SystemClock.elapsedRealtime() })
        val economy = LiveEconomyRepository(session, holder, api, baseId, { account.state.value.landOwned }, intents, observer,
            refreshAccount = { account.refreshIdentity(); account.refreshDirectory(); refreshHud() },
            solBalance = { java.math.BigDecimal(rpc(cluster).balanceLamports(session.wallet)).movePointLeft(9).toPlainString() })
        val gems = GemsRepository(session, holder, api, gemsIntents, ReceiptObserver(gemsIntents), baseId,
            { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
            { account.refreshIdentity(); account.refreshDirectory() }, {
                base.refreshWithoutJourneys()
                check(base.state.value.error == null && base.state.value.balances != null) { "Gems accepted; refresh your kingdom balances before finishing." }
            })
        val gemsBuyPayment = gg.pixelkingdomwars.nativeclient.wallet.GemsBuyPayment(rpc(cluster), cluster, ChainAddresses.forCluster(cluster).keepMint)
        val gemsBuyBalances = GemsBuyBalances(session, holder, api,
            { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() },
            { account.state.value.directory?.let { !it.enabled || (it.stableMutations && baseId() != null) } == true },
            { base.refreshWithoutJourneys(); check(base.state.value.error == null && base.state.value.balances != null) {
                "Gems credited. Refresh your kingdom balances before finishing."
            } })
        val gemsBuy = GemsBuyRepository(session, holder, api, gemsBuyStores.forIdentity(origin, cluster.id, session.wallet), cluster,
            { ChainAddresses.forCluster(cluster).keepMint }, { KeepDepositBounds.from(content.state.value.catalogue) },
            gemsBuyPayment::prepare, gemsBuyBalances::refresh, { android.os.SystemClock.elapsedRealtime() },
            { runCatching { Math.multiplyExact(requireNotNull((constants()?.get("ECONOMY") as? kotlinx.serialization.json.JsonObject)
                ?.string("depositReuseMinRemainingMin")).toLong(), 60_000L) }.getOrNull() })
        val forgeClaims = ForgeClaimsRepository(session, holder, api, intents, observer, baseId,
            { account.state.value.directory }, { account.state.value.landOwned },
            refreshAccount = { account.refreshIdentity(); account.refreshDirectory() },
            batchMax = { (constants()?.get("FORGE") as? kotlinx.serialization.json.JsonObject)?.string("claimBatchMax")?.toIntOrNull() }, cluster = cluster.id,
            invalidateViews = { economy.invalidateForge(); base.invalidateForgeBalance() },
            refreshViews = economy::refreshForgeAfterClaim, refreshHome = base::refreshAfterForgeClaim)
        val withdrawalUnwind = WithdrawalUnwindRepository(session, holder, api, intents, observer, baseId,
            { account.state.value.directory }, { account.refreshIdentity(); account.refreshDirectory(); refreshHud() })
        val faucet = FaucetRepository(session, holder, api, FaucetJournal(store("faucet-${session.wallet}"), session.wallet, origin, cluster.id),
            cluster.id, { FaucetBounds.from(content.state.value.catalogue) }, {
                economy.refresh(EconomyPage.WALLET)
                check(economy.state.value.errors["/wallet/balances"] == null) { "Grant confirmed; wallet balance refresh is unavailable. Check again." }
            })
        val community = LiveCommunityRepository(session, holder, api, intents, observer, baseId, { MailBounds.from(content.state.value.catalogue) }, refreshHud,
            selectionGeneration = { account.state.value.baseSelectionGeneration })
        val referrals = ReferralRepository(session, holder, api,
            ReferralJournal(store("referral-${cluster.id}-${session.wallet}"), session.wallet, origin, cluster.id))
        val baseClaims = BaseClaimRepository(session, holder, api,
            BaseClaimJournal(store("base-claim-${cluster.id}-${session.wallet}"), session.wallet, origin, cluster.id),
            { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory(); holder.requireCurrent(session) })
        val chat = LiveChatRepository(session, holder, api, ChatOutbox(store("chat-outbox-${session.wallet}"), session.wallet, origin), { ChatBounds.from(content.state.value.catalogue) })
        val clans = LiveClansRepository(session, holder, api, intents, observer, baseId, { base.refreshWithoutJourneys() }, cluster.id,
            directory = { account.state.value.directory }, landOwned = { account.state.value.landOwned },
            refreshAccount = { account.refreshIdentity(); account.refreshDirectory() })
        val feedback = LiveFeedbackRepository(session, holder, api, FeedbackOutbox(store("feedback-outbox-${session.wallet}"), session.wallet, origin), { FeedbackBounds.from(content.state.value.catalogue) },
            issueBounds = { FeedbackIssueBounds.from(content.state.value.catalogue) }, nativeBuild = BuildConfig.NATIVE_BUILD_SHA)
        val playtest = LivePlaytestRepository(session, holder, api, CampaignOutbox(store("campaign-outbox-${session.wallet}"), session.wallet, origin),
            { PlaytestBounds.from(content.state.value.catalogue) }, { FeedbackBounds.from(content.state.value.catalogue) })
        val deposits = KeepDepositRepository(session, holder, api,
            KeepDepositStore(store("keep-deposit-${cluster.id}-${session.wallet}"), session.wallet, origin, cluster.id), cluster,
            { ChainAddresses.forCluster(cluster).keepMint }, { KeepDepositBounds.from(content.state.value.catalogue) },
            preparePayment = { quote -> gg.pixelkingdomwars.nativeclient.wallet.KeepDepositPayment.prepare(rpc(cluster), quote.wallet, quote.source, quote.destination, quote.mint, quote.reference, quote.baseUnits, quote.decimals) },
            refreshWallet = {
                account.refreshIdentity(); economy.refresh(EconomyPage.WALLET); refreshHud()
                check(listOf("/balances", "/wallet/balances").none { it in economy.state.value.errors }) { "Deposit confirmed. Reconnect to refresh account and wallet balances before finishing." }
            }, monotonicMs = { android.os.SystemClock.elapsedRealtime() },
            signatureLanding = { signature, lastValidBlockHeight -> rpc(cluster).signatureLanding(signature, lastValidBlockHeight) })
        val tester = LiveTesterRepository(session, holder, api, { TesterBounds.from(content.state.value.catalogue) })
        val market = MarketRepository(session, holder, api) { MarketDestinations.from(content.state.value.catalogue) }
        val marketTrades = MarketTransactionsRepository(session, holder, api, intents, observer,
            MarketPurchaseStore(store("market-purchase-${cluster.id}-${session.wallet}"), session.wallet, origin, cluster.id), cluster,
            baseId, { account.state.value.landOwned }, { MarketTradeBounds.from(content.state.value.catalogue) },
            { quote -> gg.pixelkingdomwars.nativeclient.wallet.MarketPurchasePayment.prepare(rpc(cluster), quote) },
            refreshAccount = {
                account.refreshIdentity(); account.refreshDirectory(); economy.refresh(EconomyPage.WALLET)
                check(listOf("/balances", "/wallet/balances").none { it in economy.state.value.errors }) { "Reconnect to refresh account and wallet balances before finishing this market action." }
            }, refreshMarket = {
                market.refresh()
                check(listOf(MarketRepository.BOOK, MarketRepository.OWN).all { it in market.state.value.fresh }) { "Reconnect to refresh market listings before finishing." }
            }, ownedBaseIds = { account.state.value.directory?.bases?.map { it.id }?.toSet() },
            monotonicMs = { android.os.SystemClock.elapsedRealtime() },
            signatureLanding = { signature, lastValidBlockHeight -> rpc(cluster).signatureLanding(signature, lastValidBlockHeight) })
        val seeker = SeekerRepository(session, holder, api, SeekerJournal(store("seeker-action-${session.wallet}"), session),
            { SeekerBounds.from(content.state.value.catalogue) }, account::refreshIdentity)
        val heroRecruitment = HeroRecruitmentRepository(session, holder, api, intents, observer, baseId,
            { account.state.value.directory }, { account.refreshIdentity(); account.refreshDirectory() },
            { content.state.value.catalogue }, { base.refreshWithoutJourneys(); army.refreshInventory(); army.refreshHeroes() }, cluster.id)
        val wallBatch = WallBatchRepository(session, holder, api, intents, observer, baseId,
            { account.state.value.directory }, { account.refreshIdentity(); account.refreshDirectory() },
            { content.state.value.catalogue }, { content.state.value.renderCatalogue },
            { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }, { base.refreshWithoutJourneys() }, cluster.id)
        val basePurchases = BasePurchaseRepository(session, holder, api,
            BasePurchaseStore(store("paid-base-${cluster.id}-${session.wallet}"), session.wallet, origin, cluster.id), cluster,
            baseId, { account.state.value.directory }, { content.state.value.catalogue },
            { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
            { account.refreshIdentity(); account.refreshDirectory() }, { base.refreshWithoutJourneys() },
            { quote -> gg.pixelkingdomwars.nativeclient.wallet.BasePurchasePayment.prepare(rpc(cluster), ChainAddresses.forCluster(cluster),
                gg.pixelkingdomwars.nativeclient.wallet.BasePurchaseKind.entries.single { it.wire == quote.request.kind }, quote.wallet,
                quote.reference, quote.amountLamports.toBigInteger(), quote.rail.destination,
                quote.rail.directLamports?.toBigInteger(), quote.rail.splitLamports?.toBigInteger()) },
            { android.os.SystemClock.elapsedRealtime() },
            signatureLanding = { signature, lastValidBlockHeight -> rpc(cluster).signatureLanding(signature, lastValidBlockHeight) })
        val candidateExpansions = if (gg.pixelkingdomwars.nativeclient.model.CandidateExpansionContract.lane(
                BuildConfig.NATIVE_CANDIDATE, origin, BuildConfig.APPLICATION_ID, mode.offline)) {
            CandidateExpansionRepository(session, holder, api, candidateExpansionStores.getOrPut(session.wallet) {
                CandidateExpansionStore(store("candidate-expansion-${session.wallet}"), session.wallet, origin)
            }, true, baseId, { account.state.value.directory }, { content.state.value.catalogue },
                { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
                { account.refreshIdentity(); account.refreshDirectory() }, { base.refreshWithoutJourneys(); check(base.state.value.error == null) { "Refresh your kingdom again to see the new claim." } })
        } else null
        val workshopFactory = {
            WorkshopRepository(session, holder, api, workshopStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.balances != null) { "Workshop accepted. Refresh the original kingdom balances before finishing." }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
                { android.os.SystemClock.elapsedRealtime() }).also { workshop ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) workshop.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { workshop.invalidateAdmission() }
                }
            }
        }
        // This session owns only admitted optional art leases. The ordinary renderer
        // retains its own lease lifetime; content activation remains independently held.
        val cosmeticContent = MutableStateFlow<ServiceContentSession?>(null)
        val cosmeticArtGeneration = MutableStateFlow(0L)
        val cosmeticQueueLimit = {
            val constants = requireNotNull(content.state.value.catalogue?.get("constants") as? JsonObject)
            val crafting = requireNotNull(constants["PHASE_E_ORDINARY_CRAFTING"] as? JsonObject)
            val rules = requireNotNull(crafting["v1"] as? JsonObject)
            val count = requireNotNull(rules["maxConcurrentPerBase"] as? JsonPrimitive)
            require(!count.isString)
            requireNotNull(count.intOrNull).also { require(it > 0) }
        }
        val leasedCosmeticArt = LeasedBoundCosmeticArtAdmission(
            content = { cosmeticContent.value?.admitted() },
            marketOutput = { level ->
                val loaded = content.state.value
                gg.pixelkingdomwars.nativeclient.scene.SceneMapper(requireNotNull(loaded.catalogue), requireNotNull(loaded.renderCatalogue))
                    .completedMarketOutput()(level)
            })
        val cosmeticArt = object : BoundCosmeticArtAdmission {
            override fun applicationReady() = leasedCosmeticArt.applicationReady() &&
                runCatching { leasedCosmeticArt.maxConcurrentPerBase() == cosmeticQueueLimit() }.getOrDefault(false)
            // A legacy core catalogue still supports strict current reads and free Off;
            // only new craft/On require the separately admitted Awning extension.
            override fun maxConcurrentPerBase() = cosmeticQueueLimit()
            override fun completedMarketOutput(level: Long) = leasedCosmeticArt.completedMarketOutput(level)
            override suspend fun preview(appearance: gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance,
                guard: () -> Unit): BoundCosmeticPreview {
                check(applicationReady()) { "Verified Awning content is unavailable." }
                return leasedCosmeticArt.preview(appearance) {
                    guard(); check(applicationReady()) { "Verified Awning content changed." }
                }
            }
        }
        // Verified source pixels are independent of fleet application/craft admission.
        val wakeSourcePreview = object : BoundCosmeticWakeSourcePreview {
            override suspend fun wakePreview(appearance: gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance,
                guard: () -> Unit): BoundCosmeticWakePreview {
                val current = requireNotNull(cosmeticContent.value) { "Aurora source art is unavailable in this client." }
                return LeasedBoundCosmeticWakeSourcePreview(content = { current.admitted() }).wakePreview(appearance) {
                    holder.requireCurrent(session); guard()
                    check(cosmeticContent.value === current) { "The admitted appearance content changed." }
                }
            }
        }
        scope.launch {
            content.state.collectLatest { loaded ->
                var opened: ServiceContentSession? = null
                try {
                    if (!loaded.ready) return@collectLatest
                    val owner = kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]!!
                    val guard = {
                        holder.requireCurrent(session)
                        check(content.state.value === loaded) { "The admitted content changed." }
                    }
                    opened = serviceContent.open(loaded, api, owner, guard)
                    guard(); cosmeticContent.value = opened; cosmeticArtGeneration.value++
                    kotlinx.coroutines.awaitCancellation()
                } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                catch (error: Exception) { Log.w("BoundCosmeticArt", "Verified Awning content is unavailable", error) }
                finally {
                    if (cosmeticContent.value === opened) { cosmeticContent.value = null; cosmeticArtGeneration.value++ }
                    opened?.close()
                }
            }
        }
        val boundCosmeticWorkshopFactory = {
            BoundCosmeticWorkshopRepository(session, holder, api,
                boundCosmeticWorkshopStores.forIdentity(origin, cluster.id, session.wallet),
                gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWorkshopRules(
                    { cosmeticArt.maxConcurrentPerBase() }, cosmeticArt::completedMarketOutput), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Appearance accepted. Refresh the selected kingdom to see its current materials."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
                cosmeticArt::applicationReady, { appearance, guard -> cosmeticArt.preview(appearance, guard); Unit }).also { workshop ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) workshop.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { workshop.invalidateAdmission() }
                }
                scope.launch { cosmeticArtGeneration.collect { workshop.invalidateAdmission() } }
            }
        }
        val boundCosmeticWakeWorkshopFactory = {
            // No C5 fleet application capability has been delivered. Repository defaults
            // keep new craft/On closed while account Off and exact originals remain usable.
            BoundCosmeticWakeWorkshopRepository(session, holder, api,
                boundCosmeticWorkshopStores.forWakeIdentity(origin, cluster.id, session.wallet), cosmeticQueueLimit, baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Appearance accepted. Refresh the selected kingdom to see its current materials."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
                { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }).also { workshop ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) workshop.dismiss() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { workshop.invalidateAdmission() }
                }
                scope.launch { cosmeticArtGeneration.collect { workshop.invalidateAdmission() } }
            }
        }
        val ordinaryCraftingFactory = {
            OrdinaryCraftingRepository(session, holder, api, ordinaryCraftingStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    // Ordinary receipts use the same guarded Home publication barrier as Forge history.
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Refining accepted. Refresh the original kingdom before archiving its receipt."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }).also { ordinary ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) ordinary.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { ordinary.invalidateAdmission() }
                }
            }
        }
        val miningContributionFactory = {
            MiningContributionRepository(session, holder, api, miningContributionStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    // Mining receipts use the same guarded Home publication barrier as Forge history.
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Mining contribution accepted. Refresh the original kingdom before archiving its receipt."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }).also { mining ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) mining.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { mining.invalidateAdmission() }
                }
            }
        }
        val starterFleetFactory = {
            StarterFleetRepository(session, holder, api, starterFleetStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    // Starter receipts use the same guarded Home publication barrier as Forge history.
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Starter installation accepted. Refresh the original kingdom before archiving its receipt."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }).also { starterFleet ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) starterFleet.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { starterFleet.invalidateAdmission() }
                }
            }
        }
        val starterExpeditionFactory = {
            StarterExpeditionRepository(session, holder, api, starterExpeditionStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    // Starter receipts use the same guarded Home publication barrier as Forge history.
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Starter departure accepted. Refresh the original kingdom before archiving its receipt."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed },
                captureDeparture = fleetJourneyDepartures::capture).also { starterExpedition ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) starterExpedition.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { starterExpedition.invalidateAdmission() }
                }
            }
        }
        val harvesterFactory = {
            HarvesterRepository(session, holder, api, harvesterStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { publicationGuard ->
                    // Harvester receipts use the same guarded Home publication barrier as Forge history.
                    base.refreshForWorkshop(publicationGuard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Harvester source accepted. Refresh the original kingdom before archiving its receipt."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }).also { harvester ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) harvester.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { harvester.invalidateAdmission() }
                }
            }
        }
        // Phase E: fresh directory authority is independent from permanent receipt recovery.
        val freeBasePurchaseFactory = {
            FreeBasePurchaseRepository(session, holder, api, freeBasePurchaseStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() },
                { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }).also { purchase ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) purchase.invalidateAdmission() }
                }
                scope.launch {
                    account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { purchase.invalidateAdmission() }
                }
            }
        }
        val seekerResourceClaimsFactory = {
            SeekerResourceClaimsRepository(session, holder, api, seekerResourceClaimStores.forIdentity(origin, cluster.id, session.wallet), baseId,
                { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
                { account.refreshIdentity(); holder.requireCurrent(session); account.refreshDirectory() }, { guard ->
                    val originalBase = requireNotNull(baseId()); guard()
                    val inventory = gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView.from(
                        api.getOrdinaryCrafting("/ordinary-crafting", mapOf("baseId" to originalBase), guard))
                    check(inventory.baseId == originalBase && inventory.wallet == session.wallet); guard()
                    base.refreshForWorkshop(guard)
                    check(base.state.value.error == null && base.state.value.base != null && base.state.value.balances != null) {
                        "Claim accepted. Refresh the original kingdom before archiving its receipt."
                    }
                }, { content.allowsGameOrders(versionCode) && interlock.state.value.actionsAllowed }).also { claims ->
                scope.launch {
                    combine(content.state, interlock.state) { loaded, raid -> loaded.allowsGameOrders(versionCode) && raid.actionsAllowed }
                        .distinctUntilChanged().collect { allowed -> if (!allowed) claims.invalidateAdmission() }
                }
                scope.launch { account.state.map { it.baseSelectionGeneration }.distinctUntilChanged().collect { claims.invalidateAdmission() } }
            }
        }
        val graph = SessionGraph(session, scope, api, intents, observer, base, army, battle, world, land, economy, gems, gemsBuy, gemsBuyPayment, gemsBuyBalances, forgeClaims, withdrawalUnwind, faucet, referrals, community, chat, clans, feedback, deposits, tester, market, marketTrades, seeker, playtest, interlock, heroRecruitment, wallBatch, basePurchases, baseClaims, candidateExpansions, workshopFactory, ordinaryCraftingFactory, boundCosmeticWorkshopFactory, cosmeticArt, cosmeticArtGeneration.asStateFlow(), miningContributionFactory, starterFleetFactory, starterExpeditionFactory, harvesterFactory, freeBasePurchaseFactory, seekerResourceClaimsFactory, boundCosmeticWakeWorkshopFactory, wakeSourcePreview, fleetJourneys, fleetJourneyDepartures)
        scope.launch { runCatching { observer.refresh(session.wallet) } }
        return graph
    }
}
