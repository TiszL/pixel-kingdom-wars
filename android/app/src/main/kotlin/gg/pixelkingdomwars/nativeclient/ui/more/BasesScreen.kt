package gg.pixelkingdomwars.nativeclient.ui.more

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.AccountRepository
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.BaseRepository
import gg.pixelkingdomwars.nativeclient.data.ContentRepository
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.NoteLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipStrip
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteCardPage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteNoticeRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.keepTierOf
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.plainSentences
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.JsonObject

/** Web `baseLocationLabel` (lib/baseLocation.ts): realm names come from the catalogue's `baseVisual.REALM_NAMES`. */
fun baseLocationLabel(base: BaseSummary?, fantasy: Boolean, realmNames: JsonObject?): String {
    val realm = base?.fantasyRealmId; val tile = base?.fantasyTileId
    if (realm != null && tile != null) return "${(realmNames?.string(realm) ?: realm).uppercase()} · TILE $tile"
    if (fantasy) return if (base?.landPaidAt != null || base?.deedAssetId != null) Copy.DEED_LOCATION_PENDING else Copy.NO_DEEDED_LAND
    val cell = base?.earthCellId ?: return Copy.EARTH_CELL_PENDING
    return "EARTH · $cell${base.countryA3?.let { " · $it" } ?: ""}"
}
/** Web `fantasyDirectory`: a migrated directory cannot reveal historical addresses. */
fun fantasyDirectory(directory: BaseDirectory?): Boolean = directory?.fantasy == true || directory?.bases?.any { it.fantasyLocation != null } == true
/** Web bases.tsx deed line. */
fun deedLine(base: BaseSummary): String = base.deedAssetId?.let { "DEED ${it.take(6)}…${it.takeLast(4)}" }
    ?: if (base.landPaidAt != null) Copy.LAND_PAID_DEED_PENDING else Copy.FREE_BASE_NO_DEED

data class BasesUiState(val account: AccountState = AccountState(), val canClose: Boolean = false, val realmNames: JsonObject? = null, val replaceBaseId: String? = null,
    /** The content catalogue, read only for the Keep portrait tier (`constants.ART_V2`); never a number shown. */
    val catalogue: JsonObject? = null) {
    val directory: BaseDirectory? get() = account.directory
    val full: Boolean get() = directory?.let { it.activeBases.size >= (it.maxActive ?: 0) } == true
    val writes: Boolean get() = directory?.capabilities?.baseScopedMutations == true
}

/** Lazy, device-local base selector (web bases.tsx). Ownership always comes from fresh GET /bases; the saved ID
 * is only a preference and never grants access by itself. */
class BasesViewModel(private val account: AccountRepository, private val base: BaseRepository, content: ContentRepository) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(graph.account, session.base, graph.content)
    private val replace = MutableStateFlow<String?>(null)
    val state: StateFlow<BasesUiState> = combine(account.state, base.state, content.state, replace) { account, home, content, replace ->
        BasesUiState(account, home.base != null, ((content.catalogue?.get("modules") as? JsonObject)?.get("baseVisual") as? JsonObject)?.get("REALM_NAMES") as? JsonObject, replace,
            catalogue = content.catalogue)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, BasesUiState())
    init { refresh() }
    /** Fresh ownership on every open: a stale selection is reported in production's words. */
    fun refresh() = run {
        account.refreshDirectory()
        val selected = account.state.value.selectedBaseId
        if (selected == null && account.state.value.directory?.selectorAvailable == true && base.state.value.base != null) notify(Copy.DEED_STALE, error = true)
    }
    /** OPEN BASE: the selection commits only with the base read that follows it. */
    fun open(baseId: String) = run { account.selectBase(baseId); base.refreshWithoutJourneys() } // selection hydration: no journey publication (N-C5)
    fun setReplace(baseId: String?) { replace.value = baseId }
    fun activate(baseId: String) = run {
        check(state.value.writes) { Copy.ACTIVATION_LOCKED }
        account.activateBase(baseId, replace.value)
        replace.value = null
    }
}


/** The replacement chips' "no slot chosen" id (it never collides with a base id, which is a UUID). */
internal const val BASES_CHOOSE_SLOT = "choose"

/** Why ACTIVATE DEED cannot run now, or null when it can (the tap then says this instead of doing nothing). */
internal fun basesActivateHold(state: BasesUiState, busy: Boolean): String? = when {
    busy -> "A base request is finishing. Please wait."
    !state.writes -> plainSentences(Copy.BASES_READONLY)
    state.full && state.replaceBaseId == null -> "Choose the active slot this deed replaces first."
    else -> null
}

/**
 * YOUR BASES: every deed this wallet holds, which slots are active, activation and replacement, and the next land.
 * Owner 2026-10-06 ("UI unfinished"): the old Material column is replaced by the designed card ([RouteCardPage]) in the
 * Profile > KINGDOMS grammar (account/profile-kingdoms.png): Keep portrait wells, the gold PLAYING rim, blue SWITCH, the
 * dashed ADD A KINGDOM row with its blue GO, and "A DEED FROM A FRIEND?" with CLAIM. [BasesViewModel] and every action
 * (open, activate, replace, buy, claim) are unchanged; ownership is still the fresh `GET /bases` read on every open, and
 * a refresh keeps the last read list on screen.
 */
@Composable fun BasesScreen(model: BasesViewModel, notice: String?, onBack: () -> Unit, onBuyDeed: (String) -> Unit, onClaimDeed: (() -> Unit)? = null) {
    val state by model.state.collectAsState(); val busy by model.busy.collectAsState(); val screenNotice by model.notice.collectAsState()
    val directory = state.directory
    val fantasy = fantasyDirectory(directory)
    val checking = busy || state.account.busy
    var feedback by remember { mutableStateOf<String?>(null) }
    BackHandlerAt(BackPriority.SCREEN, enabled = state.canClose) { onBack() }
    // Without an open base there is nothing to return to: the close says so instead of doing nothing.
    val close: () -> Unit = { if (model.state.value.canClose) onBack() else feedback = plainSentences(Copy.CHOOSE_ACTIVE_BASE) }
    fun portrait(base: BaseSummary) = keepPortrait(keepTierOf(base.keepLevel, state.catalogue))
    RouteCardPage(Copy.BASES_TITLE, "itm_deed_earth", close) {
        notice?.let { RouteNoticeRow(it) }
        feedback?.let { RouteNoticeRow(it, onDismiss = { feedback = null }) }
        screenNotice?.let { RouteNoticeRow(it.message, error = it.error, retrying = busy,
            onRetry = if (it.error) ({ model.refresh() }) else null, onDismiss = model::dismissNotice) }
        when {
            directory == null -> if (checking || screenNotice == null) repeat(2) { SkeletonRow(height = 84.dp) }
            !directory.selectorAvailable -> RouteNoticeRow(plainSentences(Copy.BASES_UNAVAILABLE))
            else -> {
                val maxActive = directory.maxActive ?: 0
                SectionHeader(Copy.ACTIVE_DEEDS, right = "${directory.activeBases.size} / $maxActive")
                if (checking) StatusTag("CHECKING", Verb.STONE, dots = true)
                if (!state.writes) NoteLine(plainSentences(Copy.BASES_READONLY), maxLines = 4)
                (1..maxActive).forEach { slot ->
                    val base = directory.activeBases.firstOrNull { it.slot == slot }
                    if (base != null) {
                        val current = base.id == state.account.selectedBaseId
                        CardRow(variant = if (current) RowVariant.YOU else RowVariant.PLAIN, height = 84.dp) {
                            Well(portrait(base), size = 64.dp, iconSize = 56.dp)
                            BaseLines("SLOT ${base.slot} · KEEP ${base.keepLevel ?: "—"}", baseLocationLabel(base, fantasy, state.realmNames), deedLine(base))
                            if (current) StatusTag("PLAYING", Verb.GOLD, tall = true)
                            else SecondaryButton("SWITCH", { if (!model.busy.value) model.open(base.id) }, Modifier.width(96.dp), verb = Verb.BLUE,
                                enabled = !busy, contentDescription = "${Copy.OPEN_BASE}, slot ${base.slot}")
                        }
                    } else CardRow(variant = RowVariant.DIM, height = 56.dp) {
                        RowText("SLOT $slot", plainSentences(Copy.SLOT_EMPTY))
                    }
                }
                SectionHeader(Copy.INACTIVE_DEEDS, right = "${directory.inactiveBases.size}")
                if (directory.inactiveBases.isEmpty()) NoteLine(plainSentences(Copy.NO_EXTRA_DEEDS))
                directory.inactiveBases.forEach { base ->
                    AccountCard(Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Well(portrait(base), size = 64.dp, iconSize = 56.dp)
                            BaseLines("KEEP ${base.keepLevel ?: "—"}", baseLocationLabel(base, fantasy, state.realmNames), deedLine(base))
                        }
                        if (state.full && state.writes) {
                            NoteLine(plainSentences(Copy.REPLACE_ACTIVE_SLOT))
                            FilterChipStrip(listOf(FilterChipUi(BASES_CHOOSE_SLOT, Copy.CHOOSE)) + directory.activeBases.map { active ->
                                FilterChipUi(active.id, "SLOT ${active.slot} · KEEP ${active.keepLevel ?: "—"}")
                            }, selected = state.replaceBaseId ?: BASES_CHOOSE_SLOT,
                                onSelect = { id -> model.setReplace(id.takeUnless { it == BASES_CHOOSE_SLOT }) })
                        }
                        val hold = basesActivateHold(state, busy)
                        PrimaryButton(if (state.writes) Copy.ACTIVATE_DEED else Copy.ACTIVATION_LOCKED,
                            { val now = basesActivateHold(model.state.value, model.busy.value); if (now == null) model.activate(base.id) else feedback = now },
                            Modifier.fillMaxWidth(), verb = Verb.GREEN,
                            state = when { busy -> CommandState.BUSY; !state.writes -> CommandState.LOCKED; hold != null -> CommandState.DISABLED; else -> CommandState.ENABLED },
                            reason = hold?.takeIf { state.writes && !busy })
                    }
                }
                SectionHeader(if (fantasy) Copy.NEXT_LAND_TILE else Copy.NEXT_EARTH_CELL)
                if (directory.capabilities?.cellReservations == true) {
                    NoteLine(plainSentences(if (fantasy) Copy.NEXT_TILE_FANTASY else Copy.NEXT_CELL_EARTH), maxLines = 5)
                    if (state.full) NoteLine(plainSentences(Copy.SLOTS_FULL), maxLines = 4)
                    // A wallet that never bought its first land goes through the entry purchase (live-stuck report 2026-08-16).
                    val kind = directory.nextLandPurchaseKind ?: if (state.account.landOwned) "deed" else "entry"
                    CardRow(height = 84.dp) {
                        Well("plus", size = 64.dp, light = true, iconSize = 36.dp)
                        RowText("ADD A KINGDOM", plainSentences(Copy.BUY_ANOTHER_DEED))
                        GoButton({ if (model.busy.value) feedback = "A base request is finishing. Please wait." else onBuyDeed(kind) },
                            contentDescription = Copy.BUY_ANOTHER_DEED, modifier = Modifier.size(72.dp, 52.dp))
                    }
                } else NoteLine(plainSentences(if (fantasy) Copy.LAND_RESERVATION_UNAVAILABLE else Copy.CELL_RESERVATION_UNAVAILABLE), maxLines = 4)
            }
        }
        onClaimDeed?.let { claim ->
            SectionHeader("A DEED FROM A FRIEND?")
            CardRow(height = 72.dp) {
                Well("itm_deed_earth", size = 52.dp, light = true, iconSize = 32.dp)
                RowText("A deed sent to you", "Its base joins this list")
                SecondaryButton("CLAIM", { if (model.busy.value) feedback = "A base request is finishing. Please wait." else claim() },
                    Modifier.width(88.dp), contentDescription = "Claim a deed sent to you")
            }
        }
    }
}

/** A base row's three lines: PS title, its place on the map, its deed. */
@Composable private fun RowScope.BaseLines(title: String, place: String, deed: String) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        PkwText(title, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
        PkwText(place, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
        PkwText(deed, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}
