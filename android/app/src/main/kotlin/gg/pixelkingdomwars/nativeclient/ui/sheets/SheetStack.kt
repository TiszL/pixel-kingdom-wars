package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import java.util.Collections
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Non-secret lifecycle identity. [sessionId] identifies the authenticated session generation,
 * never an auth token/cookie or just a wallet. The host supplies AccountState's current
 * [baseSelectionGeneration] even while its selected base ID is still unchanged.
 * Restoration requires this exact identity; a new session/selection starts empty.
 */
data class SheetScope(val sessionId: String, val baseId: String, val baseSelectionGeneration: Long = 0) {
    init {
        require(sessionId.isNotBlank() && sessionId.length <= MAX_SCOPE_ID_LENGTH)
        require(baseId.isNotBlank() && baseId.length <= MAX_SCOPE_ID_LENGTH)
        require(baseSelectionGeneration >= 0)
    }
}

/**
 * Navigation and scroll presentation only. No price, consent, idempotency key, or Seal belongs here.
 * [restored] tells the owning sheet to obtain its current/recovery state through its existing reads;
 * it is a rendering hint, never permission to submit or a substitute for the owner's money safeguards.
 */
data class SheetEntry(
    val destination: Destination,
    val selectedTab: String? = null,
    val scrollIndex: Int = 0,
    val scrollOffset: Int = 0,
    val restored: Boolean = false,
) {
    init {
        require(scrollIndex >= 0)
        require(scrollOffset >= 0)
    }
}

/**
 * Immutable, bounded sheet history. A tab change updates the current entry rather than pushing one.
 * Destination admission (registry gates and scene-versus-sheet routing) remains with the host.
 * FocusBuilding is a transient host command: the host resolves it before rendering its eventual sheet.
 * It and anything above it are omitted from saved history so restoration cannot replay that command.
 *
 * [save] returns a String suitable for rememberSaveable/SavedState; [restore] must receive the current
 * scope before a restored entry is rendered. Only this format, not direct Destination serialization,
 * is a supported way to restore a stack.
 */
class SheetStack(entries: List<SheetEntry> = emptyList()) {
    val entries: List<SheetEntry> = Collections.unmodifiableList(ArrayList(entries))
    val top: SheetEntry? get() = entries.lastOrNull()
    val depth: Int get() = entries.size
    val isEmpty: Boolean get() = entries.isEmpty()

    init {
        require(this.entries.size <= MAX_DEPTH)
    }

    fun push(destination: Destination): SheetStack = push(SheetEntry(destination))

    fun push(entry: SheetEntry): SheetStack = SheetStack(
        (if (depth < MAX_DEPTH) entries else entries.dropLast(1)) + entry
    )

    fun replace(destination: Destination): SheetStack = replace(SheetEntry(destination))

    fun replace(entry: SheetEntry): SheetStack = SheetStack(entries.dropLast(1) + entry)

    fun pop(): SheetStack = if (isEmpty) this else SheetStack(entries.dropLast(1))

    fun updateTop(
        selectedTab: String? = top?.selectedTab,
        scrollIndex: Int = top?.scrollIndex ?: 0,
        scrollOffset: Int = top?.scrollOffset ?: 0,
    ): SheetStack {
        val current = top ?: return this
        return replace(current.copy(selectedTab = selectedTab, scrollIndex = scrollIndex, scrollOffset = scrollOffset))
    }

    fun clear(): SheetStack = if (isEmpty) this else SheetStack()

    fun save(scope: SheetScope): String = buildJsonObject {
        put("version", SAVED_VERSION)
        put("scope", scope.toSavedJson())
        put("entries", savedEntries())
    }.toString()

    override fun equals(other: Any?): Boolean = other is SheetStack && entries == other.entries
    override fun hashCode(): Int = entries.hashCode()
    override fun toString(): String = "SheetStack(entries=$entries)"

    internal fun savedEntries(): JsonArray = JsonArray(
        entries.takeWhile { it.destination !is Destination.FocusBuilding }.map { entry ->
            buildJsonObject {
                put("destination", sheetJson.encodeToJsonElement(Destination.serializer(), entry.destination))
                put("selectedTab", entry.selectedTab?.let(::JsonPrimitive) ?: JsonNull)
                put("scrollIndex", entry.scrollIndex)
                put("scrollOffset", entry.scrollOffset)
            }
        }
    )

    companion object {
        const val MAX_DEPTH = 3

        fun restore(saved: String?, scope: SheetScope): SheetStack {
            val envelope = savedEnvelope(saved, scope) ?: return SheetStack()
            return restoreEntries(envelope["entries"])
        }

        /** An invalid parent also drops its children; restoration never invents a replacement route. */
        internal fun restoreEntries(value: JsonElement?): SheetStack {
            val saved = value as? JsonArray ?: return SheetStack()
            if (saved.size > MAX_DEPTH) return SheetStack()
            val entries = ArrayList<SheetEntry>(saved.size)
            for (item in saved) {
                val entry = restoreEntry(item) ?: break
                entries += entry
            }
            return SheetStack(entries)
        }
    }
}

/** The two Home hosts keep independent histories; this uses the existing HomeTab identity. */
data class HomeSheetStacks(
    val scope: SheetScope,
    val selectedTab: HomeTab = HomeTab.KINGDOM,
    val kingdom: SheetStack = SheetStack(),
    val world: SheetStack = SheetStack(),
) {
    init {
        require(selectedTab == HomeTab.KINGDOM || selectedTab == HomeTab.WORLD)
    }

    val active: SheetStack get() = if (selectedTab == HomeTab.WORLD) world else kingdom

    fun selectTab(tab: HomeTab): HomeSheetStacks {
        require(tab == HomeTab.KINGDOM || tab == HomeTab.WORLD)
        return if (tab == selectedTab) this else copy(selectedTab = tab)
    }

    fun push(destination: Destination): HomeSheetStacks = withActive(active.push(destination))
    fun push(entry: SheetEntry): HomeSheetStacks = withActive(active.push(entry))
    fun replace(destination: Destination): HomeSheetStacks = withActive(active.replace(destination))
    fun replace(entry: SheetEntry): HomeSheetStacks = withActive(active.replace(entry))
    fun pop(): HomeSheetStacks = withActive(active.pop())

    fun updateTop(
        selectedTab: String? = active.top?.selectedTab,
        scrollIndex: Int = active.top?.scrollIndex ?: 0,
        scrollOffset: Int = active.top?.scrollOffset ?: 0,
    ): HomeSheetStacks = withActive(active.updateTop(selectedTab, scrollIndex, scrollOffset))

    /** A deliberate World → Kingdom handoff has no Back path into either previous sheet history. */
    fun handoffHome(destination: Destination): HomeSheetStacks = HomeSheetStacks(
        scope = scope,
        kingdom = SheetStack().push(destination),
    )

    fun clear(): HomeSheetStacks = HomeSheetStacks(scope)

    /** Call before rendering on every session/base/selection-generation change, including A → B → A. */
    fun forScope(scope: SheetScope): HomeSheetStacks = if (this.scope == scope) this else HomeSheetStacks(scope)

    fun save(): String = buildJsonObject {
        put("version", SAVED_VERSION)
        put("scope", scope.toSavedJson())
        put("selectedTab", selectedTab.name)
        put("kingdom", kingdom.savedEntries())
        put("world", world.savedEntries())
    }.toString()

    private fun withActive(stack: SheetStack): HomeSheetStacks = when {
        stack === active -> this
        selectedTab == HomeTab.WORLD -> copy(world = stack)
        else -> copy(kingdom = stack)
    }

    companion object {
        fun restore(saved: String?, scope: SheetScope): HomeSheetStacks {
            val envelope = savedEnvelope(saved, scope) ?: return HomeSheetStacks(scope)
            val tab = when (envelope["selectedTab"].stringOrNull()) {
                HomeTab.KINGDOM.name -> HomeTab.KINGDOM
                HomeTab.WORLD.name -> HomeTab.WORLD
                else -> return HomeSheetStacks(scope)
            }
            return HomeSheetStacks(
                scope = scope,
                selectedTab = tab,
                kingdom = SheetStack.restoreEntries(envelope["kingdom"]),
                world = SheetStack.restoreEntries(envelope["world"]),
            )
        }
    }
}

private const val SAVED_VERSION = 1
private const val MAX_SCOPE_ID_LENGTH = 256
private const val MAX_SAVED_CHARS = 65_536
private const val MAX_JSON_DEPTH = 32
// MS-B's Destination contract rejects additional fields, including injected money intent.
// Envelope/entry metadata is read explicitly below, so harmless outer keys remain discarded.
private val sheetJson = Json { ignoreUnknownKeys = false }

private fun SheetScope.toSavedJson(): JsonObject = buildJsonObject {
    put("sessionId", sessionId)
    put("baseId", baseId)
    // Version-1 payloads without this field describe generation zero only.
    if (baseSelectionGeneration != 0L) put("baseSelectionGeneration", baseSelectionGeneration)
}

private fun savedEnvelope(saved: String?, scope: SheetScope): JsonObject? {
    if (saved == null || saved.length > MAX_SAVED_CHARS || !saved.hasBoundedJsonDepth()) return null
    val envelope = try {
        sheetJson.parseToJsonElement(saved) as? JsonObject
    } catch (_: Exception) {
        null
    } ?: return null
    if (envelope["version"].integerOrNull() != SAVED_VERSION) return null
    val identity = envelope["scope"] as? JsonObject ?: return null
    if (identity["sessionId"].stringOrNull() != scope.sessionId ||
        identity["baseId"].stringOrNull() != scope.baseId) return null
    val generation = if ("baseSelectionGeneration" !in identity) 0L
        else (identity["baseSelectionGeneration"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            ?: return null
    if (generation != scope.baseSelectionGeneration) return null
    return envelope
}

private fun restoreEntry(value: JsonElement): SheetEntry? {
    val entry = value as? JsonObject ?: return null
    val encodedDestination = entry["destination"] as? JsonObject ?: return null
    val destination = try {
        sheetJson.decodeFromJsonElement(Destination.serializer(), encodedDestination)
    } catch (_: Exception) {
        return null
    }
    if (destination is Destination.FocusBuilding) return null
    val selectedTab = when (val tab = entry["selectedTab"]) {
        JsonNull -> null
        else -> tab.stringOrNull() ?: return null
    }
    val index = entry["scrollIndex"].integerOrNull()?.takeIf { it >= 0 } ?: return null
    val offset = entry["scrollOffset"].integerOrNull()?.takeIf { it >= 0 } ?: return null
    return SheetEntry(destination, selectedTab, index, offset, restored = true)
}

private fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.integerOrNull(): Int? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

/** Bound parser work for corrupt saved state before asking the serializer to traverse nested input. */
private fun String.hasBoundedJsonDepth(): Boolean {
    var depth = 0
    var inString = false
    var escaped = false
    for (character in this) {
        if (inString) {
            when {
                escaped -> escaped = false
                character == '\\' -> escaped = true
                character == '"' -> inString = false
            }
        } else {
            when (character) {
                '"' -> inString = true
                '{', '[' -> if (++depth > MAX_JSON_DEPTH) return false
                '}', ']' -> if (--depth < 0) return false
            }
        }
    }
    return depth == 0 && !inString
}
