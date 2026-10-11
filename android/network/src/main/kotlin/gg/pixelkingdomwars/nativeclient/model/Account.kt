package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** `GET /me`. */
@Serializable data class Identity(
    val wallet: String,
    val name: String? = null,
    @Serializable(LenientIntSerializer::class) val keepLevel: Int? = null,
    val entryPaid: Boolean? = null,
    val deedAssetId: String? = null,
    val seeker: SeekerStatus? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Your kingdom"
    companion object { fun from(raw: JsonObject): Identity = raw.decode<Identity>().also { require(it.wallet.isNotBlank()) } }
}

@Serializable data class SeekerStatus(val linked: Boolean = false, val verifiedAt: String? = null, val stale: Boolean = false) {
    val verified: Boolean get() = linked && verifiedAt != null && !stale
}

/** `GET /bases`: the wallet's deed directory. `worldId` selects the fantasy or legacy world client. */
@Serializable data class BaseDirectory(
    val enabled: Boolean = false,
    val worldId: String? = null,
    @Serializable(LenientIntSerializer::class) val maxActive: Int? = null,
    val nextLandPurchaseKind: String? = null,
    val capabilities: BaseCapabilities? = null,
    val bases: List<BaseSummary> = emptyList(),
) {
    val fantasy: Boolean get() = worldId == FANTASY_WORLD_ID
    /** Web `baseSelectorAvailable` (lib/api.ts): the deed selector and deed-scoped history exist only with base-scoped reads. */
    val selectorAvailable: Boolean get() = enabled && capabilities?.baseScopedReads == true
    /** Web `stableBaseMode` (Overlay.tsx): the defender raid interlock and deed activation need base-scoped mutations too. */
    val stableMutations: Boolean get() = selectorAvailable && capabilities?.baseScopedMutations == true
    val activeBases: List<BaseSummary> get() = bases.filter { it.selectable }
    val inactiveBases: List<BaseSummary> get() = bases.filter { it.status == "inactive" || it.slot == null }
    companion object {
        const val FANTASY_WORLD_ID = "fantasy-v1"
        fun from(raw: JsonObject): BaseDirectory = raw.decode()
    }
}

@Serializable data class BaseSummary(
    val id: String,
    val status: String? = null,
    @Serializable(LenientIntSerializer::class) val keepLevel: Int? = null,
    @Serializable(LenientIntSerializer::class) val builders: Int? = null,
    @Serializable(LenientIntSerializer::class) val slot: Int? = null,
    val deedAssetId: String? = null,
    val landPaidAt: String? = null,
    val countryA3: String? = null,
    val fantasyLocation: JsonElement? = null,
    val earthCell: JsonElement? = null,
) {
    /** A deed without an active slot cannot be selected for gameplay. */
    val selectable: Boolean get() = status == "active" && slot != null
    val fantasyRealmId: String? get() = (fantasyLocation as? JsonObject)?.get("realmId")?.let { (it as? JsonPrimitive)?.contentOrNull }
    val fantasyTileId: String? get() = (fantasyLocation as? JsonObject)?.get("tileId")?.let { (it as? JsonPrimitive)?.contentOrNull }
    val earthCellId: String? get() = (earthCell as? JsonPrimitive)?.takeUnless { it is JsonNull }?.contentOrNull
}

/** `GET /bases.capabilities`: which deed-scoped surfaces this server serves (web `BasesDto.capabilities`). */
@Serializable data class BaseCapabilities(
    val baseScopedReads: Boolean = false,
    val baseScopedMutations: Boolean = false,
    val cellReservations: Boolean = false,
)

/** `GET /playtest/access` (D-118): invite codes are retired while the playtest is open. */
@Serializable data class PlaytestAccess(val open: Boolean, val playUrl: String? = null) {
    companion object { fun from(raw: JsonObject): PlaytestAccess = raw.decode() }
}

/** `GET /2fa/status`. */
@Serializable data class SecurityStatus(
    val totpEnabled: Boolean = false,
    val emailVerified: Boolean = false,
    val email: String? = null,
    val reenrollmentRequired: Boolean = false,
    val loginTotpRequired: Boolean = false,
) { companion object { fun from(raw: JsonObject): SecurityStatus = raw.decode() } }

/** `GET /native/capabilities` (re-ported native support; absent on an unported server). */
@Serializable data class NativeCapabilities(
    val protocolVersion: Int,
    val simVersion: Long,
    val minimumVersionCode: Long = 0,
    val contentManifestUrl: String? = null,
    val presentation: PresentationCapability? = null,
    val economy: NativeEconomyCapability? = null,
    @kotlinx.serialization.Transient val phaseEArt: PhaseEArtCapability? = null,
    /** M45 in-app update channel; the key is absent unless the server offers a signed APK to this caller. */
    @Serializable(TolerantUpdateOfferSerializer::class) val update: NativeUpdateOffer? = null,
    /** D-NEXT world kill switch (backend PR #143, always sent there); absent from older servers, and a malformed value
     * reads as absent. The app caches the last value it read (`WorldV2Switch`). */
    @Serializable(TolerantWorldV2Serializer::class) val worldV2: WorldV2Capability? = null,
) {
    companion object { fun from(raw: JsonObject): NativeCapabilities = raw.decode<NativeCapabilities>()
        .copy(phaseEArt = PhaseEArtCapability.optional(raw["phaseEArt"]))
        .also { require(it.minimumVersionCode >= 0) } }
}
@Serializable data class PresentationCapability(val enabled: Boolean = false)

/** `GET /native/capabilities.worldV2`: `enabled: false` sends every client to the legacy globe without a release. */
@Serializable data class WorldV2Capability(val enabled: Boolean = true)

/** A malformed switch is no switch: it must never cost the capabilities response its content and minimum-build fields. */
object TolerantWorldV2Serializer : KSerializer<WorldV2Capability?> {
    override val descriptor: SerialDescriptor = WorldV2Capability.serializer().nullable.descriptor
    override fun deserialize(decoder: Decoder): WorldV2Capability? {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        return (element as? JsonObject)?.let { raw -> runCatching { raw.decode<WorldV2Capability>() }.getOrNull() }
    }
    override fun serialize(encoder: Encoder, value: WorldV2Capability?) =
        (encoder as JsonEncoder).encodeJsonElement(value?.let { ApiJson.encodeToJsonElement(WorldV2Capability.serializer(), it) } ?: JsonNull)
}

/** `GET /native/capabilities.update` (M45 §1, frozen). Advisory only: the client resolves [apkPath] against its own
 * origin and verifies hash, package, signer and version of the downloaded file before any install. */
@Serializable data class NativeUpdateOffer(
    val latestVersionCode: Long,
    val versionName: String,
    val sourceCommit: String,
    val apkPath: String,
    val apkUrl: String,
    val sha256: String,
    val sizeBytes: Long,
    val signerSha256: String,
    val publishedAt: String,
    val storeStatus: String,
    val channel: String,
    val mandatory: Boolean = false,
    val notesUrl: String? = null,
)

/** A malformed offer is no offer: it must never cost the capabilities response its content and minimum-build fields. */
object TolerantUpdateOfferSerializer : KSerializer<NativeUpdateOffer?> {
    override val descriptor: SerialDescriptor = NativeUpdateOffer.serializer().nullable.descriptor
    override fun deserialize(decoder: Decoder): NativeUpdateOffer? {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        return (element as? JsonObject)?.let { raw -> runCatching { raw.decode<NativeUpdateOffer>() }.getOrNull() }
    }
    override fun serialize(encoder: Encoder, value: NativeUpdateOffer?) =
        (encoder as JsonEncoder).encodeJsonElement(value?.let { ApiJson.encodeToJsonElement(NativeUpdateOffer.serializer(), it) } ?: JsonNull)
}

/** `GET /version`. */
@Serializable data class ServerVersion(val version: String, val gitSha: String, val builtAt: String? = null, val simVersion: Int) {
    companion object { fun from(raw: JsonObject): ServerVersion = raw.decode() }
}

/** `GET /auth/login/status` and the login-verify family: a wallet that still owes its authenticator code. */
@Serializable data class LoginStatus(val loginRequired: Boolean, val wallet: String? = null) {
    companion object { fun from(raw: JsonObject): LoginStatus = raw.decode<LoginStatus>().also { require(!it.loginRequired || !it.wallet.isNullOrBlank()) } }
}
