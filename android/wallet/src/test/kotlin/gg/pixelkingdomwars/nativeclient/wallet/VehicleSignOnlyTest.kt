package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import gg.pixelkingdomwars.nativeclient.charter.*
import org.junit.Assert.*
import org.junit.Test

class VehicleSignOnlyTest {
    private val fixture=vehicleFixture("/vehicle-client-vectors.json")
    private val row=fixture.getValue("vectors").jsonArray.first().jsonObject
    private val client=row.charterObject("client")
    private val wallet=client.charterObject("record").charterText("wallet")
    private val wire=vehicleHex(row.charterObject("wire").charterText("signedTransactionHex"),66,1232)
    private fun prepared()=VehicleTransaction.prepare(client,VehicleSigningTrust.from(row.charterObject("trust")),gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy.from(fixture.charterObject("constants")))
    private class Wallet(val versions:Array<Any> = arrayOf(0), val capability:()->Unit={}, private val sign:(ByteArray)->Array<ByteArray>):AdapterOperations{
        val calls=mutableListOf<String>()
        override suspend fun getCapabilities():MobileWalletAdapterClient.GetCapabilitiesResult{
            calls+="capabilities";capability()
            // SDK result has a private constructor; exercise its actual immutable API fields.
            val c=MobileWalletAdapterClient.GetCapabilitiesResult::class.java.getDeclaredConstructor(Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Array<Any>::class.java,Array<String>::class.java)
            c.isAccessible=true;return c.newInstance(1,1,versions,emptyArray<String>())
        }
        override suspend fun signTransactions(transactions:Array<ByteArray>):MobileWalletAdapterClient.SignPayloadsResult{calls+="sign";return MobileWalletAdapterClient.SignPayloadsResult(sign(transactions.single()))}
        override suspend fun signAndSendTransactions(transactions:Array<ByteArray>,params:TransactionParams):MobileWalletAdapterClient.SignAndSendTransactionsResult=error("Vehicle never broadcasts through wallet")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun authorize(identityUri:Uri,iconUri:Uri,identityName:String,rpcCluster:RpcCluster)=error("unused")
        override suspend fun authorize(identityUri:Uri,iconUri:Uri,identityName:String,chain:String,authToken:String?,features:Array<String>?,addresses:Array<ByteArray>?,signInPayload:SignInWithSolana.Payload?)=error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun reauthorize(identityUri:Uri,iconUri:Uri,identityName:String,authToken:String)=error("unused")
        override suspend fun deauthorize(authToken:String)=error("unused")
        override suspend fun signMessages(messages:Array<ByteArray>,addresses:Array<ByteArray>)=error("unused")
        override suspend fun signMessagesDetached(messages:Array<ByteArray>,addresses:Array<ByteArray>)=error("unused")
    }

    @Test fun `authorized exact MWA signing persists attempt and final freshness before SDK invocation`()=runBlocking {
        val order=mutableListOf<String>();val p=prepared();val adapter=Wallet{bytes->assertArrayEquals(p.unsignedTransaction(),bytes);order+="wallet";arrayOf(wire)}
        adapter.signVehicleInSession(p,publicKeyBytes(wallet),{order+="guard"},{order+="marker"},{order+="retained"})
        assertEquals(listOf("guard","marker","guard","wallet","retained","guard"),order);assertEquals(listOf("sign"),adapter.calls)
    }
    @Test fun `wrong authorized account leaves marker false and original can be authorized again`()=runBlocking {
        var marker=false;val adapter=Wallet{arrayOf(wire)}
        assertThrows(IllegalArgumentException::class.java){runBlocking{adapter.signVehicleInSession(prepared(),ByteArray(32),{},{marker=true},{})}}
        assertFalse(marker);assertTrue(adapter.calls.isEmpty())
        adapter.signVehicleInSession(prepared(),publicKeyBytes(wallet),{},{marker=true},{})
        assertTrue(marker);assertEquals(listOf("sign"),adapter.calls)
    }
    @Test fun `actual signing failure keeps marker and does not fabricate evidence`()=runBlocking {
        var marker=false;val adapter=Wallet{throw IOException("invoked uncertain")}
        assertThrows(IOException::class.java){runBlocking{adapter.signVehicleInSession(prepared(),publicKeyBytes(wallet),{},{marker=true},{fail("No signature")})}}
        assertTrue(marker);assertEquals(listOf("sign"),adapter.calls)
    }
    @Test fun `failed durable marker or review expiry after persistence never calls SDK signing`()=runBlocking {
        for(expiry in listOf(false,true)){var live=true;var marker=false;val adapter=Wallet{error("must not invoke")}
            assertThrows(Exception::class.java){runBlocking{adapter.signVehicleInSession(prepared(),publicKeyBytes(wallet),{check(live)},{if(!expiry)throw IOException("store");marker=true;live=false},{})}}
            assertEquals(expiry,marker);assertTrue(adapter.calls.isEmpty())
        }
    }
    @Test fun `valid late signed wire is retained before stale MWA guard refusal`()=runBlocking {
        var live=true;var retained:JsonObject?=null;val adapter=Wallet{live=false;arrayOf(wire)}
        assertThrows(IllegalStateException::class.java){runBlocking{adapter.signVehicleInSession(prepared(),publicKeyBytes(wallet),{check(live)},{},{retained=it})}}
        assertEquals(row.charterObject("wire"),retained);assertEquals(listOf("sign"),adapter.calls)
    }
    @Test fun `invalid or multiple SDK replies never reach retained wire`()=runBlocking {
        for(reply in listOf(emptyArray(),arrayOf(wire,wire),arrayOf(wire.copyOf().also{it[1]=(it[1].toInt() xor 1).toByte()}))){val adapter=Wallet{reply};var marked=false
            assertThrows(IllegalArgumentException::class.java){runBlocking{adapter.signVehicleInSession(prepared(),publicKeyBytes(wallet),{},{marked=true},{fail("No unverified evidence")})}}
            assertTrue(marked);assertEquals(listOf("sign"),adapter.calls)
        }
    }
}
