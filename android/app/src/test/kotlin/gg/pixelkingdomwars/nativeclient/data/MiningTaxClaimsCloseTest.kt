package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningTaxClaimsControls
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): a KEEP tax claim whose prepare POST was lost before the server recorded it
 *  keeps no preparation, so nothing could ever retire it and PREPARE KEEP CLAIM stayed shut. CLOSE re-reads the
 *  by-key preparation and archives the request only when that read answers `unknown` for exactly its key. */
class MiningTaxClaimsCloseTest {
    private fun repo(f: MiningTaxAppFixture) = MiningTaxClaimsRepository(f.store, object : MiningTaxClaimsPorts by f.ports() { override fun key() = f.p.idempotencyKey })
    /** The journal exactly as a lost prepare POST leaves it: begun and attempted, no preparation recovered. */
    private suspend fun stuck(f: MiningTaxAppFixture): MiningTaxClaimsRepository {
        f.store.begin(f.store.read(), MiningTaxClaimsPrepareRequest(f.p.idempotencyKey, f.p.round, f.p.spot, f.p.caps), f.totalSpots)
        f.store.prepareAttempt(f.store.read())
        return repo(f).also { it.open() }
    }
    private fun requests(f: MiningTaxAppFixture) = (0 until f.server.requestCount).map { f.server.takeRequest() }

    @Test fun `a saved KEEP tax claim the server does not know cannot block PREPARE KEEP CLAIM forever`() = runBlocking { MiningTaxAppFixture().use { f ->
        val r = stuck(f)
        assertFalse(miningTaxClaimsControls(r.state.value, true).begin); assertTrue(miningTaxClaimsControls(r.state.value, true).archiveAbsent)
        assertTrue("no approval exists without a preparation", runCatching { r.review(0) }.isFailure)
        r.archiveAbsent()
        assertNull(f.store.read().operation); assertEquals(listOf(f.p.idempotencyKey), f.store.read().archiveKeys)
        assertTrue(requireNotNull(r.archived(f.p.idempotencyKey)).operation.absenceConfirmed)
        val sent = requests(f)
        assertTrue("CLOSE never prepares, signs or submits", sent.none { it.method == "POST" })
        assertTrue("CLOSE made its own fresh by-key read", sent.last().path!!.endsWith("/claims/mining-tax/prepare/by-key/${f.p.idempotencyKey}"))
        r.open(); assertTrue(miningTaxClaimsControls(r.state.value, true).begin)
    } }

    @Test fun `close is refused when the server shows the KEEP tax claim preparation`() = runBlocking { MiningTaxAppFixture().use { f ->
        val r = stuck(f); f.prepared = true
        assertTrue(runCatching { r.archiveAbsent() }.isFailure)
        assertEquals(f.p, f.store.read().operation!!.preparation); assertTrue(f.store.read().archiveKeys.isEmpty())
        assertTrue(requests(f).none { it.method == "POST" })
    } }
}
