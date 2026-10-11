package gg.pixelkingdomwars.nativeclient.vehicle

import gg.pixelkingdomwars.nativeclient.charter.*
import java.time.Instant
import kotlinx.serialization.json.*

/** Read-only crafting ABI. Every capability is false; no wire or issuer can be
 * supplied by these responses. Quantities and odds are server-owned values. */
object VehicleCraftProtocol {
    val families = listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")
    private val flags = setOf("materialReservationAuthorized", "signingAuthorized", "broadcastAuthorized", "reservationReleaseAuthorized")
    private val refined = setOf("frostglass", "heartwood_beams", "sunstone_blocks", "crownsteel", "prismstone_lens", "stormalloy", "thornsilk", "embercore")
    private fun fields(v: JsonObject, names: String, capabilities: Boolean = false) {
        require(v.keys == names.split(' ').toSet() + if (capabilities) flags else emptySet())
        if (capabilities) flags.forEach { require(!CharterGrammar.bool(v.getValue(it))) }
    }
    private fun version(v: JsonObject) { require(CharterGrammar.number(v.getValue("version")) == 1L) }
    private fun time(v: JsonElement, digits: Int) { CharterGrammar.timestamp(v); require(CharterGrammar.text(v).matches(Regex(".*\\.[0-9]{$digits}Z"))) }
    private fun target(v: JsonObject) {
        require(v.charterText("family") in families && CharterGrammar.number(v.getValue("tier")) in 1..4)
        require(CharterGrammar.number(v.getValue("recipeVersion")) == 1L)
    }
    private fun leaf(v: JsonObject) {
        require(v.charterText("kind") in listOf("refined", "fragment"))
        require(if (v.charterText("kind") == "fragment") v.charterText("itemId") == "crystal_fragment" else v.charterText("itemId") in refined)
    }
    fun recipe(v: JsonObject): JsonObject {
        fields(v, "recipeVersion family tier outputQuantity oddsBps inputs"); target(v)
        require(CharterGrammar.number(v.getValue("outputQuantity")) == 1L)
        require(CharterGrammar.number(v.getValue("oddsBps")) <= 10_000L)
        val rows = v.getValue("inputs").jsonArray.map { it.jsonObject }; require(rows.size in 1..32)
        rows.forEach { fields(it, "kind itemId quantity"); leaf(it); CharterGrammar.amount(it.getValue("quantity"), true) }
        val keys = rows.map { it.charterText("kind") + ":" + it.charterText("itemId") }
        require(keys.distinct().size == keys.size && keys == keys.sorted())
        return v
    }
    fun request(v: JsonObject) { fields(v, "baseId family tier recipeVersion"); CharterGrammar.id(v.getValue("baseId")); target(v) }
    fun quote(raw: JsonObject): JsonObject = VehicleProtocol.copy(raw).jsonObject.also { v ->
        fields(v, "version wallet baseId recipe recipeHash applicationFeeLamports ingredients serverNow", true); version(v)
        CharterGrammar.address(v.getValue("wallet")); CharterGrammar.id(v.getValue("baseId")); CharterGrammar.hex(v.getValue("recipeHash"), 32)
        time(v.getValue("serverNow"), 3); CharterGrammar.amount(v.getValue("applicationFeeLamports"), true)
        val recipe = recipe(v.charterObject("recipe")); val rows = v.getValue("ingredients").jsonArray
        require(rows.size == recipe.getValue("inputs").jsonArray.size)
        rows.forEachIndexed { i, x -> val line = x.jsonObject; val input = recipe.getValue("inputs").jsonArray[i].jsonObject
            fields(line, "kind itemId required available held"); leaf(line)
            require(line["kind"] == input["kind"] && line["itemId"] == input["itemId"] && line["required"] == input["quantity"])
            for (k in listOf("required", "available", "held")) CharterGrammar.amount(line.getValue(k), k == "required")
        }
    }
    fun record(raw: JsonObject): JsonObject = VehicleProtocol.copy(raw).jsonObject.also { v ->
        fields(v, "version wallet idempotencyKey reservationId baseId rootId attemptId identity recipe recipeHash materialHash reservedAt status consumedAt mintedAt serverNow", true); version(v)
        CharterGrammar.address(v.getValue("wallet")); for (k in listOf("idempotencyKey", "reservationId", "baseId")) CharterGrammar.id(v.getValue(k))
        for (k in listOf("rootId", "attemptId")) CharterGrammar.hex(v.getValue(k), 16)
        for (k in listOf("recipeHash", "materialHash")) CharterGrammar.hex(v.getValue(k), 32)
        val recipe = recipe(v.charterObject("recipe")); val identity = v.charterObject("identity"); fields(identity, "assetId collection family tier")
        for (k in listOf("assetId", "collection")) CharterGrammar.address(identity.getValue(k))
        require(identity["assetId"] != identity["collection"] && identity["family"] == recipe["family"] && identity["tier"] == recipe["tier"])
        time(v.getValue("reservedAt"), 6); time(v.getValue("serverNow"), 3)
        val status = v.charterText("status"); require(status in listOf("held", "paid_loss", "won_unminted", "minted"))
        require((v["consumedAt"] == JsonNull) == (status == "held")); require((v["mintedAt"] != JsonNull) == (status == "minted"))
        for (k in listOf("consumedAt", "mintedAt")) if (v[k] != JsonNull) {
            time(v.getValue(k), 6); require(Instant.parse(v.charterText(k)) >= Instant.parse(v.charterText("reservedAt")))
        }
        // The acquisition may have been recorded before a later material
        // recovery. These are independent journal times, not chain slot order.
    }
    fun history(raw: JsonObject): JsonObject = VehicleProtocol.copy(raw).jsonObject.also { v ->
        fields(v, "version wallet items nextCursor"); version(v); CharterGrammar.address(v.getValue("wallet"))
        val rows = v.getValue("items").jsonArray; require(rows.size <= 512)
        rows.forEach { require(record(it.jsonObject)["wallet"] == v["wallet"]) }
        for (k in listOf("idempotencyKey", "reservationId", "rootId", "attemptId")) require(rows.map { it.jsonObject[k] }.distinct().size == rows.size)
        if (v["nextCursor"] != JsonNull) cursor(v.charterText("nextCursor"))
    }
    fun recovery(raw: JsonObject): JsonObject = VehicleProtocol.copy(raw).jsonObject.also { v ->
        fields(v, "version wallet idempotencyKey status reason record"); version(v)
        val r = record(v.charterObject("record")); require(v["wallet"] == r["wallet"] && v["idempotencyKey"] == r["idempotencyKey"])
        require(v.charterText("status") in listOf("current", "held"))
        if (v.charterText("status") == "current") require(v["reason"] == JsonNull)
        else require(v.charterText("reason") in listOf("PROVIDER_UNAVAILABLE", "PROOF_UNAVAILABLE"))
    }
    fun original(v: JsonObject) = JsonObject(record(v) - setOf("status", "consumedAt", "mintedAt", "serverNow"))
    fun cursor(v: String) { require(v.length in 1..256 && v.matches(Regex("[A-Za-z0-9_-]+"))) }
    fun validateRequest(method: String, path: String, query: Map<String, String>, body: JsonObject?) {
        require('?' !in path && '#' !in path)
        if (method == "POST" && path == "/vehicles/craft/quote") { require(query.isEmpty()); request(requireNotNull(body)); return }
        if (method == "GET" && path == "/vehicles/craft/history") { require(body == null && query.keys.all { it == "cursor" }); query["cursor"]?.let(::cursor); return }
        val prefix = "/vehicles/craft/by-key/"; require(path.startsWith(prefix) && query.isEmpty())
        val parts = path.removePrefix(prefix).split('/'); CharterGrammar.id(JsonPrimitive(parts[0]))
        require(method == "GET" && parts.size == 1 && body == null || method == "POST" && parts.size == 2 && parts[1] == "recover" && body?.isEmpty() == true)
    }
}
