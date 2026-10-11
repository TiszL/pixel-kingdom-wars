package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CharterSignOnlyTest {
    private val fixture=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charter-client.json")).readText()).jsonObject
    private val row=fixture.getValue("rows").jsonArray.first().jsonObject
    private val signing=row.getValue("sale").jsonObject
    private val wallet=row.getValue("buyer").jsonPrimitive.content
    private val wire=Base64.getDecoder().decode(row.getValue("saleWire").jsonObject.getValue("signedTransaction").jsonPrimitive.content)
    private suspend fun prepared()=CharterTransaction.prepare(signing,CharterSigningTrust.from(fixture.getValue("trust").jsonObject),wallet,
        CharterCryptoPolicy(400000,600,540,"1500000",500,10000))
    private class Wallet(val versions:Array<Any> = arrayOf(0), val capability:()->Unit={}, private val sign:(ByteArray)->Array<ByteArray>):AdapterOperations{
        val calls=mutableListOf<String>()
        override suspend fun getCapabilities():MobileWalletAdapterClient.GetCapabilitiesResult{
            calls+="capabilities";capability()
            // SDK result has a private constructor; exercise its actual immutable API fields.
            val c=MobileWalletAdapterClient.GetCapabilitiesResult::class.java.getDeclaredConstructor(Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Array<Any>::class.java,Array<String>::class.java)
            c.isAccessible=true;return c.newInstance(1,1,versions,emptyArray<String>())
        }
        override suspend fun signTransactions(transactions:Array<ByteArray>):MobileWalletAdapterClient.SignPayloadsResult{calls+="sign";return MobileWalletAdapterClient.SignPayloadsResult(sign(transactions.single()))}
        override suspend fun signAndSendTransactions(transactions:Array<ByteArray>,params:TransactionParams):MobileWalletAdapterClient.SignAndSendTransactionsResult=error("Charter never broadcasts through wallet")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun authorize(identityUri:Uri,iconUri:Uri,identityName:String,rpcCluster:RpcCluster)=error("unused")
        override suspend fun authorize(identityUri:Uri,iconUri:Uri,identityName:String,chain:String,authToken:String?,features:Array<String>?,addresses:Array<ByteArray>?,signInPayload:SignInWithSolana.Payload?)=error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun reauthorize(identityUri:Uri,iconUri:Uri,identityName:String,authToken:String)=error("unused")
        override suspend fun deauthorize(authToken:String)=error("unused")
        override suspend fun signMessages(messages:Array<ByteArray>,addresses:Array<ByteArray>)=error("unused")
        override suspend fun signMessagesDetached(messages:Array<ByteArray>,addresses:Array<ByteArray>)=error("unused")
    }
    @Test fun `v0 capability precedes one exact sign call and durable evidence precedes final guard`()=runBlocking{
        val order=mutableListOf<String>();val p=prepared()
        val adapter=Wallet(capability={order+="capability"}){bytes->assertArrayEquals(p.unsignedTransaction(),bytes);order+="wallet";arrayOf(wire)}
        adapter.signCharterInSession(p,publicKeyBytes(wallet),{order+="guard"},{order+="retained"})
        assertEquals(listOf("guard","capability","guard","wallet","retained","guard"),order)
        assertEquals(listOf("capabilities","sign"),adapter.calls)
    }
    @Test fun `legacy only capability is unavailable with no wallet prompt`()=runBlocking{
        for(versions in listOf(arrayOf<Any>("legacy"),arrayOf<Any>("0"),emptyArray())){
            val adapter=Wallet(versions){error("must not prompt")}
            assertThrows(IllegalArgumentException::class.java){runBlocking{adapter.signCharterInSession(prepared(),publicKeyBytes(wallet),{},{})}}
            assertEquals(listOf("capabilities"),adapter.calls)
        }
    }
    @Test fun `session invalidation during capability read prevents prompt`()=runBlocking{
        var stale=false;val adapter=Wallet(capability={stale=true}){error("must not prompt")}
        assertThrows(CancellationException::class.java){runBlocking{adapter.signCharterInSession(prepared(),publicKeyBytes(wallet),{if(stale)throw CancellationException("stale")},{})}}
        assertEquals(listOf("capabilities"),adapter.calls)
    }
    @Test fun `late owned signature survives session cancellation before guard`()=runBlocking{
        var stale=false;var retained:SignedCharter?=null
        val adapter=Wallet{stale=true;arrayOf(wire)}
        assertThrows(CancellationException::class.java){runBlocking{adapter.signCharterInSession(prepared(),publicKeyBytes(wallet),{if(stale)throw CancellationException("stale")},{retained=it})}}
        assertNotNull(retained);assertEquals(listOf("capabilities","sign"),adapter.calls)
    }
    @Test fun `failed durable custody cannot become successful approval or relay`()=runBlocking{
        val adapter=Wallet{arrayOf(wire)}
        assertThrows(IOException::class.java){runBlocking{adapter.signCharterInSession(prepared(),publicKeyBytes(wallet),{},{throw IOException("encrypted store unavailable")})}}
        assertEquals(listOf("capabilities","sign"),adapter.calls)
    }
    @Test fun `wrong authorized actor is rejected before capability and signing effects`()=runBlocking{
        val adapter=Wallet{error("must not prompt")}
        assertThrows(IllegalArgumentException::class.java){runBlocking{adapter.signCharterInSession(prepared(),publicKeyBytes(row.getValue("creator").jsonPrimitive.content),{},{})}}
        assertTrue(adapter.calls.isEmpty())
    }
    @Test fun `invalid signed responses never reach durable owned custody`()=runBlocking{
        for(response in listOf(emptyArray(),arrayOf(wire,wire),arrayOf(wire.copyOf().also{it[1]=(it[1].toInt() xor 1).toByte()}),arrayOf(ByteArray(1233)))){
            val adapter=Wallet{response}
            assertThrows(IllegalArgumentException::class.java){runBlocking{adapter.signCharterInSession(prepared(),publicKeyBytes(wallet),{},{fail("unverified evidence")})}}
            assertEquals(listOf("capabilities","sign"),adapter.calls)
        }
    }
    @Test fun `cancelled coroutine still saves verified late wallet bytes in original custody`()=runBlocking{
        var retained:SignedCharter?=null
        val job=launch{
            val ownContext=coroutineContext
            val adapter=Wallet{ownContext.cancel();arrayOf(wire)}
            adapter.signCharterInSession(prepared(),publicKeyBytes(wallet),{ownContext.ensureActive()},{retained=it})
        }
        job.join()
        assertTrue(job.isCancelled);assertNotNull(retained)
    }

}
