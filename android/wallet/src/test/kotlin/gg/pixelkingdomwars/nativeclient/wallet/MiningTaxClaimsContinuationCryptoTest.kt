package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.mining.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsContinuationCryptoTest {
    private fun envelope() = MiningTaxClaimsContinuationEnvelope.from(Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-continuation.json")).readText()).jsonObject)
    private val policy get() = MiningTaxClaimsSigningPolicy(Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-crypto.json")).readText()).jsonObject.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun hex(v: ByteArray) = v.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun hash(v: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(v))
    private class F(val e: MiningTaxClaimsContinuationEnvelope) {
        val c = requireNotNull(e.continuation); val p = c.parentPreparation; val w = c.parentWire
        val request = MiningTaxClaimsContinuationRequest(c.childPreparation.idempotencyKey, c.childPreparation.caps)
        val setup = MiningTaxClaimsRecoveryEnvelope(p.wallet, p.idempotencyKey, p.claimId, "setup", p, listOf(w), c.parentSetup, p.preparedAt)
        val local = MiningTaxClaimsLocalEvidence(p.wallet, MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps), p,
            listOf(MiningTaxClaimsLocalWire(0, Base64.getEncoder().encodeToString(w.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()), w.signature, w.messageSha256, w.wireSha256)))
        val trust = MiningTaxClaimsSigningTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress, p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
    }
    private suspend fun bind(f: F = F(envelope()), local: MiningTaxClaimsLocalEvidence = f.local, setup: MiningTaxClaimsRecoveryEnvelope = f.setup,
        request: MiningTaxClaimsContinuationRequest = f.request, trust: MiningTaxClaimsSigningTrust = f.trust) = MiningTaxClaimsContinuationCrypto.bind(local, setup, request, f.e, trust, policy)
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue(runCatching { block() }.isFailure) }
    @Test fun `actual immutable link binds historical paid setup and unsigned child without granting authority`() = runBlocking {
        val f = F(envelope()); val bound = bind(f); assertEquals(f.e, bound.envelope)
        assertEquals("6", bound.envelope.continuation!!.parentSetup.receipt.feeLamports)
        assertFalse(bound.nativeFinalityVerified); assertFalse(bound.currentSigningAuthorized); assertFalse(bound.broadcastAuthorized)
        assertFalse(bound.relayAuthorized); assertFalse(bound.settlementAuthorized); assertFalse(bound.journalClearingAuthorized)
    }
    @Test fun `positive link exact saved setup and explicit additional child caps are all mandatory`() = runBlocking {
        val f = F(envelope()); refuses { MiningTaxClaimsContinuationCrypto.bind(f.local, f.setup, f.request, f.e.copy(status = "unknown", continuation = null), f.trust, policy) }
        refuses { bind(f, setup = f.setup.copy(status = "signed", settlement = null)) }
        refuses { bind(f, setup = f.setup.copy(settlement = f.c.parentSetup.copy(settledAt = "2026-09-27T00:00:00.000000Z"))) }
        refuses { bind(f, request = f.request.copy(idempotencyKey = f.p.idempotencyKey)) }
        for (caps in listOf(f.request.caps.copy(maxFeeLamports = "11"), f.request.caps.copy(maxRentLamports = "1001"), f.request.caps.copy(maxTotalLamports = "1011"))) refuses { bind(f, request = f.request.copy(caps = caps)) }
    }
    @Test fun `local actor intent original preparation and signed prefix cannot be substituted`() = runBlocking {
        val f = F(envelope())
        refuses { bind(f, local = f.local.copy(wallet = f.p.identity.keepMint)) }
        refuses { bind(f, local = f.local.copy(request = f.local.request.copy(round = "999"))) }
        refuses { bind(f, local = f.local.copy(preparation = f.p.copy(source = f.p.source.copy(snapshotSha256 = "ab".repeat(32))))) }
        refuses { bind(f, local = f.local.copy(wires = emptyList())) }
    }
    @Test fun `jointly replaced signature and digests still require valid original Ed25519`() = runBlocking {
        val f = F(envelope()); val b = bytes(f.w.signedTransactionHex); b[1] = (b[1].toInt() xor 1).toByte()
        val sig = base58(b.copyOfRange(1, 65)); val sha = hash(b)
        val wire = f.w.copy(signedTransactionHex = hex(b), signature = sig, wireSha256 = sha)
        val setup = f.c.parentSetup.copy(receipt = f.c.parentSetup.receipt.copy(transactions = f.c.parentSetup.receipt.transactions.map { it.copy(signature = sig, signedTransactionSha256 = sha) }))
        val changed = F(f.e.copy(continuation = f.c.copy(parentWire = wire, parentSetup = setup)))
        changed.e.validate(); refuses { bind(changed) }
    }
    @Test fun `child declared hash and correctly hashed message replacement cannot bypass canonical ABI`() = runBlocking {
        val f = F(envelope()); val p = f.c.childPreparation; val tx = p.transactions.single()
        refuses { bind(F(f.e.copy(continuation = f.c.copy(childPreparation = p.copy(transactions = listOf(tx.copy(messageSha256 = "ab".repeat(32)))))))) }
        val b = bytes(tx.messageHex); b[b.lastIndex] = (b.last().toInt() xor 1).toByte()
        val changed = f.e.copy(continuation = f.c.copy(childPreparation = p.copy(transactions = listOf(tx.copy(messageHex = hex(b), messageSha256 = hash(b))))))
        changed.validate(); refuses { bind(F(changed)) }
    }
    @Test fun `jointly rewritten PDA identity and all independent deployment pins are checked`() = runBlocking {
        val f = F(envelope()); val other = "11111111111111111111111111111112"
        val parent = f.p.copy(identity = f.p.identity.copy(registry = other)); val child = f.c.childPreparation.copy(identity = f.c.childPreparation.identity.copy(registry = other))
        val changed = F(f.e.copy(continuation = f.c.copy(parentPreparation = parent, childPreparation = child)))
        changed.e.validate(); refuses { bind(changed) }
        val t = f.trust
        for (pin in listOf(t.copy(genesisHash = other), t.copy(programId = other), t.copy(configAddress = other), t.copy(keepMint = other), t.copy(reserveOwner = other), t.copy(reviewedDeploymentSlot = 0), t.copy(reviewedProgramDataSha256 = "ab".repeat(32)))) refuses { bind(f, trust = pin) }
    }
    @Test fun `local custody has canonical bytes ordered bounded rows and no traversal of oversized input`() = runBlocking {
        val f = F(envelope()); val w = f.local.wires.single()
        for (v in listOf(w.wire + "\n", w.wire.dropLast(1), "A".repeat(1648))) refuses { bind(f, local = f.local.copy(wires = listOf(w.copy(wire = v)))) }
        refuses { bind(f, local = f.local.copy(wires = listOf(w, w))) }
        val huge = object : AbstractList<MiningTaxClaimsLocalWire>() { override val size = 10000; override fun get(index: Int): MiningTaxClaimsLocalWire = error("Must not traverse") }
        refuses { bind(f, local = f.local.copy(wires = huge)) }
    }
    @Test fun `bound copies preserve setup and both immutable transaction lists`() = runBlocking {
        val f = F(envelope()); val parent = f.p.transactions.toMutableList(); val child = f.c.childPreparation.transactions.toMutableList(); val setup = f.c.parentSetup.receipt.transactions.toMutableList()
        val changed = F(f.e.copy(continuation = f.c.copy(parentPreparation = f.p.copy(transactions = parent), childPreparation = f.c.childPreparation.copy(transactions = child), parentSetup = f.c.parentSetup.copy(receipt = f.c.parentSetup.receipt.copy(transactions = setup)))))
        val bound = bind(changed); parent.clear(); child.clear(); setup.clear(); assertEquals(f.e, bound.envelope)
        assertThrows(UnsupportedOperationException::class.java) { (bound.envelope.continuation!!.childPreparation.transactions as MutableList).clear() }
        Unit
    }
}
