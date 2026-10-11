package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface CharterPorts {
    val transport:CharterTransport
    fun capture(newAction:Boolean):()->Unit
    fun policy():CharterProtocolPolicy?
    fun cryptoPolicy():CharterCryptoPolicy?
    fun trust():CharterSigningTrust?
    fun key():String
    suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit
    suspend fun hydrate(guard:()->Unit)
    suspend fun ready(guard:()->Unit)
    suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit)
}
data class CharterState(val loaded:Boolean=false,val busy:Boolean=false,val journal:CharterJournal?=null,val activity:CharterActivity?=null,
    val selected:String?=null,val reviewed:Boolean=false,val error:String?=null) {
    val record get()=journal?.records?.singleOrNull{it.localKey==selected}
    val envelope get()=record?.envelope?.let(CharterEnvelope::from)
}

/** Complete ordinary workflow with explicit effects and GET-only discovery. An
 * unknown result remains under its original key; no action creates a replacement. */
class CharterRepository(private val store:CharterStore,private val ports:CharterPorts) {
    private val mutable=MutableStateFlow(CharterState());val state=mutable.asStateFlow()
    @Volatile private var epoch=0L
    private var reviewGuard:(()->Unit)?=null
    private var selection:String?=null
    private val hydratedTerminals=mutableSetOf<String>()
    private val observedTerminals=mutableSetOf<String>()
    init {require(store.identity==ports.transport.identity)}
    fun dismiss(){epoch++;reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)}
    suspend fun awaitIdle(){store.requests.withLock{}}
    private suspend fun reload(guard:()->Unit,requireHydration:Boolean=true,observeOnly:Boolean=false){
        val j=store.read();guard()
        val next=j.records.singleOrNull{it.localKey==selection}?.envelope?.let(CharterEnvelope::from)
        next?.terminal?.let{terminal->observedTerminals+="${next.kind}:${next.key}:$terminal"}
        // Browsing another original must not erase a selected terminal's pending domain refresh.
        val pending=observedTerminals-hydratedTerminals
        if(pending.isNotEmpty()){
            if(observeOnly){reviewGuard=null;mutable.value=mutable.value.copy(loaded=true,journal=j,selected=selection,reviewed=false);return}
            try{ports.hydrate(guard);guard();hydratedTerminals.addAll(pending)}catch(error:Exception){
                if(error is CancellationException)throw error
                guard();reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
                if(requireHydration)throw error
                mutable.value=mutable.value.copy(loaded=true,journal=j,selected=selection,error="Current clan state could not refresh. Saved outcomes and original receipt checks remain available.");return
            }
        }
        mutable.value=mutable.value.copy(loaded=true,journal=j,selected=selection)
    }
    private suspend fun action(newAction:Boolean,historyRecovery:Boolean=false,block:suspend (()->Unit)->Unit) {
        val captured=ports.capture(newAction);val currentEpoch=epoch
        val guard={captured();check(epoch==currentEpoch){"The Charter view changed. Check the saved outcome."}}
        guard();check(store.requests.tryLock()){ "Another request owns this Charter journal." }
        try {mutable.value=mutable.value.copy(busy=true,error=null);reload(guard,requireHydration=!historyRecovery,observeOnly=historyRecovery);block(guard)}
        catch(e:Exception){if(runCatching{guard()}.isSuccess)mutable.value=mutable.value.copy(error=e.message?:"Check the saved Charter outcome.",reviewed=false);reviewGuard=null;throw e}
        finally {store.requests.unlock();if(runCatching{captured()}.isSuccess)mutable.value=mutable.value.copy(busy=false)}
    }
    private fun selected()=requireNotNull(state.value.record){"Select an original Charter request."}
    private fun route(r:CharterRecord,action:String?=null)="/clans/charter/client/${if(r.kind=="creation")"creations" else "sales"}/${requireNotNull(r.serverKey)}"+(action?.let{"/$it"}?:"")
    private fun requireEnabled(kind:String){check(state.value.activity?.raw?.charterObject("newActions")?.get(kind)?.let(CharterGrammar::bool)==true){"New Charter actions are unavailable. Saved outcomes remain available."}}
    private suspend fun verifyHistory(record:CharterRecord,envelope:CharterEnvelope) {
        val review=record.review?:return
        val trust=CharterSigningTrust.from(review.pins);val policy=charterCryptoPolicy(review.crypto)
        require(envelope.signing==review.signing);CharterProtocolPolicy.from(review.protocol).validate(envelope)
        envelope.wire?.let{CharterTransaction.verifyWire(review.signing,trust,it,policy)}
        envelope.contributions.forEach{CharterTransaction.verifyContribution(review.signing,trust,it,policy)}
    }
    private suspend fun retain(record:CharterRecord,input:JsonObject,delivery:Boolean=false,byKey:Boolean=false):CharterEnvelope? {
        // Own attributed bytes before parsing adjacent metadata or testing a view guard.
        return withContext(NonCancellable) {
            store.observe(record.localKey,input)
            val envelope=when {byKey->charterSaleByKey(input,store.identity.wallet,record.localKey);delivery->charterDelivery(input);else->CharterEnvelope.from(input)}
            if(envelope!=null){verifyHistory(store.record(record.localKey),envelope);store.accept(record.localKey,envelope)}
            else if(byKey)store.settleAbsent(record.localKey) // `sale:null` for exactly this key: absence, not a held contradiction
            envelope
        }
    }
    private suspend fun get(record:CharterRecord,guard:()->Unit,requireHydration:Boolean=true) {
        val byKey=record.kind=="sale" && record.serverKey==null
        val path=if(byKey)"/clans/charter/client/sales/by-key/${record.localKey}" else route(record)
        ports.transport.request("GET",path,null,guard){retain(record,it,byKey=byKey)};reload(guard,requireHydration=requireHydration)
    }
    suspend fun open()=action(false,historyRecovery=true){guard->mutable.value=mutable.value.copy(activity=ports.transport.activity(null,guard));reload(guard,requireHydration=false)}
    suspend fun nextPage()=action(false,historyRecovery=true){guard->val old=requireNotNull(state.value.activity);val cursor=requireNotNull(old.cursor);mutable.value=mutable.value.copy(activity=ports.transport.activity(cursor,guard));reload(guard,requireHydration=false)}
    suspend fun select(kind:String,key:String)=action(false,historyRecovery=true){guard->val r=store.discover(kind,key);guard();selection=r.localKey;mutable.value=mutable.value.copy(reviewed=false);reviewGuard=null;get(r,guard,requireHydration=false)}
    suspend fun selectSaved(localKey:String)=action(false,historyRecovery=true){guard->val r=store.record(localKey);guard();selection=r.localKey;mutable.value=mutable.value.copy(reviewed=false);reviewGuard=null;get(r,guard,requireHydration=false)}
    suspend fun checkOriginal()=action(false,historyRecovery=true){guard->get(selected(),guard,requireHydration=false)}
    /** Dead-end audit 2026-10-06 (shape A). One open sale offer blocks every new offer (CharterStore.begin). This
     * explicit GET-only action re-reads the by-key route and closes the selected offer on this device only when
     * that same read answered `sale:null` for exactly its key. A shown sale is retained and stays open. Creation
     * has no safe absence answer (its by-key read is a 404 that may also mean a closed route) and is never closed. */
    suspend fun closeAbsent()=action(false,historyRecovery=true){guard->
        val r=selected();check(charterClosable(r)){"Only an unconfirmed sale offer can be closed."}
        var absence:JsonObject?=null
        ports.transport.request("GET","/clans/charter/client/sales/by-key/${r.localKey}",null,guard){raw->if(retain(r,raw,byKey=true)==null){absence=raw}}
        reload(guard,requireHydration=false)
        val absent=checkNotNull(absence){"The server shows this sale offer. It stays open."}
        store.closeAbsent(r.localKey,absent);guard();reload(guard,requireHydration=false)
    }
    private suspend fun begin(kind:String,request:(String)->JsonObject)=action(true){guard->
        requireEnabled(kind);val policy=requireNotNull(ports.policy());policy.validate();requireNotNull(ports.trust());requireNotNull(ports.cryptoPolicy())
        val key=ports.key();val body=request(key);val r=store.begin(kind,key,body);guard();selection=key;mutable.value=mutable.value.copy(reviewed=false);reload(guard)
        store.attempt(key,"create");guard()
        ports.transport.request("POST","/clans/charter/client/${if(kind=="creation")"creations" else "sales"}",body,guard){retain(r,it)};reload(guard)
    }
    suspend fun create(baseId:String,name:String,tag:String,inviteMode:String)=begin("creation"){key->
        val p=requireNotNull(ports.policy());require(name.length in p.nameMin..p.nameMax && tag.length in p.tagMin..p.tagMax)
        buildJsonObject{put("creationIntentId",key);put("baseId",baseId);put("name",name);put("tag",tag);put("inviteMode",inviteMode)}
    }
    suspend fun sell(clanId:String,buyer:String,priceLamports:String,sellerLeaves:Boolean)=begin("sale"){key->buildJsonObject{put("clanId",clanId);put("buyer",buyer);put("priceLamports",priceLamports);put("sellerLeaves",sellerLeaves);put("idempotencyKey",key)}}
    private suspend fun command(name:String,body:JsonObject=buildJsonObject{},newAction:Boolean=true,repeatable:Boolean=false)=action(newAction){guard->
        val r=selected();if(newAction)requireEnabled(r.kind)
        store.attempt(r.localKey,name,repeatable);guard()
        ports.transport.request("POST",route(r,name),body,guard){retain(r,it)};reload(guard)
    }
    suspend fun accept(buyerBaseId:String){val e=requireNotNull(state.value.envelope);require(e.kind=="sale" && e.actor==e.original.charterText("buyer"));command("accept",buildJsonObject{put("termsHash",e.original.charterText("termsHash"));put("buyerBaseId",buyerBaseId)})}
    suspend fun payMembers()=command("pay-members")
    suspend fun prepare()=command("prepare")
    suspend fun recoverPreparation()=command("recover-preparation",newAction=false,repeatable=true)
    suspend fun recover()=command("recover",newAction=false,repeatable=true)
    suspend fun cancel()=command("cancel",newAction=false,repeatable=true)
    suspend fun refund(baseId:String?)=command("refund",buildJsonObject{baseId?.let{put("destinationBaseId",it)}},newAction=false,repeatable=true)
    suspend fun review()=action(true){guard->
        val r=selected();requireEnabled(r.kind);get(r,guard);val current=selected();check("wallet" !in current.attempts && !current.held)
        val e=requireNotNull(state.value.envelope);check(e.terminal==null && e.wire==null && e.contributions.none{it.charterText("wallet")==e.actor})
        val s=requireNotNull(e.signing);val policy=requireNotNull(ports.policy());policy.validate(e);val crypto=requireNotNull(ports.cryptoPolicy());val trust=requireNotNull(ports.trust())
        val prepared=CharterTransaction.prepare(s,trust,e.actor,crypto);guard();val live=ports.live(prepared,s,guard);live()
        store.review(r.localKey,CharterReviewContext(s,trust.toJson(),policy.toJson(),charterCryptoJson(crypto)));guard();live()
        reviewGuard={guard();live();check(ports.trust()?.toJson()==trust.toJson() && ports.policy()==policy && ports.cryptoPolicy()==crypto)}
        mutable.value=mutable.value.copy(reviewed=true);reload(guard)
    }
    suspend fun approve()=action(true){guard->
        val reviewed=requireNotNull(reviewGuard){"Review the exact Charter transaction first."};reviewed();get(selected(),guard);reviewed();val r=selected();requireEnabled(r.kind);check(!r.held && r.ownSignature==null && "wallet" !in r.attempts)
        val review=requireNotNull(r.review);val e=requireNotNull(state.value.envelope);check(e.terminal==null && e.wire==null && e.contributions.none{it.charterText("wallet")==e.actor})
        val trust=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());require(review.pins==trust.toJson() && review.crypto==charterCryptoJson(crypto) && review.protocol==ports.policy()?.toJson())
        val prepared=CharterTransaction.prepare(review.signing,trust,e.actor,crypto);guard();reviewed()
        val live=ports.live(prepared,review.signing,guard);val fresh={guard();reviewed();live();check(ports.trust()?.toJson()==review.pins && ports.cryptoPolicy()==crypto)}
        ports.ready(fresh);fresh();store.attempt(r.localKey,"wallet");fresh()
        ports.sign(prepared,fresh){signed->val verified=prepared.verifySignedBase64(signed.wire);require(verified==signed);store.signed(r.localKey,CharterSignature(signed.wire,signed.signature,signed.transactionSignature))}
        fresh();reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false);reload(guard)
    }
    suspend fun publishSignature()=action(false){guard->
        val r=selected();val own=requireNotNull(r.ownSignature);val context=requireNotNull(r.review)
        val p=CharterTransaction.prepare(context.signing,CharterSigningTrust.from(context.pins),store.identity.wallet,charterCryptoPolicy(context.crypto));p.verifySignedBase64(own.wire)
        val action=if(r.kind=="creation")"signed" else "signature"
        val body=if(r.kind=="creation")buildJsonObject{put("signedTransaction",own.wire)} else buildJsonObject{put("attemptId",context.signing.charterText("attemptId"));put("messageSha256",context.signing.charterObject("packet").charterText("messageSha256"));put("signature",own.signature)}
        store.attempt(r.localKey,"retain-signature",repeatable=true);guard();ports.transport.request("POST",route(r,action),body,guard){retain(r,it)};reload(guard)
    }
    suspend fun deliver()=action(true){guard->
        val r=selected();requireEnabled(r.kind);get(r,guard);val current=selected();val e=requireNotNull(state.value.envelope);check(e.terminal==null);val w=requireNotNull(e.wire)
        val s=requireNotNull(e.signing);val trust=requireNotNull(ports.trust());val policy=requireNotNull(ports.policy());policy.validate(e);val crypto=requireNotNull(ports.cryptoPolicy())
        current.review?.let{require(it.pins==trust.toJson() && it.signing==s && it.crypto==charterCryptoJson(crypto))}
        CharterTransaction.verifyWire(s,trust,w,crypto);val p=CharterTransaction.prepare(s,trust,e.actor,crypto);val live=ports.live(p,s,guard)
        val fresh={guard();live();check(ports.trust()?.toJson()==trust.toJson() && ports.policy()==policy && ports.cryptoPolicy()==crypto)}
        fresh();store.attempt(r.localKey,"deliver",repeatable=true);fresh();ports.transport.request("POST",route(current,"deliver"),buildJsonObject{},fresh){retain(current,it,delivery=true)};reload(guard)
    }
}

/** A saved sale offer the server has never shown: no server key, envelope, review or own signature. */
fun charterClosable(r:CharterRecord)=r.kind=="sale" && r.request!=null && !r.closed && r.serverKey==null && r.envelope==null && r.review==null && r.ownSignature==null
fun charterCryptoJson(p:CharterCryptoPolicy)=buildJsonObject{put("computeUnitLimit",p.computeUnitLimit);put("maxPolicyPermitTtlSec",p.maxPolicyPermitTtlSec);put("issuedPermitTtlSec",p.issuedPermitTtlSec);put("coreCreateFeeLamports",p.coreCreateFeeLamports);put("royaltyBps",p.royaltyBps);put("basisPoints",p.basisPoints)}
fun charterCryptoPolicy(raw:JsonObject):CharterCryptoPolicy {require(raw.keys==setOf("computeUnitLimit","maxPolicyPermitTtlSec","issuedPermitTtlSec","coreCreateFeeLamports","royaltyBps","basisPoints"));fun n(k:String)=CharterGrammar.number(raw.getValue(k))
    return CharterCryptoPolicy(n("computeUnitLimit").also{require(it<=Int.MAX_VALUE)}.toInt(),n("maxPolicyPermitTtlSec"),n("issuedPermitTtlSec"),raw.charterText("coreCreateFeeLamports"),n("royaltyBps").also{require(it<=Int.MAX_VALUE)}.toInt(),n("basisPoints").also{require(it<=Int.MAX_VALUE)}.toInt())
}
