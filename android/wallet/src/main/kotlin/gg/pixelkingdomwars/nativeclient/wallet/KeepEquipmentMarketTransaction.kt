package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import java.math.BigInteger
import kotlinx.serialization.json.*
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Installed application configuration, never copied from a purchase/review. */
class KeepEquipmentMarketSigningTrust private constructor(private val owned:JsonObject) {
 fun toJson()=KeepEquipmentMarketProtocol.copy(owned).jsonObject
 val policy get()=owned.charterObject("policy")
 internal val limits get()=owned.charterObject("limits")
 internal fun text(key:String)=owned.charterText(key)
 internal fun number(key:String)=owned.number(key)
 internal fun value(key:String)=owned.getValue(key)
 companion object {fun from(raw:JsonObject):KeepEquipmentMarketSigningTrust {
  val p=KeepEquipmentMarketProtocol.copy(raw).jsonObject
  require(p.keys==setOf("version","revision","expectedGenesisHash","expectedKeepMint","transactionVersion","policy","limits","rpcTimeoutMs","maxPendingRpc"))
  require(p.number("version")==1L&&p.charterText("revision").length in 1..128);vehicleKey(p.charterText("expectedGenesisHash"));vehicleKey(p.charterText("expectedKeepMint"))
  require(p["transactionVersion"]==JsonPrimitive("legacy")||p["transactionVersion"]==JsonPrimitive(0));KeepEquipmentMarketProtocol.policy(p.charterObject("policy"))
  val l=p.charterObject("limits");require(l.keys==setOf("maxFeeLamports","maxPriorityFeeLamports","maxComputeUnitLimit"));require(l.amount("maxPriorityFeeLamports")<=l.amount("maxFeeLamports")&&l.number("maxComputeUnitLimit") in 1..1_400_000)
  require(p.number("rpcTimeoutMs") in 1..60_000&&p.number("maxPendingRpc") in 1..512);return KeepEquipmentMarketSigningTrust(p)
 }}
}

/** Exact message capability. Existing sign-only adapters verify the same sole
 * Ed25519 payer; this wrapper grants no vehicle, send or delivery authority. */
class PreparedKeepEquipmentMarket internal constructor(val wallet:String,message:ByteArray,val buyerAta:String,val sellerAta:String) {
 val signingPacket=PreparedVehicle(wallet,message)
 val messageSha256 get()=signingPacket.messageSha256
 fun unsignedTransaction()=signingPacket.unsignedTransaction()
 fun verifySigned(bytes:ByteArray)=signingPacket.verifySigned(bytes)
 fun verifyWire(raw:JsonObject)=signingPacket.verifyWire(raw)
}

object KeepEquipmentMarketTransaction {
 suspend fun prepare(purchase:JsonObject,pins:KeepEquipmentMarketSigningTrust,policy:JsonObject):PreparedKeepEquipmentMarket {
  require(KeepEquipmentMarketProtocol.policy(policy)==pins.policy){"Installed market payment policy changed"}
  val v=KeepEquipmentMarketProtocol.purchase(purchase);require(v["release"]==null){"This reservation has been closed"};val p=v.charterObject("preparation")
  require(p["expectedGenesisHash"]==pins.value("expectedGenesisHash")&&p["expectedKeepMint"]==pins.value("expectedKeepMint")&&p["transactionVersion"]==pins.value("transactionVersion")){"Market chain differs from installed pins"}
  val l=p.charterObject("limits");require(l.amount("maxFeeLamports")<=pins.limits.amount("maxFeeLamports")&&l.amount("maxPriorityFeeLamports")<=pins.limits.amount("maxPriorityFeeLamports")&&l.number("maxComputeUnitLimit")<=pins.limits.number("maxComputeUnitLimit")){"Saved payment limit exceeds installed limit"}
  return canonical(v,policy).also{verifyMetadata(v,it,policy)}
 }
 suspend fun verifyHistory(purchase:JsonObject,policy:JsonObject){val v=KeepEquipmentMarketProtocol.purchase(purchase);if(v["preparation"]!=JsonNull)verifyMetadata(v,canonical(v,policy),policy)}
 suspend fun verifyWire(purchase:JsonObject,wire:JsonObject,policy:JsonObject):JsonObject {val v=KeepEquipmentMarketProtocol.purchase(purchase);return canonical(v,policy).verifyWire(wire).also{verifyMetadata(v,canonical(v,policy),policy);v.charterOptional("wire")?.let{w->for(k in listOf("signature","messageSha256","wireSha256","signedTransactionHex"))require(it[k]==w[k])}}}
 private fun verifyMetadata(v:JsonObject,prepared:PreparedKeepEquipmentMarket,policy:JsonObject){
  v.charterOptional("wire")?.let{prepared.verifyWire(JsonObject(it-"recordedAt"))}
  v["release"]?.jsonObject?.charterOptional("proof")?.let{proof->
   val message=prepared.unsignedTransaction().let{it.copyOfRange(65,it.size)};val offset=if(message[0]==0x80.toByte())4 else 3;val count=message[offset].toInt()and 255;require(count in 1..16&&message.size>=offset+1+count*32)
   val keys=(0 until count).map{base58(message.copyOfRange(offset+1+it*32,offset+1+(it+1)*32))};require(proof.getValue("resolvedKeys").jsonArray==JsonArray(keys.map(::JsonPrimitive)))
   val evidence=buildJsonObject{for(k in listOf("slot","blockTime","error","feeLamports","resolvedKeys","lamportsBefore","lamportsAfter","tokenBalances"))put(k,proof.getValue(k))}
   require(vehicleHash(evidence.toString().toByteArray(Charsets.UTF_8))==proof.charterText("evidenceSha256")){"Saved failure evidence changed"}
   if(proof["tokenBalances"]!=JsonNull){val rows=proof.getValue("tokenBalances").jsonArray.map{it.jsonObject};val indexes=rows.map{it.number("accountIndex").toInt()};require(keys.indexOf(prepared.buyerAta) in indexes);if(CharterGrammar.bool(v.charterObject("preparation").charterObject("original").getValue("sellerAtaExists")))require(keys.indexOf(prepared.sellerAta) in indexes)
    rows.forEach{row->val expected=when(keys[row.number("accountIndex").toInt()]){prepared.buyerAta->v.charterObject("fill")["buyerWallet"];prepared.sellerAta->v.charterObject("fill")["sellerWallet"];else->error("Unexpected failed token account")};require(row["owner"]==expected&&row.charterText("programId")==KEEP_MARKET_TOKEN&&row.number("decimals")==policy.number("decimals"))}
   }
  }
  v.charterOptional("delivery")?.charterObject("proof")?.let{proof->
   val total=v.charterObject("fill").amount("totalBaseUnits");val seller=total*policy.number("sellerBps").toBigInteger()/policy.number("basisPoints").toBigInteger()
   require(proof.amount("sellerBaseUnits")==seller&&proof.amount("burnBaseUnits")==total-seller&&proof.charterText("buyerAta")==prepared.buyerAta&&proof.charterText("sellerAta")==prepared.sellerAta)
   val sig=base58Decode(proof.charterText("signature"));require(sig.size==64);prepared.verifySigned(prepared.unsignedTransaction().also{sig.copyInto(it,1)})
  }
 }
 private suspend fun canonical(v:JsonObject,rawPolicy:JsonObject):PreparedKeepEquipmentMarket {
  val policy=KeepEquipmentMarketProtocol.policy(rawPolicy);val p=v.charterObject("preparation");val o=p.charterObject("original")
  val buyer=vehicleKey(o.charterText("buyer"));val seller=vehicleKey(o.charterText("seller"));val mint=vehicleKey(o.charterText("keepMint"))
  require(Ed25519.validatePublicKeyFull(buyer,0)&&Ed25519.validatePublicKeyFull(seller,0)){"Market payer and seller must be wallet keys"}
  val token=vehicleKey(KEEP_MARKET_TOKEN);val ataProgram=vehicleKey(KEEP_MARKET_ATA);val memo=vehicleKey(VEHICLE_MEMO);val system=ByteArray(32)
  suspend fun ata(owner:ByteArray)=ProgramDerivedAddress.find(listOf(owner,token,mint),SolanaPublicKey(ataProgram)).getOrThrow().bytes
  val buyerAta=ata(buyer);val sellerAta=ata(seller)
  require(listOf(buyer,seller,mint,buyerAta,sellerAta,token,ataProgram,memo,system,vehicleKey("ComputeBudget111111111111111111111111111111")).map(::base58).distinct().size==10)
  val total=o.amount("totalBaseUnits");require(total>=policy.amount("minFillBaseUnits"));val sellerAmount=total*policy.number("sellerBps").toBigInteger()/policy.number("basisPoints").toBigInteger();val burn=total-sellerAmount
  require(sellerAmount.signum()>0&&burn.signum()>0);val decimals=policy.number("decimals").toByte()
  val instructions=mutableListOf<Instruction>()
  if(!CharterGrammar.bool(o.getValue("sellerAtaExists")))instructions+=Instruction(ataProgram,listOf(AccountMeta(buyer,true,true),AccountMeta(sellerAta,false,true),AccountMeta(seller,false,false),AccountMeta(mint,false,false),AccountMeta(system,false,false),AccountMeta(token,false,false)),byteArrayOf(1))
  instructions+=Instruction(token,listOf(AccountMeta(buyerAta,false,true),AccountMeta(mint,false,false),AccountMeta(sellerAta,false,true),AccountMeta(buyer,true,false)),byteArrayOf(12)+little(sellerAmount)+byteArrayOf(decimals))
  instructions+=Instruction(token,listOf(AccountMeta(buyerAta,false,true),AccountMeta(mint,false,true),AccountMeta(buyer,true,false)),byteArrayOf(15)+little(burn)+byteArrayOf(decimals))
  instructions+=Instruction(memo,emptyList(),("pkw:keep-market:"+o.charterText("reservationId")).toByteArray(Charsets.UTF_8))
  val legacy=compileMiningMessage(buyer,vehicleKey(p.charterText("blockhash")),instructions)
  // With no lookup tables, v0 is the same static compilation plus version and
  // empty lookup-vector bytes. No arbitrary instructions or budget are accepted.
  val message=if(p["transactionVersion"]==JsonPrimitive("legacy"))legacy else byteArrayOf(0x80.toByte())+legacy+byteArrayOf(0)
  require(message.size+65<=1232&&message.contentEquals(vehicleHex(p.charterText("messageHex"),1,1167))&&vehicleHash(message)==p.charterText("messageSha256")){"Payment differs from the original KEEP transfer, burn or memo"}
  return PreparedKeepEquipmentMarket(base58(buyer),message,base58(buyerAta),base58(sellerAta))
 }
 private fun little(amount:BigInteger)=ByteArray(8){i->amount.shiftRight(i*8).and(BigInteger.valueOf(255)).toByte()}
}
internal const val KEEP_MARKET_TOKEN="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
internal const val KEEP_MARKET_ATA="ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
