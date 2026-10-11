package gg.pixelkingdomwars.nativeclient.diagnostics

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BattleCommandCorrelationTest {
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/command-correlation/source-reference.json")).readText()).jsonObject
    private val policy = fixture.getValue("policy").jsonObject.let { p -> BattleCommandCorrelationPolicy(
        p.getValue("simVersion").jsonPrimitive.int, p.getValue("tickDurationMs").jsonPrimitive.int,
        p.getValue("unitsPerTile").jsonPrimitive.int, p.getValue("heroDonors").jsonObject.mapValues { it.value.jsonPrimitive.content },
        p.getValue("trainableTroops").jsonArray.map { it.jsonPrimitive.content }.toSet(),
        p.getValue("maxCommands").jsonPrimitive.int, p.getValue("maxEvents").jsonPrimitive.int) }
    private fun row(name: String) = fixture.getValue("cases").jsonArray.map { it.jsonObject }.single { it["name"] == JsonPrimitive(name) }
    private fun scene(name: String = "same-fields-and-families") = row(name).getValue("presentation").jsonObject
    private val raid = scene().getValue("raidId").jsonPrimitive.content
    private fun patch(value: JsonObject, key: String, next: JsonElement) = JsonObject(value + (key to next))
    private fun associate(value: JsonObject = scene()) = correlateBattleCommands(raid, value, policy)
    private fun linked(value: JsonObject = scene()) = associate(value) as BattleCommandCorrelation.Associated
    private fun unavailable(value: JsonObject) = assertTrue(associate(value) is BattleCommandCorrelation.Unavailable)
    private fun commands(value: JsonObject, change: (MutableList<JsonElement>) -> Unit): JsonObject {
        val rows = value.getValue("commands").jsonArray.toMutableList(); change(rows)
        return patch(value, "commands", JsonArray(rows))
    }
    private fun firstAttacker(value: JsonObject, change: (JsonObject) -> JsonObject): JsonObject {
        val events = value.getValue("events").jsonArray.toMutableList()
        val index = events.indexOfFirst { it.jsonObject["e"] == JsonPrimitive("deploy") && it.jsonObject["side"] != JsonPrimitive("defender") }
        events[index] = change(events[index].jsonObject)
        return patch(value, "events", JsonArray(events))
    }

    @Test fun `actual SIM15 repeated fields use stable family order before exact canonical actor identity`() {
        val result = linked()
        // Real nativeOrders + simulateRaid output, not native-generated expected events.
        assertEquals(listOf(1,3,4,0,2,5,6,8), result.links.map { it.commandSequence })
        assertEquals(listOf(1,2,3,4,5,6,7,9), result.links.map { it.actorId })
        assertEquals(listOf("command-1","command-3","command-4","command-0","command-2","command-5","command-6","command-8"), result.links.map { it.commandId })
        assertEquals(listOf(0,0,0,0,0,11,11,120), result.links.map { it.spawnTick })
        assertTrue(result.notEmittedInRevision.isEmpty())
        assertEquals(raid,result.raidId)
        // The smaller negative tile at1199ms follows the positive tile at1101ms,
        // despite both emitting in tick11. Rounding before sorting is incorrect.
        assertTrue(result.links[5].eventIndex < result.links[6].eventIndex)
    }

    @Test fun `receipt timing is irrelevant while a partial or reordered receipt union cannot impersonate a journal`() {
        val changedClock = commands(scene()) { rows -> rows.indices.forEach { i -> rows[i] = patch(rows[i].jsonObject,"acceptedAt",JsonPrimitive("2099-01-01T00:00:00Z")) } }
        assertEquals(linked(),linked(changedClock))
        unavailable(commands(scene()) { rows -> val last=rows.removeAt(rows.lastIndex);rows.add(0,last) })
        unavailable(commands(scene()) { it.removeAt(0) })
        unavailable(patch(scene(),"lastSequence",JsonPrimitive(0)))
    }

    @Test fun `same-time insertion remaps IDs only within its own rendered revision`() {
        val before=linked(scene("revision-before"));val after=linked(scene("revision-after"))
        assertEquals(1,before.links.single().actorId)
        assertEquals(2,after.links.single { it.commandId=="command-0" }.actorId)
        assertEquals(1,after.links.single { it.commandId=="command-1" }.actorId)
        assertNotEquals(before.revision,after.revision)
        assertEquals(before,linked(scene("revision-before")))
    }

    @Test fun `defender heroes Nest units and summoned Barrowlings never consume direct command slots`() {
        val value=scene("summons-and-nest")
        val events=value.getValue("events").jsonArray.map { it.jsonObject }
        assertTrue(events.any { it["e"]==JsonPrimitive("spawn") })
        assertTrue(events.any { it["e"]==JsonPrimitive("troopSpawn") })
        val result=linked(value)
        assertEquals(listOf("command-0","command-1"),result.links.map { it.commandId })
        assertTrue(result.links[1].actorId>1)
        assertEquals(8,linked().links.size) // excludes source fixture's defender Theodor
    }

    @Test fun `early victory and staged commands remain unemitted without a guessed actor or latency`() {
        val value=scene("early-victory-future-unemitted")
        assertTrue(row("early-victory-future-unemitted").getValue("outcomeTicks").jsonPrimitive.int<890)
        val result=linked(value)
        assertEquals(listOf("command-0"),result.links.map { it.commandId })
        assertEquals(listOf(UnemittedCommand(1,"command-1")),result.notEmittedInRevision)
        val staged=linked(patch(scene(),"events",JsonArray(emptyList())))
        assertTrue(staged.links.isEmpty());assertEquals(8,staged.notEmittedInRevision.size)
        // Archive envelopes lack an ordinary accepted journal. Never infer its
        // missing original IDs or treat an unobserved terminal troop as a spawn.
        unavailable(patch(value,"source",JsonPrimitive("archive")))
        unavailable(patch(patch(value,"source",JsonPrimitive("archive")),"commands",JsonArray(emptyList())))
    }

    @Test fun `played-prefix and pre-start retreat cannot consume future accepted commands`() {
        val value=scene()
        val prefix=value.getValue("events").jsonArray.filter { it.jsonObject.getValue("t").jsonPrimitive.int<120 }
        val result=linked(patch(value,"events",JsonArray(prefix)))
        assertEquals(listOf(UnemittedCommand(8,"command-8")),result.notEmittedInRevision)
        val prestart=patch(patch(value,"events",JsonArray(emptyList())),"status",JsonPrimitive("resolved"))
        assertEquals(8,linked(prestart).notEmittedInRevision.size)
    }

    @Test fun `canonical tuple mismatch duplicate identity and extra actor fail the whole association closed`() {
        for((key,next) in listOf("t" to JsonPrimitive(1),"troop" to JsonPrimitive("dragon"),"hero" to JsonPrimitive("vex"),"x" to JsonPrimitive(0),"y" to JsonPrimitive(0),"side" to JsonPrimitive("unknown"))) {
            unavailable(firstAttacker(scene()) { patch(it,key,next) })
        }
        unavailable(firstAttacker(scene()) { patch(it,"id",JsonPrimitive(0)) }) // defender already owns0
        unavailable(commands(scene()) { rows -> rows[1]=patch(rows[1].jsonObject,"clientCommandId",JsonPrimitive("command-0")) })
        unavailable(commands(scene()) { rows -> rows[1]=patch(rows[1].jsonObject,"payload",JsonObject(emptyMap())) })
        val all=scene().getValue("events").jsonArray
        unavailable(patch(scene(),"events",JsonArray(all+all.first())))
    }

    @Test fun `unsupported transport SIM raid scope and source policy cannot silently reuse this proof`() {
        for((key,next) in listOf("simVersion" to JsonPrimitive(16),"protocolVersion" to JsonPrimitive(2),"transportProtocolVersion" to JsonPrimitive(1),"raidProtocolVersion" to JsonPrimitive(1),"replaceFromTick" to JsonPrimitive(1),"raidId" to JsonPrimitive("another-raid"),"revision" to JsonPrimitive("not-a-revision"))) unavailable(patch(scene(),key,next))
        for(bad in listOf(policy.copy(simVersion=14),policy.copy(tickDurationMs=0),policy.copy(unitsPerTile=0),policy.copy(maxCommands=1),policy.copy(maxEvents=1))) {
            assertTrue(correlateBattleCommands(raid,scene(),bad) is BattleCommandCorrelation.Unavailable)
        }
    }
}
