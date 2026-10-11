package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WalletChallengeLoginTest {
    private val publicKey=ByteArray(32) { it.toByte() }
    private val address=base58(publicKey)
    private val signature=ByteArray(64) { (it+1).toByte() }
    private val message="Pixel Kingdom Wars\nქართული 🔐\nnonce: exact"
    private fun challenge()=jsonBody("message" to message,"nonce" to "server-nonce")
    private fun signer(sign: suspend (ByteArray) -> ByteArray = { signature.copyOf() }) = object : WalletSigner {
        override val address=this@WalletChallengeLoginTest.address
        override suspend fun signMessage(message: ByteArray)=sign(message)
    }

    @Test fun `both full and pending TOTP responses use the same exact wallet challenge`() = runBlocking {
        for(pending in listOf(false,true)) {
            var signs=0; var verifies=0
            val result=buildJsonObject { put("wallet",address); put("loginRequired",pending); put("entryPaid",true) }
            val login=WalletChallengeLogin({ assertEquals(address,it); challenge() },{ body ->
                verifies++
                assertEquals(jsonBody("wallet" to address,"signature" to base58(signature),"nonce" to "server-nonce","client" to "solana-mobile"),body)
                result
            })
            assertSame(result,login.signIn(signer { bytes -> signs++; assertArrayEquals(message.toByteArray(Charsets.UTF_8),bytes); signature.copyOf() }) {})
            assertEquals(1,signs); assertEquals(1,verifies)
        }
    }
    @Test fun `an account change after challenge or signing prevents server verification`() = runBlocking {
        for(changeDuringChallenge in listOf(false,true)) {
            var current=true; var verifies=0; var signs=0
            val login=WalletChallengeLogin({ challenge().also { if(changeDuringChallenge) current=false } },{ verifies++; jsonBody("wallet" to address) })
            try {
                login.signIn(signer { signs++; current=false; signature.copyOf() }) { if(!current) throw CancellationException("session changed") }
                fail("Stale account continued")
            } catch(_: CancellationException) { }
            assertEquals(if(changeDuringChallenge) 0 else 1,signs); assertEquals(0,verifies)
        }
    }
    @Test fun `lost verification response never repeats a signature or verification POST`() = runBlocking {
        var signs=0; var verifies=0
        val login=WalletChallengeLogin({ challenge() },{ verifies++; throw IOException("lost reply") })
        try { login.signIn(signer { signs++; signature.copyOf() }) {}; fail("Lost reply accepted") } catch(_: IOException) { }
        assertEquals(1,signs); assertEquals(1,verifies)
    }
    @Test fun `malformed challenge signature and different server identity cannot sign in`() = runBlocking {
        var signs=0; var verifies=0
        val badChallenge=WalletChallengeLogin({ jsonBody("message" to message) },{ verifies++; jsonBody("wallet" to address) })
        try { badChallenge.signIn(signer { signs++; signature }) {}; fail("Missing nonce accepted") } catch(_: IllegalArgumentException) { }
        val badSignature=WalletChallengeLogin({ challenge() },{ verifies++; jsonBody("wallet" to address) })
        try { badSignature.signIn(signer { ByteArray(63) }) {}; fail("Invalid signature accepted") } catch(_: IllegalArgumentException) { }
        assertEquals(0,signs); assertEquals(0,verifies)
        val otherIdentity=WalletChallengeLogin({ challenge() },{ jsonBody("wallet" to "other-wallet") })
        try { otherIdentity.signIn(signer()) {}; fail("Different wallet accepted") } catch(_: IllegalStateException) { }
    }
    @Test fun `detached MWA replies cannot replace the reviewed message or authorized account`() {
        val request=message.toByteArray(Charsets.UTF_8)
        assertArrayEquals(signature,checkedDetachedSignature(request,publicKey,request.copyOf(),arrayOf(publicKey.copyOf()),arrayOf(signature.copyOf())))
        assertThrows(IllegalArgumentException::class.java) { checkedDetachedSignature(request,publicKey,byteArrayOf(1),arrayOf(publicKey),arrayOf(signature)) }
        assertThrows(IllegalArgumentException::class.java) { checkedDetachedSignature(request,publicKey,request,arrayOf(ByteArray(32)),arrayOf(signature)) }
        assertThrows(IllegalArgumentException::class.java) { checkedDetachedSignature(request,publicKey,request,arrayOf(publicKey,publicKey),arrayOf(signature,signature)) }
        assertThrows(IllegalArgumentException::class.java) { checkedDetachedSignature(request,publicKey,request,arrayOf(publicKey),arrayOf(ByteArray(63))) }
    }
}
