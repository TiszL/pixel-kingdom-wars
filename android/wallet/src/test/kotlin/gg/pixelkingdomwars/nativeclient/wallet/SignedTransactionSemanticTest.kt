package gg.pixelkingdomwars.nativeclient.wallet

import java.util.Base64
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The owner's wallet prepends two ComputeBudget (priority fee) instructions to every transaction it signs — all
 * of its landed devnet payments carry them and the game never builds them. The sign-only fallback demanded
 * byte-identical messages and so rejected an honest signature as a wallet failure. The server settles by
 * reference key and exact balance deltas and the relay accepts any transaction fully signed by the session
 * wallet, so the rule that matters is: the PAYMENT must be untouched. Each way of touching it is rejected with
 * its own kind, even when the wallet's signature over the altered message is perfectly valid. */
class SignedTransactionSemanticTest {
    private val f = SignedFixture()
    private fun rejected(signed: ByteArray): WalletFailureKind = assertThrows(SignedTransactionRejected::class.java) { semanticPaymentSignature(f.unsigned, signed, f.wallet) }.kind

    @Test fun `a reply with only ComputeBudget instructions added is accepted and its own signature is returned`() {
        val checked = semanticPaymentSignature(f.unsigned, f.signedWithComputeBudget, f.wallet)
        assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, checked.mutation)
        assertArrayEquals("the signature of the RETURNED message identifies the payment", f.signedWithComputeBudget.copyOfRange(1, 65), checked.signature)
        assertFalse("the old byte-equality check is what rejected this", f.signedWithComputeBudget.copyOfRange(65, f.signedWithComputeBudget.size).contentEquals(f.unsigned.copyOfRange(65, f.unsigned.size)))
        val unchanged = semanticPaymentSignature(f.unsigned, f.signedUnchanged, f.wallet)
        assertEquals(TransactionMutation.NONE, unchanged.mutation); assertArrayEquals(f.signedUnchanged.copyOfRange(1, 65), unchanged.signature)
        // Appended or interleaved budget instructions are the same harmless addition.
        assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, semanticPaymentSignature(f.unsigned, f.signed(f.transfers() + f.computeBudget), f.wallet).mutation)
        assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, semanticPaymentSignature(f.unsigned, f.signed(listOf(f.transfers()[0], f.computeBudget[0], f.transfers()[1])), f.wallet).mutation)
    }

    /** Independent encoder: these bytes were produced and signed by @solana/web3.js (the encoder wallets use), with
     * setComputeUnitPrice + setComputeUnitLimit prepended exactly as on the owner's chain history. */
    @Test fun `a web3js transaction with the ComputeBudget prefix passes against the web3js original`() {
        val wire = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/signed-fallback-wire.json")).readText()).jsonObject
        fun bytes(key: String) = Base64.getDecoder().decode(wire.getValue(key).jsonPrimitive.content)
        val wallet = wire.getValue("wallet").jsonPrimitive.content
        val budget = semanticPaymentSignature(bytes("unsigned"), bytes("signedWithComputeBudget"), wallet)
        assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, budget.mutation); assertArrayEquals(bytes("signedWithComputeBudget").copyOfRange(1, 65), budget.signature)
        assertEquals(TransactionMutation.NONE, semanticPaymentSignature(bytes("unsigned"), bytes("signedUnchanged"), wallet).mutation)
        // The strict check used for the embedded wallet still refuses the rewritten bytes.
        assertThrows(IllegalArgumentException::class.java) { paymentTransactionSignature(bytes("unsigned"), bytes("signedWithComputeBudget"), wallet) }
        // One flipped signature bit, or the unchanged transaction's signature pasted over the rewritten message.
        val flipped = bytes("signedWithComputeBudget").also { it[10] = (it[10].toInt() xor 1).toByte() }
        assertEquals(WalletFailureKind.TX_BAD_SIGNATURE, assertThrows(SignedTransactionRejected::class.java) { semanticPaymentSignature(bytes("unsigned"), flipped, wallet) }.kind)
        val pasted = bytes("signedWithComputeBudget").also { bytes("signedUnchanged").copyInto(it, 1, 1, 65) }
        assertEquals(WalletFailureKind.TX_BAD_SIGNATURE, assertThrows(SignedTransactionRejected::class.java) { semanticPaymentSignature(bytes("unsigned"), pasted, wallet) }.kind)
    }

    @Test fun `any change to the payment itself is rejected by name although the signature is valid`() {
        assertEquals("an extra System transfer drains the wallet", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(f.signed(f.transfers() + f.transfer(ByteArray(32) { 99 }, 5_000_000))))
        assertEquals("a changed destination", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(f.signed(f.transfers(seller = ByteArray(32) { 98 }))))
        assertEquals("a changed amount", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(f.signed(f.transfers(sellerLamports = 190001))))
        assertEquals("a dropped leg", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(f.signed(f.transfers().take(1))))
        assertEquals("reordered legs", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(f.signed(f.transfers().reversed())))
        assertEquals("the reference key removed from the seller leg: the server could not find the payment",
            WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(f.signed(listOf(f.transfer(f.seller, 190000), f.transfer(f.treasury, 10000)))))
        assertEquals("a changed blockhash would desynchronise this app's expiry", WalletFailureKind.TX_BLOCKHASH_CHANGED, rejected(f.signed(f.transfers(), blockhash = ByteArray(32) { 15 })))
    }

    @Test fun `a bad signature, another version and other signers are each rejected by name`() {
        val message = f.signedUnchanged.copyOfRange(65, f.signedUnchanged.size)
        assertEquals(WalletFailureKind.TX_BAD_SIGNATURE, rejected(f.signedMessage(message, ByteArray(64) { 21 })))
        assertEquals("an empty signature slot is not a signature", WalletFailureKind.TX_BAD_SIGNATURE, rejected(f.signedMessage(message, ByteArray(64))))
        assertEquals("the signature of the unchanged message does not cover the rewritten one", WalletFailureKind.TX_BAD_SIGNATURE,
            rejected(f.signedMessage(f.signedWithComputeBudget.copyOfRange(65, f.signedWithComputeBudget.size), f.signedUnchanged.copyOfRange(1, 65))))
        assertEquals("a v0 message for a legacy request", WalletFailureKind.TX_VERSION_CHANGED, rejected(f.signedMessage(byteArrayOf(0x80.toByte()) + message)))
        assertEquals("another fee payer", WalletFailureKind.TX_SIGNERS_CHANGED, rejected(f.signed(f.transfers(), feePayer = ByteArray(32) { 97 })))
        val twoSigners = message.copyOf().also { it[0] = 2 }
        assertEquals("a second required signer", WalletFailureKind.TX_SIGNERS_CHANGED, rejected(f.signedMessage(twoSigners)))
        assertEquals("two signature slots", WalletFailureKind.TX_SIGNERS_CHANGED, rejected(byteArrayOf(2) + ByteArray(128) + message))
        for (garbage in listOf(ByteArray(0), ByteArray(40) { 1 }, f.signedUnchanged.copyOf(f.signedUnchanged.size - 3), f.signedUnchanged + byteArrayOf(0)))
            assertEquals("malformed reply of ${garbage.size} bytes", WalletFailureKind.INVALID_RESPONSE, rejected(garbage))
    }

    /** Reviewer note 2026-09-18: any number of ComputeBudget instructions was accepted and their data never read. The
     * priority fee is paid by the fee payer — the player — so a validly signed reply with an absurd
     * SetComputeUnitPrice would have been persisted and relayed, draining the wallet's SOL. */
    @Test fun `an added priority fee is bounded, so a relayed reply cannot drain the player's SOL`() {
        fun reply(vararg budget: Instruction) = f.signed(budget.toList() + f.transfers())
        fun accepted(vararg budget: Instruction) = assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, semanticPaymentSignature(f.unsigned, reply(*budget), f.wallet).mutation)
        fun tooHigh(vararg budget: Instruction) = assertEquals(WalletFailureKind.TX_PRIORITY_FEE_TOO_HIGH, rejected(reply(*budget)))
        // What the owner's real wallet adds: 375000 µlamports × 200000 units = 75,000 lamports, and 100000 × 400000 = 40,000.
        accepted(f.unitPrice(375000), f.unitLimit(200000)); accepted(f.unitLimit(400000), f.unitPrice(100000))
        // The bound is 10,000,000 lamports (0.01 SOL), inclusive, on ceil(price × limit / 1,000,000).
        accepted(f.unitPrice(10_000_000), f.unitLimit(1_000_000)); tooHigh(f.unitPrice(10_000_001), f.unitLimit(1_000_000))
        accepted(f.unitPrice(10_000_000_000_000), f.unitLimit(1)); tooHigh(f.unitPrice(10_000_000_000_001), f.unitLimit(1))
        // A price without a limit is judged against the most the runtime can ever charge for: 1,400,000 units.
        accepted(f.unitPrice(7_142_857)); tooHigh(f.unitPrice(7_142_858))
        // u64::MAX µlamports must not overflow into "cheap"; a limit alone costs nothing, whatever it says.
        tooHigh(f.unitPrice(-1), f.unitLimit(200000)); tooHigh(f.unitPrice(-1)); tooHigh(f.unitPrice(Long.MIN_VALUE), f.unitLimit(0xFFFFFFFFL))
        accepted(f.unitLimit(0xFFFFFFFFL)); accepted(f.unitPrice(0), f.unitLimit(0xFFFFFFFFL))
        // Appended instead of prepended is judged the same.
        assertEquals(WalletFailureKind.TX_PRIORITY_FEE_TOO_HIGH, rejected(f.signed(f.transfers() + f.unitPrice(50_000_000_000) + f.unitLimit(1_400_000))))
    }

    @Test fun `only one SetComputeUnitLimit and one SetComputeUnitPrice may be added, with exact data and no accounts`() {
        fun changed(why: String, vararg budget: Instruction) = assertEquals(why, WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(f.signed(budget.toList() + f.transfers())))
        changed("two prices, each under the bound: the runtime rejects duplicates and the purchase would strand", f.unitPrice(1), f.unitPrice(2))
        changed("two limits", f.unitLimit(200000), f.unitLimit(200000), f.unitPrice(1))
        // 0 = deprecated RequestUnits, which carries its own additional fee; 1 = RequestHeapFrame; 4 = SetLoadedAccountsDataSizeLimit.
        changed("RequestUnits sets a fee directly", f.budget(byteArrayOf(0) + ByteArray(8) { 0x7F }))
        for (other in listOf(1, 4, 5, 255)) changed("discriminator $other", f.budget(byteArrayOf(other.toByte()) + ByteArray(4)))
        changed("no data", f.budget(ByteArray(0)))
        changed("a price with a u32", f.budget(byteArrayOf(3) + ByteArray(4))); changed("a price with trailing bytes", f.budget(byteArrayOf(3) + ByteArray(9)))
        changed("a limit with a u64", f.budget(byteArrayOf(2) + ByteArray(8))); changed("a limit with no value", f.budget(byteArrayOf(2)))
        changed("a budget instruction that names an account", f.budget(byteArrayOf(2) + ByteArray(4), listOf(AccountMeta(f.treasury, signer = false, writable = true))))
    }

    /** Reviewer note 2026-09-18: the header's read-only counts were read and thrown away, so a reply could keep every
     * key and every instruction byte while changing WHO MAY BE WRITTEN. It passed, was persisted and relayed, then
     * failed on chain — an "uncertain" payment that strands the purchase. Each reply below is validly signed. */
    @Test fun `account privileges are part of the payment, so a reply that flips them is rejected although every key and byte of data is kept`() {
        val message = f.signedUnchanged.copyOfRange(65, f.signedUnchanged.size)
        // Header: [required signatures, read-only signed, read-only unsigned]; keys: payer, seller/treasury (writable), reference/System (read-only).
        assertArrayEquals(byteArrayOf(1, 0, 2, 5), message.copyOfRange(0, 4))
        fun header(readOnlySigned: Int, readOnlyUnsigned: Int) = f.signedMessage(message.copyOf().also { it[1] = readOnlySigned.toByte(); it[2] = readOnlyUnsigned.toByte() })
        assertEquals("sanity: the untouched header passes", TransactionMutation.NONE, semanticPaymentSignature(f.unsigned, header(0, 2), f.wallet).mutation)
        assertEquals("a read-only fee payer cannot pay", WalletFailureKind.TX_SIGNERS_CHANGED, rejected(header(1, 2)))
        assertEquals("one payee made read-only cannot be credited", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(header(0, 3)))
        assertEquals("both payees read-only", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(header(0, 4)))
        assertEquals("a read-only account made writable is a change as well", WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(header(0, 1)))
        assertEquals(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(header(0, 0)))
        assertEquals("more read-only accounts than unsigned keys is no header at all", WalletFailureKind.INVALID_RESPONSE, rejected(header(0, 5)))
        assertEquals(WalletFailureKind.INVALID_RESPONSE, rejected(header(2, 2)))
        // The same attack with the keys really moved: the seller placed last, inside the read-only range, every index rewritten to match.
        val moved = f.signedMessage(LegacyTransaction.message(f.publicKey, f.blockhash, listOf(
            Instruction(ByteArray(32), listOf(AccountMeta(f.publicKey, true, true), AccountMeta(f.seller, false, false), AccountMeta(f.reference, false, false)), f.transfers()[0].data),
            f.transfers()[1])))
        assertEquals(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, rejected(moved))
        // An honest wallet's ComputeBudget program key lands in the read-only range and changes nobody's privileges.
        assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, semanticPaymentSignature(f.unsigned, f.signedWithComputeBudget, f.wallet).mutation)
        // A key listed twice would be refused on chain ("account loaded twice") after the relay.
        val twice = message.copyOf().also { f.treasury.copyInto(it, 4 + 32 * 3) }
        assertEquals(WalletFailureKind.INVALID_RESPONSE, rejected(f.signedMessage(twice)))
    }

    @Test fun `the reviewed transaction itself must be this wallet's one-signature legacy payment`() {
        assertThrows(IllegalArgumentException::class.java) { semanticPaymentSignature(f.unsigned, f.signedUnchanged, base58(ByteArray(32) { 5 })) }
        assertThrows(IllegalArgumentException::class.java) { semanticPaymentSignature(ByteArray(3), f.signedUnchanged, f.wallet) }
    }
}
