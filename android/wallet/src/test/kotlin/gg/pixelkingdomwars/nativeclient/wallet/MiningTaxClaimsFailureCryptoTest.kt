package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.mining.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsFailureCryptoTest {
    private val raw get() = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-crypto.json")).readText()).jsonObject
    private val policy get() = MiningTaxClaimsSigningPolicy(raw.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
    private fun recovery(mode: String) = MiningTaxClaimsRecoveryEnvelope.from(raw.getValue("recoveries").jsonObject.getValue(mode).jsonObject)
    private fun fixture(mode: String = "claim", ordinals: List<Int> = listOf(0)): MiningTaxClaimsFailureEnvelope {
        val r = recovery(mode).copy(status = "signed", settlement = null); val p = r.preparation!!; val s = p.source; val i = p.identity
        val slot = maxOf(s.snapshotSlot, s.blockhashSlot) + 1
        return MiningTaxClaimsFailureEnvelope(r, ordinals.map { ordinal -> val w = r.wires.single { it.ordinal == ordinal.toLong() }
            MiningTaxClaimsFailure(p.wallet, p.idempotencyKey, p.claimId, ordinal.toLong(), MiningTaxClaimsFailureReceipt(1, p.wallet, p.idempotencyKey, p.claimId,
                p.round, p.spot, ordinal.toLong(), w.kind, w.signature, w.messageSha256, w.wireSha256, slot, p.snapshot.unixTimestamp.toLong(),
                "18446744073709551615", "0", "0", MiningTaxClaimsFailureSource("trusted-finalized-rpc-reviewed-program", i.genesisHash, i.programId, i.configAddress,
                    s.reviewedDeploymentSlot, s.reviewedProgramDataSha256, s.snapshotSha256, s.snapshotSlot, s.blockhashSlot, slot + 1),
                "failed", true, false, false, false, false), "2020-01-01T00:00:00.000000Z", true, false)
        })
    }
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun hash(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun local(f: MiningTaxClaimsFailureEnvelope): MiningTaxClaimsLocalEvidence {
        val p = f.recovery.preparation!!
        return MiningTaxClaimsLocalEvidence(p.wallet, MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps), p,
            f.recovery.wires.map { MiningTaxClaimsLocalWire(it.ordinal.toInt(), Base64.getEncoder().encodeToString(bytes(it.signedTransactionHex)), it.signature, it.messageSha256, it.wireSha256) })
    }
    private fun trust(p: MiningTaxClaimsPreparation) = MiningTaxClaimsSigningTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress,
        p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
    private suspend fun bind(f: MiningTaxClaimsFailureEnvelope = fixture(), l: MiningTaxClaimsLocalEvidence = local(f), t: MiningTaxClaimsSigningTrust = trust(l.preparation)) = MiningTaxClaimsFailureCrypto.bind(l, f, t, policy)
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue(runCatching { block() }.isFailure) }
    @Test fun `five actual public packet fixtures bind failure with uncapped fees and no finality or clearing authority`() = runBlocking {
        for (mode in listOf("claim", "combined", "split", "setup", "aboveQuote")) {
            val f = fixture(mode); val bound = bind(f); assertEquals(f, bound.envelope)
            assertFalse(bound.nativeFinalityVerified); assertFalse(bound.currentSigningAuthorized); assertFalse(bound.broadcastAuthorized); assertFalse(bound.journalClearingAuthorized)
        }
    }
    @Test fun `sparse ordinal one is failure evidence without invented setup or whole plan closure`() = runBlocking {
        val f = fixture("split", listOf(1)); val sparse = f.copy(recovery = f.recovery.copy(wires = f.recovery.wires.drop(1)))
        assertNull(bind(sparse).envelope.recovery.settlement); assertFalse(bind(sparse).journalClearingAuthorized)
        assertEquals(2, bind(fixture("split", listOf(0, 1))).envelope.failures.size)
    }
    @Test fun `setup plus failed claim requires the entire locally signed successful prefix`() = runBlocking {
        val f = fixture("split", listOf(1)).copy(recovery = recovery("setup")); val saved = local(f)
        assertEquals("setup", bind(f).envelope.recovery.status)
        refuses { bind(f, saved.copy(wires = saved.wires.drop(1))) }
        refuses { bind(fixture("split", listOf(0, 1)).copy(recovery = recovery("setup"))) }
    }
    @Test fun `every failed ordinal needs local consent and exact saved actor request and preparation`() = runBlocking {
        val f = fixture(); val l = local(f)
        refuses { bind(f.copy(failures = emptyList())) }; refuses { bind(f, l.copy(wires = emptyList())) }
        refuses { bind(f, l.copy(wallet = l.preparation.identity.keepMint)) }
        refuses { bind(f, l.copy(request = l.request.copy(round = "999"))) }
        refuses { bind(f.copy(recovery = f.recovery.copy(preparation = l.preparation.copy(caps = l.preparation.caps.copy(maxFeeLamports = "99999")))), l) }
    }
    @Test fun `all independent historical deployment pins remain mandatory`() = runBlocking {
        val f = fixture(); val l = local(f); val t = trust(l.preparation); val other = "11111111111111111111111111111111"
        for (wrong in listOf(t.copy(genesisHash = other), t.copy(programId = other), t.copy(configAddress = other), t.copy(keepMint = other), t.copy(reserveOwner = other), t.copy(reviewedDeploymentSlot = 0), t.copy(reviewedProgramDataSha256 = "ab".repeat(32)))) refuses { bind(f, l, wrong) }
    }
    @Test fun `jointly recomposed signature and digest declarations cannot replace Ed25519 verification`() = runBlocking {
        val f = fixture(); val w = f.recovery.wires.single(); val packet = bytes(w.signedTransactionHex); packet[1] = (packet[1].toInt() xor 1).toByte()
        val signature = base58(packet.copyOfRange(1, 65)); val digest = hash(packet)
        val forged = f.copy(recovery = f.recovery.copy(wires = listOf(w.copy(signedTransactionHex = hex(packet), signature = signature, wireSha256 = digest))),
            failures = f.failures.map { it.copy(receipt = it.receipt.copy(signature = signature, signedTransactionSha256 = digest)) })
        forged.validate(); refuses { bind(forged) }
    }
    @Test fun `adjacent server custody is verified even when it has no local failure or wire`() = runBlocking {
        val f = fixture("split"); val w = f.recovery.wires[1]; val packet = bytes(w.signedTransactionHex); packet[1] = (packet[1].toInt() xor 1).toByte()
        val forged = f.copy(recovery = f.recovery.copy(wires = listOf(f.recovery.wires[0], w.copy(signedTransactionHex = hex(packet), signature = base58(packet.copyOfRange(1, 65)), wireSha256 = hash(packet)))))
        forged.validate(); refuses { bind(forged, local(f).copy(wires = local(f).wires.take(1))) }
    }
    @Test fun `canonical local packets and bounded ordered collections refuse malformed custody before traversal`() = runBlocking {
        val f = fixture(); val l = local(f); val w = l.wires.single()
        for (wire in listOf(w.wire + "\n", w.wire.dropLast(1), "A".repeat(1648))) refuses { bind(f, l.copy(wires = listOf(w.copy(wire = wire)))) }
        refuses { bind(f, l.copy(wires = listOf(w, w))) }
        val hostile = object : AbstractList<MiningTaxClaimsLocalWire>() { override val size = 10000; override fun get(index: Int): MiningTaxClaimsLocalWire = error("Must not inspect") }
        refuses { bind(f, l.copy(wires = hostile)) }
    }
    @Test fun `bound evidence owns immutable copies of failure custody and preparation collections`() = runBlocking {
        val f = fixture("split", listOf(0, 1)); val failures = f.failures.toMutableList(); val wires = f.recovery.wires.toMutableList(); val txs = f.recovery.preparation!!.transactions.toMutableList()
        val r = f.recovery.copy(wires = wires, preparation = f.recovery.preparation!!.copy(transactions = txs)); val bound = bind(f.copy(recovery = r, failures = failures))
        failures.clear(); wires.clear(); txs.clear(); assertEquals(f, bound.envelope)
        assertThrows(UnsupportedOperationException::class.java) { (bound.envelope.failures as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (bound.envelope.recovery.preparation!!.transactions as MutableList).clear() }
        Unit
    }
}
