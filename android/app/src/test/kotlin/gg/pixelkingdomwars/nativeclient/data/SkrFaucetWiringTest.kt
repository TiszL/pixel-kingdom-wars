package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.Base64

/**
 * WHY (owner 2026-10-06: "I should be able to showcase any part of game flawlessly", the in-app TEST SKR faucet
 * included): a test build that carries the pinned devnet test SKR identity must claim the daily test SKR end to end
 * from the phone — reserve, the player's own signature in the wallet app, submit — while every other build, production
 * above all, stays exactly as dark as before. Money rules that must survive the wiring: CLAIM opens only where the
 * server says the faucet is open (or the player's own reserved grant still needs their signature), a lost claim reply is
 * never posted again (its grant is found through GET /devnet-skr-faucet/grants), and no number is invented when the
 * catalogue has no SKR_FAUCET block. Server bodies are the fixture-derived P5 vectors (see their _provenance).
 */
class SkrFaucetWiringTest {
    private fun file(name: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/$name")) { "MISSING: $name" }
        .bufferedReader().use { it.readText() }).jsonObject
    private val api = file("skr-faucet-api-vectors.json")
    private val signed = file("skr-faucet-signed-vector.json")
    private fun vector(name: String) = api.getValue(name).jsonObject
    private val player = signed.getValue("wallet").jsonPrimitive.content
    private val wire = signed.getValue("signedTransaction").jsonPrimitive.content
    private val grant = SkrFaucetGrant.from(vector("claim").getValue("grant").jsonObject)
    private val pin = SkrIdentity(grant.mint, grant.decimals)
    private val base = "11111111-1111-4111-8111-111111111111"
    private companion object { val catalogue = SkrFaucetBounds(5000, "1000", 20) }

    /** The phone: the real repository and flow over scripted routes; the "wallet app" answers with the player's signature. */
    private inner class Phone(val bounds: SkrFaucetBounds? = catalogue) {
        val holder = testHolder(); val session = signedIn(holder, player); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), session.wallet, session.origin, "devnet")
        val prompts = mutableListOf<String>()
        var balanceReads = 0
        val repo = SkrFaucetRepository(session, holder, api, journal, { pin }, { bounds }, { base },
            signer = { prepared, guard, retain ->
                guard(); prompts += Base64.getEncoder().encodeToString(prepared.unsignedTransaction())
                retain(prepared.verifySigned(Base64.getDecoder().decode(wire)))
            }, refreshWallet = { balanceReads++ })
        val flow = SkrFaucetFlow(repo) { bounds }
        /** Status answers in order; the last one repeats. */
        fun statuses(vararg names: String) {
            val queue = ArrayDeque(names.toList())
            api.onGet("/devnet-skr-faucet/status") { vector(if (queue.size > 1) queue.removeFirst() else queue.first()) }
        }
        fun status(reason: String, enabled: Boolean = true) = api.onGet("/devnet-skr-faucet/status") {
            JsonObject(vector("status") + mapOf("reason" to JsonPrimitive(reason), "eligible" to JsonPrimitive(false), "enabled" to JsonPrimitive(enabled)))
        }
    }

    // Rewritten 2026-10-10 (owner: Phase E to production): the faucet used to ride the SKR pin, so pinning the real auction
    // SKR mint on production would have opened a "test SKR" faucet there. The faucet now needs its own pkwSkrFaucet switch.
    @Test fun `a test build with the pinned SKR identity and the faucet switch constructs the faucet repository, any other build stays dark`() = runBlocking {
        val skr = "A68QYUbmEqNQjmumg7ta1m3KezFSVYCsfZLpSNyyUNQ2"
        val economy = "17sCdP3nT1p1AYSA29oczoVMMfzYThJAV7o6FVokvR3"
        val auction = ChainPinValues(cluster = "devnet", economyProgramId = economy, skrMint = skr, skrDecimals = "6")
        val pinned = requireNotNull(ChainPins.parse(auction.copy(skrFaucet = "on"), "devnet") { error("The faucet family derives nothing") })
        assertEquals(SkrIdentity(skr, 6), skrFaucetPin(pinned.chainProfile, SolanaCluster.DEVNET, offline = false))
        // The auction's SKR pin alone (a production build pinned for auctions) is no faucet.
        assertNull(requireNotNull(ChainPins.parse(auction, "devnet") { error("") }).chainProfile)
        // A build without pins has none; a half-set SKR family is no pin; offline previews and mainnet never claim.
        assertNull(ChainPins.parse(ChainPinValues(), "devnet"))
        assertNull(skrFaucetPin(null, SolanaCluster.DEVNET, offline = false))
        assertNull(ChainPins.parse(auction.copy(skrDecimals = "", skrFaucet = "on"), "devnet") { error("") }?.chainProfile)
        assertNull(skrFaucetPin(pinned.chainProfile, SolanaCluster.DEVNET, offline = true))
        assertNull(skrFaucetPin(pinned.chainProfile, SolanaCluster.MAINNET, offline = false))
        // The sheet builds its claim owner (repository + sign-only wallet step) only behind that pin; otherwise it keeps
        // the local states it had before.
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/hub/live/SkrFaucetHost.kt").readText()
        val build = host.substringAfter("private fun rememberSkrFaucetClient(").substringBefore("@Composable private fun SkrFaucetClaimHost(")
        assertTrue(build.contains("val profile = graph.chainPins?.chainProfile"))
        assertTrue(build.contains("if (skrFaucetPin(profile, graph.cluster, graph.mode.offline) == null) null"))
        assertTrue(build.contains("graph.skrFaucetClient(session, profile, graph.skrFaucetSigner(session, wallet),"))
        val ports = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/data/SkrFaucetAppPorts.kt").readText()
        assertTrue(ports.contains("val pin = skrFaucetPin(profile, cluster, mode.offline)"))
        // A repository without a pin is inert: no request of any kind, nothing claimable.
        val f = Phone()
        val dark = SkrFaucetRepository(f.session, f.holder, f.api, f.journal, { null }, { catalogue }, { base }, { _, _, _ -> error("no prompt") }, {})
        dark.refresh(); dark.claim()
        assertTrue(f.api.gets.isEmpty()); assertTrue(f.api.posts.isEmpty()); assertFalse(skrFaucetClaimable(dark.state.value))
    }

    @Test fun `CLAIM is enabled only when the server says ok, or when the player's own reserved grant still needs their signature`() = runBlocking {
        val open = Phone(); open.statuses("status"); open.repo.refresh()
        assertTrue(skrFaucetClaimable(open.repo.state.value))
        // A reserved grant whose wallet step was dismissed or lost: CLAIM continues it (prepare + sign), never reserves again.
        for (name in listOf("statusSignRequired", "statusPending")) {
            val f = Phone(); f.statuses(name); f.repo.refresh()
            assertTrue(name, skrFaucetClaimable(f.repo.state.value)); assertFalse(name, f.repo.state.value.canClaim)
        }
        // Signed and with the faucet, or already claimed today: nothing to press.
        for (name in listOf("statusSubmitted", "statusClaimed")) {
            val f = Phone(); f.statuses(name); f.repo.refresh(); assertFalse(name, skrFaucetClaimable(f.repo.state.value))
        }
        for (reason in listOf("deed_required", "retired_deed", "deed_unavailable", "select_base", "unavailable", "unconfigured", "future_reason")) {
            val f = Phone(); f.status(reason); f.repo.refresh(); assertFalse(reason, skrFaucetClaimable(f.repo.state.value))
        }
        val off = Phone(); off.status("disabled", enabled = false); off.repo.refresh(); assertFalse(skrFaucetClaimable(off.repo.state.value))
        // Even an open faucet is not claimable while an earlier claim's answer is unresolved on this phone.
        val unresolved = Phone(); unresolved.journal.beginIfEmpty(base, "2026-10-06"); unresolved.statuses("status")
        unresolved.api.onGet("/devnet-skr-faucet/grants") { throw IOException("read lost") }
        unresolved.repo.refresh()
        assertTrue(unresolved.repo.state.value.uncertain); assertFalse(skrFaucetClaimable(unresolved.repo.state.value))
        for (f in listOf(open, unresolved)) assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `one CLAIM tap reserves, is signed on the phone and submitted, and the app never sends the transaction itself`() = runBlocking {
        val f = Phone(); f.statuses("status", "status", "statusSignRequired", "statusSubmitted")
        val prepare = vector("prepare")
        val attempt = prepare.getValue("grant").jsonObject.getValue("attempt").jsonObject.getValue("id").jsonPrimitive.content
        f.api.onPost("/devnet-skr-faucet/claim") { body ->
            assertEquals(setOf("baseId"), body.keys); assertNotNull("The intent is saved before the POST", f.journal.read()); vector("claim")
        }
        f.api.onPost("/devnet-skr-faucet/prepare") { body ->
            assertEquals(grant.id, body.getValue("grantId").jsonPrimitive.content); assertTrue("Prepare comes before the wallet", f.prompts.isEmpty()); prepare
        }
        f.api.onPost("/devnet-skr-faucet/submit") { body ->
            assertEquals(attempt, body.getValue("attemptId").jsonPrimitive.content)
            assertEquals(wire, body.getValue("signedTransaction").jsonPrimitive.content)
            assertEquals("The signed bytes are saved before they leave the phone", wire, f.journal.read()!!.signedTransaction)
            vector("submit")
        }
        f.repo.refresh(); assertTrue(skrFaucetClaimable(f.repo.state.value))
        assertNull(f.flow.claim())
        assertEquals(listOf("/devnet-skr-faucet/claim", "/devnet-skr-faucet/prepare", "/devnet-skr-faucet/submit"), f.api.posts.map { it.first })
        // The wallet app was asked once, for exactly the server-prepared bytes the app reviewed.
        assertEquals(listOf(prepare.getValue("unsignedTransaction").jsonPrimitive.content), f.prompts)
        val saved = requireNotNull(f.journal.read())
        assertEquals(wire, saved.signedTransaction); assertTrue(saved.grant!!.attempt!!.phase.isValue("player_signed"))
        assertTrue(f.repo.state.value.status!!.reason.isValue("submitted")); assertFalse(skrFaucetClaimable(f.repo.state.value))
        // A second tap reserves nothing and asks for no second signature.
        assertNotNull(f.flow.claim()); assertEquals(3, f.api.posts.size); assertEquals(1, f.prompts.size)
    }

    @Test fun `a lost claim reply is never posted again - its grant is found through GET grants, then signed and submitted`() = runBlocking {
        val f = Phone(); f.statuses("status", "status", "statusSignRequired", "statusSignRequired", "statusSubmitted")
        f.api.onPost("/devnet-skr-faucet/claim") { throw IOException("reply lost") }
        f.api.onGet("/devnet-skr-faucet/grants") { query -> assertTrue("The proof starts at the head", query.isEmpty()); vector("grantsAfterClaim") }
        f.api.onPost("/devnet-skr-faucet/prepare") { vector("prepare") }
        f.api.onPost("/devnet-skr-faucet/submit") { vector("submit") }
        f.repo.refresh()
        assertNotNull("The player is told the answer was lost", f.flow.claim())
        // The read after the lost reply found the wallet's own grant for the claim day and attached it.
        assertEquals(1, f.api.gets.count { it.first == "/devnet-skr-faucet/grants" })
        assertEquals(grant.id, f.journal.read()!!.grant!!.id)
        assertFalse(f.repo.state.value.uncertain); assertTrue(skrFaucetClaimable(f.repo.state.value))
        assertNull(f.flow.claim())
        assertEquals("Exactly one reservation POST, ever", listOf("/devnet-skr-faucet/claim", "/devnet-skr-faucet/prepare",
            "/devnet-skr-faucet/submit"), f.api.posts.map { it.first })
        assertEquals(1, f.prompts.size); assertEquals(wire, f.journal.read()!!.signedTransaction)
    }

    @Test fun `without the catalogue block the grant comes from the server status checked against the pin, and nothing is invented`() = runBlocking {
        val packed = SkrFaucetBoundsSource({ catalogue }, pin) { error("The catalogue answers first") }
        assertEquals(SkrFaucetBoundsCheck.KNOWN, packed.resolve()); assertEquals(catalogue, packed.current())
        val derived = SkrFaucetBoundsSource({ null }, pin) { vector("status") }
        assertNull(derived.current())
        assertEquals(SkrFaucetBoundsCheck.KNOWN, derived.resolve())
        assertEquals("The status names the grant; it carries no cadence and no page size, so neither is made up",
            SkrFaucetBounds(null, "1000", null), derived.current())
        val status = vector("status")
        val cases = mapOf(
            "server silent" to (SkrFaucetBoundsSource({ null }, pin) { JsonObject(status + mapOf("decimals" to JsonNull, "grantRaw" to JsonNull)) } to SkrFaucetBoundsCheck.UNCONFIRMED),
            "unreadable" to (SkrFaucetBoundsSource({ null }, pin) { throw IOException("offline") } to SkrFaucetBoundsCheck.UNCONFIRMED),
            "no pin" to (SkrFaucetBoundsSource({ null }, null) { error("never read") } to SkrFaucetBoundsCheck.UNCONFIRMED),
            "another token" to (SkrFaucetBoundsSource({ null }, SkrIdentity(player, pin.decimals)) { status } to SkrFaucetBoundsCheck.MISMATCH),
            "other decimals" to (SkrFaucetBoundsSource({ null }, SkrIdentity(pin.mint, 9)) { status } to SkrFaucetBoundsCheck.MISMATCH),
            "inconsistent grant" to (SkrFaucetBoundsSource({ null }, pin) { JsonObject(status + ("grantRaw" to JsonPrimitive("1000"))) } to SkrFaucetBoundsCheck.MISMATCH))
        for ((name, case) in cases) { assertEquals(name, case.second, case.first.resolve()); assertNull(name, case.first.current()) }
        // A status-derived faucet still opens CLAIM (the repository's own grant checks agree), but never polls.
        val f = Phone(derived.current()); f.statuses("status")
        f.flow.observe()
        assertEquals("One recovery read and one status read, then no cadence to repeat at", 2, f.api.gets.size)
        assertTrue(skrFaucetClaimable(f.repo.state.value)); assertTrue(f.api.posts.isEmpty())
    }
}
