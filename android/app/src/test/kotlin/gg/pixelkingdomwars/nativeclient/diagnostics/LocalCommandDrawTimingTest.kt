package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LocalCommandDrawTimingTest {
    private val fixture=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/command-correlation/source-reference.json")).readText()).jsonObject
    private val p=fixture.getValue("policy").jsonObject
    private val policy=BattleCommandCorrelationPolicy(p.getValue("simVersion").jsonPrimitive.int,p.getValue("tickDurationMs").jsonPrimitive.int,
        p.getValue("unitsPerTile").jsonPrimitive.int,p.getValue("heroDonors").jsonObject.mapValues {it.value.jsonPrimitive.content},
        p.getValue("trainableTroops").jsonArray.map {it.jsonPrimitive.content}.toSet(),p.getValue("maxCommands").jsonPrimitive.int,p.getValue("maxEvents").jsonPrimitive.int)
    private fun presentation(name:String="revision-before")=fixture.getValue("cases").jsonArray.map {it.jsonObject}.single {it["name"]==JsonPrimitive(name)}.getValue("presentation").jsonObject
    private val raid=presentation().getValue("raidId").jsonPrimitive.content
    private var now=100L
    private var generation=1L
    private var session:LocalCommandTiming.Session
    private var enabled=true
    private val core=LocalCommandTiming {now}.also {it.reset(1)}
    private val draw:LocalCommandDrawTiming
    init { session=core.session();draw=LocalCommandDrawTiming(core) {if(enabled)generation to session else null} }
    private fun bind(id:String="command-0") {core.bind(core.input(generation,session,1000,"0.4.2:15:dev")!!,id)}
    private fun plan(name:String="revision-before")=requireNotNull(draw.prepare(raid,presentation(name),policy))
    private fun submit(plan:LocalCommandDrawTiming.Prepared)=BattleCommandBodySubmission(plan.plan.lease,raid,plan.plan.revision,plan.plan.aliasesByActor.values.toList())
    private fun stages()=core.sample(generation)!!.records.map {it.stagesMs}

    @Test fun `exact revised actor association preserves first body timestamp for original input`() {
        bind();val first=plan();draw.activate(first);now=250;draw.submitted(submit(first))
        bind("command-1");val second=plan("revision-after");draw.activate(second)
        assertEquals(first.plan.aliasesByActor[1],second.plan.aliasesByActor[2])
        now=400;draw.submitted(submit(second));draw.submitted(submit(second))
        assertEquals(150L,stages()[0]["first_canonical_body_submitted"])
        assertEquals(150L,stages()[1]["first_canonical_body_submitted"])
    }
    @Test fun `obsolete plan revision view and unknown alias cannot mark a newer scene`() {
        bind();val first=plan();val newer=plan("revision-after");draw.activate(newer)
        draw.submitted(submit(first));draw.submitted(submit(newer).copy(revision="wrong"))
        draw.submitted(submit(newer).copy(aliases=listOf(999)))
        assertFalse("first_canonical_body_submitted" in stages().single())
        draw.close();draw.activate(newer);draw.submitted(submit(newer))
        assertFalse("first_canonical_body_submitted" in stages().single())
    }
    @Test fun `same revision preparation retry requires its newly accepted plan`() {
        bind();val first=plan();val retry=plan()
        assertEquals(first.plan.revision,retry.plan.revision)
        assertEquals(first.plan.aliasesByActor,retry.plan.aliasesByActor)
        assertNotEquals(first.plan.lease,retry.plan.lease)
        draw.activate(retry);now=250;draw.submitted(submit(first))
        assertFalse("An outgoing GL preparation cannot certify its replacement","first_canonical_body_submitted" in stages().single())
        now=300;draw.submitted(submit(retry))
        assertEquals(200L,stages().single()["first_canonical_body_submitted"])
    }
    @Test fun `consent clear disable and changed account session reject outstanding draws`() {
        bind();val old=plan();draw.activate(old);enabled=false;draw.submitted(submit(old))
        assertFalse("first_canonical_body_submitted" in stages().single())
        enabled=true;core.close(session);session=core.session();draw.submitted(submit(old))
        assertFalse("first_canonical_body_submitted" in stages().single())
        generation=2;core.reset(2);bind();draw.submitted(submit(old))
        assertFalse("first_canonical_body_submitted" in stages().single())
    }
    @Test fun `restored archive disabled and malformed complete journal have no invented alias or draw plan`() {
        assertNull(draw.prepare(raid,presentation(),policy));bind();enabled=false
        assertNull(draw.prepare(raid,presentation(),policy));enabled=true
        assertNull(draw.prepare(raid,JsonObject(presentation()+ ("source" to JsonPrimitive("archive"))),policy))
        assertNull(draw.prepare(raid,JsonObject(presentation()+ ("lastSequence" to JsonPrimitive(99))),policy))
        assertNull(draw.prepare("wrong",presentation(),policy))
    }
    @Test fun `catalogue policy reads source values and training flags instead of duplicating numbers`() {
        val catalogue=buildJsonObject {
            put("simVersion",policy.simVersion);put("presentation",buildJsonObject {put("tickMs",policy.tickDurationMs);put("unitsPerTile",policy.unitsPerTile)})
            put("constants",buildJsonObject {
                put("HERO_COMBAT",buildJsonObject {policy.heroDonors.forEach {(key,value)->put(key,buildJsonObject {put("donor",value)})}})
                put("LIVE_RAID",buildJsonObject {put("maxCommands",policy.maxCommands)})
                put("RAID_REPLAY_LIMITS",buildJsonObject {put("maxEvents",policy.maxEvents)})
                put("TROOPS",buildJsonObject {policy.trainableTroops.forEach {put(it,buildJsonObject {})};put("spawn_only",buildJsonObject {put("spawnOnly",true)})})
            })
        }
        assertEquals(policy,commandCorrelationPolicy(catalogue))
        assertNull(commandCorrelationPolicy(JsonObject(emptyMap())))
    }
}
