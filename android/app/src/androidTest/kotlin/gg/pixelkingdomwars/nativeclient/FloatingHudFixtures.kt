package gg.pixelkingdomwars.nativeclient

import androidx.lifecycle.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.ui.battle.BattleViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.Collections

/** No AppGraph, retained account, encrypted store, HTTP client or wallet is constructed. The only
 * accepted transport shape is an explicitly injected synthetic deployment; it records its stable
 * request before replying. This is input/receipt wiring evidence, never server/simulation acceptance. */
internal class FloatingHudFixtures(val content: ContentState, val canonical: JsonObject) {
    companion object {
        const val WALLET = "floating-hud-synthetic-wallet"
        const val BASE = "11111111-1111-4111-8111-111111111111"
        const val RAID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    }
    private class Memory : SecretStore {
        private var value: String? = null
        @Synchronized override fun read() = value
        @Synchronized override fun write(value: String) { this.value = value }
        @Synchronized override fun clear() { value = null }
    }
    private val memory = Memory()
    val store = PendingBattleStore(memory)
    val commands = Collections.synchronizedList(mutableListOf<JsonObject>())
    val attemptedCommands = Collections.synchronizedList(mutableListOf<String>())
    var commandReply: CompletableDeferred<Unit>? = null
    var commandStartsBattle = true
    val errors = Collections.synchronizedList(mutableListOf<String>())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, e -> errors += e.javaClass.simpleName })
    private val models = ViewModelStore()
    var forbiddenCalls = 0
        private set
    var cleared = false
        private set
    private fun forbidden(): Nothing { forbiddenCalls++; error("Floating HUD fixture refuses non-display operations") }
    private val rules = requireNotNull(content.catalogue).getValue("constants").jsonObject
    private val durationMs = rules.getValue("RAID_RULES").jsonObject.getValue("battleDurationSec").jsonPrimitive.long * 1000
    private val stagingNow = Instant.now()
    private fun clock(started: Boolean = false, revision: Int = 0) = buildJsonObject {
        val now = if (started) Instant.now() else stagingNow
        put("protocolVersion", 2); put("revision", revision); put("rate", 1)
        put("anchorWallAt", if (started) JsonPrimitive(now.toString()) else JsonNull)
        put("anchorSimMs", 0); put("serverNow", now.toString()); put("simNowMs", 0)
        put("battleEndsAt", if (started) JsonPrimitive(now.plusMillis(durationMs).toString()) else JsonNull)
        put("durationMs", durationMs)
    }
    val page: JsonObject
    val coordinator: BattleCoordinator
    init {
        // Retain the hash-pinned historical events when the installed content advances.
        // This injected coordinator tests UI/receipt wiring, never new simulation acceptance.
        val fixtureSimVersion = canonical.getValue("simVersion").jsonPrimitive.int
        val army = canonical.getValue("armySnapshot").jsonObject
        page = JsonObject(canonical + mapOf(
            "raidId" to JsonPrimitive(RAID), "revision" to JsonPrimitive("floating-hud-stage100"),
            "raidProtocolVersion" to JsonPrimitive(2), "source" to JsonPrimitive("live"), "status" to JsonPrimitive("pending_orders"),
            "lastSequence" to JsonPrimitive(0), "commands" to JsonArray(emptyList()), "clock" to clock(),
            "_clientFirstPageReceivedAtNanos" to JsonPrimitive(System.nanoTime()),
            "armySnapshot" to JsonObject(army + mapOf("counts" to buildJsonObject { put("dragon", 90) },
                "heroes" to buildJsonArray { add("vex"); add("theodor") },
                "heroLevels" to buildJsonObject { put("vex", 20); put("theodor", 20) }))))
        store.put(PendingBattle(WALLET, BASE, raidId = RAID, stage = 100,
            ordersDeadlineAt = stagingNow.plusMillis(durationMs + 60_000).toString()))
        coordinator = BattleCoordinator.withTransport(WALLET, BASE, fixtureSimVersion, store,
            get = { _, _ -> forbidden() },
            post = { path, body ->
                check(path == "/raids/$RAID/commands") { "Unexpected fixture transport path" }
                val command = requireNotNull(body["command"] as? JsonObject)
                check(command.string("kind") in setOf("deploy", "hero")) { "Unexpected fixture command" }
                val payload = command.getValue("payload").jsonObject
                val x = payload.getValue("tx").jsonPrimitive.int; val y = payload.getValue("ty").jsonPrimitive.int
                val grid = rules.getValue("GRID").jsonObject
                val edge = grid.getValue("claimTiles").jsonPrimitive.int + grid.getValue("deployRingTiles").jsonPrimitive.int * 2
                val snap = canonical.getValue("snapshot").jsonObject
                val lo = snap.getValue("claimMin").jsonPrimitive.int; val hi = snap.getValue("claimMax").jsonPrimitive.int
                check(x in 0 until edge && y in 0 until edge && !(x in lo until hi && y in lo until hi)) { "Fixture tap must use the current SIM14 deploy ring" }
                val id = requireNotNull(body.string("clientCommandId"))
                val pending = requireNotNull(store.get(WALLET, BASE)).writes.single { it.id == id }
                check(pending.attempted && pending.body == body)
                attemptedCommands += id
                // The harness controls response timing after the real coordinator has
                // durably saved its original request. No HTTP transport is constructed.
                commandReply?.await()
                check(commands.none { it.string("clientCommandId") == id }) { "Duplicate synthetic command" }
                val accepted = JsonObject(command + mapOf("clientCommandId" to JsonPrimitive(id), "sequence" to JsonPrimitive(commands.size)))
                commands += accepted
                buildJsonObject { put("command", accepted); put("clock", clock(started = commandStartsBattle, revision = commands.size)) }
            }, presentation = { raid -> check(raid == RAID); flow { emit(page); awaitCancellation() } })
    }
    val contentRepository = object : ContentRepository {
        override val state = MutableStateFlow(content)
        override val mode = LaunchMode.OFFLINE_BATTLE
        override suspend fun initialize() = Unit
        override fun simVersion() = content.simVersion
        override suspend fun checkUpdates(api: ApiClient, force: Boolean) = forbidden()
        override suspend fun applyUpdate(canActivate: () -> Boolean) = forbidden()
        override suspend fun loadPreviewFixtures(): Pair<JsonObject, JsonObject?> = forbidden()
    }
    val repository = object : BattleRepository {
        override val state = MutableStateFlow(BattleDomainState(coordinator = coordinator, battleVisible = true, lastTarget = RaidCreateTarget.Campaign(100)))
        override suspend fun foreground(coordinator: BattleCoordinator) = coordinator.runForeground()
        override suspend fun foreground(spectator: BattleSpectator) = forbidden()
        override fun battleAction(action: suspend () -> Unit): Job = scope.launch { action() }
        override suspend fun refreshCampaign() = forbidden()
        override suspend fun refreshHistory() = forbidden()
        override suspend fun loadOlderDeedBattles() = forbidden()
        override suspend fun loadOlderParticipantBattles() = forbidden()
        override suspend fun previewStage(stage: Int) = forbidden()
        override suspend fun scoutTarget(wallet: String, baseId: String?) = forbidden()
        override fun closePreview() = forbidden()
        override suspend fun campaignBattle(stage: Int) = forbidden()
        override suspend fun pvpBattle(target: RaidCreateTarget.Pvp) = forbidden()
        override suspend fun retryCreate() = forbidden()
        override suspend fun raidAgain(): Boolean = forbidden()
        override suspend fun nextTarget() = forbidden()
        override suspend fun retreat() = forbidden()
        override suspend fun recoverBattle() = forbidden()
        override suspend fun resumePending(raidId: String) = forbidden()
        override suspend fun recoverOnEntry(): EntryRecovery = forbidden()
        override suspend fun returnHome() = forbidden()
        override fun leaveBattleView() = forbidden()
        override suspend fun watchLive(raidId: String, baseId: String) = forbidden()
        override fun closeSpectator() = forbidden()
        override suspend fun openReplay(raidId: String) = forbidden()
        override suspend fun openReplay(row: BattleRecord) = forbidden()
        override fun closeReplay() = forbidden()
        override fun clearNotice() = Unit
        override fun activationAllowed() = false
    }
    fun model(): BattleViewModel = ViewModelProvider(models, object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST") override fun <T : ViewModel> create(modelClass: Class<T>): T = BattleViewModel(repository, contentRepository) as T
    })[BattleViewModel::class.java]
    fun close() { models.clear(); scope.cancel(); memory.clear(); cleared = true }
}
