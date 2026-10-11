package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.CharterTransaction
import gg.pixelkingdomwars.nativeclient.wallet.CharterSigningTrust
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val charterStoreJson=Json {encodeDefaults=true}
@Serializable data class CharterSignature(val wire:String,val signature:String,val transactionSignature:String?)
@Serializable data class CharterReviewContext(val signing:JsonObject,val pins:JsonObject,val protocol:JsonObject,val crypto:JsonObject)
@Serializable data class CharterRecord(val localKey:String,val kind:String,val request:JsonObject?,val serverKey:String?=null,
    val attempts:List<String> = emptyList(),val envelope:JsonObject?=null,val review:CharterReviewContext?=null,
    val ownSignature:CharterSignature?=null,val observations:List<JsonObject> = emptyList(),val held:Boolean=false,
    /** Dead-end audit 2026-10-06: closed on this device after a same-action by-key GET answered `sale:null` for
     * exactly this key. Kept as history; a later server envelope reopens it. Absent in older journal bytes. */
    val closed:Boolean=false)
@Serializable data class CharterJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,val records:List<CharterRecord> = emptyList())

/** One atomic encrypted document contains intents, immutable original identities and
 * their complete received history. No response, timeout or missing record clears it. */
class CharterStore(private val secret:SecretStore,val identity:StarterIdentity) {
    private class Locks {val updates=Mutex();val requests=Mutex();val pending=mutableListOf<Pair<String,JsonObject>>();val pendingSignatures=mutableMapOf<String,CharterSignature>()}
    companion object {private val locks=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun shared(identity:StarterIdentity)=locks.getOrPut(identity){Locks()}}
    private val locks=shared(identity);val requests get()=locks.requests
    init {identity.validate();require(identity.origin.startsWith("https://"))}
    private suspend fun snapshot():CharterJournal {
        val raw=secret.read()?:return CharterJournal(identity=identity)
        require(raw.length<=4*1024*1024);val value=charterStoreJson.decodeFromString<CharterJournal>(raw)
        require(value.version==1 && value.identity==identity && value.revision in 0..9_007_199_254_740_991L && value.records.size<=64 && value.records.map{it.localKey}.distinct().size==value.records.size)
        value.records.forEach {r->
            CharterGrammar.id(JsonPrimitive(r.localKey));require(r.kind in listOf("creation","sale"));r.serverKey?.let{CharterGrammar.id(JsonPrimitive(it))}
            require(r.attempts.size<=64 && r.attempts.distinct().size==r.attempts.size && r.attempts.all{it.length in 1..64})
            r.request?.let{validateCharterRequest("POST","/clans/charter/client/${if(r.kind=="creation")"creations" else "sales"}",emptyMap(),it);require(it.charterText(if(r.kind=="creation")"creationIntentId" else "idempotencyKey")==r.localKey)}
            r.envelope?.let {rawEnvelope->val e=CharterEnvelope.from(rawEnvelope);require(e.actor==identity.wallet && e.kind==r.kind && e.key==r.serverKey)}
            require(r.observations.size<=64);r.observations.forEach{CharterGrammar.copy(it);require(it.charterText("actor")==identity.wallet)}
            if(r.closed)require(r.request!=null && r.review==null && r.ownSignature==null && absentOnly(r))
            r.review?.let{require(it.signing==r.envelope?.charterOptional("signing"));CharterProtocolPolicy.from(it.protocol).validate(CharterEnvelope.from(requireNotNull(r.envelope)));CharterGrammar.copy(it.pins);CharterGrammar.copy(it.crypto)}
            r.ownSignature?.let{
                require("wallet" in r.attempts && r.review!=null)
                val prepared=CharterTransaction.prepare(r.review.signing,CharterSigningTrust.from(r.review.pins),identity.wallet,charterCryptoPolicy(r.review.crypto))
                val verified=prepared.verifySignedBase64(it.wire);require(verified.signature==it.signature && verified.transactionSignature==it.transactionSignature)
            }
        }
        return value
    }
    private fun write(previous:CharterJournal,records:List<CharterRecord>):CharterJournal {
        val next=previous.copy(revision=Math.addExact(previous.revision,1),records=records.toList());require(next.records.size<=64)
        val bytes=charterStoreJson.encodeToString(CharterJournal.serializer(),next);require(bytes.length<=4*1024*1024)
        secret.write(bytes);return next
    }
    private fun replace(d:CharterJournal,key:String,change:(CharterRecord)->CharterRecord):CharterJournal {
        require(d.records.any{it.localKey==key});return write(d,d.records.map{if(it.localKey==key)change(it) else it})
    }
    private suspend fun flush():CharterJournal {
        var d=snapshot()
        while(locks.pending.isNotEmpty()) {
            val (key,raw)=locks.pending.first();d=replace(d,key){r->require(r.observations.size<64 || raw in r.observations);r.copy(observations=if(raw in r.observations)r.observations else r.observations+raw,held=true,closed=r.closed && absentAnswer(raw,r.localKey))}
            locks.pending.removeAt(0)
        }
        while(locks.pendingSignatures.isNotEmpty()) {
            val (key,signature)=locks.pendingSignatures.entries.first()
            val r=d.records.single{it.localKey==key};require("wallet" in r.attempts && r.review!=null)
            val prepared=CharterTransaction.prepare(r.review.signing,CharterSigningTrust.from(r.review.pins),identity.wallet,charterCryptoPolicy(r.review.crypto))
            val verified=prepared.verifySignedBase64(signature.wire);require(verified.signature==signature.signature && verified.transactionSignature==signature.transactionSignature)
            d=replace(d,key){old->old.ownSignature?.let{require(it==signature)};old.copy(ownSignature=signature)}
            locks.pendingSignatures.remove(key)
        }
        return d
    }
    suspend fun read():CharterJournal=locks.updates.withLock{flush()}
    suspend fun record(key:String)=read().records.single{it.localKey==key}
    suspend fun begin(kind:String,key:String,request:JsonObject):CharterRecord=locks.updates.withLock {
        val d=flush();CharterGrammar.id(JsonPrimitive(key));require(kind in listOf("creation","sale") && d.records.none{it.localKey==key})
        validateCharterRequest("POST","/clans/charter/client/${if(kind=="creation")"creations" else "sales"}",emptyMap(),request)
        require(request.charterText(if(kind=="creation")"creationIntentId" else "idempotencyKey")==key)
        check(d.records.none{it.kind==kind && it.request!=null && !it.closed && (it.envelope==null || CharterEnvelope.from(it.envelope).terminal==null)}) {"Recover the existing Charter request before creating another."}
        val r=CharterRecord(key,kind,CharterGrammar.copy(request).jsonObject,if(kind=="creation")key else null)
        write(d,d.records+r);r
    }
    suspend fun discover(kind:String,key:String):CharterRecord=locks.updates.withLock {
        val d=flush();CharterGrammar.id(JsonPrimitive(key));require(kind in listOf("creation","sale"))
        d.records.singleOrNull{it.kind==kind && it.serverKey==key}?.let{return@withLock it}
        require(d.records.none{it.localKey==key});val r=CharterRecord(key,kind,null,key);write(d,d.records+r);r
    }
    suspend fun attempt(key:String,name:String,repeatable:Boolean=false):CharterRecord=locks.updates.withLock {
        val d=flush();val r=d.records.single{it.localKey==key};check(!r.held){"An original response needs recovery."}
        val tag=if(repeatable)"$name:${r.attempts.count{it.startsWith("$name:")}}" else name
        check(tag !in r.attempts){"This action was already attempted. Check the original outcome."};require(r.attempts.size<64)
        val next=r.copy(attempts=r.attempts+tag);replace(d,key){next};next
    }
    /** Persist even a contradictory, already-attributed response before parsing adjacent
     * signing data. Any failed write latches the process until it can flush to storage. */
    suspend fun observe(key:String,input:JsonObject)=withContext(NonCancellable) {locks.updates.withLock {
        require(input.charterText("actor")==identity.wallet);val raw=CharterGrammar.copy(input).jsonObject
        locks.pending+=key to raw;flush();Unit
    }}
    suspend fun accept(key:String,envelope:CharterEnvelope)=withContext(NonCancellable) {locks.updates.withLock {
        val d=flush();val r=d.records.single{it.localKey==key};require(envelope.actor==identity.wallet && envelope.kind==r.kind && (r.serverKey==null || r.serverKey==envelope.key))
        r.request?.let{req->if(r.kind=="creation")require(envelope.state.getValue("request")==req) else {
            val o=envelope.original;require(o.charterText("seller")==identity.wallet);listOf("clanId","buyer","priceLamports","sellerLeaves").forEach{require(req[it]==o[it])}
        }}
        val old=r.envelope?.let(CharterEnvelope::from)
        if(old!=null) {
            require(old.original==envelope.original)
            if(old.signing!=null && envelope.signing!=null)require(old.signing==envelope.signing)
            if(old.wire!=null && envelope.wire!=null)require(old.wire==envelope.wire)
            if(old.terminal!=null && envelope.terminal!=null && old.terminal!=envelope.terminal) {
                val before=old.terminal!!;val after=envelope.terminal!!
                require(r.kind=="creation" && old.status=="cancelled_unpaid" && envelope.status=="refunded" &&
                    before["terminalId"]==after["terminalId"] && before["terminalTransactionId"]==after["terminalTransactionId"] &&
                    before["refundTransactionId"]==JsonNull && before["refundDestinationBaseId"]==JsonNull &&
                    after["refundTransactionId"]!=JsonNull && after["refundDestinationBaseId"]!=JsonNull)
            }
            val rank=if(r.kind=="creation")listOf("funded","admitted","issuing","prepared","signed","activated","cancelled_unpaid","refunded") else listOf("draft","accepted","members_paid","issuing","prepared","signed","completed","cancelled")
            if(rank.indexOf(envelope.status)>=rank.indexOf(old.status))require(
                (old.signing==null || envelope.signing!=null) && (old.wire==null || envelope.wire!=null) &&
                (old.terminal==null || envelope.terminal!=null) && old.contributions.all{it in envelope.contributions})
            if(rank.indexOf(envelope.status)<rank.indexOf(old.status) || old.terminal!=null && envelope.terminal==null || old.contributions.any{it !in envelope.contributions}) {
                replace(d,key){it.copy(held=false)};return@withLock
            }
        }
        replace(d,key){it.copy(serverKey=envelope.key,envelope=envelope.raw,held=false,closed=false)};Unit
    }}
    private fun absentAnswer(o:JsonObject,key:String)=runCatching{charterSaleByKey(o,identity.wallet,key)==null}.getOrDefault(false)
    /** Every retained observation is the by-key answer `sale:null` for exactly this unconfirmed sale offer. Any other
     * observation reopens a closed record in [flush], so a closed record always satisfies this. */
    private fun absentOnly(r:CharterRecord)=r.kind=="sale" && r.serverKey==null && r.envelope==null && r.observations.isNotEmpty() &&
        r.observations.all{absentAnswer(it,r.localKey)}
    /** Dead-end audit 2026-10-06: an attributed `sale:null` answer is absence, not a contradiction, so it must not
     * latch [CharterRecord.held]. Any other retained observation keeps the latch. */
    suspend fun settleAbsent(key:String)=withContext(NonCancellable) {locks.updates.withLock {
        val d=flush();val r=d.records.single{it.localKey==key};if(r.held && absentOnly(r))replace(d,key){it.copy(held=false)};Unit
    }}
    /** Dead-end audit 2026-10-06 (shape A). The repository passes the `sale:null` answer its same action just
     * retained for exactly this key. Never closes a record the server has shown, signed or reviewed. */
    suspend fun closeAbsent(key:String,absence:JsonObject):CharterRecord=locks.updates.withLock {
        val d=flush();val r=d.records.single{it.localKey==key}
        check(r.request!=null && r.review==null && r.ownSignature==null && "wallet" !in r.attempts && absentOnly(r) &&
            absence in r.observations && charterSaleByKey(absence,identity.wallet,key)==null) {"The server has shown this Charter request; it stays open."}
        val next=r.copy(held=false,closed=true);replace(d,key){next};next
    }
    suspend fun review(key:String,context:CharterReviewContext)=locks.updates.withLock {
        val d=flush();val r=d.records.single{it.localKey==key};check(!r.held && "wallet" !in r.attempts)
        require(context.signing==r.envelope?.charterOptional("signing"));r.review?.let{require(it==context)}
        replace(d,key){it.copy(review=context)};Unit
    }
    suspend fun signed(key:String,signed:CharterSignature)=withContext(NonCancellable) {locks.updates.withLock {
        CharterGrammar.id(JsonPrimitive(key));CharterGrammar.base64(JsonPrimitive(signed.wire));CharterGrammar.base64(JsonPrimitive(signed.signature),true)
        locks.pendingSignatures[key]?.let{require(it==signed)}
        // The callback already verified these exact bytes. Latch before even a read:
        // temporary Keystore/decryption failure must not lose owned wallet evidence.
        locks.pendingSignatures[key]=signed;flush();Unit
    }}
}
