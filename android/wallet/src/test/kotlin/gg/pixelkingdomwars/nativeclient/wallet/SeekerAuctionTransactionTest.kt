package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionBidRequest
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionPrepared
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionWithdrawRequest
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.bouncycastle.math.ec.rfc8032.Ed25519
import org.junit.Assert.*
import org.junit.Test

/** The auction bid is a money action whose bytes the SERVER writes, so the client must prove them to be the reviewed
 * action before the wallet sees them: the pinned program and mint, the reviewed round, spot and total, the wallet as
 * the only signer, and nothing else. Messages here are built the way the server builds them
 * (`packages/chain/src/seekerAuctionInstructions.ts` over IDL `shardkeep_economy.json`), with the seeds and the IDL
 * discriminator bytes written out here, independently of the verifier, which computes its own. */
class SeekerAuctionTransactionTest {
    private val f = SignedFixture()
    private val player = f.publicKey
    /** The devnet test deployment's public ids, the shape a debug BuildConfig pin carries. */
    private val pin = SeekerAuctionPin("xdBqCYi7DeTg8HBbkCU4Zy1zZDbvw5dubXoxRtcn2xs", "A68QYUbmEqNQjmumg7ta1m3KezFSVYCsfZLpSNyyUNQ2")
    private val program = publicKeyBytes(pin.programId)
    private val mint = publicKeyBytes(pin.mint)
    private val blockhash = ByteArray(32) { 4 }
    private val reviewedRound = "2"
    private val reviewedSpot = 20
    private val reviewedTotal = 123456789L
    private val bidRequest = SeekerAuctionBidRequest(reviewedRound, reviewedSpot, reviewedTotal.toString())
    private val withdrawRequest = SeekerAuctionWithdrawRequest(reviewedRound, reviewedSpot)
    private val openBid = bytes(47, 244, 91, 248, 119, 250, 130, 129)
    private val placeBid = bytes(238, 77, 148, 91, 200, 151, 92, 146)
    private val withdrawBid = bytes(110, 53, 157, 195, 147, 100, 110, 73)
    private val token = publicKeyBytes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    private val associated = publicKeyBytes("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    private val system = ByteArray(32)

    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }
    private fun le(value: Long) = ByteArray(8) { (value shr (8 * it)).toByte() }
    private suspend fun pda(owner: ByteArray, vararg seeds: ByteArray): ByteArray =
        ProgramDerivedAddress.find(seeds.toList(), SolanaPublicKey(owner)).getOrThrow().bytes
    private suspend fun ata(owner: ByteArray, coin: ByteArray) = pda(associated, owner, token, coin)

    /** Every account role of one target, derived as `seekerAuctionProtocol.ts` and spl-token derive it. */
    private class AuctionAccounts(val config: ByteArray, val authority: ByteArray, val term: ByteArray, val auction: ByteArray,
        val bid: ByteArray, val source: ByteArray, val vault: ByteArray)
    private suspend fun target(onProgram: ByteArray = program, coin: ByteArray = mint, owner: ByteArray = player,
        round: Long = 2, spot: Int = reviewedSpot): AuctionAccounts {
        val config = pda(onProgram, "auction_config".toByteArray())
        val auction = pda(onProgram, "auction".toByteArray(), config, byteArrayOf(spot.toByte()), le(round))
        return AuctionAccounts(config, pda(onProgram, "seeker_authority".toByteArray()), pda(onProgram, "seeker_term".toByteArray(), config, le(round)),
            auction, pda(onProgram, "bid".toByteArray(), auction, owner), ata(owner, coin), ata(auction, coin))
    }

    private fun meta(key: ByteArray, writable: Boolean = false, signer: Boolean = false) = AccountMeta(key, signer, writable)
    private fun openBidIx(t: AuctionAccounts, onProgram: ByteArray = program, owner: ByteArray = player) =
        Instruction(onProgram, listOf(meta(owner, true, true), meta(t.config), meta(t.auction), meta(t.bid, true), meta(system)), openBid)
    private fun placeBidIx(t: AuctionAccounts, amount: Long = reviewedTotal, onProgram: ByteArray = program, coin: ByteArray = mint,
        owner: ByteArray = player, vaultWritable: Boolean = true) =
        Instruction(onProgram, listOf(meta(owner, signer = true), meta(t.authority), meta(t.config), meta(t.term), meta(t.auction, true),
            meta(t.bid, true), meta(coin), meta(t.source, true), meta(t.vault, vaultWritable), meta(token)), placeBid + le(amount))
    private fun createAtaIx(t: AuctionAccounts, coin: ByteArray = mint, owner: ByteArray = player) =
        Instruction(associated, listOf(meta(owner, true, true), meta(t.source, true), meta(owner), meta(coin), meta(system), meta(token)), byteArrayOf(1))
    private fun withdrawIx(t: AuctionAccounts, onProgram: ByteArray = program, coin: ByteArray = mint, owner: ByteArray = player) =
        Instruction(onProgram, listOf(meta(owner, signer = true), meta(t.config), meta(t.auction, true), meta(t.bid, true), meta(coin),
            meta(t.source, true), meta(t.vault, true), meta(token)), withdrawBid)

    /** `@solana/web3.js` `TransactionMessage.compileToLegacyMessage`, the server's compiler: the payer first, then keys
     * by first use grouped as writable signers, read-only signers, writable others, read-only others. [unused] appends
     * keys that no instruction references. */
    private fun serverMessage(instructions: List<Instruction>, payer: ByteArray = player, hash: ByteArray = blockhash,
        unused: List<ByteArray> = emptyList()): ByteArray {
        val keys = mutableListOf<AccountMeta>()
        fun add(meta: AccountMeta) {
            val at = keys.indexOfFirst { it.key.contentEquals(meta.key) }
            if (at < 0) { keys.add(meta); return }
            keys[at] = keys[at].copy(signer = keys[at].signer || meta.signer, writable = keys[at].writable || meta.writable)
        }
        add(AccountMeta(payer, signer = true, writable = true))
        for (ix in instructions) { add(AccountMeta(ix.programId, signer = false, writable = false)); ix.keys.forEach(::add) }
        unused.forEach { add(AccountMeta(it, signer = false, writable = false)) }
        val ordered = keys.sortedWith(compareByDescending<AccountMeta> { it.signer }.thenByDescending { it.writable })
        fun index(key: ByteArray) = ordered.indexOfFirst { it.key.contentEquals(key) }
        val out = ByteArrayOutputStream()
        out.write(ordered.count { it.signer }); out.write(ordered.count { it.signer && !it.writable }); out.write(ordered.count { !it.signer && !it.writable })
        out.write(compactU16(ordered.size)); ordered.forEach { out.write(it.key) }; out.write(hash); out.write(compactU16(instructions.size))
        for (ix in instructions) {
            out.write(index(ix.programId)); out.write(compactU16(ix.keys.size)); ix.keys.forEach { out.write(index(it.key)) }
            out.write(compactU16(ix.data.size)); out.write(ix.data)
        }
        return out.toByteArray()
    }
    private fun prepared(message: ByteArray, quoted: ByteArray = blockhash) =
        SeekerAuctionPrepared(Base64.getEncoder().encodeToString(message), base58(quoted), "11", reviewedTotal.toString(), "5000", "0")
    private fun rejects(block: suspend () -> Unit) { assertThrows(IllegalArgumentException::class.java) { runBlocking { block() } } }

    @Test fun `a first bid with open_bid as the server builds it is accepted and is the exact wire the shared rail signs`() = runBlocking<Unit> {
        val t = target()
        val message = serverMessage(listOf(openBidIx(t), placeBidIx(t)))
        val verified = SeekerAuctionTransaction.bid(prepared(message), bidRequest, pin, f.wallet)
        val unsigned = verified.unsignedTransaction()
        assertArrayEquals(byteArrayOf(1) + ByteArray(64) + message, unsigned)
        assertEquals(listOf(f.wallet, reviewedRound, reviewedTotal.toString()), listOf(verified.wallet, verified.round, verified.newTotalRaw))
        assertEquals(reviewedSpot, verified.spot)
        // The rail's own checks take the wallet's signature over exactly these bytes, also with the owner's priority-fee prefix.
        validateTransactionSigner(unsigned, f.wallet)
        assertEquals(TransactionMutation.NONE, semanticPaymentSignature(unsigned, f.signedMessage(message), f.wallet).mutation)
        val withBudget = serverMessage(f.computeBudget + listOf(openBidIx(t), placeBidIx(t)))
        assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, semanticPaymentSignature(unsigned, f.signedMessage(withBudget), f.wallet).mutation)
    }

    @Test fun `a raise without open_bid is accepted whatever canonical key order the compiler chose`() = runBlocking<Unit> {
        val t = target()
        for (message in listOf(serverMessage(listOf(placeBidIx(t))), LegacyTransaction.message(player, blockhash, listOf(placeBidIx(t)))))
            assertArrayEquals(byteArrayOf(1) + ByteArray(64) + message,
                SeekerAuctionTransaction.bid(prepared(message), bidRequest, pin, f.wallet).unsignedTransaction())
    }

    @Test fun `a withdrawal with or without the idempotent token account setup is accepted and carries no total`() = runBlocking<Unit> {
        val t = target()
        for (instructions in listOf(listOf(withdrawIx(t)), listOf(createAtaIx(t), withdrawIx(t)))) {
            val message = serverMessage(instructions)
            val verified = SeekerAuctionTransaction.withdraw(prepared(message), withdrawRequest, pin, f.wallet)
            assertArrayEquals(byteArrayOf(1) + ByteArray(64) + message, verified.unsignedTransaction())
            assertNull(verified.newTotalRaw)
        }
    }

    @Test fun `the reviewed total round and spot bind the signed instruction`() = runBlocking<Unit> {
        val t = target()
        val message = serverMessage(listOf(placeBidIx(t)))
        // A different amount than the one the player reviewed, in either direction.
        rejects { SeekerAuctionTransaction.bid(prepared(message), bidRequest.copy(newTotalRaw = (reviewedTotal + 1).toString()), pin, f.wallet) }
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(t, amount = reviewedTotal * 10)))), bidRequest, pin, f.wallet) }
        // Another round or spot is another auction and another escrow.
        rejects { SeekerAuctionTransaction.bid(prepared(message), bidRequest.copy(round = "3"), pin, f.wallet) }
        rejects { SeekerAuctionTransaction.bid(prepared(message), bidRequest.copy(spot = reviewedSpot + 1), pin, f.wallet) }
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(target(round = 3))))), bidRequest, pin, f.wallet) }
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(target(spot = 21))))), bidRequest, pin, f.wallet) }
        val withdrawal = serverMessage(listOf(withdrawIx(t)))
        rejects { SeekerAuctionTransaction.withdraw(prepared(withdrawal), withdrawRequest.copy(round = "1"), pin, f.wallet) }
        rejects { SeekerAuctionTransaction.withdraw(prepared(withdrawal), withdrawRequest.copy(spot = 0), pin, f.wallet) }
        // Malformed reviewed values never reach a comparison.
        for (bad in listOf(bidRequest.copy(newTotalRaw = "0"), bidRequest.copy(newTotalRaw = "18446744073709551616"),
            bidRequest.copy(newTotalRaw = "0123"), bidRequest.copy(round = "-1"), bidRequest.copy(spot = 256), bidRequest.copy(spot = -1)))
            rejects { SeekerAuctionTransaction.bid(prepared(message), bad, pin, f.wallet) }
    }

    @Test fun `a message for another program or another mint is refused and a build without the pin refuses everything`() = runBlocking<Unit> {
        val acceptedProgram = publicKeyBytes("5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr") // The IDL's own address, not tonight's pin.
        val otherMint = ByteArray(32) { 3 }
        val elsewhere = target(onProgram = acceptedProgram)
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(openBidIx(elsewhere, onProgram = acceptedProgram),
            placeBidIx(elsewhere, onProgram = acceptedProgram)))), bidRequest, pin, f.wallet) }
        val otherCoin = target(coin = otherMint)
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(otherCoin, coin = otherMint)))), bidRequest, pin, f.wallet) }
        rejects { SeekerAuctionTransaction.withdraw(prepared(serverMessage(listOf(createAtaIx(otherCoin, coin = otherMint),
            withdrawIx(otherCoin, coin = otherMint)))), withdrawRequest, pin, f.wallet) }
        // The right message is still refused under the default empty pin, a partial pin, or a pin for another deployment.
        val message = serverMessage(listOf(placeBidIx(target())))
        for (wrong in listOf(SeekerAuctionPin("", ""), pin.copy(programId = ""), pin.copy(mint = ""), pin.copy(programId = base58(acceptedProgram)),
            pin.copy(mint = base58(otherMint)), pin.copy(mint = pin.programId)))
            rejects { SeekerAuctionTransaction.bid(prepared(message), bidRequest, wrong, f.wallet) }
    }

    @Test fun `any instruction or account the reviewed action does not need is refused`() = runBlocking<Unit> {
        val t = target()
        val drain = f.transfer(ByteArray(32) { 99 }, 5_000_000)
        val refusedBids = listOf(
            listOf(placeBidIx(t), drain), listOf(drain, placeBidIx(t)), listOf(openBidIx(t), placeBidIx(t), drain),
            f.computeBudget + listOf(placeBidIx(t)), // Only the wallet may add a bounded priority fee, after review.
            listOf(placeBidIx(t), openBidIx(t)), listOf(openBidIx(t), openBidIx(t)), listOf(createAtaIx(t), placeBidIx(t)),
            listOf(placeBidIx(t, vaultWritable = false)), // The escrow vault demoted to read-only.
            listOf(withdrawIx(t)), // A withdrawal presented as the reviewed bid.
        )
        for (instructions in refusedBids) rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(instructions)), bidRequest, pin, f.wallet) }
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(t)), unused = listOf(ByteArray(32) { 77 }))), bidRequest, pin, f.wallet) }
        for (instructions in listOf(listOf(placeBidIx(t)), listOf(openBidIx(t), withdrawIx(t)), listOf(withdrawIx(t), createAtaIx(t)), listOf(createAtaIx(t))))
            rejects { SeekerAuctionTransaction.withdraw(prepared(serverMessage(instructions)), withdrawRequest, pin, f.wallet) }
    }

    @Test fun `the game wallet must be the fee payer and the only signer`() = runBlocking<Unit> {
        val t = target()
        val other = ByteArray(32).also { Ed25519.generatePublicKey(ByteArray(32) { 42 }, 0, it, 0) }
        // Someone else pays the fee and becomes a second signer.
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(t)), payer = other)), bidRequest, pin, f.wallet) }
        // A complete bid for another wallet.
        val theirs = target(owner = other)
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(theirs, owner = other)), payer = other)), bidRequest, pin, f.wallet) }
        // An extra signer requirement on a reviewed account.
        val place = placeBidIx(t)
        val signingMint = Instruction(place.programId, place.keys.map { if (it.key.contentEquals(mint)) it.copy(signer = true) else it }, place.data)
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(signingMint))), bidRequest, pin, f.wallet) }
        // A program address can never sign, so it is refused as the bidder.
        val offCurve = target(owner = t.auction)
        rejects { SeekerAuctionTransaction.bid(prepared(serverMessage(listOf(placeBidIx(offCurve, owner = t.auction)), payer = t.auction)),
            bidRequest, pin, base58(t.auction)) }
    }

    @Test fun `the message must be canonical base64 for the quoted blockhash with nothing after it`() = runBlocking<Unit> {
        val message = serverMessage(listOf(placeBidIx(target())))
        rejects { SeekerAuctionTransaction.bid(prepared(message, quoted = ByteArray(32) { 5 }), bidRequest, pin, f.wallet) }
        rejects { SeekerAuctionTransaction.bid(prepared(message + byteArrayOf(0)), bidRequest, pin, f.wallet) }
        rejects { SeekerAuctionTransaction.bid(prepared(ByteArray(1232 - 64)), bidRequest, pin, f.wallet) }
        val encoded = Base64.getEncoder().encodeToString(message)
        for (bad in listOf("", "AQ=", "AR==", "$encoded\n", " $encoded", encoded.dropLast(4)))
            rejects { SeekerAuctionTransaction.bid(SeekerAuctionPrepared(bad, base58(blockhash), "11", reviewedTotal.toString(), "5000", "0"), bidRequest, pin, f.wallet) }
    }
}
