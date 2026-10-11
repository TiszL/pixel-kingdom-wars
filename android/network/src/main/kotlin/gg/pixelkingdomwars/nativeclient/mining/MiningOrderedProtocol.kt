package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import java.security.MessageDigest
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

private fun orderedHash(v:String){require(v.matches(Regex("[0-9a-f]{64}")))}
private fun orderedTime(v:String):Instant{require(v.length in 24..27);return Instant.parse(v)}

@Serializable data class MiningClaimLookupPin(val address:String,val dataSha256:String){fun validate(){wallet(address);orderedHash(dataSha256)}}
@Serializable data class MiningClaimLookupTable(val address:String,val owner:String,val executable:Boolean,val dataHex:String,val slot:Long){fun validate(){wallet(address);require(owner=="AddressLookupTab1e1111111111111111111111111"&&!executable&&dataHex.matches(Regex("[0-9a-f]{304}")));count(slot)}}
@Serializable data class MiningClaimOrderedFormat(val version:Int,val preset:String,val lookupTable:MiningClaimLookupTable,val expectedLookupTable:MiningClaimLookupPin,val blockhashContextSlot:Long){
 fun validate(){require(version==1&&preset=="ordered-v0");lookupTable.validate();expectedLookupTable.validate();count(blockhashContextSlot);require(lookupTable.address==expectedLookupTable.address&&lookupTable.slot<=blockhashContextSlot)
  val data=lookupTable.dataHex.chunked(2).map{it.toInt(16).toByte()}.toByteArray();require(MessageDigest.getInstance("SHA-256").digest(data).joinToString(""){"%02x".format(it)}==expectedLookupTable.dataSha256)
 }
}
@Serializable data class MiningClaimSetupBinding(val claimId:String,val signature:String,val slot:Long,val observedAccountSlot:Long,val messageSha256:String,val wireSha256:String){
 fun validate(){uuid(claimId);miningClaimSignature(signature);count(slot);count(observedAccountSlot);require(observedAccountSlot>=slot);orderedHash(messageSha256);orderedHash(wireSha256)}
}
@Serializable data class MiningClaimFailureBinding(val ordinal:Int,val signature:String,val slot:Long,val observedAccountSlot:Long,val messageSha256:String,val wireSha256:String){
 fun validate(){require(ordinal in 0..1);miningClaimSignature(signature);count(slot);count(observedAccountSlot);require(observedAccountSlot>=slot);orderedHash(messageSha256);orderedHash(wireSha256)}
}
@Serializable data class MiningClaimOrdinalReview(val version:Int,val wallet:String,val claimId:String,val ordinal:Int,val status:String,val messageSha256:String,val blockhash:String,
 val preparedAt:String,val expiresAt:String,val observedAt:String,val snapshotSlot:Long,val blockHeight:Long,val lastValidBlockHeight:Long,val setup:MiningClaimSetupBinding?,
 val currentSigningAuthorized:Boolean,val relayAuthorized:Boolean,val settlementAuthorized:Boolean){
 fun validate(){require(version==1&&ordinal in 0..1&&status=="ready"&&!currentSigningAuthorized&&!relayAuthorized&&!settlementAuthorized);wallet(wallet);uuid(claimId);orderedHash(messageSha256);wallet(blockhash)
  val from=orderedTime(preparedAt);val until=orderedTime(expiresAt);val observed=orderedTime(observedAt);require(from<until&&observed>=from&&observed<until);listOf(snapshotSlot,blockHeight,lastValidBlockHeight).forEach{count(it)};require(blockHeight<=lastValidBlockHeight);setup?.let{it.validate();require(snapshotSlot>=it.observedAccountSlot)}
 }
 fun bind(p:MiningClaimPreparationView,expectedOrdinal:Int,inheritedSetup:MiningClaimSetupBinding?=null){validate();require(wallet==p.wallet&&claimId==p.claimId&&ordinal==expectedOrdinal);val tx=p.transactions[ordinal];require(blockhash==tx.blockhash&&preparedAt==p.preparedAt&&expiresAt==p.expiresAt&&lastValidBlockHeight==tx.lastValidBlockHeight);require(messageSha256==miningMessageHash(tx.message));if(ordinal==1)require(setup?.claimId==p.claimId&&setup.messageSha256==miningMessageHash(p.transactions[0].message));else require(setup==inheritedSetup)}
 companion object{fun from(raw:JsonObject)=decodeMiningClaims(raw,serializer()).also{it.validate()}}
}
@Serializable data class MiningClaimContinuationExpiry(val blockHeight:Long,val slot:Long){fun validate(){count(blockHeight);count(slot)}}
@Serializable data class MiningClaimContinuation(val version:Int,val wallet:String,val parentClaimId:String,val childClaimId:String,val reason:String,
 val parentPreparation:MiningClaimPreparationView,val setup:MiningClaimSetupBinding,val failure:MiningClaimFailureBinding?,val childPreparation:MiningClaimPreparationView,
 val expiry:MiningClaimContinuationExpiry,val createdAt:String,val currentSigningAuthorized:Boolean,val relayAuthorized:Boolean,val settlementAuthorized:Boolean,val journalClearingAuthorized:Boolean){
 fun validate(policy:MiningClaimsProtocolPolicy){require(version==1&&reason in setOf("unsigned-expired","failed")&&!currentSigningAuthorized&&!relayAuthorized&&!settlementAuthorized&&!journalClearingAuthorized);wallet(wallet);uuid(parentClaimId);uuid(childClaimId);require(parentClaimId!=childClaimId);parentPreparation.validate(policy);childPreparation.validate(policy);setup.validate();failure?.validate();expiry.validate();orderedTime(createdAt)
  val p=parentPreparation;val c=childPreparation;require(p.idempotencyKey!=c.idempotencyKey&&expiry.slot>=setup.observedAccountSlot&&expiry.slot>=(failure?.observedAccountSlot?:0)&&requireNotNull(c.format).lookupTable.slot>=expiry.slot&&orderedTime(createdAt)>=orderedTime(c.preparedAt));require(p.wallet==wallet&&c.wallet==wallet&&p.claimId==parentClaimId&&c.claimId==childClaimId&&p.format!=null&&c.format!=null&&p.identity==c.identity&&p.leaf==c.leaf&&p.root==c.root&&p.rootSequence==c.rootSequence&&p.proof==c.proof&&p.totalCumulativeBaseUnits==c.totalCumulativeBaseUnits&&p.day==c.day)
  require(!c.needsAta&&!c.needsMinerRecords&&c.transactions.size==1&&c.transactions.single().kind=="claim"&&c.transactions[0].blockhash!=p.transactions[0].blockhash&&c.format.expectedLookupTable==p.format.expectedLookupTable)
  if(p.transactions.size==2)require(setup.claimId==p.claimId&&setup.messageSha256==miningMessageHash(p.transactions[0].message))
  if(reason=="unsigned-expired")require(failure==null&&expiry.blockHeight>p.transactions.last().lastValidBlockHeight) else require(failure!=null&&failure.ordinal==p.transactions.lastIndex&&failure.messageSha256==miningMessageHash(p.transactions.last().message))
 }
 companion object{fun from(raw:JsonObject,policy:MiningClaimsProtocolPolicy)=decodeMiningClaims(raw,serializer()).also{it.validate(policy)}}
}
@Serializable data class MiningClaimContinuationEnvelope(val version:Int,val wallet:String,val parentClaimId:String,val status:String,val continuation:MiningClaimContinuation?,val serverNow:String){
 fun validate(policy:MiningClaimsProtocolPolicy){require(version==1&&status in setOf("unknown","continued")&&(status=="unknown")== (continuation==null));wallet(wallet);uuid(parentClaimId);orderedTime(serverNow);continuation?.let{it.validate(policy);require(it.wallet==wallet&&it.parentClaimId==parentClaimId)}}
 companion object{fun from(raw:JsonObject,policy:MiningClaimsProtocolPolicy)=decodeMiningClaims(raw,serializer()).also{it.validate(policy)}}
}
fun miningMessageHash(base64:String)=MessageDigest.getInstance("SHA-256").digest(java.util.Base64.getDecoder().decode(base64)).joinToString(""){"%02x".format(it)}
