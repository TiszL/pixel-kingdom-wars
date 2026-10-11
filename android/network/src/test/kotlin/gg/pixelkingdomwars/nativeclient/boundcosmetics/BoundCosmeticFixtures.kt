package gg.pixelkingdomwars.nativeclient.boundcosmetics

import kotlinx.serialization.json.*
import org.junit.Assert.assertThrows

/** Byte-identical private loopback HTTP capture; synthetic mutations below are negative test cases.
 * No production-login, live chain, native pixel or asset admission evidence is implied. */
internal object BoundCosmeticFixtures {
    val bytes: ByteArray get() = requireNotNull(javaClass.getResourceAsStream("/boundcosmetics/final-actual-http.json")).use { it.readBytes() }
    fun raw(): JsonObject = cosmeticJson.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
    val wallet get() = raw().getValue("wallet").jsonPrimitive.content
    val base get() = raw().getValue("selectedBase").jsonObject.getValue("baseId").jsonPrimitive.content
    val identity get() = BoundCosmeticIdentity("https://game.test", "devnet", wallet)
    // Exact fixture scope, not a copied Market tier rule. Other levels fail unless a test injects its own catalogue.
    val rules get() = BoundCosmeticWorkshopRules(1) { level -> require(level == 1L); "artisan_market_awning_t1" }
    fun view(raw: JsonObject = raw()) = BoundCosmeticWorkshopView.from(raw, wallet, base, rules)
    fun proof() = BoundCosmeticProof.from(raw().getValue("originals").jsonArray.single().jsonObject)
    fun command() = proof().receipt!!.let { BoundCosmeticCommand(it.request, it.recipe, it.appearance) }
    fun encode(proof: BoundCosmeticProof) = cosmeticJson.encodeToJsonElement(BoundCosmeticProof.serializer(), proof).jsonObject
    fun encode(command: BoundCosmeticCommand) = cosmeticJson.encodeToJsonElement(BoundCosmeticCommand.serializer(), command).jsonObject
    fun edit(raw: JsonObject, key: String, value: JsonElement) = JsonObject(raw + (key to value))
    fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }
}
