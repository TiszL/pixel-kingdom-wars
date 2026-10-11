package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftIcon
import kotlinx.coroutines.delay
import kotlin.math.cos
import kotlin.math.sin

/**
 * Design component: feedback (DESIGN-SYSTEM §6 Toast, Banner (herald), Celebration; §7 motion).
 *
 * - [ToastHost] draws the queue it is given (at most 3; [ToastQueue] merges and expires it, the host owns the clock).
 * - [HeraldBanner] draws the one transient top-centre banner.
 * - [Celebration] plays only for a server receipt ([CelebrationUi.receiptId] is required) and dismisses itself after 900 ms
 *   or on a tap.
 *
 * Pointer rule: none of these is full-screen or a scrim. Each draws only its own painted plate; the column a toast host
 * lays out in has no pointer handling, so empty space between toasts reaches the kingdom. The caller positions them
 * (top centre under the top bar) inside the OverlayHost.
 */
@Composable fun ToastHost(toasts: List<ToastUi>, onGo: (ToastUi) -> Unit, onReport: (ToastUi) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.widthIn(max = 396.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        toasts.takeLast(PkwTokens.Budget.MAX_TOASTS).forEach { toast ->
            key(toast.key) { Toast(toast, onGo, onReport) }
        }
    }
}

/**
 * One toast (DESIGN-SYSTEM §6 Toast, hub SPEC §3.2, toasts.png bottom): a 58 dp charcoal plate with a 32 dp icon, a VT 20
 * sentence, an optional blue GO and, on an error, the white close mark and a gold-hi underlined "Report" link. An error is
 * the blood body ([drawErrorToast]): toasts.png and hub SPEC §3.2 agree on it, so they win over kit-2.png's charcoal body
 * inside a blood shell (Rule 7; kit-2.png is flagged for cleanup). It slides 12 dp and fades in over 160 ms, and fades out
 * over the last 160 ms of its 4 s; a merge (new [ToastUi.revision]) restarts the hold.
 */
@Composable fun Toast(ui: ToastUi, onGo: (ToastUi) -> Unit, onReport: (ToastUi) -> Unit, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val shown = remember { Animatable(if (inspection) 1f else 0f) }
    val current by rememberUpdatedState(ui)
    LaunchedEffect(ui.revision) {
        shown.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TOAST_IN, easing = PkwTokens.Motion.Out))
        delay((PkwTokens.Motion.TOAST_HOLD - PkwTokens.Motion.TOAST_IN - PkwTokens.Motion.TOAST_OUT).toLong())
        shown.animateTo(0f, tween(PkwTokens.Motion.TOAST_OUT, easing = PkwTokens.Motion.In))
    }
    val error = ui.kind == ToastKind.ERROR
    Box(modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.toastH).sceneInputRegion()
        .semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite }
        .graphicsLayer {
            alpha = shown.value
            translationY = if (reduced) 0f else -PkwTokens.Motion.TOAST_SLIDE_DP * density * (1f - shown.value)
        }
        .drawBehind { if (error) drawErrorToast() else drawPlate(PlateKind.CHARCOAL) }
        .padding(plateContentPadding(PlateKind.CHARCOAL))) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (error) PkwIcon("shape:close", 24.dp, tint = PkwTokens.Colors.text) else ui.icon?.let { CraftIcon(it, 32.dp) }
            PkwText(ui.message, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.text, maxLines = 2)
            if (ui.report) ReportLink { onReport(current) }
            if (ui.go != null) GoButton({ onGo(current) }, contentDescription = ui.goLabel ?: "Go", label = ui.goLabel ?: "GO")
        }
    }
}

/** The error toast (hub SPEC §3.2 "blood body", toasts.png): the stepped M shell 3 dp in blood, then the blood face with
 *  its 3 dp lighter top band and 4 dp dark lip. No charcoal inner frame: the frame draws the face straight to the shell. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawErrorToast() {
    val w = size.width; val h = size.height
    fillStepped(0f, 0f, w, h, CornerProfiles.M, PkwTokens.Colors.blood)
    val i = 3.dp.toPx()
    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
        drawRect(ERROR_TOAST_FACE)
        band(i, w - i, i, 3.dp.toPx(), ERROR_TOAST_BAND)
        band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), ERROR_TOAST_LIP)
    }
}

/** The error toast's face, top band and lip (hub SPEC §3.2 / toasts.html: #7D2626, #A33A32, #4E1414). TOKENS.json has
 *  only the shell's `blood` (#8F2C2C), so these three are literals here. */
private val ERROR_TOAST_FACE = Color(0xFF7D2626)
private val ERROR_TOAST_BAND = Color(0xFFA33A32)
private val ERROR_TOAST_LIP = Color(0xFF4E1414)

/** The error toast's "Report" (kit-2.png): VT 18 gold-hi, underlined, a 48 dp target with no face. */
@Composable private fun ReportLink(onClick: () -> Unit) {
    Box(Modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "Report"; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
        PkwText("Report", PkwTokens.Type.small.copy(textDecoration = TextDecoration.Underline), color = PkwTokens.Colors.gold.hi)
    }
}

/**
 * The herald banner (DESIGN-SYSTEM §6 Banner, kit-2.png "BANNER", hub SPEC §3.1): 44 dp and at most 336 dp wide; an ink M
 * shell 3 dp, a 2 dp gold-lo inner rim on a dark gold face with a 3 dp lighter top band; a 30 dp icon and one VT 20 line
 * in gold-hi. Pass the banner to show or null (it fades out). A tap opens [HeraldUi.target]; a banner without a target is
 * not a button.
 */
@Composable fun HeraldBanner(ui: HeraldUi?, onOpen: (FeatureId) -> Unit, modifier: Modifier = Modifier) {
    Presence(ui, PkwTokens.Motion.TOAST_IN, PkwTokens.Motion.TOAST_OUT) { herald, progress, active, reduced ->
        val target = herald.target
        val tap = if (target != null && active) Modifier
            .clearAndSetSemantics { contentDescription = herald.text; role = Role.Button; this.onClick(label = null, action = { onOpen(target); true }) }
            .clickable(role = Role.Button) { onOpen(target) }
        else Modifier.clearAndSetSemantics { contentDescription = herald.text; liveRegion = LiveRegionMode.Polite }
        Row(modifier.widthIn(max = HERALD_MAX_W).heightIn(min = PkwTokens.Dims.bannerH).sceneInputRegion()
            .graphicsLayer {
                alpha = progress()
                translationY = if (reduced) 0f else -PkwTokens.Motion.TOAST_SLIDE_DP * density * (1f - progress())
            }
            .then(tap)
            .drawBehind {
                val w = size.width; val h = size.height
                fillStepped(0f, 0f, w, h, CornerProfiles.M, PkwTokens.Colors.ink)
                val i = 3.dp.toPx()
                insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                    drawRect(PkwTokens.Colors.gold.lo)
                    val j = i + 2.dp.toPx()
                    drawRect(HERALD_FACE, Offset(j, j), Size(w - 2 * j, h - 2 * j))
                    drawRect(HERALD_BAND, Offset(j, j), Size(w - 2 * j, 3.dp.toPx()))
                }
            }.padding(horizontal = 13.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CraftIcon(herald.icon, 30.dp)
            PkwText(herald.text, PkwTokens.Type.body, color = PkwTokens.Colors.gold.hi, maxLines = 2)
        }
    }
}

/** Hub SPEC §3.1 geometry: the herald is 336 dp wide (x 8..344), clear of the QUESTS edge button. */
private val HERALD_MAX_W = 336.dp

/** The herald's dark gold face and its top band (kit-2.png #2A2016 / #3A2B18). */
private val HERALD_FACE = Color(0xFF2A2016)
private val HERALD_BAND = Color(0xFF3A2B18)

/**
 * The receipt-gated celebration (DESIGN-SYSTEM §6 Celebration, kit-2.png "CELEBRATION"): a #1A120E panel in a 2 dp ink
 * frame with eighteen 10° gold sunrays (from a centre 45 % down) turning 8°/s, the 48 dp token, a 36 dp gold ribbon (PS 12,
 * white outlined) that drops in (160 ms, `pop`) and the VT line. Auto-dismisses after 900 ms ([onDone]) or on a tap.
 * Sparks are capped at 9 (the arch's flyer budget). Reduced motion: no turning rays, no drop, no sparks.
 */
@Composable fun Celebration(ui: CelebrationUi?, onDone: () -> Unit, modifier: Modifier = Modifier) {
    val done by rememberUpdatedState(onDone)
    Presence(ui, PkwTokens.Motion.RIBBON_DROP, PkwTokens.Motion.SEAL_OUT) { party, progress, active, reduced ->
        LaunchedEffect(party.receiptId) { delay(PkwTokens.Motion.CELEBRATE.toLong()); done() }
        val inspection = LocalInspectionMode.current
        val still = reduced || inspection
        val spin = if (still) null else rememberInfiniteTransition(label = "rays").animateFloat(0f, 360f,
            infiniteRepeatable(tween((360f / PkwTokens.Motion.RAYS_DEG_PER_S * 1000).toInt(), easing = LinearEasing), RepeatMode.Restart), label = "spin")
        val drop = remember(party.receiptId) { Animatable(if (still) 1f else 0f) }
        LaunchedEffect(party.receiptId) { drop.animateTo(1f, tween(PkwTokens.Motion.RIBBON_DROP, easing = PkwTokens.Motion.Pop)) }
        Box(modifier.widthIn(min = 200.dp, max = 300.dp).sceneInputRegion().graphicsLayer { alpha = progress() }
            .clearAndSetSemantics {
                contentDescription = "${party.ribbon}. ${party.line}"; liveRegion = LiveRegionMode.Polite; role = Role.Button
                this.onClick(label = "Dismiss", action = { if (active) done(); true })
            }
            .clickable(role = Role.Button) { if (active) done() }
            .drawBehind {
                drawRect(PkwTokens.Colors.ink)
                val i = 2.dp.toPx()
                drawRect(CELEBRATION_PANEL, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
            }.padding(2.dp)) {
            Box(Modifier.matchParentSize().clipToBounds().drawBehind { drawRays(spin?.value ?: 0f, if (still) 0 else 9, drop.value) })
            Column(Modifier.align(Alignment.Center).padding(top = 10.dp, bottom = 10.dp, start = 10.dp, end = 10.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                CraftIcon(party.icon, 48.dp)
                Box(Modifier.fillMaxWidth().heightIn(min = 36.dp).graphicsLayer { translationY = -12.dp.toPx() * (1f - drop.value) }
                    .drawBehind { drawRibbon() }.padding(PaddingValues(horizontal = 10.dp, vertical = 4.dp)), contentAlignment = Alignment.Center) {
                    PkwText(party.ribbon, PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
                }
                PkwText(party.line, PkwTokens.Type.body, color = PkwTokens.Colors.text, textAlign = TextAlign.Center, maxLines = 2)
            }
        }
    }
}

/** The ribbon's top band (3 dp, kit-2.png): gold-hi. The design frame wins over the VEIL plate's veil-hi, which read as a
 *  dark seam across the gold. */
internal val RIBBON_BAND = PkwTokens.Colors.gold.hi

/** The ribbon (kit-2.png): an ink S shell 2 dp with a gold face and the 3 dp [RIBBON_BAND] top band. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawRibbon() {
    val w = size.width; val h = size.height; val i = 2.dp.toPx()
    fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
        drawRect(PkwTokens.Colors.gold.face)
        band(i, w - i, i, 3.dp.toPx(), RIBBON_BAND)
    }
}

/** The celebration panel (kit-2.png #1A120E) and its ray colour (#F4D77B at 18 %). */
private val CELEBRATION_PANEL = Color(0xFF1A120E)
private val RAY = Color(0xFFF4D77B).copy(alpha = 0.18f)

/** The celebration's ray layer: eighteen 10° gold wedges, one every 20°, from a centre 45 % down, turned by [degrees];
 *  plus up to [sparks] (≤ 9) gold squares rising with [lift] (0..1). */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawRays(degrees: Float, sparks: Int, lift: Float) {
    val c = Offset(size.width / 2f, size.height * 0.45f)
    val r = maxOf(size.width, size.height)
    rotate(degrees, c) {
        for (k in 0 until 18) {
            val a0 = Math.toRadians((k * 20).toDouble()); val a1 = Math.toRadians((k * 20 + 10).toDouble())
            val wedge = Path().apply {
                moveTo(c.x, c.y)
                lineTo(c.x + (r * cos(a0)).toFloat(), c.y + (r * sin(a0)).toFloat())
                lineTo(c.x + (r * cos(a1)).toFloat(), c.y + (r * sin(a1)).toFloat())
                close()
            }
            drawPath(wedge, RAY)
        }
    }
    val s = 4.dp.toPx()
    for (k in 0 until sparks.coerceAtMost(9)) {
        val x = size.width * (0.12f + 0.095f * k)
        val y = size.height * (0.85f - 0.5f * lift * (0.6f + 0.05f * (k % 4)))
        drawRect(PkwTokens.Colors.gold.hi.copy(alpha = 1f - 0.6f * lift), Offset(x, y), Size(s, s))
    }
}

@Preview(name = "Feedback", widthDp = 412, heightDp = 520)
@Composable private fun FeedbackPreview() {
    Column(Modifier.background(PkwTokens.Colors.bg).padding(8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ToastHost(listOf(
            ToastUi("lodge", "Expedition back at the Lodge", "ui:lodge-menu", ToastKind.INFO, FeatureId("lodge.expedition"), "GO", false, 0L),
            ToastUi("wallet", "Wallet didn't answer. Nothing was sent.", null, ToastKind.ERROR, null, null, true, 0L),
        ), onGo = {}, onReport = {})
        HeraldBanner(HeraldUi("builder", "builder", "Builder finished: Workshop Lv 3", FeatureId("hud.builders")), onOpen = {})
        Celebration(CelebrationUi("rcpt-1", "keep", "+1,240 KEEP", "Sent to your wallet"), onDone = {})
    }
}
