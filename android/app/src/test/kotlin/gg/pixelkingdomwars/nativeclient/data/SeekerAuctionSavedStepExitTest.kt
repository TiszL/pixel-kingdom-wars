package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionAuthenticatedPort
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionBidRequest
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionPrepared
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionWithdrawRequest
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import gg.pixelkingdomwars.nativeclient.wallet.base58
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner rules 2026-10-06 for every saved request ("a player is never charged twice", "a real charge is never hidden", "no
 * saved request blocks a door forever"), applied to the Seeker auction journal (SeekerAuctionJournal: a bid or withdrawal
 * step saved before the wallet is asked; the saved step shows that spot's BID or WITHDRAW as SENDING). The app restarted
 * after the reply was lost; only GET reads resolve the step:
 * - the chain finalized the signature: the round is re-read and the step is accepted, never hidden;
 * - the chain never saw the signature and the quoted blockhash is past its last valid height: the step is closed, nothing
 *   is resent and no wallet is asked (a send the wallet broadcast itself has an unknown blockhash: never by height alone);
 * - anything else stays saved, refuses a bid at the same or lower total on that spot (never a double bid), and is released
 *   only when a finalized round view proves the program can no longer take it (the bidding window closed on chain).
 */
class SeekerAuctionSavedStepExitTest {
    private companion object {
        const val ORIGIN = "https://localhost:18443"
        const val PROGRAM = "11111111111111111111111111111112"
        const val MINT = "11111111111111111111111111111113"
        const val BLOCKHASH = "11111111111111111111111111111114"
        const val CURRENT = "/seeker/auctions/current"
        const val PREPARE_BID = "/seeker/auctions/bids/prepare"
        const val SUBMIT = "/seeker/auctions/submit"
        val SIG = base58(ByteArray(64) { 7 })
        val TX = "/seeker/auctions/tx/$SIG"
        val CATALOGUE = buildJsonObject { putJsonObject("constants") {
            putJsonObject("PHASE_E_POLICY") { putJsonObject("seekerIsland") { put("totalSpots", 3); put("kingSpots", 1); put("realmCount", 3) } }
            putJsonObject("PHASE_E_SEEKER_AUCTION") { put("regularRealmCount", 2) }
            putJsonObject("PHASE_E_SEEKER_AUCTION_RUNTIME") { put("refundPageSize", 2) }
        } }

        fun spot(index: Int, kind: String, mask: Int, high: String, bidder: String?, own: String) = buildJsonObject {
            put("spot", index); put("class", kind); put("realmMask", mask); put("opened", true); put("highBidRaw", high)
            put("highBidder", bidder?.let(::JsonPrimitive) ?: JsonNull); put("settled", false); put("yourBidRaw", own)
            put("refundable", own != "0" && bidder != WALLET)
        }
        /** Round 0 on the synthetic calendar of SeekerAuctionRepositoryTest (bidding window 980..1000). */
        fun view(chainTime: Long = 990, high: String = "0", bidder: String? = null, own: String = "0"): JsonObject = buildJsonObject {
            put("version", 1); put("source", "chain"); put("chainUnixTime", chainTime.toString()); put("walletSkrRaw", "500000000")
            put("wallet", WALLET); put("observedSlot", "9"); put("round", "0"); put("biddingRound", "0"); put("admissionPaused", false)
            putJsonObject("config") {
                put("programId", PROGRAM); put("address", BLOCKHASH); put("mint", MINT); put("prizeOwner", BLOCKHASH); put("prizeAta", BLOCKHASH)
                put("decimals", 6); put("openingBidRaw", "10000000"); put("firstOperatingStart", "1000"); put("termSec", "100")
                put("auctionSec", "20"); put("graceSec", "5")
            }
            put("auctionStart", "980"); put("auctionEnd", "1000"); put("operatingStart", "1000"); put("operatingEnd", "1100")
            put("openedCount", 3); put("completedCount", 0); put("winnerCount", 0); put("completedAt", JsonNull)
            put("spots", buildJsonArray {
                add(spot(0, "king", 7, "0", null, "0")); add(spot(1, "regular", 3, high, bidder, own)); add(spot(2, "regular", 6, "0", null, "0"))
            })
        }
        fun status(state: String, found: Boolean, height: String) = buildJsonObject {
            put("signature", SIG); put("status", state); put("slot", if (state == "pending") JsonNull else JsonPrimitive("5"))
            put("error", if (state == "failed") JsonPrimitive("CHAIN_TRANSACTION_FAILED") else JsonNull)
            put("found", found); put("finalizedBlockHeight", height)
        }
        /** A bid to 20 SKR on spot 1, quoted with blockhash valid through height 11, saved before the wallet was asked. */
        fun saved(signature: String? = SIG, opaqueSend: Boolean = false) = SeekerAuctionAttempt("22222222-2222-4222-8222-222222222222",
            SeekerAuctionKind.BID, "0", 1, "20000000", BLOCKHASH, "11", signature, opaqueSend && signature != null)
    }

    private class Fixture {
        val events = mutableListOf<String>()
        val holder = testHolder(); val session = signedIn(holder)
        val journal = SeekerAuctionJournal(MemoryStore(), WALLET, ORIGIN, "devnet")
        var current: () -> JsonObject = { view() }
        var observed: () -> JsonObject = { status("finalized", true, "10") }
        val port = object : SeekerAuctionAuthenticatedPort {
            override val identity = StarterIdentity(ORIGIN, "devnet", WALLET)
            override suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?,
                guard: () -> Unit, retain: suspend (JsonObject) -> Unit): JsonObject {
                guard(); events += "$method $path"
                val raw = when (path) { CURRENT -> current(); TX -> observed(); else -> error("Unexpected $method $path") }
                retain(raw); return raw
            }
        }
        val verifier = object : SeekerAuctionVerifier {
            override suspend fun bid(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionBidRequest): ByteArray { events += "verify"; error("never verified here") }
            override suspend fun withdraw(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionWithdrawRequest): ByteArray { events += "verify"; error("never verified here") }
        }
        val payer = WalletPayer { _, _, _, _ -> events += "wallet"; error("The wallet is never asked again for a saved step") }
        val repository = SeekerAuctionRepository(session, holder, port, journal, SeekerAuctionPins(PROGRAM, MINT, 6), SolanaCluster.DEVNET,
            { seekerAuctionProtocolPolicy(CATALOGUE) }, { LandCheckoutBounds(15_000, 30_000, 60_000, 2_500) }, verifier, payer,
            SolanaRpc { events += "relay"; error("never relayed") }, { 0L }, report = {})
        /** Nothing but GET reads happened: no prepare, submit, wallet, verify or relay. */
        fun readsOnly() = events.all { it.startsWith("GET ") }
    }

    @Test fun `a signed bid whose reply was lost is accepted once the chain finalized it and the round shows it`() = runBlocking {
        val f = Fixture(); f.journal.add(saved())
        f.current = { view(high = "20000000", bidder = WALLET, own = "20000000") }
        f.repository.refresh()
        assertTrue("the accepted step is retired", f.journal.read().isEmpty()); assertTrue(f.repository.state.value.pending.isEmpty())
        assertEquals("the charge is shown from a fresh round", "20000000", f.repository.state.value.current!!.spots[1].yourBidRaw)
        assertEquals(listOf("GET $TX", "GET $CURRENT"), f.events)
    }

    @Test fun `a signature the chain never saw after its quoted blockhash expired is closed and nothing is resent`() = runBlocking {
        val f = Fixture(); f.journal.add(saved())
        f.observed = { status("pending", false, "12") } // Past the quote's lastValidBlockHeight 11: it can never land.
        f.repository.refresh()
        assertTrue(f.journal.read().isEmpty()); assertTrue("the spot can be bid on again", f.repository.state.value.pending.isEmpty())
        assertTrue("closing sent nothing and asked no wallet", f.readsOnly())
    }

    @Test fun `a signature still inside its blockhash validity is kept and never forgotten`() = runBlocking {
        val f = Fixture(); val step = saved(); f.journal.add(step)
        f.observed = { status("pending", false, "10") }
        f.repository.refresh()
        assertEquals("kept with what the chain said", listOf(step.copy(lastFound = false)), f.journal.read())
        assertEquals(f.journal.read(), f.repository.state.value.pending)
        assertTrue(f.readsOnly())
    }

    @Test fun `a step the wallet broadcast itself is never closed by height and never lets a same total bid through`() = runBlocking {
        // Its signed blockhash is unknown, so block height alone proves nothing: it stays until the chain answers or the round
        // view proves the program can no longer take it. Meanwhile a bid at the same total is refused before the server
        // prepares anything, so the player cannot bid twice for one approval.
        val f = Fixture(); f.journal.add(saved(opaqueSend = true))
        f.observed = { status("pending", false, "999") }
        f.repository.refresh()
        assertEquals(1, f.journal.read().size)
        f.repository.bid(SeekerAuctionBidRequest("0", 1, "20000000"), "20000000")
        assertEquals(SeekerAuctionNotice.CHECKING, f.repository.state.value.notice)
        assertTrue("no prepare, no wallet: never a double bid", f.readsOnly())
        f.current = { view(chainTime = 1000) } // The bidding window closed on chain.
        f.repository.refresh()
        assertTrue("released once the program can no longer take it", f.journal.read().isEmpty())
        assertTrue(f.readsOnly())
    }

    @Test fun `a step saved before the wallet answered is released only by the round view and never resent`() = runBlocking {
        // No signature was saved (the app stopped while the wallet was open), so there is nothing to look up: the step is kept
        // and is released only once a finalized round view proves the program can no longer take it.
        val f = Fixture(); f.journal.add(saved(signature = null))
        f.repository.refresh()
        assertEquals(1, f.journal.read().size); assertEquals(listOf("GET $CURRENT"), f.events)
        f.current = { view(high = "20000000", bidder = WALLET, own = "20000000") } // The wallet did send it: the escrow is there.
        f.repository.refresh()
        assertTrue(f.journal.read().isEmpty()); assertEquals("20000000", f.repository.state.value.current!!.spots[1].yourBidRaw)
        assertTrue(f.readsOnly())
    }
}
