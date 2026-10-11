package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import gg.pixelkingdomwars.nativeclient.charter.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Actual market preparation composed with the production MWA sign-only seam.
 * The provider returns independently executed fixture signatures; no live wallet. */
class KeepEquipmentMarketSignOnlyTest {
 private val rows=keepMarketRows();private val policy=keepMarketFixture().charterObject("policy")
 private suspend fun prepared(r:JsonObject=rows.first())=KeepEquipmentMarketTransaction.prepare(r.charterObject("purchase"),KeepEquipmentMarketSigningTrust.from(r.charterObject("trust")),policy)
 private fun wire(r:JsonObject=rows.first())=vehicleHex(r.charterObject("wire").charterText("signedTransactionHex"),66,1232)
 private class Wallet(private val sign:(ByteArray)->Array<ByteArray>):AdapterOperations {
  val calls=mutableListOf<String>()
  override suspend fun getCapabilities():MobileWalletAdapterClient.GetCapabilitiesResult=error("Association capability negotiation is outside this sign-only seam")
  override suspend fun signTransactions(transactions:Array<ByteArray>):MobileWalletAdapterClient.SignPayloadsResult{calls+="sign";return MobileWalletAdapterClient.SignPayloadsResult(sign(transactions.single()))}
  override suspend fun signAndSendTransactions(transactions:Array<ByteArray>,params:TransactionParams):MobileWalletAdapterClient.SignAndSendTransactionsResult=error("KEEP market wallet must never broadcast")
  @Suppress("OVERRIDE_DEPRECATION") override suspend fun authorize(identityUri:Uri,iconUri:Uri,identityName:String,rpcCluster:RpcCluster)=error("unused")
  override suspend fun authorize(identityUri:Uri,iconUri:Uri,identityName:String,chain:String,authToken:String?,features:Array<String>?,addresses:Array<ByteArray>?,signInPayload:SignInWithSolana.Payload?)=error("unused")
  @Suppress("OVERRIDE_DEPRECATION") override suspend fun reauthorize(identityUri:Uri,iconUri:Uri,identityName:String,authToken:String)=error("unused")
  override suspend fun deauthorize(authToken:String)=error("unused")
  override suspend fun signMessages(messages:Array<ByteArray>,addresses:Array<ByteArray>)=error("unused")
  override suspend fun signMessagesDetached(messages:Array<ByteArray>,addresses:Array<ByteArray>)=error("unused")
 }
 @Test fun `both actual market formats persist an attempt and signed evidence around signTransactions only`()=runBlocking {
  for(r in rows){val p=prepared(r);val order=mutableListOf<String>();val adapter=Wallet{bytes->assertArrayEquals(p.unsignedTransaction(),bytes);order+="wallet";arrayOf(wire(r))}
   val result=adapter.signVehicleInSession(p.signingPacket,publicKeyBytes(p.wallet),{order+="guard"},{order+="attempt"},{order+="retained"})
   assertEquals(r.charterObject("wire"),result);assertEquals(listOf("guard","attempt","guard","wallet","retained","guard"),order);assertEquals(listOf("sign"),adapter.calls)
  }
 }
 @Test fun `wrong or absent authorized wallet never writes attempt or invokes signing`()=runBlocking {
  for(account in listOf(null,ByteArray(32))){var marker=false;val p=prepared();val adapter=Wallet{error("No signing")}
   assertTrue(runCatching{adapter.signVehicleInSession(p.signingPacket,account,{},{marker=true},{})}.isFailure);assertFalse(marker);assertTrue(adapter.calls.isEmpty())
  }
 }
 @Test fun `durable attempt failure and changed view after persistence block wallet invocation`()=runBlocking {
  for(expired in listOf(false,true)){var live=true;val p=prepared();val adapter=Wallet{error("No signing")}
   assertTrue(runCatching{adapter.signVehicleInSession(p.signingPacket,publicKeyBytes(p.wallet),{check(live)},{if(!expired)throw IOException("Store unavailable");live=false},{})}.isFailure)
   assertTrue(adapter.calls.isEmpty())
  }
 }
 @Test fun `lost wallet reply keeps attempted state and cannot fabricate a signature`()=runBlocking {
  var marker=false;var retained=false;val p=prepared();val adapter=Wallet{throw IOException("Reply lost")}
  assertTrue(runCatching{adapter.signVehicleInSession(p.signingPacket,publicKeyBytes(p.wallet),{},{marker=true},{retained=true})}.exceptionOrNull() is IOException)
  assertTrue(marker);assertFalse(retained);assertEquals(listOf("sign"),adapter.calls)
 }
 @Test fun `late genuine signature reaches custody before stale session refusal`()=runBlocking {
  var live=true;var retained:JsonObject?=null;val p=prepared();val adapter=Wallet{live=false;arrayOf(wire())}
  assertTrue(runCatching{adapter.signVehicleInSession(p.signingPacket,publicKeyBytes(p.wallet),{check(live)},{},{retained=it})}.isFailure)
  assertEquals(rows.first().charterObject("wire"),retained);assertEquals(listOf("sign"),adapter.calls)
 }
 @Test fun `cancellation after wallet execution still drains verified evidence into custody`()=runBlocking {
  val p=prepared();var retained:JsonObject?=null;lateinit var job:Job
  val adapter=Wallet{job.cancel();arrayOf(wire())}
  job=launch(start=CoroutineStart.LAZY){adapter.signVehicleInSession(p.signingPacket,publicKeyBytes(p.wallet),{ensureActive()},{},{retained=it})}
  job.start();job.join();assertTrue(job.isCancelled);assertEquals(rows.first().charterObject("wire"),retained)
 }
 @Test fun `invalid or ambiguous wallet replies never cross the verified retention callback`()=runBlocking {
  val p=prepared();val signed=wire();val altered=signed.copyOf().also{it[1]=(it[1].toInt() xor 1).toByte()}
  for(reply in listOf(emptyArray(),arrayOf(signed,signed),arrayOf(altered),arrayOf(signed+byteArrayOf(0)))){var retained=false;val adapter=Wallet{reply}
   assertTrue(runCatching{adapter.signVehicleInSession(p.signingPacket,publicKeyBytes(p.wallet),{},{},{retained=true})}.isFailure);assertFalse(retained);assertEquals(listOf("sign"),adapter.calls)
  }
 }
 @Test fun `failed signed custody propagates uncertainty after exactly one sign call`()=runBlocking {
  val p=prepared();val adapter=Wallet{arrayOf(wire())};var attempt=false
  assertTrue(runCatching{adapter.signVehicleInSession(p.signingPacket,publicKeyBytes(p.wallet),{},{attempt=true},{throw IOException("Signed custody failed")})}.exceptionOrNull() is IOException)
  assertTrue(attempt);assertEquals(listOf("sign"),adapter.calls)
 }
}
