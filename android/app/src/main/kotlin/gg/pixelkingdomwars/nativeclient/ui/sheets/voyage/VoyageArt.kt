package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import android.os.Build
import androidx.compose.animation.animateColorAsState
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.CompositingStrategy
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.integerArtScale
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt
import kotlin.random.Random

/*
 * Design component: the voyage cluster's art and shared parts (SPEC §0.3 `sea` token, §0.4 pixel scale, §0.2 sheet
 * skeleton): the sea wells and wave marks route and vehicle art sit on, the integer-scale sprite window, the route-art
 * source the data side plugs in, and the small rows, labels, chips and meters every Lodge / Berth panel repeats.
 *
 * Missing kit parts added here (the kit is committed and not edited): the `sea` colour family (SPEC §0.3, needs the
 * owner's OK to enter TOKENS.json), a resolver for the voyage art copied into res/drawable-nodpi (the kit's PkwIcon
 * whitelist does not know it), a cropped-window sprite, a selectable choice chip, a back square and a dashed frame.
 *
 * Pointer rule: every part here is a painted piece inside a sheet; only the chips, rows with an onClick and the back square
 * take touches, each with a ≥ 48 dp target and a screen-reader label. Nothing here is full-screen.
 */

/** SPEC §0.3: the one token this cluster adds. Wells and headers that host route or vehicle art only. */
object VoyageColors {
    val sea = Color(0xFF1C3850)
    /** Header sea; equals the glasswake card background. */
    val seaHdr = Color(0xFF21405A)
    /** Wave marks. */
    val seaHi = Color(0xFF2A5272)
    /** A well's bottom band. */
    val seaLo = Color(0xFF12263A)
    /** The 4 dp coast band. */
    val sand = Color(0xFFD9C48A)
    /** The shore stand-in's grass until the scene crop is plugged in. */
    val grass = Color(0xFF4E7A35)
    /** A READY trip row's body (SPEC §5a item 4). */
    val readyBody = Color(0xFFEEF6D8)
    /** An empty berth's grey well (trips.html / berth-fleet.html `#4a4152`). */
    val emptyWell = Color(0xFF4A4152)
    /** An empty-berth row's body (trips.html `#efe4c4`): quieter than the cream of a row that can act. */
    val emptyRow = Color(0xFFEFE4C4)
    /** A dimmed vehicle card's body (send.html / berth-fleet.html `.vc.dim` `#e7dcc0`). */
    val dimCard = Color(0xFFE7DCC0)
    /** The reward card's resource well (send.html `#f6dfa1`). */
    val rewardWell = Color(0xFFF6DFA1)
}

/** Locked island tiles: 85 % grey, 45 % brightness (SPEC §4). */
val LOCKED_TILE_DIM: FloatArray = dimMatrix(0.85f, 0.45f)
/** Empty quay slots and family teasers: 70 % grey, 55 % brightness (SPEC §7, §10). */
val EMPTY_SLOT_DIM: FloatArray = dimMatrix(0.70f, 0.55f)
/** A dimmed SEND vehicle card's sprite (send.html `.vc.dim .well img`: grayscale 1, brightness .55). */
val DIM_CARD_SPRITE: FloatArray = dimMatrix(1f, 0.55f)
/** The empty-berth row's sprite on TRIPS (trips.html: grayscale 1, brightness .6). */
val EMPTY_ROW_SPRITE: FloatArray = dimMatrix(1f, 0.6f)

/** The `voyage:` art name of a vehicle's idle sprite; an unknown tier falls back to T1 (same silhouette). */
fun vehicleIdleArt(family: VehicleFamily, tier: Int?): String = when (family) {
    VehicleFamily.STARTER -> "voyage:veh-starter"
    else -> "voyage:veh-${family.name.lowercase().replace('_', '-')}-t${(tier ?: 1).coerceIn(1, 4)}"
}

/** The `voyage:` art name of a family's intact berth. */
fun berthArt(family: VehicleFamily): String = "voyage:berth-${family.name.lowercase().replace('_', '-')}"

/**
 * The drawables copied for this cluster (ASSET-COPIES-voyage.md), by `voyage:` name: vehicle idles (112 px), intact
 * berths (112 px), the eight realm raw resources and four items (64 px). Null for any other name.
 */
fun voyageDrawable(name: String): Int? = when (name.removePrefix("voyage:")) {
    "veh-starter" -> R.drawable.pkw_ui_veh_starter_idle
    "veh-survey-balloon-t1" -> R.drawable.pkw_ui_veh_survey_balloon_t1_idle
    "veh-survey-balloon-t2" -> R.drawable.pkw_ui_veh_survey_balloon_t2_idle
    "veh-survey-balloon-t3" -> R.drawable.pkw_ui_veh_survey_balloon_t3_idle
    "veh-survey-balloon-t4" -> R.drawable.pkw_ui_veh_survey_balloon_t4_idle
    "veh-cargo-cutter-t1" -> R.drawable.pkw_ui_veh_cargo_cutter_t1_idle
    "veh-cargo-cutter-t2" -> R.drawable.pkw_ui_veh_cargo_cutter_t2_idle
    "veh-cargo-cutter-t3" -> R.drawable.pkw_ui_veh_cargo_cutter_t3_idle
    "veh-cargo-cutter-t4" -> R.drawable.pkw_ui_veh_cargo_cutter_t4_idle
    "veh-courier-airship-t1" -> R.drawable.pkw_ui_veh_courier_airship_t1_idle
    "veh-courier-airship-t2" -> R.drawable.pkw_ui_veh_courier_airship_t2_idle
    "veh-courier-airship-t3" -> R.drawable.pkw_ui_veh_courier_airship_t3_idle
    "veh-courier-airship-t4" -> R.drawable.pkw_ui_veh_courier_airship_t4_idle
    "veh-expedition-barge-t1" -> R.drawable.pkw_ui_veh_expedition_barge_t1_idle
    "veh-expedition-barge-t2" -> R.drawable.pkw_ui_veh_expedition_barge_t2_idle
    "veh-expedition-barge-t3" -> R.drawable.pkw_ui_veh_expedition_barge_t3_idle
    "veh-expedition-barge-t4" -> R.drawable.pkw_ui_veh_expedition_barge_t4_idle
    "berth-starter" -> R.drawable.pkw_ui_berth_starter_intact
    "berth-survey-balloon" -> R.drawable.pkw_ui_berth_survey_balloon_intact
    "berth-cargo-cutter" -> R.drawable.pkw_ui_berth_cargo_cutter_intact
    "berth-courier-airship" -> R.drawable.pkw_ui_berth_courier_airship_intact
    "berth-expedition-barge" -> R.drawable.pkw_ui_berth_expedition_barge_intact
    "heartwood-logs" -> R.drawable.pkw_ui_inv_heartwood_logs
    "ember-nodules" -> R.drawable.pkw_ui_inv_ember_nodules
    "frost-quartz" -> R.drawable.pkw_ui_inv_frost_quartz
    "rough-prism" -> R.drawable.pkw_ui_inv_rough_prism
    "crown-iron-ore" -> R.drawable.pkw_ui_inv_crown_iron_ore
    "storm-ore" -> R.drawable.pkw_ui_inv_storm_ore
    "sunstone-rubble" -> R.drawable.pkw_ui_inv_sunstone_rubble
    "thorn-fibre" -> R.drawable.pkw_ui_inv_thorn_fibre
    "route-compass" -> R.drawable.pkw_ui_item_route_compass
    "survey-lens" -> R.drawable.pkw_ui_item_survey_lens
    "realm-passport" -> R.drawable.pkw_ui_item_realm_passport
    "fastener-set" -> R.drawable.pkw_ui_item_fastener_set
    else -> null
}

/**
 * An icon that knows the voyage art: a `voyage:` name draws its copied PNG at a whole number of device pixels per art
 * pixel, centred in [size] (64 px art at 32 / 64 dp only); every other name goes to the kit's [PkwIcon].
 */
@Composable fun VoyageIcon(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null, alpha: Float = 1f) {
    val res = voyageDrawable(name)
    if (res == null) { PkwIcon(name, size, modifier, contentDescription, alpha); return }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(res)
    val described = if (contentDescription == null) Modifier else Modifier.clearAndSetSemantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) {
        val k = minOf(integerArtScale(this.size.width, bitmap.width), integerArtScale(this.size.height, bitmap.height))
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, IntOffset.Zero, IntSize(bitmap.width, bitmap.height),
            IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - h) / 2f).roundToInt()), IntSize(w, h),
            alpha = alpha, filterQuality = FilterQuality.None)
    }
}

/**
 * A pixel sprite drawn at SPEC §0.4's [designK] ([deviceArtScale]) with nearest sampling, cropped to [modifier]'s box (the
 * window). It is centred on the art point ([centreArtX], [centreArtY]), or with [bottomArtY] that art row sits on the
 * window's bottom edge. [dim] is a [dimMatrix] (grey / brightness) or null.
 */
@Composable fun PixelSprite(art: String, designK: Int, modifier: Modifier, centreArtX: Float, centreArtY: Float,
    bottomArtY: Int? = null, alpha: Float = 1f, dim: FloatArray? = null) {
    val res = voyageDrawable(art)
    if (res == null) { Spacer(modifier); return }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(res)
    val filter = remember(dim) { dim?.let { ColorFilter.colorMatrix(ColorMatrix(it)) } }
    Canvas(modifier.clipToBounds().clearAndSetSemantics { }) {
        val k = deviceArtScale(designK, density)
        val (x, y) = spriteOrigin(size.width.roundToInt(), size.height.roundToInt(), k, centreArtX, centreArtY, bottomArtY)
        drawImage(bitmap, IntOffset.Zero, IntSize(bitmap.width, bitmap.height), IntOffset(x, y), IntSize(bitmap.width * k, bitmap.height * k),
            alpha = alpha, colorFilter = filter, filterQuality = FilterQuality.None)
    }
}

/** A vehicle's idle sprite in a window centred on its painted box (SPEC §0.4 bbox table). */
@Composable fun VehicleSprite(family: VehicleFamily, tier: Int?, designK: Int, modifier: Modifier, alpha: Float = 1f, dim: FloatArray? = null) {
    val box = vehicleBbox(family)
    PixelSprite(vehicleIdleArt(family, tier), designK, modifier, (box[0] + box[2]) / 2f, (box[1] + box[3]) / 2f, alpha = alpha, dim = dim)
}

/** The SPEC §0.4 design scale for a vehicle in a well: the starter is tiny (k 3), the balloon tall (k 1 in short wells). */
fun wellScale(family: VehicleFamily, tallWell: Boolean = true): Int = when (family) {
    VehicleFamily.STARTER -> 3
    VehicleFamily.SURVEY_BALLOON -> if (tallWell) 2 else 1
    else -> 2
}

/** Flat 2 dp × 6-12 dp wave marks from a seeded random (SPEC §0.3): static, no shader. */
fun DrawScope.drawWaves(seed: Int, color: Color = VoyageColors.seaHi) {
    val r = Random(seed)
    val step = 2.dp.toPx()
    val count = ((size.width * size.height) / (44.dp.toPx() * 30.dp.toPx())).toInt().coerceIn(1, 40)
    repeat(count) {
        val w = (6 + r.nextInt(4) * 2).dp.toPx()
        val x = (r.nextFloat() * (size.width - w) / step).toInt() * step
        val y = (r.nextFloat() * size.height / step).toInt() * step
        drawRect(color, Offset(x, y), Size(w, step))
    }
}

/**
 * A sea well (SPEC §0.3): 2 dp ink border, sea face, 3 dp `sea.lo` bottom band; [grey] is the empty-berth well. The
 * content is clipped to the inside.
 */
@Composable fun SeaWell(modifier: Modifier = Modifier, grey: Boolean = false, waves: Int? = null, content: @Composable BoxScope.() -> Unit = {}) {
    Box(modifier.drawBehind {
        val i = 2.dp.toPx()
        drawRect(PkwTokens.Colors.ink)
        drawRect(if (grey) VoyageColors.emptyWell else VoyageColors.sea, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        if (waves != null && !grey) {
            drawWaves(waves)
        }
        drawRect(if (grey) PkwTokens.Colors.ink.copy(alpha = 0.5f) else VoyageColors.seaLo, Offset(i, size.height - i - 3.dp.toPx()), Size(size.width - 2 * i, 3.dp.toPx()))
    }.padding(2.dp).clipToBounds(), contentAlignment = Alignment.Center, content = content)
}

/**
 * Where route art comes from. Route cards and island cutouts live in the streamed chain atlases (SPEC §3 assets; the
 * existing loader is `phasee/OrdinaryRouteArt.kt`, which needs the content session), so the presentation files never load
 * them: the data side provides a [VoyageArtSource] with `CompositionLocalProvider(LocalVoyageArt provides …)`. The
 * default draws a sea stand-in (and "Island art loading" when [RouteUi.artAvailable] is false), so previews and a missing
 * atlas never crash or blank the sheet.
 */
@Immutable class VoyageArtSource(
    /** The square route card (80 dp tiles, 40-80 dp thumbs; 320 px art, 2:1 or 4:1). */
    val routeCard: @Composable (route: RouteUi, modifier: Modifier) -> Unit,
    /** The island cutout (card × chain mask) for headers and the collect card (160 / 80 dp); no card edge may show. */
    val routeCutout: @Composable (route: RouteUi, modifier: Modifier) -> Unit,
    /** The live-world crop around the Lodge for the header's left shore (160 × 136 dp); null draws the stand-in coast. */
    val shore: (@Composable (modifier: Modifier) -> Unit)? = null,
)

/** The route-art source in scope (see [VoyageArtSource]). */
val LocalVoyageArt = staticCompositionLocalOf {
    VoyageArtSource(routeCard = { route, modifier -> RouteStandIn(route, modifier, card = true) },
        routeCutout = { route, modifier -> RouteStandIn(route, modifier, card = false) })
}

/** The stand-in for missing route art: a stepped island silhouette on sea, or the "Island art loading" note. */
@Composable private fun RouteStandIn(route: RouteUi, modifier: Modifier, card: Boolean) {
    Box(modifier.drawBehind {
        if (card) { drawRect(VoyageColors.sea); drawWaves(route.routeId.hashCode()) }
        if (route.artAvailable) {
            val u = (size.minDimension / 10f / density).roundToInt().coerceAtLeast(1) * density
            val cx = size.width / 2f; val cy = size.height / 2f
            drawRect(VoyageColors.sand, Offset(cx - 3 * u, cy - 2 * u), Size(6 * u, 4 * u))
            drawRect(VoyageColors.sand, Offset(cx - 2 * u, cy - 3 * u), Size(4 * u, 6 * u))
            drawRect(VoyageColors.grass, Offset(cx - 2 * u, cy - 2 * u), Size(4 * u, 3 * u))
        }
    }, contentAlignment = Alignment.Center) {
        if (!route.artAvailable && card) PkwText("Island art loading", PkwTokens.Type.small, Modifier.padding(4.dp), color = PkwTokens.Colors.muted,
            textAlign = TextAlign.Center, maxLines = 2)
    }
}

/** A PS section label with its VT note ("VEHICLE  Grade II needs Tier 2 or higher"). Plain text, no touches. */
@Composable fun VoyageLabel(title: String, note: String? = null, modifier: Modifier = Modifier, noteColor: Color = PkwTokens.Colors.textOnParch2) {
    Row(modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(title, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
        if (note != null) PkwText(note, PkwTokens.Type.small, Modifier.weight(1f), color = noteColor)
    }
}

/**
 * A cream row with IngredientRow geometry (DESIGN-SYSTEM §6: ≥ 52 tall, 2 dp ink rim). [rim] draws a 3 dp state rim
 * (gold selected, green ready, blood short); [tint] replaces the cream. With [onClick] the whole row is one ≥ 48 dp target
 * labelled [description].
 */
@Composable fun VoyageRow(modifier: Modifier = Modifier, minHeight: Dp = PkwTokens.Dims.ingredientRowH, rim: Color? = null, tint: Color? = null,
    description: String? = null, onClick: (() -> Unit)? = null, selected: Boolean = false, content: @Composable RowScope.() -> Unit) {
    val reduced = LocalReducedMotion.current
    val rimColor by animateColorAsState(rim ?: Color.Transparent, tween(if (reduced) 0 else PkwTokens.Motion.RELEASE), label = "rim")
    val tap = if (onClick == null) Modifier else Modifier
        .clearAndSetSemantics {
            contentDescription = description.orEmpty(); role = Role.Button; this.selected = selected
            this.onClick(label = null, action = { onClick(); true })
        }
        .clickable(role = Role.Button, onClick = onClick)
    Plate(PlateKind.CREAM, modifier.fillMaxWidth().heightIn(min = minHeight).then(tap)
        .then(if (rim != null || rimColor.alpha > 0f) Modifier.border(3.dp, rimColor, PixelShapes.M) else Modifier), tint = tint) {
        Row(Modifier.fillMaxWidth().align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

/** A filter / segment chip (SPEC §4 item 2, §3a): 48 tall target, wood when off, cream when on, PS caption. */
@Composable fun ChoiceChip(label: String, on: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, description: String = label, dimmed: Boolean = false) {
    Plate(if (on) PlateKind.CREAM else PlateKind.WOOD, modifier.defaultMinSize(minHeight = PkwTokens.Dims.minTap, minWidth = PkwTokens.Dims.minTap)
        .graphicsLayer { alpha = if (dimmed) 0.55f else 1f }
        .clearAndSetSemantics { contentDescription = description; role = Role.Tab; selected = on; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Tab, onClick = onClick), contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)) {
        if (on) PkwText(label, PkwTokens.Type.caption, Modifier.align(Alignment.Center), color = PkwTokens.Colors.textOnParch)
        else PkwText(label, PkwTokens.Type.caption, Modifier.align(Alignment.Center), color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

/** The stone 48 dp back square (drawn arrow; the kit's GO glyph mirrored) and the PS title + VT sub-line beside it. */
@Composable fun BackTitleRow(title: String, sub: String?, onBack: () -> Unit, backDescription: String = "Back") {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        IconSquare("shape:go", Verb.STONE, onBack, backDescription, Modifier.graphicsLayer { scaleX = -1f })
        Column(Modifier.weight(1f)) {
            PkwText(title, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
            if (sub != null) PkwText(sub, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
    }
}

/** A trips-left meter (10-14 dp): green, gold at two or fewer; unknown draws an empty track. */
@Composable fun TripsMeter(left: Int?, max: Int?, modifier: Modifier, height: Dp = 10.dp) {
    ProgressBar(tripsFraction(left, max), "${tripsLeftLong(left, max)}", modifier, verb = tripsMeterVerb(left), height = height)
}

/** The 3 dp dashed gold-hi selection frame of a quay slot (SPEC §7 item 2). Paint only. */
fun Modifier.dashedFrame(show: Boolean): Modifier = if (!show) this else drawBehind {
    val w = 3.dp.toPx()
    drawRect(PkwTokens.Colors.gold.hi, Offset(w / 2, w / 2), Size(size.width - w, size.height - w),
        style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))))
}

/** A row that hands the player to another place: icon, two lines and a blue GO (SPEC §7 item 6, §10 item 4). */
@Composable fun GoRow(icon: String, line1: String, line2: String, goLabel: String, onGo: () -> Unit, goDescription: String,
    modifier: Modifier = Modifier, rim: Color? = null) {
    VoyageRow(modifier, rim = rim) {
        VoyageIcon(icon, 32.dp, Modifier.padding(start = 6.dp))
        Column(Modifier.weight(1f)) {
            PkwText(line1, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
            PkwText(line2, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
        GoButton(onGo, goDescription, Modifier.width(64.dp).padding(end = 2.dp), label = goLabel)
    }
}

/**
 * Locked art (SPEC §4: grey 85 %, brightness 45 %) for content the cluster does not draw itself (route cards from the
 * [VoyageArtSource]). The grey pass needs API 29 (BlendMode.Saturation); on API 28 only the darkening is drawn, never an
 * opaque grey square. Paint only.
 */
fun Modifier.lockedArt(on: Boolean): Modifier = if (!on) this else this
    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
    .drawWithContent {
        drawContent()
        if (Build.VERSION.SDK_INT >= 29) drawRect(Color.Gray, blendMode = BlendMode.Saturation)
        drawRect(Color.Black.copy(alpha = 0.55f))
    }

/** The green ✓ corner badge of a selected card or tile (24 dp, drawn check glyph). Decorative; the card says "selected". */
@Composable fun CheckBadge(modifier: Modifier = Modifier) {
    Box(modifier.size(PkwTokens.Dims.badgeH).clearAndSetSemantics { }.drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
            drawRect(PkwTokens.Colors.green.face)
            band(i, size.width - i, i, 2.dp.toPx(), PkwTokens.Colors.green.hi)
        }
    }, contentAlignment = Alignment.Center) { PkwIcon("shape:check", 16.dp, tint = PkwTokens.Colors.label) }
}

/** The 2 dp stone refresh line under the tabs while a refresh runs over the last snapshot (SPEC §0.5): paint only. */
@Composable fun RefreshLine(show: Boolean) {
    Box(Modifier.fillMaxWidth().heightIn(min = 2.dp).background(if (show) PkwTokens.Colors.stone.face else Color.Transparent))
}

@Preview(name = "Voyage parts", widthDp = 400, heightDp = 420)
@Composable private fun VoyagePartsPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            VehicleFamily.entries.forEach { f ->
                SeaWell(Modifier.size(64.dp, 60.dp), waves = f.ordinal) { VehicleSprite(f, 2, wellScale(f, tallWell = false), Modifier.fillMaxSize()) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("voyage:heartwood-logs", "voyage:thorn-fibre", "voyage:route-compass", "voyage:fastener-set", "ui:lodge-menu").forEach { VoyageIcon(it, 32.dp) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            ChoiceChip("ALL 32", true, {})
            ChoiceChip("CAN SAIL 16", false, {})
            CheckBadge()
        }
        RefreshLine(true)
        VoyageLabel("SUPPLIES", "used up when it sails")
        TripsMeter(1, 10, Modifier.width(200.dp))
        GoRow("ui:solana-navigation", "No balloon to install?", "Craft one at Solana Island", "GO", {}, "Go to Solana Island")
        BackTitleRow("CHOOSE AN ISLAND", "Tap one to sail there", {})
    }
}
