package gg.pixelkingdomwars.nativeclient.diagnostics

import kotlinx.serialization.json.*

/** Source-pinned presentation policy. This helper never admits content or changes commands. */
internal data class BattleCommandCorrelationPolicy(
    val simVersion: Int,
    val tickDurationMs: Int,
    val unitsPerTile: Int,
    val heroDonors: Map<String, String>,
    val trainableTroops: Set<String>,
    val maxCommands: Int,
    val maxEvents: Int,
)

internal data class CommandActorLink(val commandSequence: Int, val commandId: String,
    val actorId: Int, val spawnTick: Int, val eventIndex: Int)
internal data class UnemittedCommand(val commandSequence: Int, val commandId: String)
internal sealed interface BattleCommandCorrelation {
    data class Associated(val raidId: String, val revision: String, val links: List<CommandActorLink>,
        val notEmittedInRevision: List<UnemittedCommand>) : BattleCommandCorrelation
    /** No guessing and no partial association; gameplay does not consume this result. */
    data class Unavailable(val reason: String) : BattleCommandCorrelation
}

private data class CorrelationDrop(val sequence: Int, val id: String, val tMs: Int,
    val tx: Int, val ty: Int, val troop: String, val hero: String?)
private fun JsonObject.correlationInt(key: String): Int =
    requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
private fun JsonObject.correlationString(key: String): String =
    requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)

/** Exact SIM15 order stream paired with its own complete canonical event prefix.
 * Call once off Main/GL after PresentationAssembly.complete(), never per frame.
 * IDs are revision-local: do not feed the coordinator's newer receipt union here.
 * Terminal archives omit the ordinary command journal and remain unavailable.
 */
internal fun correlateBattleCommands(expectedRaidId: String, presentation: JsonObject,
    policy: BattleCommandCorrelationPolicy): BattleCommandCorrelation {
    if (presentation["source"] != JsonPrimitive("live")) return BattleCommandCorrelation.Unavailable("journal unavailable")
    return try {
        // Structural version fence; future SIMs must re-prove their ordering contract.
        require(policy.simVersion == 15 && presentation.correlationInt("simVersion") == policy.simVersion)
        require(presentation.correlationInt("protocolVersion") == 1 && presentation.correlationInt("transportProtocolVersion") == 2)
        require(presentation.correlationInt("raidProtocolVersion") == 2 && presentation.correlationInt("replaceFromTick") == 0)
        require(policy.tickDurationMs > 0 && policy.unitsPerTile > 0 && policy.unitsPerTile % 2 == 0)
        require(policy.maxCommands > 0 && policy.maxEvents > 0 && policy.heroDonors.keys == setOf("vex", "theodor"))
        val raidId = presentation.correlationString("raidId")
        require(raidId == expectedRaidId)
        val revision = presentation.correlationString("revision")
        require(revision.matches(Regex("[a-f0-9]{64}")))
        val commands = requireNotNull(presentation["commands"] as? JsonArray)
        val events = requireNotNull(presentation["events"] as? JsonArray)
        require(commands.size <= policy.maxCommands && events.size <= policy.maxEvents)
        require(presentation.correlationInt("lastSequence") == commands.size - 1)
        val ids = HashSet<String>()
        val heroes = HashSet<String>()
        val drops = ArrayList<CorrelationDrop>()
        commands.forEachIndexed { sequence, value ->
            val command = requireNotNull(value as? JsonObject)
            require(command.correlationInt("sequence") == sequence)
            val id = command.correlationString("clientCommandId")
            require(id.isNotEmpty() && ids.add(id))
            val tMs = command.correlationInt("serverOffsetMs").also { require(it >= 0) }
            val payload = requireNotNull(command["payload"] as? JsonObject)
            val kind = command.correlationString("kind")
            require(kind in setOf("deploy", "hero", "rally", "buff", "start", "speed", "retreat"))
            if (kind == "deploy" || kind == "hero") {
                val hero = if (kind == "hero") payload.correlationString("hero") else null
                val troop = if (hero == null) payload.correlationString("troop").also { require(it in policy.trainableTroops) }
                    else requireNotNull(policy.heroDonors[hero]).also { require(heroes.add(hero)) }
                drops += CorrelationDrop(sequence, id, tMs, payload.correlationInt("tx"), payload.correlationInt("ty"), troop, hero)
            }
        }
        // NativeOrders preserves journal order within each family. Sequence makes
        // the simulator's stable tie explicit, including identical held drops.
        drops.sortWith(compareBy<CorrelationDrop> { it.tMs }.thenBy { it.tx }.thenBy { it.ty }
            .thenBy { if (it.hero == null) 0 else 1 }.thenBy { it.sequence })
        val links = ArrayList<CommandActorLink>()
        val actors = HashSet<Int>()
        events.forEachIndexed { eventIndex, value ->
            val event = requireNotNull(value as? JsonObject)
            val kind = event.correlationString("e")
            if (kind in setOf("deploy", "spawn", "troopSpawn")) {
                val actor = event.correlationInt("id").also { require(it >= 0 && actors.add(it)) }
                if (kind == "deploy") {
                    val side = event["side"]?.let { event.correlationString("side") }
                    require(side == null || side in setOf("attacker", "defender"))
                    if (side != "defender") {
                        val drop = drops.getOrNull(links.size) ?: error("extra actor")
                        val hero = event["hero"]?.let { event.correlationString("hero") }
                        val tick = event.correlationInt("t")
                        require(tick == drop.tMs / policy.tickDurationMs && hero == drop.hero && event.correlationString("troop") == drop.troop)
                        require(event.correlationInt("x").toLong() == drop.tx.toLong() * policy.unitsPerTile + policy.unitsPerTile / 2)
                        require(event.correlationInt("y").toLong() == drop.ty.toLong() * policy.unitsPerTile + policy.unitsPerTile / 2)
                        links += CommandActorLink(drop.sequence, drop.id, actor, tick, eventIndex)
                    }
                }
            }
        }
        BattleCommandCorrelation.Associated(raidId, revision, links,
            drops.drop(links.size).map { UnemittedCommand(it.sequence, it.id) })
    } catch (_: IllegalArgumentException) {
        BattleCommandCorrelation.Unavailable("incomplete or incompatible command/event identity")
    } catch (_: IllegalStateException) {
        BattleCommandCorrelation.Unavailable("incomplete or incompatible command/event identity")
    }
}
