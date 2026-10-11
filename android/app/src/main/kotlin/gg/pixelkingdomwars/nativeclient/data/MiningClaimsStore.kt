@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class MiningClaimSavedWire(val ordinal: Int, val wire: String, val signature: String)
@Serializable data class MiningClaimPrepareRefusal(val status: Int, val code: String) {
    fun validate() { require(definitive(status, code)) { "This preparation result is still uncertain." } }
    companion object {
        fun definitive(status: Int, code: String) = when (code) {
            "INVALID_INPUT" -> status == 400; "INSUFFICIENT_SOL" -> status == 422
            "CLAIM_ROOT_PENDING", "CLAIM_BLOCKHASH_REUSED" -> status == 409; "PHASE_E_DISABLED" -> status == 503
            else -> false
        }
    }
}
@Serializable data class MiningOrderedRefusal(val status:Int,val code:String){fun validate(){require(status==when(code){"MINING_CLAIM_INVALID_INPUT","MINING_CLAIM_NOT_PREPARED"->400;"MINING_CLAIM_NOT_EXPIRED","MINING_CLAIM_SETUP_REQUIRED","MINING_CLAIM_PARENT_SIGNED","MINING_CLAIM_DISABLED"->409;else->error("Uncertain continuation result")})}}
@Serializable data class MiningOrderedAttemptReceipt(val key:String,val refusal:MiningOrderedRefusal,val absence:MiningClaimContinuationEnvelope)
@Serializable data class MiningOrderedCustody(val signingStarted:List<Int> = emptyList(),val signed:List<MiningClaimSavedWire> = emptyList(),val submitAttempted:List<Int> = emptyList(),
    val observations:List<JsonObject> = emptyList(),val held:Boolean=false,val continuationRequest:String?=null,val continuationRefusal:MiningOrderedRefusal?=null,val previousContinuations:List<MiningOrderedAttemptReceipt> = emptyList(),val continuation:MiningClaimContinuation?=null,val parent:MiningClaimContinuation?=null)
@Serializable data class MiningClaimsOperation(val request: MiningClaimPrepareRequest, val policy: MiningClaimsProtocolPolicy,
    val prepareAttempted: Boolean = false, val prepareRefusal: MiningClaimPrepareRefusal? = null, val refusalConfirmedAbsent: Boolean = false,
    val preparation: MiningClaimPreparationView? = null, val signingStarted: Boolean = false,
    val signed: MiningClaimSavedWire? = null, val submitAttempted: Boolean = false, val claim: MiningClaimView? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val ordered:MiningOrderedCustody? = null,
    // Dead-end audit 2026-10-06: never encoded while false, so every older journal keeps its exact canonical bytes.
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val absenceConfirmed: Boolean = false)
@Serializable data class MiningClaimsJournal(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: MiningClaimsOperation?, val archives: List<MiningClaimsOperation>)

private val miningJournalJson = Json { encodeDefaults = true }
/** One process-owned encrypted store per origin/cluster/wallet. Every method rereads durable
 * state; returned data classes are observations, never permission to overwrite later evidence.
 * The synchronous signed callback can commit before wallet code checks a replacement session. */
class MiningClaimsStore(private val secret: SecretStore, val identity: StarterIdentity) {
    val requests = Mutex()
    init { identity.validate(); require(identity.origin.startsWith("https://")) }
    private fun resolved(op: MiningClaimsOperation) = op.ordered?.continuation!=null || op.claim?.state == "settled" ||
        op.claim?.state == "failed" && (op.preparation?.transactions?.size == 1 || orderedFailedSetup(op)) ||
        op.prepareRefusal != null && op.refusalConfirmedAbsent && op.preparation == null && op.signed == null && op.claim == null ||
        op.absenceConfirmed && op.prepareRefusal == null && op.preparation == null && op.signed == null && op.claim == null
    private fun validateOperation(op: MiningClaimsOperation) {
        op.request.validate(); op.policy.validate()
        op.ordered?.let{o->
            require(op.request.profile=="ordered-v0"&&!op.signingStarted&&op.signed==null&&!op.submitAttempted)
            require(o.signingStarted.size<=2&&o.signingStarted.distinct()==o.signingStarted&&o.submitAttempted.size<=2&&o.submitAttempted.distinct()==o.submitAttempted&&o.signed.size<=2&&o.signed.map{it.ordinal}.distinct().size==o.signed.size)
            for(i in o.signingStarted)require(i in requireNotNull(op.preparation).transactions.indices)
            for(w in o.signed){require(w.ordinal in o.signingStarted);require(verifyMiningClaimSavedWire(requireNotNull(op.preparation),w.wire,w.ordinal)==w)}
            require(o.submitAttempted.all{i->o.signed.any{it.ordinal==i}})
            require(o.observations.size<=64);o.observations.forEach{gg.pixelkingdomwars.nativeclient.charter.CharterGrammar.copy(it);require(it["wallet"]==JsonPrimitive(identity.wallet)&&it["claimId"]==JsonPrimitive(requireNotNull(op.preparation).claimId))}
            require(o.previousContinuations.size<=32);o.continuationRefusal?.validate();o.previousContinuations.forEach{it.refusal.validate();it.absence.validate(op.policy);require(it.absence.status=="unknown"&&it.absence.wallet==identity.wallet&&it.absence.parentClaimId==op.preparation?.claimId);gg.pixelkingdomwars.nativeclient.charter.CharterGrammar.id(JsonPrimitive(it.key))};require(o.previousContinuations.map{it.key}.distinct().size==o.previousContinuations.size)
            o.continuationRequest?.let{gg.pixelkingdomwars.nativeclient.charter.CharterGrammar.id(JsonPrimitive(it))}
            o.continuation?.let{it.validate(op.policy);require(it.parentPreparation.sameOriginal(requireNotNull(op.preparation),op.policy)&&it.childPreparation.idempotencyKey==o.continuationRequest)}
            o.parent?.let{it.validate(op.policy);require(it.childPreparation.sameOriginal(requireNotNull(op.preparation),op.policy))}
        }
        op.prepareRefusal?.let { it.validate(); require(op.prepareAttempted) }
        require(!op.refusalConfirmedAbsent || op.prepareRefusal != null)
        require(!op.absenceConfirmed || op.prepareRefusal == null && op.preparation == null && op.signed == null && op.claim == null)
        op.preparation?.let { p ->
            p.validate(op.policy); require((p.format!=null)==(op.request.profile=="ordered-v0")); require(op.prepareAttempted && p.wallet == identity.wallet && p.idempotencyKey == op.request.idempotencyKey)
        }
        require(!op.signingStarted || op.preparation != null)
        op.signed?.let { s ->
            require(op.signingStarted)
            require(verifyMiningClaimSavedWire(requireNotNull(op.preparation), s.wire) == s) { "The saved mining signature changed." }
        }
        require(!op.submitAttempted || op.signed != null)
        op.claim?.let { c ->
            c.validate(); val p = requireNotNull(op.preparation)
            require(c.state != "unknown" && c.wallet == identity.wallet && c.claimId == p.claimId && c.transactions.size == p.transactions.size)
            c.transactions.forEachIndexed { i, t -> require(t.ordinal == i && t.kind == p.transactions[i].kind) }
            op.signed?.let { s -> require(c.transactions[s.ordinal].signature.let { it == null || it == s.signature }) };op.ordered?.signed?.forEach{s->require(c.transactions[s.ordinal].signature.let{it==null||it==s.signature})}
            c.settledBaseUnits?.let { amount ->
                val paid = amount.toBigInteger(); val total = p.leaf.cumulativeKeepBaseUnits.toBigInteger()
                require(paid.signum() > 0 && paid <= total)
                if (p.needsMinerRecords && p.transactions.size == 1) require(paid == total)
            }
        }
    }
    private fun validate(j: MiningClaimsJournal) {
        require(j.version == 1 && j.identity == identity && j.revision >= 0 && j.archives.size.toLong() <= j.revision)
        require(j.revision > 0 || j.operation == null && j.archives.isEmpty())
        j.operation?.let(::validateOperation)
        j.archives.forEach { validateOperation(it); require(resolved(it)) }
        val keys = (j.archives + listOfNotNull(j.operation)).map { it.request.idempotencyKey }
        require(keys.distinct().size == keys.size) { "A mining claim request key cannot be reused." }
    }
    @Synchronized fun read(): MiningClaimsJournal {
        val text = secret.read() ?: return MiningClaimsJournal(1, identity, 0, null, emptyList())
        val raw = miningJournalJson.parseToJsonElement(text)
        val journal = miningJournalJson.decodeFromJsonElement<MiningClaimsJournal>(raw)
        // Own journals always write complete canonical primitive types. Quoted booleans/numbers,
        // unknown/missing fields and numeric coercions must not reset an irreversible marker.
        require(raw == miningJournalJson.encodeToJsonElement(journal)) { "Saved mining claims require compatible storage." }
        validate(journal); return journal
    }
    private fun save(expected: MiningClaimsJournal, next: MiningClaimsJournal): MiningClaimsJournal {
        check(read() == expected && expected.revision < Long.MAX_VALUE) { "The saved mining claim changed." }
        val saved = next.copy(revision = expected.revision + 1); validate(saved)
        secret.write(miningJournalJson.encodeToString(MiningClaimsJournal.serializer(), saved)); return saved
    }
    private fun original(key: String): Pair<MiningClaimsJournal, MiningClaimsOperation> {
        val j = read(); val op = requireNotNull(j.operation)
        check(op.request.idempotencyKey == key) { "The response belongs to another mining request." }; return j to op
    }
    @Synchronized fun begin(expected: MiningClaimsJournal, key: String, policy: MiningClaimsProtocolPolicy, profile:String? = null): MiningClaimsJournal {
        check(expected.operation == null)
        return save(expected, expected.copy(operation = MiningClaimsOperation(MiningClaimPrepareRequest(key,profile), policy,ordered=if(profile==null)null else MiningOrderedCustody())))
    }
    @Synchronized fun prepareAttempt(expected: MiningClaimsJournal): MiningClaimsJournal {
        val op = requireNotNull(expected.operation); check(!op.prepareAttempted)
        return save(expected, expected.copy(operation = op.copy(prepareAttempted = true)))
    }
    @Synchronized fun acceptPreparation(key: String, value: MiningClaimPreparationView): MiningClaimsJournal {
        val (j, op) = original(key); value.validate(op.policy)
        check(op.prepareAttempted && value.wallet == identity.wallet && value.idempotencyKey == key)
        op.preparation?.let { old -> check(old.sameOriginal(value, op.policy)) { "The original mining preparation changed." }; return j }
        return save(j, j.copy(operation = op.copy(preparation = value)))
    }
    @Synchronized fun prepareRefused(key: String, refusal: MiningClaimPrepareRefusal): MiningClaimsJournal {
        val (j, op) = original(key); refusal.validate(); check(op.prepareAttempted)
        op.prepareRefusal?.let { check(it == refusal); return j }
        // Contradictory positive evidence stays recoverable and cannot be retired as absence.
        return save(j, j.copy(operation = op.copy(prepareRefusal = refusal)))
    }
    @Synchronized fun signingAttempt(expected: MiningClaimsJournal, ordinal:Int=0): MiningClaimsJournal {
        expected.operation?.ordered?.let{o->val op=expected.operation;check(!o.held&&o.continuation==null&&o.signed.none{it.ordinal==ordinal}&&op.claim?.transactions?.get(ordinal)?.signature==null&&ordinal==nextMiningOrdinal(op));if(ordinal in o.signingStarted)return expected;return save(expected,expected.copy(operation=op.copy(ordered=o.copy(signingStarted=o.signingStarted+ordinal))))}
        val op = requireNotNull(expected.operation); check(op.preparation != null && op.signed == null && op.claim?.state !in setOf("settled", "failed"))
        return save(expected, expected.copy(operation = op.copy(signingStarted = true)))
    }
    @Synchronized fun acceptSigned(key: String, wire: String, ordinal:Int=0): MiningClaimsJournal {
        val journal=read()
        if(journal.operation?.request?.idempotencyKey!=key){
            // An explicitly continued parent still owns any late wallet bytes.
            // Archival custody grants no authority to sign or deliver them again.
            val index=journal.archives.indexOfFirst{it.request.idempotencyKey==key};check(index>=0)
            val parent=journal.archives[index];val custody=requireNotNull(parent.ordered)
            check(custody.continuation!=null&&ordinal in custody.signingStarted)
            val signed=verifyMiningClaimSavedWire(requireNotNull(parent.preparation),wire,ordinal)
            custody.signed.singleOrNull{it.ordinal==ordinal}?.let{check(it==signed);return journal}
            val changed=parent.copy(ordered=custody.copy(signed=(custody.signed+signed).sortedBy{it.ordinal}))
            return save(journal,journal.copy(archives=journal.archives.mapIndexed{i,op->if(i==index)changed else op}))
        }
        val current=original(key);current.second.ordered?.let{o->val(j,op)=current;check(ordinal in o.signingStarted);val signed=verifyMiningClaimSavedWire(requireNotNull(op.preparation),wire,ordinal);o.signed.singleOrNull{it.ordinal==ordinal}?.let{check(it==signed);return j};return save(j,j.copy(operation=op.copy(ordered=o.copy(signed=(o.signed+signed).sortedBy{it.ordinal}))))}
        val (j, op) = original(key); check(op.signingStarted)
        val signed = verifyMiningClaimSavedWire(requireNotNull(op.preparation), wire)
        op.signed?.let { check(it == signed) { "The original signed mining wire changed." }; return j }
        return save(j, j.copy(operation = op.copy(signed = signed)))
    }
    @Synchronized fun submitAttempt(expected: MiningClaimsJournal, ordinal:Int=0): MiningClaimsJournal {
        expected.operation?.ordered?.let{o->val op=expected.operation;check(!o.held&&o.continuation==null&&o.signed.any{it.ordinal==ordinal}&&ordinal==nextMiningOrdinal(op));if(ordinal in o.submitAttempted)return expected;return save(expected,expected.copy(operation=op.copy(ordered=o.copy(submitAttempted=o.submitAttempted+ordinal))))}
        val op = requireNotNull(expected.operation); check(op.signed != null && !op.submitAttempted && op.claim?.state !in setOf("settled", "failed"))
        return save(expected, expected.copy(operation = op.copy(submitAttempted = true)))
    }
    @Synchronized fun acceptClaim(key: String, value: MiningClaimView): MiningClaimsJournal {
        val (j, op) = original(key); value.validate(); val p = requireNotNull(op.preparation)
        check(value.wallet == identity.wallet && value.claimId == p.claimId)
        if (value.state == "unknown") { check(op.claim == null) { "The saved mining receipt is temporarily unavailable." }; return j }
        op.claim?.let { old ->
            fun rank(state: String) = when (state) { "unknown" -> 0; "prepared" -> 1; "retained" -> 2; "settled", "failed" -> 3; else -> -1 }
            val splitFailure = old.state == "failed" && p.transactions.size == 2
            check(rank(value.state) >= (if (splitFailure) 2 else rank(old.state)) && value.transactions.size == old.transactions.size)
            if (old.state == "settled") check(value.state == "settled" && value.signature == old.signature && value.settledBaseUnits == old.settledBaseUnits && value.landing == old.landing)
            if (old.state == "settled" && p.transactions.size == 1 || old.state == "failed" && !splitFailure) check(value.copy(serverNow = old.serverNow) == old)
            old.transactions.forEachIndexed { i, before ->
                val after = value.transactions[i]; check(before.ordinal == after.ordinal && before.kind == after.kind)
                if (before.signature != null) check(before.signature == after.signature && before.acceptedAt == after.acceptedAt)
                if (before.landing in setOf("finalized", "failed")) check(before == after)
            }
            if (value.copy(serverNow = old.serverNow) == old && op.ordered?.held!=true) return j
        }
        op.ordered?.let{o->
            val claims=o.observations.flatMap{observedMiningTerminals(it)}.toSet();val current=observedMiningTerminals(miningJournalJson.encodeToJsonElement(MiningClaimView.serializer(),value).jsonObject)
            check(claims.all{it in current}){"Saved terminal evidence needs a matching original outcome."}
            return save(j,j.copy(operation=op.copy(claim=value,ordered=o.copy(held=false))))
        }
        return save(j, j.copy(operation = op.copy(claim = value)))
    }
    @Synchronized fun finish(expected: MiningClaimsJournal): MiningClaimsJournal {
        val op = requireNotNull(expected.operation); check(op.claim?.state == "settled" && op.ordered?.held!=true) { "Check the finalized payment receipt first." }
        return save(expected, expected.copy(operation = null, archives = expected.archives + op))
    }
    /** A fresh matching failed receipt retires only this request. Fees are not refunded or retried. */
    @Synchronized fun archiveFailed(expected: MiningClaimsJournal, proof: MiningClaimView): MiningClaimsJournal {
        val op = requireNotNull(expected.operation); val failed = requireNotNull(op.claim); proof.validate()
        check((op.preparation?.transactions?.size == 1 || orderedFailedSetup(op)) && op.ordered?.held!=true && failed.state == "failed" && proof.copy(serverNow = failed.serverNow) == failed) { "Check the verified single-transaction failed receipt first." }
        return save(expected, expected.copy(operation = null, archives = expected.archives + op))
    }
    /** Only the controller's fresh authenticated GET can supply absence. CAS rejects a
     * concurrently arrived preparation/signature; time alone never grants this transition. */
    @Synchronized fun archiveRefusal(expected: MiningClaimsJournal, proof: MiningClaimPreparationEnvelope): MiningClaimsJournal {
        val op = requireNotNull(expected.operation); proof.validate(op.policy)
        check(op.ordered?.held!=true && op.prepareRefusal != null && op.preparation == null && op.signed == null && op.claim == null)
        check(proof.wallet == identity.wallet && proof.idempotencyKey == op.request.idempotencyKey && proof.status == "unknown" && proof.receipt == null)
        return save(expected, expected.copy(operation = null, archives = expected.archives + op.copy(refusalConfirmedAbsent = true)))
    }
    /** Owner rule 2026-10-06 (no saved request blocks play forever), case (a) only: a request with neither a recovered
     * preparation nor a definitive refusal retires when the controller's fresh by-key preparation read in the same locked
     * action answered `unknown` for exactly its key. CAS rejects a concurrently arrived preparation. An expired preparation
     * the server still knows is NOT this case and never retires here. */
    @Synchronized fun archiveAbsent(expected: MiningClaimsJournal, proof: MiningClaimPreparationEnvelope): MiningClaimsJournal {
        val op = requireNotNull(expected.operation); proof.validate(op.policy)
        check((op.ordered == null || op.ordered == MiningOrderedCustody()) && op.prepareRefusal == null && op.preparation == null &&
            !op.signingStarted && op.signed == null && !op.submitAttempted && op.claim == null) { "Only a saved request without a recovered preparation can close." }
        check(proof.wallet == identity.wallet && proof.idempotencyKey == op.request.idempotencyKey && proof.status == "unknown" && proof.receipt == null)
        return save(expected, expected.copy(operation = null, archives = expected.archives + op.copy(absenceConfirmed = true)))
    }
    @Synchronized fun observeOrderedClaim(key:String,raw:JsonObject):MiningClaimsJournal {
        val(j,op)=original(key);val o=requireNotNull(op.ordered);val value=gg.pixelkingdomwars.nativeclient.charter.CharterGrammar.copy(raw).jsonObject
        require(value["wallet"]==JsonPrimitive(identity.wallet)&&value["claimId"]==JsonPrimitive(requireNotNull(op.preparation).claimId))
        // Only irreversible claims need custody before parsing. Poll timestamps must not
        // exhaust a bounded journal while the same original awaits finalization.
        if(observedMiningTerminals(value).isEmpty())return j
        val known=o.observations.any{JsonObject(it-"serverNow")==JsonObject(value-"serverNow")}
        require(o.observations.size<64||known);if(known&&o.held)return j
        return save(j,j.copy(operation=op.copy(ordered=o.copy(observations=if(known)o.observations else o.observations+value,held=true))))
    }
    @Synchronized fun continuationAttempt(expected:MiningClaimsJournal,key:String):MiningClaimsJournal {
        gg.pixelkingdomwars.nativeclient.charter.CharterGrammar.id(JsonPrimitive(key));val op=requireNotNull(expected.operation);val o=requireNotNull(op.ordered);check(!o.held&&o.continuation==null);o.continuationRequest?.let{check(it==key);return expected}
        return save(expected,expected.copy(operation=op.copy(ordered=o.copy(continuationRequest=key))))
    }
    @Synchronized fun continuationRefused(key:String,value:MiningOrderedRefusal):MiningClaimsJournal {
        val(j,op)=original(key);val o=requireNotNull(op.ordered);value.validate();require(o.continuationRequest!=null);o.continuationRefusal?.let{check(it==value);return j};return save(j,j.copy(operation=op.copy(ordered=o.copy(continuationRefusal=value))))
    }
    @Synchronized fun renewContinuation(expected:MiningClaimsJournal,key:String,absence:MiningClaimContinuationEnvelope):MiningClaimsJournal {
        val op=requireNotNull(expected.operation);val o=requireNotNull(op.ordered);check(!o.held&&o.continuation==null);val refusal=requireNotNull(o.continuationRefusal);val old=requireNotNull(o.continuationRequest);absence.validate(op.policy);require(absence.status=="unknown"&&absence.wallet==identity.wallet&&absence.parentClaimId==op.preparation?.claimId)
        gg.pixelkingdomwars.nativeclient.charter.CharterGrammar.id(JsonPrimitive(key));check(key!=old&&o.previousContinuations.none{it.key==key})
        return save(expected,expected.copy(operation=op.copy(ordered=o.copy(continuationRequest=key,continuationRefusal=null,previousContinuations=o.previousContinuations+MiningOrderedAttemptReceipt(old,refusal,absence)))))
    }
    @Synchronized fun acceptContinuation(key:String,value:MiningClaimContinuationEnvelope):MiningClaimsJournal {
        val(j,op)=original(key);val o=requireNotNull(op.ordered);val p=requireNotNull(op.preparation);value.validate(op.policy);require(value.wallet==identity.wallet&&value.parentClaimId==p.claimId)
        val proof=value.continuation?:run{check(o.continuation==null);return j};require(proof.parentPreparation.sameOriginal(p,op.policy)&&proof.childPreparation.idempotencyKey==o.continuationRequest)
        o.continuation?.let{old->
            val originalTimes=proof.copy(parentPreparation=proof.parentPreparation.copy(serverNow=old.parentPreparation.serverNow),childPreparation=proof.childPreparation.copy(serverNow=old.childPreparation.serverNow))
            check(old==originalTimes);return j
        };check(!o.held&&op.claim?.state!="settled")
        if(p.transactions.size==2){val setup=requireNotNull(op.claim).transactions[0];check(setup.landing=="finalized"&&setup.signature==proof.setup.signature)}else check(o.parent?.setup==proof.setup)
        val ordinal=p.transactions.lastIndex
        if(proof.reason=="unsigned-expired")check(o.signed.none{it.ordinal==ordinal})
        else{val failed=requireNotNull(op.claim).transactions[ordinal];check(failed.landing=="failed"&&failed.signature==proof.failure?.signature);o.signed.singleOrNull{it.ordinal==ordinal}?.let{check(it.signature==requireNotNull(proof.failure).signature&&miningMessageHash(it.wire)==requireNotNull(proof.failure).wireSha256)}}
        return save(j,j.copy(operation=op.copy(ordered=o.copy(continuation=proof))))
    }
    @Synchronized fun useContinuation(expected:MiningClaimsJournal):MiningClaimsJournal {
        val op=requireNotNull(expected.operation);val o=requireNotNull(op.ordered);val proof=requireNotNull(o.continuation);check(!o.held);if(proof.reason=="unsigned-expired")check(o.signed.none{it.ordinal==op.preparation?.transactions?.lastIndex});val p=proof.childPreparation
        val child=MiningClaimsOperation(MiningClaimPrepareRequest(p.idempotencyKey,"ordered-v0"),op.policy,prepareAttempted=true,preparation=p,ordered=MiningOrderedCustody(parent=proof))
        return save(expected,expected.copy(operation=child,archives=expected.archives+op))
    }

}

/** The first unfinalized ordinal is the only candidate; setup success is never KEEP paid. */
fun nextMiningOrdinal(op:MiningClaimsOperation):Int? {
    val p=op.preparation?:return null;if(op.ordered==null)return 0
    if(op.ordered.held||op.ordered.continuation!=null||op.claim?.state in setOf("settled","failed"))return null
    return p.transactions.indices.firstOrNull{i->op.claim?.transactions?.getOrNull(i)?.landing!="finalized"}
}
private fun observedMiningTerminals(raw:JsonObject):Set<String>{
    val claims=mutableSetOf<String>();val status=(raw["state"] as? JsonPrimitive)?.content;if(status in setOf("settled","failed"))claims+="state:$status"
    (raw["transactions"] as? JsonArray)?.forEachIndexed{i,v->val land=((v as? JsonObject)?.get("landing") as? JsonPrimitive)?.content;if(land in setOf("finalized","failed"))claims+="$i:$land"};return claims
}

fun orderedFailedSetup(op:MiningClaimsOperation):Boolean {
    val o=op.ordered?:return false;val c=op.claim?:return false;return !o.held&&op.preparation?.transactions?.size==2&&c.state=="failed"&&c.transactions[0].kind=="setup"&&c.transactions[0].landing=="failed"&&c.transactions[1].signature==null&&1 !in o.signingStarted&&o.signed.none{it.ordinal==1}
}
