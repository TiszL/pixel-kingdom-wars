package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject

data class WorldState(
    val globe: FantasyGlobe? = null,
    val loading: Boolean = false,
    val error: String? = null,
    /** `503 FANTASY_WORLD_NOT_READY` or a catalogue mismatch: the world cannot be offered right now. */
    val unavailable: String? = null,
)

/** Server-owned world directory and metered parcel reads, fenced to the requesting identity and base. */
interface WorldRepository {
    val state: StateFlow<WorldState>
    suspend fun refreshGlobe()
    suspend fun parcel(tileId: Int): FantasyParcel
    suspend fun search(term: String): List<FantasySearchResult> = error("Owner search is unavailable")
    suspend fun warzone(): JsonObject? = error("Warzone status is unavailable")
    suspend fun markers(x0: Int, y0: Int, x1: Int, y1: Int): FantasyViewport
}

class LiveWorldRepository(
    private val session: AccountSession,
    private val holder: AccountSessionHolder,
    private val api: ApiClient,
    private val baseId: () -> String?,
    private val catalogue: () -> JsonObject?,
    /** The frozen owner-approved geography of the active pack; a parcel is trusted only where it agrees. */
    private val frozen: () -> FantasyCatalog?,
) : WorldRepository {
    private val _state = MutableStateFlow(WorldState())
    override val state: StateFlow<WorldState> = _state.asStateFlow()
    private fun query(base: String?, extra: Map<String, String> = emptyMap()) = extra + base?.let { mapOf("baseId" to it) }.orEmpty()
    private fun capture(): String? { holder.requireCurrent(session); return baseId() }
    private fun requireBase(base: String?) {
        holder.requireCurrent(session)
        if (baseId() != base) throw SessionSupersededException()
    }
    private fun catalogHash(): String? = ((catalogue()?.get("modules") as? JsonObject)?.get("fantasyWorld") as? JsonObject)?.string("FANTASY_CATALOG_HASH")

    /** Web `validateFantasyGlobe`: a catalogue hash the bundled world does not know is a world update. */
    override suspend fun refreshGlobe() {
        val requestedBase = capture()
        _state.update { it.copy(loading = true, error = null) }
        try {
            val globe = FantasyGlobe.from(api.get("/globe/fantasy", query(requestedBase)))
            requireBase(requestedBase)
            val expected = catalogHash()
            if (!globe.ready || (expected != null && globe.catalogHash != expected)) {
                _state.update { it.copy(globe = null, unavailable = "World catalog update required. Install the available app update to choose land.") }
                throw ApiCompatibilityException("/globe/fantasy")
            }
            _state.update { it.copy(globe = globe, unavailable = null) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (holder.isCurrent(session) && baseId() == requestedBase) _state.update {
                if (error is ApiException && error.status == 503 && error.code == "FANTASY_WORLD_NOT_READY") it.copy(globe = null, unavailable = error.message)
                else it.copy(error = error.message ?: "Connection interrupted. Please retry.")
            }
            throw error
        } finally { if (holder.isCurrent(session) && baseId() == requestedBase) _state.update { it.copy(loading = false) } }
    }
    /** Web `validateFantasyParcel`: the server's tile must match the frozen catalogue's realm and allocation
     * for that address, so a pack/server drift can never draft a tile the web would refuse. */
    override suspend fun parcel(tileId: Int): FantasyParcel {
        val requestedBase = capture()
        require(tileId >= 0)
        val parcel = FantasyParcel.from(api.get("/globe/fantasy/parcels/$tileId", query(requestedBase)))
        requireBase(requestedBase)
        val expected = frozen()?.tile(tileId)
        require(expected != null && parcel.worldId == BaseDirectory.FANTASY_WORLD_ID && parcel.tile.worldId == BaseDirectory.FANTASY_WORLD_ID
            && parcel.tile.tileId == tileId && parcel.tile.realmId == expected.realmId && parcel.tile.allocation == expected.allocation) { "Parcel address mismatch" }
        return parcel
    }
    override suspend fun search(term: String): List<FantasySearchResult> {
        val requestedBase = capture()
        val value = term.trim()
        if (value.length < 2) return emptyList()
        require(value.length <= 160) { "Owner search is too long" }
        val response = FantasySearch.from(api.get("/globe/fantasy/search", mapOf("q" to value)))
        requireBase(requestedBase)
        return response.results.filter { row -> frozen()?.tile(row.tileId)?.realmId == row.realmId && row.name.length <= 160 }
    }
    override suspend fun warzone(): JsonObject? {
        val requestedBase=capture()
        val result=api.get("/economy/stats")
        requireBase(requestedBase)
        return result["warzone"] as? JsonObject
    }
    override suspend fun markers(x0: Int, y0: Int, x1: Int, y1: Int): FantasyViewport {
        val requestedBase = capture()
        val catalog = requireNotNull(frozen()) { "World catalog is unavailable" }
        require(x0 in 0..x1 && x1 < catalog.columns && y0 in 0..y1 && y1 < catalog.rows)
        val rect = FantasyRect(x0, y0, x1, y1)
        val viewport = FantasyViewport.from(api.get("/globe/fantasy/parcels", query(requestedBase, mapOf("x0" to "$x0", "y0" to "$y0", "x1" to "$x1", "y1" to "$y1"))))
        requireBase(requestedBase)
        require(viewport.worldId == BaseDirectory.FANTASY_WORLD_ID && viewport.scope == rect) { "Globe parcel scope mismatch" }
        val markers = viewport.markers.filter { marker ->
            catalog.tile(marker.tileId) != null && catalog.x(marker.tileId) in x0..x1 && catalog.y(marker.tileId) in y0..y1 &&
                marker.name != null && (marker.name?.length ?: Int.MAX_VALUE) <= 160 && marker.keepLevel != null
        }.distinctBy { it.tileId }
        return viewport.copy(markers = markers, matched = maxOf(markers.size, viewport.matched))
    }
}
