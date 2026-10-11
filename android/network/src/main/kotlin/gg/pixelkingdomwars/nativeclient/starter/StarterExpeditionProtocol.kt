package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.quantity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import gg.pixelkingdomwars.nativeclient.realmsales.RealmSaleProofAccount
import java.math.BigInteger
import java.time.Instant
import java.util.Collections
import kotlinx.serialization.*
import kotlinx.serialization.json.*

@Serializable data class StarterExpeditionFeature(val version: Int, val receipts: Int)
@Serializable data class StarterExpeditionFeatures(val starterExpeditions: StarterExpeditionFeature)
/** Wire index identities, pinned by the backend REALM_IDS order; never tuning. */
val paidStarterRealmIds = listOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall")
private val paidU64Max = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
private fun paidAmount(value: String, max: BigInteger = BigInteger.valueOf(Long.MAX_VALUE)): BigInteger {
    require(value.length in 1..20 && value.matches(Regex("0|[1-9][0-9]{0,19}")))
    return value.toBigInteger().also { require(it <= max) }
}
private fun paidHash(value: String) { require(value.length == 64 && value.matches(Regex("[0-9a-f]{64}"))) }
@Serializable data class StarterPaidAccessFinality(val commitment: String, val contextSlot: String, val observedAt: String, val chainUnixTimestamp: String)
@Serializable data class StarterPaidAccessSource(val trust: String, val stateProvenance: String, val genesisHash: String,
    val programId: String, val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String,
    val upgradeAuthority: String?, val accounts: List<RealmSaleProofAccount>)
@Serializable data class StarterPaidAccessObservation(val version: Int, val wallet: String, val realm: Int, val accessAddress: String,
    val configAddress: String, val expiresAt: String, val finality: StarterPaidAccessFinality, val source: StarterPaidAccessSource) {
    /** Owner-attested historical consistency, not independent finality or a new
     * entitlement. Current source/PDA/age admission stays on the server. */
    fun validate(realmId: String) {
        require(version == 1 && realm in paidStarterRealmIds.indices && paidStarterRealmIds[realm] == realmId)
        listOf(wallet, accessAddress, configAddress, source.genesisHash, source.programId).forEach(::wallet)
        require(wallet != "1".repeat(32)); source.upgradeAuthority?.let(::wallet)
        require(paidAmount(expiresAt).signum() > 0 && finality.commitment == "finalized")
        val contextSlot = paidAmount(finality.contextSlot, paidU64Max); count(source.reviewedDeploymentSlot)
        require(contextSlot >= source.reviewedDeploymentSlot.toBigInteger())
        require(finality.observedAt.length == 24 && timestamp(finality.observedAt) >= Instant.EPOCH)
        require(paidAmount(finality.chainUnixTimestamp).signum() > 0)
        require(source.trust == "trusted-finalized-rpc-reviewed-program" && source.stateProvenance == "fresh-reviewed-deployment")
        paidHash(source.reviewedProgramDataSha256)
        val rows = source.accounts; require(rows.size == 5 && rows.map { it.address }.distinct().size == rows.size)
        rows.forEachIndexed { index, row ->
            row.validate(); wallet(row.address); wallet(row.owner)
            require(row.owner == when (index) { 0, 1 -> "BPFLoaderUpgradeab1e11111111111111111111111"
                4 -> "Sysvar1111111111111111111111111111111111111"; else -> source.programId })
            require(row.executable == (index == 0))
        }
        require(rows[0].address == source.programId && rows[1].dataSha256 == source.reviewedProgramDataSha256
            && rows[2].address == configAddress && rows[3].address == accessAddress && rows[4].address == "SysvarC1ock11111111111111111111111111111111")
    }
    fun atDeparture(departedAt: String) {
        val departed = timestamp(departedAt); require(timestamp(finality.observedAt) <= departed)
        val seconds = departed.epochSecond.toBigInteger()
        require(seconds >= paidAmount(finality.chainUnixTimestamp) && seconds < paidAmount(expiresAt))
    }
    internal fun owned() = copy(source = source.copy(accounts = Collections.unmodifiableList(ArrayList(source.accounts))))
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class StarterExpeditionAccess(val kind: String, val policyVersion: Int,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val observation: StarterPaidAccessObservation? = null)
/** Bound new nested evidence before descriptor walking and list allocation. */
internal fun boundedStarterHistory(raw: JsonElement, paidProof: Boolean = true) {
    var nodes = 0
    fun bound(value: JsonElement, depth: Int, field: String?) {
        require(++nodes <= 2048 && depth <= 16)
        when (value) {
            is JsonObject -> {
                require(value.size <= 32)
                if (field == "access") require(value.keys == if (paidProof && value["kind"]?.jsonPrimitive?.content == "paid_realm")
                    setOf("kind", "policyVersion", "observation") else setOf("kind", "policyVersion"))
                value.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1, key) }
            }
            is JsonArray -> { require(if (field == "accounts") value.size == 5 else value.size <= 16); value.forEach { bound(it, depth + 1, null) } }
            is JsonPrimitive -> require(value.content.length <= 256)
        }
    }
    bound(raw, 0, null)
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class StarterExpeditionRoute(val routeCatalogueVersion: Int, val rewardTableVersion: Int, val routeId: String,
    val realmId: String, val resourceId: String, val vehicleFamily: String, val durationSec: Long,
    val grossQuantity: String, val netQuantity: String, val islandPoolQuantity: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val access: StarterExpeditionAccess? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val fitting: EquipmentFittingSnapshot? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val secondaryOutput: EquipmentSecondaryOutput? = null) {
    /** Historical format validation only: never compare saved rewards with today's catalogue. */
    fun validate() {
        require(routeCatalogueVersion > 0 && rewardTableVersion > 0 && routeId.matches(Regex("[a-z][a-z0-9_]{0,63}")))
        require(realmId in starterResourceRealms.values && resourceId in starterResourceRealms && vehicleFamily == "starter"); count(durationSec, true)
        require(quantity(netQuantity) + quantity(islandPoolQuantity) == quantity(grossQuantity, true))
        fitting?.validate(); equipmentCompanion(starterJson.encodeToJsonElement(serializer(),this).jsonObject)
        if (routeId.startsWith("common_")) {
            require(access == StarterExpeditionAccess("starter_common", 1) && routeCatalogueVersion == 2 && rewardTableVersion == 2)
            require(routeId == "common_${realmId.replace('-', '_')}" && starterResourceRealms[resourceId] == realmId)
        } else if (routeId.startsWith("paid_")) {
            require(access?.kind == "paid_realm" && access.policyVersion == 1 && routeCatalogueVersion == 3 && rewardTableVersion == 2)
            require(routeId == "paid_${realmId.replace('-', '_')}" && starterResourceRealms[resourceId] == realmId)
            requireNotNull(access.observation).validate(realmId)
        } else require(access == null)
    }
    internal fun owned() = copy(access = access?.let { it.copy(observation = it.observation?.owned()) })
}
@Serializable data class StarterExpeditionHome(val source: String, val version: Int, val realmId: String) {
    fun validate() { require(source in setOf("free_assignment", "deed_location", "free_policy_preview") && version == 1 && realmId in starterResourceRealms.values) }
}
@Serializable data class StarterExpeditionFlight(val expeditionId: String, val installationId: String, val route: StarterExpeditionRoute,
    val departedAt: String, val returnsAt: String, val termId: String, val termHash: String) {
    fun validate() {
        uuid(expeditionId); uuid(installationId); uuid(termId); require(termHash.matches(Regex("[0-9a-f]{64}"))); route.validate()
        require(timestamp(returnsAt) == timestamp(departedAt).plusSeconds(route.durationSec))
        route.access?.observation?.atDeparture(departedAt)
    }
}
@Serializable data class StarterExpeditionView(val wallet: String, val baseId: String, val serverNow: String,
    val features: StarterExpeditionFeatures, val acceptingDepartures: Boolean, val home: StarterExpeditionHome?,
    val routes: List<StarterExpeditionRoute>, val installation: StarterFleetInstallation?, val flight: StarterExpeditionFlight?,
    val lodgeCompletedAt: String?, val rawStock: List<OrdinaryRawStock>) {
    fun validate() {
        wallet(wallet); uuid(baseId); val now = timestamp(serverNow); require(features.starterExpeditions == StarterExpeditionFeature(1, 1))
        home?.validate(); require(if (home == null) routes.isEmpty() else routes.map { it.routeId }.toSet() == starterRouteIds && routes.size == starterRouteIds.size)
        routes.forEach { it.validate(); require(it.routeId in starterRouteIds && starterResourceRealms[it.resourceId] == it.realmId)
            if (it.access == null) require(it.realmId == home?.realmId) }
        require(routes.map { it.routeCatalogueVersion to it.rewardTableVersion }.distinct().size <= 1)
        installation?.let { it.validate(); require(it.baseId == baseId && timestamp(it.installedAt) <= now) }
        flight?.let { it.validate(); require(it.installationId == installation?.installationId && timestamp(it.departedAt) <= now && timestamp(it.returnsAt) > now) }
        lodgeCompletedAt?.let { require(timestamp(it) <= now) }
        require(rawStock.map { it.resourceId }.toSet() == starterResourceRealms.keys && rawStock.size == starterResourceRealms.size); rawStock.forEach { it.validate() }
    }
    companion object { fun from(raw: JsonObject): StarterExpeditionView { boundedStarterHistory(raw); starterPrimitives(raw, serializer().descriptor)
        return starterJson.decodeFromJsonElement<StarterExpeditionView>(raw).also { it.validate() }
            .let { it.copy(routes = it.routes.map(StarterExpeditionRoute::owned), flight = it.flight?.let { f -> f.copy(route = f.route.owned()) }) } } }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class StarterExpeditionRequest(val idempotencyKey: String, val baseId: String, val installationId: String,
    val routeId: String, val routeVersion: Int, val rewardVersion: Int,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val fitting: EquipmentFitting? = null) {
    fun validate() { uuid(idempotencyKey); uuid(baseId); uuid(installationId); require(routeId.matches(Regex("[a-z][a-z0-9_]{0,63}")) && routeVersion > 0 && rewardVersion > 0); fitting?.validate() }
    fun body(): JsonObject = starterJson.encodeToJsonElement(serializer(), this).jsonObject
}
@Serializable data class StarterExpeditionCommand(val request: StarterExpeditionRequest, val route: StarterExpeditionRoute, val installation: StarterFleetInstallation) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/starter-expeditions/by-key/$key"
    fun validate() {
        request.validate(); if (route.routeId.startsWith("paid_") && route.access?.observation == null) validatePaidStarterPreview(route) else route.validate(); installation.validate()
        require(request.baseId == installation.baseId && request.installationId == installation.installationId
            && request.routeId == route.routeId && request.routeVersion == route.routeCatalogueVersion && request.rewardVersion == route.rewardTableVersion
            && request.fitting == route.fitting?.selection())
    }
    fun admit(identity: StarterIdentity, current: StarterExpeditionView) {
        identity.validate(); validate(); current.validate()
        require(current.wallet == identity.wallet && current.baseId == request.baseId && current.acceptingDepartures && current.home != null
            && current.lodgeCompletedAt != null && current.flight == null && current.installation == installation)
        require(current.routes.single { it.routeId == request.routeId } == route)
    }
    fun admitPaid(identity: StarterIdentity, current: StarterExpeditionView, selected: PaidStarterExpeditionView) {
        identity.validate(); validate(); current.validate(); selected.validate()
        require(current.wallet == identity.wallet && current.baseId == request.baseId && current.acceptingDepartures && current.home != null
            && current.lodgeCompletedAt != null && current.flight == null && current.installation == installation)
        require(selected.wallet == identity.wallet && selected.baseId == request.baseId && selected.acceptingDepartures
            && selected.coverage.status == "covered" && selected.route == route)
        val coastal = current.routes.single { it.routeId == "coastal_survey" }
        require(route.durationSec == coastal.durationSec && route.rewardTableVersion == coastal.rewardTableVersion
            && route.grossQuantity == coastal.grossQuantity && route.netQuantity == coastal.netQuantity && route.islandPoolQuantity == coastal.islandPoolQuantity)
    }
    companion object {
    fun reviewPaid(identity: StarterIdentity, view: StarterExpeditionView, selected: PaidStarterExpeditionView, key: String): StarterExpeditionCommand {
        view.validate(); selected.validate(); val route = selected.route; val installed = requireNotNull(view.installation)
        return StarterExpeditionCommand(StarterExpeditionRequest(key, view.baseId, installed.installationId, route.routeId,
            route.routeCatalogueVersion, route.rewardTableVersion), route, installed).also { it.admitPaid(identity, view, selected) }
    }
    fun review(identity: StarterIdentity, view: StarterExpeditionView, key: String, routeId: String): StarterExpeditionCommand {
        view.validate(); val route = view.routes.single { it.routeId == routeId }; val installed = requireNotNull(view.installation)
        return StarterExpeditionCommand(StarterExpeditionRequest(key, view.baseId, installed.installationId, routeId,
            route.routeCatalogueVersion, route.rewardTableVersion), route, installed).also { it.admit(identity, view) }
    } }
}
@Serializable data class StarterExpeditionReceipt(val wallet: String, val request: StarterExpeditionRequest, val expeditionId: String,
    val installationId: String, val route: StarterExpeditionRoute, val departedAt: String, val returnsAt: String, val termId: String, val termHash: String) {
    fun flight() = StarterExpeditionFlight(expeditionId, installationId, route, departedAt, returnsAt, termId, termHash)
    fun validate(identity: StarterIdentity, command: StarterExpeditionCommand) {
        identity.validate(); command.validate(); flight().validate()
        require(wallet == identity.wallet && request == command.request && expeditionId == command.key && installationId == request.installationId && (route == command.route || (command.route.access == StarterExpeditionAccess("paid_realm", 1) && route.copy(access = StarterExpeditionAccess("paid_realm", 1)) == command.route)))
        require(timestamp(departedAt) >= timestamp(command.installation.installedAt))
        route.access?.observation?.let { require(it.wallet == wallet) }
    }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class StarterExpeditionReturn(val returnId: String, val returnedAt: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val secondaryOutput: EquipmentSecondaryOutput? = null)
@Serializable data class StarterExpeditionProof(val wallet: String, val idempotencyKey: String, val serverNow: String, val status: String,
    val receipt: StarterExpeditionReceipt?, @SerialName("return") val returned: StarterExpeditionReturn?) {
    fun validate(identity: StarterIdentity, command: StarterExpeditionCommand) {
        identity.validate(); command.validate(); require(wallet == identity.wallet && idempotencyKey == command.key); val now = timestamp(serverNow)
        if (status == "unknown") { require(receipt == null && returned == null); return }; require(status == "accepted")
        val original = requireNotNull(receipt); original.validate(identity, command); require(timestamp(original.departedAt) <= now)
        returned?.let { require(it.secondaryOutput == original.route.secondaryOutput); it.secondaryOutput?.validate(); uuid(it.returnId); require(timestamp(it.returnedAt) in timestamp(original.returnsAt)..now) }
    }
    companion object { fun from(raw: JsonObject, identity: StarterIdentity, command: StarterExpeditionCommand): StarterExpeditionProof {
        boundedStarterHistory(raw); starterPrimitives(raw, serializer().descriptor)
        return starterJson.decodeFromJsonElement<StarterExpeditionProof>(raw).also { it.validate(identity, command) }
            .let { it.copy(receipt = it.receipt?.let { r -> r.copy(route = r.route.owned()) }) }
    } }
}
