package gg.pixelkingdomwars.nativeclient.ui.land

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.FantasyParcel
import gg.pixelkingdomwars.nativeclient.model.FantasyRealm
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** One candidate tile of the picker: occupied markers come from the viewport read, availability from
 * one metered parcel inspection when the tile is tapped. */
data class TileCell(val tileId: Int, val occupied: Boolean, val availability: String? = null)
data class TilePicker(val realmId: String? = null, val tiles: List<TileCell> = emptyList(), val parcel: FantasyParcel? = null, val loading: Boolean = false)

/** Web `landStage`: the rail says where the player is; payment credit permits play, only the deed asset marks minting done. */
enum class LandStage { PICK, RESERVE, PAY, CONFIRMED, MINTING, DEED }

data class LandUiState(
    val checkout: LandCheckoutState = LandCheckoutState(),
    val world: WorldState = WorldState(),
    val picker: TilePicker = TilePicker(),
    val landOwned: Boolean = false,
    val hasBase: Boolean = false,
    val deedReady: Boolean = false,
    /** The catalogue's `LAND_CHECKOUT_RECOVERY`; null while the loaded pack lacks it (checkout fails closed). */
    val bounds: LandCheckoutBounds? = null,
    val interrupted: List<InterruptedIntent> = emptyList(),
    val realmNames: Map<String, String> = emptyMap(),
    val wallet: String? = null,
    /** The server's last `/wallet/balances` read (the Home HUD's SOL source); the RPC estimate leads once a reservation is priced. */
    val funds: WalletFunds? = null,
    /** Realm swatches from the render catalogue's fantasy presentation (`regions[].color`, hex text); presentation only. */
    val realmColors: Map<String, String> = emptyMap(),
) {
    val reservation get() = checkout.reservation
    val additionalDeed: Boolean get() = checkout.purchaseKind == "deed"
    val paymentCredited: Boolean get() = checkout.phase == LandPhase.CREDITED || (landOwned && !additionalDeed)
    /** An interrupted reservation must be recovered first; a pack without the recovery bounds cannot reserve at all. */
    val reservationBlocked: Boolean get() = interrupted.any { it.kind == IntentKind.LAND_RESERVATION && it.blocking } || checkout.unavailable != null
    val realms: List<FantasyRealm> get() = world.globe?.realms.orEmpty()
    fun realmName(id: String) = realmNames[id] ?: id.replaceFirstChar { it.uppercase() }
    /** Web `FundingChip`: the freshest balance available against the frozen price (plus fees once estimated). */
    val funding: FundingView get() = fundingView(checkout.estimate, funds, reservation)
    val stage: LandStage get() = when {
        deedReady -> LandStage.DEED
        paymentCredited -> LandStage.MINTING
        reservation != null || checkout.phase == LandPhase.PAYING || checkout.phase == LandPhase.CONFIRMING || checkout.phase == LandPhase.FAILED -> LandStage.PAY
        checkout.draftedTile != null || checkout.phase == LandPhase.RESERVING -> LandStage.RESERVE
        else -> LandStage.PICK
    }
}

/** CLAIM YOUR LAND / FOUND ANOTHER KEEP: realm and tile choice, the frozen reservation, one wallet
 * approval and reference verification; entering the game re-reads `/me`, `/bases` and Home. */
class LandViewModel(
    private val land: LandRepository, private val world: WorldRepository, private val account: AccountRepository, private val base: BaseRepository,
    private val observer: ReceiptObserver, private val content: ContentRepository, private val catalog: () -> FantasyCatalog?,
    private val actions: InterruptedActions?,
    /** The wallet's server-read funds (Home HUD source) and the read that refreshes them; absent in tests that never fund. */
    private val funds: Flow<WalletFunds?> = flowOf(null), private val refreshFunds: suspend () -> Unit = {},
    private val signOutAction: suspend (() -> Unit) -> Unit,
) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(session.land, session.world, graph.account, session.base, session.observer, graph.content,
        { graph.fantasyCatalog() }, null, session.economy.state.map { it.wallet }, { session.economy.refresh(EconomyPage.WALLET) },
        { after -> graph.account.logout(after) }) { fallback = interruptedActions(session) }
    private var fallback: InterruptedActions? = null
    private val picker = MutableStateFlow(TilePicker())
    val state: StateFlow<LandUiState> = combine(land.state, world.state, picker, account.state, observer.interrupted, base.state, content.state, funds) { values ->
        @Suppress("UNCHECKED_CAST")
        val checkout = values[0] as LandCheckoutState; val worldState = values[1] as WorldState; val pick = values[2] as TilePicker
        val acct = values[3] as AccountState; val interrupted = values[4] as List<InterruptedIntent>; val home = values[5] as BaseState; val contentState = values[6] as ContentState
        val wallet = values[7] as WalletFunds?
        val deedReady = checkout.reservation?.baseId?.let { id -> acct.directory?.bases?.firstOrNull { it.id == id }?.deedAssetId != null } == true
        LandUiState(checkout, worldState, pick, acct.landOwned, home.base != null, deedReady, LandCheckoutBounds.from(contentState.catalogue), interrupted, realmNames(contentState.catalogue), acct.wallet,
            wallet, realmColors(contentState.renderCatalogue))
    }.stateIn(viewModelScope, SharingStarted.Eagerly, LandUiState())
    val interrupted: InterruptedActions get() = actions ?: requireNotNull(fallback)
    private var fundingPoll: kotlinx.coroutines.Job? = null

    private fun realmNames(catalogue: JsonObject?): Map<String, String> =
        ((catalogue?.get("modules") as? JsonObject)?.get("baseVisual") as? JsonObject)?.get("REALM_NAMES")?.let { it as? JsonObject }
            ?.mapValues { (it.value as? kotlinx.serialization.json.JsonPrimitive)?.content ?: it.key }.orEmpty()
    /** Same source as the world screen's realm labels (`fantasy.presentation.regions[].color`). */
    private fun realmColors(render: JsonObject?): Map<String, String> =
        (((render?.get("fantasy") as? JsonObject)?.get("presentation") as? JsonObject)?.get("regions") as? JsonArray).orEmpty()
            .mapNotNull { row -> (row as? JsonObject)?.let { r -> val id = r.string("id"); val color = r.string("color"); if (id != null && color != null) id to color else null } }.toMap()

    fun open(kind: String) = run {
        land.open(kind)
        if (world.state.value.globe == null) runCatching { world.refreshGlobe() }
    }
    fun refreshWorld() = run { world.refreshGlobe() }
    /** Candidate tiles: the first ordinary tiles of the realm in tile order, with occupied markers from one viewport read. */
    fun pickRealm(realmId: String) = run {
        val frozen = catalog() ?: error("Game content is still loading")
        val realm = state.value.realms.firstOrNull { it.realmId == realmId } ?: error("Unknown realm")
        picker.value = TilePicker(realmId, loading = true)
        val from = realm.anchorTileId?.let { maxOf(0, it - frozen.columns) } ?: 0
        val candidates = frozen.ordinaryTiles(realmId, from, TILE_CANDIDATES).ifEmpty { frozen.ordinaryTiles(realmId, 0, TILE_CANDIDATES) }
        val occupied = if (candidates.isEmpty()) emptySet() else {
            val xs = candidates.map(frozen::x); val ys = candidates.map(frozen::y)
            runCatching { world.markers(xs.min(), ys.min(), xs.max(), ys.max()).markers.map { it.tileId }.toSet() }.getOrDefault(emptySet())
        }
        picker.value = TilePicker(realmId, candidates.map { TileCell(it, it in occupied) })
    }
    fun clearRealm() { picker.value = TilePicker(); land.draft(null) }
    /** One metered parcel read decides availability; only an available tile becomes the draft. */
    fun inspectTile(tileId: Int) = run {
        val parcel = world.parcel(tileId)
        picker.update { p -> p.copy(parcel = parcel, tiles = p.tiles.map { if (it.tileId == tileId) it.copy(availability = parcel.availability) else it }) }
        land.draft(if (parcel.available) tileId else null)
        if (!parcel.available) notify("Tile $tileId is ${parcel.availability}. Choose another tile.", error = true)
    }
    fun reserveDrafted() = run { land.reserve(requireNotNull(state.value.checkout.draftedTile) { "Choose a tile first" }) }
    /**
     * SETTLE IN <REALM> without a hand-picked tile (land-realm.png): the same two owner steps a tile tap and SETTLE make, in
     * one action. The parcel read decides; only an available tile is drafted and reserved (payment still waits for the
     * Seal and the wallet). A taken tile is marked so the next SETTLE tries the next candidate.
     */
    fun settleTile(tileId: Int) = run {
        val parcel = world.parcel(tileId)
        picker.update { p -> p.copy(parcel = parcel, tiles = p.tiles.map { if (it.tileId == tileId) it.copy(availability = parcel.availability) else it }) }
        if (parcel.available) {
            land.draft(tileId)
            land.reserve(tileId)
        } else {
            land.draft(null)
            notify("Tile $tileId is ${parcel.availability}. Tap SETTLE again for the next free tile.", error = true)
        }
    }
    fun reserveRandom() = run { land.reserve(null) }
    fun pay(signer: LandSigner) = run { land.pay(signer) }
    fun retryPayment(signer: LandSigner) = run { land.retryPayment(signer) }
    fun refreshEstimate() = run { land.refreshEstimate() }
    /** Web `useSolBalance(wallet, 10_000)`: one funding read per tick while the screen is open, never through the busy
     * action slot (a poll must not disable PAY or flash the progress bar). A priced reservation re-reads its RPC estimate;
     * otherwise the server wallet read the Home HUD uses. Failures are silent: the chip says BALANCE UNAVAILABLE. */
    fun pollFunding() {
        if (fundingPoll?.isActive == true) return
        fundingPoll = viewModelScope.launch {
            try {
                val checkout = state.value.checkout
                if (checkout.reservation != null && checkout.phase == LandPhase.READY) { if (!checkout.estimateLoading) land.refreshEstimate() }
                else refreshFunds()
            } catch (error: CancellationException) { throw error } catch (_: Exception) { /* the next tick tries again */ }
        }
    }
    fun clearNotice() { land.clearNotice(); dismissNotice() }
    /** Overlay's post-payment entry: `/me`, `/bases` and Home are re-read from the server before Home shows. */
    fun enterGame(onEntered: () -> Unit) = run {
        account.refreshIdentity(); account.refreshDirectory()
        runCatching { base.refreshWithoutJourneys() } // post-payment entry hydration: no journey publication (N-C5)
        onEntered()
    }
    fun refreshDirectory() = run { account.refreshDirectory() }
    fun signOut(afterLocal: () -> Unit) = run { signOutAction(afterLocal) }

    companion object { const val TILE_CANDIDATES = 24 }
}
