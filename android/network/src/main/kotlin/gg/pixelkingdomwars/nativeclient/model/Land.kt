package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** Fantasy world (D-128/D-129) wire models. Realm names and world geometry come from the constants
 * catalogue (`modules.baseVisual`, `constants.FANTASY_WORLD`), never from this file. */
@Serializable data class FantasyTile(
    val worldId: String? = null,
    @Serializable(LenientIntSerializer::class) val tileId: Int,
    val realmId: String,
    val allocation: String? = null,
    /** Degrees, kept as the server's exact text for display; the simulation never reads positions. */
    @Serializable(DecimalStringSerializer::class) val lon: String? = null,
    @Serializable(DecimalStringSerializer::class) val lat: String? = null,
) {
    val ordinary: Boolean get() = allocation == null || allocation == "ordinary"
}

/** One row of `GET /globe/fantasy.realms`: server-counted availability per realm. */
@Serializable data class FantasyRealm(
    val realmId: String,
    @Serializable(LenientIntSerializer::class) val total: Int = 0,
    @Serializable(LenientIntSerializer::class) val occupied: Int = 0,
    @Serializable(LenientIntSerializer::class) val held: Int = 0,
    @Serializable(LenientIntSerializer::class) val available: Int = 0,
    @Serializable(LenientIntSerializer::class) val anchorTileId: Int? = null,
)

@Serializable data class FantasyOwnedTile(
    val baseId: String,
    @Serializable(LenientIntSerializer::class) val tileId: Int,
    val realmId: String,
    val name: String? = null,
    @Serializable(LenientIntSerializer::class) val keepLevel: Int? = null,
    val active: Boolean = false,
    val selected: Boolean = false,
    /** The owner's profile image (the server's `/api/avatars/<generation>.webp`), null for none: the realm map's name tag. */
    val avatarUrl: String? = null,
)
@Serializable data class FantasyGlobeMe(
    val baseId: String? = null,
    @Serializable(LenientIntSerializer::class) val selectedTileId: Int? = null,
    val ownedTiles: List<FantasyOwnedTile> = emptyList(),
)

/** `GET /globe/fantasy`. */
@Serializable data class FantasyGlobe(
    val worldId: String,
    val catalogHash: String? = null,
    val ready: Boolean = false,
    val realms: List<FantasyRealm> = emptyList(),
    val me: FantasyGlobeMe? = null,
    val warzone: JsonObject? = null,
) {
    companion object {
        fun from(raw: JsonObject): FantasyGlobe = raw.decode<FantasyGlobe>().also { require(it.worldId == BaseDirectory.FANTASY_WORLD_ID) { "Unknown world ${it.worldId}" } }
    }
}

/** `GET /globe/fantasy/parcels?x0..y1`: occupied markers only; availability is per tile. [shielded] (D-NEXT, server
 *  PR #147) is the raid gate's own answer at the read: a live shield not suppressed by a warzone. Older servers omit it:
 *  null, which draws no dome ([shieldUp] false) and tells the HUD the feed cannot answer "who is shielded" at all. */
@Serializable data class FantasyMarker(@Serializable(LenientIntSerializer::class) val tileId: Int, val name: String? = null, @Serializable(LenientIntSerializer::class) val keepLevel: Int? = null,
    @Serializable(ShieldedFlagSerializer::class) val shielded: Boolean? = null,
    /** The owner's profile image (the server's `/api/avatars/<generation>.webp`), null for none: the realm map's name tag. */
    val avatarUrl: String? = null) {
    /** The dome answer: only a marker the server called shielded; absent (an older server) stays null: no dome, and never
     *  unshielded (SHARDKEEP D-191: only an explicit `false` is a raid target). */
    val shieldUp: Boolean get() = shielded == true
}

/** A marker's `shielded`: JSON `true` / `false` (or their text forms) decode; anything else stays null ("not carried")
 *  and the read survives it: absent, JSON null, or a present but malformed value (a number, an object, an array), so one
 *  odd value never costs the whole viewport read. SHARDKEEP D-191 made `false` a positive claim (an explicitly unshielded
 *  kingdom is a raid target), so a malformed bit reads unknown, never false: the map offers only the targets the server
 *  named (D-169 / D-181: hidden, never faked). */
internal object ShieldedFlagSerializer : KSerializer<Boolean?> {
    override val descriptor: SerialDescriptor = Boolean.serializer().nullable.descriptor
    override fun deserialize(decoder: Decoder): Boolean? = ((decoder as JsonDecoder).decodeJsonElement() as? JsonPrimitive)?.booleanOrNull
    override fun serialize(encoder: Encoder, value: Boolean?) = if (value == null) encoder.encodeNull() else encoder.encodeBoolean(value)
}
@Serializable data class FantasyRect(val x0: Int, val y0: Int, val x1: Int, val y1: Int)
@Serializable data class FantasySearchResult(
    val tileId: Int, val realmId: String, val name: String, val keepLevel: Int, val trophies: Int, val seeker: Boolean = false,
)
@Serializable data class FantasySearch(val results: List<FantasySearchResult>) {
    companion object { fun from(raw: JsonObject): FantasySearch = raw.decode() }
}
@Serializable data class FantasyViewport(
    val worldId: String,
    @Serializable(LenientIntSerializer::class) val matched: Int = 0,
    val truncated: Boolean = false,
    val markers: List<FantasyMarker> = emptyList(),
    val scope: FantasyRect? = null,
) {
    /** This read's markers carry `shielded` (a server with PR #147). An older server's read, or one with no markers, cannot
     *  say who is shielded: the realm map must not offer the UNSHIELDED chip (SHARDKEEP D-191) on its word. */
    val carriesShielded: Boolean get() = markers.any { it.shielded != null }
    companion object { fun from(raw: JsonObject): FantasyViewport = raw.decode() }
}

/** `GET /globe/fantasy/parcels/:tileId`: `reserved` (genesis/Seeker allocation), `available`, `held`, `occupied`. */
@Serializable data class FantasyParcel(
    val worldId: String,
    val tile: FantasyTile,
    val availability: String,
    val detail: JsonElement? = null,
) {
    val available: Boolean get() = availability == "available"
    companion object {
        fun from(raw: JsonObject): FantasyParcel = raw.decode<FantasyParcel>().also {
            require(it.availability in setOf("reserved", "available", "held", "occupied")) { "Unknown parcel availability" }
        }
    }
}

/** `landAddress` on a land deposit; production sends and returns the fantasy form only. */
@Serializable data class LandAddress(
    val kind: String,
    val worldId: String? = null,
    @Serializable(LenientIntSerializer::class) val tileId: Int? = null,
    @Serializable(LenientIntSerializer::class) val earthCell: Int? = null,
) {
    val fantasy: Boolean get() = kind == "fantasy" && worldId == BaseDirectory.FANTASY_WORLD_ID
    companion object { fun fantasy(tileId: Int?): LandAddress = LandAddress("fantasy", BaseDirectory.FANTASY_WORLD_ID, tileId) }
}

/** `POST /deposits` (kind entry|deed) and `GET /deposits/:id` / `POST /deposits/:id/verify`. The
 * same shape carries a fresh reservation, a replayed pending one, a terminal row and the
 * `alreadyPaid` short-circuit; [requireReservation] proves which one arrived. */
@Serializable data class LandDeposit(
    val id: String? = null,
    val kind: String? = null,
    val status: String? = null,
    val reference: String? = null,
    val baseId: String? = null,
    @Serializable(DecimalStringSerializer::class) val amountLamports: String? = null,
    val landAddress: LandAddress? = null,
    val fantasyLocation: FantasyTile? = null,
    /** Server deadlines; the client never extends a payable reservation. */
    val serverNow: String? = null,
    val payableUntil: String? = null,
    val retryAt: String? = null,
    val paymentSignature: String? = null,
    val txSignature: String? = null,
    val alreadyPaid: Boolean = false,
) {
    val credited: Boolean get() = status == "credited"
    val terminal: Boolean get() = status in setOf("credited", "expired", "failed")
    /** `worldId:tileId` for a fantasy reservation (web `landReservationIdentity`), or null when malformed. */
    val reservationIdentity: String? get() {
        val address = landAddress ?: return null
        if (!address.fantasy || address.tileId == null || address.tileId < 0) return null
        if (fantasyLocation != null && fantasyLocation.tileId != address.tileId) return null
        return "${address.worldId}:${address.tileId}"
    }
    /** A payable reservation: id, reference, base, frozen price and frozen fantasy address all present. */
    fun requireReservation(expectedKind: String): LandDeposit {
        require(!id.isNullOrBlank() && !reference.isNullOrBlank() && !baseId.isNullOrBlank()) { "server did not return a complete land reservation" }
        require(kind == null || kind == expectedKind) { "server returned a different land purchase" }
        require(reservationIdentity != null) { "server did not return a complete land reservation" }
        val amount = amountLamports
        require(amount != null && amount.matches(Regex("[1-9][0-9]*")) && amount.length <= 20) { "server did not return a complete land reservation" }
        return this
    }
    companion object { fun from(raw: JsonObject): LandDeposit = raw.decode() }
}

/** `POST /deposits/:id/paid` acknowledgement is the deposit row itself; nothing else is read from it. */
fun JsonObject.depositStatus(): String? = (this["status"] as? JsonPrimitive)?.contentOrNull
