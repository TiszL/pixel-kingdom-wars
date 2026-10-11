package gg.pixelkingdomwars.nativeclient

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import kotlinx.serialization.json.*
import java.io.File

/** Parse completely before a caller publishes the directory or its display data. [rendererTree]
 * is the same render catalogue as the libGDX tree the renderer draws from. */
internal class AdmittedGameContent(val directory: File, val catalogue: JsonObject, val renderCatalogue: JsonObject, val rendererTree: JsonValue)

/** Reads and admits one generation's catalogues: one kotlinx parse of each file, one libGDX
 * conversion, and the real renderer parsers before anything is returned. Uncached. */
internal fun readValidatedGameContent(directory: File, onLoad: ((ContentLoadSample) -> Unit)? = null): AdmittedGameContent {
    val catalogueFile = File(directory, "catalogue.json")
    val catalogue = contentLoadWork(ContentLoadStage.CATALOGUE_READ, onLoad, 1, catalogueFile.length()) {
        Json.parseToJsonElement(catalogueFile.readText()).jsonObject
    }
    require(catalogue["schemaVersion"]?.jsonPrimitive?.int == 1)
    val renderFile = File(directory, "render-catalog.json")
    val text = contentLoadWork(ContentLoadStage.RENDER_READ, onLoad, 1, renderFile.length()) { renderFile.readText() }
    val render = contentLoadWork(ContentLoadStage.RENDER_DECODE, onLoad) { Json.parseToJsonElement(text).jsonObject }
    gg.pixelkingdomwars.nativeclient.network.ArchivedReplayPolicy.from(render["archivePresentation"] as? JsonObject)?.let { archive->
        require(archive.maximumSimVersion==catalogue["simVersion"]?.jsonPrimitive?.intOrNull) { "Archived replay policy belongs to a different content generation" }
    }
    val tree = contentLoadWork(ContentLoadStage.RENDER_ADMISSION, onLoad) { render.toGdx().also {
        RendererCatalogue.validate(it)
        RendererCatalogue.requireAcceptedRealmKits(it)
    } }
    return AdmittedGameContent(directory, catalogue, render, tree)
}

/** One parsed catalogue per verified generation for the whole process. Generations are immutable
 * and hash- or stamp-verified before this cache is consulted, so the directory is the key. At
 * most [RETAINED] generations stay parsed; [retainOnly] drops the rest once one is published. */
internal object GameContentCache {
    private const val RETAINED = 2
    private val entries = object : LinkedHashMap<String, AdmittedGameContent>(4, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, AdmittedGameContent>) = size > RETAINED
    }
    private fun key(directory: File) = directory.canonicalPath

    @Synchronized fun cached(directory: File): AdmittedGameContent? = entries[key(directory)]

    /** Parses outside the lock; a concurrent duplicate parse of the same generation is harmless. */
    fun admitted(directory: File, onLoad: ((ContentLoadSample) -> Unit)? = null): AdmittedGameContent {
        cached(directory)?.let { content ->
            // The updater calls admission again before activation. Recheck the production rule
            // even for a parsed tree, without another parse or a duplicate successful load sample.
            val start = System.nanoTime()
            try { RendererCatalogue.requireAcceptedRealmKits(content.rendererTree) }
            catch (error: Exception) {
                onLoad?.invoke(ContentLoadSample(ContentLoadStage.RENDER_ADMISSION, System.nanoTime() - start, 0, 0, false))
                throw error
            }
            return content
        }
        val content = readValidatedGameContent(directory, onLoad)
        synchronized(this) { return entries.getOrPut(key(directory)) { content } }
    }

    /** The renderer's view of the published parse. Falls back to a fresh admission if it was evicted. */
    fun rendererCatalogue(directory: File): JsonValue = admitted(directory).rendererTree

    @Synchronized fun retainOnly(directory: File) { val keep = key(directory); entries.keys.retainAll { it == keep } }

    @Synchronized internal fun clearForTest() { entries.clear() }
}
