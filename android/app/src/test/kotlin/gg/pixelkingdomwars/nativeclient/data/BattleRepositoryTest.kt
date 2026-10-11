package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

/** Return-home hydration order, replay admission and the content activation guard. */
class BattleRepositoryTest {
    private class Fixture(ordersAllowed: Boolean = true,archiveSupported:(Int)->Boolean={it==14}) {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val gameApi = GameApi("https://localhost:18443", SessionCookieJar("https://localhost:18443".toHttpUrl(), MemoryStore()), "battle-test")
        var hydrations = 0
        var hydrateFailure: Exception? = null
        val logs = mutableListOf<String>()
        var expired: ApiException? = null
        val repository = LiveBattleRepository(session, holder, requireNotNull(holder.scopeOf(session)), api, gameApi, PendingBattleStore(MemoryStore()), { BASE_ID }, { 14 },
            { ordersAllowed }, { hydrations++; hydrateFailure?.let { throw it } }, { expired = it }, { logs += it },archivedSimSupported=archiveSupported)
    }
    private fun replayJson(sim: Int = 14) = json("""{"id":"6b993df1-1af2-41b4-9a65-638428c388a3","simVersion":$sim,"visualContext":{"version":1,"realmId":"sunscar","artVersion":2},"events":[{"t":0,"e":"deploy"}],"snapshot":{}}""")

    @Test fun `supported archived history keeps its original SIM events and authority without any command or simulation`() = runBlocking {
        val catalog=json("""{"archivePresentation":{"version":1,"minimumSimVersion":1,"maximumSimVersion":14,"mode":"currentWebArchive","legacyMelee":{"mode":"sourceIdleAttack","selfDescribingSimVersion":7,"targetAwareSimVersion":5,"positionSnapDistance":1,"aim":{"minimumDeltaSquared":0.25,"retainWithinDegrees":32.5}}}}""")
        val f=Fixture(archiveSupported={archivedReplaySupported(it,14,catalog)})
        val id="6b993df1-1af2-41b4-9a65-638428c388a3"
        for(sim in listOf(1,5,6,7,13,14)) {
            val saved=replayJson(sim)
            f.api.onGet("/battles/participated/$id/replay") {saved}
            f.repository.openReplay(id)
            assertEquals(sim,f.repository.state.value.replay?.simVersion)
            assertEquals(saved,f.repository.state.value.replay?.raw)
            assertFalse(f.repository.activationAllowed());f.repository.closeReplay()
        }
        f.api.onGet("/battles/participated/$id/replay") {replayJson(0)}
        assertThrows(IllegalArgumentException::class.java) {runBlocking {f.repository.openReplay(id)}}
        assertTrue("An archive read must never create, finish, retry, or otherwise write a raid",f.api.posts.isEmpty())
    }

    @Test fun `a stronghold preview is read for the selected base, pinned to its stage and closes before activation`() = runBlocking<Unit> {
        val f = Fixture()
        f.api.onGet("/campaign") { json("""{"baseId":"$BASE_ID","stages":[{"stage":1,"name":"DRIFTWOOD CAMP","keepLevel":1,"unlocked":true,"bestStars":3}]}""") }
        f.repository.refreshCampaign()
        f.api.onGet("/campaign/1/preview") { query -> assertEquals(BASE_ID, query["baseId"]); json("""{"stage":1,"snapshot":{"keepLevel":1,"buildings":[]},"visualContext":{"version":1,"realmId":"crownlands","artVersion":2}}""") }
        f.repository.previewStage(1)
        val preview = requireNotNull(f.repository.state.value.preview) as CampaignPreview
        assertEquals(1, preview.stage); assertEquals("DRIFTWOOD CAMP", preview.name); assertEquals("crownlands", preview.head.visualContext!!.realmId)
        assertTrue(f.logs.last().contains("preview stage 1")); assertFalse("A read-only preview still blocks content activation", f.repository.activationAllowed())
        f.api.onGet("/campaign/1/preview") { json("""{"stage":2,"snapshot":{"keepLevel":1},"visualContext":{"version":1,"realmId":"crownlands","artVersion":2}}""") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.previewStage(1) } }
        f.api.onGet("/campaign/1/preview") { json("""{"stage":1,"snapshot":{"keepLevel":4},"visualContext":{"version":1,"realmId":"crownlands","artVersion":2}}""") }
        assertThrows("The snapshot must be the board's keep level", IllegalArgumentException::class.java) { runBlocking { f.repository.previewStage(1) } }
        f.repository.closePreview(); assertNull(f.repository.state.value.preview); assertTrue(f.repository.activationAllowed())
    }
    @Test fun `campaign attack is refused while the server has retired this build`() = runBlocking {
        val f = Fixture(ordersAllowed = false)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.campaignBattle(1) } }
        assertFalse(f.repository.state.value.battleVisible); assertTrue(f.api.gets.isEmpty() && f.api.posts.isEmpty())
    }
    // Rewritten 2026-09-18 (0.5.4). The old rule — "a failed Home read NEVER retires the battle view" — trapped a tester
    // on "Entering battle…": the server answered a transient 503 DEED_AUTHORITY_UNAVAILABLE to his march AND to the Home
    // read behind BACK TO BASE, and every relaunch reopened the same screen. The rule that matters is narrower: a march
    // the SERVER ACKNOWLEDGED (it holds a raid id: loot, energy and troops may have changed) still needs the read first.
    @Test fun `returning home from an acknowledged raid hydrates first and keeps the battle visible when the read fails`() = runBlocking {
        val f = PvpFixture(); f.onHydrate = { throw IOException("Read failed") }
        f.battleStore.put(PendingBattle(WALLET, BASE_ID, raidId = raidId, target = PendingRaidTarget(defenderBaseId = other)))
        f.repository.recoverBattle()
        assertTrue(f.repository.state.value.battleVisible)
        assertThrows(IOException::class.java) { runBlocking { f.repository.returnHome() } }
        assertTrue("A failed Home read never retires an acknowledged raid's battle view", f.repository.state.value.battleVisible)
        assertNotNull(f.battleStore.get(WALLET, BASE_ID))
    }
    @Test fun `a march the server never acknowledged cannot trap the player when the Home read fails`() = runBlocking {
        val f = Fixture(); f.hydrateFailure = IOException("deed ownership unavailable or changed")
        f.repository.recoverBattle()
        assertTrue(f.repository.state.value.battleVisible)
        f.repository.returnHome()
        assertFalse("BACK TO BASE works with no acknowledged raid even when Home cannot be read", f.repository.state.value.battleVisible); assertEquals(1, f.hydrations)
        f.hydrateFailure = null; f.repository.recoverBattle(); f.repository.returnHome()
        assertFalse(f.repository.state.value.battleVisible); assertEquals(2, f.hydrations)
    }
    @Test fun `replays are admitted only for the loaded SIM and their visual context is carried and logged`() = runBlocking<Unit> {
        val f = Fixture()
        f.api.onGet("/battles/participated/6b993df1-1af2-41b4-9a65-638428c388a3/replay") { replayJson() }
        f.repository.openReplay("6b993df1-1af2-41b4-9a65-638428c388a3")
        val replay = requireNotNull(f.repository.state.value.replay)
        assertEquals("sunscar", replay.visualContext!!.realmId); assertEquals(14, replay.simVersion)
        assertTrue(f.logs.single().contains("realm=sunscar"))
        assertFalse("A visible replay blocks content activation", f.repository.activationAllowed())
        f.repository.closeReplay(); assertTrue(f.repository.activationAllowed())
        f.api.onGet("/battles/participated/6b993df1-1af2-41b4-9a65-638428c388a3/replay") { replayJson(sim = 13) }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.openReplay("6b993df1-1af2-41b4-9a65-638428c388a3") } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.openReplay("not-a-raid") } }
    }
    @Test fun `campaign and history decode typed models and errors surface without losing state`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/campaign") { json("""{"baseId":"$BASE_ID","stages":[{"stage":1,"name":"DRIFTWOOD CAMP","bestStars":3,"unlocked":true}]}""") }
        f.api.onGet("/battles/participated") { json("""{"battles":[{"raidId":"6b993df1-1af2-41b4-9a65-638428c388a3","mode":"campaign","result":"defeat"}],"nextCursor":null}""") }
        f.api.onGet("/raids/pending") { json("""{"raids":[]}""") }
        f.repository.refreshCampaign(); f.repository.refreshHistory()
        assertEquals("DRIFTWOOD CAMP", f.repository.state.value.campaign!!.stages.single().name)
        // Without base-scoped reads (web `stable` false) only the wallet's participation is read, as prior-participant rows.
        assertEquals("defeat", f.repository.state.value.history.participant.single().result)
        assertEquals("participant", f.repository.state.value.history.participant.single().replayAccess); assertNull(f.repository.state.value.history.error)
        f.api.onGet("/campaign") { throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.refreshCampaign() } }
        assertEquals("offline", f.repository.state.value.error); assertNotNull(f.repository.state.value.campaign)
    }

    // --- PvP (web RaidChooser / RaidUI / raidNoTargets / raidlog) -----------------------------------------------------

    private class PvpFixture(stable: Boolean = true) {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val gameApi = GameApi("https://localhost:18443", SessionCookieJar("https://localhost:18443".toHttpUrl(), MemoryStore()), "battle-test")
        var hydrations = 0
        var selectedBase = BASE_ID
        var onHydrate: () -> Unit = {}
        var presentation: (String) -> kotlinx.coroutines.flow.Flow<JsonObject> = { kotlinx.coroutines.flow.emptyFlow() }
        val battleStore = PendingBattleStore(MemoryStore())
        val repository = LiveBattleRepository(session, holder, requireNotNull(holder.scopeOf(session)), api, gameApi, battleStore, { selectedBase }, { 14 },
            { true }, { hydrations++; onHydrate() }, {}, {}, stableSelector = { stable }, campaignStages = { 2 }, scoutPreviewSec = { 30 }, now = { 1_000L },
            // The coordinator's own reads and the create POST go through the same scripted transport as the repository.
            coordinatorFactory = { base, sim -> BattleCoordinator.withTransport(WALLET, base, sim, battleStore, { path, query -> api.get(path, query) }, { path, body -> api.post(path, body) }) { raid -> presentation(raid) } },
            spectatorFactory = { raid, sim -> BattleSpectator.withTransport(raid, sim) { kotlinx.coroutines.flow.emptyFlow() } })
        init {
            api.onGet("/native/capabilities") { json("""{"simVersion":14,"presentation":{"enabled":true}}""") }
            api.onGet("/raids/pending") { json("""{"raids":[]}""") }
        }
    }
    private val raidId = "6b993df1-1af2-41b4-9a65-638428c388a3"
    private val other = "c0ffee00-1af2-41b4-9a65-638428c388a3"

    @Test fun `campaign preflight DNS exposes safe recovery and back works offline without reserving a raid`() = runBlocking {
        val f = PvpFixture()
        f.api.onGet("/native/capabilities") { throw java.net.UnknownHostException("Unable to resolve host play.pixelkingdomwars.com") }
        f.onHydrate = { throw IOException("Home offline") }
        f.repository.campaignBattle(1)
        kotlinx.coroutines.withTimeout(3000) { f.repository.state.first { it.error != null } }
        val coordinator = requireNotNull(f.repository.state.value.coordinator)
        assertFalse(coordinator.state.value.creating)
        assertEquals("Can't connect to the game. Check your connection and try again.", f.repository.state.value.error)
        assertNull(f.battleStore.get(WALLET, BASE_ID)); assertTrue(f.api.posts.isEmpty())
        f.repository.returnHome()
        assertFalse(f.repository.state.value.battleVisible)
        f.api.onGet("/native/capabilities") { json("""{"simVersion":14,"presentation":{"enabled":true}}""") }
        f.api.onPost("/campaign/1/raid") { json("""{"raid":{"id":"$raidId","attackerBaseId":"$BASE_ID","simVersion":14,"raidProtocolVersion":2}}""") }
        f.repository.retryCreate()
        kotlinx.coroutines.withTimeout(3000) { coordinator.state.first { it.pending?.raidId != null && !it.creating } }
        assertEquals(1, f.api.posts.size)
        assertEquals(raidId, f.battleStore.get(WALLET, BASE_ID)?.raidId)
    }

    @Test fun `leaving an unread acknowledged battle is navigation only and reopening retains its exact journal`() = runBlocking {
        val f = PvpFixture()
        val original = PendingBattle(WALLET, BASE_ID, raidId = raidId, stage = 1)
        f.battleStore.put(original)
        f.repository.recoverBattle()
        val coordinator = f.repository.state.value.coordinator
        f.repository.leaveBattleView()
        assertFalse(f.repository.state.value.battleVisible)
        assertEquals(original, f.battleStore.get(WALLET, BASE_ID))
        assertEquals(0, f.hydrations); assertTrue(f.api.posts.isEmpty())
        f.repository.recoverBattle()
        assertTrue(f.repository.state.value.battleVisible)
        assertSame(coordinator, f.repository.state.value.coordinator)
        assertEquals(original, f.battleStore.get(WALLET, BASE_ID))
    }

    private fun scoutJson() = json("""{"name":"Kane","keepLevel":5,"trophies":900,"previewSec":30,"buildings":[],"obstacles":[]}""")
    @Test fun `explicit scout attack creates only the frozen player target and a rejection remains visible`() = runBlocking {
        val f = PvpFixture(); f.api.onGet("/map/scout/$other") { scoutJson() }
        f.api.onPost("/raids") { throw ApiException(422, "INSUFFICIENT_SHARDS", "Not enough shards") }
        f.repository.scoutTarget(WALLET, other)
        assertTrue(f.api.posts.isEmpty())
        val preview = requireNotNull(f.repository.state.value.preview)
        f.repository.attackPreview(preview)
        kotlinx.coroutines.withTimeout(5_000) { f.repository.state.first { it.createFailure != null } }
        assertNull(f.repository.state.value.preview); assertTrue(f.repository.state.value.battleVisible)
        assertEquals(WALLET, f.api.posts.single().second.string("defenderWallet"))
        assertEquals(other, f.api.posts.single().second.string("defenderBaseId"))
        assertEquals(BASE_ID, f.api.posts.single().second.string("attackerBaseId"))
        assertEquals("Not enough shards", f.repository.state.value.createFailure?.message)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.attackPreview(preview) } }
        assertEquals(1, f.api.posts.size)
    }
    @Test fun `closed replaced blocked and changed-base scouts cannot create a raid`() = runBlocking {
        val f = PvpFixture(); f.api.onGet("/map/scout/$other") { scoutJson() }
        f.repository.scoutTarget(WALLET, other, "Shield active")
        val blocked = requireNotNull(f.repository.state.value.preview)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.attackPreview(blocked) } }
        f.repository.scoutTarget(WALLET, other)
        val old = requireNotNull(f.repository.state.value.preview)
        f.repository.scoutTarget(WALLET, other)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.attackPreview(old) } }
        val current = requireNotNull(f.repository.state.value.preview)
        f.selectedBase = other
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.attackPreview(current) } }
        f.selectedBase = BASE_ID; f.repository.closePreview()
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.attackPreview(current) } }
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `close during a scout read prevents its late response from reopening the preview`() = runBlocking {
        val f = PvpFixture(); f.api.onGet("/map/scout/$other") { f.repository.closePreview(); scoutJson() }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.scoutTarget(WALLET, other) } }
        assertNull(f.repository.state.value.preview); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `campaign scout attack keeps its displayed stage and cannot become automatic PvP`() = runBlocking {
        val f = PvpFixture()
        f.api.onGet("/campaign/2/preview") { json("""{"stage":2,"snapshot":{"keepLevel":1,"buildings":[]}}""") }
        f.api.onPost("/campaign/2/raid") { throw ApiException(422, null, "Campaign is locked") }
        f.repository.previewStage(2); f.repository.attackPreview(requireNotNull(f.repository.state.value.preview))
        kotlinx.coroutines.withTimeout(5_000) { f.repository.state.first { it.createFailure != null } }
        assertEquals("/campaign/2/raid", f.api.posts.single().first)
        assertEquals(RaidCreateTarget.Campaign(2), f.repository.state.value.lastTarget)
    }

    @Test fun `late campaign history scout and replay replies cannot populate a newly selected deed`() = runBlocking {
        val f = PvpFixture()
        val responses = listOf(
            "/campaign" to json("""{"baseId":"$BASE_ID","stages":[]}"""),
            "/bases/$BASE_ID/battles" to json("""{"battles":[]}"""),
            "/map/scout/$other" to json("""{"wallet":"w","name":"Kane","keepLevel":5,"trophies":900,"previewSec":30,"buildings":[],"obstacles":[],"claimMin":8,"claimMax":22}"""),
            "/battles/participated/$raidId/replay" to replayJson(),
        )
        f.api.onGet("/battles/participated") { json("""{"battles":[]}""") }
        val actions: List<suspend () -> Unit> = listOf(
            { f.repository.refreshCampaign() }, { f.repository.refreshHistory() },
            { f.repository.scoutTarget("w", other) }, { f.repository.openReplay(raidId) },
        )
        for ((index, response) in responses.withIndex()) {
            f.selectedBase = BASE_ID
            f.api.onGet(response.first) { f.selectedBase = other; response.second }
            assertThrows("${response.first} must stay bound to the deed that requested it", IllegalStateException::class.java) { runBlocking { actions[index]() } }
        }
        assertNull(f.repository.state.value.campaign)
        assertNull(f.repository.state.value.history.baseId)
        assertNull(f.repository.state.value.preview)
        assertNull(f.repository.state.value.replay)
    }
    @Test fun `switching deed during entry recovery does not resume the old deed's pending march`() = runBlocking {
        val f = PvpFixture()
        f.api.onGet("/raids/pending") {
            f.selectedBase = other
            json("""{"raids":[{"id":"$raidId","attackerBaseId":"$BASE_ID","simVersion":14,"ordersDeadlineAt":"2026-09-11T00:00:30Z"}]}""")
        }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.recoverOnEntry() } }
        assertFalse(f.repository.state.value.battleVisible)
        assertNull(f.battleStore.get(WALLET, BASE_ID))
        assertEquals("A late list cannot trigger a follow-up for the former deed", listOf("/raids/pending"), f.api.gets.map { it.first })
    }
    @Test fun `home hydration cannot retire a march after the selected deed changes`() = runBlocking {
        val f = PvpFixture()
        f.battleStore.put(PendingBattle(WALLET, BASE_ID, raidId = raidId, target = PendingRaidTarget(defenderBaseId = other)))
        f.repository.recoverBattle()
        f.onHydrate = { f.selectedBase = other }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.returnHome() } }
        assertTrue(f.repository.state.value.battleVisible)
        assertNotNull("Original-deed hydration is required before its durable march may be retired", f.battleStore.get(WALLET, BASE_ID))
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `process death restores the march target used by the result's next-stage or next-raid action`() = runBlocking {
        val campaign = PvpFixture()
        campaign.battleStore.put(PendingBattle(WALLET, BASE_ID, raidId = raidId, stage = 2))
        campaign.repository.recoverBattle()
        assertEquals(RaidCreateTarget.Campaign(2), campaign.repository.state.value.lastTarget)
        val pvp = PvpFixture()
        pvp.battleStore.put(PendingBattle(WALLET, BASE_ID, raidId = raidId, target = PendingRaidTarget(defenderWallet = WALLET, defenderBaseId = other, name = "Kane")))
        pvp.repository.recoverBattle()
        assertEquals(RaidCreateTarget.Pvp(defenderWallet = WALLET, defenderBaseId = other, name = "Kane"), pvp.repository.state.value.lastTarget)
        assertTrue("Restoring a result action's context never issues a new attack", campaign.api.posts.isEmpty() && pvp.api.posts.isEmpty())
    }

    @Test fun `an auto-match refusal before any march keeps the exact cause for the production panels`() = runBlocking {
        val f = PvpFixture()
        val cases = listOf(
            Triple(404, "no_targets", "no deeded base at KEEP ≥ 3") to "ladder",
            Triple(404, "no_targets_deedless", "no other settlers") to "deedless",
            Triple(404, null, "No other settlers at KEEP ≥ 1 to raid right now") to "deedless",
            Triple(404, "no_other_targets", "No other target available") to null,
            Triple(422, null, "out of raid energy — buy more with SOL or wait for tomorrow") to null,
        )
        for ((refusal, pool) in cases) {
            val (status, code, message) = refusal
            f.api.postHandlers.clear()
            f.api.onPost("/raids") { throw ApiException(status, code, message) }
            val target = if (code == "no_other_targets") RaidCreateTarget.Pvp(excludeBaseId = other) else RaidCreateTarget.Pvp()
            f.repository.pvpBattle(target)
            // Coordinator completion precedes the repository's catch: wait for the panel's actual state.
            val failure = requireNotNull(kotlinx.coroutines.withTimeout(5_000) {
                f.repository.state.first { it.createFailure != null }.createFailure
            }) { "$refusal" }
            requireNotNull(f.repository.state.value.coordinator).state.first { !it.creating }
            assertEquals(message, pool, failure.pool); assertEquals(message, failure.message)
            assertEquals("TRY AGAIN only for a NEXT TARGET re-roll that found nobody else", code == "no_other_targets", failure.retryable)
            assertEquals(status == 422, failure.outOfEnergy)
            assertTrue("The battle view stays up to show the refusal", f.repository.state.value.battleVisible)
            assertNull("A definitive refusal on the first attempt retires the key: nothing was charged", f.battleStore.get(WALLET, BASE_ID))
            assertEquals("Each refusal retains only its own target for an explicit retry", target, f.repository.state.value.lastTarget)
            assertEquals(target.excludeBaseId, f.api.posts.last().second.string("excludeBaseId"))
            assertNull("Auto-match leaves defender selection to the server", f.api.posts.last().second.string("defenderBaseId"))
            f.repository.returnHome()
            assertNull(f.repository.state.value.createFailure); assertFalse(f.repository.state.value.battleVisible)
        }
        assertTrue(f.api.posts.all { it.first == "/raids" && it.second.string("attackerBaseId") == BASE_ID && it.second.string("raidProtocolVersion") == "2" })
    }
    @Test fun `explicit retry preserves the next-target exclusion with a fresh key and ordinary matchmaking clears it`() = runBlocking {
        val f = PvpFixture()
        f.api.onPost("/raids") { throw ApiException(404, "no_other_targets", "No other target available") }
        suspend fun awaitRefusal() {
            f.repository.state.first { it.createFailure != null }
            requireNotNull(f.repository.state.value.coordinator).state.first { !it.creating }
            assertNull("A definitive first-attempt refusal leaves no uncertain charged intent", f.battleStore.get(WALLET, BASE_ID))
        }
        f.repository.pvpBattle(RaidCreateTarget.Pvp(excludeBaseId = other))
        awaitRefusal()
        f.repository.retryCreate()
        awaitRefusal()
        assertEquals(2, f.api.posts.size)
        for ((_, request) in f.api.posts) {
            assertEquals(other, request.string("excludeBaseId"))
            assertNull("A retry remains an auto-match, never a targeted attack", request.string("defenderBaseId"))
        }
        val keys = f.api.posts.map { requireNotNull(it.second.string("idempotencyKey")) }
        assertNotEquals("The server definitively refused the old request; retry is a new match attempt", keys[0], keys[1])
        f.repository.returnHome()
        f.repository.pvpBattle(RaidCreateTarget.Pvp())
        awaitRefusal()
        assertNull("A deliberate ordinary match must not exclude the prior target", f.api.posts.last().second.string("excludeBaseId"))
        assertEquals(RaidCreateTarget.Pvp(), f.repository.state.value.lastTarget)
    }
    /** D153.333 (b): BACK TO BASE from an unconfirmed create reaches Home and stays there, but the saved key is not forgotten
     * (the server may have committed it). ATTACK must therefore reopen that request's recovery, never persist and charge a
     * second key for the same player. */
    @Test fun `ATTACK with an unconfirmed create reopens its recovery instead of charging a new key`() = runBlocking {
        val f = PvpFixture()
        f.api.onPost("/raids") { throw IOException("connection reset") }
        f.repository.pvpBattle(RaidCreateTarget.Pvp())
        kotlinx.coroutines.withTimeout(5_000) { f.repository.state.first { it.error != null } }
        val coordinator = requireNotNull(f.repository.state.value.coordinator)
        kotlinx.coroutines.withTimeout(5_000) { coordinator.state.first { !it.creating } }
        val saved = requireNotNull(f.battleStore.get(WALLET, BASE_ID)?.create)
        f.repository.returnHome()
        assertFalse(f.repository.state.value.battleVisible)
        f.repository.pvpBattle(RaidCreateTarget.Pvp())
        kotlinx.coroutines.withTimeout(5_000) { f.repository.state.first { it.error?.contains("Recover the existing march") == true } }
        assertTrue("The recovery overlay reopens for the saved request", f.repository.state.value.battleVisible)
        assertEquals("No second key is persisted while the first is unconfirmed", saved, f.battleStore.get(WALLET, BASE_ID)?.create)
        assertEquals("Nothing new is sent", 1, f.api.posts.size)
    }
    @Test fun `next raid after a settled revenge or reroll is a fresh automatic match`() = runBlocking {
        for (target in listOf(RaidCreateTarget.Pvp(defenderWallet = WALLET, defenderBaseId = other), RaidCreateTarget.Pvp(excludeBaseId = other))) {
            val f = PvpFixture()
            f.api.onPost("/raids") { json("""{"raid":{"id":"$raidId","attackerBaseId":"$BASE_ID","defenderBaseId":"$other","simVersion":14,"raidProtocolVersion":2}}""") }
            f.presentation = { id -> kotlinx.coroutines.flow.flowOf(json("""{"raidId":"$id","simVersion":14,"source":"archive","status":"resolved","commands":[],"_clientFirstPageReceivedAtNanos":1,"result":{"stars":1}}""")) }
            f.repository.pvpBattle(target)
            val coordinator = requireNotNull(f.repository.state.value.coordinator)
            kotlinx.coroutines.withTimeout(5_000) { coordinator.state.first { it.pending?.raidId != null && !it.creating } }
            f.repository.foreground(coordinator)
            assertTrue("Only the server's settled verdict enables NEXT RAID", coordinator.state.value.terminal)
            val originalKey = f.api.posts.single().second.string("idempotencyKey")
            assertTrue(f.repository.raidAgain())
            kotlinx.coroutines.withTimeout(5_000) { coordinator.state.first { it.pending?.raidId != null && !it.creating } }
            val next = f.api.posts.last().second
            assertEquals(2, f.api.posts.size)
            assertNull("A victory must not attack the former revenge target again", next.string("defenderWallet"))
            assertNull(next.string("defenderBaseId"))
            assertNull("NEXT RAID also drops the former reroll exclusion", next.string("excludeBaseId"))
            assertNotEquals("A deliberate new match never reuses the settled request", originalKey, next.string("idempotencyKey"))
            assertEquals(RaidCreateTarget.Pvp(), f.repository.state.value.lastTarget)
        }
    }

    @Test fun `next target is refused until the march is staged and untouched and retreat copy names whether it was sent`() = runBlocking {
        val f = PvpFixture()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.nextTarget() } }
        f.battleStore.put(PendingBattle(WALLET, BASE_ID, raidId = raidId, target = PendingRaidTarget(defenderBaseId = other)))
        f.repository.recoverBattle()
        val error = assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.nextTarget() } }
        assertEquals("Not connected yet: nothing may be committed", LiveBattleRepository.NEXT_TARGET_UNAVAILABLE, error.message)
        assertFalse(f.repository.state.value.nextTargetIntent)
    }
    @Test fun `history merges the deed record the prior participation and the unfinished marches of the selected deed`() = runBlocking {
        val f = PvpFixture()
        f.api.onGet("/bases/$BASE_ID/battles") { query -> if (query["cursor"] == "older") json("""{"battles":[{"raidId":"$other","baseId":"$BASE_ID","role":"attacker","mode":"pvp","result":"victory","stars":3,"destructionPct":100}],"nextCursor":null}""")
            else json("""{"battles":[{"raidId":"$raidId","baseId":"$BASE_ID","role":"defender","mode":"pvp","result":"defeat","stars":1,"destructionPct":55,"opponent":{"baseId":"$other","wallet":"w","name":"Kane","seeker":false}}],"nextCursor":"older"}""") }
        f.api.onGet("/battles/participated") { json("""{"battles":[{"raidId":"$raidId","baseId":"$BASE_ID","role":"defender","mode":"pvp","result":"defeat","stars":1,"destructionPct":55},{"raidId":"$other","baseId":"sold-deed","role":"attacker","mode":"pvp","result":"victory","stars":2,"destructionPct":70,"lootRedacted":true}],"nextCursor":null}""") }
        f.api.onGet("/raids/pending") { json("""{"raids":[{"id":"$raidId","attackerBaseId":"$BASE_ID","simVersion":14},{"id":"$other","attackerBaseId":"another-deed","simVersion":14}]}""") }
        f.repository.refreshHistory()
        val history = f.repository.state.value.history
        assertTrue(history.stable && history.deedSelected); assertNull(history.error)
        assertEquals(listOf("deed"), history.deed.map { it.replayAccess }); assertEquals("/bases/$BASE_ID/battles/$raidId/replay", history.deed.single().replayPath)
        assertEquals("Selected-deed rows are not repeated under prior participation", listOf("sold-deed"), history.participant.map { it.baseId })
        assertEquals("/battles/participated/$other/replay", history.participant.single().replayPath)
        assertEquals("Only the selected deed's marches are continuable here", listOf(raidId), history.pending.map { it.id })
        f.repository.loadOlderDeedBattles()
        assertEquals(2, f.repository.state.value.history.deed.size); assertNull(f.repository.state.value.history.deedCursor)
        f.api.onGet("/bases/$BASE_ID/battles") { throw IOException("deed history down") }
        f.repository.refreshHistory()
        assertEquals("One failed source is named; the others still load", "deed history down", f.repository.state.value.history.error)
        assertEquals(1, f.repository.state.value.history.participant.size)
    }
    @Test fun `replays open through the authority the row was listed under and a scouted player needs the server's window`() = runBlocking<Unit> {
        val f = PvpFixture()
        val replay = json("""{"id":"$raidId","simVersion":14,"events":[{"t":0,"e":"deploy"}],"snapshot":{}}""")
        f.api.onGet("/bases/$BASE_ID/battles/$raidId/replay") { replay }
        f.repository.openReplay(BattleRecord(raidId, BASE_ID, replayAccess = "deed"))
        assertEquals("/bases/$BASE_ID/battles/$raidId/replay", f.api.gets.last().first)
        f.api.onGet("/battles/participated/$raidId/replay") { replay }
        f.repository.openReplay(BattleRecord(raidId, "sold-deed", replayAccess = "participant"))
        assertEquals("/battles/participated/$raidId/replay", f.api.gets.last().first)
        f.api.onGet("/map/scout/$other") { query -> assertEquals(BASE_ID, query["baseId"]); json("""{"wallet":"w","name":"Kane","keepLevel":5,"trophies":900,"previewSec":30,"buildings":[],"obstacles":[],"claimMin":8,"claimMax":22}""") }
        f.repository.scoutTarget("w", other)
        val scout = f.repository.state.value.preview as TargetScout
        assertEquals("Kane", scout.title); assertEquals(5, scout.keepLevel); assertEquals(30, scout.previewSec); assertEquals("900", scout.report.trophies)
        assertFalse("A scout blocks content activation like any preview", f.repository.activationAllowed())
        f.api.onGet("/map/scout/$other") { json("""{"wallet":"w","name":"Kane","keepLevel":5,"trophies":900}""") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.scoutTarget("w", other) } }
    }
    @Test fun `a wallet scout keeps its base58 route while unsafe target paths never reach the server`() = runBlocking {
        val f = PvpFixture()
        f.api.onGet("/map/scout/$WALLET") { query ->
            assertEquals(BASE_ID, query["baseId"])
            json("""{"wallet":"$WALLET","name":"Kane","keepLevel":5,"trophies":900,"previewSec":30,"buildings":[],"obstacles":[],"claimMin":8,"claimMax":22}""")
        }
        f.repository.scoutTarget(WALLET, null)
        assertEquals("A legacy wallet is a valid scout identifier, not a UUID", "/map/scout/$WALLET", f.api.gets.single().first)
        val preview = f.repository.state.value.preview
        val invalidTargets = listOf(
            "" to other, "w" to null, "$WALLET/extra" to null, "$WALLET?baseId=$BASE_ID" to null,
            "0".repeat(32) to null, "1".repeat(45) to null, WALLET to "$other/extra", WALLET to "-".repeat(36),
            WALLET to WALLET, WALLET to "../$other",
        )
        for ((wallet, baseId) in invalidTargets) {
            assertThrows("Invalid scout identifier $wallet / $baseId", IllegalArgumentException::class.java) {
                runBlocking { f.repository.scoutTarget(wallet, baseId) }
            }
        }
        assertEquals("Malformed navigation data cannot issue another scout request", 1, f.api.gets.size)
        assertSame("A rejected identifier cannot replace the current preview", preview, f.repository.state.value.preview)
    }
    @Test fun `entering home resumes a single current pending march and sends several to the history`() = runBlocking {
        val f = PvpFixture()
        val row = """{"id":"%s","attackerBaseId":"$BASE_ID","defenderWallet":"w","defenderBaseId":"$other","simVersion":14,"raidProtocolVersion":2,"ordersDeadlineAt":"2026-09-11T00:00:30Z"}"""
        f.api.onGet("/raids/pending") { json("""{"raids":[${row.format(raidId)},{"id":"$other","attackerBaseId":"$BASE_ID","simVersion":13,"ordersDeadlineAt":"2026-09-11T00:00:30Z"},{"id":"11111111-1111-4111-8111-111111111111","attackerBaseId":"other-deed","simVersion":14,"ordersDeadlineAt":"2026-09-11T00:00:30Z"}]}""") }
        f.api.onGet("/raids/pending/$raidId") { json("""{"raid":${row.format(raidId)}}""") }
        assertEquals("Another SIM or another deed never counts", EntryRecovery.BATTLE, f.repository.recoverOnEntry())
        assertTrue(f.repository.state.value.battleVisible); assertEquals(other, f.battleStore.get(WALLET, BASE_ID)!!.pvpDefenderBaseId)
        val g = PvpFixture()
        g.api.onGet("/raids/pending") { json("""{"raids":[${row.format(raidId)},${row.format(other)}]}""") }
        assertEquals(EntryRecovery.HISTORY, g.repository.recoverOnEntry()); assertFalse(g.repository.state.value.battleVisible)
        val h = PvpFixture()
        h.api.onGet("/raids/pending") { json("""{"raids":[]}""") }
        assertEquals(EntryRecovery.NONE, h.repository.recoverOnEntry())
    }
    @Test fun `authority loss leaves the battle view without finishing and a live watch is a read-only participant`() = runBlocking<Unit> {
        val f = PvpFixture()
        f.battleStore.put(PendingBattle(WALLET, BASE_ID, raidId = raidId, target = PendingRaidTarget(defenderBaseId = other)))
        f.repository.recoverBattle()
        assertTrue(f.repository.state.value.battleVisible)
        f.repository.leaveBattleView()
        assertFalse(f.repository.state.value.battleVisible); assertNotNull("The saved march stays for later reconciliation", f.battleStore.get(WALLET, BASE_ID))
        assertTrue(f.api.posts.isEmpty())
        f.repository.watchLive(raidId, BASE_ID)
        assertEquals(raidId, f.repository.state.value.spectator!!.spectator.raidId); assertFalse(f.repository.activationAllowed())
        f.repository.closeSpectator(); assertNull(f.repository.state.value.spectator)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.watchLive("not-a-raid", BASE_ID) } }
    }
    @Test fun `a battle order that meets a revoked session reports expiry to the account`() = runBlocking {
        val f = Fixture()
        f.repository.recoverBattle()
        requireNotNull(f.repository.battleAction { throw ApiException(401, "SESSION_EXPIRED", "Expired") }).join()
        assertEquals(401, f.expired!!.status)
        kotlinx.coroutines.withContext(Dispatchers.Default) { }
        assertEquals("Expired", f.repository.state.value.error)
    }
    /** Owner 2026-09-18: deploying fast must put no text on the battle screen. A refused or interrupted deploy answers
     * on the field (its marker leaves, the counter returns), so it must neither write the error line nor clear one a
     * start/finish/speed order left there: either would add or remove a HUD row per tap. */
    @Test fun `a deploy order neither writes nor clears the battle error line while other orders still do`() = runBlocking {
        val f = Fixture()
        f.repository.recoverBattle()
        requireNotNull(f.repository.deployAction { throw ApiException(422, null, "deploy outside the deploy zone: (3,4)") }).join()
        assertNull("A refused deploy shows no text", f.repository.state.value.error)
        requireNotNull(f.repository.battleAction { throw ApiException(422, null, "raid clock is stale") }).join()
        assertEquals("raid clock is stale", f.repository.state.value.error)
        requireNotNull(f.repository.deployAction { }).join()
        assertEquals("A successful deploy does not flash the line away either", "raid clock is stale", f.repository.state.value.error)
        requireNotNull(f.repository.battleAction { }).join()
        assertNull("The next ordinary order still clears it", f.repository.state.value.error)
        requireNotNull(f.repository.deployAction { throw ApiException(401, "SESSION_EXPIRED", "Expired") }).join()
        assertEquals("Session expiry is still reported to the account", 401, f.expired!!.status)
    }
    @Test fun `a deploy order on a retired build still says why nothing happens`() = runBlocking {
        val f = Fixture(ordersAllowed = false)
        f.repository.recoverBattle()
        var ran = false
        requireNotNull(f.repository.deployAction { ran = true }).join()
        assertFalse(ran)
        assertEquals("Install the available native update before submitting new battle orders", f.repository.state.value.error)
    }
}
