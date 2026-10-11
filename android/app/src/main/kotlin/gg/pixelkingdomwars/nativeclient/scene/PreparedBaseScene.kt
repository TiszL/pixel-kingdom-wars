package gg.pixelkingdomwars.nativeclient.scene

import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.renderer.RenderServiceFacts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** Retain the valid same-base scene while preparing fresh geometry and camp routes off Main. */
internal data class PreparedBaseSceneResult(val scene: BaseScene? = null, val failed: Boolean = false,
    val rawSource: JsonObject? = null) {
    /** A pending or failed changed response may retain geometry, never old service facts.
     * Bind the complete immutable payload, not merely its base ID. Equal data carries
     * equal authority and follows Compose's existing structural effect/state semantics. */
    fun forSource(raw: JsonObject): PreparedBaseSceneResult = if (rawSource === raw || rawSource == raw) this
        else withoutServices()
    /** The geometry alone: what a payload the server has not (re)confirmed this launch may draw ([LastBasePayload]). */
    fun withoutServices(): PreparedBaseSceneResult = copy(scene = scene?.copy(services = RenderServiceFacts()))
}

/** One Home payload as an effect key, equal only to itself. Home recomposes at least once a second (its display clock)
 *  and on every drag; `JsonObject.equals` walks the whole ~100 KB tree even for the SAME instance, so keying the
 *  preparation on the payload itself cost two full-tree comparisons per recomposition. */
internal class BaseSourceKey(val raw: JsonObject)

/** Hands out one [BaseSourceKey] per distinct payload CONTENT: the same instance is recognised by identity, and a new
 *  instance is compared with the current key's payload once, when it first arrives. An equal answer (a routine re-read
 *  that changed nothing) keeps the current key, so the scene is not prepared again; a changed answer gets a new key. */
internal class BaseSourceKeys {
    private var current: BaseSourceKey? = null
    private var seen: JsonObject? = null
    fun keyFor(raw: JsonObject): BaseSourceKey {
        val key = current
        if (key != null && (seen === raw || key.raw === raw)) return key
        seen = raw
        if (key != null && key.raw == raw) return key
        return BaseSourceKey(raw).also { current = it }
    }
}
/** Only fixed, account-free exception text reaches the DEBUG PKWVisual callback.
 * Serialization and dynamic mapper errors may embed response values, so omit unknown
 * text rather than logging the body, account identity, cause or stack trace. */
internal fun baseSceneFailureDiagnostic(error: Exception): String {
    val type = error.javaClass.simpleName.takeIf { it.matches(Regex("[A-Za-z_$][A-Za-z0-9_$]{0,127}")) } ?: "Exception"
    val message = when (error.message) {
        null -> "<no message>"
        "Failed requirement.", "Required value was null.", "Missing terrain contract",
        "The content pack has no grid contract", "Duplicate building health identity",
        "Service footprint differs from admitted geometry", "Service art tier differs from exported level mapping",
        "Market completed level is invalid", "Obstacle artwork is unavailable; update the native content pack" -> error.message
        else -> "<redacted>"
    }
    return "base scene preparation failed: $type: $message"
}

/** The last scene Home prepared, kept by its [KingdomViewModel][gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel]
 *  (which outlives the Kingdom composition), so a Home that left composition — the MAP or MORE tab, a standalone route, a
 *  battle — reopens on it in its first frame instead of an empty result behind "Opening your kingdom…", and the GL surface
 *  starts at once instead of after the payload is mapped again. One slot. It is recalled only for the same identity
 *  (session model + base) and the SAME catalogue instances it was mapped with (another content generation may not know
 *  its frame keys), and only while [PreparedBaseSceneResult.forSource] of the current payload returns it unchanged: a
 *  changed payload never seeds, so a stripped scene (the N-C5 rule) is never what a reopened Home starts from. */
internal class PreparedSceneMemory {
    private class Entry(val identity: Any, val catalogue: JsonObject, val render: JsonObject, val result: PreparedBaseSceneResult)
    private var entry: Entry? = null
    @Synchronized fun keep(identity: Any, catalogue: JsonObject, render: JsonObject, result: PreparedBaseSceneResult) {
        if (result.scene != null && !result.failed && result.rawSource != null) entry = Entry(identity, catalogue, render, result)
    }
    @Synchronized fun recall(identity: Any, catalogue: JsonObject, render: JsonObject, raw: JsonObject): PreparedBaseSceneResult? =
        entry?.takeIf { it.identity == identity && it.catalogue === catalogue && it.render === render }?.result
            ?.takeIf { it.forSource(raw) === it }
}

@Composable internal fun rememberPreparedBaseScene(identity: Any, raw: JsonObject, catalogue: JsonObject,
    render: JsonObject, log: (String) -> Unit, memory: PreparedSceneMemory? = null): PreparedBaseSceneResult {
    // The catalogues are keyed like the payload (BaseSourceKeys), never as remember keys themselves: Compose compares keys
    // with equals, and JsonObject.equals walks the whole tree even for the same instance — the ~8 MB render catalogue and
    // the catalogue on every Home recomposition (at least once a second).
    val catalogueKey = remember { BaseSourceKeys() }.keyFor(catalogue)
    val renderKey = remember { BaseSourceKeys() }.keyFor(render)
    val mapper = remember(catalogueKey,renderKey) { SceneMapper(catalogueKey.raw,renderKey.raw,log) }
    var prepared by remember(identity,mapper) {
        mutableStateOf(memory?.recall(identity, catalogueKey.raw, renderKey.raw, raw) ?: PreparedBaseSceneResult())
    }
    // Equal content keeps one key (see BaseSourceKeys): no re-preparation and no full-tree compare per recomposition.
    val keys = remember { BaseSourceKeys() }
    val source = keys.keyFor(raw)
    LaunchedEffect(identity,source,mapper) {
        val payload = source.raw
        // A Home reopened on the scene this exact payload already produced has nothing to map again.
        if (prepared.rawSource === payload && prepared.scene != null && !prepared.failed) {
            SceneLoadLog.mark(LoadEvent.SCENE_MAP, "seeded"); return@LaunchedEffect
        }
        val started = System.nanoTime()
        val next = withContext(Dispatchers.Default) {
            try { Result.success(mapper.baseScene(payload,checkpoint={coroutineContext.ensureActive()})) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { log(baseSceneFailureDiagnostic(error)); Result.failure(error) }
        }
        prepared = next.fold({ PreparedBaseSceneResult(it, rawSource = payload).also { result ->
            memory?.keep(identity, catalogueKey.raw, renderKey.raw, result) } }, { prepared.copy(failed = true) })
        SceneLoadLog.mark(LoadEvent.SCENE_MAP, "ms=${(System.nanoTime() - started) / 1_000_000} ok=${next.isSuccess}")
    }
    // Memoised per (result, key): while a changed payload is still preparing, the stripped copy is made once, not per pass.
    return remember(prepared, source) { prepared.forSource(source.raw) }
}
