package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.network.trainableTroops
import gg.pixelkingdomwars.nativeclient.network.BattleCommandStage
import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Only complete immutable live presentation data enters this off-Main preparation. */
internal fun commandCorrelationPolicy(catalogue: JsonObject): BattleCommandCorrelationPolicy? = runCatching {
    val constants=catalogue.getValue("constants").jsonObject
    val presentation=catalogue.getValue("presentation").jsonObject
    BattleCommandCorrelationPolicy(catalogue.getValue("simVersion").jsonPrimitive.int,
        presentation.getValue("tickMs").jsonPrimitive.int,presentation.getValue("unitsPerTile").jsonPrimitive.int,
        constants.getValue("HERO_COMBAT").jsonObject.mapValues { it.value.jsonObject.getValue("donor").jsonPrimitive.content },
        trainableTroops(catalogue).toSet(),constants.getValue("LIVE_RAID").jsonObject.getValue("maxCommands").jsonPrimitive.int,
        constants.getValue("RAID_REPLAY_LIMITS").jsonObject.getValue("maxEvents").jsonPrimitive.int)
}.getOrNull()

/** One visible view's frozen plan. Receipt unions and current account data are never inputs. */
internal class LocalCommandDrawTiming(private val core: LocalCommandTiming,
    private val context: () -> Pair<Long,LocalCommandTiming.Session>?) {
    internal data class Prepared(val plan: BattleCommandDrawPlan, val generation: Long, val session: LocalCommandTiming.Session)
    private val closed=AtomicBoolean(false)
    private val active=AtomicReference<Prepared?>()
    fun prepare(raid: String, presentation: JsonObject, policy: BattleCommandCorrelationPolicy): Prepared? {
        if(closed.get())return null
        val (generation,session)=context() ?: return null
        val linked=correlateBattleCommands(raid,presentation,policy) as? BattleCommandCorrelation.Associated ?: return null
        val aliases=core.aliases(generation,session,linked.links.map {it.commandId}.toSet())
        val actors=linked.links.mapNotNull { link->aliases[link.commandId]?.let {link.actorId to it} }.toMap()
        if(actors.isEmpty())return null
        return Prepared(BattleCommandDrawPlan(sequence.incrementAndGet(),raid,linked.revision,actors),generation,session)
    }
    /** UI admission of the exact prepared scene, before the renderer can replace it. */
    fun activate(prepared: Prepared?) { if(!closed.get())active.set(prepared) }
    fun submitted(value: BattleCommandBodySubmission) {
        if(closed.get())return
        val expected=active.get() ?: return
        val current=context() ?: return
        val plan=expected.plan
        if(current.first!=expected.generation || current.second!==expected.session || !expected.session.active.get() ||
            value.lease!=plan.lease || value.raidId!=plan.raidId || value.revision!=plan.revision ||
            value.aliases.size>LocalCommandTiming.LIMIT || value.aliases.any { it !in plan.aliasesByActor.values })return
        value.aliases.forEach { core.stageAlias(expected.generation,expected.session,it,BattleCommandStage.FIRST_CANONICAL_BODY_SUBMITTED) }
    }
    fun close() { closed.set(true);active.set(null) }
    companion object {private val sequence=AtomicLong()}
}
