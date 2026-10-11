package gg.pixelkingdomwars.nativeclient.ui.chrome

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.*
import gg.pixelkingdomwars.nativeclient.R
import org.json.JSONObject
import android.content.res.Resources
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.kit.SolanaMark
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import androidx.compose.ui.draw.drawBehind
import gg.pixelkingdomwars.nativeclient.ui.kit.isSolanaMark
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ownsBuildingArt
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.material3.Text
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/** Original web art, bundled so title and HUD do not depend on an optional content download. */
private fun artResource(name: String): Int? = when (name) {
    "gem" -> R.drawable.gem_24
    "gem-32" -> R.drawable.gem_32
    "league-bronze", "league_bronze" -> R.drawable.pkw_web_league_bronze
    "league-silver", "league_silver" -> R.drawable.pkw_web_league_silver
    "league-gold", "league_gold" -> R.drawable.pkw_web_league_gold
    "league-sol", "league_sol" -> R.drawable.pkw_web_league_sol
    "hero_vex_idle_f1" -> R.drawable.pkw_web_body_vex
    "hero_theo_idle_f1" -> R.drawable.pkw_web_body_theo
    "logo" -> R.drawable.pkw_web_logo
    "title-portrait" -> R.drawable.pkw_web_title_portrait
    "title-landscape" -> R.drawable.pkw_web_title_landscape
    "overflow" -> R.drawable.pkw_web_overflow
    "overflow-pressed" -> R.drawable.pkw_web_overflow_pressed
    "alert" -> R.drawable.pkw_web_alert
    "keep", "founding", "shop" -> R.drawable.pkw_web_icon_keeptoken
    "builder" -> R.drawable.pkw_web_builder
    "shards", "shard", "market" -> R.drawable.pkw_web_icon_shard
    "plus" -> R.drawable.pkw_web_icon_plus
    "map" -> R.drawable.pkw_web_icon_map
    "raid", "attack" -> R.drawable.pkw_web_icon_attack
    "quests", "quest" -> R.drawable.pkw_web_icon_quest
    "bag", "backpack" -> R.drawable.pkw_web_icon_backpack
    "cache", "streak" -> R.drawable.pkw_web_icon_streak
    "mail", "info" -> R.drawable.pkw_web_icon_info
    "referral" -> R.drawable.pkw_web_icon_referral
    "trophy" -> R.drawable.pkw_web_icon_trophy
    "energy" -> R.drawable.pkw_web_icon_energy
    "shield" -> R.drawable.pkw_web_icon_shield
    "settings" -> R.drawable.pkw_web_icon_settings
    "close" -> R.drawable.pkw_web_icon_close
    "layout" -> R.drawable.pkw_web_icon_layout
    "locate" -> R.drawable.pkw_web_icon_locate
    "timer" -> R.drawable.pkw_web_icon_timer
    "replay" -> R.drawable.pkw_web_icon_replay
    "scout" -> R.drawable.pkw_web_icon_scout
    "sol" -> R.drawable.pkw_web_icon_sol
    "star" -> R.drawable.pkw_web_icon_star
    "wall5_t1_straight_intact_f1" -> R.drawable.pkw_web_wall_t1
    "wall5_t2_straight_intact_f1" -> R.drawable.pkw_web_wall_t2
    "wall5_t3_straight_intact_f1" -> R.drawable.pkw_web_wall_t3
    "wall5_t4_straight_intact_f1" -> R.drawable.pkw_web_wall_t4
    "wall5_t5_straight_intact_f1" -> R.drawable.pkw_web_wall_t5
    "hero_vex_portrait" -> R.drawable.pkw_web_hero_vex
    "hero_vex_portrait_t4" -> R.drawable.pkw_web_hero_vex_t4
    "hero_theo_portrait" -> R.drawable.pkw_web_hero_theo
    "hero_theo_portrait_t4" -> R.drawable.pkw_web_hero_theo_t4
    "itm_helm" -> R.drawable.pkw_web_item_helm
    "itm_amulet" -> R.drawable.pkw_web_item_amulet
    "itm_chest" -> R.drawable.pkw_web_item_chest
    "itm_cloak" -> R.drawable.pkw_web_item_cloak
    "itm_gloves" -> R.drawable.pkw_web_item_gloves
    "itm_ring" -> R.drawable.pkw_web_item_ring
    "itm_boots" -> R.drawable.pkw_web_item_boots
    "itm_banner" -> R.drawable.pkw_web_item_banner
    "itm_hammer" -> R.drawable.pkw_web_item_hammer
    "itm_shield" -> R.drawable.pkw_web_item_shield
    "itm_deed_earth" -> R.drawable.pkw_web_item_deed_earth
    "profile", "ui_portrait_keep_t1" -> R.drawable.pkw_web_portrait_keep_t1
    "ui_portrait_keep_t2" -> R.drawable.pkw_web_portrait_keep_t2
    "ui_portrait_keep_t3" -> R.drawable.pkw_web_portrait_keep_t3
    "ui_portrait_keep_t4" -> R.drawable.pkw_web_portrait_keep_t4
    "ui_portrait_barrowling_t1" -> R.drawable.pkw_web_portrait_barrowling_t1
    "ui_portrait_barrowling_t2" -> R.drawable.pkw_web_portrait_barrowling_t2
    "ui_portrait_barrowling_t3" -> R.drawable.pkw_web_portrait_barrowling_t3
    "ui_portrait_barrowling_t4" -> R.drawable.pkw_web_portrait_barrowling_t4
    "ui_portrait_bilgewraith_t1" -> R.drawable.pkw_web_portrait_bilgewraith_t1
    "ui_portrait_bilgewraith_t2" -> R.drawable.pkw_web_portrait_bilgewraith_t2
    "ui_portrait_bilgewraith_t3" -> R.drawable.pkw_web_portrait_bilgewraith_t3
    "ui_portrait_bilgewraith_t4" -> R.drawable.pkw_web_portrait_bilgewraith_t4
    "ui_portrait_bowman_t1" -> R.drawable.pkw_web_portrait_bowman_t1
    "ui_portrait_bowman_t2" -> R.drawable.pkw_web_portrait_bowman_t2
    "ui_portrait_bowman_t3" -> R.drawable.pkw_web_portrait_bowman_t3
    "ui_portrait_bowman_t4" -> R.drawable.pkw_web_portrait_bowman_t4
    "ui_portrait_cannon_t1" -> R.drawable.pkw_web_portrait_cannon_t1
    "ui_portrait_cannon_t2" -> R.drawable.pkw_web_portrait_cannon_t2
    "ui_portrait_cannon_t3" -> R.drawable.pkw_web_portrait_cannon_t3
    "ui_portrait_cannon_t4" -> R.drawable.pkw_web_portrait_cannon_t4
    "ui_portrait_direwyvern_t1" -> R.drawable.pkw_web_portrait_direwyvern_t1
    "ui_portrait_direwyvern_t2" -> R.drawable.pkw_web_portrait_direwyvern_t2
    "ui_portrait_direwyvern_t3" -> R.drawable.pkw_web_portrait_direwyvern_t3
    "ui_portrait_direwyvern_t4" -> R.drawable.pkw_web_portrait_direwyvern_t4
    "ui_portrait_dragon_t1" -> R.drawable.pkw_web_portrait_dragon_t1
    "ui_portrait_dragon_t2" -> R.drawable.pkw_web_portrait_dragon_t2
    "ui_portrait_dragon_t3" -> R.drawable.pkw_web_portrait_dragon_t3
    "ui_portrait_dragon_t4" -> R.drawable.pkw_web_portrait_dragon_t4
    "ui_portrait_giant_t1" -> R.drawable.pkw_web_portrait_giant_t1
    "ui_portrait_giant_t2" -> R.drawable.pkw_web_portrait_giant_t2
    "ui_portrait_giant_t3" -> R.drawable.pkw_web_portrait_giant_t3
    "ui_portrait_giant_t4" -> R.drawable.pkw_web_portrait_giant_t4
    "ui_portrait_gloamfang_t1" -> R.drawable.pkw_web_portrait_gloamfang_t1
    "ui_portrait_gloamfang_t2" -> R.drawable.pkw_web_portrait_gloamfang_t2
    "ui_portrait_gloamfang_t3" -> R.drawable.pkw_web_portrait_gloamfang_t3
    "ui_portrait_gloamfang_t4" -> R.drawable.pkw_web_portrait_gloamfang_t4
    "ui_portrait_hexbarrow_t1" -> R.drawable.pkw_web_portrait_hexbarrow_t1
    "ui_portrait_hexbarrow_t2" -> R.drawable.pkw_web_portrait_hexbarrow_t2
    "ui_portrait_hexbarrow_t3" -> R.drawable.pkw_web_portrait_hexbarrow_t3
    "ui_portrait_hexbarrow_t4" -> R.drawable.pkw_web_portrait_hexbarrow_t4
    "ui_portrait_highlander_t1" -> R.drawable.pkw_web_portrait_highlander_t1
    "ui_portrait_highlander_t2" -> R.drawable.pkw_web_portrait_highlander_t2
    "ui_portrait_highlander_t3" -> R.drawable.pkw_web_portrait_highlander_t3
    "ui_portrait_highlander_t4" -> R.drawable.pkw_web_portrait_highlander_t4
    "ui_portrait_kegrunner_t1" -> R.drawable.pkw_web_portrait_kegrunner_t1
    "ui_portrait_kegrunner_t2" -> R.drawable.pkw_web_portrait_kegrunner_t2
    "ui_portrait_kegrunner_t3" -> R.drawable.pkw_web_portrait_kegrunner_t3
    "ui_portrait_kegrunner_t4" -> R.drawable.pkw_web_portrait_kegrunner_t4
    "ui_portrait_mage_t1" -> R.drawable.pkw_web_portrait_mage_t1
    "ui_portrait_mage_t2" -> R.drawable.pkw_web_portrait_mage_t2
    "ui_portrait_mage_t3" -> R.drawable.pkw_web_portrait_mage_t3
    "ui_portrait_mage_t4" -> R.drawable.pkw_web_portrait_mage_t4
    "ui_portrait_mortar_t1" -> R.drawable.pkw_web_portrait_mortar_t1
    "ui_portrait_mortar_t2" -> R.drawable.pkw_web_portrait_mortar_t2
    "ui_portrait_mortar_t3" -> R.drawable.pkw_web_portrait_mortar_t3
    "ui_portrait_mortar_t4" -> R.drawable.pkw_web_portrait_mortar_t4
    "ui_portrait_plunderer_t1" -> R.drawable.pkw_web_portrait_plunderer_t1
    "ui_portrait_plunderer_t2" -> R.drawable.pkw_web_portrait_plunderer_t2
    "ui_portrait_plunderer_t3" -> R.drawable.pkw_web_portrait_plunderer_t3
    "ui_portrait_plunderer_t4" -> R.drawable.pkw_web_portrait_plunderer_t4
    "ui_portrait_troll_t1" -> R.drawable.pkw_web_portrait_troll_t1
    "ui_portrait_troll_t2" -> R.drawable.pkw_web_portrait_troll_t2
    "ui_portrait_troll_t3" -> R.drawable.pkw_web_portrait_troll_t3
    "ui_portrait_troll_t4" -> R.drawable.pkw_web_portrait_troll_t4
    "ui_portrait_tunneler_t1" -> R.drawable.pkw_web_portrait_tunneler_t1
    "ui_portrait_tunneler_t2" -> R.drawable.pkw_web_portrait_tunneler_t2
    "ui_portrait_tunneler_t3" -> R.drawable.pkw_web_portrait_tunneler_t3
    "ui_portrait_tunneler_t4" -> R.drawable.pkw_web_portrait_tunneler_t4
    "ui_portrait_turrider_t1" -> R.drawable.pkw_web_portrait_turrider_t1
    "ui_portrait_turrider_t2" -> R.drawable.pkw_web_portrait_turrider_t2
    "ui_portrait_turrider_t3" -> R.drawable.pkw_web_portrait_turrider_t3
    "ui_portrait_turrider_t4" -> R.drawable.pkw_web_portrait_turrider_t4
    else -> null
}


private object ShellImages {
    private val bitmaps = mutableMapOf<Int, ImageBitmap>()
    private var frameMap: Map<String, JSONObject>? = null
    @Synchronized fun bitmap(resources: Resources, id: Int): ImageBitmap =
        bitmaps.getOrPut(id) { ImageBitmap.imageResource(resources, id) }
    /** The decoded painting when it is already in the cache, without decoding: a recreated backdrop's first frame. */
    @Synchronized fun cached(id: Int): ImageBitmap? = bitmaps[id]
    // Background paintings must not hold the cache monitor while decoding: GameArt can
    // request its small icons on the UI thread while the loader's picture is being prepared.
    fun background(resources: Resources, id: Int): ImageBitmap {
        synchronized(this) { bitmaps[id]?.let { return it } }
        val decoded = ImageBitmap.imageResource(resources, id)
        return synchronized(this) { bitmaps.getOrPut(id) { decoded } }
    }
    @Synchronized fun frames(resources: Resources): Map<String, JSONObject> {
        frameMap?.let { return it }
        val root = JSONObject(resources.openRawResource(R.raw.pkw_ui_art).bufferedReader().use { it.readText() })
        val texture = root.getJSONArray("textures").getJSONObject(0)
        require(texture.getString("image") == "ui@1x.png")
        val rows = texture.getJSONArray("frames")
        return buildMap {
            for (index in 0 until rows.length()) {
                val row = rows.getJSONObject(index)
                require(!row.getBoolean("rotated") && !row.getBoolean("trimmed"))
                put(row.getString("filename"), row.getJSONObject("frame"))
            }
        }.also { frameMap = it }
    }
}

/** The art the first Home frame draws (the HUD plates, the shared UI atlas and its 56 KB frame table, the currency and
 *  door icons). Without this the first composition decoded the 684×674 atlas and parsed the frame JSON on the main
 *  thread, a visible hitch on the frame Home appears. Called once off Main at activity start; every step is a cache
 *  fill only (a later composition finds the same images), and any failure leaves the lazy path exactly as before. */
internal fun prewarmShellArt(resources: Resources) {
    runCatching { ShellImages.frames(resources) }
    val shell = listOf(R.drawable.pkw_web_ui_atlas, R.drawable.pkw_web_bar, R.drawable.pkw_web_shard, R.drawable.pkw_web_keep,
        R.drawable.pkw_web_tab, R.drawable.pkw_web_tab_sunk, R.drawable.pkw_web_gold, R.drawable.pkw_web_gold_sunk,
        R.drawable.pkw_web_dock, R.drawable.pkw_web_dock_sunk)
    val icons = listOf("gem", "shards", "keep", "builder", "timer", "quests", "mail", "map", "raid", "bag", "settings",
        "trophy", "shield", "plus", "close", "locate", "layout", "alert", "overflow", "cache", "energy", "star").mapNotNull(::artResource)
    for (id in shell + icons) runCatching { ShellImages.background(resources, id) }
    gg.pixelkingdomwars.nativeclient.ui.kit.KitImages.prewarm(resources, listOf(R.drawable.gem_24, R.drawable.pkw_web_icon_shard,
        R.drawable.pkw_web_icon_keeptoken, R.drawable.pkw_web_builder, R.drawable.pkw_web_icon_timer))
}

/** The painted rectangle (left, top, right, bottom; right/bottom exclusive) of ARGB [pixels], or null when nothing is
 * painted. Icons are authored inside padded cells; a chip a few dp tall cannot afford to draw the padding. */
internal fun paintedBounds(pixels: IntArray, width: Int, height: Int, alphaFloor: Int = 16): IntArray? {
    require(width > 0 && height > 0 && pixels.size >= width * height)
    var left = width; var top = height; var right = 0; var bottom = 0
    for (y in 0 until height) for (x in 0 until width) if (pixels[y * width + x] ushr 24 > alphaFloor) {
        if (x < left) left = x; if (x >= right) right = x + 1; if (y < top) top = y; if (y >= bottom) bottom = y + 1
    }
    return if (right <= left || bottom <= top) null else intArrayOf(left, top, right, bottom)
}

@Composable private fun shellImage(id: Int): ImageBitmap {
    val resources = LocalContext.current.resources
    return remember(resources, id) { ShellImages.bitmap(resources, id) }
}

/** Draw at integer pixel boundaries with nearest sampling; never stretch a sprite's aspect ratio. */
@Composable fun GameArt(name: String, modifier: Modifier = Modifier, contentDescription: String? = null,
    /** Fit the icon's painted pixels, not its padded cell (whole-image resources only). */
    trimmed: Boolean = false) {
    // SOL is the code-drawn Solana mark at a whole scale (ui/kit/SolanaMark.kt), never the stretched 24 px bitmap.
    if (isSolanaMark(name)) { SolanaMark(24.dp, modifier, contentDescription); return }
    // A building's designed art (sheets/buildings/BuildingIconArt.kt) is drawn by BuildingArt in this box, never the old
    // dark atlas portrait nor an empty spacer.
    if (ownsBuildingArt(name)) {
        BoxWithConstraints(modifier.size(24.dp), contentAlignment = Alignment.Center) {
            BuildingArt(name, minOf(maxWidth, maxHeight), contentDescription = contentDescription)
        }
        return
    }
    val resources = LocalContext.current.resources
    val frames = remember(resources) { ShellImages.frames(resources) }
    val frameName = when {
        name == "building-wall" -> "wall5_t1_straight_intact_f1"
        name == "building-heroaltar" -> "hero_vex_portrait"
        name == "building-siegestool" -> "hero_theo_portrait"
        name == "army" -> "ui_portrait_highlander_t1"
        name == "build" -> "ui_portrait_keep_t1"
        name.startsWith("troop-") -> "ui_portrait_${name.removePrefix("troop-")}_t1"
        name.startsWith("building-") -> "ui_portrait_${name.removePrefix("building-")}_t1"
        else -> name
    }
    val resource = artResource(name) ?: artResource(frameName)
    val rect = if (resource == null) frames[frameName] else null
    // Unknown artwork remains empty rather than misidentifying a paid unit/building.
    if (resource == null && rect == null) { Spacer(modifier.size(24.dp)); return }
    val bitmap = shellImage(resource ?: R.drawable.pkw_web_ui_atlas)
    val painted = if (!trimmed || rect != null) null else remember(bitmap) {
        paintedBounds(IntArray(bitmap.width * bitmap.height).also { bitmap.readPixels(it) }, bitmap.width, bitmap.height)
    }
    val source = if (painted != null) IntOffset(painted[0], painted[1]) else if (rect == null) IntOffset.Zero else IntOffset(rect.getInt("x"), rect.getInt("y"))
    val extent = if (painted != null) IntSize(painted[2] - painted[0], painted[3] - painted[1])
        else if (rect == null) IntSize(bitmap.width, bitmap.height) else IntSize(rect.getInt("w"), rect.getInt("h"))
    Canvas(modifier.size(24.dp).then(if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription })) {
        val scale = minOf(size.width / extent.width, size.height / extent.height)
        val target = IntSize((extent.width * scale).roundToInt().coerceAtLeast(1), (extent.height * scale).roundToInt().coerceAtLeast(1))
        drawImage(bitmap, srcOffset = source, srcSize = extent,
            dstOffset = IntOffset(((size.width - target.width) / 2).roundToInt(), ((size.height - target.height) / 2).roundToInt()),
            dstSize = target, filterQuality = FilterQuality.None)
    }
}

/** Cover behavior used by the exact portrait/landscape title background on the web. */
@Composable fun TitleBackdrop(portrait: Boolean, modifier: Modifier = Modifier, brightness: Float = if(portrait)1f else .5f) =
    CoverBackdrop(if (portrait) R.drawable.pkw_web_title_portrait else R.drawable.pkw_web_title_landscape, modifier, brightness)

/** The owner-approved cinematic loading wallpaper (2026-09-25), the same painting as web brand_loading_bg_*. Each master
 * is half the Seeker's 2400x1080 panel, so the Seeker draws it at exactly 2x; other screens cover-crop, never stretch. */
@Composable fun LoadingBackdrop(portrait: Boolean, modifier: Modifier = Modifier, brightness: Float = .9f) =
    CoverBackdrop(if (portrait) R.drawable.pkw_web_loading_portrait else R.drawable.pkw_web_loading_landscape, modifier, brightness)

@Composable private fun CoverBackdrop(resource: Int, modifier: Modifier, brightness: Float) {
    val resources = LocalContext.current.resources
    // A painting already decoded is on the first frame: a backdrop recreated by a screen change never shows the gradient again.
    val prepared by produceState(ShellImages.cached(resource), resources, resource) {
        if (value == null) value = withContext(Dispatchers.IO) { runCatching { ShellImages.background(resources, resource) }.getOrNull() }
    }
    val bitmap = prepared ?: return
    Canvas(modifier) {
        val scale = maxOf(size.width / bitmap.width, size.height / bitmap.height)
        val target = IntSize((bitmap.width * scale).roundToInt(), (bitmap.height * scale).roundToInt())
        drawImage(bitmap, dstOffset = IntOffset(((size.width - target.width) / 2).roundToInt(), ((size.height - target.height) / 2).roundToInt()),
            dstSize = target, filterQuality = FilterQuality.None)
        if (brightness < 1f) drawRect(Color.Black.copy(alpha = 1f - brightness.coerceIn(0f,1f)))
    }
}

/** Insets are the source web HUD kit's border-image-slice values, in CSS px / Android dp. */
@Composable fun PixelPlate(kind: String, modifier: Modifier = Modifier, contentPadding: PaddingValues = PaddingValues(0.dp),
    /** False only for world-anchored plates (the army chips): a pan may start on one and a tap reaches the scene. */
    blocksScene: Boolean = true, content: @Composable BoxScope.() -> Unit) {
    // Second old-screen sweep (owner 2026-10-06): on the designed parchment the dark web bitmaps are the kit CREAM card;
    // a selected ("gold") plate takes the kit selected tint, a sunk tab the cream lip colour.
    if (onParchment()) {
        val tint = when (kind) {
            "gold" -> gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors.selectedTint
            "tab-sunk", "gold-sunk", "dock-sunk" -> gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors.creamLo
            else -> null
        }
        Box((if (blocksScene) modifier.blockSceneInput() else modifier)
            .drawBehind { drawPlate(gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind.CREAM, tint) },
            propagateMinConstraints = true) {
            Box(Modifier.padding(contentPadding).padding(start = 2.dp, top = 2.dp, end = 2.dp, bottom = 4.dp), content = content)
        }
        return
    }
    val (resource, x, y) = when (kind) {
        "bar" -> Triple(R.drawable.pkw_web_bar, 8, 6)
        "shard" -> Triple(R.drawable.pkw_web_shard, 3, 3)
        "keep" -> Triple(R.drawable.pkw_web_keep, 3, 3)
        "tab-sunk" -> Triple(R.drawable.pkw_web_tab_sunk, 4, 4)
        "gold" -> Triple(R.drawable.pkw_web_gold, 4, 4)
        "gold-sunk" -> Triple(R.drawable.pkw_web_gold_sunk, 4, 4)
        "dock" -> Triple(R.drawable.pkw_web_dock, 4, 4)
        "dock-sunk" -> Triple(R.drawable.pkw_web_dock_sunk, 4, 4)
        else -> Triple(R.drawable.pkw_web_tab, 4, 4)
    }
    val bitmap = shellImage(resource)
    Box(if (blocksScene) modifier.blockSceneInput() else modifier, propagateMinConstraints = true) {
        Canvas(Modifier.matchParentSize()) {
            val dx = minOf(x.dp.toPx().roundToInt(), size.width.roundToInt() / 2)
            val dy = minOf(y.dp.toPx().roundToInt(), size.height.roundToInt() / 2)
            val sx = intArrayOf(0, x, bitmap.width - x, bitmap.width)
            val sy = intArrayOf(0, y, bitmap.height - y, bitmap.height)
            val tx = intArrayOf(0, dx, size.width.roundToInt() - dx, size.width.roundToInt())
            val ty = intArrayOf(0, dy, size.height.roundToInt() - dy, size.height.roundToInt())
            for (row in 0..2) for (col in 0..2) {
                val w = tx[col + 1] - tx[col]; val h = ty[row + 1] - ty[row]
                if (w > 0 && h > 0) drawImage(bitmap, IntOffset(sx[col], sy[row]), IntSize(sx[col + 1] - sx[col], sy[row + 1] - sy[row]),
                    IntOffset(tx[col], ty[row]), IntSize(w, h), filterQuality = FilterQuality.None)
            }
        }
        Box(Modifier.padding(contentPadding), content = content)
    }
}

/** Original eight-frame crucible story. Decorative frame timing is web forge.css, not a game clock. */
@Composable fun ForgeScene(built: Boolean, modifier: Modifier = Modifier) {
    val bitmap = shellImage(R.drawable.pkw_web_forge_scene)
    val reduced = LocalReducedMotion.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var frame by remember { mutableIntStateOf(0) }
    LaunchedEffect(built, reduced, lifecycle) {
        frame = if(reduced)4 else 0
        if(built && !reduced) lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while(true) { delay(200); frame = (frame + 1) % 8 }
        }
    }
    Box(modifier.fillMaxWidth().height(200.dp).background(Palette.card).clipToBounds(), contentAlignment = Alignment.BottomCenter) {
        Canvas(Modifier.fillMaxSize().semantics { contentDescription = "Goblin smelters feeding shards to the crucible and drawing minted KEEP off the press" }) {
            val width = minOf(352.dp.toPx(), size.width)
            val height = width * 108f / 176f
            drawImage(bitmap, srcOffset = IntOffset(frame * 176, 0), srcSize = IntSize(176,108),
                dstOffset = IntOffset(((size.width-width)/2).roundToInt(), (size.height-height+14.dp.toPx()).roundToInt()),
                dstSize = IntSize(width.roundToInt(),height.roundToInt()), filterQuality = FilterQuality.None,
                colorFilter = if(built)null else ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(.4f) }), alpha = if(built)1f else .32f)
        }
        if(!built) Text("NOT BUILT", Modifier.align(Alignment.Center), color = Palette.danger, fontSize = 16.sp, letterSpacing = 2.sp)
    }
}
