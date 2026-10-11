package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.GemsBuyIntent
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.wallet.ChainAddresses
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class GemsBuyStoresTest {
    private val origin = "https://localhost:18443"
    private val key = "native-gems-store-1"
    private fun draft(wallet: String = WALLET, apiOrigin: String = origin, cluster: String = "devnet") =
        GemsBuyDraft(wallet, apiOrigin, cluster, key, 17)
    private fun quote(d: GemsBuyDraft) = GemsBuyIntent(DEPOSIT_ID, "gems_buy", d.wallet, d.idempotencyKey,
        DEPOSIT_REFERENCE, DEPOSIT_SOURCE, DEPOSIT_DEST, ChainAddresses.DEVNET.keepMint, 9, d.keepIn, d.keepIn,
        "2026-09-21T12:30:00Z")

    @Test fun `same wallet reauthentication shares the original journal and its synchronization owner`() {
        var opens = 0
        val stores = GemsBuyStores { _, _, _ -> opens++; MemoryStore() }
        val holder = testHolder(); val first = signedIn(holder)
        val original = stores.forIdentity(first.origin, "devnet", first.wallet)
        val saved = original.begin(draft())
        val next = signedIn(holder)
        assertNotSame("Authentication sessions are replaceable", first, next)
        val recovered = stores.forIdentity(next.origin, "devnet", next.wallet)
        assertSame("The journal lock must survive replacement of the account session", original, recovered)
        assertEquals(saved, recovered.read()); assertEquals(1, opens)
        assertThrows(IllegalStateException::class.java) {
            recovered.begin(saved.draft.copy(idempotencyKey = "$key-next"))
        }
        assertEquals(saved, original.read())
    }

    @Test fun `origin cluster and wallet each select separate journals without changing another identity`() {
        val opened = mutableListOf<Triple<String, String, String>>()
        val stores = GemsBuyStores { apiOrigin, cluster, wallet ->
            opened += Triple(apiOrigin, cluster, wallet); MemoryStore()
        }
        val drafts = listOf(draft(), draft(apiOrigin = "https://qa.example.test"),
            draft(cluster = "mainnet-beta"), draft(wallet = DEPOSIT_REFERENCE))
        val owners = drafts.map { d -> stores.forIdentity(d.origin, d.cluster, d.wallet) }
        for (i in owners.indices) for (j in 0 until i) assertNotSame(owners[i], owners[j])
        val saved = drafts.mapIndexed { i, d -> owners[i].begin(d) }
        drafts.forEachIndexed { i, d ->
            assertSame(owners[i], stores.forIdentity(d.origin, d.cluster, d.wallet))
            assertEquals(saved[i], owners[i].read())
        }
        assertEquals(drafts.map { Triple(it.origin, it.cluster, it.wallet) }, opened)
    }

    private class PausedSecret : SecretStore {
        @Volatile private var value: String? = null
        val writing = CountDownLatch(1)
        val resume = CountDownLatch(1)
        override fun read() = value
        override fun write(value: String) {
            writing.countDown(); check(resume.await(5, TimeUnit.SECONDS))
            this.value = value
        }
        override fun clear() { value = null }
    }

    @Test fun `competing sessions cannot both admit a purchase while the first journal write is incomplete`() {
        val secret = PausedSecret(); val opens = AtomicInteger()
        val stores = GemsBuyStores { _, _, _ -> opens.incrementAndGet(); secret }
        val firstDraft = draft(); val secondDraft = firstDraft.copy(idempotencyKey = "$key-next")
        val executor = Executors.newFixedThreadPool(2)
        try {
            val first = executor.submit<SavedGemsBuy> {
                stores.forIdentity(origin, "devnet", WALLET).begin(firstDraft)
            }
            assertTrue(secret.writing.await(5, TimeUnit.SECONDS))
            val entered = CountDownLatch(1)
            val second = executor.submit<Boolean> {
                entered.countDown()
                try { stores.forIdentity(origin, "devnet", WALLET).begin(secondDraft); true }
                catch (_: IllegalStateException) { false }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertThrows(TimeoutException::class.java) { second.get(100, TimeUnit.MILLISECONDS) }
            secret.resume.countDown()
            assertEquals(firstDraft, first.get(5, TimeUnit.SECONDS).draft)
            assertFalse("A competing session must recover the admitted purchase", second.get(5, TimeUnit.SECONDS))
            assertEquals(firstDraft, stores.forIdentity(origin, "devnet", WALLET).read()!!.draft)
            assertEquals("One process-long lock owner per identity", 1, opens.get())
        } finally { secret.resume.countDown(); executor.shutdownNow() }
    }

    @Test fun `late original wallet signature is saved only to its original journal after account selection changes`() {
        val stores = GemsBuyStores { _, _, _ -> MemoryStore() }
        val holder = testHolder(); val originalSession = signedIn(holder)
        val original = stores.forIdentity(originalSession.origin, "devnet", originalSession.wallet)
        val originalDraft = draft(); original.begin(originalDraft)
        original.update(originalDraft) { it.copy(quote = quote(originalDraft), attempted = true, preparedLastValidHeight = 500) }
        // The wallet-return callback captures its immutable original draft and journal, never current account selection.
        val recordOriginalSignature = {
            original.update(originalDraft) { it.copy(signature = DEPOSIT_SIGNATURE, signatureUsesPreparedHeight = true) }
        }
        val selectedSession = signedIn(holder, DEPOSIT_REFERENCE)
        val selected = stores.forIdentity(selectedSession.origin, "devnet", selectedSession.wallet)
        val selectedSaved = selected.begin(draft(wallet = selectedSession.wallet))
        recordOriginalSignature()
        assertEquals(DEPOSIT_SIGNATURE, stores.forIdentity(origin, "devnet", originalSession.wallet).read()!!.signature)
        assertEquals(selectedSaved, selected.read())
        assertThrows(IllegalStateException::class.java) {
            selected.update(originalDraft) { it.copy(signature = DEPOSIT_SIGNATURE) }
        }
        assertEquals(selectedSaved, selected.read())
    }
}
