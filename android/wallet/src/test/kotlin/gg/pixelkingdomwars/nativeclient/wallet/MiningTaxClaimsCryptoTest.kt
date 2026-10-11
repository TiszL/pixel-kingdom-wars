package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.mining.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Actual SDK/public receipt fixtures; test-only authority, no private keys. */
class MiningTaxClaimsCryptoTest {
    private val source get() = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-crypto.json")).readText()).jsonObject
    private val policy get() = MiningTaxClaimsSigningPolicy(source.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
    private fun recovery(kind: String = "combined") = MiningTaxClaimsRecoveryEnvelope.from(source.getValue("recoveries").jsonObject.getValue(kind).jsonObject)
    private fun p(kind: String = "combined") = requireNotNull(recovery(kind).preparation)
    private fun trust(p: MiningTaxClaimsPreparation = p()) = MiningTaxClaimsSigningTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress, p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun digest(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun base64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
    private fun local(r: MiningTaxClaimsRecoveryEnvelope = recovery()): MiningTaxClaimsLocalEvidence {
        val p = requireNotNull(r.preparation)
        return MiningTaxClaimsLocalEvidence(p.wallet, MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps), p,
            r.wires.map { MiningTaxClaimsLocalWire(it.ordinal.toInt(), base64(bytes(it.signedTransactionHex)), it.signature, it.messageSha256, it.wireSha256) })
    }
    private fun rejects(block: suspend () -> Unit) { assertThrows(IllegalArgumentException::class.java) { runBlocking { block() } } }
    private suspend fun bind(r: MiningTaxClaimsRecoveryEnvelope = recovery(), l: MiningTaxClaimsLocalEvidence = local(r)) = MiningTaxClaimsCrypto.bindSettlement(l, r, trust(l.preparation), policy)

    @Test fun `five actual SDK receipt fixtures bind exact canonical messages and real claimant signatures`() = runBlocking {
        for (kind in listOf("claim", "combined", "split", "setup", "aboveQuote")) {
            val r = recovery(kind); val p = requireNotNull(r.preparation)
            for (w in r.wires) {
                val prepared = MiningTaxClaimsCrypto.prepare(p, trust(p), policy, w.ordinal.toInt())
                assertArrayEquals(byteArrayOf(1) + ByteArray(64) + bytes(p.transactions[w.ordinal.toInt()].messageHex), prepared.unsignedTransaction())
                val signed = prepared.verifySigned(bytes(w.signedTransactionHex))
                assertEquals(w.signature, signed.signature); assertEquals(w.messageSha256, signed.messageSha256); assertEquals(w.wireSha256, signed.wireSha256)
                assertEquals(signed, MiningTaxClaimsCrypto.verifySigned(p, signed.wire, policy, w.ordinal.toInt()))
                assertFalse(prepared.signingAuthorized); assertFalse(prepared.broadcastAuthorized)
            }
            val bound = bind(r)
            assertEquals(r, bound.recovery); assertEquals(r.status, bound.phase)
            assertFalse(bound.nativeFinalityVerified); assertFalse(bound.currentSigningAuthorized); assertFalse(bound.broadcastAuthorized); assertFalse(bound.journalClearingAuthorized)
            assertEquals(kind != "setup", bound.recovery.settlement!!.claimFinalized)
        }
    }
    @Test fun `every independent pin is mandatory and remains independent of server documents`() {
        val p = p(); val t = trust(p); val other = base58(ByteArray(32) { 19 })
        for (wrong in listOf(t.copy(genesisHash = other), t.copy(programId = other), t.copy(configAddress = other), t.copy(keepMint = other), t.copy(reserveOwner = other), t.copy(reviewedDeploymentSlot = 0), t.copy(reviewedProgramDataSha256 = "ab".repeat(32)))) {
            rejects { MiningTaxClaimsCrypto.prepare(p, wrong, policy) }
            rejects { MiningTaxClaimsCrypto.bindSettlement(local(), recovery(), wrong, policy) }
        }
    }
    @Test fun `all selected and unselected messages are checked before producing static proof`() {
        val p = p("split"); val txs = p.transactions.toMutableList(); txs[1] = txs[1].copy(messageSha256 = "ab".repeat(32))
        rejects { MiningTaxClaimsCrypto.prepare(p.copy(transactions = txs), trust(p), policy, 0) }
        for (ordinal in listOf(-1, 2, Int.MAX_VALUE)) rejects { MiningTaxClaimsCrypto.prepare(p, trust(p), policy, ordinal) }
    }
    @Test fun `every canonical combined message byte is checked despite a recomputed declared hash`() {
        val p = p(); val original = bytes(p.transactions.single().messageHex)
        for (offset in original.indices) {
            val changed = original.copyOf().also { it[offset] = (it[offset].toInt() xor 1).toByte() }
            val tx = p.transactions.single().copy(messageHex = hex(changed), messageSha256 = digest(changed))
            rejects { MiningTaxClaimsCrypto.prepare(p.copy(transactions = listOf(tx)), trust(p), policy) }
        }
    }
    @Test fun `real SDK recompositions cannot substitute roles privileges instruction data payout order or version`() {
        val cases = source.getValue("adversarial").jsonArray
        assertEquals(8, cases.size)
        for (f in cases) {
            val raw = f.jsonObject.getValue("preparation").jsonObject
            assertNotEquals(p().transactions.single().messageHex, raw.getValue("transactions").jsonArray[0].jsonObject.getValue("messageHex").jsonPrimitive.content)
            assertThrows(f.jsonObject.getValue("name").jsonPrimitive.content, IllegalArgumentException::class.java) {
                runBlocking { val p = MiningTaxClaimsPreparation.from(raw); MiningTaxClaimsCrypto.prepare(p, trust(p), policy) }
            }
        }
    }
    @Test fun `PDA identities and new account sizes derive from the exact ABI`() {
        val p = p(); val i = p.identity; val other = base58(ByteArray(32) { 19 })
        for (identity in listOf(i.copy(configAddress = other), i.copy(auctionConfig = other), i.copy(registry = other), i.copy(term = other), i.copy(pool = other), i.copy(cursor = other), i.copy(auction = other), i.copy(claimantAta = other))) {
            val changed = p.copy(identity = identity)
            rejects { MiningTaxClaimsCrypto.prepare(changed, trust(changed), policy) }
        }
        val tx = p.transactions.single(); val accounts = tx.newAccounts.toMutableList(); accounts[0] = accounts[0].copy(space = accounts[0].space + 1)
        rejects { MiningTaxClaimsCrypto.prepare(p.copy(transactions = listOf(tx.copy(newAccounts = accounts))), trust(p), policy) }
    }
    @Test fun `reserve owner may be claimant but instruction roles may not alias`() = runBlocking {
        val p = p(); val allowed = p.copy(identity = p.identity.copy(reserveOwner = p.wallet))
        assertEquals(p.wallet, MiningTaxClaimsCrypto.prepare(allowed, trust(allowed), policy).wallet)
        val forged = p.copy(identity = p.identity.copy(keepMint = p.wallet))
        rejects { MiningTaxClaimsCrypto.prepare(forged, trust(forged), policy) }
    }
    @Test fun `claimant must be an Ed25519 wallet and blockhash must match reviewed message`() {
        val p = p(); val offCurve = p.identity.configAddress
        rejects { MiningTaxClaimsCrypto.prepare(p.copy(wallet = offCurve, identity = p.identity.copy(originalWinner = offCurve)), trust(p), policy) }
        rejects { MiningTaxClaimsCrypto.prepare(p.copy(blockhash = p.identity.keepMint), trust(p), policy) }
    }
    @Test fun `saved accrual days stay within original completed operating range without current tuning`() = runBlocking {
        val p = p("split"); assertEquals(7, p.setup.accrualDays.size)
        assertEquals(1, MiningTaxClaimsCrypto.prepare(p, trust(p), policy, 1).ordinal)
        rejects { MiningTaxClaimsCrypto.prepare(p, trust(p), MiningTaxClaimsSigningPolicy(0)) }
        rejects { MiningTaxClaimsCrypto.prepare(p.copy(term = p.term.copy(operatingEnd = (p.term.operatingEnd.toLong() - policy.daySec).toString())), trust(p), policy) }
        rejects { MiningTaxClaimsCrypto.prepare(p.copy(term = p.term.copy(winnerCount = 256), snapshot = p.snapshot.copy(poolAccruedBaseUnits = "0")), trust(p), policy) }
        val expired = p.copy(preparedAt = "2001-01-01T00:00:00.000Z", expiresAt = "2001-01-01T00:02:00.000Z")
        assertFalse(MiningTaxClaimsCrypto.prepare(expired, trust(expired), policy, 1).signingAuthorized)
    }
    @Test fun `canonical bounded packets and Ed25519 reject mutations zero signatures and trailing bytes`() = runBlocking {
        val p = p(); val w = bytes(recovery().wires.single().signedTransactionHex); val prepared = MiningTaxClaimsCrypto.prepare(p, trust(p), policy)
        for (bad in listOf(w.copyOf().also { it[0] = 2 }, w.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }, w.copyOf().also { it.fill(0, 1, 65) }, w.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }, w + 0.toByte(), ByteArray(65), ByteArray(1233))) rejects { prepared.verifySigned(bad) }
        for (bad in listOf(base64(w) + "\n", base64(w) + "=", "A".repeat(1648), "!!!!", "AQ==")) rejects { prepared.verifySignedBase64(bad) }
    }
    @Test fun `all saved preparation fields compare even when not encoded into claim instruction`() {
        val r = recovery(); val p = requireNotNull(r.preparation)
        for (changed in listOf(p.copy(identity = p.identity.copy(registryHash = "ab".repeat(32))), p.copy(source = p.source.copy(snapshotSha256 = "ab".repeat(32))), p.copy(lastValidBlockHeight = p.lastValidBlockHeight + 1), p.copy(fees = p.fees.copy(payerBalanceLamports = "1000001")), p.copy(caps = p.caps.copy(maxTotalLamports = "1011")), p.copy(term = p.term.copy(operatingEnd = (p.term.operatingEnd.toLong() + 1).toString()))))
            rejects { bind(r.copy(preparation = changed), local(r)) }
    }
    @Test fun `local request caps wallet key round and spot cannot be replaced by server history`() {
        val l = local(); val request = l.request
        rejects { bind(l = l.copy(wallet = p().identity.keepMint)) }
        for (changed in listOf(request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), request.copy(round = "9"), request.copy(spot = 1), request.copy(caps = request.caps.copy(maxFeeLamports = "11")))) rejects { bind(l = l.copy(request = changed)) }
    }
    @Test fun `local exact signed prefix is required and extras never promote setup to payment`() = runBlocking {
        val r = recovery("split"); val l = local(r)
        for (wires in listOf(emptyList(), listOf(l.wires[1]), l.wires.reversed(), listOf(l.wires[0], l.wires[0]), listOf(l.wires[0].copy(wire = local(recovery("claim")).wires.single().wire), l.wires[1]))) rejects { bind(r, l.copy(wires = wires)) }
        val setup = recovery("setup"); val saved = local(setup)
        assertEquals("setup", bind(setup, saved.copy(wires = listOf(saved.wires[0]))).phase)
        assertEquals("setup", bind(setup.copy(wires = listOf(setup.wires[0])), saved).phase)
    }
    @Test fun `jointly forged local server signature and hashes still fail real Ed25519`() {
        val r = recovery(); val w = r.wires.single(); val bytes = bytes(w.signedTransactionHex).also { it[1] = (it[1].toInt() xor 1).toByte() }
        val signature = base58(bytes.copyOfRange(1, 65)); val hash = digest(bytes); val s = requireNotNull(r.settlement); val tx = s.receipt.transactions.single()
        val forged = r.copy(wires = listOf(w.copy(signedTransactionHex = hex(bytes), signature = signature, wireSha256 = hash)), settlement = s.copy(receipt = s.receipt.copy(transactions = listOf(tx.copy(signature = signature, signedTransactionSha256 = hash)))))
        forged.validate(); rejects { bind(forged, local(forged)) }
    }
    @Test fun `jointly forged local server message and wire hash declarations are recomputed`() {
        val r = recovery(); val p = requireNotNull(r.preparation); val w = r.wires.single(); val s = requireNotNull(r.settlement); val tx = s.receipt.transactions.single(); val fake = "ab".repeat(32)
        val wire = r.copy(wires = listOf(w.copy(wireSha256 = fake)), settlement = s.copy(receipt = s.receipt.copy(transactions = listOf(tx.copy(signedTransactionSha256 = fake)))))
        wire.validate(); rejects { bind(wire, local(wire)) }
        val message = r.copy(preparation = p.copy(transactions = listOf(p.transactions.single().copy(messageSha256 = fake))), wires = listOf(w.copy(messageSha256 = fake)), settlement = s.copy(receipt = s.receipt.copy(transactions = listOf(tx.copy(messageSha256 = fake)))))
        message.validate(); rejects { bind(message, local(message)) }
    }
    @Test fun `unknown preparation and signed custody are not settlement receipts`() {
        val r = recovery(); val l = local(r)
        for (status in listOf("unknown", "prepared", "signed")) {
            val draft = r.copy(status = status, settlement = null, preparation = if (status == "unknown") null else r.preparation, claimId = if (status == "unknown") null else r.claimId, wires = if (status == "signed") r.wires else emptyList())
            draft.validate(); rejects { bind(draft, l) }
        }
    }
    @Test fun `claim ABI cannot authenticate server supplied amounts or chain state`() = runBlocking {
        val p = p("claim"); val changed = p.copy(intended = p.intended.copy(claimBaseUnits = "4", cumulativeBaseUnits = "4"), snapshot = p.snapshot.copy(poolAccruedBaseUnits = "13"))
        changed.validate()
        assertArrayEquals(MiningTaxClaimsCrypto.prepare(p, trust(p), policy).unsignedTransaction(), MiningTaxClaimsCrypto.prepare(changed, trust(changed), policy).unsignedTransaction())
        // No amount argument exists. The binder compares saved consent, but only fresh server admission proves current payout facts.
        assertFalse(MiningTaxClaimsCrypto.prepare(changed, trust(changed), policy).signingAuthorized)
    }
    @Test fun `owned preparations buffers and bound recovery collections cannot change later`() = runBlocking {
        val p = p("split"); val accounts = p.transactions[0].newAccounts.toMutableList(); val txs = p.transactions.toMutableList(); txs[0] = txs[0].copy(newAccounts = accounts); val days = p.setup.accrualDays.toMutableList()
        val prepared = MiningTaxClaimsCrypto.prepare(p.copy(transactions = txs, setup = p.setup.copy(accrualDays = days)), trust(p), policy)
        accounts.clear(); txs.clear(); days.clear(); prepared.unsignedTransaction().fill(0)
        val signedBytes = bytes(recovery("split").wires[0].signedTransactionHex); val signed = prepared.verifySigned(signedBytes); signedBytes.fill(0)
        assertEquals(signed, prepared.verifySignedBase64(signed.wire))
        val r = recovery("setup"); val wires = r.wires.toMutableList(); val settlement = requireNotNull(r.settlement); val receiptTx = settlement.receipt.transactions.toMutableList()
        val bound = bind(r.copy(wires = wires, settlement = settlement.copy(receipt = settlement.receipt.copy(transactions = receiptTx))))
        wires.clear(); receiptTx.clear(); assertEquals(2, bound.recovery.wires.size)
        assertThrows(UnsupportedOperationException::class.java) { (bound.recovery.wires as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (bound.recovery.preparation!!.transactions[0].newAccounts as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (bound.recovery.settlement!!.receipt.transactions as MutableList).clear() }
        Unit
    }
    @Test fun `unbounded caller collections are refused before their elements are inspected`() {
        val hostile = object : AbstractList<MiningTaxClaimsTransaction>() { override val size = 10001; override fun get(index: Int): MiningTaxClaimsTransaction = error("must not traverse") }
        rejects { MiningTaxClaimsCrypto.prepare(p().copy(transactions = hostile), trust(), policy) }
        val hostileWires = object : AbstractList<MiningTaxClaimsLocalWire>() { override val size = 10001; override fun get(index: Int): MiningTaxClaimsLocalWire = error("must not traverse") }
        rejects { bind(l = local().copy(wires = hostileWires)) }
    }
}
