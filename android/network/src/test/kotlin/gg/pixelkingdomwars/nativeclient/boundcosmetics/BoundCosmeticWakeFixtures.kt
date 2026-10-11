package gg.pixelkingdomwars.nativeclient.boundcosmetics

import kotlinx.serialization.json.*

/** Actual primary provider/HTTP DTO capture. The capture itself labels synthetic readiness for
 * before/pending/completed/on; runtime is a separate account with real normal startup admission false. */
internal object BoundCosmeticWakeFixtures {
    val bytes: ByteArray get() = requireNotNull(javaClass.getResourceAsStream("/boundcosmetics/wake-workshop-primary-pair.json")).use { it.readBytes() }
    fun pair() = cosmeticJson.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
    fun raw(name: String = "completed") = pair().getValue(name).jsonObject
    fun wallet(raw: JsonObject) = raw.getValue("wallet").jsonPrimitive.content
    fun base(raw: JsonObject) = (raw["selectedBase"] as? JsonObject)?.getValue("baseId")?.jsonPrimitive?.content
    // This isolated capture has one shared queue slot. This seam is not another native game policy.
    fun view(raw: JsonObject = raw()) = BoundCosmeticWakeWorkshopView.from(raw, wallet(raw), base(raw)) { 1 }
    fun pending() = BoundCosmeticProof.from(raw("original"))
    fun completed() = view().original!!
    val identity get() = BoundCosmeticIdentity("https://game.test", "devnet", pending().wallet)
    fun command() = pending().receipt!!.let { BoundCosmeticCommand(it.request, it.recipe, it.appearance) }
}
