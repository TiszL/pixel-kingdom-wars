package gg.pixelkingdomwars.nativeclient.freebase

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.starter.starterPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

internal val freeBaseJson = Json { encodeDefaults = true }
private fun amount(value: String) { require(value.matches(Regex("[1-9][0-9]{0,18}")) && value.toLongOrNull() != null) }
@Serializable data class FreeBasePurchaseTerms(val policyVersion: Int, val costShards: String, val minKeepLevel: Int,
    val minWorkshopLevel: Int, val minGoldForgeLevel: Int, val maxFreeBases: Int, val maxActiveBases: Int) {
    fun validate() { require(policyVersion == 1); amount(costShards); require(listOf(minKeepLevel, minWorkshopLevel, minGoldForgeLevel, maxFreeBases, maxActiveBases).all { it > 0 }) }
}
@Serializable data class FreeBasePurchaseAdmission(val allowed: Boolean, val reason: String)
@Serializable data class FreeBasePurchaseDevelopment(val keepId: String, val keepLevel: Int, val workshopId: String,
    val workshopLevel: Int, val goldForgeId: String, val goldForgeLevel: Int) {
    fun validate() { listOf(keepId, workshopId, goldForgeId).forEach(::uuid); require(listOf(keepLevel, workshopLevel, goldForgeLevel).all { it > 0 }) }
}
@Serializable data class FreeBasePurchaseRequest(val sourceBaseId: String, val idempotencyKey: String) {
    fun validate() { uuid(sourceBaseId); uuid(idempotencyKey) }
    fun body() = freeBaseJson.encodeToJsonElement(serializer(), this).jsonObject
    companion object { fun from(raw: JsonObject): FreeBasePurchaseRequest {
        starterPrimitives(raw, serializer().descriptor); return freeBaseJson.decodeFromJsonElement<FreeBasePurchaseRequest>(raw).also { it.validate() }
    } }
}
@Serializable data class FreeBasePurchaseReceipt(val version: Int, val wallet: String, val idempotencyKey: String,
    val sourceBaseId: String, val baseId: String, val slot: Int, val shardsCharged: String, val debitTransactionId: String,
    val development: FreeBasePurchaseDevelopment, val acceptedAt: String) {
    fun validate() {
        require(version == 1); wallet(wallet); require(idempotencyKey.length in 8..128)
        listOf(sourceBaseId, baseId, debitTransactionId).forEach(::uuid); require(baseId != sourceBaseId && slot > 0)
        amount(shardsCharged); development.validate(); timestamp(acceptedAt)
    }
    fun validate(identity: StarterIdentity, command: FreeBasePurchaseCommand) {
        validate(); identity.validate(); command.validate()
        require(wallet == identity.wallet && idempotencyKey == command.request.idempotencyKey && sourceBaseId == command.request.sourceBaseId)
        require(version == command.terms.policyVersion && shardsCharged == command.terms.costShards && slot <= command.terms.maxActiveBases)
        require(development.keepLevel >= command.terms.minKeepLevel && development.workshopLevel >= command.terms.minWorkshopLevel && development.goldForgeLevel >= command.terms.minGoldForgeLevel)
    }
    companion object { fun from(raw: JsonObject): FreeBasePurchaseReceipt {
        starterPrimitives(raw, serializer().descriptor); return freeBaseJson.decodeFromJsonElement<FreeBasePurchaseReceipt>(raw).also { it.validate() }
    } }
}
@Serializable data class FreeBasePurchaseEnvelope(val receipt: FreeBasePurchaseReceipt?) {
    companion object { fun from(raw: JsonObject): FreeBasePurchaseEnvelope {
        starterPrimitives(raw, serializer().descriptor); return freeBaseJson.decodeFromJsonElement<FreeBasePurchaseEnvelope>(raw).also { it.receipt?.validate() }
    } }
}
@Serializable data class FreeBasePurchaseView(val version: Int, val wallet: String, val enabled: Boolean,
    val sourceBaseId: String?, val terms: FreeBasePurchaseTerms, val admission: FreeBasePurchaseAdmission, val receipt: FreeBasePurchaseReceipt?) {
    fun validate() {
        require(version == 1); wallet(wallet); sourceBaseId?.let(::uuid); terms.validate()
        require(admission.reason in setOf("ready", "disabled", "stable-bases-required", "already-purchased", "source-required", "source-unavailable", "source-not-free", "source-reserved", "full-roster", "development-required", "insufficient-shards", "being-raided"))
        require(admission.allowed == (admission.reason == "ready"))
        if (admission.allowed) require(enabled && sourceBaseId != null && receipt == null)
        receipt?.let { it.validate(); require(it.wallet == wallet) }
    }
    companion object { fun from(raw: JsonObject): FreeBasePurchaseView {
        starterPrimitives(raw, serializer().descriptor); return freeBaseJson.decodeFromJsonElement<FreeBasePurchaseView>(raw).also { it.validate() }
    } }
}
/** The exact source and server-reviewed terms remain part of the encrypted command forever. */
@Serializable data class FreeBasePurchaseCommand(val request: FreeBasePurchaseRequest, val terms: FreeBasePurchaseTerms) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/bases/free-purchases/by-key/$key"
    fun validate() { request.validate(); terms.validate() }
    fun admit(identity: StarterIdentity, view: FreeBasePurchaseView) {
        identity.validate(); validate(); view.validate()
        require(view.wallet == identity.wallet && view.sourceBaseId == request.sourceBaseId && view.terms == terms && view.enabled && view.admission.allowed && view.receipt == null)
    }
    companion object { fun review(identity: StarterIdentity, view: FreeBasePurchaseView, key: String) =
        FreeBasePurchaseCommand(FreeBasePurchaseRequest(requireNotNull(view.sourceBaseId), key), view.terms).also { it.admit(identity, view) } }
}
