package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.PendingIntentStore
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class EconomyRepositoryTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        var base: String? = BASE_ID; var land = true
        val intents = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(intents)
        val repository = LiveEconomyRepository(session, holder, api, { base }, { land }, intents, observer)
    }
    private fun allocations(day: String?, next: String?) = json("""{"days":${if (day == null) "[]" else """[{"day":"$day","shards":"10","keepPaid":"3","status":"claimed"}]"""},
        "nextBefore":${next?.let { "\"$it\"" } ?: "null"},"totals":{"keepClaimed":"3","keepClaimable":"0","keepExpired":"0"}}""")
    private fun global(day: String = "2026-09-12", rank: Int = 1, next: String? = "next_page") = json("""{"day":"$day","settled":true,
        "totalShards":"30","distributedKeep":"3","contributors":2,"rows":[{"rank":$rank,"walletShort":"Abcd…Efgh","name":"Kingdom",
        "seeker":true,"shards":"10","keepPaid":"1"}],"nextCursor":${next?.let { "\"$it\"" } ?: "null"},"me":null,"days":["2026-09-12","2026-09-11"]}""")

    @Test fun `wallet refresh uses selected-base balances and preserves null onchain reads without money posts`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { assertEquals(BASE_ID, it["baseId"]); balancesJson("10", "20") }
        f.api.onGet("/wallet/balances") { assertTrue(it.isEmpty()); json("""{"sol":null,"tokens":{"KEEP":null},"asOf":1}""") }
        f.repository.refresh(EconomyPage.WALLET)
        assertEquals("20", f.repository.state.value.balances!!.keep); assertNull(f.repository.state.value.wallet!!.sol); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `a server read without SOL is completed from the relay, a server SOL is never overridden, a failed relay stays silent`() = runBlocking {
        // The candidate host has no upstream RPC (its wallet read returns sol null) while the web shows SOL through the
        // session relay; the native chip must show the same chain answer instead of "…", without a money post.
        val f = Fixture(); f.api.onGet("/balances") { balancesJson() }
        f.api.onGet("/wallet/balances") { json("""{"sol":null,"tokens":{"KEEP":null},"asOf":1}""") }
        var relayCalls = 0
        val relayed = LiveEconomyRepository(f.session, f.holder, f.api, { f.base }, { f.land }, f.intents, f.observer, solBalance = { relayCalls++; "0.512" })
        relayed.refresh(EconomyPage.WALLET)
        assertEquals("0.512", relayed.state.value.wallet!!.sol); assertEquals(1, relayCalls); assertTrue(f.api.posts.isEmpty())
        f.api.onGet("/wallet/balances") { json("""{"sol":"2.5","tokens":{},"asOf":1}""") }
        relayed.refresh(EconomyPage.WALLET)
        assertEquals("2.5", relayed.state.value.wallet!!.sol); assertEquals(1, relayCalls)
        f.api.onGet("/wallet/balances") { json("""{"sol":null,"tokens":{},"asOf":1}""") }
        val failing = LiveEconomyRepository(f.session, f.holder, f.api, { f.base }, { f.land }, f.intents, f.observer, solBalance = { throw IOException("relay down") })
        failing.refresh(EconomyPage.WALLET)
        assertNull(failing.state.value.wallet!!.sol); assertTrue(failing.state.value.errors.isEmpty())
    }
    @Test fun `one offline read does not hide independent wallet data and refresh clears its error`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { balancesJson() }; f.api.onGet("/wallet/balances") { throw IOException("offline") }
        f.repository.refresh(EconomyPage.WALLET)
        assertNotNull(f.repository.state.value.balances); assertEquals("offline", f.repository.state.value.errors["/wallet/balances"])
        f.api.onGet("/wallet/balances") { json("""{"sol":1,"tokens":{},"asOf":1}""") }
        f.repository.refresh(EconomyPage.WALLET); assertTrue(f.repository.state.value.errors.isEmpty()); assertFalse(f.repository.state.value.loading)
    }
    // The cached wallet is per wallet, not per kingdom, so it survives a kingdom switch. The record that its last read
    // failed must survive with it, or a later Forge or Overview refresh shows the old amounts as if they were current.
    @Test fun `a failed wallet read stays failed across a kingdom switch and an unrelated page refresh until a wallet read succeeds`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { balancesJson() }; f.api.onGet("/wallet/balances") { json("""{"sol":"2.5","tokens":{},"asOf":1}""") }
        f.repository.refresh(EconomyPage.WALLET); assertNotNull(f.repository.state.value.wallet); assertTrue(f.repository.state.value.errors.isEmpty())
        f.api.onGet("/balances") { throw IOException("offline") }; f.api.onGet("/wallet/balances") { throw IOException("offline") }
        f.repository.refresh(EconomyPage.WALLET)
        assertEquals("offline", f.repository.state.value.errors["/balances"]); assertEquals("offline", f.repository.state.value.errors["/wallet/balances"])
        f.base = "other-base"; f.repository.refresh(EconomyPage.OVERVIEW)
        assertNotNull(f.repository.state.value.wallet); assertEquals("offline", f.repository.state.value.errors["/wallet/balances"])
        assertNull(f.repository.state.value.errors["/balances"]); assertFalse(f.api.gets.any { it.first == "/wallet/balances" && it.second.isNotEmpty() })
        f.api.onGet("/balances") { balancesJson() }; f.api.onGet("/wallet/balances") { json("""{"sol":"3","tokens":{},"asOf":2}""") }
        f.repository.refresh(EconomyPage.WALLET); assertNull(f.repository.state.value.errors["/wallet/balances"])
    }
    @Test fun `deedless accounts retain withdrawal history and allocation recovery without owned reads`() = runBlocking {
        val f = Fixture(); f.land = false
        f.api.onGet("/withdrawals") { json("""{"withdrawals":[]}""") }
        f.api.onGet("/forge/allocations") { assertTrue(it.isEmpty()); allocations(null, null) }
        f.repository.refresh(EconomyPage.WITHDRAWALS); f.repository.refresh(EconomyPage.FORGE)
        assertEquals(emptyList<Any>(), f.repository.state.value.withdrawals)
        assertFalse(f.api.gets.any { it.first == "/forge" || it.first == "/withdrawals/status" }); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `allocation paging retains selected deed and prevents a repeated cursor from duplicating history`() = runBlocking {
        val f = Fixture(); f.api.onGet("/forge") { throw ApiException(404, null, "off") }
        f.api.onGet("/forge/allocations") { q -> assertEquals(BASE_ID, q["baseId"]); allocations("2026-09-11", "2026-09-11") }
        f.repository.refresh(EconomyPage.FORGE)
        f.api.onGet("/forge/allocations") { q -> assertEquals("2026-09-11", q["before"]); allocations("2026-09-11", "2026-09-11") }
        f.repository.moreAllocations()
        assertEquals(1, f.repository.state.value.allocations!!.days.size); assertNotNull(f.repository.state.value.errors["/forge/allocations"])
        f.api.onGet("/forge/allocations") { allocations("2026-09-10", null) }; f.repository.moreAllocations()
        assertEquals(listOf("2026-09-11", "2026-09-10"), f.repository.state.value.allocations!!.days.map { it.day }); assertNull(f.repository.state.value.allocations!!.nextBefore)
    }
    @Test fun `selected-base change discards an in-flight balance and old allocation paging`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { f.base = "other-base"; balancesJson("999", "999") }
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.refresh(EconomyPage.WALLET) } }
        assertNull(f.repository.state.value.balances); assertFalse(f.api.gets.any { it.first == "/wallet/balances" })
        f.repository.moreAllocations(); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `superseded wallet cannot publish a late response into its old graph`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { signedIn(f.holder, "other-wallet"); balancesJson("999", "999") }
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.refresh(EconomyPage.WALLET) } }
        assertNull(f.repository.state.value.balances)
    }
    @Test fun `faucet and referral reads are independent and never claim or redeem`() = runBlocking {
        val f = Fixture(); f.api.onGet("/devnet-faucet/status") { throw ApiException(503, null, "RPC unavailable") }
        f.api.onGet("/referrals/code") { json("""{"code":"SHAREME","bonusBps":125,"bonusBpsPerReferral":50}""") }
        f.repository.refresh(EconomyPage.SUPPORT)
        assertEquals("SHAREME", f.repository.state.value.referrals!!.code); assertNull(f.repository.state.value.faucet); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `public Forge read preserves private balances and does not send selected deed or money requests`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { balancesJson("20", "40") }
        f.api.onGet("/wallet/balances") { json("""{"sol":null,"tokens":{},"asOf":1}""") }
        f.repository.refresh(EconomyPage.WALLET)
        val privateBalances = f.repository.state.value.balances
        f.api.onGet("/forge/global") { assertTrue(it.isEmpty()); global() }
        f.repository.refreshGlobal()
        assertSame(privateBalances, f.repository.state.value.balances)
        assertEquals("2026-09-12", f.repository.state.value.forgeGlobal!!.day)
        assertEquals(BASE_ID, f.repository.state.value.baseId)
        assertFalse(f.repository.state.value.forgeGlobalLoading); assertNull(f.repository.state.value.forgeGlobalError)
        assertTrue(f.api.posts.isEmpty()); assertTrue(f.intents.all(f.session.wallet).isEmpty())
    }
    @Test fun `public Forge page is pinned to settled head day and opaque cursor`() = runBlocking {
        val f = Fixture(); f.api.onGet("/forge/global") { global() }; f.repository.refreshGlobal()
        f.api.onGet("/forge/global") { q ->
            assertEquals(mapOf("day" to "2026-09-12", "cursor" to "next_page"), q)
            global(rank = 2, next = null)
        }
        f.repository.moreGlobal()
        assertEquals(listOf(1, 2), f.repository.state.value.forgeGlobal!!.rows.map { it.rank })
        assertNull(f.repository.state.value.forgeGlobal!!.nextCursor)
        val gets = f.api.gets.size; f.repository.moreGlobal(); assertEquals(gets, f.api.gets.size)
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `invalid Forge pages leave retained history intact and a valid retry can finish it`() = runBlocking {
        val f = Fixture(); f.api.onGet("/forge/global") { global() }; f.repository.refreshGlobal()
        val head = f.repository.state.value.forgeGlobal
        listOf(global(), global(day = "2026-09-11", rank = 2, next = null), global(rank = 1, next = null), json("""{"bad":"payload"}""")).forEach { response ->
            f.api.onGet("/forge/global") { response }; f.repository.moreGlobal()
            assertSame(head, f.repository.state.value.forgeGlobal); assertNotNull(f.repository.state.value.forgeGlobalError)
            assertTrue(f.repository.state.value.errors.isEmpty()); assertFalse(f.repository.state.value.forgeGlobalLoading)
        }
        f.api.onGet("/forge/global") { global(rank = 2, next = null) }; f.repository.moreGlobal()
        assertEquals(2, f.repository.state.value.forgeGlobal!!.rows.size); assertNull(f.repository.state.value.forgeGlobalError)
    }
    @Test fun `new settled day failure cannot masquerade as the previous cycle and retry retains selection`() = runBlocking {
        val f = Fixture(); f.api.onGet("/forge/global") { global() }; f.repository.refreshGlobal()
        f.api.onGet("/forge/global") { q -> assertEquals(mapOf("day" to "2026-09-11"), q); throw IOException("offline") }
        f.repository.refreshGlobal("2026-09-11")
        assertNull(f.repository.state.value.forgeGlobal); assertEquals("2026-09-11", f.repository.state.value.forgeGlobalDay)
        assertEquals("offline", f.repository.state.value.forgeGlobalError)
        f.api.onGet("/forge/global") { global(day = "2026-09-11") }; f.repository.refreshGlobal(f.repository.state.value.forgeGlobalDay)
        assertEquals("2026-09-11", f.repository.state.value.forgeGlobal!!.day); assertNull(f.repository.state.value.forgeGlobalError)
    }
    @Test fun `selected deed change rejects late global response and prevents stale cache pagination`() = runBlocking {
        val f = Fixture(); f.api.onGet("/forge/global") { global() }; f.repository.refreshGlobal()
        f.base = "other-base"
        val count = f.api.gets.size; f.repository.moreGlobal(); assertEquals(count, f.api.gets.size)
        f.api.onGet("/forge/global") { f.base = "third-base"; global() }
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.refreshGlobal() } }
        assertNull(f.repository.state.value.forgeGlobal); assertFalse(f.repository.state.value.forgeGlobalLoading)
    }
    @Test fun `superseded wallet cannot publish public Forge me identity`() = runBlocking {
        val f = Fixture(); f.api.onGet("/forge/global") { signedIn(f.holder, "other-wallet"); global() }
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.refreshGlobal() } }
        assertNull(f.repository.state.value.forgeGlobal)
    }
    @Test fun `global loading and cancellation never block or clear independent wallet state`() = runBlocking {
        val f = Fixture(); val release = CompletableDeferred<Unit>()
        f.api.onGet("/forge/global") { release.await(); global() }
        val read = launch(start = CoroutineStart.UNDISPATCHED) { f.repository.refreshGlobal() }
        assertTrue(f.repository.state.value.forgeGlobalLoading); assertFalse(f.repository.state.value.loading)
        f.api.onGet("/balances") { balancesJson("20", "40") }; f.api.onGet("/wallet/balances") { json("""{"sol":1,"tokens":{},"asOf":1}""") }
        f.repository.refresh(EconomyPage.WALLET)
        assertEquals("40", f.repository.state.value.balances!!.keep); assertTrue(f.repository.state.value.forgeGlobalLoading)
        read.cancelAndJoin()
        assertFalse(f.repository.state.value.forgeGlobalLoading); assertNull(f.repository.state.value.forgeGlobalError)
        assertEquals("40", f.repository.state.value.balances!!.keep); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `claim invalidation rejects an older allocation page before publishing the coordinated snapshot`() = runBlocking {
        val f = Fixture(); val oldEntered = CompletableDeferred<Unit>(); val oldRelease = CompletableDeferred<Unit>()
        val freshEntered = CompletableDeferred<Unit>(); val freshRelease = CompletableDeferred<Unit>(); var reads = 0
        f.api.onGet("/balances") { balancesJson(keep = "900") }; f.api.onGet("/forge") { forgeClaimOverview() }
        f.api.onGet("/forge/allocations") {
            if (++reads == 1) { oldEntered.complete(Unit); oldRelease.await(); allocations("2026-09-11", "2026-09-11") }
            else { freshEntered.complete(Unit); freshRelease.await(); allocations(null, null) }
        }
        val old = async { f.repository.refresh(EconomyPage.FORGE) }; oldEntered.await()
        f.repository.invalidateForge()
        val fresh = async { f.repository.refreshForgeAfterClaim(BASE_ID, null) }
        oldRelease.complete(Unit); freshEntered.await()
        assertNull(f.repository.state.value.allocations); assertNull(f.repository.state.value.balances)
        assertFalse(f.repository.state.value.forgeReady)
        freshRelease.complete(Unit); fresh.await()
        assertThrows(CancellationException::class.java) { runBlocking { old.await() } }
        assertEquals("0", f.repository.state.value.allocations!!.claimable)
        assertEquals("900", f.repository.state.value.balances!!.keep); assertTrue(f.repository.state.value.forgeReady)
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `failed coordinated refresh does not publish a partial new balance beside old allocations`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { balancesJson(keep = "900") }
        f.api.onGet("/forge") { forgeClaimOverview() }; f.api.onGet("/forge/allocations") { throw IOException("offline") }
        f.repository.invalidateForge()
        val result = f.repository.refreshForgeAfterClaim(BASE_ID, null)
        assertEquals("900", result.keepBalance); assertFalse(result.availabilityCurrent)
        assertNotNull(result.availabilityUnavailable)
        assertNull(f.repository.state.value.balances); assertNull(f.repository.state.value.allocations)
        assertFalse(f.repository.state.value.forgeReady); assertFalse(f.repository.state.value.loading)
    }
    @Test fun `allocation ownership change during refresh rejects the old scope even when selected base is unchanged`() = runBlocking {
        val f = Fixture(); f.api.onGet("/balances") { balancesJson() }; f.api.onGet("/forge") { forgeClaimOverview() }
        f.api.onGet("/forge/allocations") { f.land = false; allocations(null, null) }
        f.repository.invalidateForge()
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.refreshForgeAfterClaim(BASE_ID, null) } }
        assertNull(f.repository.state.value.allocations); assertFalse(f.repository.state.value.forgeReady)
    }

}
