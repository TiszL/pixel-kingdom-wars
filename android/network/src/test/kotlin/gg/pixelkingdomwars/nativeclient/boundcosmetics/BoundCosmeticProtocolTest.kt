package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.bytes
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.raw
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.wallet
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.base
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.identity
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.rules
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.view
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.proof
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.command
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.encode
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.edit
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.rejects
import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BoundCosmeticProtocolTest {
    @Test fun `actual private HTTP bytes preserve four server recipes and original completion`() {
        assertEquals(9319, bytes.size)
        assertEquals("0bda5050d8770431a43156070ba10b7ebe947f82d8a21750c9ee2d2090e9d645", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        val parsed = view(); assertEquals(awningRecipes, parsed.recipes.map { it.recipe.recipeId }); assertEquals(1, parsed.originals.size)
        assertNotNull(parsed.originals.single().completion); assertEquals(proof(), parsed.originals.single())
        assertEquals(raw().getValue("recipes").jsonArray.first().jsonObject.getValue("recipe"), cosmeticJson.encodeToJsonElement(BoundCosmeticRecipe.serializer(), parsed.recipes.first().recipe))
        assertFalse((parsed.selectedBase as BoundCosmeticSelectedBase.Available).preference.enabled)
    }
    @Test fun `strict scalar kinds and exact keys prevent schema coercion or silent fields`() {
        listOf("version" to JsonPrimitive("1"), "acceptingJobs" to JsonPrimitive("true"), "wallet" to JsonPrimitive(23), "unknownField" to JsonNull)
            .forEach { (key, value) -> rejects { view(edit(raw(), key, value)) } }
        val request = command().request.body()
        rejects { BoundCosmeticRequest.from(edit(request, "recipeVersion", JsonPrimitive("1"))) }
        rejects { BoundCosmeticRequest.from(edit(request, "quantity", JsonPrimitive(1))) }
        rejects { BoundCosmeticRequest.from(JsonObject(request - "baseId")) }
    }
    @Test fun `invalid decimal UUID hash timestamp and safe integer are refused`() {
        val c = command()
        listOf("01", "-1", "1.0", "9223372036854775808").forEach { q -> rejects { c.copy(recipe = c.recipe.copy(inputs = listOf(c.recipe.inputs.first().copy(quantity = q)))).validate() } }
        rejects { c.request.copy(baseId = "../../base").validate() }; rejects { c.request.copy(appearanceBindingSha256 = "A".repeat(64)).validate() }
        rejects { c.request.copy(recipeVersion = 9_007_199_254_740_992).validate() }
        rejects { proof().copy(serverNow = "2026-09-29T18:33:13Z").validate() }
        rejects { proof().copy(serverNow = "2026-02-30T18:33:13.335Z").validate() }
    }
    @Test fun `identity and immutable original must match beyond request key`() {
        val p = proof(); val c = command(); p.match(identity, c)
        rejects { p.match(identity.copy(wallet = "11111111111111111111111111111111"), c) }
        rejects { p.match(identity, c.copy(recipe = c.recipe.copy(durationSec = c.recipe.durationSec + 1))) }
        rejects { p.match(identity, c.copy(appearance = c.appearance.copy(sourceIndexSha256 = "0".repeat(64)))) }
        rejects { p.copy(receipt = p.receipt!!.copy(request = c.request.copy(baseId = "00000000-0000-4000-8000-000000000009"))).match(identity, c) }
    }
    @Test fun `server sourced quantities persist without a copied native cost table`() {
        val c = command(); val custom = c.copy(recipe = c.recipe.copy(durationSec = 71, inputs = c.recipe.inputs.map { it.copy(quantity = "17") }, requiredFacility = c.recipe.requiredFacility.copy(level = 3)))
        val parsed = BoundCosmeticCommand.from(encode(custom)); assertEquals(custom, parsed)
        rejects { proof().match(identity, custom) }
        // Parsing the new values is not authority to use them for a current craft or replace original terms.
    }
    @Test fun `appearance source recipe and blueprint bindings cannot diverge`() {
        val c = command(); rejects { c.copy(appearance = c.appearance.copy(sourceId = "artisan-market-t2")).validate() }
        rejects { c.copy(request = c.request.copy(appearanceBindingSha256 = "0".repeat(64))).validate() }
        rejects { c.copy(recipe = c.recipe.copy(blueprintId = "other_blueprint")).validate() }
        rejects { c.copy(recipe = c.recipe.copy(inputs = c.recipe.inputs + c.recipe.inputs.first())).validate() }
    }
    @Test fun `original observation cannot precede start completion blueprint or duration`() {
        val p = proof(); val r = p.receipt!!
        rejects { p.copy(serverNow = r.startedAt).validate() }
        rejects { p.copy(receipt = r.copy(readyAt = r.startedAt)).validate() }
        rejects { p.copy(receipt = r.copy(blueprint = r.blueprint.copy(completedAt = r.readyAt))).validate() }
        rejects { p.copy(completion = BoundCosmeticCompletion(r.startedAt)).validate() }
        rejects { p.copy(status = "unknown").validate() }
    }
    @Test fun `future or foreign current facts cannot publish into selected account`() {
        rejects { BoundCosmeticWorkshopView.from(raw(), "11111111111111111111111111111111", base, rules) }
        rejects { BoundCosmeticWorkshopView.from(raw(), wallet, null, rules) }
        rejects { view(edit(raw(), "serverNow", JsonPrimitive(proof().receipt!!.startedAt))) }
        rejects { view(edit(raw(), "applicationReady", JsonPrimitive(false))) }
        val bp = raw().getValue("blueprint").jsonObject; val proof = bp.getValue("proof").jsonObject
        rejects { view(edit(raw(), "blueprint", edit(bp, "proof", edit(proof, "completedAt", JsonPrimitive("2099-01-01T00:00:00.000Z"))))) }
    }
    @Test fun `catalogue originals stock and facilities have exact unique identity closure`() {
        val r = raw(); rejects { view(edit(r, "recipes", JsonArray(r.getValue("recipes").jsonArray.reversed()))) }
        rejects { view(edit(r, "originals", JsonArray(listOf(r.getValue("originals").jsonArray.single(), r.getValue("originals").jsonArray.single())))) }
        val b = r.getValue("selectedBase").jsonObject
        rejects { view(edit(r, "selectedBase", edit(b, "craftingStock", JsonArray(b.getValue("craftingStock").jsonArray.dropLast(1))))) }
        rejects { view(edit(r, "selectedBase", edit(b, "workshops", b.getValue("markets")))) }
        rejects { view(edit(r, "selectedBase", edit(b, "preference", buildJsonObject { put("enabled", true); put("revision", "0") }))) }
    }
    @Test fun `account history and unavailable current base remain distinct from empty stock`() {
        val r = raw(); val b = buildJsonObject { put("state", "unavailable"); put("baseId", base); put("reason", "DEED_AUTHORITY_UNAVAILABLE") }
        val parsed = view(edit(r, "selectedBase", b)); assertTrue(parsed.selectedBase is BoundCosmeticSelectedBase.Unavailable); assertEquals(1, parsed.originals.size)
        rejects { view(edit(r, "selectedBase", edit(b, "craftingStock", JsonArray(emptyList())))) }
        val account = BoundCosmeticWorkshopView.from(edit(r, "selectedBase", JsonNull), wallet, null, rules)
        assertNull(account.selectedBase); assertEquals(1, account.originals.size)
    }
    @Test fun `completed Market visual needs externally admitted tier and exact same snapshot building`() {
        val p = BoundCosmeticBaseRead("available", BoundCosmeticBaseVisual(1, listOf(BoundCosmeticAwning(base, command().appearance))))
        val building = BoundCosmeticVisualBuilding(base, "market", 123, false); var observed = 0L
        p.match(listOf(building)) { observed = it; command().appearance.outputId }; assertEquals(123, observed)
        rejects { p.match(listOf(building.copy(underConstruction = true))) { command().appearance.outputId } }
        rejects { p.match(listOf(building, building)) { command().appearance.outputId } }
        rejects { p.match(listOf(building)) { "artisan_market_awning_t2" } }
        rejects { p.copy(visual = p.visual!!.copy(marketAwnings = p.visual.marketAwnings + p.visual.marketAwnings)).validate() }
        assertNotEquals(BoundCosmeticBaseRead("unavailable", null), BoundCosmeticBaseRead("available", BoundCosmeticBaseVisual(1, emptyList())))
    }
    @Test fun `preference CAS uses exact decimal revision and cannot imply visual availability`() {
        val request = BoundCosmeticPreferenceRequest(base, false, "9223372036854775806")
        BoundCosmeticPreferenceRequest.from(request.body()); val response = BoundCosmeticPreferenceResponse(base, false, "9223372036854775807", BoundCosmeticBaseRead("unavailable", null))
        response.match(request); assertNull(response.visual.visual)
        rejects { request.copy(expectedRevision = "9223372036854775807").validate() }
        rejects { request.copy(expectedRevision = "00").validate() }
        rejects { response.copy(enabled = true).match(request) }; rejects { response.copy(revision = request.expectedRevision).match(request) }
        rejects { response.copy(revision = "9223372036854775808").validate() }
        val b = raw().getValue("selectedBase").jsonObject
        rejects { view(edit(raw(), "selectedBase", edit(b, "preference", buildJsonObject { put("enabled", false); put("revision", "9223372036854775808") }))) }
        rejects { BoundCosmeticPreferenceRequest.from(edit(request.body(), "enabled", JsonPrimitive("false"))) }
    }
    @Test fun `shared queue retains all three recipe families deadlines and caller supplied capacity`() {
        val r = raw(); val baseRaw = r.getValue("selectedBase").jsonObject; val c = command()
        val now = r.getValue("serverNow").jsonPrimitive.content; val ready = java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(java.time.Instant.parse(now).plusSeconds(c.recipe.durationSec))
        val job = buildJsonObject { put("kind", "cosmetic"); put("jobId", c.key); put("recipe", cosmeticJson.encodeToJsonElement(BoundCosmeticRecipe.serializer(), c.recipe)); put("startedAt", now); put("readyAt", ready) }
        val parsed = view(edit(r, "selectedBase", edit(baseRaw, "queue", JsonArray(listOf(job)))))
        assertEquals("cosmetic", (parsed.selectedBase as BoundCosmeticSelectedBase.Available).queue.single().kind)
        rejects { view(edit(r, "selectedBase", edit(baseRaw, "queue", JsonArray(listOf(edit(job, "readyAt", JsonPrimitive(now))))))) }
        rejects { view(edit(r, "selectedBase", edit(baseRaw, "queue", JsonArray(listOf(job, job))))) }
        for ((kind, output) in listOf("ordinary" to "heartwood_beams", "equipment" to "route_compass")) {
            val recipe = buildJsonObject { put("recipeVersion", 1); put("recipeId", if (kind == "ordinary") "refine_$output" else "craft_$output"); put("quantity", 1); put("durationSec", c.recipe.durationSec)
                put("inputs", buildJsonArray { if (kind == "ordinary") add(buildJsonObject { put("kind", "raw"); put("itemId", "heartwood_logs"); put("quantity", "7") }) else {
                    for (item in listOf("prismstone_lens", "crownsteel")) add(buildJsonObject { put("kind", "crafting"); put("itemId", item); put("quantity", "7") }) } })
                put("output", buildJsonObject { put("itemId", output); put("quantity", "1") }) }
            val other = edit(edit(job, "kind", JsonPrimitive(kind)), "recipe", recipe)
            val queue = (view(edit(r, "selectedBase", edit(baseRaw, "queue", JsonArray(listOf(other))))).selectedBase as BoundCosmeticSelectedBase.Available).queue
            assertEquals(kind, queue.single().kind); assertEquals(recipe, queue.single().recipe)
        }
    }
}
