package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsControls
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.PreparedMiningClaim
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit), case (a): a KEEP claim whose prepare POST was lost before the server saw it
 *  has no preparation and no refusal, so nothing could ever retire it and the Gold Forge claim stayed shut. CLOSE makes
 *  a fresh by-key preparation read and archives the request only when that read answers `unknown` for its key. */
class MiningClaimsCloseTest {
    private class Fixture {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/mining-claim-journal-fixture.json")).bufferedReader().use { it.readText() }).jsonObject
        val policy = MiningClaimsProtocolPolicy(9, 1, 120)
        val p = MiningClaimPreparationView.from(raw.getValue("preparation").jsonObject, policy)
        val pins = p.identity.let { MiningClaimSigningTrust(it.genesisHash, it.programId, it.configAddress, it.keepMint, it.reserveOwner) }
        val memory = MemoryStore(); val identity = StarterIdentity("https://game.test", "devnet", p.wallet)
        var prepared = false; var prepares = 0; var preparationReads = 0
        fun store() = MiningClaimsStore(memory, identity)
        fun status() = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), p.wallet, "shardkeep-economy", p.identity.programId, p.identity.keepMint,
            "ready", null, p.rootSequence, "80", "0", "80", 9, 200, "7200", "7200", true, true, true, false, p.serverNow)
        val ports = object : MiningClaimsPorts {
            override fun capture(newAction: Boolean): () -> Unit = {}
            override fun policy() = policy
            override fun trust() = pins
            override fun key() = p.idempotencyKey
            override fun clockMs() = 0L
            override suspend fun status(guard: () -> Unit) = status().also { guard() }
            override suspend fun prepare(request: MiningClaimPrepareRequest, guard: () -> Unit, retain: (MiningClaimPreparationView) -> Unit, refusal: (MiningClaimPrepareRefusal) -> Unit): MiningClaimPreparationView {
                prepares++; throw IOException("lost before the server saw it")
            }
            override suspend fun preparation(key: String, guard: () -> Unit, retain: (MiningClaimPreparationEnvelope) -> Unit): MiningClaimPreparationEnvelope {
                assertEquals(p.idempotencyKey, key); preparationReads++
                val result = MiningClaimPreparationEnvelope(p.wallet, key, if (prepared) "prepared" else "unknown", if (prepared) p else null, p.serverNow)
                retain(result); guard(); return result
            }
            override suspend fun claim(id: String, guard: () -> Unit, retain: (MiningClaimView) -> Unit): MiningClaimView { error("No claim exists without a preparation.") }
            override suspend fun live(preparation: MiningClaimPreparationView, guard: () -> Unit) { error("CLOSE never checks a transaction.") }
            override suspend fun sign(prepared: PreparedMiningClaim, guard: () -> Unit, retain: (MiningClaimSavedWire) -> Unit) { error("CLOSE never opens the wallet.") }
            override suspend fun submit(request: MiningClaimSubmitRequest, guard: () -> Unit): MiningClaimSubmitResponse { error("CLOSE never submits.") }
        }
        fun repo() = MiningClaimsRepository(store(), ports)
        suspend fun stuck(): MiningClaimsRepository {
            assertTrue(runCatching { repo().begin() }.isFailure)
            val op = store().read().operation!!; assertTrue(op.prepareAttempted); assertNull(op.preparation); assertNull(op.prepareRefusal)
            return repo().also { it.open() }
        }
    }

    @Test fun `a saved KEEP claim the server does not know cannot block the Gold Forge claim forever`() = runBlocking {
        val f = Fixture(); val r = f.stuck()
        assertFalse(miningClaimsControls(r.state.value, true).begin)
        assertTrue(miningClaimsControls(r.state.value, true).archiveAbsent)
        assertTrue("a new claim is refused while the request is saved", runCatching { r.begin() }.isFailure)
        assertTrue("the request cannot be reviewed without a preparation", runCatching { r.review() }.isFailure)
        val reads = f.preparationReads
        r.archiveAbsent()
        assertTrue("CLOSE made its own fresh by-key read", f.preparationReads > reads)
        assertNull(f.store().read().operation); assertTrue(f.store().read().archives.single().absenceConfirmed)
        assertEquals("CLOSE never prepares again", 1, f.prepares)
        val reopened = f.repo(); reopened.open()
        assertTrue(miningClaimsControls(reopened.state.value, true).begin)
    }

    @Test fun `close is refused when the server shows the KEEP claim preparation`() = runBlocking {
        val f = Fixture(); val r = f.stuck(); f.prepared = true
        assertTrue(runCatching { r.archiveAbsent() }.isFailure)
        assertEquals(f.p, f.store().read().operation!!.preparation); assertTrue(f.store().read().archives.isEmpty()); assertEquals(1, f.prepares)
    }
}
