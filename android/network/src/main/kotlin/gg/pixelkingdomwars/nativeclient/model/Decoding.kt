package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

/** Hand-written wire models decode with unknown keys ignored so additive server fields never
 * break an installed client. Money and count values that the server may send as JSON numbers
 * are kept as their exact decimal text: no float ever touches a balance. */
val ApiJson: Json = Json { ignoreUnknownKeys = true; coerceInputValues = false; explicitNulls = false }

inline fun <reified T> JsonObject.decode(): T = ApiJson.decodeFromJsonElement(this)

/** Accepts a JSON string or number and preserves its exact text (`"9007199254740993"`, `15`). */
object DecimalStringSerializer : KSerializer<String> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("DecimalString", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): String {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val primitive = element as? JsonPrimitive ?: throw IllegalArgumentException("Expected a decimal value")
        require(primitive !is JsonNull) { "Expected a decimal value" }
        return primitive.content
    }
    override fun serialize(encoder: Encoder, value: String) = encoder.encodeString(value)
}

/** Accepts a JSON number or a numeric string as an Int (levels, counts, steps). */
object LenientIntSerializer : KSerializer<Int> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("LenientInt", PrimitiveKind.INT)
    override fun deserialize(decoder: Decoder): Int {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val primitive = element as? JsonPrimitive ?: throw IllegalArgumentException("Expected a whole number")
        return requireNotNull(primitive.content.toIntOrNull()) { "Expected a whole number" }
    }
    override fun serialize(encoder: Encoder, value: Int) = encoder.encodeInt(value)
}
