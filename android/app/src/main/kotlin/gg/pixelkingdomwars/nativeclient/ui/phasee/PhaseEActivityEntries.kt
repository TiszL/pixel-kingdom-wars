package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.economy.TitledPlate
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageRow

internal enum class PhaseEActivityGroup(val title: String) {
    MARKET("MARKET & WORKSHOP"), KINGDOMS("KINGDOMS & EXPEDITIONS"),
    EVENTS("CLANS & TRIALS"), SHARES("CLAIMS & SHARES")
}

/** Navigation labels only. Availability and every opening action remain in their existing mount. */
internal enum class PhaseEActivity(val group: PhaseEActivityGroup, val title: String) {
    KEEP_MARKET(PhaseEActivityGroup.MARKET, "KEEP MARKET"),
    WORKSHOP(PhaseEActivityGroup.MARKET, "WORKSHOP · EXPEDITION EQUIPMENT"),
    INGOT_WORKSHOP(PhaseEActivityGroup.MARKET, "WORKSHOP"),
    REFINING(PhaseEActivityGroup.MARKET, "REFINING"),
    COSMETICS(PhaseEActivityGroup.MARKET, "COSMETICS"),
    REALM_PASSPORT(PhaseEActivityGroup.KINGDOMS, "REALM PASSPORT · HISTORY"),
    VEHICLES(PhaseEActivityGroup.KINGDOMS, "VEHICLES & EXPEDITIONS"),
    REALM_PERMITS(PhaseEActivityGroup.KINGDOMS, "REALM PERMIT PURCHASES & RECEIPTS"),
    PAID_EXPEDITIONS(PhaseEActivityGroup.KINGDOMS, "PAID REALM EXPEDITIONS & RECEIPTS"),
    FREE_KINGDOM(PhaseEActivityGroup.KINGDOMS, "FREE KINGDOM PURCHASE & RECEIPT"),
    STARTER_FLEET(PhaseEActivityGroup.KINGDOMS, "STARTER VEHICLE"),
    STARTER_EXPEDITIONS(PhaseEActivityGroup.KINGDOMS, "SEND EXPEDITION"),
    HARVESTERS(PhaseEActivityGroup.KINGDOMS, "REALM HARVESTER"),
    CHARTERS(PhaseEActivityGroup.EVENTS, "CLAN CHARTERS & INVITATIONS"),
    TOURNAMENTS(PhaseEActivityGroup.EVENTS, "CLAN TOURNAMENTS & PRIZES"),
    DIVINE_TRIALS(PhaseEActivityGroup.EVENTS, "DIVINE TRIALS & PRIZES"),
    MINING(PhaseEActivityGroup.SHARES, "KEEP MINING & CLAIM RECEIPTS"),
    MINING_TAX(PhaseEActivityGroup.SHARES, "KEEP TAX CLAIMS & RECEIPTS"),
    SHARDS(PhaseEActivityGroup.SHARES, "SEEKER SHARDS & RECEIPTS"),
    RESOURCES(PhaseEActivityGroup.SHARES, "SEEKER RESOURCE SHARES & RECEIPT"),
    FRAGMENTS(PhaseEActivityGroup.SHARES, "CRYSTAL FRAGMENTS & SEEKER SHARES")
}

/** Session-owned presentation state. Retired mounts cannot remove or invoke a replacement's action. */
internal class PhaseEActivityRegistry {
    private data class Entry(val owner: Any, val canLaunch: () -> Boolean,
        val onLaunch: () -> Unit, val onHistory: (() -> Unit)?)
    private val entries = mutableStateMapOf<PhaseEActivity, Entry>()
    private val featureEntries = mutableStateMapOf<FeatureId, Entry>()
    fun registerFeatureDoor(id: FeatureId, owner: Any, canLaunch: () -> Boolean, onLaunch: () -> Unit) {
        if (active) featureEntries[id] = Entry(owner, canLaunch, onLaunch, null)
    }
    fun unregisterFeature(id: FeatureId, owner: Any) {
        if (featureEntries[id]?.owner === owner) featureEntries.remove(id)
    }
    fun featureAvailable(id: FeatureId): Boolean {
        if (!active) return false
        val entry = featureEntries[id] ?: existingPhaseEDoor(id)?.let(entries::get) ?: return false
        return entry.canLaunch()
    }
    /** Canonical entry keeps one owner and the existing dispatch fence. History never falls through here. */
    fun launchFeature(id: FeatureId): Boolean {
        if (!active || dispatching) return false
        val entry = featureEntries[id] ?: return existingPhaseEDoor(id)?.let(::launch) ?: false
        if (!entry.canLaunch()) return false
        close(); dispatching = true
        try { entry.onLaunch() } finally { dispatching = false }
        return true
    }
    private data class ResourceEntry(val rows: List<ResourceRow>, val quotes: List<ActionResourceQuote>, val current: () -> Boolean)
    private val resourceEntries=mutableStateMapOf<Any,ResourceEntry>()
    fun registerResources(owner: Any, rows: List<ResourceRow>, quotes: List<ActionResourceQuote>, current: () -> Boolean) {
        if(active)resourceEntries[owner]=ResourceEntry(resourceList(rows.map{it.resourceSnapshot()}),resourceList(quotes.map{it.resourceSnapshot()}),current)
    }
    fun unregisterResources(owner: Any) { resourceEntries.remove(owner) }
    val resources: List<ResourceRow> get() {
        if(!active)return emptyList()
        val samples=resourceEntries.values.flatMap { entry ->
            val current=runCatching { entry.current() }.getOrDefault(false)
            entry.rows.map { it to current }
        }
        return resourceList(samples.groupBy { Triple(it.first.id,it.first.kind,it.first.scope) }.values.sortedBy { it.first().first.id }.map { group ->
            val live=group.filter { it.second }
            when(live.size) {
                1 -> live.single().first
                0 -> group.first().first.copy(amount=retiredResourceAmount)
                else -> live.first().first.copy(amount=ResourceAmount.Unavailable("Resource producers disagree; refresh the current balance."))
            }
        })
    }
    val resourceQuotes: List<ActionResourceQuote> get() {
        if(!active)return emptyList()
        return resourceList(resourceEntries.values.flatMap { entry ->
            val current=runCatching { entry.current() }.getOrDefault(false)
            entry.quotes.map { quote -> if(current)quote else quote.copy(costs=resourceList(quote.costs.map {
                it.copy(required=retiredResourceAmount,available=retiredResourceAmount)
            })) }
        })
    }
    private var active = true
    private var dispatching = false
    var expanded by mutableStateOf(false)
        private set
    val available: List<PhaseEActivity> get() = PhaseEActivity.entries.filter { entries[it]?.onHistory != null }
    val registered: List<PhaseEActivity> get() = PhaseEActivity.entries.filter { entries.containsKey(it) }
    val launchable: List<PhaseEActivity> get() = if (!active) emptyList() else registered.filter { entries[it]?.canLaunch?.invoke() == true }
    fun hasDistinctHistory(activity: PhaseEActivity): Boolean = entries[activity]?.let {
        it.onHistory != null && it.onHistory !== it.onLaunch
    } == true

    fun register(activity: PhaseEActivity, owner: Any, onClick: () -> Unit) {
        if (active) entries[activity] = Entry(owner, { true }, onClick, onClick)
    }
    /** Primary discovery and receipt recovery have distinct callbacks: history can never fall through to new work. */
    fun registerDoor(activity: PhaseEActivity, owner: Any, canLaunch: () -> Boolean,
        onLaunch: () -> Unit, onHistory: (() -> Unit)?) {
        if (active) entries[activity] = Entry(owner, canLaunch, onLaunch, onHistory)
        if (available.isEmpty()) close()
    }
    /** Direct world/island entry, still owned by the one current registration. It only navigates. */
    fun launch(activity: PhaseEActivity): Boolean {
        if (!active || dispatching) return false
        val entry = entries[activity] ?: return false
        if (!entry.canLaunch()) return false
        close()
        dispatching = true
        try { entry.onLaunch() } finally { dispatching = false }
        return true
    }
    fun unregister(activity: PhaseEActivity, owner: Any) {
        if (entries[activity]?.owner === owner) entries.remove(activity)
        if (available.isEmpty()) close()
    }
    fun open() { if (active && available.isNotEmpty()) expanded = true }
    fun close() { expanded = false }
    fun choose(activity: PhaseEActivity): Boolean {
        if (!active || !expanded) return false
        val action = entries[activity]?.onHistory ?: return false
        close()
        action()
        return true
    }
    fun dispose() { active = false; close(); entries.clear(); featureEntries.clear(); resourceEntries.clear() }
}

private val LocalPhaseEActivityRegistry = staticCompositionLocalOf<PhaseEActivityRegistry?> { null }

/** Shares the existing session scope with in-world hosts; never constructs another registry. */
@Composable internal fun rememberPhaseEActivityRegistry(): PhaseEActivityRegistry? = LocalPhaseEActivityRegistry.current

@Composable internal fun PhaseEDoorEntry(activity: PhaseEActivity, canLaunch: () -> Boolean,
    onHistory: (() -> Unit)? = null, onLaunch: () -> Unit) {
    val registry = LocalPhaseEActivityRegistry.current ?: return
    val owner = remember(registry, activity) { Any() }
    val latestCanLaunch = rememberUpdatedState(canLaunch)
    val latestLaunch = rememberUpdatedState(onLaunch)
    val latestHistory = rememberUpdatedState(onHistory)
    DisposableEffect(registry, activity, owner, onHistory != null) {
        registry.registerDoor(activity, owner, { latestCanLaunch.value() }, { latestLaunch.value() },
            if (onHistory == null) null else ({ latestHistory.value?.invoke(); Unit }))
        onDispose { registry.unregister(activity, owner) }
    }
}

/** Exact canonical feature IDs share the session-owned registry with legacy entries. */
@Composable internal fun PhaseEFeatureEntry(id: FeatureId, canLaunch: () -> Boolean, onLaunch: () -> Unit) {
    val registry = LocalPhaseEActivityRegistry.current ?: return
    val owner = remember(registry, id) { Any() }
    val latestCanLaunch = rememberUpdatedState(canLaunch)
    val latestLaunch = rememberUpdatedState(onLaunch)
    DisposableEffect(registry, id, owner) {
        registry.registerFeatureDoor(id, owner, { latestCanLaunch.value() }, { latestLaunch.value() })
        onDispose { registry.unregisterFeature(id, owner) }
    }
}

@Composable internal fun PhaseEActivityScope(session: Any, content: @Composable () -> Unit) {
    val registry = remember(session) { PhaseEActivityRegistry() }
    DisposableEffect(registry) { onDispose { registry.dispose() } }
    CompositionLocalProvider(LocalPhaseEActivityRegistry provides registry, content = content)
}

@Composable internal fun PhaseEActivityEntry(activity: PhaseEActivity, onClick: () -> Unit) {
    val registry = LocalPhaseEActivityRegistry.current
    val latest = rememberUpdatedState(onClick)
    if (registry == null) {
        // Individual mounts also remain usable outside the combined Phase E host.
        ActivityButton(activity, onClick, Modifier.padding(horizontal = 16.dp))
    } else DisposableEffect(registry, activity) {
        val owner = Any()
        registry.register(activity, owner) { latest.value() }
        onDispose { registry.unregister(activity, owner) }
    }
}

/** One activity as a designed cream row (owner 2026-10-06: the old dark outlined button is off the player path). */
@Composable private fun ActivityButton(activity: PhaseEActivity, onClick: () -> Unit, modifier: Modifier = Modifier) {
    VoyageRow(modifier, minHeight = 52.dp, description = activity.title, onClick = onClick) {
        when (activity) {
            PhaseEActivity.WORKSHOP -> GameArt("ui_compass", Modifier.padding(start = 6.dp).size(28.dp))
            PhaseEActivity.SHARDS -> GameArt("shards", Modifier.padding(start = 6.dp).size(22.dp))
            else -> Box(Modifier.padding(start = 2.dp))
        }
        PkwText(activity.title, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
        PkwIcon("shape:go", 20.dp, Modifier.padding(end = 6.dp), tint = PkwTokens.Colors.textOnParch2)
    }
}

/** Bases keep their composition while the menu is open; opening a feature still belongs to its mount. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable internal fun PhaseEActivityHost(bases: @Composable () -> Unit) {
    val registry = LocalPhaseEActivityRegistry.current
    if (registry == null) { bases(); return }
    val entries = registry.available
    val expanded = registry.expanded
    val menuFocus = remember { FocusRequester() }
    val launcherFocus = remember { FocusRequester() }
    var restoreFocus by remember { mutableStateOf(false) }
    val close = { registry.close(); restoreFocus = true }
    BackHandlerAt(BackPriority.SHEET, expanded, close)
    DisposableEffect(registry) { onDispose { registry.close() } }
    LaunchedEffect(expanded, restoreFocus) {
        if (expanded) menuFocus.requestFocus()
        else if (restoreFocus && entries.isNotEmpty()) { launcherFocus.requestFocus(); restoreFocus = false }
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().then(if (expanded) Modifier.clearAndSetSemantics {} else Modifier)) {
            // Owner 2026-10-06: the launcher and the menu are the designed kit (blue GO-to button, tall wood sheet, cream rows).
            if (entries.isNotEmpty()) SecondaryButton("ACTIVITIES & RECEIPTS", registry::open,
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).focusRequester(launcherFocus), verb = Verb.BLUE)
            Box(Modifier.weight(1f)) { bases() }
        }
        if (expanded) PhaseEDesignedSheet("ACTIVITIES & RECEIPTS", close,
            Modifier.semantics { paneTitle = "Activities and receipts" }
                .pointerInput(Unit) { detectTapGestures {} }
                .focusRequester(menuFocus).focusProperties { exit = { FocusRequester.Cancel } }.focusGroup()
                .onPreviewKeyEvent { event ->
                    if (event.key == Key.Escape && event.type == KeyEventType.KeyUp) { close(); true } else false
                }) {
            PkwText("Open an activity or return to its saved receipts.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
            PhaseEActivityGroup.entries.forEach { group ->
                val choices = entries.filter { it.group == group }
                if (choices.isNotEmpty()) {
                    VoyageLabel(group.title)
                    choices.forEach { activity ->
                        if (registry.hasDistinctHistory(activity)) {
                            Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
                                Column(Modifier.fillMaxWidth().padding(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    PkwText(activity.title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 2)
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        SecondaryButton("OPEN", { if (registry.expanded) registry.launch(activity) }, Modifier.weight(1f), verb = Verb.GOLD)
                                        SecondaryButton("RECEIPTS", { registry.choose(activity) }, Modifier.weight(1f))
                                    }
                                }
                            }
                        } else ActivityButton(activity, { registry.choose(activity) })
                    }
                }
            }
        }
    }
}
