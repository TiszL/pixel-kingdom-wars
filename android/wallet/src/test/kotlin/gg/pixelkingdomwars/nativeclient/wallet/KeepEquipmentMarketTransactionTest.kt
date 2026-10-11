package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal fun keepMarketFixture()=Json.parseToJsonElement(requireNotNull(KeepEquipmentMarketTransactionTest::class.java.getResource("/keep-equipment-market-vectors.json")).readText()).jsonObject
internal fun keepMarketChange(o:JsonObject,path:String,value:JsonElement):JsonObject {val p=path.split('.',limit=2);return JsonObject(o+(p[0] to if(p.size==1)value else keepMarketChange(o.charterObject(p[0]),p[1],value)))}
internal fun keepMarketRows()=keepMarketFixture().getValue("vectors").jsonArray.map{it.jsonObject}

/** Expected wires came from actual SPL execution and independent TypeScript
 * construction. No private signing material or Kotlin-produced golden bytes. */
class KeepEquipmentMarketTransactionTest {
 private val policy=keepMarketFixture().charterObject("policy")
 private val rows=keepMarketRows()
 private suspend fun prepared(r:JsonObject,purchase:JsonObject=r.charterObject("purchase"),trust:JsonObject=r.charterObject("trust"))=KeepEquipmentMarketTransaction.prepare(purchase,KeepEquipmentMarketSigningTrust.from(trust),policy)
 private suspend fun reject(label:String,action:suspend()->Unit){assertNotNull(label,runCatching{action()}.exceptionOrNull())}
 private suspend fun accepted(r:JsonObject){
  val p=prepared(r);val wire=r.charterObject("wire");val original=r.charterObject("purchase").charterObject("preparation")
  assertEquals(original.charterText("messageSha256"),p.messageSha256)
  assertEquals(original.charterText("messageHex"),vehicleHex(p.unsignedTransaction().copyOfRange(65,p.unsignedTransaction().size)))
  assertEquals(wire,p.verifySigned(vehicleHex(wire.charterText("signedTransactionHex"),66,1232)))
  assertEquals(wire,KeepEquipmentMarketTransaction.verifyWire(r.charterObject("signedPurchase"),wire,policy))
  KeepEquipmentMarketTransaction.verifyHistory(r.charterObject("deliveredPurchase"),policy)
 }
 @Test fun `legacy actual seller credit burn and reservation memo reconstruct exactly`()=runBlocking{accepted(rows.first())}
 @Test fun `v0 actual seller ATA creation credit and burn reconstruct exactly`()=runBlocking{accepted(rows.last())}
 @Test fun `installed genesis mint version limits and economics cannot be replaced by response policy`()=runBlocking {
  for(r in rows){val buyer=r.charterObject("purchase").charterObject("fill").getValue("buyerWallet")
   for((path,value) in listOf("expectedGenesisHash" to buyer,"expectedKeepMint" to buyer,"transactionVersion" to if(r.charterObject("trust")["transactionVersion"]==JsonPrimitive(0))JsonPrimitive("legacy")else JsonPrimitive(0),"limits.maxFeeLamports" to JsonPrimitive("0")))reject(path){prepared(r,trust=keepMarketChange(r.charterObject("trust"),path,value))}
   reject("changed policy"){KeepEquipmentMarketTransaction.prepare(r.charterObject("purchase"),KeepEquipmentMarketSigningTrust.from(r.charterObject("trust")),keepMarketChange(policy,"sellerBps",JsonPrimitive(policy.number("sellerBps")-1)))}
  }
 }
 @Test fun `server cannot preserve consent while changing memo blockhash amount or recipient`()=runBlocking {
  val r=rows.first();val v=r.charterObject("purchase");val f=v.charterObject("fill")
  for((path,value) in listOf("preparation.blockhash" to f.getValue("buyerWallet"),"preparation.messageSha256" to JsonPrimitive("00".repeat(32)),"preparation.original.seller" to f.getValue("buyerWallet"),"preparation.original.totalBaseUnits" to JsonPrimitive("1")))reject(path){prepared(r,keepMarketChange(v,path,value))}
 }
 @Test fun `changed message remains forbidden even when attacker recomputes its SHA256`()=runBlocking {
  for(r in rows){val v=r.charterObject("purchase");val bytes=vehicleHex(v.charterObject("preparation").charterText("messageHex"),1,1167)
   for(offset in listOf(0,bytes.lastIndex)){val altered=bytes.copyOf().also{it[offset]=(it[offset].toInt() xor 1).toByte()}
    reject("message offset $offset"){prepared(r,keepMarketChange(keepMarketChange(v,"preparation.messageHex",JsonPrimitive(vehicleHex(altered))),"preparation.messageSha256",JsonPrimitive(vehicleHash(altered))))}
   }
  }
 }
 @Test fun `wire rejects changed signature header message trailing data and packet overflow`()=runBlocking {
  for(r in rows){val p=prepared(r);val wire=vehicleHex(r.charterObject("wire").charterText("signedTransactionHex"),66,1232)
   for(bad in listOf(wire.copyOf().also{it[0]=2},wire.copyOf().also{it[1]=(it[1].toInt() xor 1).toByte()},wire.copyOf().also{it[it.lastIndex]=(it.last().toInt() xor 1).toByte()},wire+byteArrayOf(0),ByteArray(1233),wire.copyOf(64)))reject("invalid signed packet"){p.verifySigned(bad)}
  }
 }
 @Test fun `wire metadata hashes and canonical signature must agree with signed bytes`()=runBlocking {
  val r=rows.first();val p=prepared(r);val wire=r.charterObject("wire")
  for(k in listOf("messageSha256","wireSha256"))reject(k){p.verifyWire(keepMarketChange(wire,k,JsonPrimitive("00".repeat(32))))}
  reject("signature"){p.verifyWire(keepMarketChange(wire,"signature",JsonPrimitive(base58(ByteArray(64)))))}
  reject("authority flag"){p.verifyWire(keepMarketChange(wire,"signingAuthorized",JsonPrimitive(true)))}
 }
 @Test fun `mutable returned unsigned packets and caller wire arrays cannot alter retained prepared proof`()=runBlocking {
  val r=rows.first();val p=prepared(r);val before=p.unsignedTransaction();p.unsignedTransaction().fill(0);assertArrayEquals(before,p.unsignedTransaction())
  val bytes=vehicleHex(r.charterObject("wire").charterText("signedTransactionHex"),66,1232);val checked=p.verifySigned(bytes);bytes.fill(0)
  assertEquals(r.charterObject("wire"),checked);assertArrayEquals(before,p.unsignedTransaction())
 }
 @Test fun `delivered history can be cryptographically checked without gaining new signing authority`()=runBlocking {
  for(r in rows){KeepEquipmentMarketTransaction.verifyHistory(r.charterObject("deliveredPurchase"),policy)
   assertEquals(JsonPrimitive(false),r.charterObject("deliveredPurchase")["signingAuthorized"])
  }
 }
 @Test fun `delivery split and canonical token account identities cannot be forged around a valid signature`()=runBlocking {
  val r=rows.first();val v=r.charterObject("deliveredPurchase");val q=v.charterObject("delivery").charterObject("proof")
  val split=keepMarketChange(keepMarketChange(v,"delivery.proof.sellerBaseUnits",JsonPrimitive((q.amount("sellerBaseUnits")+java.math.BigInteger.ONE).toString())),"delivery.proof.burnBaseUnits",JsonPrimitive((q.amount("burnBaseUnits")-java.math.BigInteger.ONE).toString()))
  reject("changed economic split"){KeepEquipmentMarketTransaction.verifyHistory(split,policy)}
  for(k in listOf("buyerAta","sellerAta"))reject(k){KeepEquipmentMarketTransaction.verifyHistory(keepMarketChange(v,"delivery.proof.$k",q.getValue("keepMint")),policy)}
 }
 @Test fun `off curve recipient and added signing trust fields fail before wallet preparation`()=runBlocking {
  val r=rows.first();val v=keepMarketChange(keepMarketChange(r.charterObject("purchase"),"fill.sellerWallet",JsonPrimitive(base58(ByteArray(32)))),"preparation.original.seller",JsonPrimitive(base58(ByteArray(32))))
  reject("non-wallet seller"){prepared(r,v)}
  reject("request-supplied authority"){prepared(r,trust=keepMarketChange(r.charterObject("trust"),"signingAuthorized",JsonPrimitive(true)))}
 }
 private val releases=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/keep-equipment-market-release-vectors.json")).readText()).jsonObject.getValue("vectors").jsonArray.map{it.jsonObject}
 @Test fun `released real signed originals remain verifiable history but never new signing capabilities`()=runBlocking {
  for((index,r) in releases.withIndex()){KeepEquipmentMarketTransaction.verifyHistory(r.charterObject("unpreparedReleased"),policy);KeepEquipmentMarketTransaction.verifyHistory(r.charterObject("failedReleased"),policy);reject("released signing"){prepared(rows[index],r.charterObject("failedReleased"))}};Unit
 }
 @Test fun `release history binds failure hash and resolved key order to genuine retained packet`()=runBlocking {
  val p=releases.first().charterObject("failedReleased");reject("evidence hash"){KeepEquipmentMarketTransaction.verifyHistory(keepMarketChange(p,"release.proof.evidenceSha256",JsonPrimitive("00".repeat(32))),policy)}
  val keys=p.charterObject("release").charterObject("proof").getValue("resolvedKeys").jsonArray.toMutableList();val key=keys[1];keys[1]=keys[2];keys[2]=key
  reject("resolved message roles"){KeepEquipmentMarketTransaction.verifyHistory(keepMarketChange(p,"release.proof.resolvedKeys",JsonArray(keys)),policy)};Unit
 }

}
