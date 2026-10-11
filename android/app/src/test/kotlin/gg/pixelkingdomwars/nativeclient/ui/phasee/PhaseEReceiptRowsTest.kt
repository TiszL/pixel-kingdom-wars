package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.workshop.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Projection tests only. Synthetic commands exercise recovery visibility; no server or wallet is invoked. */
class PhaseEReceiptRowsTest {
    private val wallet = "So11111111111111111111111111111111111111112"
    private val origin = "https://receipt.invalid"
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val base = id(1)
    private val now = "2035-01-01T00:00:00.000Z"
    private val identity = StarterIdentity(origin, "devnet", wallet)
    private val cosmeticIdentity = BoundCosmeticIdentity(origin, "devnet", wallet)
    private fun json(vararg fields: Pair<String, String>) = buildJsonObject { fields.forEach { (k, v) -> put(k, v) } }
    private fun workshopOperation(n: Int, attempted: Boolean = true) = WorkshopOperation(
        WorkshopCommand("start", base, id(n), 2, null, 1, 17, 1, 61, "free_wallet"), attempted, null, null)
    private fun workshopJournal(operation: WorkshopOperation? = null, archives: List<WorkshopArchive> = emptyList()) =
        WorkshopJournal(1, WorkshopIdentity(origin, "devnet", wallet), 0, operation, archives)
    private fun ordinaryOperation(n: Int) = OrdinaryCraftingOperation(
        OrdinaryCraftingCommand(OrdinaryCraftingRequest(id(n), base, "refine_frostglass", 1, 1),
            OrdinaryCraftingRecipe(1, "refine_frostglass", 1, 30, listOf(OrdinaryCraftingInput("raw", "frost_quartz", "2")), OrdinaryCraftingOutput("frostglass", "1"))),
        1, null, null)
    private fun fleetOperation(n: Int) = StarterFleetOperation(
        StarterFleetCommand(StarterFleetRequest(id(n), base, id(3)), StarterFleetBerth(id(3), id(4), now), null), 1, null, null)
    private fun expeditionOperation(n: Int) = StarterExpeditionOperation(
        StarterExpeditionCommand(StarterExpeditionRequest(id(n), base, id(5), "introduction", 2, 2),
            StarterExpeditionRoute(2, 2, "introduction", "crownlands", "crown_iron_ore", "starter", 17, "101", "77", "24"),
            StarterFleetInstallation(id(5), base, id(3), "starter", id(4), now, now)), 1, null, null)
    private fun harvesterOperation(n: Int) = HarvesterOperation(
        HarvesterCommand(HarvesterRequest(id(n), base, id(6), null, 1), HarvesterFacility(base, id(6), id(4), now),
            "crownlands", HarvesterPolicy(1, 1, "20", "2", 60, 600, 1, 1000, 500), null), 1, null, null)
    private fun resource(name: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource(name)).readText()).jsonObject
    private fun display(rows: List<PhaseEReceiptRow>) = rows.joinToString("|") { row ->
        listOf(row.id, row.title, row.status, row.baseId.orEmpty(), row.receiptKey).joinToString("|") +
            row.details.joinToString("|") { "${it.label}:${it.value}" }
    }

    @Test fun `unknown pending Workshop outcome and every archived original stay visible without advertisement`() {
        val pending = workshopOperation(10)
        val archive = workshopOperation(11, attempted = false)
        val rows = PhaseEReceiptRows.workshop(WorkshopState(workshopJournal(pending, listOf(WorkshopArchive(archive, "unattempted", null)))))
        assertEquals(setOf(id(10), id(11)), rows.map { it.receiptKey }.toSet())
        val current = rows.single { it.receiptKey == id(10) }
        assertEquals(base, current.baseId)
        assertEquals("CHECK NEEDED", current.status)
        assertEquals(PhaseEReceiptSource.PENDING, current.check?.source)
        assertNull(rows.single { it.receiptKey == id(11) }.check) // No Workshop archived-GET API exists.
    }

    @Test fun `advertisement alone never creates a receipt row for any typed journal family`() {
        assertTrue(PhaseEReceiptRows.workshop(WorkshopState(workshopJournal(), advertised = true)).isEmpty())
        assertTrue(PhaseEReceiptRows.refining(OrdinaryCraftingState(OrdinaryCraftingJournal(1, OrdinaryCraftingIdentity(origin, "devnet", wallet), 0, null, emptyList()), advertised = true)).isEmpty())
        assertTrue(PhaseEReceiptRows.starterFleet(StarterFleetState(StarterFleetJournal(1, identity, 0, null, emptyList()), advertised = true)).isEmpty())
        assertTrue(PhaseEReceiptRows.expeditions(StarterExpeditionState(StarterExpeditionJournal(1, identity, 0, null, emptyList()), advertised = true)).isEmpty())
        assertTrue(PhaseEReceiptRows.harvester(HarvesterState(HarvesterJournal(1, HarvesterIdentity(origin, "devnet", wallet), 0, null, emptyList()), advertised = true)).isEmpty())
        val cosmeticJournal = BoundCosmeticJournal(1, cosmeticIdentity, 0, null, emptyList())
        assertTrue(PhaseEReceiptRows.awnings(BoundCosmeticWorkshopState(cosmeticJournal, advertised = true)).isEmpty())
        assertTrue(PhaseEReceiptRows.wake(BoundCosmeticWakeWorkshopState(cosmeticJournal, advertised = true)).isEmpty())
    }

    @Test fun `refining preserves pending and archived keys independently of selected kingdom`() {
        val journal = OrdinaryCraftingJournal(1, OrdinaryCraftingIdentity(origin, "devnet", wallet), 0, ordinaryOperation(10),
            listOf(OrdinaryCraftingArchive(ordinaryOperation(11), "accepted", null)))
        val rows = PhaseEReceiptRows.refining(OrdinaryCraftingState(journal))
        assertEquals(setOf(id(10), id(11)), rows.map { it.receiptKey }.toSet())
        assertTrue(rows.all { it.baseId == base })
        assertEquals(PhaseEReceiptSource.ARCHIVED, rows.single { it.receiptKey == id(11) }.check?.source)
        assertTrue(display(rows).contains("frostglass"))
    }

    @Test fun `starter installation preserves both saved and archived originals`() {
        val rows = PhaseEReceiptRows.starterFleet(StarterFleetState(StarterFleetJournal(1, identity, 0, fleetOperation(10),
            listOf(StarterFleetArchive(fleetOperation(11), "accepted", null)))))
        assertEquals(setOf(id(10), id(11)), rows.map { it.receiptKey }.toSet())
        assertTrue(rows.all { it.check != null && it.baseId == base })
        assertTrue(display(rows).contains(id(3)))
    }

    @Test fun `an archived expedition is not marked returned merely because its timer elapsed`() {
        val rows = PhaseEReceiptRows.expeditions(StarterExpeditionState(StarterExpeditionJournal(1, identity, 0, expeditionOperation(10),
            listOf(StarterExpeditionArchive(expeditionOperation(11), "accepted", null)))))
        assertEquals(2, rows.size)
        assertTrue(rows.none { it.status == "RETURNED" })
        assertTrue(rows.all { it.baseId == base && it.check != null })
        assertTrue(display(rows).contains("introduction"))
    }

    @Test fun `harvester keeps original earning checks after discovery disappears`() {
        val rows = PhaseEReceiptRows.harvester(HarvesterState(HarvesterJournal(1, HarvesterIdentity(origin, "devnet", wallet), 0,
            harvesterOperation(10), listOf(HarvesterArchive(harvesterOperation(11), "accepted", null)))))
        assertEquals(setOf(id(10), id(11)), rows.map { it.receiptKey }.toSet())
        assertTrue(rows.all { it.status == "CHECK NEEDED" && it.check != null })
        assertTrue(display(rows).contains(id(6)))
    }

    @Test fun `server-only awning originals remain readable with an empty local journal`() {
        val raw = resource("/boundcosmetics/final-actual-http.json")
        val proof = BoundCosmeticProof.from(raw.getValue("originals").jsonArray.first().jsonObject)
        val view = BoundCosmeticWorkshopView(1, proof.wallet, proof.serverNow, false, false,
            BoundCosmeticBlueprintEligibility("unavailable", null, "NOT_CONFIGURED"), emptyList(), listOf(proof), null)
        val journal = BoundCosmeticJournal(1, cosmeticIdentity.copy(wallet = proof.wallet), 0, null, emptyList())
        val rows = PhaseEReceiptRows.awnings(BoundCosmeticWorkshopState(journal, view = view))
        assertEquals(proof.idempotencyKey, rows.single().receiptKey)
        assertEquals(proof.receipt!!.request.baseId, rows.single().baseId)
        assertEquals(PhaseEReceiptSource.SERVER, rows.single().source)
    }

    @Test fun `wake account original survives missing selected-base stock and capability`() {
        val raw = resource("/boundcosmetics/wake-workshop-primary-pair.json")
        val proof = BoundCosmeticProof.from(raw.getValue("completed").jsonObject.getValue("original").jsonObject)
        val journal = BoundCosmeticJournal(1, cosmeticIdentity.copy(wallet = proof.wallet), 0, null, emptyList())
        val rows = PhaseEReceiptRows.wake(BoundCosmeticWakeWorkshopState(journal, original = proof))
        assertEquals(proof.idempotencyKey, rows.single().receiptKey)
        assertEquals("COMPLETED", rows.single().status)
    }

    @Test fun `saved cosmetic attempts remain alongside server completion evidence`() {
        val raw = resource("/boundcosmetics/final-actual-http.json")
        val proof = BoundCosmeticProof.from(raw.getValue("originals").jsonArray.first().jsonObject)
        val receipt = proof.receipt!!
        val original = BoundCosmeticOperation(BoundCosmeticCommand(receipt.request, receipt.recipe, receipt.appearance), true, proof)
        val archived = original.copy(command = original.command.copy(request = original.command.request.copy(idempotencyKey = id(19))), proof = null)
        val journal = BoundCosmeticJournal(1, cosmeticIdentity.copy(wallet = proof.wallet), 0, original, listOf(archived))
        val rows = PhaseEReceiptRows.awnings(BoundCosmeticWorkshopState(journal))
        assertEquals(setOf(proof.idempotencyKey, id(19)), rows.map { it.receiptKey }.toSet())
        assertEquals(PhaseEReceiptSource.ARCHIVED, rows.single { it.receiptKey == id(19) }.check?.source)
    }

    @Test fun `equipment projection never publishes stored request extensions policy or observations`() {
        val secret = "DO_NOT_RENDER_SIGNED_OR_POLICY_BYTES"
        val request = json("baseId" to base, "signedTransaction" to secret)
        val record = EquipmentRecord("craft", id(10), request, json("wire" to secret),
            observations = listOf(json("secret" to secret)), held = true)
        val journal = EquipmentJournal(identity = identity, pending = listOf(record), archives = listOf(record.copy(key = id(11))))
        val rows = PhaseEReceiptRows.equipment(EquipmentState(journal = journal))
        assertEquals(setOf(id(10), id(11)), rows.map { it.receiptKey }.toSet())
        assertTrue(rows.all { it.status == "CHECK NEEDED" && it.check != null })
        assertFalse(display(rows).contains(secret))
        assertTrue(rows.all { it.baseId == base })
    }

    @Test fun `vehicle projection includes server activity and keeps signed payloads private`() {
        val secret = "DO_NOT_RENDER_VEHICLE_SIGNED_WIRE"
        val saved = VehicleRecord(id(10), "installation", id(11), json("baseId" to base), json("wire" to secret),
            signed = json("signedTransaction" to secret), attempts = listOf("wallet"))
        val server = json("kind" to "expedition", "id" to id(12), "idempotencyKey" to id(13), "baseId" to id(2), "status" to "returned", "createdAt" to now)
        val rows = PhaseEReceiptRows.vehicles(VehicleState(journal = VehicleJournal(identity = identity, pending = listOf(saved)),
            activity = buildJsonObject { put("items", JsonArray(listOf(server))) }))
        assertEquals(2, rows.size)
        assertTrue(rows.any { it.source == PhaseEReceiptSource.SERVER && it.baseId == id(2) && it.status == "RETURNED" })
        assertEquals(id(10), rows.single { it.source == PhaseEReceiptSource.PENDING }.check?.id)
        assertFalse(display(rows).contains(secret))
    }

    @Test fun `market keeps archived and server-only receipts without copying payment data`() {
        val secret = "DO_NOT_RENDER_MARKET_PAYMENT"
        val saved = KeepEquipmentMarketRecord("fill", id(10), json("buyerBaseId" to base), json("policy" to secret),
            signed = json("wire" to secret), response = json("unknownField" to secret))
        val server = json("kind" to "listing", "id" to id(12), "baseId" to id(2), "itemId" to "frostglass", "createdAt" to now)
        val rows = PhaseEReceiptRows.market(KeepEquipmentMarketState(journal = KeepEquipmentMarketJournal(identity = identity, archives = listOf(saved)),
            history = buildJsonObject { put("items", JsonArray(listOf(server))) }))
        assertEquals(setOf(id(10), id(12)), rows.map { it.receiptKey }.toSet())
        assertFalse(display(rows).contains(secret))
        assertTrue(rows.any { it.source == PhaseEReceiptSource.SERVER && it.check?.id == id(12) })
        assertTrue(rows.none { it.status == "COMPLETED" })
    }

    @Test fun `malformed server receipt row remains unavailable instead of silently disappearing`() {
        val rows = PhaseEReceiptRows.vehicles(VehicleState(activity = buildJsonObject {
            put("items", JsonArray(listOf(JsonPrimitive("malformed"))))
        }))
        assertEquals(1, rows.size)
        assertEquals("UNAVAILABLE", rows.single().status)
        assertNull(rows.single().check)
        assertFalse(display(rows).contains("malformed"))
    }

    @Test fun `details and row collection cannot be altered after publication`() {
        val supplied = mutableListOf(PhaseEReceiptDetail("Original request", id(10)))
        val row = PhaseEReceiptRow("row", PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.PENDING, id(10), "Workshop", "CHECK NEEDED", base, supplied)
        supplied.clear()
        assertEquals(1, row.details.size)
        assertThrows(UnsupportedOperationException::class.java) { (row.details as MutableList<*>).clear() }
        val rows = PhaseEReceiptRows.workshop(WorkshopState(workshopJournal(workshopOperation(10))))
        assertThrows(UnsupportedOperationException::class.java) { (rows as MutableList<*>).clear() }
    }
}
