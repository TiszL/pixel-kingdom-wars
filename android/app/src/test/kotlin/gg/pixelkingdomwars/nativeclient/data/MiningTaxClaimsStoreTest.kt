package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsStoreTest {
    companion object {
        private val ids = AtomicInteger()
        private var digestProvider = ""
        private val digestObservation = java.util.concurrent.atomic.AtomicReference<(() -> Unit)?>(null)
    }
    class ObservingDigest : java.security.MessageDigestSpi() {
        private val original = MessageDigest.getInstance("SHA-256", digestProvider)
        override fun engineUpdate(input: Byte) = original.update(input)
        override fun engineUpdate(input: ByteArray, offset: Int, len: Int) = original.update(input, offset, len)
        override fun engineDigest(): ByteArray { digestObservation.getAndSet(null)?.invoke(); return original.digest() }
        override fun engineReset() = original.reset()
    }
    private class Memory : SecretStore {
        var value: String? = null; var failRead = false; var failWrite = false; var writes = 0; var afterRead: (() -> Unit)? = null; var afterWrite: () -> Unit = {}
        override fun read(): String? { if (failRead) throw IOException("locked"); val v = value; afterRead?.also { afterRead = null; it() }; return v }
        override fun write(value: String) { if (failWrite) throw IOException("full"); this.value = value; writes++; afterWrite() }
        override fun clear() = error("Tax history may not be cleared")
    }
    /** Real JVM AES-GCM/file replacement fixture. AndroidKeyStore is not available
     * in these JVM tests, so this does not certify the production device provider. */
    private class AesFile(val file: java.io.File, val key: SecretKey) : SecretStore {
        var failBeforeReplace = false
        override fun read(): String? {
            if (!file.exists()) return null
            val bytes = file.readBytes(); require(bytes.size >= 29)
            return Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
            }
        }
        override fun write(value: String) {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
            val temp = java.io.File(file.parentFile, "${file.name}.tmp")
            temp.outputStream().use { it.write(cipher.iv + cipher.doFinal(value.toByteArray())); it.flush(); it.fd.sync() }
            if (failBeforeReplace) throw IOException("before atomic replacement")
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
        override fun clear() = error("Tax history may not be cleared")
    }
    private class Fixture(val kind: String = "combined") {
        val data = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-journal-fixtures.json")).readText()).jsonObject
        fun raw(kind: String = this.kind) = data.getValue("recoveries").jsonObject.getValue(kind).jsonObject
        val recovery = MiningTaxClaimsRecoveryEnvelope.from(raw()); val preparation = requireNotNull(recovery.preparation)
        val policy = MiningTaxClaimsSigningPolicy(data.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
        val trust = preparation.let { p -> MiningTaxClaimsSigningTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress, p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256) }
        val identity = StarterIdentity("https://tax-${ids.incrementAndGet()}.test", "devnet", preparation.wallet)
        val key = preparation.idempotencyKey; val request = MiningTaxClaimsPrepareRequest(key, preparation.round, preparation.spot, preparation.caps)
        val disk = Memory()
        fun wire(ordinal: Int) = Base64.getEncoder().encodeToString(recovery.wires[ordinal].signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        fun store(secret: SecretStore = disk) = MiningTaxClaimsStore(secret, identity, trust, policy)
        suspend fun prepared(secret: SecretStore = disk): MiningTaxClaimsStore = store(secret).also { s -> s.begin(s.read(), request, 256); s.prepareAttempt(s.read()); s.acceptPreparation(key, preparation) }
        suspend fun signed(secret: SecretStore = disk): MiningTaxClaimsStore = prepared(secret).also { s ->
            s.signingAttempt(s.read(), 0); s.acceptSigned(key, 0, wire(0))
            if (preparation.transactions.size == 2 && kind != "setup") {
                s.acceptRecovery(key, 0, raw("setup")); s.signingAttempt(s.read(), 1); s.acceptSigned(key, 1, wire(1))
            }
        }
        suspend fun settled(secret: SecretStore = disk) = signed(secret).also { it.acceptRecovery(key, recovery.settlement!!.ordinal.toInt(), raw()) }
    }
    private suspend fun rejects(block: suspend () -> Unit) { assertTrue("Uncertain tax history must stay held", runCatching { block() }.isFailure) }
    private fun changed(raw: JsonElement, path: String, value: JsonElement): JsonElement {
        val head = path.substringBefore('.'); val tail = path.substringAfter('.', "")
        fun next(old: JsonElement) = if (tail.isEmpty()) value else changed(old, tail, value)
        return when (raw) {
            is JsonObject -> JsonObject(raw + (head to next(raw.getValue(head))))
            is JsonArray -> JsonArray(raw.toMutableList().also { it[head.toInt()] = next(it[head.toInt()]) })
            else -> error("test path")
        }
    }

    @Test fun `five actual recovery fixtures preserve ordered consent and only complete payment can archive`() = runBlocking {
        for (kind in listOf("claim", "combined", "split", "setup", "aboveQuote")) {
            val f = Fixture(kind); val s = f.settled(); val before = s.read(); val op = requireNotNull(before.operation)
            assertEquals(f.preparation, op.preparation); assertEquals(f.request, op.request)
            if (kind == "setup") { assertNotNull(op.setup); assertNull(op.settlement); rejects { s.archive(before) } }
            else {
                assertEquals(f.recovery, op.settlement); val writes = f.disk.writes; s.archive(before)
                assertEquals(writes + 1, f.disk.writes); assertNull(s.read().operation); assertEquals(op, f.store().archived(f.key)!!.operation)
                assertFalse(s.read().settlementHeld); rejects { s.begin(s.read(), f.request, 256) }
            }
        }
    }
    @Test fun `effect markers must precede external effects and cannot reset or repeat`() = runBlocking {
        val f = Fixture(); val s = f.store(); val empty = s.read(); s.begin(empty, f.request, 256)
        rejects { s.begin(empty, f.request, 256) }; rejects { s.acceptPreparation(f.key, f.preparation) }
        rejects { s.signingAttempt(s.read(), 0) }; rejects { s.submitAttempt(s.read(), 0) }
        s.prepareAttempt(s.read()); rejects { s.prepareAttempt(s.read()) }; s.acceptPreparation(f.key, f.preparation)
        rejects { s.acceptSigned(f.key, 0, f.wire(0)) }; s.signingAttempt(s.read(), 0); rejects { s.signingAttempt(s.read(), 0) }
        s.acceptSigned(f.key, 0, f.wire(0)); s.submitAttempt(s.read(), 0); rejects { s.submitAttempt(s.read(), 0) }
        assertEquals(f.wire(0), f.store().read().operation!!.transactions.single().signed!!.wire)
        rejects { s.archive(s.read()) }
    }
    @Test fun `split claim needs verified setup and higher ordinal observations prevent replay of setup`() = runBlocking {
        val f = Fixture("split"); val s = f.prepared()
        rejects { s.signingAttempt(s.read(), 1) }; s.signingAttempt(s.read(), 0); s.acceptSigned(f.key, 0, f.wire(0))
        s.observeSettlement(f.key, 1); rejects { s.submitAttempt(s.read(), 0) }
        s.acceptRecovery(f.key, 0, f.raw("setup")); assertNotNull(s.read().operation!!.setup)
        rejects { s.signingAttempt(s.read(), 1) }; rejects { s.archive(s.read()) }
    }
    @Test fun `setup observation permits only the next ordinal after its verified setup receipt`() = runBlocking {
        val f = Fixture("split"); val s = f.prepared(); s.signingAttempt(s.read(), 0); s.acceptSigned(f.key, 0, f.wire(0))
        s.observeSettlement(f.key, 0); rejects { s.submitAttempt(s.read(), 0) }; rejects { s.signingAttempt(s.read(), 1) }
        s.acceptRecovery(f.key, 0, f.raw("setup")); s.signingAttempt(s.read(), 1); s.acceptSigned(f.key, 1, f.wire(1)); s.submitAttempt(s.read(), 1)
        s.acceptRecovery(f.key, 1, f.raw()); assertNotNull(s.read().operation!!.settlement)
        assertEquals(listOf(0, 1), s.read().operation!!.observed)
    }
    @Test fun `positive ordinal or unattributed hold survives failed storage before malformed data is decoded`() = runBlocking {
        for (readFailure in listOf(false, true)) for (ordinal in listOf<Int?>(null, 0, 1)) {
            val f = Fixture("split"); val s = f.prepared(); s.signingAttempt(s.read(), 0); s.acceptSigned(f.key, 0, f.wire(0)); val raw = f.disk.value
            f.disk.failRead = readFailure; f.disk.failWrite = !readFailure
            rejects { s.acceptRecovery(f.key, ordinal, JsonPrimitive("malformed")) }
            f.disk.failRead = false; f.disk.failWrite = false; assertEquals(raw, f.disk.value)
            val restored = f.store(); assertTrue(restored.read().settlementHeld); rejects { restored.submitAttempt(restored.read(), 0) }
            rejects { restored.archive(restored.read()) }
        }
    }
    @Test fun `durable observed prefix survives reopened storage and cannot be erased by unknown or expiry`() = runBlocking {
        val f = Fixture("split"); val s = f.prepared(); s.observeSettlement(f.key, 1)
        val bytes = f.disk.value!!; assertTrue(bytes.contains("\"observed\":[1]"))
        val reopenedDisk = Memory().also { it.value = bytes }; val reopened = f.store(reopenedDisk)
        assertEquals(listOf(1), reopened.read().operation!!.observed); rejects { reopened.signingAttempt(reopened.read(), 0) }
        rejects { reopened.acceptRecovery(f.key, 1, JsonObject(f.raw() + mapOf("status" to JsonPrimitive("unknown"), "preparation" to JsonNull, "claimId" to JsonNull, "wires" to JsonArray(emptyList()), "settlement" to JsonNull))) }
        rejects { reopened.archive(reopened.read()) }; assertNotNull(reopened.read().operation)
    }
    @Test fun `late valid signature persists through a hold and cancelled caller`() = runBlocking {
        val f = Fixture(); val s = f.prepared(); s.signingAttempt(s.read(), 0); s.observeSettlement(f.key, 0)
        val job = launch { currentCoroutineContext().cancel(); s.acceptSigned(f.key, 0, f.wire(0)) }; job.join()
        assertEquals(f.wire(0), f.store().read().operation!!.transactions.single().signed!!.wire)
        rejects { s.submitAttempt(s.read(), 0) }
    }
    @Test fun `valid signed prefix saves before adjacent malformed receipt fails`() = runBlocking {
        val f = Fixture(); val s = f.prepared(); s.signingAttempt(s.read(), 0)
        rejects { s.acceptRecovery(f.key, 0, changed(f.raw(), "settlement.receipt.source.trust", JsonPrimitive("forged"))) }
        val op = s.read().operation!!; assertEquals(f.wire(0), op.transactions.single().signed!!.wire); assertEquals(listOf(0), op.observed); assertNull(op.settlement)
        s.acceptRecovery(f.key, 0, f.raw()); assertNotNull(s.read().operation!!.settlement)
    }
    @Test fun `unstarted extra server custody does not invent local signing but setup still verifies`() = runBlocking {
        val f = Fixture("setup"); val s = f.settled(); val op = s.read().operation!!
        assertEquals(1, op.transactions.size); assertEquals(0, op.transactions.single().ordinal); assertNotNull(op.setup)
        rejects { s.acceptSigned(f.key, 1, f.wire(1)) }; rejects { s.archive(s.read()) }
    }
    @Test fun `archive write failure preserves active and history atomically and older keys remain reserved`() = runBlocking {
        val f = Fixture(); val s = f.settled(); val before = s.read(); val raw = f.disk.value; f.disk.failWrite = true
        rejects { s.archive(before) }; assertEquals(raw, f.disk.value); assertEquals(before, s.read()); assertNull(s.archived(f.key))
        f.disk.failWrite = false; s.archive(before); val history = s.archived(f.key)
        val next = f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"); s.begin(s.read(), next, 256)
        assertEquals(history, s.archived(f.key)); rejects { s.begin(s.read(), f.request, 256) }
    }
    @Test fun `self consistent forged signature and declared hashes never become archival proof`() = runBlocking {
        val f = Fixture(); val s = f.prepared(); s.signingAttempt(s.read(), 0)
        val w = f.recovery.wires.single(); val bytes = Base64.getDecoder().decode(f.wire(0)).also { it[1] = (it[1].toInt() xor 1).toByte() }
        fun base58(bytes: ByteArray): String {
            val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; var n = java.math.BigInteger(1, bytes); val digits = StringBuilder()
            while (n.signum() > 0) { val qr = n.divideAndRemainder(java.math.BigInteger.valueOf(58)); digits.append(alphabet[qr[1].toInt()]); n = qr[0] }
            return "1".repeat(bytes.takeWhile { it == 0.toByte() }.size) + digits.reverse()
        }
        val signature = base58(bytes.copyOfRange(1, 65)); val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        var raw: JsonElement = f.raw()
        for ((path, value) in listOf("wires.0.signedTransactionHex" to bytes.joinToString("") { "%02x".format(it.toInt() and 255) }, "wires.0.signature" to signature, "wires.0.wireSha256" to hash, "settlement.receipt.transactions.0.signature" to signature, "settlement.receipt.transactions.0.signedTransactionSha256" to hash)) raw = changed(raw, path, JsonPrimitive(value))
        MiningTaxClaimsRecoveryEnvelope.from(raw.jsonObject); rejects { s.acceptRecovery(f.key, 0, raw) }
        assertTrue(s.read().settlementHeld); assertNull(s.read().operation!!.transactions.single().signed); rejects { s.archive(s.read()) }
        assertNotEquals(w.signature, signature)
    }
    @Test fun `preparation and verified receipt cannot be rewritten by changed recovery metadata`() = runBlocking {
        val f = Fixture(); val s = f.settled(); val before = s.read()
        rejects { s.acceptPreparation(f.key, f.preparation.copy(lastValidBlockHeight = f.preparation.lastValidBlockHeight + 1)) }
        rejects { s.acceptRecovery(f.key, 0, changed(f.raw(), "settlement.settledAt", JsonPrimitive("2035-01-01T00:00:03.123456Z"))) }
        assertEquals(before, s.read())
    }
    @Test fun `scope independent deployment pins and saved historical policy are validated on every reopen`() = runBlocking {
        val f = Fixture("split"); val s = f.prepared()
        rejects { MiningTaxClaimsStore(f.disk, f.identity.copy(origin = "https://different.test"), f.trust, f.policy).read() }
        rejects { MiningTaxClaimsStore(f.disk, f.identity, f.trust.copy(keepMint = f.preparation.wallet), f.policy).read() }
        rejects { MiningTaxClaimsStore(f.disk, f.identity, f.trust, f.policy.copy(daySec = f.policy.daySec + 1)).read() }
        assertEquals(f.policy.daySec, s.read().operation!!.daySec)
    }
    @Test fun `corruption unknown fields and coerced scalar markers never become empty recovery`() = runBlocking {
        val f = Fixture(); f.prepared(); val raw = f.disk.value!!
        for (bad in listOf("broken", "{}", raw.replace("\"prepareAttempted\":true", "\"prepareAttempted\":\"true\""), raw.dropLast(1) + ",\"extra\":true}", raw.replace("\"daySec\":86400", "\"daySec\":0"))) {
            f.disk.value = bad; rejects { f.store().read() }; assertEquals(bad, f.disk.value)
        }
    }
    @Test fun `cross instance locking and revisions permit only one attempt while raw CAS detects hidden replacement`() = runBlocking {
        val f = Fixture(); val s = f.store(); s.begin(s.read(), f.request, 256); val before = s.read(); assertSame(s.requests, f.store().requests)
        val won = listOf(s, f.store()).map { store -> async(Dispatchers.Default) { runCatching { store.prepareAttempt(before) }.isSuccess } }.awaitAll()
        assertEquals(1, won.count { it }); val current = s.read(); val initial = f.disk.value!!
        f.disk.afterRead = { f.disk.value = "$initial " }
        rejects { s.acceptPreparation(f.key, f.preparation) }; assertEquals("$initial ", f.disk.value); assertEquals(current, s.read())
    }
    @Test fun `returned lists and caller mutable preparation cannot rewrite saved evidence`() = runBlocking {
        val f = Fixture("split"); val s = f.store(); s.begin(s.read(), f.request, 256); s.prepareAttempt(s.read())
        val txs = f.preparation.transactions.toMutableList(); val days = f.preparation.setup.accrualDays.toMutableList()
        s.acceptPreparation(f.key, f.preparation.copy(transactions = txs, setup = f.preparation.setup.copy(accrualDays = days))); txs.clear(); days.clear()
        assertEquals(f.preparation, s.read().operation!!.preparation)
        val op = s.read().operation!!
        rejects { (op.preparation!!.transactions as MutableList).clear() }; rejects { (op.observed as MutableList).clear() }; rejects { (op.transactions as MutableList).clear() }
    }
    @Test fun `late positive for older history resolves only its own hold and cannot clear another key`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); val newer = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        s.begin(s.read(), f.request.copy(idempotencyKey = newer), 256); s.observeSettlementKey(newer, 0); s.observeSettlementKey(f.key, 0)
        assertTrue(s.read().settlementHeld); assertNotNull(s.archived(f.key)); assertTrue(s.settlementHeld(newer, 0)); assertFalse(s.settlementHeld(f.key))
        rejects { s.prepareAttempt(s.read()) }
    }
    @Test fun `unresolved positive for another key blocks both active signing and submission`() = runBlocking {
        for (signed in listOf(false, true)) {
            val f = Fixture(); val s = if (signed) f.signed() else f.prepared(); val stale = s.read()
            s.observeSettlementKey("ffffffff-ffff-4fff-8fff-ffffffffffff", 0)
            assertTrue(f.store().read().settlementHeld)
            rejects { if (signed) s.submitAttempt(stale, 0) else s.signingAttempt(stale, 0) }
            val latest = s.read(); rejects { if (signed) s.submitAttempt(latest, 0) else s.signingAttempt(latest, 0) }
        }
    }
    @Test fun `corrupt historical archive cannot release its cross key positive hold`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); val newer = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        s.begin(s.read(), f.request.copy(idempotencyKey = newer), 256); s.prepareAttempt(s.read()); s.acceptPreparation(newer, f.preparation.copy(idempotencyKey = newer))
        val stale = s.read(); val raw = Json.parseToJsonElement(f.disk.value!!).jsonObject
        f.disk.value = JsonObject(raw + ("archives" to JsonObject(raw.getValue("archives").jsonObject + (f.key to JsonPrimitive("broken"))))).toString()
        s.observeSettlementKey(f.key, 0); rejects { s.signingAttempt(stale, 0) }; assertTrue(s.settlementHeld(f.key))
    }
    @Test fun `JVM AES GCM file reopen and failed atomic archive replacement retain recoverable ciphertext`() = runBlocking {
        val f = Fixture(); val path = Files.createTempDirectory("phase-e-tax-journal-").resolve("claim.enc").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey(); val disk = AesFile(path, key); val s = f.settled(disk)
        val before = s.read(); val ciphertext = path.readBytes(); assertFalse(ciphertext.toString(Charsets.UTF_8).contains(f.key))
        disk.failBeforeReplace = true; rejects { s.archive(before) }; assertArrayEquals(ciphertext, path.readBytes())
        val reopened = f.store(AesFile(path, key)); assertEquals(before.operation, reopened.read().operation); assertNull(reopened.archived(f.key))
        reopened.archive(reopened.read()); val again = f.store(AesFile(path, key)); assertNull(again.read().operation); assertEquals(before.operation, again.archived(f.key)!!.operation)
        val persisted = path.readBytes(); path.writeBytes(persisted.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() })
        rejects { f.store(AesFile(path, key)).read() }; assertNotEquals(0, path.length())
    }
    @Test fun `failure atomic history requires explicit fresh archival and preserves uncapped fees through reopen`() = runBlocking {
        for (kind in listOf("claim", "combined", "aboveQuote")) {
            val f = Fixture(kind); val s = f.signed(); val raw = taxFailureFixture(f.recovery)
            s.acceptFailure(f.key, raw); val before = f.store().read(); val op = before.operation!!
            assertEquals("18446744073709551615", op.failure!!.failures.single().receipt.feeLamports)
            rejects { s.archive(before) }; rejects { s.signingAttempt(before, 0) }; rejects { s.submitAttempt(before, 0) }
            s.archiveFailed(before, MiningTaxClaimsFailureEnvelope.from(raw))
            assertNull(s.read().operation); assertEquals(op, f.store().archived(f.key)!!.operation)
            assertFalse(s.read().settlementHeld); rejects { s.begin(s.read(), f.request, 256) }
        }
    }
    @Test fun `failed setup alone stays held while verified setup plus failed claim preserves both costs`() = runBlocking {
        val partial = Fixture("setup"); val s = partial.signed(); val raw = taxFailureFixture(partial.recovery)
        s.acceptFailure(partial.key, raw); rejects { s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw)) }
        rejects { s.signingAttempt(s.read(), 1) }; assertNotNull(s.read().operation)
        val f = Fixture("split"); val full = f.signed(); val setup = MiningTaxClaimsRecoveryEnvelope.from(f.raw("setup"))
        val failure = taxFailureFixture(f.recovery, listOf(1), setup); full.acceptFailure(f.key, failure)
        full.archiveFailed(full.read(), MiningTaxClaimsFailureEnvelope.from(failure)); val history = full.archived(f.key)!!.operation
        assertEquals(setup.settlement, history.setup!!.settlement); assertEquals("18446744073709551615", history.failure!!.failures.single().receipt.feeLamports)
        assertEquals(2, history.transactions.size); assertNull(history.settlement)
    }
    @Test fun `two historical failed ordinals rebind without inventing successful setup or permitting effects`() = runBlocking {
        val f = Fixture("split"); f.signed(); val raw = taxFailureFixture(f.recovery, listOf(0, 1))
        // Historical import has actual local signed packets and explicit markers;
        // normal native sequencing never signs claim1 after failed setup0.
        var disk: JsonElement = Json.parseToJsonElement(f.disk.value!!)
        disk = changed(disk, "operation.setup", JsonNull)
        disk = changed(disk, "operation.observed", JsonArray(listOf(JsonPrimitive(0), JsonPrimitive(1))))
        disk = changed(disk, "operation.failure", raw); f.disk.value = disk.toString()
        val s = f.store(); val before = s.read(); assertNull(before.operation!!.setup)
        rejects { s.submitAttempt(before, 1) }; s.archiveFailed(before, MiningTaxClaimsFailureEnvelope.from(raw))
        assertEquals(2, s.archived(f.key)!!.operation.failure!!.failures.size)
    }
    @Test fun `fresh failure must preserve all immutable facts and unchanged revision raw bytes and current guard`() = runBlocking {
        val conflicting = Fixture(); val held = conflicting.signed(); val original = taxFailureFixture(conflicting.recovery); held.acceptFailure(conflicting.key, original)
        val altered = changed(original, "failures.0.receipt.feeLamports", JsonPrimitive("0")).jsonObject
        rejects { held.acceptFailure(conflicting.key, altered) }; rejects { held.archiveFailed(held.read(), MiningTaxClaimsFailureEnvelope.from(altered)) }
        assertTrue(held.read().operation!!.unattributedObserved)
        val f = Fixture(); val s = f.signed(); val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw); val expected = s.read()
        rejects { s.archiveFailed(expected, MiningTaxClaimsFailureEnvelope.from(raw)) { error("session changed") } }
        f.disk.failWrite = true; rejects { s.archiveFailed(expected, MiningTaxClaimsFailureEnvelope.from(raw)) }; f.disk.failWrite = false
        assertEquals(expected, s.read()); assertNull(s.archived(f.key))
        val storedRaw = f.disk.value!!; f.disk.afterRead = { f.disk.value = "$storedRaw " }
        rejects { s.archiveFailed(expected, MiningTaxClaimsFailureEnvelope.from(raw)) }; assertNotNull(s.read().operation)
        s.observeSettlement(f.key); rejects { s.archiveFailed(expected, MiningTaxClaimsFailureEnvelope.from(raw)) }
        rejects { s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw)) }; assertNotNull(s.read().operation)
    }
    @Test fun `legacy missing failure field remains readable but tampering failure bytes or fields cannot clear history`() = runBlocking {
        val f = Fixture(); val s = f.signed(); val raw = Json.parseToJsonElement(f.disk.value!!).jsonObject
        f.disk.value = JsonObject(raw + ("operation" to JsonObject(raw.getValue("operation").jsonObject - "failure"))).toString()
        assertNull(f.store().read().operation!!.failure)
        val failed = taxFailureFixture(f.recovery); s.acceptFailure(f.key, failed); val saved = f.disk.value!!
        f.disk.value = changed(Json.parseToJsonElement(saved), "operation.failure.failures.0.receipt.signature", JsonPrimitive(f.preparation.wallet)).toString()
        rejects { f.store().read() }; f.disk.value = saved
        rejects { (f.store().read().operation!!.failure!!.failures as MutableList).clear() }
        assertNotNull(f.store().read().operation)
    }
    @Test fun `failure recovery retains late local wire before adjacent malformed evidence and storage refusal stays held`() = runBlocking {
        val f = Fixture(); val s = f.prepared(); s.signingAttempt(s.read(), 0)
        val raw = taxFailureFixture(f.recovery)
        rejects { s.acceptFailure(f.key, changed(raw, "failures.0.receipt.outcome", JsonPrimitive("paid"))) }
        assertEquals(f.wire(0), s.read().operation!!.transactions.single().signed!!.wire); assertTrue(s.settlementHeld(f.key))
        assertNull(s.read().operation!!.failure); f.disk.failRead = true
        rejects { s.acceptFailure(f.key, JsonPrimitive("broken")) }; f.disk.failRead = false
        assertTrue(s.settlementHeld(f.key)); s.acceptFailure(f.key, raw); assertNotNull(s.read().operation!!.failure)
    }
    @Test fun `JVM encrypted failed archival is one atomic replacement and restart verifies the complete history`() = runBlocking {
        val f = Fixture(); val path = Files.createTempDirectory("phase-e-tax-failure-").resolve("claim.enc").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey(); val disk = AesFile(path, key)
        val s = f.signed(disk); val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw); val before = s.read(); val bytes = path.readBytes()
        disk.failBeforeReplace = true; rejects { s.archiveFailed(before, MiningTaxClaimsFailureEnvelope.from(raw)) }; assertArrayEquals(bytes, path.readBytes())
        val reopened = f.store(AesFile(path, key)); assertEquals(before.operation, reopened.read().operation)
        reopened.archiveFailed(reopened.read(), MiningTaxClaimsFailureEnvelope.from(raw)); assertNull(reopened.read().operation)
        assertEquals(before.operation, f.store(AesFile(path, key)).archived(f.key)!!.operation)
    }

    @Test fun `an ambiguous positive arriving at final storage CAS cannot clear previously complete failure history`() = runBlocking {
        for (ordinal in listOf<Int?>(null, 1)) {
            val f = Fixture(); val s = f.signed(); val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw); val expected = s.read()
            f.disk.afterRead = { f.disk.afterRead = { s.observeSettlementKey(f.key, ordinal) } }
            rejects { s.archiveFailed(expected, MiningTaxClaimsFailureEnvelope.from(raw)) }
            assertNotNull(s.read().operation); assertNull(s.archived(f.key)); assertTrue(s.settlementHeld(f.key))
        }
    }

    @Test fun `failed archive reopen preserves later unknown and out of plan holds against a new active key`() = runBlocking {
        for (ordinal in listOf<Int?>(null, 1)) {
            val f = Fixture(); val s = f.signed(); val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw)
            s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw))
            val newer = "ffffffff-ffff-4fff-8fff-ffffffffffff"; s.begin(s.read(), f.request.copy(idempotencyKey = newer), 256)
            s.observeSettlementKey(f.key, ordinal); assertTrue(f.store().read().settlementHeld)
            assertNotNull(s.archived(f.key)); assertTrue(s.settlementHeld(f.key)); rejects { s.prepareAttempt(s.read()) }
        }
    }
    @Test fun `reopening bound failed history releases only a covered ordinal and keeps other key observations`() = runBlocking {
        val f = Fixture(); val s = f.signed(); val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw)
        s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw)); val other = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        s.observeSettlementKey(f.key, 0); s.observeSettlementKey(other, 0); assertNotNull(f.store().archived(f.key))
        assertFalse(s.settlementHeld(f.key)); assertTrue(s.settlementHeld(other))
    }

    @Test fun `contradictory failed setup refuses a previously captured claim effect guard`() = runBlocking {
        val f = Fixture("setup"); val s = f.settled(); val guard = s.effectGuard(s.read(), 1)
        rejects { s.acceptFailure(f.key, taxFailureFixture(f.recovery)) }
        rejects { guard() }; assertTrue(s.read().operation!!.unattributedObserved)
        assertNotNull(s.read().operation!!.setup); assertNull(s.read().operation!!.failure)
    }

    @Test fun `sparse historical failure one never invents setup or clears the missing ordinal zero`() = runBlocking {
        val f = Fixture("split"); f.signed(); val raw = taxFailureFixture(f.recovery.copy(wires = f.recovery.wires.drop(1)), listOf(1))
        var disk: JsonElement = Json.parseToJsonElement(f.disk.value!!)
        disk = changed(disk, "operation.setup", JsonNull); disk = changed(disk, "operation.observed", JsonArray(listOf(JsonPrimitive(1))))
        disk = changed(disk, "operation.transactions", JsonArray(disk.jsonObject.getValue("operation").jsonObject.getValue("transactions").jsonArray.drop(1)))
        disk = changed(disk, "operation.failure", raw); f.disk.value = disk.toString()
        val s = f.store(); assertNull(s.read().operation!!.setup); assertEquals(1, s.read().operation!!.transactions.size)
        rejects { s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw)) }; rejects { s.signingAttempt(s.read(), 0) }
    }

    @Test fun `failure observation blocks known setup claim guard synchronously before any storage or proof`() = runBlocking {
        val f = Fixture("setup"); val s = f.settled(); val guard = s.effectGuard(s.read(), 1)
        f.disk.failRead = true; s.observeFailureKey(f.key); rejects { guard() }; rejects { s.observeFailure(f.key) }
        f.disk.failRead = false; s.observeFailure(f.key); val reopened = f.store()
        assertTrue(reopened.read().operation!!.failureObserved); assertNull(reopened.read().operation!!.failure)
        rejects { reopened.effectGuard(reopened.read(), 1) }; rejects { reopened.archive(reopened.read()) }
    }

    @Test fun `S3 paid archive refuses durable or in memory contradictory failure observations`() = runBlocking {
        for (durable in listOf(false, true)) {
            val f = Fixture(); val s = f.settled(); if (durable) s.observeFailure(f.key) else s.observeFailureKey(f.key)
            rejects { s.archive(s.read()) }; assertNotNull(s.read().operation); assertTrue(s.settlementHeld(f.key))
        }
    }
    @Test fun `S3 paid archive history cannot erase a new failure marker even after atomic replacement`() = runBlocking {
        for (duringWrite in listOf(false, true)) {
            val f = Fixture(); val s = f.settled(); if (duringWrite) f.disk.afterWrite = { s.observeFailureKey(f.key) }
            s.archive(s.read()); f.disk.afterWrite = {}; if (!duringWrite) s.observeFailureKey(f.key)
            assertTrue(s.read().settlementHeld); assertNotNull(s.archived(f.key)); assertTrue(s.settlementHeld(f.key))
            rejects { s.begin(s.read(), f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), 256) }
        }
    }
    @Test fun `S3 bad first sibling cannot discard valid later started wire in direct failure or saved recovery`() = runBlocking {
        for (failure in listOf(false, true)) {
            val f = Fixture("split"); val s = f.prepared(); s.signingAttempt(s.read(), 0); s.acceptSigned(f.key, 0, f.wire(0))
            s.acceptRecovery(f.key, 0, f.raw("setup")); s.signingAttempt(s.read(), 1)
            val raw = corruptTaxFailureWire(taxFailureFixture(f.recovery, listOf(1), MiningTaxClaimsRecoveryEnvelope.from(f.raw("setup"))))
            rejects { if (failure) s.acceptFailure(f.key, raw) else s.acceptRecovery(f.key, 1, raw.getValue("recovery")) }
            assertEquals(f.wire(1), s.read().operation!!.transactions.last().signed!!.wire)
        }
    }

    /** Simulates a new process for only this unique fixture identity. Reusing the
     * existing Store companion map would falsely certify durable observation data. */
    private fun coldStore(f: Fixture, disk: SecretStore = f.disk): MiningTaxClaimsStore {
        val field = MiningTaxClaimsStore::class.java.getDeclaredField("identities").also { it.isAccessible = true }
        synchronized(MiningTaxClaimsStore.Companion) {
            @Suppress("UNCHECKED_CAST")
            (field.get(null) as MutableMap<StarterIdentity, *>).remove(f.identity)
        }
        return f.store(disk)
    }
    @Test fun `durable post archive paid failure unknown and out of plan holds survive fresh process memory`() = runBlocking {
        for (kind in listOf("failure", "unknown", "outside")) {
            val f = Fixture(); val s = f.settled(); s.archive(s.read()); val original = s.archived(f.key)!!
            when (kind) { "failure" -> s.observeFailure(f.key); "unknown" -> s.observeSettlement(f.key); else -> s.observeSettlement(f.key, 1) }
            val restarted = coldStore(f); assertTrue(restarted.read().settlementHeld); assertEquals(original, restarted.archived(f.key))
            rejects { restarted.begin(restarted.read(), f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), 256) }
        }
    }
    @Test fun `durable post archive failed unknown or extra ordinal stays held across process restart`() = runBlocking {
        for (ordinal in listOf<Int?>(null, 1)) {
            val f = Fixture(); val s = f.signed(); val failure = taxFailureFixture(f.recovery); s.acceptFailure(f.key, failure)
            s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(failure)); val archive = s.archived(f.key)!!
            s.observeSettlement(f.key, ordinal); val restarted = coldStore(f)
            assertTrue(restarted.read().settlementHeld); assertEquals(archive, restarted.archived(f.key)); assertTrue(restarted.settlementHeld(f.key))
        }
    }
    @Test fun `durable post archive snapshot flushes pending synchronous holds before any next action`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); s.observeFailureKey(f.key)
        assertTrue(s.read().settlementHeld); val restarted = coldStore(f); assertTrue(restarted.read().settlementHeld)
        rejects { restarted.begin(restarted.read(), f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), 256) }
    }
    @Test fun `durable post archive storage refusal retains memory hold and recovered flush persists without editing receipt`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read())
        val before = Json.parseToJsonElement(f.disk.value!!).jsonObject.getValue("archives"); f.disk.failWrite = true
        rejects { s.observeFailure(f.key) }; assertTrue(s.settlementHeld(f.key)); f.disk.failWrite = false
        assertTrue(s.read().settlementHeld); assertEquals(before, Json.parseToJsonElement(f.disk.value!!).jsonObject.getValue("archives"))
        assertTrue(coldStore(f).read().settlementHeld)
    }
    @Test fun `durable post archive observation during atomic completion is flushed without changing immutable history`() = runBlocking {
        for (failure in listOf(false, true)) {
            val f = Fixture(); val s = f.settled(); val op = s.read().operation!!
            f.disk.afterWrite = { f.disk.afterWrite = {}; if (failure) s.observeFailureKey(f.key) else s.observeSettlementKey(f.key) }
            assertTrue(s.archive(s.read()).settlementHeld); val restarted = coldStore(f)
            assertNull(restarted.read().operation); assertTrue(restarted.read().settlementHeld); assertEquals(op, restarted.archived(f.key)!!.operation)
        }
    }
    @Test fun `durable post archive encrypted roster and byte identical receipt reopen in a fresh process`() = runBlocking {
        val f = Fixture(); val path = Files.createTempDirectory("phase-e-tax-held-history-").resolve("claim.enc").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey(); val disk = AesFile(path, key)
        val s = f.settled(disk); s.archive(s.read()); val history = Json.parseToJsonElement(disk.read()!!).jsonObject.getValue("archives")
        s.observeFailure(f.key); assertEquals(history, Json.parseToJsonElement(disk.read()!!).jsonObject.getValue("archives"))
        val reopened = coldStore(f, AesFile(path, key)); assertTrue(reopened.read().settlementHeld); assertNotNull(reopened.archived(f.key))
    }
    @Test fun `covered historical observations still resolve without rewriting paid or failed archive bytes`() = runBlocking {
        for (failed in listOf(false, true)) {
            val f = Fixture(); val s = if (failed) f.signed() else f.settled()
            if (failed) { val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw); s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw)) } else s.archive(s.read())
            val bytes = f.disk.value; s.observeSettlement(f.key, 0); assertFalse(s.read().settlementHeld); assertEquals(bytes, f.disk.value)
            assertFalse(coldStore(f).read().settlementHeld)
        }
    }

    @Test fun `durable roster accepts untouched legacy paid archive and preserves its exact serialized receipt`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); val root = Json.parseToJsonElement(f.disk.value!!).jsonObject
        val history = Json.parseToJsonElement(root.getValue("archives").jsonObject.getValue(f.key).jsonPrimitive.content).jsonObject
        val oldHistory = JsonObject(history + ("operation" to JsonObject(history.getValue("operation").jsonObject - "failure" - "failureObserved"))).toString()
        f.disk.value = JsonObject((root - "heldArchives") + ("archives" to JsonObject(mapOf(f.key to JsonPrimitive(oldHistory))))).toString()
        val bytes = f.disk.value; val reopened = coldStore(f); assertFalse(reopened.read().settlementHeld); assertNotNull(reopened.archived(f.key)); assertEquals(bytes, f.disk.value)
        reopened.observeFailure(f.key); assertEquals(oldHistory, Json.parseToJsonElement(f.disk.value!!).jsonObject.getValue("archives").jsonObject.getValue(f.key).jsonPrimitive.content)
        assertTrue(coldStore(f).read().settlementHeld)
    }
    @Test fun `durable roster raw CAS refuses a hidden document replacement while pending observation stays held`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); val bytes = f.disk.value!!; s.observeFailureKey(f.key)
        f.disk.afterRead = { f.disk.value = "$bytes " }; rejects { s.read() }; assertEquals("$bytes ", f.disk.value); assertTrue(s.settlementHeld(f.key))
        assertTrue(s.read().settlementHeld); assertTrue(coldStore(f).read().settlementHeld)
    }
    @Test fun `durable roster persists a hold before corrupt archive proof fails so restart cannot forget the blocker`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); val root = Json.parseToJsonElement(f.disk.value!!).jsonObject
        f.disk.value = JsonObject(root + ("archives" to JsonObject(mapOf(f.key to JsonPrimitive("broken"))))).toString()
        rejects { s.observeFailure(f.key) }; val reopened = coldStore(f)
        rejects { reopened.read() }; assertTrue(reopened.settlementHeld(f.key))
    }

    @Test fun `continuation observation at final failed archive guard preserves the active failed history`() = runBlocking {
        val f = Fixture("claim"); val s = f.signed(); val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw)
        rejects { s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw)) { s.observeContinuationKey(f.key) } }
        assertNotNull(s.read().operation)
    }
    @Test fun `later continuation observation survives paid or failed archived history and a cold reopen`() = runBlocking {
        for (failed in listOf(false, true)) {
            val f = Fixture("claim"); val s = if (failed) f.signed() else f.settled()
            if (failed) { val raw = taxFailureFixture(f.recovery); s.acceptFailure(f.key, raw); s.archiveFailed(s.read(), MiningTaxClaimsFailureEnvelope.from(raw)) } else s.archive(s.read())
            val original = s.archived(f.key); s.observeContinuation(f.key); assertEquals(original, s.archived(f.key))
            assertTrue(coldStore(f).read().settlementHeld)
        }
    }
    @Test fun `durable public history return flushes observations arriving during its asynchronous cryptographic rebind`() = runBlocking {
        for (failure in listOf(false, true)) {
            val f = Fixture(); val s = f.settled(); s.archive(s.read()); var observed = false
            digestProvider = MessageDigest.getInstance("SHA-256").provider.name
            val provider = object : java.security.Provider("TaxHistoryObservation", 1.0, "Fixture-only digest observation") {
                init { put("MessageDigest.SHA-256", ObservingDigest::class.java.name) }
            }
            digestObservation.set { observed = true; if (failure) s.observeFailureKey(f.key) else s.observeSettlementKey(f.key) }
            java.security.Security.insertProviderAt(provider, 1)
            try { assertNotNull(s.archived(f.key)) }
            finally { java.security.Security.removeProvider(provider.name); digestObservation.set(null) }
            assertTrue(observed)
            // No intervening read is allowed to repair an incomplete archived() drain.
            val reopened = coldStore(f); assertTrue(reopened.read().settlementHeld)
        }
    }

}
