package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetPriorDayTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-grant-read-vectors.json")
        assertNotNull("MISSING: P5 authorized grant-read route vectors", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    @Test fun `saved previous day submitted grant hydrates only after exact grant GET settles`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), WALLET, session.origin, "devnet")
        val submitted = SkrFaucetGrant.from(vector("submitted").getValue("grant").jsonObject)
        val initial = journal.beginIfEmpty("11111111-1111-4111-8111-111111111111")
        journal.replace(initial, initial.copy(grant = submitted, attemptId = submitted.attempt!!.id))
        var hydrated = 0; var terminal = false
        api.onGet("/devnet-skr-faucet/status") { vector("nextDayStatus") }
        api.onGet("/devnet-skr-faucet/grants/${submitted.id}") { vector(if (terminal) "sent" else "submitted") }
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(submitted.mint, submitted.decimals) },
            { SkrFaucetBounds(5000, "1000") }, { initial.baseId }, { _, _, _ -> error("no prompt") }, {
                assertNotNull(journal.read()); hydrated++
            })
        repo.refresh(); assertNotNull(journal.read()); assertEquals(0, hydrated)
        terminal = true; repo.refresh(); assertNull(journal.read()); assertEquals(1, hydrated); assertTrue(api.posts.isEmpty())
    }
    @Test fun `foreign and missing saved grant refusals preserve durable evidence`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val disk = MemoryStore(); val journal = SkrFaucetJournal(disk, WALLET, session.origin, "devnet")
        val grant = SkrFaucetGrant.from(vector("submitted").getValue("grant").jsonObject)
        val initial = journal.beginIfEmpty("11111111-1111-4111-8111-111111111111")
        journal.replace(initial, initial.copy(grant = grant, attemptId = grant.attempt!!.id)); val before = disk.value
        api.onGet("/devnet-skr-faucet/status") { vector("nextDayStatus") }
        api.onGet("/devnet-skr-faucet/grants/${grant.id}") { throw ApiException(404, "SKR_FAUCET_NOT_OWNED", "unavailable") }
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
            { SkrFaucetBounds(5000, "1000") }, { initial.baseId }, { _, _, _ -> error("no prompt") }, {})
        repo.refresh(); assertEquals(before, disk.value); assertTrue(repo.state.value.available); assertTrue(api.posts.isEmpty())
    }

    @Test fun `exact prior day settlement waits for successful wallet refresh before publishing arrival`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), WALLET, session.origin, "devnet")
        val submitted = SkrFaucetGrant.from(vector("submitted").getValue("grant").jsonObject)
        val sent = SkrFaucetGrant.from(vector("sent").getValue("grant").jsonObject)
        assertTrue(submitted.sameIdentity(sent)); assertTrue(sent.status.isValue("sent"))
        val initial = journal.beginIfEmpty("11111111-1111-4111-8111-111111111111")
        journal.replace(initial, initial.copy(grant = submitted, attemptId = submitted.attempt!!.id))
        var walletReads = 0; var walletReady = false; var prompts = 0
        api.onGet("/devnet-skr-faucet/status") { vector("nextDayStatus") }
        api.onGet("/devnet-skr-faucet/grants/${submitted.id}") { vector("sent") }
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(submitted.mint, submitted.decimals) },
            { SkrFaucetBounds(5000, "1000") }, { initial.baseId }, { _, _, _ -> prompts++ }, {
                walletReads++; assertEquals(sent, journal.read()!!.grant)
                check(walletReady) { "Wallet read remains unavailable" }
            })
        repo.refresh()
        val retained = requireNotNull(journal.read())
        assertEquals(initial.intentId, retained.intentId); assertEquals(sent, retained.grant)
        assertEquals(sent.attempt!!.id, retained.attemptId); assertNull(repo.state.value.arrival)
        assertEquals(1, walletReads); assertTrue(repo.state.value.available); assertFalse(repo.state.value.canClaim)
        assertNotNull(repo.state.value.error); assertTrue(api.posts.isEmpty()); assertEquals(0, prompts)
        walletReady = true; repo.refresh()
        assertEquals(2, walletReads); assertNull(journal.read()); assertEquals(sent, repo.state.value.arrival)
        assertEquals(sent, repo.state.value.grant); assertFalse(repo.state.value.canClaim)
        assertTrue(api.posts.isEmpty()); assertEquals(0, prompts)
        assertEquals(2, api.gets.count { it.first == "/devnet-skr-faucet/grants/${submitted.id}" })
    }

}
