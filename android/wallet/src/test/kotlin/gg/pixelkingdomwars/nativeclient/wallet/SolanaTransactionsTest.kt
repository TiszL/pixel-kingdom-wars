package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Byte-exact agreement with the web's transaction builders (`lib/chain.ts` over @solana/web3.js
 * 1.98.4, vectors generated for the devnet registry) so native land payments are the same on-chain
 * transaction the web sends, and the reviewed bytes pass the wallet-signer validation. */
class SolanaTransactionsTest {
    private val wallet = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val reference = "5Mx9V8mMkkdVDrMjAZGkYgutxSmxUdTPR846Q1okAgro"
    private val blockhash = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"
    private val entryTx = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAQJveNBGjjf2RYtW6hJE5sW9pK8gHeOt66j4rbm9jfmIew2Z1MwG8BXCI1j7DH7m1wTaRXfxaP3fkkprKUhVweehkhhY8FFA78FczdshAPe73YEil5bUWOoFDZv2Z0x5jnwhelRUoEx/1Efsg1k/67WXYfaf7pDXmHRwv0g/0jpgYsJyQbz5Ni7f8acZrYymjbyFd6PFOOpmsmvArbZhkSJGwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQMy3zuNgaaqsfNUBJKHx6RdnKbsLhQ0Whkp/86JBzByJSGOOVhaqT7K9EgjtV4id9X2lpnyROdK11CXqONigQAtpODWtxyCcfSLPWvel9IDwsU4Zu2HZ6T1IMAzEUsi4AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBCAgHAAEDAgQGBQi7ClpDU6zEzw=="
    private val entryMessage = "AQAECb3jQRo439kWLVuoSRObFvaSvIB3jreuo+K25vY35iHsNmdTMBvAVwiNY+wx+5tcE2kV38Wj935JKaylIVcHnoZIYWPBRQO/BXM3bIQD3u92BIpeW1FjqBQ2b9mdMeY58IXpUVKBMf9RH7INZP+u1l2H2n+6Q15h0cL9IP9I6YGLCckG8+TYu3/GnGa2Mpo28hXejxTjqZrJrwK22YZEiRsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEDMt87jYGmqrHzVASSh8ekXZym7C4UNFoZKf/OiQcwciUhjjlYWqk+yvRII7VeInfV9paZ8kTnStdQl6jjYoEALaTg1rccgnH0iz1r3pfSA8LFOGbth2ek9SDAMxFLIuAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQgIBwABAwIEBgUIuwpaQ1OsxM8="
    private val deedTx = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAQIveNBGjjf2RYtW6hJE5sW9pK8gHeOt66j4rbm9jfmIexIYWPBRQO/BXM3bIQD3u92BIpeW1FjqBQ2b9mdMeY58IXpUVKBMf9RH7INZP+u1l2H2n+6Q15h0cL9IP9I6YGLCckG8+TYu3/GnGa2Mpo28hXejxTjqZrJrwK22YZEiRsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEDMt87jYGmqrHzVASSh8ekXZym7C4UNFoZKf/OiQcwciUhjjlYWqk+yvRII7VeInfV9paZ8kTnStdQl6jjYoEALaTg1rccgnH0iz1r3pfSA8LFOGbth2ek9SDAMxFLIuAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQcHBgACAQMFBBHceaiWeRnVDgkAwusLAAAAAA=="
    private fun b64(text: String) = Base64.getDecoder().decode(text)

    @Test fun `base58 decoding round trips addresses and rejects other text`() {
        for (address in listOf(wallet, reference, ChainAddresses.DEVNET.coreProgram, "11111111111111111111111111111111")) {
            val bytes = base58Decode(address); assertEquals(32, bytes.size); assertEquals(address, base58(bytes))
        }
        assertArrayEquals(ByteArray(32), base58Decode("11111111111111111111111111111111"))
        assertThrows(IllegalArgumentException::class.java) { base58Decode("0OIl") }
        assertThrows(IllegalArgumentException::class.java) { publicKeyBytes("abc") }
    }
    @Test fun `compact u16 matches the short vec encoding`() {
        assertArrayEquals(byteArrayOf(0), compactU16(0)); assertArrayEquals(byteArrayOf(0x7F), compactU16(127))
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0x01), compactU16(128)); assertArrayEquals(byteArrayOf(0xFF.toByte(), 0x7F), compactU16(16383))
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x01), compactU16(16384))
    }
    @Test fun `the player PDA matches the chain package derivation`() = runBlocking {
        val pda = ShardkeepCore.playerPda(publicKeyBytes(wallet), ChainAddresses.DEVNET)
        assertEquals("4fNQ1oioZwdDuDe61ovHksuzQrtFccUZjmXRw7YG3JcM", base58(pda))
    }
    @Test fun `pay_entry serializes to the web's exact unsigned transaction and message`() = runBlocking {
        val payer = publicKeyBytes(wallet)
        val pda = ShardkeepCore.playerPda(payer, ChainAddresses.DEVNET)
        val instruction = ShardkeepCore.payEntry(payer, pda, publicKeyBytes(reference), ChainAddresses.DEVNET)
        val message = LegacyTransaction.message(payer, publicKeyBytes(blockhash), listOf(instruction))
        assertArrayEquals(b64(entryMessage), message)
        val transaction = LegacyTransaction.unsigned(payer, publicKeyBytes(blockhash), listOf(instruction))
        assertArrayEquals(b64(entryTx), transaction)
        validateTransactionSigner(transaction, wallet)
        assertThrows("Another wallet is not the required signer", IllegalArgumentException::class.java) { validateTransactionSigner(transaction, reference) }
        Unit
    }
    @Test fun `buy_sink deed serializes the kind byte and little endian lamports exactly`() {
        val payer = publicKeyBytes(wallet)
        val instruction = ShardkeepCore.buyDeed(payer, publicKeyBytes(reference), BigInteger.valueOf(200_000_000), ChainAddresses.DEVNET)
        assertEquals(8 + 1 + 8, instruction.data.size); assertEquals(9, instruction.data[8].toInt())
        assertArrayEquals(b64(deedTx), LegacyTransaction.unsigned(payer, publicKeyBytes(blockhash), listOf(instruction)))
        assertThrows(IllegalArgumentException::class.java) { ShardkeepCore.buyDeed(payer, publicKeyBytes(reference), BigInteger.ONE.shiftLeft(64), ChainAddresses.DEVNET) }
        assertThrows(IllegalArgumentException::class.java) { ShardkeepCore.buyDeed(payer, publicKeyBytes(reference), BigInteger.valueOf(-1), ChainAddresses.DEVNET) }
    }
    @Test fun `account ordering reproduces web3's locale sort and the fee payer leads`() {
        assertTrue(LegacyTransaction.collate("a1", "A1") < 0); assertTrue(LegacyTransaction.collate("B", "a") > 0)
        assertTrue(LegacyTransaction.collate("9z", "Az") < 0); assertEquals(0, LegacyTransaction.collate("Same", "Same")); assertTrue(LegacyTransaction.collate("ab", "abc") < 0)
        val payer = publicKeyBytes(wallet)
        val message = LegacyTransaction.message(payer, publicKeyBytes(blockhash), listOf(ShardkeepCore.buyDeed(payer, publicKeyBytes(reference), BigInteger.TEN, ChainAddresses.DEVNET)))
        assertEquals(1, message[0].toInt()); assertEquals(0, message[1].toInt()); assertEquals(4, message[2].toInt()); assertEquals(8, message[3].toInt())
        assertArrayEquals(payer, message.copyOfRange(4, 36))
    }
    @Test fun `mainnet addresses are never guessed and every registry key is a valid address`() {
        assertSame(ChainAddresses.DEVNET, ChainAddresses.forCluster(SolanaCluster.DEVNET))
        assertThrows(IllegalStateException::class.java) { ChainAddresses.forCluster(SolanaCluster.MAINNET) }
        assertEquals(ChainAddresses.DEVNET, ChainAddresses.forCluster(SolanaCluster.MAINNET, ChainAddresses.DEVNET))
        assertThrows(IllegalArgumentException::class.java) { ChainAddresses.DEVNET.copy(config = "short") }
        assertEquals(SolanaCluster.DEVNET, SolanaCluster.parse("devnet")); assertEquals("solana:mainnet", SolanaCluster.parse("mainnet-beta").chain)
        assertThrows(IllegalArgumentException::class.java) { SolanaCluster.parse("testnet") }
    }
}
