package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class StarterFleetFeature(val version: Int, val receipts: Int)
@Serializable data class StarterFleetFeatures(val starterFleet: StarterFleetFeature)
@Serializable data class StarterFleetBerth(val berthId: String, val completedBuildJobId: String, val berthCompletedAt: String) {
    fun validate() { uuid(berthId); uuid(completedBuildJobId); timestamp(berthCompletedAt) }
}
@Serializable data class StarterFleetInstallation(val installationId: String, val baseId: String, val berthId: String,
    val family: String, val completedBuildJobId: String, val berthCompletedAt: String, val installedAt: String) {
    fun berth() = StarterFleetBerth(berthId, completedBuildJobId, berthCompletedAt)
    fun validate() { uuid(installationId); uuid(baseId); require(family == "starter"); berth().validate(); require(timestamp(installedAt) >= timestamp(berthCompletedAt)) }
}
@Serializable data class StarterFleetView(val wallet: String, val baseId: String, val serverNow: String,
    val features: StarterFleetFeatures, val acceptingInstallations: Boolean, val installation: StarterFleetInstallation?, val eligibleBerths: List<StarterFleetBerth>) {
    fun validate() {
        wallet(wallet); uuid(baseId); val now = timestamp(serverNow); require(features.starterFleet == StarterFleetFeature(1, 1))
        installation?.let { it.validate(); require(it.baseId == baseId && timestamp(it.installedAt) <= now) }
        require(eligibleBerths.map { it.berthId }.distinct().size == eligibleBerths.size)
        eligibleBerths.forEach { it.validate(); require(timestamp(it.berthCompletedAt) <= now); installation?.let { original -> require(original.berth() == it) } }
        if (installation != null) require(eligibleBerths == listOf(installation.berth()))
    }
    companion object { fun from(raw: JsonObject): StarterFleetView { starterPrimitives(raw, serializer().descriptor); return starterJson.decodeFromJsonElement<StarterFleetView>(raw).also { it.validate() } } }
}
@Serializable data class StarterFleetRequest(val idempotencyKey: String, val baseId: String, val berthId: String) {
    fun validate() { uuid(idempotencyKey); uuid(baseId); uuid(berthId) }
    fun body(): JsonObject = starterJson.encodeToJsonElement(serializer(), this).jsonObject
}
/** Positive reviewed berth and any original existing installation stay frozen with the command. */
@Serializable data class StarterFleetCommand(val request: StarterFleetRequest, val berth: StarterFleetBerth, val installation: StarterFleetInstallation?) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/starter-fleet/installations/by-key/$key"
    fun validate() { request.validate(); berth.validate(); require(request.berthId == berth.berthId)
        installation?.let { it.validate(); require(it.baseId == request.baseId && it.berth() == berth) } }
    fun admit(identity: StarterIdentity, view: StarterFleetView) {
        identity.validate(); validate(); view.validate()
        require(view.wallet == identity.wallet && view.baseId == request.baseId && view.acceptingInstallations)
        require(view.eligibleBerths.single { it.berthId == request.berthId } == berth && view.installation == installation)
    }
    companion object { fun review(identity: StarterIdentity, view: StarterFleetView, key: String, berthId: String): StarterFleetCommand =
        StarterFleetCommand(StarterFleetRequest(key, view.baseId, berthId), view.eligibleBerths.single { it.berthId == berthId }, view.installation).also { it.admit(identity, view) } }
}
@Serializable data class StarterFleetReceipt(val wallet: String, val request: StarterFleetRequest, val installation: StarterFleetInstallation, val acceptedAt: String) {
    fun validate(identity: StarterIdentity, command: StarterFleetCommand) {
        identity.validate(); command.validate(); require(wallet == identity.wallet && request == command.request)
        installation.validate(); require(installation.baseId == request.baseId && installation.berth() == command.berth)
        command.installation?.let { require(it == installation) }; require(timestamp(acceptedAt) >= timestamp(installation.installedAt))
    }
}
@Serializable data class StarterFleetProof(val wallet: String, val idempotencyKey: String, val serverNow: String, val status: String, val receipt: StarterFleetReceipt?) {
    fun validate(identity: StarterIdentity, command: StarterFleetCommand) {
        identity.validate(); command.validate(); require(wallet == identity.wallet && idempotencyKey == command.key); val now = timestamp(serverNow)
        if (status == "unknown") { require(receipt == null); return }; require(status == "accepted")
        requireNotNull(receipt).validate(identity, command); require(timestamp(receipt.acceptedAt) <= now)
    }
    companion object { fun from(raw: JsonObject, identity: StarterIdentity, command: StarterFleetCommand): StarterFleetProof {
        starterPrimitives(raw, serializer().descriptor); return starterJson.decodeFromJsonElement<StarterFleetProof>(raw).also { it.validate(identity, command) }
    } }
}
