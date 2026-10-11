package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.integerArtScale
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.kit.sealArmFraction
import gg.pixelkingdomwars.nativeclient.ui.kit.stateRamp
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftIcon
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Design components: the Gold Forge cluster's composed parts (design/final/goldforge/SPEC.md §2 table and §4 "New
 * parts"), built only from kit primitives: the cluster primary [ForgePrimary] (60 dp, or the 72 dp CLAIM), the dark
 * [DarkWell] with stepped sunrays, [StepRow] / [StepChip], [RaidDayPips], [CalloutRow], [GoRow], [PayGet], [StepDots],
 * [WalletGlyph], [ConsentRow], [EstimateCard], [AmountStepper] buttons with hold-to-repeat, the tap / hold target, and
 * the Seal shell [ForgeSeal] with its [ArmingButton].
 *
 * Pointer rule: every part here is either paint only or a painted ≥ 48 dp button that registers itself as a
 * scene-input region; [ForgeSeal] alone is full-screen, and only while a seal is shown (its scrim tap cancels, never
 * confirms).
 */

/** The cluster's literal colours (SPEC §2 / §4; not in TOKENS.json, so kept here once). */
object GoldForgeColors {
    /** Dark well / off-scene fill. */
    val wellFace = Color(0xFF1A120E)
    val wellFrame = Color(0xFF3D2A1C)
    val wellLip = Color(0xFF0F0A08)
    /** Sunray wedge, rgba(244,215,123,.16). */
    val ray = Color(0x29F4D77B)
    /** EstimateCard dashes, StepDots connectors. */
    val dash = Color(0xFFC4A464)
    val stepDone = Color(0xFFE3ECD0)
    val stepTodo = Color(0xFFEBDCB4)
    val pipOff = Color(0xFFCDB98A)
    /** The basket's "+1,800" on the load label. */
    val basketGreen = Color(0xFF2A6A1C)
    /** "500 GEMS" on the dark well. */
    val gemText = Color(0xFFA9F0C8)
    /** Speed-up subject well (grass). */
    val grassFace = Color(0xFF3F6A35)
    val grassFrame = Color(0xFF2C4A25)
    /** The Gems readout tint while short (SPEC §6b). */
    val shortReadout = Color(0xFFFFB3A0)
}

/** The cold look (SPEC §4 MintTray cold): 85 % grayscale, [brightness] of the light. */
internal fun coldFilter(brightness: Float = 0.5f, grayscale: Float = 0.85f): ColorFilter {
    val m = ColorMatrix().apply { setToSaturation(1f - grayscale) }
    val b = brightness
    m.timesAssign(ColorMatrix(floatArrayOf(b, 0f, 0f, 0f, 0f, 0f, b, 0f, 0f, 0f, 0f, 0f, b, 0f, 0f, 0f, 0f, 0f, 1f, 0f)))
    return ColorFilter.colorMatrix(m)
}

/**
 * `gf:` art: the copies this cluster added (`pkw_ui_gf_*`, see ASSET-COPIES-goldforge.md) and existing drawables the kit
 * names do not reach (gem 48 / 64, the exact KEEP token, the Forge Ingot). Null for any other name.
 */
internal fun goldForgeDrawable(name: String): Int? = when (name.removePrefix("gf:")) {
    "coin_tray" -> R.drawable.pkw_ui_gf_coin_tray_64
    "coin" -> R.drawable.pkw_ui_gf_coin_16
    "keep_24" -> R.drawable.pkw_ui_keep_24
    "keep_48" -> R.drawable.pkw_ui_keep_48
    "gem_24" -> R.drawable.gem_24
    "gem_48" -> R.drawable.gem_48
    "gem_64" -> R.drawable.gem_64
    "forge_ingot" -> R.drawable.pkw_ui_inv_forge_ingot
    else -> null
}

/**
 * The cluster icon: `gf:<name>` ([goldForgeDrawable]) at a whole number of device px per art px with nearest sampling and
 * an optional [colorFilter] (the cold tray, the grey FurnaceLine token); every other name goes to the craft cluster's
 * [CraftIcon] (`craft:` copies) and from there to the kit's PkwIcon / GameArt.
 */
@Composable internal fun GfIcon(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null,
    alpha: Float = 1f, tint: Color = PkwTokens.Colors.text, colorFilter: ColorFilter? = null) {
    val id = if (name.startsWith("gf:")) goldForgeDrawable(name) else null
    if (id == null) {
        CraftIcon(if (name.startsWith("gf:")) "shape:unknown" else name, size, modifier, contentDescription, alpha, tint)
        return
    }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(id)
    val described = if (contentDescription == null) Modifier.clearAndSetSemantics { } else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) {
        val k = minOf(integerArtScale(this.size.width, bitmap.width), integerArtScale(this.size.height, bitmap.height))
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
            dstOffset = IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - h) / 2f).roundToInt()),
            dstSize = IntSize(w, h), alpha = alpha, colorFilter = colorFilter, filterQuality = FilterQuality.None)
    }
}

/**
 * A tab's one primary ([ForgePrimaryLook]): the chunky face (gold, red FIND A RAID, blue GET GEMS, stone busy / checking,
 * moss SENT, charcoal locked with its padlock and gold-hi line, off with the reason under it). 60 dp, or [height] 72
 * for CLAIM. Every state but BUSY calls [onClick]; the caller routes by [ForgePrimaryLook.action].
 */
@Composable internal fun ForgePrimary(look: ForgePrimaryLook, onClick: () -> Unit, modifier: Modifier = Modifier,
    height: Dp = PkwTokens.Dims.sheetPrimaryH) {
    val c = PkwTokens.Colors
    val showReason = look.reason != null && (look.state == CommandState.DISABLED || look.state == CommandState.LOCKED)
    val spoken = listOfNotNull(look.label, look.sub, look.reason?.takeIf { showReason }).joinToString(". ")
    val big = height > PkwTokens.Dims.sheetPrimaryH
    val gold = look.verb == Verb.GOLD && look.state == CommandState.ENABLED
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        ChunkyBox(stateRamp(look.verb, look.state), onClick, spoken, Modifier.fillMaxWidth().heightIn(min = height),
            enabled = look.state != CommandState.BUSY) {
            Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    look.state == CommandState.BUSY -> BusyDots()
                    look.state == CommandState.LOCKED -> PkwIcon("shape:lock", 32.dp, tint = c.gold.face)
                    look.icon != null -> GfIcon(look.icon, 24.dp, tint = c.label)
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    if (look.sentence || look.state == CommandState.BUSY) PkwText(look.label, PkwTokens.Type.body, color = c.text)
                    else PkwText(look.label, if (big) PkwTokens.Type.numeralL else PkwTokens.Type.primary,
                        color = if (look.state == CommandState.DISABLED) c.text else c.label, outline = 2.dp)
                    look.sub?.let {
                        PkwText(it, if (big) PkwTokens.Type.body else PkwTokens.Type.small, color = when {
                            look.subAccent -> c.gold.hi
                            gold -> c.textOnParch
                            else -> c.text
                        })
                    }
                }
            }
        }
        if (showReason) PkwText(look.reason!!, PkwTokens.Type.small, Modifier.padding(top = 3.dp), color = c.textOnParch2,
            textAlign = TextAlign.Center, maxLines = 2)
    }
}

/**
 * The dark well (SPEC §2 ClaimWell / §4 MintTray, §5a pay → get): ink M shell 3 dp, `#1A120E` face, `#3D2A1C` 2 dp frame,
 * `#0F0A08` 4 dp lip, static sunray wedges at [rays] strength (1 = 16 % gold, 0 = none) and an optional warm [glow].
 * Paint only.
 */
@Composable internal fun DarkWell(modifier: Modifier = Modifier, rays: Float = 1f, glow: Boolean = false,
    rayCenter: Float = 0.42f, content: @Composable BoxScope.() -> Unit) {
    val g = GoldForgeColors
    // The wedges, glow and ray colour are built once per size (drawWithCache), never on each draw.
    Box(modifier.drawWithCache {
        val w = size.width; val h = size.height
        val center = Offset(w / 2f, h * rayCenter)
        val glowBrush = if (glow) Brush.radialGradient(listOf(Color(0x55F4B94A), Color.Transparent), center, radius = minOf(w, h) * 0.55f) else null
        val rayColor = g.ray.copy(alpha = g.ray.alpha * rays.coerceIn(0f, 1f))
        val wedges = if (rays > 0f) Path().apply {
            val r = w + h
            for (k in 0 until 18) {
                val a0 = Math.toRadians(k * 20.0); val a1 = Math.toRadians(k * 20.0 + 10.0)
                moveTo(center.x, center.y)
                lineTo(center.x + (r * cos(a0)).toFloat(), center.y + (r * sin(a0)).toFloat())
                lineTo(center.x + (r * cos(a1)).toFloat(), center.y + (r * sin(a1)).toFloat())
                close()
            }
        } else null
        onDrawBehind {
            fillStepped(0f, 0f, w, h, CornerProfiles.M, PkwTokens.Colors.ink)
            val i = 3.dp.toPx()
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                drawRect(g.wellFace)
                if (glowBrush != null) drawRect(glowBrush)
                if (wedges != null) drawPath(wedges, rayColor)
                val f = 2.dp.toPx()
                drawRect(g.wellFrame, Offset(i, i), Size(w - 2 * i, f))
                drawRect(g.wellFrame, Offset(i, i), Size(f, h - 2 * i))
                drawRect(g.wellFrame, Offset(w - i - f, i), Size(f, h - 2 * i))
                band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), g.wellLip)
            }
        }
    }.padding(start = 8.dp, top = 8.dp, end = 8.dp, bottom = 10.dp), content = content)
}

/** A numbered medallion (SPEC §2 NumMedallion): moss + check when done, gold when now, stone when todo. */
@Composable internal fun NumMedallion(n: Int, state: StepState, size: Dp = 24.dp) {
    val ramp = when (state) {
        StepState.DONE -> PkwTokens.Colors.moss
        StepState.NOW -> PkwTokens.Colors.gold
        StepState.TODO -> PkwTokens.Colors.stone
    }
    Box(Modifier.size(size).drawBehind {
        fillStepped(0f, 0f, this.size.width, this.size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        insideStepped(i, i, this.size.width - i, this.size.height - i, CornerProfiles.S) {
            drawRect(ramp.face)
            band(i, this.size.width - i, i, 2.dp.toPx(), ramp.hi)
        }
    }, contentAlignment = Alignment.Center) {
        if (state == StepState.DONE) PkwIcon("shape:check", size - 8.dp, tint = PkwTokens.Colors.label)
        else PkwText(n.toString(), PkwTokens.Type.small, color = if (state == StepState.NOW) PkwTokens.Colors.ink else PkwTokens.Colors.label)
    }
}

/** The three-step row (SPEC §2 StepRow): Basket · Raid · Coins, 54 dp chips 4 dp apart. Paint only, read as one line each. */
@Composable internal fun StepRow(steps: List<StepUi>, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        steps.take(3).forEachIndexed { i, step -> StepChip(i + 1, step, Modifier.weight(1f)) }
    }
}

/** One StepChip: ink S shell 2 dp, done `#E3ECD0` / now `#FFF3C8` + 3 dp gold rim / todo `#EBDCB4`, medallion + 2 VT lines. */
@Composable internal fun StepChip(n: Int, step: StepUi, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val face = when (step.state) { StepState.DONE -> GoldForgeColors.stepDone; StepState.NOW -> c.selectedTint; StepState.TODO -> GoldForgeColors.stepTodo }
    val spoken = "Step $n, ${step.title}, ${step.small}, " + when (step.state) { StepState.DONE -> "done"; StepState.NOW -> "now"; StepState.TODO -> "to do" }
    Row(modifier.heightIn(min = 54.dp).clearAndSetSemantics { contentDescription = spoken }.drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(face)
            if (step.state == StepState.NOW) {
                val r = 3.dp.toPx()
                drawRect(c.gold.face, Offset(i, i), Size(w - 2 * i, r)); drawRect(c.gold.face, Offset(i, h - i - r), Size(w - 2 * i, r))
                drawRect(c.gold.face, Offset(i, i), Size(r, h - 2 * i)); drawRect(c.gold.face, Offset(w - i - r, i), Size(r, h - 2 * i))
            }
        }
    }.padding(horizontal = 7.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        NumMedallion(n, step.state)
        Column {
            PkwText(step.title, PkwTokens.Type.small, color = c.textOnParch)
            PkwText(step.small, PkwTokens.Type.small, color = if (step.state == StepState.TODO) c.textOnParch2 else c.textOnParch)
        }
    }
}

/**
 * The raid-day pips (SPEC §2 RaidDayPips): "Raid days", one 16 dp square per day of the window (red = counted, sand =
 * not, gold rim = today), and "+8% more coins" on the right. With no server counts it reads "Raid on more days for a
 * bigger share" and draws no pips (SPEC §3a.5).
 */
@Composable internal fun RaidDayPips(ui: RaidDaysUi?, modifier: Modifier = Modifier, todayRim: Boolean = false) {
    val c = PkwTokens.Colors
    if (ui == null) {
        PkwText("Raid on more days for a bigger share", PkwTokens.Type.small, modifier, color = c.textOnParch2)
        return
    }
    val counted = ui.days.count { it }
    val spoken = "Raid days: $counted of ${ui.days.size} counted" + (ui.bonus?.let { ", $it more coins" } ?: "")
    Row(modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = spoken }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwText("Raid days", PkwTokens.Type.body, color = c.textOnParch)
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            ui.days.forEachIndexed { i, on ->
                val today = todayRim && i == ui.todayIndex
                Box(Modifier.size(16.dp).drawBehind {
                    fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, c.ink)
                    val k = 2.dp.toPx()
                    fillStepped(k, k, size.width - k, size.height - k, CornerProfiles.S, if (today) c.gold.face else if (on) c.red.face else GoldForgeColors.pipOff)
                    if (today) {
                        val r = 3.dp.toPx() + k
                        fillStepped(r, r, size.width - r, size.height - r, CornerProfiles.S, if (on) c.red.face else GoldForgeColors.pipOff)
                    }
                })
            }
        }
        Spacer(Modifier.weight(1f))
        ui.bonus?.let {
            PkwText(it, PkwTokens.Type.caption, color = c.textOnParch)
            PkwText("more coins", PkwTokens.Type.small, color = c.textOnParch2)
        }
    }
}

/**
 * A callout (SPEC §2 CalloutRow): `#FFF3C8` (or [tint]) + 2 dp ink, a 36 dp icon and two VT lines. With [go] a blue GO
 * sits on the right; with [onTap] the whole row is one ≥ 48 dp target (the settlement callout dismisses on tap).
 */
@Composable internal fun CalloutRow(icon: String?, title: String, sub: String?, modifier: Modifier = Modifier,
    tint: Color = PkwTokens.Colors.selectedTint, onTap: (() -> Unit)? = null, go: (() -> Unit)? = null, goDescription: String = "Go") {
    val c = PkwTokens.Colors
    val spoken = listOfNotNull(title, sub).joinToString(". ")
    val tap = if (onTap == null) Modifier.semantics(mergeDescendants = true) { contentDescription = spoken }
    else Modifier.sceneInputRegion().clearAndSetSemantics { contentDescription = "$spoken. Tap to dismiss"; role = Role.Button
        this.onClick(label = "Dismiss") { onTap(); true } }
        .pointerInput(onTap) { detectTapGestures(onTap = { onTap() }) }
    Row(modifier.fillMaxWidth().heightIn(min = 52.dp).drawBehind {
        drawRect(c.ink)
        val i = 2.dp.toPx()
        drawRect(tint, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
    }.then(tap).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (icon != null) GfIcon(icon, 36.dp)
        Column(Modifier.weight(1f)) {
            PkwText(title, PkwTokens.Type.body, color = c.textOnParch, maxLines = 2)
            if (sub != null) PkwText(sub, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
        }
        if (go != null) GoButton(go, goDescription, Modifier.width(64.dp))
    }
}

/** A cream row with a blue GO (SPEC §2 GoRow): 32 dp authored icon, VT title + sub, GO 64 × 48 (the only target). */
@Composable internal fun GoRow(icon: String, title: String, sub: String?, onGo: () -> Unit, goDescription: String, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).drawBehind {
        drawRect(c.ink)
        val i = 2.dp.toPx()
        drawRect(c.cream, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
    }.padding(start = 10.dp, end = 6.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        GfIcon(icon, 32.dp)
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }) {
            PkwText(title, PkwTokens.Type.body, color = c.textOnParch)
            if (sub != null) PkwText(sub, PkwTokens.Type.small, color = c.textOnParch2)
        }
        GoButton(onGo, goDescription, Modifier.width(64.dp))
    }
}

/** Pay → get (SPEC §2 PayGet): two columns at least 96 dp each and the ink step arrow between. Paint only. */
@Composable internal fun PayGet(left: @Composable ColumnScope.() -> Unit, right: @Composable ColumnScope.() -> Unit,
    modifier: Modifier = Modifier, arrow: Color = PkwTokens.Colors.textOnParch) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
        Column(Modifier.widthIn(min = 96.dp).weight(1f), horizontalAlignment = Alignment.CenterHorizontally, content = left)
        PkwIcon("shape:go", 24.dp, tint = arrow)
        Column(Modifier.widthIn(min = 96.dp).weight(1f), horizontalAlignment = Alignment.CenterHorizontally, content = right)
    }
}

/** The wallet step dots (SPEC §2 StepDots): Confirm · Wallet · Sent; [current] 0..2 is "now", earlier are done. */
@Composable internal fun StepDots(current: Int, modifier: Modifier = Modifier) {
    val labels = listOf("Confirm", "Wallet", "Sent")
    val spoken = "Step ${current + 1} of 3: ${labels[current.coerceIn(0, 2)]}"
    Row(modifier.clearAndSetSemantics { contentDescription = spoken }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        labels.forEachIndexed { i, label ->
            if (i > 0) Box(Modifier.width(18.dp).height(3.dp).background(GoldForgeColors.dash))
            NumMedallion(i + 1, when { i < current -> StepState.DONE; i == current -> StepState.NOW; else -> StepState.TODO }, 22.dp)
            PkwText(label, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch)
        }
    }
}

/** The drawn wallet (SPEC §2 WalletGlyph; no authored wallet art exists): ink S shell, wood face, gold clasp 18 × 14. */
@Composable internal fun WalletGlyph(modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Canvas(modifier.size(48.dp, 40.dp).clearAndSetSemantics { }) {
        val w = size.width; val h = size.height; val i = 3.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(c.woodHi)
            band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), c.wood)
        }
        val cw = 18.dp.toPx(); val ch = 14.dp.toPx()
        val cx = w - cw; val cy = (h - ch) / 2f
        drawRect(c.ink, Offset(cx - 2.dp.toPx(), cy - 2.dp.toPx()), Size(cw + 2.dp.toPx(), ch + 4.dp.toPx()))
        drawRect(c.gold.face, Offset(cx, cy), Size(cw - 2.dp.toPx(), ch))
        drawRect(c.gold.hi, Offset(cx, cy), Size(cw - 2.dp.toPx(), 2.dp.toPx()))
    }
}

/** The drawn 12 × 20 chevron of the DestinationRow (decorative). */
@Composable internal fun Chevron(modifier: Modifier = Modifier, color: Color = PkwTokens.Colors.textOnParch) {
    Canvas(modifier.size(12.dp, 20.dp).clearAndSetSemantics { }) {
        val s = 3.dp.toPx()
        val path = Path().apply { moveTo(0f, 0f); lineTo(size.width, size.height / 2f); lineTo(0f, size.height) }
        drawPath(path, color, style = Stroke(width = s))
    }
}

/**
 * The consent row (SPEC §3b): 48 dp, `#FFF3C8`, 2 dp ink, a 28 dp drawn check box and the VT line. The whole row is one
 * toggle target (Role.Checkbox). It gates the Seal's arming.
 */
@Composable internal fun ConsentRow(checked: Boolean, text: String, onToggle: (Boolean) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = PkwTokens.Colors
    val toggle by rememberUpdatedState(onToggle)
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = text; role = Role.Checkbox
            toggleableState = if (checked) ToggleableState.On else ToggleableState.Off
            stateDescription = if (checked) "Checked" else "Not checked"
            if (!enabled) disabled()
            this.onClick(label = null) { if (enabled) toggle(!checked); enabled }
        }
        .pointerInput(enabled, checked) { if (enabled) detectTapGestures(onTap = { toggle(!checked) }) }
        .drawBehind {
            drawRect(c.ink)
            val i = 2.dp.toPx()
            drawRect(c.selectedTint, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        }.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(28.dp).drawBehind {
            drawRect(c.ink)
            val i = 3.dp.toPx()
            drawRect(if (checked) c.green.face else c.cream, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        }, contentAlignment = Alignment.Center) {
            if (checked) PkwIcon("shape:check", 20.dp, tint = c.label)
        }
        PkwText(text, PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch, maxLines = 2)
    }
}

/** The dashed estimate card (SPEC §2 EstimateCard): 3 dp dashed `#C4A464`, no fill, three VT/PS lines. Paint only. */
@Composable internal fun EstimateCard(estimate: String?, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Column(modifier.heightIn(min = 80.dp).semantics(mergeDescendants = true) { }.drawBehind {
        val s = 3.dp.toPx()
        drawRect(GoldForgeColors.dash, Offset(s / 2, s / 2), Size(size.width - s, size.height - s),
            style = Stroke(width = s, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))))
    }.padding(horizontal = 10.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (estimate == null) {
            PkwText("Your share is set at payout", PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
        } else {
            PkwText("may mint for you", PkwTokens.Type.small, color = c.textOnParch2)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                GfIcon("gf:keep_24", 24.dp)
                PkwText("about $estimate", PkwTokens.Type.title, color = c.textOnParch)
            }
            PkwText("estimate, not yours yet", PkwTokens.Type.small, color = c.textOnParch2)
        }
    }
}

/** The footnote under a pinned primary: VT 18 secondary, centred, up to 2 lines. */
@Composable internal fun ForgeFootnote(text: String, modifier: Modifier = Modifier) {
    PkwText(text, PkwTokens.Type.small, modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
}

/** A section heading row: PS label on the left, an optional VT note on the right. */
@Composable internal fun SectionRow(title: String, modifier: Modifier = Modifier, right: String? = null, tag: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(title, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
        tag?.invoke()
        Spacer(Modifier.weight(1f))
        if (right != null) PkwText(right, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

/** An empty state with cluster art (DESIGN-SYSTEM §6 EmptyState; the kit one draws kit icons only): 64 dp art at 40 %,
 *  VT 20 headline, VT 18 reason, an optional blue GO TO. */
@Composable internal fun ForgeEmpty(icon: String, headline: String, reason: String?, modifier: Modifier = Modifier,
    goLabel: String? = null, onGo: (() -> Unit)? = null) {
    val c = PkwTokens.Colors
    Column(modifier.fillMaxWidth().padding(vertical = 12.dp, horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        GfIcon(icon, 64.dp, alpha = 0.4f)
        PkwText(headline, PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
        if (reason != null) PkwText(reason, PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 3)
        if (goLabel != null && onGo != null) gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton(goLabel, onGo, Modifier.fillMaxWidth(), verb = Verb.BLUE)
    }
}

/**
 * A chunky button that steps once on press and then repeats every 120 ms after 400 ms while held (SPEC §2
 * AmountStepper). Its own ≥ 48 dp target; a screen reader's click steps once.
 */
@Composable internal fun RepeatSquare(icon: String, contentDescription: String, onStep: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true) {
    val step by rememberUpdatedState(onStep)
    var pressed by remember { mutableStateOf(false) }
    val ramp = PkwTokens.ramp(if (enabled) Verb.STONE else Verb.OFF)
    Box(modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics {
            this.contentDescription = contentDescription; role = Role.Button
            if (!enabled) disabled()
            this.onClick(label = null) { if (enabled) step(); enabled }
        }
        .pointerInput(enabled) {
            if (!enabled) return@pointerInput
            coroutineScope {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    pressed = true
                    val repeat = launch {
                        step()
                        delay(STEP_REPEAT_AFTER_MS)
                        while (true) { step(); delay(STEP_REPEAT_EVERY_MS) }
                    }
                    waitForUpOrCancellation()
                    repeat.cancel()
                    pressed = false
                }
            }
        }
        .drawBehind { drawChunky(ramp, if (pressed) 1f else 0f) }, contentAlignment = Alignment.Center) {
        Box(Modifier.padding(bottom = 6.dp)) { PkwIcon(icon, 24.dp, tint = PkwTokens.Colors.label) }
    }
}

/** SPEC §2 AmountStepper: long-press repeats after 400 ms, every 120 ms. */
private const val STEP_REPEAT_AFTER_MS = 400L
private const val STEP_REPEAT_EVERY_MS = 120L

/**
 * A tap / hold target (SMELT tiles and their "− 1": tap = one step, hold = fill / remove the line). Its own ≥ 48 dp
 * target with a click and a long-click action for screen readers. [content] gets the pressed flag for its face.
 */
@Composable internal fun HoldBox(contentDescription: String, onTap: () -> Unit, onHold: (() -> Unit)?, modifier: Modifier = Modifier,
    enabled: Boolean = true, holdLabel: String? = null, content: @Composable BoxScope.(pressed: Boolean) -> Unit) {
    var pressed by remember { mutableStateOf(false) }
    val tap by rememberUpdatedState(onTap)
    val hold by rememberUpdatedState(onHold)
    Box(modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics {
            this.contentDescription = contentDescription; role = Role.Button
            if (!enabled) disabled()
            this.onClick(label = null) { if (enabled) tap(); enabled }
            if (enabled && onHold != null) onLongClick(label = holdLabel) { hold?.invoke(); true }
        }
        .pointerInput(enabled, onHold != null) {
            if (!enabled) return@pointerInput
            detectTapGestures(
                onPress = { pressed = true; tryAwaitRelease(); pressed = false },
                onLongPress = if (onHold == null) null else { _ -> hold?.invoke() },
                onTap = { tap() },
            )
        }, contentAlignment = Alignment.Center) { content(pressed) }
}

/**
 * The Seal's gold primary with its arming bar (SPEC §2 Seal: 4 dp ink bar on a 30 % ink track, 10 dp above the face
 * bottom). [armStartMs] null = not armable yet (the SMELT consent is unchecked): off face, taps ignored. Taps before
 * [sealAccepts] are ignored, never queued. [armMs] 0 = no arming (a server-zero "FREE" spend).
 */
@Composable internal fun ArmingButton(label: String, armStartMs: Long?, active: Boolean, onConfirm: () -> Unit, clock: () -> Long,
    modifier: Modifier = Modifier, verb: Verb = Verb.GOLD, armMs: Int = PkwTokens.Motion.SEAL_ARM) {
    val arm = remember(armStartMs, armMs) { Animatable(if (armStartMs == null) 0f else if (armMs <= 0) 1f else sealArmFraction(clock(), armStartMs, armMs)) }
    LaunchedEffect(armStartMs, armMs) {
        if (armStartMs != null && armMs > 0) {
            val remaining = ((1f - arm.value) * armMs).toInt()
            if (remaining > 0) arm.animateTo(1f, tween(remaining, easing = PkwTokens.Motion.Linear))
        }
    }
    val enabled = active && armStartMs != null
    val confirm by rememberUpdatedState(onConfirm)
    ChunkyBox(PkwTokens.ramp(if (armStartMs == null) Verb.OFF else verb),
        { if (enabled && sealAccepts(clock(), armStartMs!!, armMs)) confirm() }, label,
        modifier.heightIn(min = PkwTokens.Dims.sheetPrimaryH).drawWithContent {
            drawContent()
            val a = arm.value
            if (armStartMs != null && a < 1f) {
                val inset = 8.dp.toPx(); val h = 4.dp.toPx(); val y = size.height - 14.dp.toPx()
                drawRect(PkwTokens.Colors.ink.copy(alpha = 0.30f), Offset(inset, y), Size(size.width - 2 * inset, h))
                drawRect(PkwTokens.Colors.ink, Offset(inset, y), Size((size.width - 2 * inset) * a, h))
            }
        }, enabled = enabled) {
        PkwText(label, PkwTokens.Type.primary, color = if (armStartMs == null) PkwTokens.Colors.text else PkwTokens.Colors.label, outline = 2.dp)
    }
}

/**
 * The cluster Seal shell (SPEC §2 Seal; DESIGN-SYSTEM §6 ConfirmDialog): wood frame on parchment, 20 dp from the screen
 * sides, centred, over the 55 % scrim; PS title, then [content]. Enter 160 ms scale 0.96 → 1 + fade, exit 120 ms.
 *
 * Pointer rule: pass the seal to show, or null. With null (and after its exit) nothing is composed, so touches reach the
 * kingdom; while shown its root is full-screen and its scrim tap calls [onScrimTap] (BACK, never confirm; the caller
 * ignores it while the wallet or server is working). Keep composing the same call with null through the exit:
 * [onExitFinished] then fires once. Back is the OverlayHost's (cancel, never confirm).
 */
@Composable internal fun <T : Any> ForgeSeal(value: T?, title: (T) -> String, onScrimTap: (T) -> Unit, modifier: Modifier = Modifier,
    onExitFinished: () -> Unit = {}, content: @Composable ColumnScope.(seal: T, active: Boolean) -> Unit) {
    Presence(value, PkwTokens.Motion.SEAL_IN, PkwTokens.Motion.SEAL_OUT, onGone = onExitFinished) { seal, progress, active, reduced ->
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = { if (active) onScrimTap(seal) })
            Plate(PlateKind.WOOD, Modifier.padding(horizontal = 20.dp).widthIn(max = 400.dp).fillMaxWidth()
                .semantics { paneTitle = title(seal); liveRegion = LiveRegionMode.Assertive }
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        PkwText(title(seal), PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                        content(seal, active)
                    }
                }
            }
        }
    }
}

/** A token + amount column for a Seal's pay or get side: 48 dp art, PS 13 amount, VT 18 caption. */
@Composable internal fun SealSide(icon: String, amount: String, caption: String?, amountColor: Color = PkwTokens.Colors.textOnParch,
    iconSize: Dp = 48.dp) {
    GfIcon(icon, iconSize)
    PkwText(amount, PkwTokens.Type.title, color = amountColor, textAlign = TextAlign.Center)
    if (caption != null) PkwText(caption, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
}

@Preview(name = "Gold Forge parts", widthDp = 398, heightDp = 640)
@Composable private fun GoldForgePartsPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        StepRow(GoldForgeSamples.stepsChoosing)
        RaidDayPips(GoldForgeSamples.raidDays)
        RaidDayPips(null)
        CalloutRow("attack", "Win one raid before midnight", "or the basket comes back unused")
        GoRow("gf:forge_ingot", "Smelt today", "more coins for you", {}, "Go to SMELT")
        StepDots(1)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            WalletGlyph(); Chevron(); NumMedallion(1, StepState.DONE); NumMedallion(2, StepState.NOW); NumMedallion(3, StepState.TODO)
        }
        ConsentRow(true, "Yes, melt it if it mints coins", {})
        EstimateCard("42", Modifier.width(200.dp))
        DarkWell(Modifier.fillMaxWidth().height(80.dp), glow = true) { PkwText("dark well", PkwTokens.Type.body, Modifier.align(Alignment.Center)) }
        ForgePrimary(ForgePrimaryLook("CLAIM", Verb.CHARCOAL, CommandState.LOCKED, ForgeAction.EXPLAIN_LOCK, sub = "opens Wed 14 Oct", subAccent = true), {})
    }
}
