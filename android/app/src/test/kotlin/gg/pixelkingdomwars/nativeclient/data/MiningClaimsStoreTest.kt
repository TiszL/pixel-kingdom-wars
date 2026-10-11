package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningClaimsStoreTest {
    private class Fixture {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/mining-claim-journal-fixture.json")).bufferedReader().use { it.readText() }).jsonObject
        val policy = MiningClaimsProtocolPolicy(9, 1, 120)
        val preparation = MiningClaimPreparationView.from(raw.getValue("preparation").jsonObject, policy)
        val wire = raw.getValue("signed").jsonObject.getValue("wire").jsonPrimitive.content
        val signature = raw.getValue("signed").jsonObject.getValue("signature").jsonPrimitive.content
        val identity = StarterIdentity("https://game.test", "devnet", preparation.wallet)
        val memory = MemoryStore()
        fun store() = MiningClaimsStore(memory, identity)
        fun prepared(): MiningClaimsStore = store().also { s ->
            s.begin(s.read(), preparation.idempotencyKey, policy); s.prepareAttempt(s.read()); s.acceptPreparation(preparation.idempotencyKey, preparation)
        }
        fun signed(): MiningClaimsStore = prepared().also { s -> s.signingAttempt(s.read()); s.acceptSigned(preparation.idempotencyKey, wire) }
        fun claim(state: String = "settled") = MiningClaimView(1, preparation.wallet, preparation.claimId, state,
            if (state == "settled") "finalized" else "pending", signature, if (state == "settled") "80" else null,
            listOf(MiningClaimLanding(0, "combined", signature, if (state == "settled") "finalized" else "pending",
                if (state == "settled") "80" else null, preparation.serverNow, if (state == "settled") preparation.serverNow else null)), preparation.serverNow, false)
    }
    private fun refuses(block: () -> Unit) { assertTrue(runCatching(block).isFailure) }

    @Test fun `verified failure is immutable unpaid original evidence and archives only with matching proof`() {
        val f = Fixture(); val s = f.signed()
        val failed = f.claim().copy(state = "failed", landing = "failed", settledBaseUnits = null,
            transactions = f.claim().transactions.map { it.copy(landing = "failed", settledBaseUnits = null) })
        s.acceptClaim(f.preparation.idempotencyKey, failed); val original = s.read()
        assertNull(original.operation!!.claim!!.settledBaseUnits)
        refuses { s.signingAttempt(original) }; refuses { s.submitAttempt(original) }; refuses { s.finish(original) }
        for (bad in listOf(f.claim("retained"), f.claim(), failed.copy(transactions = failed.transactions.map { it.copy(settledAt = "2035-01-01T00:00:01.000Z") }))) {
            refuses { s.acceptClaim(f.preparation.idempotencyKey, bad) }; refuses { s.archiveFailed(original, bad) }
        }
        assertEquals(original, s.read())
        s.archiveFailed(original, failed.copy(serverNow = "2035-01-01T00:00:02.000Z"))
        val history = f.store().read(); assertNull(history.operation); assertEquals(f.wire, history.archives.single().signed!!.wire)
        assertEquals(failed, history.archives.single().claim)
        s.begin(history, UUID.randomUUID().toString(), f.policy); assertEquals(history.archives, s.read().archives)
    }
    @Test fun `failure cannot replace a paid receipt or hide another signature and ambiguous history fails closed`() {
        val f = Fixture(); val s = f.signed()
        val failed = f.claim().copy(state = "failed", landing = "failed", settledBaseUnits = null,
            transactions = f.claim().transactions.map { it.copy(landing = "failed", settledBaseUnits = null) })
        val other = "1".repeat(63) + "2"
        refuses { s.acceptClaim(f.preparation.idempotencyKey, failed.copy(signature = other, transactions = failed.transactions.map { it.copy(signature = other) })) }
        refuses { s.archiveFailed(s.read(), failed) }
        s.acceptClaim(f.preparation.idempotencyKey, f.claim()); refuses { s.acceptClaim(f.preparation.idempotencyKey, failed) }
        s.finish(s.read()); val encoded = requireNotNull(f.memory.value)
        f.memory.value = encoded.replace("\"state\":\"settled\"", "\"state\":\"failed\"")
        refuses { f.store().read() }
    }
    @Test fun `split failure preserves each terminal ordinal but cannot archive before another ordinal appears`() {
        val f = Fixture(); val s = f.store(); val p = f.preparation; val first = p.transactions.single()
        val fee = first.feeLamports.toBigInteger().multiply(java.math.BigInteger.TWO).toString()
        val split = p.copy(transactions = listOf(first.copy(kind = "setup"), first.copy(ordinal = 1, kind = "claim", rentLamports = "0")),
            fees = p.fees.copy(feeLamports = fee, totalLamports = (fee.toBigInteger() + p.fees.rentLamports.toBigInteger()).toString()))
        s.begin(s.read(), p.idempotencyKey, f.policy); s.prepareAttempt(s.read()); s.acceptPreparation(p.idempotencyKey, split)
        val failedSetup = MiningClaimLanding(0, "setup", f.signature, "failed", null, p.serverNow, p.serverNow)
        val pendingClaim = MiningClaimLanding(1, "claim", null, "pending", null, null, null)
        val failed = f.claim().copy(state = "failed", landing = "failed", settledBaseUnits = null, transactions = listOf(failedSetup, pendingClaim))
        s.acceptClaim(p.idempotencyKey, failed); refuses { s.archiveFailed(s.read(), failed) }
        val signature = "1".repeat(63) + "2"
        val pending = failed.copy(state = "retained", landing = "pending", signature = signature,
            transactions = listOf(failedSetup, pendingClaim.copy(signature = signature, acceptedAt = p.serverNow)))
        s.acceptClaim(p.idempotencyKey, pending)
        val paid = pending.copy(state = "settled", landing = "finalized", settledBaseUnits = "80",
            transactions = listOf(failedSetup, pending.transactions[1].copy(landing = "finalized", settledBaseUnits = "80", settledAt = p.serverNow)))
        s.acceptClaim(p.idempotencyKey, paid); assertEquals(failedSetup, s.read().operation!!.claim!!.transactions.first())
        s.finish(s.read()); assertEquals(paid, f.store().read().archives.single().claim)
    }

    @Test fun `full signed bytes survive encrypted source reload and acknowledgement alone cannot archive`() {
        val f = Fixture(); val s = f.signed(); s.submitAttempt(s.read()); val saved = f.store().read()
        assertEquals(f.wire, saved.operation!!.signed!!.wire); assertEquals(f.signature, saved.operation!!.signed!!.signature)
        refuses { s.finish(saved) }; assertEquals(saved, f.store().read())
        s.acceptClaim(f.preparation.idempotencyKey, f.claim()); val settled = s.read(); s.finish(settled)
        val archived = f.store().read(); assertNull(archived.operation); assertEquals(f.wire, archived.archives.single().signed!!.wire)
        refuses { s.begin(archived, f.preparation.idempotencyKey, f.policy) }
        s.begin(archived, UUID.randomUUID().toString(), f.policy); assertEquals(archived.archives, s.read().archives)
    }
    @Test fun `each original side effect requires its separate durable marker and exact CAS`() {
        val f = Fixture(); val s = f.store(); val empty = s.read(); s.begin(empty, f.preparation.idempotencyKey, f.policy)
        refuses { s.begin(empty, UUID.randomUUID().toString(), f.policy) }
        refuses { s.acceptPreparation(f.preparation.idempotencyKey, f.preparation) }
        refuses { s.signingAttempt(s.read()) }; refuses { s.submitAttempt(s.read()) }
        val draft = s.read(); s.prepareAttempt(draft); refuses { s.prepareAttempt(s.read()) }
        s.acceptPreparation(f.preparation.idempotencyKey, f.preparation)
        refuses { s.acceptSigned(f.preparation.idempotencyKey, f.wire) }
        s.signingAttempt(s.read()); s.acceptSigned(f.preparation.idempotencyKey, f.wire)
        s.submitAttempt(s.read()); refuses { s.submitAttempt(s.read()) }; refuses { s.signingAttempt(draft) }
    }
    @Test fun `late evidence binds original identity while recovered server time cannot rewrite quote`() {
        val f = Fixture(); val s = f.prepared(); val initial = s.read().operation!!.preparation!!
        s.acceptPreparation(f.preparation.idempotencyKey, initial.copy(serverNow = "2035-01-01T00:00:01.000Z"))
        assertEquals(initial, s.read().operation!!.preparation)
        refuses { s.acceptPreparation(f.preparation.idempotencyKey, initial.copy(root = "aa".repeat(32))) }
        refuses { s.acceptPreparation(UUID.randomUUID().toString(), initial) }
        s.signingAttempt(s.read()); f.store().acceptSigned(f.preparation.idempotencyKey, f.wire)
        assertEquals(f.wire, s.read().operation!!.signed!!.wire)
        refuses { MiningClaimsStore(f.memory, f.identity.copy(cluster = "mainnet-beta")).read() }
        refuses { MiningClaimsStore(f.memory, f.identity.copy(origin = "https://other.test")).read() }
    }
    @Test fun `corrupt foreign oversized unsigned and wallet mutated bytes never become saved evidence`() {
        val f = Fixture(); val s = f.prepared(); s.signingAttempt(s.read())
        val wire = Base64.getDecoder().decode(f.wire)
        for (bad in listOf("A".repeat(2000), Base64.getEncoder().encodeToString(wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }),
            Base64.getEncoder().encodeToString(wire.copyOf().also { it.fill(0, 1, 65) }),
            Base64.getEncoder().encodeToString(wire.copyOf().also { it[it.lastIndex] = 1 }))) refuses { s.acceptSigned(f.preparation.idempotencyKey, bad) }
        assertNull(s.read().operation!!.signed)
    }
    @Test fun `positive receipt from another device does not forge local attempt markers and cannot regress`() {
        val f = Fixture(); val s = f.prepared(); s.acceptClaim(f.preparation.idempotencyKey, f.claim("retained"))
        assertFalse(s.read().operation!!.signingStarted); assertNull(s.read().operation!!.signed); assertFalse(s.read().operation!!.submitAttempted)
        s.acceptClaim(f.preparation.idempotencyKey, f.claim()); val settled = s.read()
        refuses { s.acceptClaim(f.preparation.idempotencyKey, f.claim("retained")) }
        refuses { s.acceptClaim(f.preparation.idempotencyKey, f.claim().copy(transactions = f.claim().transactions.map { it.copy(settledAt = "2035-01-01T00:00:01.000Z") })) }
        assertEquals(settled, s.read())
        s.finish(settled); assertEquals(f.signature, s.read().archives.single().claim!!.signature)
    }
    @Test fun `only definitive first prepare refusal plus fresh matching absence can archive`() {
        val f = Fixture(); val s = f.store(); s.begin(s.read(), f.preparation.idempotencyKey, f.policy); s.prepareAttempt(s.read())
        refuses { s.prepareRefused(f.preparation.idempotencyKey, MiningClaimPrepareRefusal(503, "CLAIM_UNAVAILABLE")) }
        val absent = MiningClaimPreparationEnvelope(f.identity.wallet, f.preparation.idempotencyKey, "unknown", null, f.preparation.serverNow)
        refuses { s.archiveRefusal(s.read(), absent) }
        s.prepareRefused(f.preparation.idempotencyKey, MiningClaimPrepareRefusal(422, "INSUFFICIENT_SOL"))
        val expected = s.read(); refuses { s.archiveRefusal(expected, absent.copy(idempotencyKey = UUID.randomUUID().toString())) }
        s.archiveRefusal(expected, absent); assertTrue(s.read().archives.single().refusalConfirmedAbsent)
        refuses { s.begin(s.read(), f.preparation.idempotencyKey, f.policy) }
    }
    @Test fun `malformed or unreadable storage fails closed and no failed write advances durable intent`() {
        val f = Fixture(); val s = f.prepared(); val original = f.memory.value!!
        for (bad in listOf("{}", original.replace("\"prepareAttempted\":true", "\"prepareAttempted\":\"true\""),
            original.replace("\"revision\":3", "\"revision\":\"3\""))) {
            f.memory.value = bad; refuses { s.read() }; refuses { s.begin(MiningClaimsJournal(1, f.identity, 0, null, emptyList()), UUID.randomUUID().toString(), f.policy) }
        }
        f.memory.value = original
        val broken = object : SecretStore { override fun read() = original; override fun write(value: String) { throw IllegalStateException("storage full") }; override fun clear() { error("never clear") } }
        refuses { MiningClaimsStore(broken, f.identity).signingAttempt(s.read()) }; assertFalse(s.read().operation!!.signingStarted)
    }
    @Test fun `reused blockhash is definitive only for first prepare conflict and confirmed absence preserves its history`() {
        val f = Fixture(); val s = f.store(); s.begin(s.read(), f.preparation.idempotencyKey, f.policy); s.prepareAttempt(s.read())
        refuses { s.prepareRefused(f.preparation.idempotencyKey, MiningClaimPrepareRefusal(503, "CLAIM_BLOCKHASH_REUSED")) }
        s.prepareRefused(f.preparation.idempotencyKey, MiningClaimPrepareRefusal(409, "CLAIM_BLOCKHASH_REUSED"))
        refuses { s.finish(s.read()) }
        val absent = MiningClaimPreparationEnvelope(f.identity.wallet, f.preparation.idempotencyKey, "unknown", null, f.preparation.serverNow)
        s.archiveRefusal(s.read(), absent)
        assertTrue(f.store().read().archives.single().refusalConfirmedAbsent)
        assertEquals("CLAIM_BLOCKHASH_REUSED", f.store().read().archives.single().prepareRefusal!!.code)
    }
    @Test fun `paid split claim accepts later setup failure and preserves that fresh terminal receipt in history`() {
        val f = Fixture(); val s = f.store(); val p = f.preparation; val first = p.transactions.single()
        val fee = first.feeLamports.toBigInteger().multiply(java.math.BigInteger.TWO).toString()
        val split = p.copy(transactions = listOf(first.copy(kind = "setup"), first.copy(ordinal = 1, kind = "claim", rentLamports = "0")),
            fees = p.fees.copy(feeLamports = fee, totalLamports = (fee.toBigInteger() + p.fees.rentLamports.toBigInteger()).toString()))
        s.begin(s.read(), p.idempotencyKey, f.policy); s.prepareAttempt(s.read()); s.acceptPreparation(p.idempotencyKey, split)
        val setup = MiningClaimLanding(0, "setup", "1".repeat(63) + "2", "pending", null, p.serverNow, null)
        val claim = f.claim().transactions.single().copy(ordinal = 1, kind = "claim")
        val paid = f.claim().copy(transactions = listOf(setup, claim)); s.acceptClaim(p.idempotencyKey, paid)
        val complete = paid.copy(transactions = listOf(setup.copy(landing = "failed", settledAt = p.serverNow), claim))
        s.acceptClaim(p.idempotencyKey, complete); assertEquals("80", s.read().operation!!.claim!!.settledBaseUnits)
        s.finish(s.read()); assertEquals(complete, f.store().read().archives.single().claim)
    }
}
