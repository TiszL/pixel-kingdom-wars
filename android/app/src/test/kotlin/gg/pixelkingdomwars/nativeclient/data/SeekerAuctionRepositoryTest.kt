package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionAuthenticatedPort
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionBidRequest
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionPrepared
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionProtocolPolicy
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionWithdrawRequest
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import gg.pixelkingdomwars.nativeclient.wallet.TransactionMutation
import gg.pixelkingdomwars.nativeclient.wallet.WalletPayment
import gg.pixelkingdomwars.nativeclient.wallet.WalletPaymentException
import gg.pixelkingdomwars.nativeclient.wallet.base58
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The Seeker auction repository's money rules (plan onchain-client-reach.md S-C): the intent is saved before the wallet,
 * the wallet is never asked for anything the player did not review, nothing re-prompts on an uncertain outcome, and SENT
 * is published only after a finalized receipt and a fresh round. A synthetic 3-spot policy proves no auction number is
 * copied into the client.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SeekerAuctionRepositoryTest {
    private companion object {
        const val ORIGIN = "https://localhost:18443"
        const val PROGRAM = "11111111111111111111111111111112"
        const val MINT = "11111111111111111111111111111113"
        const val BLOCKHASH = "11111111111111111111111111111114"
        const val RIVAL = "11111111111111111111111111111115"
        const val CURRENT = "/seeker/auctions/current"
        const val PREPARE_BID = "/seeker/auctions/bids/prepare"
        const val PREPARE_WITHDRAW = "/seeker/auctions/withdrawals/prepare"
        const val SUBMIT = "/seeker/auctions/submit"
        val SIG_BYTES = ByteArray(64) { 7 }
        val SIG = base58(SIG_BYTES)
        val OTHER_SIG = base58(ByteArray(64) { 8 })
        val TX = "/seeker/auctions/tx/$SIG"
        val CATALOGUE = buildJsonObject { putJsonObject("constants") {
            putJsonObject("PHASE_E_POLICY") { putJsonObject("seekerIsland") { put("totalSpots", 3); put("kingSpots", 1); put("realmCount", 3) } }
            putJsonObject("PHASE_E_SEEKER_AUCTION") { put("regularRealmCount", 2) }
            putJsonObject("PHASE_E_SEEKER_AUCTION_RUNTIME") { put("refundPageSize", 2) }
        } }

        fun spot(index: Int, kind: String, mask: Int, high: String, bidder: String?, settled: Boolean, own: String) = buildJsonObject {
            put("spot", index); put("class", kind); put("realmMask", mask); put("opened", true); put("highBidRaw", high)
            put("highBidder", bidder?.let(::JsonPrimitive) ?: JsonNull); put("settled", settled); put("yourBidRaw", own)
            put("refundable", own != "0" && bidder != WALLET)
        }

        /** A valid round on the synthetic calendar (first start 1000, term 100, window 20); spot 1 carries the test's bids. */
        fun view(round: Int = 0, chainTime: Long = 990, program: String = PROGRAM, high: String = "0", bidder: String? = null,
            own: String = "0", settled: Boolean = false): JsonObject = buildJsonObject {
            val start = 1000L + round * 100L
            put("version", 1); put("source", "chain"); put("chainUnixTime", chainTime.toString()); put("walletSkrRaw", "500000000")
            put("wallet", WALLET); put("observedSlot", "9"); put("round", round.toString()); put("biddingRound", round.toString())
            put("admissionPaused", false)
            putJsonObject("config") {
                put("programId", program); put("address", BLOCKHASH); put("mint", MINT); put("prizeOwner", BLOCKHASH); put("prizeAta", BLOCKHASH)
                put("decimals", 6); put("openingBidRaw", "10000000"); put("firstOperatingStart", "1000"); put("termSec", "100")
                put("auctionSec", "20"); put("graceSec", "5")
            }
            put("auctionStart", (start - 20).toString()); put("auctionEnd", start.toString())
            put("operatingStart", start.toString()); put("operatingEnd", (start + 100).toString())
            put("openedCount", 3); put("completedCount", if (settled) 1 else 0); put("winnerCount", if (settled && bidder != null) 1 else 0)
            put("completedAt", JsonNull)
            put("spots", buildJsonArray {
                add(spot(0, "king", 7, "0", null, false, "0")); add(spot(1, "regular", 3, high, bidder, settled, own))
                add(spot(2, "regular", 6, "0", null, false, "0"))
            })
        }

        fun prepared(increment: String) = buildJsonObject {
            put("messageBase64", "AQ=="); put("blockhash", BLOCKHASH); put("lastValidBlockHeight", "11"); put("incrementRaw", increment)
            put("networkFeeLamports", "5000"); put("newAccountRentLamports", "0")
        }

        fun status(state: String, found: Boolean = true, height: String = "10") = buildJsonObject {
            put("signature", SIG); put("status", state); put("slot", if (state == "pending") JsonNull else JsonPrimitive("5"))
            put("error", if (state == "failed") JsonPrimitive("CHAIN_TRANSACTION_FAILED") else JsonNull)
            put("found", found); put("finalizedBlockHeight", height)
        }

        val bid = SeekerAuctionBidRequest("0", 1, "20000000")
    }

    /** The S-A port contract: the server answers per route; every call is recorded in the shared event log. */
    private class FakePort(private val events: MutableList<String>) : SeekerAuctionAuthenticatedPort {
        override val identity = StarterIdentity(ORIGIN, "devnet", WALLET)
        val routes = mutableMapOf<String, (JsonObject?) -> JsonObject>()
        override suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?,
            guard: () -> Unit, retain: suspend (JsonObject) -> Unit): JsonObject {
            guard(); events += "$method $path"
            val raw = requireNotNull(routes[path]) { "Unexpected $method $path" }(body)
            retain(raw); return raw
        }
    }

    private class FakeVerifier(private val events: MutableList<String>) : SeekerAuctionVerifier {
        var refuse = false
        private fun check(): ByteArray {
            events += "verify"
            if (refuse) throw IllegalArgumentException("The auction message differs from the reviewed action")
            return byteArrayOf(1) + ByteArray(64) + byteArrayOf(9)
        }
        override suspend fun bid(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionBidRequest) = check()
        override suspend fun withdraw(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionWithdrawRequest) = check()
    }

    private class Fixture(private val clock: () -> Long) {
        val events = mutableListOf<String>()
        val holder = testHolder(); val session = signedIn(holder)
        val journal = SeekerAuctionJournal(MemoryStore(), WALLET, ORIGIN, "devnet")
        val port = FakePort(events)
        val verifier = FakeVerifier(events)
        var current: () -> JsonObject = { view() }
        var observed: () -> JsonObject = { status("finalized") }
        /** The wallet step: by default the wallet app signs and broadcasts itself (MWA sign_and_send). */
        var payment: (onSent: (ByteArray) -> Unit) -> WalletPayment = { onSent -> onSent(SIG_BYTES); WalletPayment.Sent(SIG_BYTES) }
        var savedAtWallet: List<SeekerAuctionAttempt>? = null
        var savedAtRelay: List<SeekerAuctionAttempt>? = null
        val payer = WalletPayer { _, cluster, owner, onSent ->
            events += "wallet"; assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(WALLET, owner)
            savedAtWallet = journal.read()
            payment(onSent)
        }
        val rpc = SolanaRpc { body ->
            events += "relay"; assertEquals("sendTransaction", body.getValue("method").jsonPrimitive.content)
            savedAtRelay = journal.read()
            buildJsonObject { put("result", SIG) }
        }
        init {
            port.routes[CURRENT] = { current() }
            port.routes[PREPARE_BID] = { body -> prepared(body!!.getValue("newTotalRaw").jsonPrimitive.content) }
            port.routes[PREPARE_WITHDRAW] = { prepared("0") }
            port.routes[SUBMIT] = { body -> assertEquals(setOf("signature"), body!!.keys); observed() }
            port.routes[TX] = { observed() }
        }
        fun repository(payer: WalletPayer? = this.payer, catalogue: JsonObject? = CATALOGUE) =
            SeekerAuctionRepository(session, holder, port, journal, SeekerAuctionPins(PROGRAM, MINT, 6), SolanaCluster.DEVNET,
                { seekerAuctionProtocolPolicy(catalogue) }, { LandCheckoutBounds(15_000, 30_000, 60_000, 2_500) }, verifier, payer, rpc,
                clock, report = {})
        fun count(event: String) = events.count { it == event }
    }

    @Test fun `a bid saves its intent before the wallet and is SENT only after the receipt and a fresh round`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        repo.refresh()
        assertEquals("0", repo.state.value.current?.round)
        f.current = { view(high = "20000000", bidder = WALLET, own = "20000000") }
        repo.bid(bid, "20000000")
        assertEquals(listOf("GET $CURRENT", "POST $PREPARE_BID", "verify", "wallet", "POST $SUBMIT", "GET $CURRENT"), f.events)
        val atWallet = f.savedAtWallet!!.single()
        assertEquals(listOf(SeekerAuctionKind.BID, "0", 1, "20000000", null), listOf(atWallet.kind, atWallet.round, atWallet.spot, atWallet.newTotalRaw, atWallet.signature))
        assertEquals(SeekerAuctionStage.SENT, repo.state.value.stage)
        assertEquals("20000000", repo.state.value.current!!.spots[1].yourBidRaw)
        assertTrue("a finished bid leaves no saved step behind", f.journal.read().isEmpty())
        assertEquals("the wallet broadcast itself, so this app relays nothing", 0, f.count("relay"))
    }

    @Test fun `a receipt without a fresh round keeps the intent and finishes on a later refresh without a second wallet prompt`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.current = { throw ApiException(503, "SEEKER_AUCTION_UNAVAILABLE", "Seeker auction data is unavailable") }
        repo.bid(bid, "20000000")
        assertEquals(SeekerAuctionStage.SENDING, repo.state.value.stage)
        assertEquals(SeekerAuctionNotice.CHECKING, repo.state.value.notice)
        val kept = f.journal.read().single()
        assertEquals(SIG, kept.signature); assertTrue("the wallet broadcast itself", kept.opaqueSend)
        f.current = { view(high = "20000000", bidder = WALLET, own = "20000000") }
        repo.refresh()
        assertEquals(SeekerAuctionStage.SENT, repo.state.value.stage)
        assertTrue(f.journal.read().isEmpty())
        assertEquals(1, f.count("wallet"))
    }

    @Test fun `the wallet is never asked when the message or the increment differs from what the player reviewed`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.verifier.refuse = true
        repo.bid(bid, "20000000")
        assertEquals(SeekerAuctionNotice.NOT_REVIEWED, repo.state.value.notice)
        f.verifier.refuse = false
        repo.bid(bid, "15000000") // The server would take 20 SKR; the Seal showed 15.
        assertEquals(SeekerAuctionNotice.NOT_REVIEWED, repo.state.value.notice)
        assertEquals(SeekerAuctionStage.FAILED, repo.state.value.stage)
        assertEquals("the increment check runs before verification", 1, f.count("verify"))
        assertEquals(0, f.count("wallet")); assertTrue(f.journal.read().isEmpty())
    }

    @Test fun `a wallet refusal before broadcast voids the intent and says nothing was sent`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.payment = { throw WalletPaymentException("declined", true) }
        repo.bid(bid, "20000000")
        assertEquals(SeekerAuctionStage.FAILED, repo.state.value.stage)
        assertEquals("Wallet didn't answer. Nothing was sent.", repo.state.value.noticeText)
        assertTrue(f.journal.read().isEmpty()); assertTrue(repo.state.value.pending.isEmpty())
        assertEquals(0, f.count("POST $SUBMIT"))
    }

    @Test fun `an uncertain wallet outcome is kept and a repeat at the same total never reaches the wallet`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.payment = { throw WalletPaymentException("lost", false) }
        repo.bid(bid, "20000000")
        assertEquals(SeekerAuctionNotice.CHECKING, repo.state.value.notice)
        assertEquals(1, f.journal.read().size)
        f.payment = { onSent -> onSent(SIG_BYTES); WalletPayment.Sent(SIG_BYTES) }
        repo.bid(bid, "20000000")
        assertEquals(SeekerAuctionNotice.CHECKING, repo.state.value.notice)
        assertEquals("the same total is refused before the server prepares again", 1, f.count("POST $PREPARE_BID"))
        assertEquals(1, f.count("wallet"))
        // The program tops escrow up to the highest landed total, so a higher bid can never charge twice.
        f.current = { view(high = "30000000", bidder = WALLET, own = "30000000") }
        repo.bid(SeekerAuctionBidRequest("0", 1, "30000000"), "30000000")
        assertEquals(2, f.count("wallet"))
        assertEquals(SeekerAuctionStage.SENT, repo.state.value.stage)
    }

    @Test fun `a sign-only payment is relayed once after its signature is saved and its provable expiry voids the intent`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.payment = { WalletPayment.SignedOnly(byteArrayOf(1) + SIG_BYTES + byteArrayOf(9), SIG_BYTES, TransactionMutation.NONE, null) }
        f.observed = { status("pending", found = false, height = "12") } // Past the quote's lastValidBlockHeight 11.
        repo.bid(bid, "20000000")
        assertEquals(1, f.count("relay"))
        val atRelay = f.savedAtRelay!!.single()
        assertEquals(SIG, atRelay.signature); assertFalse("this app relays the exact quoted bytes", atRelay.opaqueSend)
        assertEquals(SeekerAuctionNotice.NOT_LANDED, repo.state.value.notice)
        assertTrue(f.journal.read().isEmpty())
    }

    @Test fun `a send the wallet broadcast itself is never retired by block height alone`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.observed = { status("pending", found = false, height = "999") }
        repo.bid(bid, "20000000")
        assertTrue("observation ran for the whole grace bound", testScheduler.currentTime >= 30_000)
        assertEquals(SeekerAuctionNotice.CHECKING, repo.state.value.notice)
        val kept = f.journal.read().single()
        assertTrue(kept.opaqueSend); assertEquals(false, kept.lastFound)
        assertEquals(1, f.count("wallet"))
    }

    @Test fun `a saved bid is released only once the round's bidding window has closed on chain`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.payment = { throw WalletPaymentException("lost", false) }
        repo.bid(bid, "20000000")
        repo.refresh()
        assertEquals("inside the window the program could still take it", 1, f.journal.read().size)
        f.current = { view(chainTime = 1000) }
        repo.refresh()
        assertTrue(f.journal.read().isEmpty()); assertTrue(repo.state.value.pending.isEmpty())
    }

    @Test fun `a second withdrawal waits while the chain has seen the first and is offered once it has not`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.current = { view(high = "30000000", bidder = RIVAL, own = "20000000") }
        val withdraw = SeekerAuctionWithdrawRequest("0", 1)
        f.observed = { status("pending", found = true) }
        repo.withdraw(withdraw)
        assertEquals(true, f.journal.read().single().lastFound)
        repo.withdraw(withdraw)
        assertEquals(1, f.count("wallet")); assertEquals(SeekerAuctionNotice.CHECKING, repo.state.value.notice)
        f.observed = { status("pending", found = false) }
        repo.refresh()
        assertEquals("still refundable, so the first is kept", false, f.journal.read().single().lastFound)
        repo.withdraw(withdraw) // A withdrawal can only return this escrow once; a fresh one cannot move SKR twice.
        assertEquals(2, f.count("wallet"))
    }

    @Test fun `without a wallet app the bid stops before the server prepares anything`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository(payer = null)
        repo.bid(bid, "20000000")
        assertEquals(SeekerAuctionNotice.NO_WALLET, repo.state.value.notice)
        assertEquals(0, f.count("POST $PREPARE_BID")); assertTrue(f.journal.read().isEmpty())
    }

    @Test fun `a routine refresh failure keeps the shown round`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        repo.refresh()
        f.current = { throw IOException("offline") }
        repo.refresh()
        assertEquals("0", repo.state.value.current?.round)
        assertTrue(repo.state.value.readFailed)
    }

    @Test fun `a round from another deployment is never shown as this build's auction`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository()
        f.current = { view(program = BLOCKHASH) }
        repo.refresh()
        assertNull(repo.state.value.current); assertTrue(repo.state.value.readFailed)
    }

    @Test fun `the live verifier refuses a message that is not the pinned program's bid`() {
        val verifier = seekerAuctionPinnedVerifier(SeekerAuctionPins(PROGRAM, MINT, 6), WALLET)
        val garbage = SeekerAuctionPrepared("AQ==", BLOCKHASH, "11", "20000000", "5000", "0")
        assertThrows(IllegalArgumentException::class.java) { runBlocking { verifier.bid(garbage, bid) } }
    }

    @Test fun `journal fails closed on unreadable data and is bound to its identity`() {
        assertThrows(Exception::class.java) { SeekerAuctionJournal(MemoryStore("not-json"), WALLET, ORIGIN, "devnet").read() }
        val disk = MemoryStore(); val journal = SeekerAuctionJournal(disk, WALLET, ORIGIN, "devnet")
        journal.add(SeekerAuctionAttempt("11111111-1111-4111-8111-111111111111", SeekerAuctionKind.BID, "0", 1, "20000000", BLOCKHASH, "11"))
        assertThrows(IllegalArgumentException::class.java) { SeekerAuctionJournal(disk, WALLET, "https://another.invalid", "devnet").read() }
        assertThrows(IllegalArgumentException::class.java) { SeekerAuctionJournal(disk, RIVAL, ORIGIN, "devnet").read() }
        assertEquals(1, journal.read().size)
    }

    @Test fun `a saved signature and reviewed amount cannot be rewritten by a stale callback`() {
        val journal = SeekerAuctionJournal(MemoryStore(), WALLET, ORIGIN, "devnet")
        val saved = SeekerAuctionAttempt("22222222-2222-4222-8222-222222222222", SeekerAuctionKind.BID, "0", 1, "20000000", BLOCKHASH, "11")
        journal.add(saved)
        assertThrows(IllegalArgumentException::class.java) { journal.replace(saved, saved.copy(newTotalRaw = "90000000")) }
        val signed = saved.copy(signature = SIG, opaqueSend = true); journal.replace(saved, signed)
        assertThrows(IllegalArgumentException::class.java) { journal.replace(saved, saved.copy(signature = OTHER_SIG)) }
        assertThrows(IllegalArgumentException::class.java) { journal.replace(signed, signed.copy(signature = OTHER_SIG)) }
        assertEquals(listOf(signed), journal.read())
    }

    @Test fun `pins are dark unless the debug build type carries all three canonical values`() {
        assertEquals(SeekerAuctionPins(PROGRAM, MINT, 6), seekerAuctionPinsFrom("debug", PROGRAM, MINT, "6"))
        assertNull("a release build never signs for a test deployment", seekerAuctionPinsFrom("release", PROGRAM, MINT, "6"))
        assertNull(seekerAuctionPinsFrom("debug", "", MINT, "6"))
        assertNull(seekerAuctionPinsFrom("debug", PROGRAM, "", "6"))
        assertNull(seekerAuctionPinsFrom("debug", PROGRAM, MINT, ""))
        assertNull(seekerAuctionPinsFrom("debug", PROGRAM, PROGRAM, "6"))
        assertNull(seekerAuctionPinsFrom("debug", "0OIl" + PROGRAM.drop(4), MINT, "6"))
        listOf("06", "20", "-1", "6.0").forEach { assertNull(it, seekerAuctionPinsFrom("debug", PROGRAM, MINT, it)) }
    }

    @Test fun `the protocol policy comes only from the catalogue's canonical keys`() {
        assertEquals(SeekerAuctionProtocolPolicy(3, 1, 3, 2, 2), seekerAuctionProtocolPolicy(CATALOGUE))
        val constants = CATALOGUE.getValue("constants").jsonObject
        assertNull(seekerAuctionProtocolPolicy(buildJsonObject { put("constants", JsonObject(constants - "PHASE_E_SEEKER_AUCTION_RUNTIME")) }))
        assertNull(seekerAuctionProtocolPolicy(buildJsonObject { put("constants", JsonObject(constants +
            ("PHASE_E_SEEKER_AUCTION" to buildJsonObject { put("regularRealmCount", "2") }))) }))
        assertNull(seekerAuctionProtocolPolicy(null))
    }

    @Test fun `without catalogue rules a refresh reads nothing and says it cannot reach the auction`() = runTest {
        val f = Fixture { testScheduler.currentTime }; val repo = f.repository(catalogue = null)
        repo.refresh()
        assertTrue(repo.state.value.readFailed); assertTrue(f.events.isEmpty())
    }
}
