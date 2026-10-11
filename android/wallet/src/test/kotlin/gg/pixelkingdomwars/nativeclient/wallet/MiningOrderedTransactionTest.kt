package gg.pixelkingdomwars.nativeclient.wallet
import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedTransactionTest {
 private val cases=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-ordered-v0-cpu.json")).readText()).jsonObject.getValue("cases").jsonArray.map{it.jsonObject}
 private fun JsonObject.o(k:String)=getValue(k).jsonObject
 private fun JsonObject.s(k:String)=getValue(k).jsonPrimitive.content
 private fun hex(v:String)=v.chunked(2).map{it.toInt(16).toByte()}.toByteArray()
 private suspend fun input(c:JsonObject):Pair<MiningClaimSigningInput,MiningClaimSigningTrust>{
  val p=c.o("plan");val leaf=p.o("leaf");val f=c.o("format");val table=f.o("lookupTable");val pin=f.o("expectedLookupTable");val identity=c.o("identity")
  val config=ProgramDerivedAddress.find(listOf("economy".toByteArray()),SolanaPublicKey(publicKeyBytes(identity.s("programId")))).getOrThrow().toString()
  val trust=MiningClaimSigningTrust("11111111111111111111111111111111",identity.s("programId"),config,identity.s("keepMint"),identity.s("reserveOwner"),MiningClaimOrderedPin(pin.s("address"),pin.s("dataSha256")))
  val txs=c.getValue("transactions").jsonArray.mapIndexed{i,v->val t=v.jsonObject;MiningClaimSigningMessage(i,t.s("kind"),"v0",Base64.getEncoder().encodeToString(hex(t.s("messageHex"))),listOf(table.s("address")),p.s("wallet"),p.s("blockhash"))}
  val input=MiningClaimSigningInput(p.s("wallet"),trust.copy(orderedLookupTable=null),p.s("sequence"),leaf.s("wallet"),leaf.s("sequence"),leaf.s("cumulativeKeep"),leaf.s("cumulativeRenown"),leaf.s("cumulativeDays"),p.getValue("proof").jsonArray.map{v->val n=v.jsonObject;MiningClaimProofNode(n.s("hash"),n.s("sum"),n.getValue("isLeft").jsonPrimitive.boolean)},p.getValue("needsAta").jsonPrimitive.boolean,p.getValue("needsMinerRecords").jsonPrimitive.boolean,txs,MiningClaimOrderedFormat(table.s("address"),table.s("owner"),false,table.s("dataHex"),table.getValue("slot").jsonPrimitive.long,pin.s("address"),pin.s("dataSha256"),f.getValue("blockhashContextSlot").jsonPrimitive.long))
  return input to trust
 }
 @Test fun `depth14 through16 and every setup combination reproduce actual web3 v0 messages`()=runBlocking {
  assertEquals(12,cases.size);for(c in cases){val(i,t)=input(c);for((ordinal,raw) in c.getValue("transactions").jsonArray.withIndex()){val p=MiningClaimTransaction.prepare(i,t,ordinal,200000);val tx=raw.jsonObject;val signed=p.verifySigned(hex(tx.s("signedTransactionHex")));assertEquals(ordinal,signed.ordinal);assertArrayEquals(hex(tx.s("messageHex")),p.unsignedTransaction().copyOfRange(65,p.unsignedTransaction().size));assertEquals(signed,verifyOrderedMiningClaimWire(i.wallet,i.transactions[ordinal].blockhash,i.transactions[ordinal].message,signed.wire,ordinal))}};Unit
 }
 @Test fun `ALT pin authority context ordering and compute policy reject replacement authority`()=runBlocking {
  val(i,t)=input(cases.first());val f=requireNotNull(i.orderedFormat)
  for(changed in listOf(f.copy(expectedDataSha256="00".repeat(32)),f.copy(slot=100),f.copy(blockhashContextSlot=119),f.copy(owner=i.wallet),f.copy(dataHex=f.dataHex.substring(0,42)+"01"+f.dataHex.substring(44))))assertNotNull(runCatching{MiningClaimTransaction.prepare(i.copy(orderedFormat=changed),t,0,200000)}.exceptionOrNull())
  assertNotNull(runCatching{MiningClaimTransaction.prepare(i,t.copy(orderedLookupTable=null),0,200000)}.exceptionOrNull());assertNotNull(runCatching{MiningClaimTransaction.prepare(i,t,0,199999)}.exceptionOrNull());Unit
 }
 @Test fun `setup approval binds every later claim byte and displayed leaf before spending SOL`()=runBlocking {
  val(i,t)=input(cases.first());assertEquals(2,i.transactions.size)
  val changed=i.transactions.toMutableList();val bytes=Base64.getDecoder().decode(changed[1].message);bytes[bytes.lastIndex]=(bytes.last().toInt() xor 1).toByte();changed[1]=changed[1].copy(message=Base64.getEncoder().encodeToString(bytes))
  assertNotNull(runCatching{MiningClaimTransaction.prepare(i.copy(transactions=changed),t,0,200000)}.exceptionOrNull())
  assertNotNull(runCatching{MiningClaimTransaction.prepare(i.copy(cumulativeKeepBaseUnits="999"),t,0,200000)}.exceptionOrNull());Unit
 }

}
