package gg.pixelkingdomwars.nativeclient.wallet

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

/** Public bytes from the real backend planner, produced with a throwaway generated signer.
 * No signing key or production identity is retained. Mutations must fail before wallet approval. */
internal class MiningClaimFixture {
    private val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/mining-claim-server-fixture.json"))
        .bufferedReader().use { it.readText() }).jsonObject
    private val p = raw.getValue("preparation").jsonObject
    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.flag(key: String) = getValue(key).jsonPrimitive.boolean
    private val identity = p.getValue("identity").jsonObject
    val trust = MiningClaimSigningTrust(identity.text("genesisHash"), identity.text("programId"), identity.text("configAddress"), identity.text("keepMint"), identity.text("reserveOwner"))
    private val leaf = p.getValue("leaf").jsonObject
    val input = MiningClaimSigningInput(p.text("wallet"), trust, p.text("rootSequence"), leaf.text("wallet"), leaf.text("rootSequence"),
        leaf.text("cumulativeKeepBaseUnits"), leaf.text("cumulativeRenown"), leaf.text("cumulativeDays"),
        p.getValue("proof").jsonArray.map { it.jsonObject.let { n -> MiningClaimProofNode(n.text("hash"), n.text("sumBaseUnits"), n.flag("isLeft")) } },
        p.flag("needsAta"), p.flag("needsMinerRecords"), p.getValue("transactions").jsonArray.map { it.jsonObject.let { t ->
            MiningClaimSigningMessage(t.getValue("ordinal").jsonPrimitive.int, t.text("kind"), t.text("version"), t.text("message"),
                t.getValue("lookupTables").jsonArray.map { it.jsonPrimitive.content }, t.text("feePayer"), t.text("blockhash")) } })
    val signed = raw.getValue("signed").jsonObject.let { SignedMiningClaim(it.text("wire"), it.text("signature")) }
    val wire: ByteArray get() = Base64.getDecoder().decode(signed.wire)
    fun prepared() = runBlocking { MiningClaimTransaction.prepare(input, trust) }
}

class MiningClaimTransactionTest {
    private val f = MiningClaimFixture()
    private fun refuses(input: MiningClaimSigningInput = f.input, trust: MiningClaimSigningTrust = f.trust) {
        assertThrows(IllegalArgumentException::class.java) { runBlocking { MiningClaimTransaction.prepare(input, trust) } }
    }
    private fun withTx(transform: (MiningClaimSigningMessage) -> MiningClaimSigningMessage) = f.input.copy(transactions = listOf(transform(f.input.transactions.single())))

    @Test fun `real server planned combined claim matches independent native ABI PDA ATA and compiled privileges`() {
        val prepared = f.prepared()
        assertEquals(f.input.wallet, prepared.wallet)
        assertArrayEquals(byteArrayOf(1) + ByteArray(64) + Base64.getDecoder().decode(f.input.transactions.single().message), prepared.unsignedTransaction())
        assertEquals(f.signed, prepared.verifySigned(f.wire))
        assertEquals(f.signed, prepared.verifySignedBase64(f.signed.wire))
    }
    @Test fun `every application identity pin is independent of the quote`() {
        val other = base58(ByteArray(32) { 3 })
        listOf(f.trust.copy(genesisHash = other), f.trust.copy(programId = other), f.trust.copy(configAddress = other),
            f.trust.copy(keepMint = other), f.trust.copy(reserveOwner = other)).forEach { refuses(trust = it) }
        val forged = f.trust.copy(configAddress = other)
        refuses(f.input.copy(identity = forged), forged)
    }
    @Test fun `historical wire verification needs no current deployment pins but still binds canonical message and signature`() = runBlocking {
        assertEquals(f.signed, MiningClaimTransaction.verifySigned(f.input, f.signed.wire))
        refuses(trust = f.trust.copy(reserveOwner = base58(ByteArray(32) { 3 })))
        assertThrows(IllegalArgumentException::class.java) { runBlocking {
            MiningClaimTransaction.verifySigned(f.input.copy(cumulativeKeepBaseUnits = "81"), f.signed.wire)
        } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking {
            MiningClaimTransaction.verifySigned(f.input, Base64.getEncoder().encodeToString(f.wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }))
        } }
        Unit
    }
    @Test fun `claimant sequence and all displayed leaf integers bind to the signed instructions`() {
        refuses(f.input.copy(leafWallet = f.trust.reserveOwner))
        refuses(f.input.copy(leafRootSequence = "2"))
        refuses(f.input.copy(rootSequence = "2", leafRootSequence = "2"))
        refuses(f.input.copy(cumulativeKeepBaseUnits = "81"))
        refuses(f.input.copy(cumulativeRenown = "0"))
        refuses(f.input.copy(cumulativeDays = "2"))
        refuses(withTx { it.copy(feePayer = f.trust.reserveOwner) })
    }
    @Test fun `noncanonical and overflowing integer inputs never reach PDA derivation`() {
        listOf("00", "01", "-1", "+1", "1.0", "18446744073709551616", "9".repeat(10000)).forEach {
            refuses(f.input.copy(cumulativeKeepBaseUnits = it))
        }
        refuses(f.input.copy(cumulativeKeepBaseUnits = "0"))
        refuses(f.input.copy(cumulativeRenown = "2"))
    }
    @Test fun `split v0 lookup tables and wrong ordinal are explicitly unsupported`() {
        refuses(f.input.copy(transactions = emptyList()))
        refuses(f.input.copy(transactions = f.input.transactions + f.input.transactions))
        refuses(withTx { it.copy(version = "v0") })
        refuses(withTx { it.copy(lookupTables = listOf(f.trust.reserveOwner)) })
        refuses(withTx { it.copy(ordinal = 1) })
        refuses(withTx { it.copy(kind = "setup") })
    }
    @Test fun `proof bytes setup actions and blockhash cannot be changed after review`() {
        refuses(f.input.copy(proof = listOf(MiningClaimProofNode("ab".repeat(32), "1", false))))
        refuses(f.input.copy(proof = List(17) { MiningClaimProofNode("ab".repeat(32), "1", false) }))
        refuses(f.input.copy(needsAta = false))
        refuses(f.input.copy(needsMinerRecords = false))
        refuses(withTx { it.copy(blockhash = f.trust.reserveOwner) })
    }
    @Test fun `oversized malformed base64 v0 and changed message header are rejected before wallet parsing`() {
        val message = Base64.getDecoder().decode(f.input.transactions.single().message)
        listOf("A".repeat(1560), "!!!!", "AA", f.input.transactions.single().message + "\n",
            Base64.getEncoder().encodeToString(message.copyOf().also { it[0] = 0x80.toByte() }),
            Base64.getEncoder().encodeToString(message.copyOf().also { it[1] = 1 })).forEach { bad -> refuses(withTx { it.copy(message = bad) }) }
    }
    @Test fun `signed wire must preserve exact message and carry valid claimant Ed25519 signature`() {
        val prepared = f.prepared()
        val variants = listOf(f.wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() },
            f.wire.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() },
            f.wire.copyOf().also { it[0] = 2 }, ByteArray(1233), f.wire + 0.toByte(), ByteArray(65),
            f.wire.copyOf().also { it.fill(0, 1, 65) })
        variants.forEach { assertThrows(IllegalArgumentException::class.java) { prepared.verifySigned(it) } }
        assertThrows(IllegalArgumentException::class.java) { prepared.verifySignedBase64(f.signed.wire + "\n") }
    }
    @Test fun `unsigned output and wallet reply buffers cannot mutate prepared or retained evidence`() {
        val prepared = f.prepared()
        prepared.unsignedTransaction().fill(0)
        val wire = f.wire; val result = prepared.verifySigned(wire); wire.fill(0)
        assertEquals(f.signed, result)
        assertEquals(f.signed, prepared.verifySigned(f.wire))
    }
}
