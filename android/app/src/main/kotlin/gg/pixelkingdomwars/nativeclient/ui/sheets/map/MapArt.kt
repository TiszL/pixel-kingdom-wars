package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.drawGlyph
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.integerArtScale
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: the map cluster's art and shared parts (design/final/map/SPEC.md §1.6 half sheets, §3.3 SpotTag, §9
 * assets and "drawn in code"): the colours the SPEC names that are not in TOKENS.json, the special-site sprites copied
 * for this cluster (ASSET-COPIES-map.md), the drawn magnifier / back arrow / crown pip / selection diamond, and the map
 * half-sheet frame (WoodFrame with an icon header, ParchmentPanel body) with its section header, rows, stat cards,
 * wells, crest squares and kingdom reference.
 *
 * Kit gaps filled here (the kit is not edited): a map half-sheet header with a 32 dp icon on the wood (the kit's
 * SheetFrame draws a charcoal title plate), the special-site sprite resolver (the kit's PkwIcon whitelist does not know
 * the copied `pkw_ui_site_*` files), and the four drawn glyphs SPEC §9 lists.
 *
 * Pointer rule: everything here is a painted piece. Only [MapRow] with an onClick, the frame's close / History squares
 * and callers' buttons take touches; nothing here is full-screen and nothing here is a scrim.
 */

/** The colours SPEC.md names that TOKENS.json does not carry (each is a literal from the SPEC / the mock CSS). */
object MapColors {
    /** SPEC §3.2: the island stage around the art. */
    val stage = Color(0xFF0C2148)
    /** SPEC §1.4: the sea-blue face of the island rail tiles. */
    val railSea = Color(0xFF0F2A57)
    /** SPEC §3.4: the spot well. */
    val seekerWell = Color(0xFF2F4A6A)
    /** SPEC §5: the Divine door wells. */
    val divineWell = Color(0xFF4A3F66)
    /** SPEC §1.6: the 2 dp rule after a section header. */
    val rule = Color(0xFFC4A464)
    /** SPEC §1.3: an unlit mode pip. */
    val pipOff = Color(0xFF4A4552)
    /** Mock CSS `.irow.miss`: an alert row's body (blood rim). */
    val missBody = Color(0xFFFDE3D8)
    /** Mock CSS `.irow.lead`: a RETURNED / leading row's body (green-lo rim). */
    val leadBody = Color(0xFFE3F3CF)
    /** SPEC §2.3: the realm-ground tint of a kingdom thumbnail well (Frostveil snow). */
    val snowWell = Color(0xFFDFE9F0)
}

/** A tag the map draws (LIVE 14h, YOU, TEST DATA): text and face verb. */
@Immutable data class MapTagUi(val text: String, val verb: Verb)

/** A kingdom named on a game surface: its face and name. Never a wallet string (CRITIC §2.2). */
@Immutable data class KingdomRefUi(
    /** The kingdom name; null reads "a Seeker player" ([bidderName]). */
    val name: String?,
    /** The face art (a GameArt name, e.g. "ui_portrait_keep_t3"); null draws none. */
    val portrait: String?,
)

/** One realm crest square (SPEC §3.4: up to 8 squares 24, ink outline 2). */
@Immutable data class CrestUi(
    /** The realm id ("frostveil"). */
    val realmId: String,
    /** Its display name, for screen readers. */
    val name: String,
    /** A crest / thumbnail drawable name; null draws the realm initial (no authored crest set exists, SPEC §10 row 8). */
    val icon: String? = null,
)

/** The `pkw_ui_site_*` copies (ASSET-COPIES-map.md), by `site:` name; null for any other name. */
fun mapDrawable(name: String): Int? = when (name.removePrefix("site:")) {
    "seeker-available" -> R.drawable.pkw_ui_site_seeker_available
    "seeker-occupied" -> R.drawable.pkw_ui_site_seeker_occupied
    "seeker-active" -> R.drawable.pkw_ui_site_seeker_active
    "seeker-expired" -> R.drawable.pkw_ui_site_seeker_expired
    "solana-available" -> R.drawable.pkw_ui_site_solana_available
    "solana-occupied" -> R.drawable.pkw_ui_site_solana_occupied
    "solana-active" -> R.drawable.pkw_ui_site_solana_active
    "solana-expired" -> R.drawable.pkw_ui_site_solana_expired
    "divine-solo-active" -> R.drawable.pkw_ui_site_divine_solo_active
    "divine-clan-occupied" -> R.drawable.pkw_ui_site_divine_clan_occupied
    else -> null
}

/** The `site:` art name of an island spot's look. */
fun siteArt(island: IslandKind, look: SpotLook): String =
    "site:${if (island == IslandKind.SEEKER) "seeker" else "solana"}-${look.name.lowercase()}"

/** Draws one bitmap at a whole number of device px per art px, centred, nearest sampling. */
internal fun DrawScope.drawPixelArt(bitmap: ImageBitmap, alpha: Float = 1f, forcedScale: Int? = null) {
    val k = forcedScale ?: minOf(integerArtScale(size.width, bitmap.width), integerArtScale(size.height, bitmap.height))
    val w = bitmap.width * k; val h = bitmap.height * k
    drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
        dstOffset = IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()),
        dstSize = IntSize(w, h), alpha = alpha, filterQuality = FilterQuality.None)
}

/**
 * An icon of this cluster: a `site:` sprite from the copies, else the kit's [PkwIcon] (`ui:` icons, `shape:` glyphs,
 * currencies, GameArt names). Pixel art at an integer scale with nearest sampling. [scale] forces a whole scale (the
 * island layer draws sprites at its zoom level's scale, not the box's nearest).
 */
@Composable fun MapIcon(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null, alpha: Float = 1f,
    scale: Int? = null) {
    val res = mapDrawable(name)
    if (res == null) { PkwIcon(name, size, modifier, contentDescription, alpha); return }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(res)
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) { drawPixelArt(bitmap, alpha, scale) }
}

// ---- Drawn glyphs (SPEC §9 "drawn in code") ----

private val MAGNIFIER = listOf(
    "..xxxx......",
    ".xhhhhx.....",
    "xh....hx....",
    "xh.....x....",
    "xh.....x....",
    "xh....hx....",
    ".x####x.....",
    "..xxxx#x....",
    ".......x#x..",
    "........x#x.",
    ".........x#x",
    "..........x.",
)

private val BACK_ARROW = listOf(
    "............",
    "....xx......",
    "...x#x......",
    "..x##xxxxxx.",
    ".x#hhhhhhh#x",
    "x##########x",
    "x##########x",
    ".x#########x",
    "..x##xxxxxx.",
    "...x#x......",
    "....xx......",
    "............",
)

/** The drawn magnifier (search). */
@Composable fun MagnifierGlyph(size: Dp, modifier: Modifier = Modifier, tint: Color = PkwTokens.Colors.label) {
    Canvas(modifier.size(size).clearAndSetSemantics { }) { drawGlyph(MAGNIFIER, tint, 1f) }
}

/** The drawn left arrow (BACK to the map). */
@Composable fun BackArrowGlyph(size: Dp, modifier: Modifier = Modifier, tint: Color = PkwTokens.Colors.label) {
    Canvas(modifier.size(size).clearAndSetSemantics { }) { drawGlyph(BACK_ARROW, tint, 1f) }
}

/** The gold crown pip (14 × 10 polygon, SPEC §3.2 / §3.3) before a King spot's number. Decorative. */
@Composable fun CrownPip(modifier: Modifier = Modifier) {
    Canvas(modifier.size(14.dp, 10.dp).clearAndSetSemantics { }) {
        val w = size.width; val h = size.height
        val crown = Path().apply {
            moveTo(0f, h); lineTo(0f, h * 0.2f); lineTo(w * 0.28f, h * 0.55f); lineTo(w * 0.5f, 0f)
            lineTo(w * 0.72f, h * 0.55f); lineTo(w, h * 0.2f); lineTo(w, h); close()
        }
        drawPath(crown, PkwTokens.Colors.gold.face)
        drawRect(PkwTokens.Colors.gold.lo, Offset(0f, h - 2.dp.toPx()), Size(w, 2.dp.toPx()))
    }
}

/** The selection diamond under a selected spot (SPEC §3.3): a stepped iso diamond 76 × 38, ink, gold-hi 3 dp ring,
 *  40 % gold fill. [pulse] 0..1 scales the ring (the 1,800 ms selection pulse; 0 under reduced motion). */
internal fun DrawScope.drawSelectionDiamond(cx: Float, cy: Float, pulse: Float) {
    val grow = 1f + 0.06f * pulse
    val hw = 38.dp.toPx() * grow; val hh = 19.dp.toPx() * grow
    fun diamond(dx: Float, dy: Float) = Path().apply {
        moveTo(cx, cy - dy); lineTo(cx + dx, cy); lineTo(cx, cy + dy); lineTo(cx - dx, cy); close()
    }
    drawPath(diamond(hw, hh), PkwTokens.Colors.ink)
    val ring = 3.dp.toPx(); val ink = 2.dp.toPx()
    drawPath(diamond(hw - ink * 2f, hh - ink), PkwTokens.Colors.gold.hi)
    drawPath(diamond(hw - (ink + ring) * 2f, hh - ink - ring), PkwTokens.Colors.gold.face.copy(alpha = 0.40f))
}

/** The archipelago / kingdom selection octagon ring (SPEC §1.5, §2.3): ink 7 / gold-hi 3, 12 % gold fill. */
internal fun DrawScope.drawOctagonRing(cx: Float, cy: Float, radius: Float) {
    fun octagon(r: Float): Path {
        val c = r * 0.4142f
        return Path().apply {
            moveTo(cx - c, cy - r); lineTo(cx + c, cy - r); lineTo(cx + r, cy - c); lineTo(cx + r, cy + c)
            lineTo(cx + c, cy + r); lineTo(cx - c, cy + r); lineTo(cx - r, cy + c); lineTo(cx - r, cy - c); close()
        }
    }
    val inkW = 7.dp.toPx(); val goldW = 3.dp.toPx()
    drawPath(octagon(radius + inkW / 2f), PkwTokens.Colors.ink, style = androidx.compose.ui.graphics.drawscope.Stroke(inkW))
    drawPath(octagon(radius + inkW / 2f), PkwTokens.Colors.gold.hi, style = androidx.compose.ui.graphics.drawscope.Stroke(goldW))
    drawPath(octagon(radius), PkwTokens.Colors.gold.face.copy(alpha = 0.12f))
}

// ---- The map half sheet (SPEC §1.6) ----

/**
 * The map half sheet (SPEC §1.6): WoodFrame anchored to the bottom (x 4 to 408; the host places it), height = content up
 * to 50 % of the screen, a 58 dp header on the wood (icon 32, PS 13 gold-hi title, optional tags, optional 48 stone
 * History, 48 red close), a ParchmentPanel body (padding 10) that scrolls when it is taller than the cap, and the pinned
 * [footer] (the sheet's one primary, last row, full width × 60). The bottom pads the gesture inset.
 *
 * Pointer rule: a HALF sheet has no scrim; the wood frame is a painted panel (scene-input region). A tap on empty map
 * closes it through the scene's own tap (the host), never through a scrim here.
 */
@Composable fun MapSheetFrame(title: String, icon: String?, onClose: () -> Unit, modifier: Modifier = Modifier,
    tags: List<MapTagUi> = emptyList(), history: Boolean = false, onHistory: () -> Unit = {},
    footer: (@Composable ColumnScope.() -> Unit)? = null, body: @Composable ColumnScope.() -> Unit) {
    val cap = (LocalConfiguration.current.screenHeightDp / 2).dp
    Plate(PlateKind.WOOD, modifier.fillMaxWidth().heightIn(max = cap)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (icon != null) MapIcon(icon, 32.dp)
                PkwText(title, PkwTokens.Type.title, Modifier.weight(1f).semantics { heading() }, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                tags.forEach { Tag(it.text, it.verb) }
                if (history) IconSquare("replay", Verb.STONE, onHistory, "History")
                CloseSquare(onClose)
            }
            Spacer(Modifier.height(6.dp))
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f, fill = false), contentPadding = PaddingValues(10.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(8.dp), content = body)
                    if (footer != null) Column(Modifier.fillMaxWidth().padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = footer)
                }
            }
        }
    }
}

/** A section header on parchment (SPEC §1.6): PS 11 ink caption plus a 2 dp `#C4A464` rule to the right. */
@Composable fun MapSectionHeader(text: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
        Box(Modifier.weight(1f).height(2.dp).background(MapColors.rule))
    }
}

/** VT 20 body copy on parchment (up to [maxLines]). */
@Composable fun ParchLine(text: String, modifier: Modifier = Modifier, secondary: Boolean = false, maxLines: Int = 3,
    center: Boolean = false) {
    PkwText(text, if (secondary) PkwTokens.Type.small else PkwTokens.Type.body, modifier,
        color = if (secondary) PkwTokens.Colors.textOnParch2 else PkwTokens.Colors.textOnParch, maxLines = maxLines,
        textAlign = if (center) TextAlign.Center else null)
}

/**
 * An IngredientRow-style row (mock CSS `.irow`): min 52, cream body with a 2 dp ink rim; [tint] / [rim] for the
 * `#FFF3C8` info row, the blood-rim alert row and the green RETURNED row. With [onClick] the whole row is a ≥ 48 dp
 * target that reads [description].
 */
@Composable fun MapRow(modifier: Modifier = Modifier, tint: Color = PkwTokens.Colors.cream, rim: Color = PkwTokens.Colors.ink,
    description: String? = null, onClick: (() -> Unit)? = null, content: @Composable RowScope.() -> Unit) {
    val touch = if (onClick == null) Modifier else Modifier.sceneInputRegion()
        .semantics(mergeDescendants = true) { role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)
    val said = if (description == null) Modifier else Modifier.semantics(mergeDescendants = true) { contentDescription = description }
    Row(modifier.fillMaxWidth().heightIn(min = 52.dp).then(touch).then(said).background(tint).border(2.dp, rim)
        .padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

/** A two-line row text block: VT 20 [title] and VT 18 [sub] (mock `.irow .nm` + `small`). */
@Composable fun RowScope.RowText(title: String, sub: String?, modifier: Modifier = Modifier) {
    Column(modifier.weight(1f)) {
        PkwText(title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 2)
        if (sub != null) PkwText(sub, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
    }
}

/** A StatCard (SPEC §3.1 YOU HERE, §4.3): CreamCard 64 with an icon, a PS 11 label and a PS 14 value ("…" unknown).
 *  With [onClick] it is a door (≥ 48 dp target). */
@Composable fun StatCard(icon: String, label: String, value: String, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null,
    iconSize: Dp = 32.dp) {
    val shown = value.ifBlank { UNKNOWN }
    val touch = if (onClick == null) Modifier.clearAndSetSemantics { contentDescription = "$label $shown" }
        else Modifier.sceneInputRegion().clearAndSetSemantics {
            contentDescription = "$label $shown"; role = Role.Button; this.onClick(label = null, action = { onClick(); true })
        }.clickable(role = Role.Button, onClick = onClick)
    Plate(PlateKind.CREAM, modifier.heightIn(min = 64.dp).then(touch), blocksScene = onClick != null) {
        Row(Modifier.align(Alignment.CenterStart).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MapIcon(icon, iconSize)
            Column {
                PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
                PkwText(shown, PkwTokens.Type.primary, color = PkwTokens.Colors.textOnParch)
            }
        }
    }
}

/** A square art well (SPEC §3.4 72 × 72 `#2F4A6A`; §5 `#4A3F66`): 2 dp ink rim, [color] face, content centred. */
@Composable fun ArtWell(size: Dp, color: Color, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.size(size).drawBehind {
        drawRect(PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        drawRect(color, Offset(i, i), Size(this.size.width - 2 * i, this.size.height - 2 * i))
    }, contentAlignment = Alignment.Center, content = content)
}

/** A row of realm crest squares (24 dp, ink 2 dp outline). Paint only; the caller reads the crest line. */
@Composable fun CrestRow(crests: List<CrestUi>, modifier: Modifier = Modifier) {
    Row(modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        crests.take(8).forEach { crest ->
            Box(Modifier.size(24.dp).border(2.dp, PkwTokens.Colors.ink).padding(2.dp).background(PkwTokens.Colors.surface),
                contentAlignment = Alignment.Center) {
                val icon = crest.icon
                if (icon != null) MapIcon(icon, 20.dp)
                else PkwText(crest.name.take(1).uppercase(), PkwTokens.Type.small, color = PkwTokens.Colors.gold.hi)
            }
        }
    }
}

/** A kingdom as a game name: face 18 + VT 18 name (CRITIC §2.2). Paint only. */
@Composable fun KingdomRef(ref: KingdomRefUi, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        ref.portrait?.let { PkwIcon(it, 18.dp) }
        PkwText(bidderName(ref.name), PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

/** A thin 12 dp meter on parchment (SPEC §3.1 state card, §6 trip rows): ink rim, track, [verb] fill. Unknown (null)
 *  draws the empty track, never 0 %. Paint only. */
@Composable fun ParchMeter(progress: Float?, verb: Verb, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(12.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        drawRect(PkwTokens.Colors.track, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        if (progress != null) {
            val w = (size.width - 2 * i) * progress.coerceIn(0f, 1f)
            drawRect(PkwTokens.ramp(verb).face, Offset(i, i), Size(w, size.height - 2 * i))
            drawRect(PkwTokens.ramp(verb).hi, Offset(i, i), Size(w, 2.dp.toPx()))
        }
    }.clearAndSetSemantics { })
}

/** The striped stone TEST DATA ribbon (SPEC §3.2, 288 × 30): "TEST DATA · NOT REAL BIDS". Paint only. */
@Composable fun TestDataRibbon(text: String, modifier: Modifier = Modifier) {
    Box(modifier.heightIn(min = 30.dp).clearAndSetSemantics { contentDescription = text }.drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx(); val band = 12.dp.toPx()
        val l = i; val t = i; val r = size.width - i; val b = size.height - i
        drawRect(PkwTokens.Colors.stone.face, Offset(l, t), Size(r - l, b - t))
        // 135° stripes, 12 dp each (mock CSS repeating-linear-gradient(135deg, #7e7266 0 12px, #716659 12px 24px)).
        var x = l - (b - t)
        while (x < r) {
            val stripe = Path().apply { moveTo(x, b); lineTo(x + band, b); lineTo(x + band + (b - t), t); lineTo(x + (b - t), t); close() }
            drawPath(stripe, PkwTokens.Colors.stone.mid)
            x += band * 2
        }
    }.padding(horizontal = 10.dp, vertical = 2.dp), contentAlignment = Alignment.CenterStart) {
        PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

@Preview(name = "Map parts", widthDp = 412, heightDp = 520)
@Composable private fun MapPartsPreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg), contentAlignment = Alignment.BottomCenter) {
        MapSheetFrame("SEEKER ISLAND", "ui:seeker-navigation", onClose = {}, modifier = Modifier.padding(horizontal = 4.dp),
            tags = listOf(MapTagUi("TEST DATA", Verb.STONE))) {
            MapSectionHeader("YOU HERE")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatCard("site:seeker-active", "MY SPOTS", "1", Modifier.weight(1f), onClick = {})
                StatCard("skr", "MY BIDS", UNKNOWN, Modifier.weight(1f), iconSize = 24.dp)
            }
            MapRow(tint = MapColors.missBody, rim = PkwTokens.Colors.blood) { RowText("Outbid on Spot 42", "120 SKR held for you") }
            ParchMeter(0.42f, Verb.GOLD)
            CrestRow(listOf(CrestUi("frostveil", "Frostveil"), CrestUi("elderwood", "Elderwood")))
            KingdomRef(KingdomRefUi("Kinmar", "ui_portrait_keep_t3"))
            TestDataRibbon("TEST DATA · NOT REAL BIDS", Modifier.width(288.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { MagnifierGlyph(26.dp); BackArrowGlyph(26.dp); CrownPip() }
        }
    }
}
