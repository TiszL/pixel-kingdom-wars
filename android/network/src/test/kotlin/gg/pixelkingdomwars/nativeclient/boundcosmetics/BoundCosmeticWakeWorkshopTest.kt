package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.edit
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.rejects
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.raw
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.view
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.wallet
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.base
import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BoundCosmeticWakeWorkshopTest {
    @Test fun `authentic capture preserves source terms and distinct runtime accounts without claiming C5`() {
        val bytes = BoundCosmeticWakeFixtures.bytes
        assertEquals(27514, bytes.size)
        assertEquals("75259751b8d535b2af449ee7a0a752d29754dac21c61746a4fa26cb788181766", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        val before = view(raw("before")); val pending = view(raw("pending")); val completed = view()
        assertNull(before.original); assertNull(pending.original!!.completion); assertNotNull(completed.original!!.completion)
        assertEquals(before.wallet, pending.wallet); assertEquals(pending.wallet, completed.wallet)
        assertEquals(BoundCosmeticWakeFixtures.pending().receipt, pending.original.receipt)
        assertEquals(pending.original.receipt, completed.original.receipt)
        assertEquals(raw().getValue("recipe").jsonObject, cosmeticJson.encodeToJsonElement(BoundCosmeticCatalogueRow.serializer(), completed.recipe))
        val on = view(raw("on")); assertNotEquals(completed.wallet, on.wallet)
        assertEquals(on.original!!.receipt!!.appearance, on.preference.visual.visual!!.wake)
        val runtime = view(raw("runtime")); assertNotEquals(completed.wallet, runtime.wallet); assertNotEquals(on.wallet, runtime.wallet)
        assertFalse(runtime.applicationReady); assertFalse(runtime.acceptingJobs); assertNull(runtime.original)
        // The other fixture sections explicitly inject readiness; parsing true never admits a native consumer.
        assertTrue(BoundCosmeticWakeFixtures.pair().getValue("provenance").jsonPrimitive.content.contains("synthetic readiness"))
    }
    @Test fun `strict sibling rejects coercion private fields missing fields and the Awning view`() {
        for ((key, value) in listOf("version" to JsonPrimitive("1"), "applicationReady" to JsonPrimitive("true"), "acceptingJobs" to JsonPrimitive(1), "wallet" to JsonPrimitive(1), "price" to JsonNull)) {
            rejects { view(edit(raw(), key, value)) }
        }
        rejects { view(JsonObject(raw() - "original")) }; rejects { view(edit(raw(), "preference", JsonNull)) }
        rejects { view(BoundCosmeticFixtures.raw()) }
        rejects { BoundCosmeticWorkshopView.from(raw(), wallet(raw()), base(raw()), BoundCosmeticFixtures.rules) }
        val b = raw().getValue("selectedBase").jsonObject
        rejects { view(edit(raw(), "selectedBase", edit(b, "markets", JsonArray(emptyList())))) }
        val row = raw().getValue("recipe").jsonObject; val recipe = row.getValue("recipe").jsonObject
        rejects { view(edit(raw(), "recipe", edit(row, "recipe", edit(recipe, "durationSec", JsonPrimitive("1"))))) }
        rejects { view(edit(raw(), "recipe", BoundCosmeticFixtures.raw().getValue("recipes").jsonArray.first())) }
    }
    @Test fun `foreign identities and future observations cannot bind account original or selected stock`() {
        val r = raw(); val other = wallet(raw("runtime"))
        rejects { BoundCosmeticWakeWorkshopView.from(r, other, base(r)) { 1 } }
        rejects { BoundCosmeticWakeWorkshopView.from(r, wallet(r), base(raw("runtime"))) { 1 } }
        rejects { BoundCosmeticWakeWorkshopView.from(r, wallet(r), null) { 1 } }
        rejects { view(edit(r, "original", raw("on").getValue("original"))) }
        rejects { view(edit(r, "serverNow", JsonPrimitive(view().original!!.receipt!!.startedAt))) }
        rejects { view(edit(r, "applicationReady", JsonPrimitive(false))) }
        val bp = r.getValue("blueprint").jsonObject; val proof = bp.getValue("proof").jsonObject
        rejects { view(edit(r, "blueprint", edit(bp, "proof", edit(proof, "completedAt", JsonPrimitive("2099-01-01T00:00:00.000Z"))))) }
        val zero = edit(r, "wallet", JsonPrimitive("1".repeat(32)))
        rejects { BoundCosmeticWakeWorkshopView.from(zero, "1".repeat(32), base(r)) { 1 } }
    }
    @Test fun `selected appearance requires matching completed original while unavailable remains distinct from off`() {
        val r = raw("on"); val pref = r.getValue("preference").jsonObject; val original = r.getValue("original").jsonObject
        rejects { view(edit(r, "original", JsonNull)) }
        rejects { view(edit(r, "original", edit(original, "completion", JsonNull))) }
        rejects { view(edit(r, "preference", edit(pref, "enabled", JsonPrimitive(false)))) }
        rejects { view(edit(r, "preference", edit(pref, "revision", JsonPrimitive("0")))) }
        val visual = pref.getValue("visual").jsonObject; val body = visual.getValue("visual").jsonObject; val appearance = body.getValue("wake").jsonObject
        rejects { view(edit(r, "preference", edit(pref, "visual", edit(visual, "visual", edit(body, "wake", edit(appearance, "bindingSha256", JsonPrimitive("0".repeat(64)))))))) }
        val unavailable = buildJsonObject { put("state", "unavailable"); put("visual", JsonNull) }
        val parsed = view(edit(r, "preference", edit(pref, "visual", unavailable)))
        assertTrue(parsed.preference.enabled); assertEquals("unavailable", parsed.preference.visual.state)
        assertNotEquals(view(raw("before")).preference.visual, parsed.preference.visual)
    }
    @Test fun `account preference and unavailable stock survive missing catalogue without admitting fresh work`() {
        val r = raw(); val account = edit(r, "selectedBase", JsonNull)
        val parsed = BoundCosmeticWakeWorkshopView.from(account, wallet(r), null) { error("catalogue absent") }
        assertNotNull(parsed.original!!.completion); assertNull(parsed.selectedBase)
        val unavailable = buildJsonObject { put("state", "unavailable"); put("baseId", base(r)); put("reason", "DEED_AUTHORITY_UNAVAILABLE") }
        val held = BoundCosmeticWakeWorkshopView.from(edit(r, "selectedBase", unavailable), wallet(r), base(r)) { error("catalogue absent") }
        assertTrue(held.selectedBase is BoundCosmeticWakeSelectedBase.Unavailable)
        rejects { BoundCosmeticWakeWorkshopView.from(r, wallet(r), base(r)) { error("catalogue absent") } }
        rejects { view(edit(r, "selectedBase", edit(unavailable, "craftingStock", JsonArray(emptyList())))) }
    }
    @Test fun `exact protected stock facilities and shared queue use server facts and injected capacity`() {
        val r = raw("pending"); val b = r.getValue("selectedBase").jsonObject
        val parsed = view(r).selectedBase as BoundCosmeticWakeSelectedBase.Available
        assertEquals("cosmetic", parsed.queue.single().kind); assertEquals("craft_aurora_wake_v1", parsed.queue.single().recipe.getValue("recipeId").jsonPrimitive.content)
        rejects { view(edit(r, "selectedBase", edit(b, "craftingStock", JsonArray(b.getValue("craftingStock").jsonArray.dropLast(1))))) }
        rejects { view(edit(r, "selectedBase", edit(b, "lodges", b.getValue("workshops")))) }
        val lodge = b.getValue("lodges").jsonArray.first().jsonObject
        rejects { view(edit(r, "selectedBase", edit(b, "lodges", JsonArray(listOf(edit(lodge, "level", JsonPrimitive("1"))))))) }
        val queue = b.getValue("queue").jsonArray; val job = queue.single().jsonObject
        rejects { view(edit(r, "selectedBase", edit(b, "queue", JsonArray(listOf(job, job))))) }
        rejects { view(edit(r, "selectedBase", edit(b, "queue", JsonArray(listOf(edit(job, "readyAt", r.getValue("serverNow"))))))) }
        rejects { BoundCosmeticWakeWorkshopView.from(r, wallet(r), base(r)) { 0 } }
    }
    @Test fun `free account CAS excludes kingdom wallet and coercion and preserves unavailable result`() {
        val request = BoundCosmeticWakePreferenceRequest(false, "9223372036854775806")
        assertEquals(setOf("enabled", "expectedRevision"), request.body().keys)
        assertEquals(request, BoundCosmeticWakePreferenceRequest.from(request.body()))
        val response = BoundCosmeticWakePreferenceResponse(false, "9223372036854775807", BoundCosmeticWakeRead("unavailable", null))
        response.match(request)
        assertEquals(response, BoundCosmeticWakePreferenceResponse.from(cosmeticJson.encodeToJsonElement(BoundCosmeticWakePreferenceResponse.serializer(), response).jsonObject))
        for (bad in listOf("01", "-1", "9223372036854775807")) rejects { request.copy(expectedRevision = bad).validate() }
        rejects { BoundCosmeticWakePreferenceRequest.from(edit(request.body(), "baseId", JsonPrimitive(base(raw())))) }
        rejects { BoundCosmeticWakePreferenceRequest.from(edit(request.body(), "wallet", JsonPrimitive(wallet(raw())))) }
        rejects { BoundCosmeticWakePreferenceRequest.from(edit(request.body(), "enabled", JsonPrimitive("false"))) }
        rejects { BoundCosmeticWakePreferenceRequest.from(edit(request.body(), "expectedRevision", JsonPrimitive(0))) }
        rejects { response.copy(enabled = true).match(request) }; rejects { response.copy(revision = request.expectedRevision).match(request) }
        rejects { response.copy(revision = "9223372036854775808").validate() }
        rejects { response.copy(visual = view(raw("on")).preference.visual).validate() }
        rejects { response.copy(enabled = true, visual = view(raw("before")).preference.visual).validate() }
    }
    @Test fun `closed modes bind exact commands and originals while preserving default Awning semantics`() {
        val wake = BoundCosmeticWakeFixtures.command(); val proof = BoundCosmeticWakeFixtures.pending(); val identity = BoundCosmeticWakeFixtures.identity
        val encoded = cosmeticJson.encodeToJsonElement(BoundCosmeticCommand.serializer(), wake).jsonObject
        assertEquals(wake, BoundCosmeticCommand.from(encoded, BoundCosmeticMode.WAKE))
        proof.match(identity, wake, BoundCosmeticMode.WAKE)
        assertEquals(proof, BoundCosmeticProof.from(raw("original"), identity, wake, BoundCosmeticMode.WAKE))
        rejects { wake.validate() }; rejects { BoundCosmeticCommand.from(encoded) }; rejects { proof.match(identity, wake) }
        val awning = BoundCosmeticFixtures.command(); awning.validate(); rejects { awning.validate(BoundCosmeticMode.WAKE) }
        rejects { proof.match(identity.copy(wallet = wallet(raw("on"))), wake, BoundCosmeticMode.WAKE) }
        rejects { proof.match(identity, wake.copy(recipe = wake.recipe.copy(durationSec = wake.recipe.durationSec + 1)), BoundCosmeticMode.WAKE) }
        rejects { proof.match(identity, wake.copy(appearance = wake.appearance.copy(sourceIndexSha256 = "0".repeat(64))), BoundCosmeticMode.WAKE) }
    }
}
