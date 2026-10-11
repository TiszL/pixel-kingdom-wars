package gg.pixelkingdomwars.nativeclient

import com.badlogic.gdx.utils.JsonValue
import kotlinx.serialization.json.*

/** Builds the renderer's libGDX tree from an already parsed kotlinx tree, so one parse of the
 * render catalogue serves admission, the Compose scene adapter and the GL renderer. Numbers keep
 * their source text, and children are linked directly so the walk is linear in the tree size. */
internal fun JsonElement.toGdx(): JsonValue = when (this) {
    is JsonNull -> JsonValue(JsonValue.ValueType.nullValue)
    is JsonPrimitive -> when {
        isString -> JsonValue(content)
        content == "true" -> JsonValue(true)
        content == "false" -> JsonValue(false)
        else -> content.toLongOrNull()?.let { JsonValue(it, content) } ?: JsonValue(content.toDouble(), content)
    }
    is JsonArray -> JsonValue(JsonValue.ValueType.array).link(map { it.toGdx() })
    is JsonObject -> JsonValue(JsonValue.ValueType.`object`).link(entries.map { (key, value) -> value.toGdx().also { it.name = key } })
}

private fun JsonValue.link(children: List<JsonValue>): JsonValue {
    var previous: JsonValue? = null
    for (child in children) {
        child.parent = this; child.prev = previous
        if (previous == null) this.child = child else previous.next = child
        previous = child
    }
    size = children.size
    return this
}
