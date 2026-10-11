package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

internal class MemoryStore(var value: String? = null) : SecretStore {
    override fun read() = value
    override fun write(value: String) { this.value = value }
    override fun clear() { value = null }
}

/** Scripted transport for repository tests: routes answer from handlers; every call is recorded. */
internal class FakeApiClient : ApiClient {
    val gets = mutableListOf<Pair<String, Map<String, String>>>()
    val posts = mutableListOf<Pair<String, JsonObject>>()
    val puts = mutableListOf<Pair<String, JsonObject>>()
    val deletes = mutableListOf<String>()
    val getHandlers = mutableMapOf<String, suspend (Map<String, String>) -> JsonObject>()
    val postHandlers = mutableMapOf<String, suspend (JsonObject) -> JsonObject>()
    val putHandlers = mutableMapOf<String, suspend (JsonObject) -> JsonObject>()
    val deleteHandlers = mutableMapOf<String, suspend () -> JsonObject>()
    val patches = mutableListOf<Pair<String, JsonObject>>()
    val patchHandlers = mutableMapOf<String, suspend (JsonObject) -> JsonObject>()
    fun onPatch(path: String, handler: suspend (JsonObject) -> JsonObject) { patchHandlers[path] = handler }
    override suspend fun patch(path: String, body: JsonObject): JsonObject { patches += path to body; return requireNotNull(patchHandlers[path]) { "Unexpected PATCH $path" }(body) }
    fun onGet(path: String, handler: suspend (Map<String, String>) -> JsonObject) { getHandlers[path] = handler }
    fun onPost(path: String, handler: suspend (JsonObject) -> JsonObject) { postHandlers[path] = handler }
    fun onPut(path: String, handler: suspend (JsonObject) -> JsonObject) { putHandlers[path] = handler }
    fun onDelete(path: String, handler: suspend () -> JsonObject) { deleteHandlers[path] = handler }
    override suspend fun get(path: String, query: Map<String, String>): JsonObject { gets += path to query; return requireNotNull(getHandlers[path]) { "Unexpected GET $path" }(query) }
    override suspend fun postMoneyCommand(path: String, body: kotlinx.serialization.json.JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency?, refusal: (gg.pixelkingdomwars.nativeclient.network.ApiException) -> Unit, guard: () -> Unit): kotlinx.serialization.json.JsonObject { guard(); return post(path, body) }
    override suspend fun post(path: String, body: JsonObject): JsonObject { posts += path to body; return requireNotNull(postHandlers[path]) { "Unexpected POST $path" }(body) }
    override suspend fun put(path: String, body: JsonObject): JsonObject { puts += path to body; return requireNotNull(putHandlers[path]) { "Unexpected PUT $path" }(body) }
    override suspend fun delete(path: String): JsonObject { deletes += path; return requireNotNull(deleteHandlers[path]) { "Unexpected DELETE $path" }() }
}

internal fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject
internal const val WALLET = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
internal const val BASE_ID = "b86b557b-bb8f-488b-8b18-035600ba0e4a"
internal fun baseJson(baseId: String = BASE_ID, jobs: String = "[]"): JsonObject = json("""{"baseId":"$baseId","visualContext":{"version":1,"realmId":"crownlands","artVersion":2},
    "player":{"wallet":"$WALLET","name":"","keepLevel":1,"trophies":0,"league":"bronze","builders":1,"expansions":0},"energy":{"used":0,"free":6,"max":6},
    "claim":{"min":8,"max":22},"buildings":[{"id":"eee0575f-6df7-4672-91ea-33f497d2e1d6","type":"keep","level":1,"tx":14,"ty":14,"underConstruction":false}],
    "obstacles":[],"jobs":$jobs,"freeBuilders":1}""")
internal fun balancesJson(shards: String = "3520", keep: String = "0"): JsonObject = json("""{"shards":"$shards","keep":"$keep","keepRate":1}""")
internal fun tutorialJson(): JsonObject = json("""{"step":0,"completedAt":null,"guideSkipped":false,"onboarding":null}""")
internal fun armyJson(queue: String = "[]", finishAllQueue: String = "[]", maxCostKeep: String = "0", freeOffer: String = "null"): JsonObject = json("""{"counts":{"highlander":10,"bowman":0},"levels":{"highlander":1,"bowman":1},"research":[],"queue":$queue,
    "rosterPts":20,"queuedPts":0,"campCapacityPts":20,"barracksQueuePts":10,"eliteUnlocks":{},
    "finishAllQuote":{"version":2,"queue":$finishAllQueue,"maxCostKeep":"$maxCostKeep"},
    "features":{"trainingScheduling":{"version":2,"mode":"sequential","lanes":1,"consentRequired":true},"researchConsent":{"version":1}},
    "freeFinishAllOffer":$freeOffer,"freeFinishAllReceipt":null,"freeFinishAllReviewRequired":false}""")
internal fun quoteJson(cost: String = "20"): JsonObject = json("""{"requested":[{"troop":"bowman","count":2}],"queueable":[{"troop":"bowman","count":2}],"remaining":[],
    "costShards":"$cost","availableShards":"3520","camp":{"used":20,"capacity":20,"after":24},"barracks":{"used":0,"capacity":10,"after":4},"completionSec":18,
    "consent":{"version":2,"queue":[],"unitDurations":[{"troop":"bowman","durationMs":9000}]},
    "schedule":{"version":2,"mode":"sequential","serverNow":"2026-09-11T00:00:00.000Z","startsAt":"2026-09-11T00:00:00.000Z","finishesAt":"2026-09-11T00:00:18.000Z","waitMs":0,"durationMs":18000}}""")

/** A holder whose scopes run inline: JVM tests need no Main looper. */
internal fun testHolder(parent: Job? = null) = AccountSessionHolder(parent, Dispatchers.Unconfined)
internal fun testToken(): SessionToken = SessionCookieJar("https://localhost:18443".toHttpUrl(), MemoryStore()).sessionToken()
internal fun signedIn(holder: AccountSessionHolder, wallet: String = WALLET): AccountSession {
    val session = AccountSession(wallet, "https://localhost:18443", testToken())
    holder.replace(session)
    return session
}

internal class FakeContentRepository(catalogue: JsonObject? = null, render: JsonObject? = null, assets: java.io.File? = null, minimumBuild: Int = 0) : ContentRepository {
    private val _state = MutableStateFlow(ContentState(assets, catalogue, render, minimumNativeBuild = minimumBuild))
    override val state: StateFlow<ContentState> = _state
    override val mode = LaunchMode.ACCOUNT
    var applied = 0
    override suspend fun initialize() {}
    override fun simVersion(): Int? = 14
    override suspend fun checkUpdates(api: ApiClient, force: Boolean) {}
    override suspend fun applyUpdate(canActivate: () -> Boolean) { check(canActivate()); applied++ }
    override suspend fun loadPreviewFixtures(): Pair<JsonObject, JsonObject?> = error("no fixtures")
    fun set(transform: (ContentState) -> ContentState) { _state.value = transform(_state.value) }
}

internal class FakeBaseRepository : BaseRepository {
    override var balanceRevision: Long = -1L
    val _state = MutableStateFlow(BaseState())
    override val state: StateFlow<BaseState> = _state
    val calls = mutableListOf<String>()
    var failWith: Exception? = null
    private val unused = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = error("unused")
        override suspend fun post(path: String, body: JsonObject) = error("unused")
    }
    private val store = PendingIntentStore(MemoryStore())
    override val construction = MoneyOp(ConstructionSpec, store, unused)
    override val wallRow = MoneyOp(WallRowSpec, store, unused)
    override val layoutUnlock = MoneyOp(LayoutUnlockSpec, store, unused)
    var wallRowQuote: WallRowQuote? = null
    var wallRowOutcome: WallRowOutcome? = null
    var layouts: Layouts? = null
    var unlockResult = LayoutUnlockAcceptance("500", "3020")
    var saveResult: LayoutSaveResult? = null
    private fun record(call: String) { calls += call; failWith?.let { throw it } }
    override suspend fun refresh() { if (balanceRevision >= 0) balanceRevision++; record("refresh") }
    override suspend fun refreshQuests() = record("quests")
    override suspend fun refreshMine() = record("mine")
    override suspend fun collectMine() = record("collect")
    override suspend fun claimDailyCache() = record("claimCache")
    override suspend fun claimQuest(questId: String) = record("claim:$questId")
    override suspend fun tutorialAction(action: String) = record("tutorial:$action")
    override suspend fun place(type: String, tx: Int, ty: Int) = record("place:$type:$tx:$ty")
    override suspend fun upgrade(buildingId: String) = record("upgrade:$buildingId")
    override suspend fun finishJob(jobId: String) = record("finish:$jobId")
    override suspend fun cancelJob(jobId: String) = record("cancel:$jobId")
    override suspend fun repairTrap(buildingId: String) = record("repair:$buildingId")
    override suspend fun clearObstacle(obstacleId: String) = record("clear:$obstacleId")
    override suspend fun moveBuilding(buildingId: String, tx: Int, ty: Int) = record("move:$buildingId:$tx:$ty")
    override suspend fun moveWalls(moves: List<BuildingMove>) = record("moveWalls:" + moves.joinToString(",") { "${it.id}:${it.tx}:${it.ty}" })
    override suspend fun quoteWallRow(wallId: String): WallRowQuote { record("quote:$wallId"); return requireNotNull(wallRowQuote) }
    override suspend fun upgradeWallRow(quote: WallRowQuote): WallRowOutcome { record("row:${quote.quoteId}"); return requireNotNull(wallRowOutcome) }
    override suspend fun refreshLayouts(): Layouts { record("layouts"); val read = requireNotNull(layouts); _state.value = _state.value.copy(layouts = read); return read }
    override suspend fun unlockFarmLayout(): LayoutUnlockAcceptance { record("unlock"); return unlockResult }
    override suspend fun saveLayout(slot: String, mode: String, geometryVersion: Int, expectedSlotEtag: String, expectedActiveEtag: String?, positions: List<LayoutPosition>): LayoutSaveResult {
        record("save:$slot:$mode:$expectedSlotEtag:${expectedActiveEtag}:${positions.size}"); return requireNotNull(saveResult)
    }
    override fun clearNotice() {}
}

internal class FakeArmyRepository : ArmyRepository {
    val _state = MutableStateFlow(ArmyDomainState())
    override val state: StateFlow<ArmyDomainState> = _state
    val calls = mutableListOf<String>()
    var failWith: Exception? = null
    private val store = PendingIntentStore(MemoryStore())
    private val transport = object : OpTransport { override suspend fun get(path: String, query: Map<String, String>) = error("unused"); override suspend fun post(path: String, body: JsonObject) = error("unused") }
    override val training = MoneyOp(TrainingBatchSpec, store, transport)
    override val cancellation = MoneyOp(TrainingCancelSpec, store, transport)
    override val finish = MoneyOp(TrainingFinishSpec, store, transport)
    override val research = MoneyOp(ResearchSpec, store, transport)
    override val heroUpgrade = MoneyOp(HeroUpgradeSpec, store, transport)
    override val heroRecovery = MoneyOp(HeroRecoverySpec, store, transport)
    override val itemPurchase = MoneyOp(ItemBuySpec, store, transport)
    override val itemUse = MoneyOp(ItemUseSpec, store, transport)
    /** Per-call hook so a test can mutate the published state the way the live repository's hydrate does. */
    var onCall: (String) -> Unit = {}
    private fun record(call: String) { calls += call; failWith?.let { throw it }; onCall(call) }
    override suspend fun refreshArmy() = record("army")
    override suspend fun refreshHeroes() = record("heroes")
    override suspend fun refreshInventory() = record("inventory")
    override suspend fun quote(draft: ArmyTrainingDraft) = record("quote:${draft.composition()}${if (draft.plan) ":plan" else ""}")
    override fun dismissQuote() { _state.value = _state.value.copy(reviewed = null) }
    override suspend fun confirmTraining() = record("confirm")
    /** Holds every cancellation until released, so a test can tap several times before the first POST "returns". */
    var gate: kotlinx.coroutines.CompletableDeferred<Unit>? = null
    override suspend fun cancelQueued(choice: TrainingCancellationChoice) { gate?.await(); record("cancel:${choice.queueId}") }
    override suspend fun finishAll(free: Boolean, displayedCostKeep: String?) = record("finishAll:$free${displayedCostKeep?.let { ":$it" } ?: ""}")
    override suspend fun submitResearch(target: JsonObject) = record("research:${target["action"]}")
    override suspend fun refreshPresets() = record("presets")
    override suspend fun savePreset(slot: Int, name: String, composition: List<gg.pixelkingdomwars.nativeclient.model.TroopCount>) = record("savePreset:$slot:$name:${composition.joinToString(",") { "${it.troop}=${it.count}" }}")
    override suspend fun deletePreset(slot: Int) = record("deletePreset:$slot")
    override suspend fun quotePrevious() = record("previous")
    override suspend fun upgradeHero(hero: String, level: Int, costKeep: String) = record("upgrade:$hero:$level:$costKeep")
    override suspend fun recoverHero(hero: String, costKeep: String, recoveryUntil: String) = record("recover:$hero:$costKeep:$recoveryUntil")
    override suspend fun buyItem(itemId: String) = record("buy:$itemId")
    override suspend fun useItem(itemId: String, jobId: String?) = record("use:$itemId")
    override suspend fun equip(hero: String, slot: String, itemId: String?, expectedVersion: Int) = record("equip:$hero:$slot:$itemId:$expectedVersion")
    override suspend fun markItemSeen(itemId: String) = record("seen:$itemId")
    override fun clearNotice() {}
}

internal class FakeWorldRepository : WorldRepository {
    val _state = MutableStateFlow(WorldState())
    override val state: StateFlow<WorldState> = _state
    val calls = mutableListOf<String>()
    var parcels = mutableMapOf<Int, String>()
    var occupied = setOf<Int>()
    override suspend fun refreshGlobe() { calls += "globe" }
    override suspend fun parcel(tileId: Int): gg.pixelkingdomwars.nativeclient.model.FantasyParcel {
        calls += "parcel:$tileId"
        return gg.pixelkingdomwars.nativeclient.model.FantasyParcel.from(json("""{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":$tileId,"realmId":"frostveil","allocation":"ordinary"},"availability":"${parcels[tileId] ?: "available"}"}"""))
    }
    override suspend fun markers(x0: Int, y0: Int, x1: Int, y1: Int): gg.pixelkingdomwars.nativeclient.model.FantasyViewport {
        calls += "markers:$x0,$y0,$x1,$y1"
        return gg.pixelkingdomwars.nativeclient.model.FantasyViewport.from(json("""{"worldId":"fantasy-v1","markers":[${occupied.joinToString { "{\"tileId\":$it,\"name\":\"A\",\"keepLevel\":1}" }}]}"""))
    }
}

internal class FakeLandRepository : LandRepository {
    val _state = MutableStateFlow(LandCheckoutState())
    override val state: StateFlow<LandCheckoutState> = _state
    val calls = mutableListOf<String>()
    override val reservation = MoneyOp(LandReservationSpec, PendingIntentStore(MemoryStore()), object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = error("unused"); override suspend fun post(path: String, body: JsonObject) = error("unused") })
    override suspend fun open(kind: String) { calls += "open:$kind"; _state.value = _state.value.copy(purchaseKind = kind) }
    override fun draft(tileId: Int?) { calls += "draft:$tileId"; _state.value = _state.value.copy(draftedTile = tileId) }
    override suspend fun reserve(tileId: Int?) { calls += "reserve:$tileId" }
    override suspend fun pay(signer: LandSigner) { calls += "pay" }
    override suspend fun retryPayment(signer: LandSigner) { calls += "retry" }
    override suspend fun refreshEstimate() { calls += "estimate" }
    override fun clearNotice() {}
}

internal class FakeAccountRepository(wallet: String = WALLET) : AccountRepository {
    val _state = MutableStateFlow(AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(wallet, entryPaid = false), selectedBaseId = BASE_ID))
    override val state: StateFlow<AccountState> = _state
    val calls = mutableListOf<String>()
    override suspend fun restore() { calls += "restore" }
    override suspend fun connect(wallet: gg.pixelkingdomwars.nativeclient.wallet.WalletLogin) { calls += "connect" }
    override suspend fun connectWith(attempt: gg.pixelkingdomwars.nativeclient.data.SignInAttempt) { calls += "connectWith" }
    override suspend fun verifyTotp(code: String) { calls += "totp" }
    override suspend fun logout(afterLocalSignOut: suspend () -> Unit) { calls += "logout"; afterLocalSignOut() }
    override suspend fun selectBase(id: String) { calls += "select:$id" }
    override suspend fun activateBase(id: String, replaceBaseId: String?) { calls += "activate:$id:${replaceBaseId ?: "-"}" }
    override suspend fun refreshDirectory() { calls += "directory" }
    override suspend fun refreshIdentity() { calls += "identity" }
    override suspend fun loadSecurity() { calls += "security" }
    override fun discardSession(session: AccountSession, error: gg.pixelkingdomwars.nativeclient.network.ApiException?) { calls += "discard" }
}

internal class FakeBattleRepository : BattleRepository {
    val _state = MutableStateFlow(BattleDomainState())
    override val state: StateFlow<BattleDomainState> = _state
    val calls = mutableListOf<String>()
    var failWith: Exception? = null
    var raidAgainStarted = true
    var entry = EntryRecovery.NONE
    private fun record(call: String) { calls += call; failWith?.let { throw it } }
    override suspend fun refreshCampaign() = record("campaign")
    override suspend fun refreshHistory() = record("history")
    override suspend fun loadOlderDeedBattles() = record("older-deed")
    override suspend fun loadOlderParticipantBattles() = record("older-participant")
    override suspend fun previewStage(stage: Int) = record("preview:$stage")
    override suspend fun scoutTarget(wallet: String, baseId: String?) = record("scout:$wallet:${baseId ?: "-"}")
    override fun closePreview() { _state.value = _state.value.copy(preview = null) }
    override suspend fun campaignBattle(stage: Int) = record("attack:$stage")
    override suspend fun pvpBattle(target: RaidCreateTarget.Pvp) = record("pvp:${target.defenderWallet ?: "-"}:${target.defenderBaseId ?: "-"}:${target.excludeBaseId ?: "-"}")
    override suspend fun retryCreate() = record("retry-create")
    override suspend fun raidAgain(): Boolean { record("again"); return raidAgainStarted }
    override suspend fun nextTarget() = record("next-target")
    override suspend fun retreat() = record("retreat")
    override suspend fun recoverBattle() = record("recover")
    override suspend fun resumePending(raidId: String) = record("resume:$raidId")
    override suspend fun recoverOnEntry(): EntryRecovery { record("entry"); return entry }
    override suspend fun foreground(coordinator: BattleCoordinator) {}
    override suspend fun foreground(spectator: BattleSpectator) {}
    override fun battleAction(action: suspend () -> Unit): Job? = null
    override suspend fun returnHome() = record("home")
    override fun leaveBattleView() { calls += "leave"; _state.value = _state.value.copy(battleVisible = false) }
    override suspend fun watchLive(raidId: String, baseId: String) = record("watch:$raidId:$baseId")
    override fun closeSpectator() { _state.value = _state.value.copy(spectator = null) }
    override suspend fun openReplay(raidId: String) = record("replay:$raidId")
    override suspend fun openReplay(row: BattleRecord) = record("replay:${row.replayPath}")
    override fun closeReplay() {}
    override fun clearNotice() {}
    override fun activationAllowed() = true
}
