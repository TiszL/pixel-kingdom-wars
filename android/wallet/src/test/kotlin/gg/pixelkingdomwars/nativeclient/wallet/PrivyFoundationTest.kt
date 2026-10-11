package gg.pixelkingdomwars.nativeclient.wallet

import io.privy.auth.AuthState
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class PrivyFoundationTest {
    private val key=ByteArray(32) { (it+1).toByte() }
    private val wallet=base58(key)
    private fun transaction(versioned: Boolean=false): ByteArray = byteArrayOf(2)+ByteArray(128)+
        (if(versioned) byteArrayOf(128.toByte()) else byteArrayOf())+
        byteArrayOf(2,0,0,2)+key+ByteArray(32) { 99 }+ByteArray(32)+byteArrayOf(0)+(if(versioned) byteArrayOf(0) else byteArrayOf())
    @Test fun `queued signing preserves the payload reviewed when the request was submitted`() = runBlocking {
        val queue=SigningQueue()
        val release=CompletableDeferred<Unit>()
        val first=async(start=CoroutineStart.UNDISPATCHED) { queue.run(byteArrayOf(0)) { release.await() } }
        val original=byteArrayOf(1,2,3)
        val second=async(start=CoroutineStart.UNDISPATCHED) { queue.run(original) { it.copyOf() } }
        original.fill(9)
        release.complete(Unit); first.await()
        assertArrayEquals(byteArrayOf(1,2,3),second.await())
    }
    @Test fun `caller cancellation releases non cancellable MFA and permits the next signer`() = runBlocking {
        val queue=SigningQueue()
        lateinit var pending: Continuation<Unit>
        var cancellations=0
        val first=launch(start=CoroutineStart.UNDISPATCHED) {
            queue.run(byteArrayOf(1),{ cancellations++; pending.resume(Unit) }) {
                suspendCoroutine<Unit> { pending=it }
            }
        }
        val cancelledWaiter=launch(start=CoroutineStart.UNDISPATCHED) {
            queue.run(byteArrayOf(2),{ fail("A queued cancellation must not cancel another signing request") }) { fail("Cancelled waiter ran") }
        }
        cancelledWaiter.cancelAndJoin()
        withTimeout(2_000) { first.cancelAndJoin() }
        assertEquals(1,cancellations)
        assertEquals(3,queue.run(byteArrayOf(3)) { it.single().toInt() })
    }
    @Test fun `a new MFA episode never equals an earlier episode for the same account`() {
        assertNotEquals(PrivyMfaRequest("same-user",setOf("totp")),PrivyMfaRequest("same-user",setOf("totp")))
    }
    @Test fun `missing either public identifier cannot initialize a substitute application`() {
        assertNull(PrivyPublicConfig.from(null,null)); assertNull(PrivyPublicConfig.from("existing-app",null))
        assertNull(PrivyPublicConfig.from(null,"android-client")); assertNull(PrivyPublicConfig.from("existing-app"," "))
        assertEquals("existing-app",PrivyPublicConfig.from("existing-app","android-client")?.appId)
        assertThrows(IllegalArgumentException::class.java) { PrivyPublicConfig.from("existing-app","android-client")!!.copy(appClientId=" ") }
    }
    @Test fun `unverified persisted authentication remains distinct from signed out`() {
        assertEquals(PrivySessionState.Unverified,sessionState(AuthState.AuthenticatedUnverified(Unit)))
        assertEquals(PrivySessionState.SignedOut,sessionState(AuthState.Unauthenticated))
        assertEquals(PrivySessionState.NotReady,sessionState(AuthState.NotReady))
    }
    @Test fun `legacy and v0 signing preserve reviewed message and cosigner signatures`() {
        for(versioned in listOf(false,true)) {
            val original=transaction(versioned).apply { this[65]=42 }
            val signed=original.copyOf().apply { this[1]=1 }
            validateSignedTransaction(original,signed,wallet)
            val mutatedMessage=signed.copyOf().apply { this[lastIndex]=1 }
            assertThrows(IllegalArgumentException::class.java) { validateSignedTransaction(original,mutatedMessage,wallet) }
            val mutatedCosigner=signed.copyOf().apply { this[65]=43 }
            assertThrows(IllegalArgumentException::class.java) { validateSignedTransaction(original,mutatedCosigner,wallet) }
        }
    }
    @Test fun `unsigned missing signer unsupported version and truncated transactions fail before signing`() {
        val original=transaction()
        assertThrows(IllegalArgumentException::class.java) { validateSignedTransaction(original,original,wallet) }
        assertThrows(IllegalArgumentException::class.java) { validateTransactionSigner(original,"different-wallet") }
        assertThrows(IllegalArgumentException::class.java) { validateTransactionSigner(transaction(true).apply { this[129]=129.toByte() },wallet) }
        assertThrows(IllegalArgumentException::class.java) { validateTransactionSigner(original.copyOf(140),wallet) }
    }
}
