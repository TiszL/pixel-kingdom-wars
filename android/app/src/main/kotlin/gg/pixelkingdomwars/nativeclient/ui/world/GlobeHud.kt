@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.FantasySearchResult
import kotlinx.coroutines.launch
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role

/** What the globe HUD shows about one realm (catalogue presentation + the server's `/globe/fantasy` realms[] counts). */
data class GlobeRealmInfo(val id: String, val name: String, val numeral: String?, val nav: String?, val epithet: String?, val lore: String?,
    val landscape: String?, val deeds: Int?, val kingdoms: Int?, val open: Int?, val mine: Int, val genesis: Int? = null, val seeker: Int? = null)

/** Callbacks the globe HUD raises; the screen maps them onto `WorldHudFlow`, the view model and navigation. */
class GlobeHudActions(
    /** Portrait sheet: the CTA's bottom edge from the sheet top in dp (the web's `--peek`). */
    val peekMeasured: (Float) -> Unit = {},
    val back: (() -> Unit)?, val campaign: (() -> Unit)?, val bases: () -> Unit,
    val selectRealm: (String) -> Unit, val deselect: () -> Unit, val enterMap: (String, Boolean) -> Unit,
    val toggleSearch: () -> Unit, val query: (String) -> Unit, val openResult: (FantasySearchResult) -> Unit,
    val explore: () -> Unit, val warzone: () -> Unit, val motion: () -> Unit, val myParcel: () -> Unit,
    val night: () -> Unit, val zoom: (Int) -> Unit, val peek: (Boolean) -> Unit,
    /** Choose mode's realm CTA "Choose land here" (GLOBE-PRODUCTION-PLAN §1.3 step 2, `land-realm-enter`). */
    val chooseLand: (String) -> Unit = {},
    /** A Phase E island's rail chip (D-172, debug/test builds only): its island panel, selected and framed. */
    val selectIsland: (String) -> Unit = {},
)

/**
 * Mounts the final designed map [chrome]. The old dark panel frame below draws only where [plan] has a panel, which the
 * World tab never gives it since c-gap-map ([worldGlobeFramePanel] is false): every globe panel (realm, island, parcel,
 * warzone, archipelago list and island, MY PARCEL help) is a designed map half sheet the screen draws ([worldGlobeSheet]).
 * [panelContent] is kept for that frame's signature only.
 */
@Composable internal fun GlobeHud(plan: GlobeHudPlan, ui: WorldHudUi, realms: List<GlobeRealmInfo>, mapped: Set<String>, readiness: Pair<String, Float>?,
    query: String, results: List<FantasySearchResult>, basesBadge: String, motionActive: Boolean, reducedMotion: Boolean, hintText: String,
    actions: GlobeHudActions, panelTitle: String, islands: List<PhaseEIslandInfo> = emptyList(), chrome: @Composable () -> Unit,
    panelContent: @Composable ColumnScope.() -> Unit) {
    val t = LocalHudType.current
    val selectedIndex = realms.indexOfFirst { it.id == ui.realmId }.takeIf { it >= 0 && ui.panel == GlobePanel.REALM }
    chrome()

    // ---- realm panel: right side in landscape, bottom sheet in portrait ----
    val panel = plan.panel
    // The last open panel, kept so that a close slides it out as the web's does (main.js closePanel). A plain holder, not
    // state: writing it never recomposes; [closedTick] recomposes once the slide-out has finished.
    val lastOpen = remember { arrayOfNulls<ClosedPanel>(1) }
    var closedTick by remember { mutableIntStateOf(0) }
    if (panel != null) {
        val realm = realms.getOrNull(selectedIndex ?: -1)
        val shownRealm = realm?.takeIf { ui.panel == GlobePanel.REALM }
        lastOpen[0] = ClosedPanel(plan, ui, shownRealm, panelTitle)
        val accent = HudAccent(HudRealms.accent(shownRealm?.id))
        CompositionLocalProvider(LocalHudAccent provides accent) {
            val density = LocalDensity.current.density
            GlobePanelFrame(plan, ui, reducedMotion, actions.peek, actions.deselect) {
                if (shownRealm != null) RealmPanelBody(shownRealm, plan.shortLandscape, plan.landscape, mapped, readiness, actions,
                    PanelEntrance(ui.panelFresh && !reducedMotion, ui.panelSerial), ui.mineCta, choose = ui.intent == WorldHudIntent.CHOOSE_LAND) { bottomPx -> actions.peekMeasured(bottomPx / density) }
                else {
                    Column(Modifier.padding(start = 18.dp, end = 60.dp, top = if (plan.landscape) 18.dp else 26.dp, bottom = 8.dp)) {
                        HudDisplayText(panelTitle, t.display)
                    }
                    Column(Modifier.weight(1f, fill = false).padding(top = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = panelContent)
                }
            }
        }
    } else {
        val closing = lastOpen[0].takeIf { closedTick >= 0 }
        if (closing != null) key(closing) {
            val closingAccent = HudRealms.accent(closing.realm?.id)
            CompositionLocalProvider(LocalHudAccent provides HudAccent(closingAccent)) {
                ClosingPanel(closing, reducedMotion, mapped, readiness) { if (lastOpen[0] === closing) { lastOpen[0] = null; closedTick++ } }
            }
        }
    }
}

/** What a closing panel showed: the layout it had, the HUD state, the realm (REALM panel) or the title of another panel. */
private class ClosedPanel(val plan: GlobeHudPlan, val ui: WorldHudUi, val realm: GlobeRealmInfo?, val title: String)

/** How a panel opens: [fresh] fades in with its children rising in turn and the stats counting up (never under reduced
 *  motion, never when revealed back from a realm map); [serial] restarts it for each fresh open. */
@Immutable internal data class PanelEntrance(val fresh: Boolean, val serial: Int)

private val CSS_EASE = CubicBezierEasing(.25f, .1f, .25f, 1f)
private val HUD_EASE = CubicBezierEasing(HudStyle.ease[0], HudStyle.ease[1], HudStyle.ease[2], HudStyle.ease[3])
private val HUD_EASE_OUT = CubicBezierEasing(HudStyle.easeOut[0], HudStyle.easeOut[1], HudStyle.easeOut[2], HudStyle.easeOut[3])

/**
 * The slide-out (main.js closePanel): the panel slides off on `--hud-ease` over `--hud-t-slide` while it fades over 0.3 s
 * (reduced motion: the 0.2 s fade only), then leaves composition once invisible (the web hides it at 520 ms). It shows
 * what it showed, without its live content, and takes no action: a tap on it during the fade does nothing.
 */
@Composable private fun ClosingPanel(c: ClosedPanel, reducedMotion: Boolean, mapped: Set<String>, readiness: Pair<String, Float>?, onGone: () -> Unit) {
    val density = LocalDensity.current.density
    val plan = c.plan; val panel = plan.panel ?: return
    val full = plan.sheetFull ?: panel
    val slide = remember { Animatable(0f) }
    val fade = remember { Animatable(1f) }
    val gone by rememberUpdatedState(onGone)
    LaunchedEffect(Unit) {
        if (!reducedMotion) launch { slide.animateTo(1f, tween(HudStyle.slideMs, easing = HUD_EASE)) }
        fade.animateTo(0f, tween(if (reducedMotion) HudMotion.REDUCED_FADE_MS else HudMotion.FADE_MS, easing = CSS_EASE))
        gone()
    }
    val peekShift = if (!plan.landscape && c.ui.peek) (full.h - (full.bottom - (plan.peekTop ?: full.y))) else 0f
    Box(Modifier.at(if (plan.landscape) panel else full).graphicsLayer {
        alpha = fade.value
        if (plan.landscape) translationX = slide.value * (panel.w + 30f) * density
        else translationY = (peekShift + slide.value * (full.h * 1.05f - peekShift)) * density
    }.pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() } } }) {
        HudPanel(Modifier.fillMaxSize(), sheet = !plan.landscape, inert = true) {
            Column(Modifier.fillMaxSize()) {
                if (!plan.landscape) Box(Modifier.fillMaxWidth().height(26.dp)) { HudGrip(Modifier.align(Alignment.Center).padding(top = 4.dp)) }
                val realm = c.realm
                if (realm != null) RealmPanelBody(realm, plan.shortLandscape, plan.landscape, mapped, readiness, INERT_ACTIONS,
                    PanelEntrance(false, c.ui.panelSerial), c.ui.mineCta, choose = c.ui.intent == WorldHudIntent.CHOOSE_LAND) { }
                else Column(Modifier.padding(start = 18.dp, end = 60.dp, top = if (plan.landscape) 18.dp else 26.dp, bottom = 8.dp)) {
                    HudDisplayText(c.title, LocalHudType.current.display)
                }
            }
            Box(Modifier.align(Alignment.TopEnd).padding(top = if (plan.landscape) 12.dp else 16.dp, end = 8.dp).size(44.dp), contentAlignment = Alignment.Center) { HudIcon("close") }
        }
    }
}
private val INERT_ACTIONS = GlobeHudActions(back = null, campaign = null, bases = {}, selectRealm = {}, deselect = {}, enterMap = { _, _ -> },
    toggleSearch = {}, query = {}, openResult = {}, explore = {}, warzone = {}, motion = {}, myParcel = {}, night = {}, zoom = {}, peek = {})

/** The panel frame: slide in on the globe's ease (reduced motion: a 0.2 s fade), the close button, and in portrait the
 *  grab header that peeks, expands and closes (main.js sheet drag rules). */
@Composable private fun GlobePanelFrame(plan: GlobeHudPlan, ui: WorldHudUi, reducedMotion: Boolean, onPeek: (Boolean) -> Unit, onClose: () -> Unit,
    content: @Composable ColumnScope.() -> Unit) {
    val density = LocalDensity.current
    val panel = requireNotNull(plan.panel)
    val full = plan.sheetFull ?: panel
    // Fresh open: slide on `--hud-ease` over `--hud-t-slide` while fading in over 0.3 s; revealed back from a realm map: the
    // slide only, solid (`#panel.ready`); reduced motion: a 0.2 s fade only (index.html #panel transitions).
    val enter = remember { Animatable(if (reducedMotion) 1f else 0f) }
    val fadeIn = remember { Animatable(if (reducedMotion || ui.panelFresh) 0f else 1f) }
    LaunchedEffect(Unit) {
        if (reducedMotion) fadeIn.animateTo(1f, tween(HudMotion.REDUCED_FADE_MS, easing = CSS_EASE))
        else {
            launch { fadeIn.animateTo(1f, tween(HudMotion.FADE_MS, easing = CSS_EASE)) }
            enter.animateTo(1f, tween(HudStyle.slideMs, easing = HUD_EASE))
        }
    }
    var drag by remember { mutableFloatStateOf(0f) }
    val peekShift = if (!plan.landscape && ui.peek) (full.h - (full.bottom - (plan.peekTop ?: full.y))) else 0f
    Box(Modifier.at(if (plan.landscape) panel else full).graphicsLayer {
        val slide = 1f - enter.value
        alpha = fadeIn.value // under reduced motion `enter` starts at 1: no slide, the fade only
        if (plan.landscape) translationX = slide * (panel.w + 30f) * density.density
        else translationY = slide * full.h * 1.05f * density.density
        if (!plan.landscape) translationY += (peekShift + GlobeHudPlan.sheetFollow(drag)) * density.density
    }) {
        HudPanel(Modifier.fillMaxSize(), sheet = !plan.landscape) {
            Column(Modifier.fillMaxSize()) {
                if (!plan.landscape) {
                    var t0 by remember { mutableLongStateOf(0L) }
                    Box(Modifier.fillMaxWidth().height(26.dp).pointerInput(ui.peek) {
                        detectVerticalDragGestures(onDragStart = { t0 = System.currentTimeMillis(); drag = 0f },
                            onDragEnd = {
                                val action = GlobeHudPlan.sheetDrag(drag, System.currentTimeMillis() - t0, ui.peek)
                                drag = 0f
                                when (action) {
                                    GlobeHudPlan.Companion.SheetAction.TOGGLE_PEEK -> onPeek(!ui.peek)
                                    GlobeHudPlan.Companion.SheetAction.PEEK -> onPeek(true)
                                    GlobeHudPlan.Companion.SheetAction.CLOSE -> onClose()
                                    GlobeHudPlan.Companion.SheetAction.EXPAND -> onPeek(false)
                                    GlobeHudPlan.Companion.SheetAction.NONE -> Unit
                                }
                            }, onDragCancel = { drag = 0f }) { change, dy -> change.consume(); drag += dy / density.density }
                    }.semantics { contentDescription = if (ui.peek) "Expand details" else "Collapse details" }) {
                        HudGrip(Modifier.align(Alignment.Center).padding(top = 4.dp))
                    }
                }
                content()
            }
            HudX(onClose, Modifier.align(Alignment.TopEnd).padding(top = if (plan.landscape) 12.dp else 16.dp, end = 8.dp), description = "Close details")
        }
    }
}

/** One realm-panel CTA ([realmCtaRows]): what it is, gold or stone, and for [Kind.PREPARING] the map's readiness. */
internal data class RealmCta(val kind: Kind, val gold: Boolean, val percent: Int = 0) {
    enum class Kind { CHOOSE_LAND, NO_OPEN_LAND, MY_BASE, ENTER_MAP, NO_MAP, PREPARING }
}

/**
 * The realm panel's CTA rows. The browse row is main.js `realmPanel`'s foot: My base when you own land here and the realm
 * has a map, then Enter map (or why not yet: no map, the map still preparing). Choose mode ([choose], GLOBE-PRODUCTION-PLAN
 * §1.3 step 2; its §1 realm panel lists "Enter realm map, My base here (when you own one) and Choose land here (when
 * buying land)") leads with its own row, "Choose land here" for a realm with open land ([open]: the server's `available`,
 * unknown while loading; the reserved Solana Reach never), and keeps the browse row under it. The owner (Seeker code 31b,
 * 2026-09-26): "now somehow it does not show up enter map on globe when selecting realms": choose mode replaced the whole
 * foot, My base and Enter map with it, for a player who owns land in three realms. One gold at most: choose mode's
 * lead while there is open land, else My base when MY PARCEL opened the panel ([mineCta]), else Enter map.
 */
internal fun realmCtaRows(realmId: String, open: Int?, mine: Boolean, hasMap: Boolean, ready: Float?, mineCta: Boolean, choose: Boolean): List<List<RealmCta>> {
    val preparing = ready != null && ready < 1f
    val percent = if (preparing) ((ready ?: 0f) * 100).toInt() else 0
    val openLand = realmId != "seeker-reach" && (open == null || open > 0)
    val chooseLeads = choose && openLand
    val myBaseGold = !chooseLeads && mineCta && mine && hasMap
    val enterGold = !chooseLeads && !myBaseGold
    val browse = buildList {
        if (mine && hasMap) add(RealmCta(RealmCta.Kind.MY_BASE, myBaseGold))
        add(when {
            !hasMap -> RealmCta(RealmCta.Kind.NO_MAP, false)
            preparing -> RealmCta(RealmCta.Kind.PREPARING, enterGold, percent)
            else -> RealmCta(RealmCta.Kind.ENTER_MAP, enterGold)
        })
    }
    if (!choose) return listOf(browse)
    val lead = when {
        !openLand -> RealmCta(RealmCta.Kind.NO_OPEN_LAND, false)
        hasMap && preparing -> RealmCta(RealmCta.Kind.PREPARING, true, percent)
        else -> RealmCta(RealmCta.Kind.CHOOSE_LAND, true)
    }
    return listOf(listOf(lead), browse)
}

/** main.js `realmPanel`: kicker (numeral + nav), the Silkscreen display name in the realm's light, epithet, lore,
 *  landscape, the server's counts, and the CTA foot ([realmCtaRows]: My base and Enter map always; choose mode leads
 *  with "Choose land here"). In choose mode the panel's Open deeds stat carries the count. */
@Composable private fun ColumnScope.RealmPanelBody(realm: GlobeRealmInfo, short: Boolean, landscape: Boolean, mapped: Set<String>, readiness: Pair<String, Float>?,
    actions: GlobeHudActions, entrance: PanelEntrance, mineCta: Boolean, choose: Boolean = false, onFootBottom: (Float) -> Unit) {
    val t = LocalHudType.current; val accent = LocalHudAccent.current
    val density = LocalDensity.current.density
    // One clock (ms since the open) drives the staggered rise of every child (index.html pIn, read in the draw phase only)
    // and the stats' count-up (main.js countUp). Not fresh: it starts at the end, so nothing moves.
    val clock = remember(realm.id, entrance) { Animatable(if (entrance.fresh) 0f else HudMotion.ENTRANCE_MS.toFloat()) }
    LaunchedEffect(realm.id, entrance) { if (entrance.fresh) clock.animateTo(HudMotion.ENTRANCE_MS.toFloat(), tween(HudMotion.ENTRANCE_MS, easing = LinearEasing)) }
    fun Modifier.rise(index: Int): Modifier = if (!entrance.fresh) this else graphicsLayer {
        val k = HUD_EASE_OUT.transform(HudMotion.stagger(index, clock.value))
        alpha = k; translationY = (1f - k) * HudMotion.RISE_DP * density
    }
    Column(Modifier.padding(start = if (short) 14.dp else 18.dp, end = 60.dp, top = if (short) 12.dp else 18.dp, bottom = if (short) 6.dp else 10.dp),
        verticalArrangement = Arrangement.spacedBy(if (short) 4.dp else 8.dp)) {
        Row(Modifier.rise(0), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // `.hud-numeral`: the accent plate with its inset highlight and `0 0 12px var(--hud-acc-a)` glow
            realm.numeral?.let { HudText(it, t.kick, Modifier.hudShadows(HudShadow(0f, 0f, 12f, 0f, accent.a)).drawBehind {
                drawRect(HudStyle.ink); drawRect(accent.acc, Offset(1.dp.toPx(), 1.dp.toPx()), Size(size.width - 2.dp.toPx(), size.height - 2.dp.toPx()))
                drawRect(accent.hi, Offset(1.dp.toPx(), 1.dp.toPx()), Size(size.width - 2.dp.toPx(), 1.dp.toPx()))
            }.padding(start = 5.dp, end = 5.dp, top = 2.dp, bottom = 1.dp), color = HudStyle.ink, spacing = 1f, line = 1f) }
            HudText(realm.nav ?: "REALM", t.kick, color = accent.ink, spacing = 2f, caps = true, line = 1f)
        }
        HudDisplayText(realm.name, t.display, Modifier.rise(1).semantics { heading() }, maxLines = 2)
        realm.epithet?.let { HudText(it, t.ui, Modifier.rise(2), color = accent.ink, maxLines = 2, line = 1.2f) }
    }
    val mine = realm.mine > 0; val hasMap = realm.id in mapped
    val ready = readiness?.takeIf { it.first == realm.id }?.second
    val rows = realmCtaRows(realm.id, realm.open, mine, hasMap, ready, mineCta, choose)
    val foot: @Composable () -> Unit = {
        Column(Modifier.rise(HudMotion.CTA_INDEX).onGloballyPositioned { c -> onFootBottom(c.positionInParent().y + c.size.height) }.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(HudStyle.gap.dp)) {
            rows.forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(HudStyle.gap.dp)) { row.forEach { RealmCtaButton(it, realm.id, actions) } } }
        }
    }
    if (!landscape) foot()
    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(start = if (short) 14.dp else 18.dp, end = if (short) 14.dp else 18.dp, top = 6.dp, bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(if (short) 8.dp else 12.dp)) {
        realm.lore?.let { HudText(it, t.body, Modifier.rise(3), color = HudStyle.text, maxLines = 6, line = 1.3f) }
        if (!short) realm.landscape?.let { HudText(it, t.cap, Modifier.rise(4), color = HudStyle.textFaint, spacing = 1f, caps = true, maxLines = 3) }
        val reserved = realm.id == "seeker-reach"
        val stats = if (reserved) listOf("Deeds" to realm.deeds, "Genesis" to realm.genesis, "Seeker" to realm.seeker, "Open deeds" to 0)
            else listOf("Deeds" to realm.deeds, "Kingdoms" to realm.kingdoms, "Open deeds" to realm.open, "Your bases" to realm.mine)
        val columns = if (short) 4 else 2
        Column(Modifier.rise(5), verticalArrangement = Arrangement.spacedBy(if (short) 6.dp else 8.dp)) {
            stats.chunked(columns).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(if (short) 6.dp else 8.dp)) {
                    row.forEach { (label, value) -> CountStat(value, label, clock, entrance.fresh, mine = label == "Your bases" && (value ?: 0) > 0, modifier = Modifier.weight(1f)) }
                }
            }
        }
        if (reserved) Box(Modifier.rise(6)) { HudNote("Reserved allocation", "Genesis and Seeker owner allocations remain reserved. Awards and claims are not open.") }
    }
    if (landscape) foot()
}

@Composable private fun RowScope.RealmCtaButton(cta: RealmCta, realmId: String, actions: GlobeHudActions) {
    val t = LocalHudType.current
    val kind = if (cta.gold) HudButtonKind.GOLD else HudButtonKind.STONE
    when (cta.kind) {
        RealmCta.Kind.CHOOSE_LAND -> HudButton({ actions.chooseLand(realmId) }, Modifier.weight(1f), kind = kind, description = "Choose land here") {
            HudIcon("map"); HudText("Choose land here", t.ui, spacing = 1f, caps = true) }
        RealmCta.Kind.NO_OPEN_LAND -> HudButton({}, Modifier.weight(1f), enabled = false) { HudText("No open land", t.ui, spacing = 1f, caps = true) }
        RealmCta.Kind.MY_BASE -> HudButton({ actions.enterMap(realmId, true) }, Modifier.weight(1f), kind = kind) { HudIcon("locate"); HudText("My base", t.ui, spacing = 1f, caps = true) }
        RealmCta.Kind.ENTER_MAP -> HudButton({ actions.enterMap(realmId, false) }, Modifier.weight(1f), kind = kind) { HudIcon("map"); HudText("Enter map", t.ui, spacing = 1f, caps = true) }
        RealmCta.Kind.NO_MAP -> HudButton({}, Modifier.weight(1f), enabled = false) { HudText("No map yet", t.ui, spacing = 1f, caps = true) }
        RealmCta.Kind.PREPARING -> HudButton({}, Modifier.weight(1f), kind = kind, enabled = false, description = "Preparing the realm map") {
            HudIcon("map"); HudText("Preparing ${cta.percent}%", t.ui, spacing = 1f, caps = true) }
    }
}

/** A realm stat that counts up from 0 on a fresh open (main.js countUp). It alone reads the clock, so only it recomposes. */
@Composable private fun CountStat(value: Int?, label: String, clock: Animatable<Float, *>, counting: Boolean, mine: Boolean, modifier: Modifier = Modifier) {
    val shown = when {
        value == null -> "—"
        counting -> RealmHudModel.fmtN(HudMotion.countUp(value.toLong(), clock.value))
        else -> RealmHudModel.fmtN(value)
    }
    HudStat(shown, label, modifier.clearAndSetSemantics { contentDescription = "$label ${value?.let(RealmHudModel::fmtN) ?: "unknown"}" }, mine = mine)
}

@Composable internal fun HudNote(title: String, body: String) {
    val t = LocalHudType.current; val accent = LocalHudAccent.current
    Column(Modifier.fillMaxWidth().drawBehind {
        drawRect(HudStyle.border); drawRect(Color(20, 18, 26, 153), Offset(2.dp.toPx(), 2.dp.toPx()), Size(size.width - 4.dp.toPx(), size.height - 4.dp.toPx()))
        drawRect(accent.acc, Offset.Zero, Size(4.dp.toPx(), size.height))
    }.padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        HudText(title, t.kick, color = accent.ink, spacing = 2f, caps = true)
        HudText(body, t.body, color = HudStyle.textDim, maxLines = 6, line = 1.3f)
    }
}

/** `.hud-row`: a 48 dp list row (search results). */
@Composable internal fun HudRow(onClick: () -> Unit, description: String, mine: Boolean = false, content: @Composable RowScope.() -> Unit) {
    val interaction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).drawBehind {
        drawRect(if (mine) HudStyle.goldDp else HudStyle.border); drawRect(HudStyle.rowFill, Offset(2.dp.toPx(), 2.dp.toPx()), Size(size.width - 4.dp.toPx(), size.height - 4.dp.toPx()))
    }.semantics { contentDescription = description }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick).padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically, content = content)
}

/** Place at a planner rect (dp). */
internal fun Modifier.at(r: HudRect): Modifier = this.offset(r.x.dp, r.y.dp).size(r.w.dp, r.h.dp)
