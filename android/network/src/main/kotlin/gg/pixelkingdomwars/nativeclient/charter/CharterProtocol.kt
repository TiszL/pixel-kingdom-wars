package gg.pixelkingdomwars.nativeclient.charter

import java.math.BigInteger
import java.net.URI
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.json.*

/** Closed, bounded public ABI. Parsing establishes consistency, never deployment trust,
 * chain finality, approval, delivery authority or permission to forget an original. */
object CharterGrammar {
    private val u64 = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
    fun text(value: JsonElement) = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("Expected string")
    fun number(value: JsonElement): Long = (value as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
        ?.also { require(it in 0..9_007_199_254_740_991L) } ?: error("Expected exact integer")
    fun bool(value: JsonElement): Boolean = (value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: error("Expected boolean")
    fun amount(value: JsonElement, positive: Boolean = false): BigInteger {
        val s = text(value); require(s.length in 1..20 && s.matches(Regex("0|[1-9][0-9]*")))
        return s.toBigInteger().also { require(it <= u64 && (!positive || it.signum() > 0)) }
    }
    fun id(value: JsonElement) { val s=text(value); require(s.length==36 && UUID.fromString(s).toString()==s && s!="00000000-0000-0000-0000-000000000000" && s.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))) }
    fun address(value: JsonElement) { val s=text(value); require(s.length in 32..44 && s.matches(Regex("[1-9A-HJ-NP-Za-km-z]+"))) }
    fun hex(value: JsonElement, bytes: Int? = null, max: Int = 1232) { val s=text(value); require(s.length in 2..max*2 && s.matches(Regex("(?:[0-9a-f]{2})+")) && (bytes==null || s.length==bytes*2)) }
    fun base64(value: JsonElement, signature: Boolean = false): ByteArray { val s=text(value); require(s.length in 88..1644); return Base64.getDecoder().decode(s).also { require(it.size in 64..1232 && (!signature || it.size==64) && Base64.getEncoder().encodeToString(it)==s) } }
    fun timestamp(value: JsonElement) { val s=text(value); require(s.length in 20..30 && s.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z"))); Instant.parse(s) }
    fun copy(value: JsonElement): JsonElement {
        var nodes=0
        fun own(v:JsonElement,depth:Int):JsonElement { require(++nodes<=2048 && depth<=12);return when(v) {
            is JsonObject -> { require(v.size<=40);JsonObject(v.mapValues { (k,x)->require(k.length<=64);own(x,depth+1) }) }
            is JsonArray -> { require(v.size<=20);JsonArray(v.map {own(it,depth+1)}) }
            is JsonPrimitive -> v.also {require(it.content.length<=3288)}
        } }
        return own(value,0)
    }
}
fun JsonObject.charterText(key:String)=CharterGrammar.text(getValue(key))
fun JsonObject.charterObject(key:String)=getValue(key).jsonObject
fun JsonObject.charterOptional(key:String)=getValue(key).takeUnless {it==JsonNull}?.jsonObject
private typealias Check=(JsonElement)->Unit
private val str:Check={CharterGrammar.text(it)}
private val address:Check=CharterGrammar::address
private val id:Check=CharterGrammar::id
private val count:Check={CharterGrammar.number(it)}
private val amount:Check={CharterGrammar.amount(it)}
private val positive:Check={CharterGrammar.amount(it,true)}
private val boolean:Check={CharterGrammar.bool(it)}
private val no:Check={require(!CharterGrammar.bool(it))}
private val hash:Check={CharterGrammar.hex(it,32)}
private val time:Check={require(CharterGrammar.amount(it)<=BigInteger.valueOf(Long.MAX_VALUE))}
private val version:Check={require(CharterGrammar.number(it)==1L)}
private val revision:Check={require(CharterGrammar.number(it)<=0xffffffffL)}
private val signature:Check={CharterGrammar.base64(it,true)}
private val txSignature:Check={val s=CharterGrammar.text(it);require(s.length in 64..88 && s.matches(Regex("[1-9A-HJ-NP-Za-km-z]+")) && s!="1".repeat(64))}
private val instant:Check=CharterGrammar::timestamp
private val name:Check={val s=CharterGrammar.text(it);require(s.length in 1..24 && s.trim()==s && s.matches(Regex("[A-Za-z0-9 ._-]+")))}
private val tag:Check={val s=CharterGrammar.text(it);require(s.length in 1..24 && s.matches(Regex("[A-Z0-9]+")))}
private val uri:Check={val s=CharterGrammar.text(it);val u=URI(s);require(s.toByteArray().size in 1..292 && u.scheme=="https" && !u.host.isNullOrBlank() && u.userInfo==null)}
private fun literal(value:String):Check={require(CharterGrammar.text(it)==value)}
private fun enum(vararg values:String):Check={require(CharterGrammar.text(it) in values)}
private fun nullable(check:Check):Check={if(it!=JsonNull)check(it)}
private fun obj(vararg fields:Pair<String,Check>):Check={raw->val o=raw.jsonObject;require(o.keys==fields.map{it.first}.toSet());fields.forEach{(k,c)->c(o.getValue(k))}}
private fun arr(max:Int,min:Int=0,check:Check):Check={raw->val a=raw.jsonArray;require(a.size in min..max);a.forEach(check)}
private val metadata=obj("name" to name,"uri" to uri,"hash" to hash)
private val domainFields=arrayOf("genesisHash" to address,"economyProgram" to address,"craftProgram" to address)
private val chain=obj(*domainFields,*listOf("config","craftControl","collection","collectionAuthority","charter","asset","assetBinding","freezeAuthority","executor","creationReceipt").map{it to address}.toTypedArray())
private val creationOriginal=obj("creationIntentId" to id,"clanId" to id,"payer" to address,"metadata" to metadata,"chain" to chain,"admissionCommitment" to hash)
private val terms=obj("version" to version,"id" to id,"clanId" to id,"seller" to address,"buyer" to address,"priceLamports" to positive,"sellerLeaves" to boolean,
    "domain" to obj(*domainFields,"treasury" to address),"expectedRevision" to revision,"epochId" to id,"fenceId" to id,"royaltyBps" to count)
private val program=obj("programId" to address,"reviewedDeploymentSlot" to count,"reviewedProgramDataSha256" to hash,"upgradeAuthority" to nullable(address))
private val deployment=obj("expectedGenesisHash" to address,"economy" to program,"craft" to program,"core" to program,"stateProvenance" to literal("fresh-reviewed-deployment"))
private val packetFields=arrayOf("version" to version,"messageHex" to {v:JsonElement->CharterGrammar.hex(v,max=1167)},"unsignedTransactionHex" to {v:JsonElement->CharterGrammar.hex(v)},"messageSha256" to hash,
    "packetBytes" to {v:JsonElement->require(CharterGrammar.number(v) in 66..1232)},"nativeInstructionIndex" to version,"signingAuthorized" to no,"relayAuthorized" to no)
private fun packet(kind:String)=obj(*packetFields,*if(kind=="creation")arrayOf("mintAuthorized" to no) else emptyArray())
private val allocation=obj("kind" to {v:JsonElement->require(CharterGrammar.text(v).length in 1..20)},"address" to address,"bytes" to {v:JsonElement->require(CharterGrammar.number(v) in 1..1232)},"minimumBalanceLamports" to amount)
private val creationCostFields=arrayOf("networkFeeLamports" to amount,"rentLamports" to amount,"coreCreateFeeLamports" to amount,"totalLamports" to amount)
private val saleCostFields=arrayOf("priceLamports" to positive,"sellerLamports" to amount,"royaltyLamports" to amount,"networkFeeLamports" to amount,"rentLamports" to amount,"totalLamports" to amount)
private val signedFields=arrayOf("signature" to txSignature,"wireSha256" to hash,"messageSha256" to hash)
private val wireShape=obj(*signedFields,"signedTransaction" to {v:JsonElement->CharterGrammar.base64(v)})
private val contribution=obj("wallet" to address,"attemptId" to id,"messageSha256" to hash,"signature" to signature)
private val creationRequest=obj("creationIntentId" to id,"baseId" to id,"name" to name,"tag" to tag,"inviteMode" to enum("open","invite"))
private val creationStatuses=arrayOf("funded","admitted","issuing","prepared","signed","activated","cancelled_unpaid","refunded")
private val saleStatuses=arrayOf("draft","accepted","members_paid","issuing","prepared","signed","completed","cancelled")
private val creationState=obj("version" to version,"wallet" to address,"creationIntentId" to id,"request" to creationRequest,"status" to enum(*creationStatuses),
    "original" to obj("reservationId" to id,"clanId" to id,"baseId" to id,"clan" to obj("name" to name,"tag" to tag,"inviteMode" to enum("open","invite")),"price" to obj("shards" to amount),"metadata" to metadata),
    "policy" to nullable(obj("permitId" to {v:JsonElement->CharterGrammar.hex(v,16)},"expiry" to time,"signer" to address)),
    "preparation" to nullable(obj("attemptId" to id,"packet" to packet("creation"),"blockhash" to address,"lastValidBlockHeight" to count,"costs" to obj(*creationCostFields))),
    "signed" to nullable(obj(*signedFields,"acceptedAt" to instant)),
    "terminal" to nullable(obj("state" to enum("activated","cancelled_unpaid","refunded"),"terminalId" to id,"terminalTransactionId" to nullable(id),"refundTransactionId" to nullable(id),"refundDestinationBaseId" to nullable(id))),
    *listOf("signingAuthorized","relayAuthorized","reservationReleaseAuthorized","mintAuthorized","paymentAuthorized","activationAuthorized","refundAuthorized").map{it to no}.toTypedArray())
private val saleState=obj("version" to version,"id" to id,"status" to enum(*saleStatuses),"original" to obj("clanId" to id,"seller" to address,"buyer" to address,"priceLamports" to positive,"sellerLeaves" to boolean,"termsHash" to hash,"expectedRevision" to revision),
    "acceptance" to nullable(obj("buyerBaseId" to id,"acceptedAt" to instant)),"memberPayment" to nullable(obj("id" to id,"totalShards" to amount)),
    "preparation" to nullable(obj("packet" to packet("sale"),"costs" to obj(*saleCostFields))),"signed" to nullable(obj(*signedFields)),
    "terminal" to nullable(obj("id" to id,"outcome" to enum("completed","cancelled"))),*listOf("signingAuthorized","relayAuthorized","transferAuthorized","fenceReleaseAuthorized").map{it to no}.toTypedArray())
private fun signingShape(kind:String)=obj("version" to version,"kind" to literal(kind),"attemptId" to id,"deployment" to deployment,
    "original" to if(kind=="creation") creationOriginal else obj("creation" to creationOriginal,"terms" to terms,"termsHash" to hash),
    "policy" to obj("signer" to address,"candidateHex" to {v:JsonElement->CharterGrammar.hex(v,161)},"signatureHex" to {v:JsonElement->CharterGrammar.hex(v,64)}),
    "lookupTable" to obj("address" to address,"owner" to address,"executable" to no,"dataHex" to {v:JsonElement->CharterGrammar.hex(v,56+12*32)},"slot" to count),
    "lookupPin" to obj("address" to address,"dataSha256" to hash),"blockhash" to address,"blockhashSlot" to count,"lastValidBlockHeight" to count,"observedSlot" to count,"observedUnixTimestamp" to time,
    "context" to obj("feeSlot" to count,"closingSlot" to count,"closingGenesisHash" to address),"packet" to packet(kind),
    "costs" to if(kind=="creation")obj(*creationCostFields,"allocations" to arr(5,5,allocation)) else obj(*saleCostFields,"allocations" to arr(2,2,allocation)),
    "costLimits" to obj("maxNetworkFeeLamports" to positive,"maxRentLamports" to positive,if(kind=="creation")"maxTotalLamports" to positive else "maxAdditionalLamports" to positive),
    "signingAuthorized" to no,"relayAuthorized" to no,
    *if(kind=="creation")arrayOf("coreCostProfile" to obj("version" to version,"profile" to literal("mpl-core-0.15.2-charter-pfd-seq-none"),"reviewedProgramDataSha256" to hash)) else emptyArray())

class CharterEnvelope private constructor(val raw:JsonObject) {
    val actor get()=raw.charterText("actor");val kind get()=raw.charterText("kind");val key get()=raw.charterText("key")
    val state get()=raw.charterObject("state");val status get()=state.charterText("status")
    val original get()=state.charterObject("original");val signing get()=raw.charterOptional("signing");val wire get()=raw.charterOptional("wire")
    val contributions get()=raw.getValue("contributions").jsonArray.map{it.jsonObject}
    val terminal get()=state.charterOptional("terminal")
    companion object { fun from(input:JsonObject):CharterEnvelope {
        val raw=CharterGrammar.copy(input).jsonObject;val kind=raw.charterText("kind");require(kind in listOf("creation","sale"))
        obj("version" to version,"actor" to address,"kind" to literal(kind),"key" to id,"state" to if(kind=="creation")creationState else saleState,"signing" to nullable(signingShape(kind)),"wire" to nullable(wireShape),"contributions" to arr(if(kind=="creation")0 else 2,check=contribution))(raw)
        return CharterEnvelope(raw).also { it.bind() }
    } }
    private fun bind() {
        val prep=state.charterOptional("preparation");val signed=state.charterOptional("signed")
        require((signing!=null)==(prep!=null) && (wire!=null)==(signed!=null))
        signing?.let{s-> checkSigning(s,kind);require(s.getValue("packet")==prep!!.getValue("packet")) }
        wire?.let{w->require(signing!=null);listOf("signature","wireSha256","messageSha256").forEach{require(w[it]==signed!![it])};require(w["messageSha256"]==signing!!.charterObject("packet")["messageSha256"])}
        if(kind=="creation") {
            val r=state.charterObject("request");val clan=original.charterObject("clan")
            require(key==state.charterText("creationIntentId") && actor==state.charterText("wallet") && r.charterText("creationIntentId")==key && r["baseId"]==original["baseId"])
            listOf("name","tag","inviteMode").forEach{require(r[it]==clan[it])}
            terminal?.let{require(it.charterText("state")==status)}
            if(prep!=null)require(state.charterOptional("policy")!=null)
            signing?.let{s->val o=s.charterObject("original");require(o.charterText("creationIntentId")==key && o["clanId"]==original["clanId"] && o.charterText("payer")==actor && o["metadata"]==original["metadata"] && s["attemptId"]==prep!!["attemptId"] && s.charterObject("policy")["signer"]==state.charterObject("policy")["signer"])}
        } else {
            require(key==state.charterText("id") && actor in listOf(original.charterText("seller"),original.charterText("buyer")))
            terminal?.let{require(it.charterText("outcome")==status)}
            if(prep!=null)require(state.charterOptional("acceptance")!=null && state.charterOptional("memberPayment")!=null)
            signing?.let{s->val o=s.charterObject("original");val t=o.charterObject("terms");require(t.charterText("id")==key && o["termsHash"]==original["termsHash"]);listOf("clanId","seller","buyer","priceLamports","sellerLeaves","expectedRevision").forEach{require(t[it]==original[it])}}
            val parties=listOf(original.charterText("buyer"),original.charterText("seller"));val indices=contributions.map{parties.indexOf(it.charterText("wallet"))}
            require(indices.all{it>=0} && indices.zipWithNext().all{(a,b)->a<b} && (contributions.size<2 || wire!=null))
            contributions.forEach{require(it["attemptId"]==signing?.get("attemptId") && it["messageSha256"]==signing?.charterObject("packet")?.get("messageSha256"))}
        }
    }

}

/** Registration packets are shared by funded creation and existing-clan migration.
 * These checks never fabricate a funded reservation or confer signing authority. */
object CharterRegistrationProtocol {
    fun original(input:JsonObject):JsonObject=CharterGrammar.copy(input).jsonObject.also { creationOriginal(it) }
    fun signing(input:JsonObject):JsonObject=CharterGrammar.copy(input).jsonObject.also { signingShape("creation")(it);checkSigning(it,"creation") }
    fun wire(input:JsonObject):JsonObject=CharterGrammar.copy(input).jsonObject.also { wireShape(it) }
}
private fun checkSigning(s:JsonObject,kind:String) {
        val o=s.charterObject("original");val c=if(kind=="creation")o else o.charterObject("creation");val chain=c.charterObject("chain");val d=s.charterObject("deployment");val context=s.charterObject("context")
        val slots=listOf(s.getValue("observedSlot"),s.charterObject("lookupTable").getValue("slot"),s.getValue("blockhashSlot"),context.getValue("feeSlot"),context.getValue("closingSlot")).map(CharterGrammar::number)
        require(slots.zipWithNext().all{(a,b)->a<=b});require(d["expectedGenesisHash"]==chain["genesisHash"] && context["closingGenesisHash"]==chain["genesisHash"] && d.charterObject("economy")["programId"]==chain["economyProgram"] && d.charterObject("craft")["programId"]==chain["craftProgram"])
        listOf("economy","craft","core").forEach{require(CharterGrammar.number(d.charterObject(it).getValue("reviewedDeploymentSlot"))<=slots.first())}
        require(s.charterObject("lookupTable")["address"]==s.charterObject("lookupPin")["address"])
        val p=s.charterObject("packet");val prefix=if(kind=="creation")65 else 129;val message=p.charterText("messageHex")
        require(message.startsWith("80") && CharterGrammar.number(p.getValue("packetBytes"))==prefix+message.length/2L && p.charterText("unsignedTransactionHex")== (if(kind=="creation")"01" else "02")+"00".repeat(prefix-1)+message)
        val costs=s.charterObject("costs");val limits=s.charterObject("costLimits");val allocations=costs.getValue("allocations").jsonArray.map{it.jsonObject}
        fun n(o:JsonObject,k:String)=CharterGrammar.amount(o.getValue(k))
        val rent=allocations.fold(BigInteger.ZERO){a,x->a+n(x,"minimumBalanceLamports")};val fee=n(costs,"networkFeeLamports")
        require(rent==n(costs,"rentLamports") && rent<=n(limits,"maxRentLamports") && fee<=n(limits,"maxNetworkFeeLamports") && allocations.map{it["address"]}.distinct().size==allocations.size)
        val kinds=allocations.map{it.charterText("kind")}
        if(kind=="creation")require(s.charterObject("coreCostProfile")["reviewedProgramDataSha256"]==d.charterObject("core")["reviewedProgramDataSha256"] && kinds==listOf("charter","assetBinding","creationReceipt","permitReceipt","asset") && n(costs,"totalLamports")==rent+fee+n(costs,"coreCreateFeeLamports") && n(costs,"totalLamports")<=n(limits,"maxTotalLamports"))
        else {val t=o.charterObject("terms");val td=t.charterObject("domain");require(t["clanId"]==c["clanId"] && t["seller"]!=t["buyer"] && td["treasury"] !in listOf(t["seller"],t["buyer"]));domainFields.forEach{require(td[it.first]==chain[it.first])};require(kinds==listOf("transfer-receipt","permit-receipt") && costs["priceLamports"]==t["priceLamports"] && n(costs,"sellerLamports")+n(costs,"royaltyLamports")==n(t,"priceLamports") && n(costs,"totalLamports")==n(t,"priceLamports")+rent+fee && rent+fee<=n(limits,"maxAdditionalLamports"))}
    }

/** Canonical catalogue inputs, supplied independently of the response being checked. */
data class CharterProtocolPolicy(val nameMin:Int,val nameMax:Int,val tagMin:Int,val tagMax:Int,val createCostShards:String,val royaltyBps:Int,val basisPoints:Int,val coreCreateFeeLamports:String) {
    fun validate() {require(nameMin>0 && nameMax>=nameMin && nameMax<=24 && tagMin>0 && tagMax>=tagMin && tagMax<=24 && basisPoints>0 && royaltyBps in 0..basisPoints);CharterGrammar.amount(JsonPrimitive(createCostShards),true);CharterGrammar.amount(JsonPrimitive(coreCreateFeeLamports),true)}
    fun validate(envelope:CharterEnvelope) {validate();if(envelope.kind=="creation") {val c=envelope.original.charterObject("clan");require(c.charterText("name").length in nameMin..nameMax && c.charterText("tag").length in tagMin..tagMax && envelope.original.charterObject("price").charterText("shards")==createCostShards);envelope.signing?.let{require(it.charterObject("costs").charterText("coreCreateFeeLamports")==coreCreateFeeLamports)}} else envelope.signing?.let{s->val t=s.charterObject("original").charterObject("terms");val c=s.charterObject("costs");require(CharterGrammar.number(t.getValue("royaltyBps"))==royaltyBps.toLong());require(CharterGrammar.amount(c.getValue("royaltyLamports"))==CharterGrammar.amount(t.getValue("priceLamports"))*royaltyBps.toBigInteger()/basisPoints.toBigInteger())}}
    fun toJson()=buildJsonObject{put("nameMin",nameMin);put("nameMax",nameMax);put("tagMin",tagMin);put("tagMax",tagMax);put("createCostShards",createCostShards);put("royaltyBps",royaltyBps);put("basisPoints",basisPoints);put("coreCreateFeeLamports",coreCreateFeeLamports)}
    companion object {fun from(raw:JsonObject):CharterProtocolPolicy {obj("nameMin" to count,"nameMax" to count,"tagMin" to count,"tagMax" to count,"createCostShards" to positive,"royaltyBps" to count,"basisPoints" to count,"coreCreateFeeLamports" to positive)(raw)
        fun i(k:String)=CharterGrammar.number(raw.getValue(k)).also{require(it<=Int.MAX_VALUE)}.toInt()
        return CharterProtocolPolicy(i("nameMin"),i("nameMax"),i("tagMin"),i("tagMax"),raw.charterText("createCostShards"),i("royaltyBps"),i("basisPoints"),raw.charterText("coreCreateFeeLamports")).also{it.validate()}}}
}

class CharterActivity private constructor(val raw:JsonObject) {
    val actor get()=raw.charterText("actor");val items get()=raw.getValue("items").jsonArray.map{it.jsonObject};val cursor get()=raw.getValue("nextCursor").takeUnless{it==JsonNull}?.let(CharterGrammar::text)
    companion object {fun from(input:JsonObject):CharterActivity {val raw=CharterGrammar.copy(input).jsonObject;obj("version" to version,"actor" to address,"newActions" to obj("creation" to boolean,"sale" to boolean),"items" to arr(20,check=obj("kind" to enum("creation","sale"),"key" to id,"status" to enum(*(creationStatuses+saleStatuses).distinct().toTypedArray()),"clanId" to id,"participantRole" to enum("creator","seller","buyer"),"name" to nullable(name),"tag" to nullable(tag))),"nextCursor" to nullable({v->val c=CharterGrammar.text(v);require(c.length in 1..256 && c.all{it.code in 33..126})}))(raw);return CharterActivity(raw)}}
}
fun charterDelivery(input:JsonObject):CharterEnvelope {val raw=CharterGrammar.copy(input).jsonObject;obj("version" to version,"actor" to address,"kind" to enum("creation","sale"),"key" to id,"status" to enum("submitted","observed","terminal","held"),"signature" to nullable(txSignature),"reason" to nullable(enum("PAUSED","BUSY","NOT_SIGNED","SOURCE_CONFLICT","TRANSPORT_UNAVAILABLE","IDENTITY","OBSERVED_TRANSACTION","FINALIZED_ERROR_UNVERIFIED","EXPIRED_UNRESOLVED","ADMISSION_HELD","SEND_UNCERTAIN","TIMEOUT")),"original" to {CharterEnvelope.from(it.jsonObject)})(raw);return CharterEnvelope.from(raw.charterObject("original")).also{require(raw["actor"]==it.raw["actor"] && raw["kind"]==it.raw["kind"] && raw["key"]==it.raw["key"] && (raw["signature"]==JsonNull || raw["signature"]==it.wire?.get("signature")))}}
fun charterSaleByKey(input:JsonObject,actor:String,key:String):CharterEnvelope? {val raw=CharterGrammar.copy(input).jsonObject;obj("version" to version,"actor" to address,"idempotencyKey" to id,"sale" to nullable({CharterEnvelope.from(it.jsonObject)}))(raw);require(raw.charterText("actor")==actor && raw.charterText("idempotencyKey")==key);return raw.charterOptional("sale")?.let(CharterEnvelope::from)?.also{require(it.kind=="sale" && it.actor==actor && it.original.charterText("seller")==actor)}}
fun validateCharterRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?) {
    val prefix="/clans/charter/client";require(path.startsWith("$prefix/") && '?' !in path && '#' !in path)
    val pieces=path.removePrefix("$prefix/").split('/');require(method in listOf("GET","POST"))
    if(method=="GET") {require(body==null);if(pieces==listOf("activity")){require(query.keys.all{it=="cursor"});query["cursor"]?.let{require(it.length in 1..256 && it.all{c->c.code in 33..126})};return};require(query.isEmpty());if(pieces.size==3 && pieces[0]=="sales" && pieces[1]=="by-key"){id(JsonPrimitive(pieces[2]));return};require(pieces.size==2 && pieces[0] in listOf("creations","sales"));id(JsonPrimitive(pieces[1]));return}
    require(query.isEmpty());val b=requireNotNull(body);CharterGrammar.copy(b)
    if(pieces==listOf("creations")){creationRequest(b);return}
    if(pieces==listOf("sales")){obj("clanId" to id,"buyer" to address,"priceLamports" to positive,"sellerLeaves" to boolean,"idempotencyKey" to id)(b);return}
    require(pieces.size==3 && pieces[0] in listOf("creations","sales"));id(JsonPrimitive(pieces[1]));val kind=pieces[0];val action=pieces[2]
    when {
        kind=="creations" && action=="signed" -> obj("signedTransaction" to {CharterGrammar.base64(it)})(b)
        kind=="creations" && action=="refund" -> {require(b.keys.all{it=="destinationBaseId"});b["destinationBaseId"]?.let(id)}
        kind=="sales" && action=="accept" -> obj("termsHash" to hash,"buyerBaseId" to id)(b)
        kind=="sales" && action=="signature" -> obj("attemptId" to id,"messageSha256" to hash,"signature" to signature)(b)
        action in if(kind=="creations")listOf("prepare","recover-preparation","recover","deliver") else listOf("pay-members","prepare","recover-preparation","recover","cancel","deliver") -> require(b.isEmpty())
        else -> error("Unsupported Charter request")
    }
}
