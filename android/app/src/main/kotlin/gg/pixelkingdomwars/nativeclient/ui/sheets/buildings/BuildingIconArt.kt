package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.os.Build
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import gg.pixelkingdomwars.nativeclient.network.NativeContentFile
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/*
 * THE building → art rule for every player-path building icon, portrait, header, well and placement ghost (owner,
 * 2026-10-06: "in some cases old building ICON is used for example barracks"). The old 56 px dark-box atlas portraits
 * (`ui_portrait_<building>_t<n>`) are never chosen for a building any more:
 * - Keep: the realm-kit idle strip of its own level (`ui:keep-l<n>-idle`, bundled, see [r2ArtDrawable]).
 * - Gold Forge: the Phase E tier art (`ui:goldforge-t<n>-idle`, bundled, see [buildingArtDrawable]).
 * - Every other ordinary building, defence and trap: its current-tier WORLD sprite from the admitted content pack
 *   (`pack:<type>-t<n>`, the same `ware_` / `v2_` frames the base scene draws; buildings/SPEC.md §5 names exactly these
 *   frames). While the frame decodes, the bundled tier-1 identity draws for the eleven types that have one.
 * - Walls, the Hero Altar / Siege Stool (hero portraits) and the Phase E services keep their existing producers.
 * Troop portraits, the hub's keep / clan-hall emblems and the campaign garrison mini portraits are designed dark-well
 * portraits (army/SPEC.md §8, hub/SPEC.md, account/SPEC.md) and are deliberately NOT routed here.
 * No art is made or edited: every name resolves to bytes already in the APK or in the pinned content pack.
 */

/** Building types whose current-tier world sprite is read from the content pack. */
internal val PACK_BUILDING_TYPES: Set<String> = setOf(
    "mine", "vault", "barracks", "forge", "camp", "clanhall", "dragonnest", "electrictower", "magetower",
    "archertower", "airdefence", "lasertower", "spiketrap", "pitfall", "powdermine", "airmine", "cannon", "mortar",
)

/** One pack frame: the atlas metadata path (manifest-pinned) and the frame's filename inside it. */
internal data class PackFrame(val atlas: String, val frame: String)

/** The resting frame the base scene shows for [type] at art [tier] (row 0 of a directional idle; a trap's armed look);
 *  null for a type the pack does not draw this way. Asset families: the Alchemy Lab is `alchemylab`, the Archer Tower
 *  `archer`; Cannon and Mortar are the v2 sheets. */
internal fun packBuildingFrame(type: String, tier: Int): PackFrame? {
    if (type !in PACK_BUILDING_TYPES || tier < 1) return null
    val family = when (type) { "forge" -> "alchemylab"; "archertower" -> "archer"; else -> type }
    val ware = "atlas/ware_${family}_$tier@1x.json"
    return when (type) {
        "cannon", "mortar" -> PackFrame("atlas/v2bld_${type}_t$tier@1x.json", "v2_bld_${type}_t${tier}_idle_d0_f1")
        "spiketrap", "pitfall", "powdermine" -> PackFrame(ware, "ware_trp_${family}_t${tier}_armed_f1")
        "airmine" -> PackFrame(ware, "ware_trp_${family}_t${tier}_arm_f1")
        "archertower", "airdefence", "lasertower" -> PackFrame(ware, "ware_bld_${family}_t${tier}_idle_d0_f1")
        else -> PackFrame(ware, "ware_bld_${family}_t${tier}_idle_f1")
    }
}

/** A pack building art name, `pack:<type>-t<tier>`. */
internal fun packBuildingArtName(type: String, tier: Int): String = "pack:$type-t$tier"

internal data class PackBuildingRef(val type: String, val tier: Int)

private val PACK_NAME = Regex("^pack:([a-z]+)-t([1-9][0-9]?)$")

/** The type and tier a `pack:` name stands for; null for any other name or an unknown type. */
internal fun packBuildingRef(name: String): PackBuildingRef? {
    val match = PACK_NAME.matchEntire(name) ?: return null
    val type = match.groupValues[1]
    return if (type in PACK_BUILDING_TYPES) PackBuildingRef(type, match.groupValues[2].toInt()) else null
}

/** The Keep's own realm-kit strip for its level (the strips are clamped to the bundled range when drawn). */
internal fun keepArtName(level: Int): String = "ui:keep-l${level.coerceAtLeast(1)}-idle"

/**
 * The designed art for a building of [type] at [level] and art [tier] (the catalogue's ART_V2 tier, computed by the
 * caller exactly as before). Null for a type with its own producer (wall, heroes, Phase E services, unknown).
 */
internal fun designedBuildingArt(type: String, level: Int, tier: Int): String? = when (type) {
    "keep" -> keepArtName(level)
    "goldforge" -> "ui:goldforge-t$tier-idle".takeIf { buildingArtDrawable(it) != null } ?: "ui:goldforge-t1-idle"
    in PACK_BUILDING_TYPES -> packBuildingArtName(type, tier.coerceAtLeast(1))
    else -> null
}

/** `building-<type>`, the tier-1 glyph some older producers still emit (a paid-upgrade plate), as designed art. The
 *  Keep is left alone: `building-keep` is the hub's emblem fallback, a designed portrait (hub/SPEC.md). */
internal fun legacyBuildingGlyphArt(name: String): String? {
    if (!name.startsWith("building-")) return null
    val type = name.removePrefix("building-")
    return if (type == "keep") null else designedBuildingArt(type, 1, 1)
}

/** True when [BuildingArt] draws [name] itself: the kit's PkwIcon and GameArt hand these over instead of falling to
 *  the old atlas (which draws an old dark-box portrait or nothing at all for them). */
internal fun ownsBuildingArt(name: String): Boolean =
    legacyBuildingGlyphArt(name) != null || packBuildingRef(name) != null ||
        ((name.startsWith("ui:") || name.startsWith("pkw_ui_")) && (buildingArtDrawable(name) != null || r2ArtDrawable(name) != null))

/** The admitted content generation pack sprites are read from. PkwApp provides it; previews and tests have none (the
 *  bundled identity, or an empty well, draws instead). */
@Stable internal class PackArtSource(val assets: File, private val manifest: NativeContentManifest) {
    private val pins: Map<String, NativeContentFile> by lazy { manifest.files.associateBy { it.path } }
    /** The manifest pin of a pack file; null when the generation does not carry it. */
    fun pin(path: String): NativeContentFile? = pins[path]
    /** Cache identity: a new content generation never reuses an older generation's pixels. */
    val key: String = assets.path + "|" + manifest.contentVersion
}

internal fun packArtSource(assets: File?, manifest: NativeContentManifest?): PackArtSource? =
    if (assets == null || manifest == null) null else PackArtSource(assets, manifest)

/** The pack sprites' source in scope (see [PackArtSource]). */
internal val LocalPackArt = compositionLocalOf<PackArtSource?> { null }

/** Decoded pack building frames, shared by every icon. Reads only manifest-pinned files inside the content root, at
 *  their pinned size; a missing, moved or undescribed frame is null (the caller keeps its fallback), never a guess. */
internal object PackSprites {
    private const val MAX_FRAMES = 64
    private val bitmaps = object : LinkedHashMap<String, ImageBitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ImageBitmap>?): Boolean = size > MAX_FRAMES
    }
    private val atlases = HashMap<String, JsonObject>()
    private val IMAGE = Regex("^[A-Za-z0-9_@.-]+\\.png$")

    fun key(source: PackArtSource, frame: PackFrame): String = source.key + "|" + frame.atlas + "|" + frame.frame

    @Synchronized fun cached(key: String): ImageBitmap? = bitmaps[key]

    /** Blocking: call off the main thread. */
    fun load(source: PackArtSource, frame: PackFrame): ImageBitmap? = try {
        val key = key(source, frame)
        cached(key) ?: decode(source, frame)?.also { image -> synchronized(this) { bitmaps[key] = image } }
    } catch (_: Exception) {
        null
    }

    private fun file(source: PackArtSource, root: File, relative: String): File? {
        val pin = source.pin(relative) ?: return null
        val file = File(root, relative).canonicalFile
        return file.takeIf { it.toPath().startsWith(root.toPath()) && it.isFile && it.length() == pin.size }
    }

    private fun atlas(source: PackArtSource, root: File, path: String): JsonObject? {
        val key = source.key + "|" + path
        synchronized(this) { atlases[key]?.let { return it } }
        val text = file(source, root, path)?.readText() ?: return null
        val parsed = Json.parseToJsonElement(text) as? JsonObject ?: return null
        return synchronized(this) { atlases.getOrPut(key) { parsed } }
    }

    private fun decode(source: PackArtSource, frame: PackFrame): ImageBitmap? {
        val root = source.assets.canonicalFile
        val atlas = atlas(source, root, frame.atlas) ?: return null
        val folder = frame.atlas.substringBeforeLast('/')
        for (page in (atlas["textures"] as? JsonArray).orEmpty()) {
            val texture = page as? JsonObject ?: continue
            val image = (texture["image"] as? JsonPrimitive)?.content ?: continue
            for (row in (texture["frames"] as? JsonArray).orEmpty()) {
                val cell = row as? JsonObject ?: continue
                if ((cell["filename"] as? JsonPrimitive)?.content != frame.frame) continue
                if ((cell["rotated"] as? JsonPrimitive)?.booleanOrNull != false) return null
                if ((cell["trimmed"] as? JsonPrimitive)?.booleanOrNull != false) return null
                if (!IMAGE.matches(image)) return null
                val box = cell["frame"] as? JsonObject ?: return null
                fun n(name: String): Int? = (box[name] as? JsonPrimitive)?.intOrNull
                val x = n("x") ?: return null; val y = n("y") ?: return null
                val w = n("w") ?: return null; val h = n("h") ?: return null
                val png = file(source, root, "$folder/$image") ?: return null
                return region(png, x, y, w, h)
            }
        }
        return null
    }

    private fun region(png: File, x: Int, y: Int, w: Int, h: Int): ImageBitmap? {
        @Suppress("DEPRECATION") // API 28–30 compatibility; the API 31 overload only drops isShareable.
        val decoder = if (Build.VERSION.SDK_INT >= 31) BitmapRegionDecoder.newInstance(png.absolutePath)
            else BitmapRegionDecoder.newInstance(png.absolutePath, false)
        val bitmap = try {
            val d = decoder ?: return null
            if (x < 0 || y < 0 || w <= 0 || h <= 0 || x.toLong() + w > d.width || y.toLong() + h > d.height) return null
            d.decodeRegion(Rect(x, y, x + w, y + h), BitmapFactory.Options().apply { inScaled = false })
        } finally {
            decoder?.recycle()
        }
        return bitmap?.asImageBitmap()
    }
}
