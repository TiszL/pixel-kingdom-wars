package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import kotlin.math.abs
import kotlin.math.hypot

/** Callbacks the realm-map HUD raises (ui.js actions; the screen maps them onto `WorldHudFlow` and the view model). */
class RealmHudActions(
    val exit: () -> Unit, val zoom: (Int) -> Unit, val myBase: () -> Unit, val step: (Int) -> Unit,
    val filter: (String) -> Unit, val level: (Int, Int) -> Unit, val toggleLevel: () -> Unit,
    val toggleSearch: () -> Unit, val query: (String) -> Unit, val choose: (RealmHudBase) -> Unit,
    val toggleMinimap: () -> Unit, val minimap: (MinimapGesture) -> Unit, val closeCard: () -> Unit,
    /** N4: the WARZONE chip (F16), choose mode's "Next open deed ▶", a search result in another realm (F9). */
    val warzone: () -> Unit = {}, val nextOpen: () -> Unit = {}, val jump: (RealmElsewhere) -> Unit = {},
)

/** A kingdom the owner search found in another realm (F9): the row offers "Go to ‹realm›". */
data class RealmElsewhere(val tileId: Int, val realmId: String, val realmName: String, val name: String, val level: Int)

/**
 * Mounts the final designed map [chrome] and preserves the realm panels. The World tab passes [card] = null: its base card
 * is the designed sheet the screen draws itself (MS-UI3, `WorldParcelSheet` / `WorldReachTileSheet`). Optional auxiliary controls
 * use [auxiliaryRects] supplied by the screen so they do not overlap the designed rail. The screen supplies the same
 * minimap rectangle to GL; Compose retains its frame, toggle and gesture forwarding.
 */
@Composable internal fun RealmMapHud(plan: RealmHudPlan, ui: WorldHudUi, title: String, subtitle: String, chips: List<HudChip>, query: String,
    results: List<RealmHudBase>, scale: Pair<Int, String>, shownCount: Int, actions: RealmHudActions, onCardHeight: (Float) -> Unit,
    card: (@Composable ColumnScope.() -> Unit)?, elsewhere: List<RealmElsewhere> = emptyList(), nextOpenEnabled: Boolean = true,
    warzone: (@Composable ColumnScope.() -> Unit)? = null, chrome: @Composable () -> Unit,
    auxiliaryRects: Map<String, HudRect> = emptyMap(), shownCountKnown: Boolean = true,
    /** False when the host draws the LV range itself (the World tab's designed sheet, c-gap-map): no old level panel. */
    levelPanel: Boolean = true) {
    val t = LocalHudType.current
    chrome()

    // ---- existing warzone status panel ----
    (auxiliaryRects["warzonePanel"] ?: plan.rect("warzonePanel"))?.let { r -> if (warzone != null) HudPanel(Modifier.at(r).semantics { contentDescription = "Warzone status" }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 14.dp, end = 56.dp, top = 12.dp, bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp), content = warzone)
        HudX(actions.warzone, Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 4.dp), description = "Close warzone")
    } }

    // ---- filter announcement and existing level range ----
    Box(Modifier.size(1.dp).semantics { liveRegion = LiveRegionMode.Polite; contentDescription = if (shownCountKnown) "$shownCount kingdoms shown" else "Kingdom counts are not available yet" })
    (auxiliaryRects["level"] ?: plan.rect("level"))?.takeIf { levelPanel }?.let { r -> HudPanel(Modifier.at(r)) {
        Column(Modifier.fillMaxSize().padding(start = 14.dp, end = 56.dp, top = 10.dp, bottom = 6.dp)) {
            for ((index, label) in listOf("Min", "Max").withIndex()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                HudText(label, t.cap, Modifier.width(32.dp), color = HudStyle.textFaint, spacing = 1f, caps = true)
                val value = if (index == 0) ui.filter.lo else ui.filter.hi
                HudRange(value, 1, 20, { actions.level(index, it) }, if (index == 0) "Minimum keep level" else "Maximum keep level", Modifier.weight(1f))
                HudText(value.toString(), t.ui, Modifier.width(28.dp), color = HudStyle.text)
            }
        }
        HudX(actions.toggleLevel, Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 4.dp), description = "Close level range")
    } }

    // ---- minimap frame (GL draws inside it) and its toggle ----
    auxiliaryRects["minimap"]?.let { r -> MinimapFrame(Modifier.at(r), actions.minimap) }
    auxiliaryRects["minimapToggle"]?.let { r -> HudTool("map", null, actions.toggleMinimap, Modifier.at(r), on = plan.miniShown,
        description = if (plan.miniShown) "Hide minimap" else "Show minimap") }

    // ---- optional navigation above the designed rail ----
    auxiliaryRects["nav"]?.let { r -> Row(Modifier.at(r), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        HudTool("prev", null, { actions.step(-1) }, description = "Previous base"); HudTool("next", null, { actions.step(1) }, description = "Next base")
    } }
    // Choose mode without a card (GLOBE-PRODUCTION-PLAN §1.3 step 3, `land-map-open-deed`): the next open-deed candidate
    auxiliaryRects["nextOpen"]?.let { r -> HudButton(actions.nextOpen, Modifier.at(r), enabled = nextOpenEnabled, description = "Next open deed") {
        HudText("Next open deed", t.ui, spacing = 1f, caps = true); HudIcon("next") } }

    // ---- scale pill: a two-tone bar of a whole number of deeds (tiles closer in), never px ----
    auxiliaryRects["scale"]?.let { r -> HudPill(Modifier.at(r).semantics { contentDescription = "Scale: ${scale.second}" }) {
        Box(Modifier.size((scale.first + 4).dp, 10.dp).drawBehind {
            drawRect(HudStyle.scaleInk); val px = 2.dp.toPx()
            drawRect(HudStyle.gold, Offset(px, px), Size((size.width - 2 * px) / 2, size.height - 2 * px))
            drawRect(HudStyle.text, Offset(px + (size.width - 2 * px) / 2, px), Size((size.width - 2 * px) / 2, size.height - 2 * px))
        })
        HudText(scale.second, t.ui, color = HudStyle.text, line = 1f)
    } }

    // ---- base card: bottom sheet (portrait) or right panel (wide); swipe = next/previous, portrait swipe down = close ----
    if (card != null) {
        val density = LocalDensity.current
        val modifier = if (plan.portrait) Modifier.fillMaxWidth() else Modifier.offset((plan.rect("card")?.x ?: 0f).dp, (plan.rect("card")?.y ?: 120f).dp)
            .width(RealmHudPlan.CARD_W.dp)
        Box(Modifier.fillMaxSize(), contentAlignment = if (plan.portrait) Alignment.BottomStart else Alignment.TopStart) {
            HudPanel(modifier.heightIn(max = plan.cardMaxH.dp).onSizeChanged { onCardHeight(it.height / density.density) }
                .semantics { contentDescription = "Base details" }
                .pointerInput(Unit) {
                    var dx = 0f; var dy = 0f
                    detectHorizontalDragGestures(onDragStart = { dx = 0f; dy = 0f }, onDragEnd = {
                        if (abs(dx) > 50 * density.density) actions.step(if (dx < 0) 1 else -1)
                    }) { change, amount -> dx += amount; change.consume() }
                }
                .then(if (plan.portrait) Modifier.pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false); var last = down.position
                        while (true) { val e = awaitPointerEvent(); val c = e.changes.firstOrNull() ?: break; if (!c.pressed) { last = c.position; break }; last = c.position }
                        val dx = last.x - down.position.x; val dy = last.y - down.position.y
                        if (dy > 60 * density.density && abs(dy) > abs(dx)) actions.closeCard()
                    }
                } else Modifier), sheet = plan.portrait) {
                Column(Modifier.fillMaxWidth().padding(top = if (plan.portrait) 14.dp else 16.dp)) {
                    if (plan.portrait) HudGrip(Modifier.align(Alignment.CenterHorizontally))
                    card()
                }
                HudX(actions.closeCard, Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 4.dp), description = "Close")
            }
        }
    }
}

/** `.hud-frame` around the GL minimap: 2 dp stone border in a 2 dp ink ring, two 4 dp gold pips; transparent inside.
 *  Tap flies there, a drag moves the view box, a pinch zooms the minimap, a double tap resets it (ui.js hit-div). */
@Composable private fun MinimapFrame(modifier: Modifier, onGesture: (MinimapGesture) -> Unit) {
    val density = LocalDensity.current.density
    Box(modifier.blockSceneInput().hudShadows(HudStyle.frameShadow).drawBehind {
        val px = 1.dp.toPx(); val w = size.width; val h = size.height
        fun ring(inset: Float, width: Float, c: Color) {
            drawRect(c, Offset(inset, inset), Size(w - 2 * inset, width)); drawRect(c, Offset(inset, h - inset - width), Size(w - 2 * inset, width))
            drawRect(c, Offset(inset, inset), Size(width, h - 2 * inset)); drawRect(c, Offset(w - inset - width, inset), Size(width, h - 2 * inset))
        }
        ring(0f, 2 * px, HudStyle.ink); ring(2 * px, 2 * px, HudStyle.borderLt)
        drawRect(HudStyle.gold, Offset(5 * px, 5 * px), Size(4 * px, 4 * px)); drawRect(HudStyle.gold, Offset(w - 9 * px, 5 * px), Size(4 * px, 4 * px))
    }.semantics { contentDescription = "Realm minimap: tap to fly, drag the box to pan, pinch to zoom, double-tap to reset" }
        .pointerInput(Unit) {
            var lastTap = 0L
            awaitEachGesture {
                val down = awaitFirstDown(); down.consume()
                val start = down.position; var moved = false; var pinch: Float? = null
                while (true) {
                    val e = awaitPointerEvent(); val pressed = e.changes.filter { it.pressed }
                    if (pressed.isEmpty()) break
                    if (pressed.size >= 2) {
                        val d = hypot(pressed[0].position.x - pressed[1].position.x, pressed[0].position.y - pressed[1].position.y)
                        pinch?.let { if (it > 0f) onGesture(MinimapGesture.Pinch(d / it)) }
                        if (!moved) moved = true
                        pinch = d
                    } else if (pinch == null) {
                        val p = pressed[0].position
                        if (!moved && hypot(p.x - start.x, p.y - start.y) > 4 * density) { moved = true; onGesture(MinimapGesture.DragStart(start.x, start.y)) }
                        if (moved) onGesture(MinimapGesture.DragTo(p.x, p.y))
                    }
                    e.changes.forEach { it.consume() }
                }
                if (!moved) {
                    val now = System.currentTimeMillis()
                    if (now - lastTap < 300) { onGesture(MinimapGesture.DoubleTap); lastTap = 0L } else { lastTap = now; onGesture(MinimapGesture.Tap(start.x, start.y)) }
                } else if (pinch == null) onGesture(MinimapGesture.DragEnd)
            }
        })
}
