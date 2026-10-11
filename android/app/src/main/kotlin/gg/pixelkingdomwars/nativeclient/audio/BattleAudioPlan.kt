package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.serialization.json.*

data class BattleAudioBounds(val tickMs: Long, val maxEvents: Int, val maxCycles: Int,
                             val maxContacts: Int, val drainTicks: Int) {
    companion object {
        fun from(catalogue: JsonObject): BattleAudioBounds {
            val limits = catalogue.getValue("constants").jsonObject.getValue("RAID_REPLAY_LIMITS").jsonObject
            fun count(key: String) = limits.getValue(key).jsonPrimitive.int.also { require(it > 0) }
            return BattleAudioBounds(catalogue.getValue("presentation").jsonObject.getValue("tickMs").jsonPrimitive.long
                .also { require(it > 0) }, count("maxEvents"), count("maxAttackRunCycles"),
                count("maxAttackContactsPerCycle"), count("postBattleDrainTicks"))
        }
    }
}

enum class AudioDispatch { ACTOR_LOOP, KEG_PRIME }
data class BattleAudioCue(val atMs: Double, val family: String, val variantKey: String,
                          val fallback: String? = null, val loop: Boolean = false, val volume: Float = 1f,
                          val priority: AudioPriority = AudioPriority.NORMAL, val dispatch: AudioDispatch? = null)
data class BattleAudioWindow(val startMs: Long, val definitions: List<AudioDefinition>)

/** Direct presentation port of canonical apps/web/src/lib/battleAudio.ts. Only accepted replay
 * events enter this planner. It never predicts attacks/damage or changes the simulation clock. */
class BattleAudioPlan(private val bounds: BattleAudioBounds) {
    private data class Actor(val troop: String, val hero: String? = null)
    private val deploy = listOf("highlander", "bowman", "kegrunner", "tunneler", "turrider", "plunderer", "giant",
        "troll", "dragon", "mage", "bilgewraith", "gloamfang", "direwyvern", "hexbarrow", "barrowling", "wyrmling")
        .associateWith { troop -> "sfx_troop_${troop}_${when (troop) {
            "kegrunner" -> "deploy_ignite"; "barrowling", "wyrmling" -> "spawn"; else -> "deploy"
        }}" }
    private val skills = mapOf(
        "crimsonDash" to "sfx_hero_vex_crimson_dash", "moonsunderWave" to "sfx_hero_vex_moonsunder_wave",
        "degenAwakening" to "sfx_hero_vex_degen_awakening", "doubleOrNothingHeads" to "sfx_hero_vex_double_or_nothing_heads",
        "doubleOrNothingTails" to "sfx_hero_vex_double_or_nothing_tails", "omegaShardstorm" to "sfx_hero_vex_omega_shardstorm",
        "cheekQuake" to "sfx_hero_theodor_cheek_quake", "snotRocket" to "sfx_hero_theodor_snot_rocket",
        "cannonball" to "sfx_hero_theodor_cannonball", "skillIssue" to "sfx_hero_theodor_skill_issue",
        "bellyBounce" to "sfx_hero_theodor_belly_bounce", "brownNote" to "sfx_hero_theodor_brown_note",
        "rageQuit" to "sfx_hero_theodor_rage_quit", "rageQuitWake" to "sfx_hero_theodor_rage_quit_wake",
        "silentButDeadly" to "sfx_hero_theodor_silent_but_deadly")
    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.number(key: String) = (this[key] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }
    private fun JsonObject.integer(key: String) = (this[key] as? JsonPrimitive)?.intOrNull

    /** Shared assertAttackRunBounded/attackRunCycleStarts, consuming exported bounds. */
    private fun starts(run: JsonObject, checkpoint: () -> Unit = {}): List<Double>? {
        val t = run.number("t") ?: return null
        val count = run.integer("count") ?: return null
        val cycle = run.integer("cycleTicks") ?: return null
        val cadence = run.integer("cadenceTicks") ?: return null
        val releaseTicks = run.integer("releaseOffsetTicks") ?: return null
        val cycleMs = run.integer("cycleMs") ?: return null
        val releaseMs = run.integer("releaseOffsetMs") ?: return null
        val contacts = run["impactOffsetsTicks"] as? JsonArray ?: return null
        if (t < 0 || t % 1 != 0.0 || count !in 1..bounds.maxCycles || cycle !in 1..bounds.drainTicks
            || cadence !in 1..bounds.maxCycles || releaseTicks !in 0..cycle || cycleMs < 1
            || cycleMs.toLong() > cycle.toLong() * bounds.tickMs || releaseMs !in 0..cycleMs
            || contacts.size !in 1..bounds.maxContacts
            || contacts.any { (it as? JsonPrimitive)?.intOrNull?.let { value -> value !in 0..bounds.drainTicks } != false }) return null
        return List(count) { checkpoint(); t + it.toDouble() * cadence }
    }

    fun plan(events: List<JsonObject>, buildings: Map<String, String>, checkpoint: () -> Unit = {}): List<BattleAudioCue> {
        require(events.size <= bounds.maxEvents) { "Audio replay exceeds admitted event bounds" }
        val cues = mutableListOf<BattleAudioCue>()
        val actors = mutableMapOf<String, Actor>()
        val owned = mutableSetOf<String>()
        events.filter { checkpoint(); it.text("e") == "attackRun" }.forEach { run ->
            val verb = when (run.text("mode")) { "projectile", "stream" -> "troopFire"; "melee" -> "troopAttack"; else -> null }
            if (verb != null) starts(run, checkpoint)?.forEach { owned += "${run.text("id")}:${tickKey(it)}:$verb" }
        }
        fun add(at: Double, family: String?, key: String, fallback: String? = null,
                loop: Boolean = false, volume: Float = 1f, priority: AudioPriority = AudioPriority.NORMAL,
                dispatch: AudioDispatch? = null) {
            if (family != null && at.isFinite() && at >= 0) cues += BattleAudioCue(at, family, key, fallback, loop, volume, priority, dispatch)
        }
        fun attack(run: JsonObject) {
            val startTicks = starts(run, checkpoint) ?: return
            for (start in startTicks) {
                checkpoint()
                val prefix = "${run.text("id")}:${tickKey(start)}"
                fun release(family: String, fallback: String? = null) =
                    add(start * bounds.tickMs + run.number("releaseOffsetMs")!!, family, "$prefix:release", fallback)
                fun impact(family: String, fallback: String? = null) {
                    run.getValue("impactOffsetsTicks").jsonArray.forEachIndexed { index, offset ->
                        add((start + offset.jsonPrimitive.double) * bounds.tickMs, family, "$prefix:impact:$index", fallback)
                    }
                }
                when (run.text("troop")) {
                    "highlander" -> release("sfx_troop_highlander_attack", "sfx_sword_hit")
                    "bowman" -> { release("sfx_troop_bowman_release", "sfx_bow_shot"); impact("sfx_troop_bowman_impact", "sfx_arrow_hit") }
                    "kegrunner" -> Unit // Exact detonate owns the blast.
                    "tunneler" -> release("sfx_troop_tunneler_pick_contact", "sfx_sword_hit")
                    "turrider" -> release("sfx_troop_turrider_horn_gore", "sfx_sword_hit")
                    "plunderer" -> release("sfx_troop_plunderer_sack_attack", "sfx_sword_hit")
                    "giant" -> if (run.text("technique") == "boulder") {
                        release("sfx_troop_giant_boulder_release", "sfx_mortar_thunk"); impact("sfx_troop_giant_boulder_impact", "sfx_explosion_big")
                    } else release("sfx_troop_giant_melee", "sfx_sword_hit")
                    "troll" -> release(if (run.text("targetKind") == "building") "sfx_troop_troll_building_pound" else "sfx_troop_troll_sweep", "sfx_sword_hit")
                    "dragon" -> { release("sfx_troop_dragon_breath", "sfx_bow_shot"); impact("sfx_troop_dragon_breath_contact", "sfx_arrow_hit") }
                    "mage" -> { release("sfx_troop_mage_release", "sfx_bow_shot"); impact("sfx_troop_mage_impact", "sfx_arrow_hit") }
                    "bilgewraith" -> release("sfx_troop_bilgewraith_chain_attack", "sfx_sword_hit")
                    "gloamfang" -> { release("sfx_troop_gloamfang_rend", "sfx_sword_hit"); impact("sfx_troop_gloamfang_contact") }
                    "direwyvern" -> if (run.text("technique") == "maul") impact("sfx_troop_direwyvern_contact", "sfx_sword_hit")
                    "hexbarrow" -> { release("sfx_troop_hexbarrow_hexshot_release", "sfx_bow_shot"); impact("sfx_troop_hexbarrow_hex_impact", "sfx_arrow_hit") }
                    "barrowling" -> release("sfx_troop_barrowling_attack", "sfx_sword_hit")
                    "wyrmling" -> { release("sfx_troop_wyrmling_breath", "sfx_bow_shot"); impact("sfx_troop_wyrmling_flame_contact", "sfx_arrow_hit") }
                }
            }
        }
        for (event in events) {
            checkpoint()
            val t = event.number("t")?.takeIf { it >= 0 } ?: continue
            val e = event.text("e") ?: continue
            val id = event.text("id") ?: "undefined"
            val at = t * bounds.tickMs
            val key = "${event.text("id") ?: e}:${tickKey(t)}:$e"
            when (e) {
                "deploy", "spawn", "troopSpawn" -> {
                    val troop = if (e == "troopSpawn") "barrowling" else event.text("troop") ?: continue
                    val hero = if (e == "deploy") event.text("hero")?.takeIf { it in setOf("vex", "theodor") } else null
                    actors[id] = Actor(troop, hero)
                    add(at, if (hero != null) "sfx_hero_${hero}_deploy" else deploy[troop], key,
                        when (hero) { "vex" -> "sfx_hero_deploy_vex"; "theodor" -> "sfx_hero_deploy_theo"; else -> "sfx_deploy_pop" })
                    // Canonical battleAudio.ts actor-loop gains; loops are never one-shot dispatches.
                    if (e == "deploy" && hero == null && troop == "kegrunner")
                        add(at, "sfx_troop_kegrunner_fuse_loop", "$key:fuse", "sfx_keg_fuse", true, 0.6f, dispatch = AudioDispatch.ACTOR_LOOP)
                    if (e == "spawn" && troop == "wyrmling") add(at, "sfx_defense_dragonnest_launch", "$key:nest")
                }
                "attackRun" -> attack(event)
                "troopFire", "troopAttack" -> if ("$id:${tickKey(t)}:$e" !in owned) {
                    val actor = actors[id] ?: continue
                    if (actor.hero != null) add(at, "sfx_hero_${actor.hero}_primary", "$id:${tickKey(t)}:legacy", "sfx_sword_hit")
                    else attack(JsonObject(event + mapOf(
                        "troop" to JsonPrimitive(actor.troop), "targetKind" to (event["targetKind"] ?: JsonPrimitive("building")),
                        "technique" to JsonPrimitive(if (event.text("proj") == "boulder") "boulder" else if (actor.troop == "gloamfang") "rend" else "strike"),
                        "count" to JsonPrimitive(1), "cycleTicks" to JsonPrimitive(1), "cadenceTicks" to JsonPrimitive(1),
                        "releaseOffsetTicks" to JsonPrimitive(0), "cycleMs" to JsonPrimitive(bounds.tickMs),
                        "releaseOffsetMs" to JsonPrimitive(0), "impactOffsetsTicks" to JsonArray(listOf(JsonPrimitive(0))))))
                }
                "heroAttack" -> add(at, "sfx_hero_${event.text("hero")}_primary", key, "sfx_sword_hit")
                "heroSkill" -> {
                    val skill = event.text("skill") ?: continue
                    if (skill in setOf("cannonball", "silentButDeadly") && event.text("phase") != "impact") continue
                    add(at, skills[skill], key, when (skill) { "crimsonDash" -> "sfx_hero_dash"; "cheekQuake" -> "sfx_hero_quake"; else -> null })
                }
                "troopAbility" -> add(at, when (event.text("ability")) {
                    "howl" -> "sfx_troop_gloamfang_howl"; "leap", "lunge" -> "sfx_troop_gloamfang_lunge"
                    "firestorm" -> "sfx_troop_direwyvern_firestorm"; "maul" -> "sfx_troop_direwyvern_maul"
                    "disgorge" -> "sfx_troop_hexbarrow_disgorge"; else -> null
                }, key)
                "fire" -> {
                    val type = buildings[id]
                    val pair = when (type) {
                        "cannon", "archertower", "electrictower", "magetower", "lasertower" -> "sfx_defense_${type}_fire" to "sfx_defense_${type}_impact"
                        "mortar" -> "sfx_defense_mortar_launch" to "sfx_defense_mortar_impact"
                        else -> null
                    } ?: continue
                    add(at + (event.number("releaseOffsetMs") ?: 0.0), pair.first, "$key:fire",
                        when (type) { "cannon" -> "sfx_cannon_fire"; "mortar" -> "sfx_mortar_thunk"; "archertower" -> "sfx_bow_shot"; else -> null })
                    add(at + (event.number("impactOffsetTicks") ?: 0.0) * bounds.tickMs, pair.second, "$key:impact",
                        when (type) { "cannon" -> "sfx_explosion_big"; "archertower" -> "sfx_arrow_hit"; else -> null })
                    if (type == "mortar") add(at, "sfx_defense_mortar_whistle", "$key:whistle", "sfx_shell_whistle")
                }
                "troopDeath" -> actors[id]?.let { actor -> add(at,
                    if (actor.hero != null) "sfx_hero_${actor.hero}_death" else "sfx_troop_${actor.troop}_death", key) }
                "detonate" -> {
                    add(at, "sfx_troop_kegrunner_plant_brace", "$key:prime", dispatch = AudioDispatch.KEG_PRIME)
                    add(at, "sfx_troop_kegrunner_detonation", key, "sfx_explosion_big")
                }
                "burrow", "emerge" -> actors[id]?.troop?.takeIf { it in setOf("tunneler", "bilgewraith") }?.let { troop ->
                    if (e == "burrow") add(at, "sfx_troop_${troop}_burrow_loop", key, "sfx_burrow_loop", true, 0.5f, dispatch = AudioDispatch.ACTOR_LOOP)
                    else add(at, "sfx_troop_${troop}_emerge", key, "sfx_emerge_pop")
                }
                "destroyed" -> add(at, "sfx_base_rubble_collapse", key, "sfx_rubble_crash")
                "trap" -> add(at, "sfx_defense_spiketrap_snap", key, "sfx_trap_snap")
                "rally" -> add(at, "sfx_battle_rally", key, "sfx_rally_horn", priority = AudioPriority.CRITICAL)
                "star" -> event.integer("n")?.coerceIn(1, 3)?.let { star ->
                    add(at, "sfx_battle_star_$star", key, "sfx_star_$star", priority = AudioPriority.CRITICAL)
                }
            }
        }
        return cues.sortedWith(compareBy<BattleAudioCue> { it.atMs }.thenBy { it.family }.thenBy { it.variantKey })
    }

    private fun tickKey(tick: Double) = if (tick % 1 == 0.0) tick.toLong().toString() else tick.toString()
}

/** Canonical rolling-bank order: cues with no legacy fallback win scarce decoded capacity,
 * then earliest event, higher priority and stable ID. No full-catalogue preload. */
fun battleAudioWindows(plan: List<BattleAudioCue>, definitions: AudioDefinitions, runtime: AudioRuntime, checkpoint: () -> Unit = {}): List<BattleAudioWindow> {
    data class Rank(val definition: AudioDefinition, val fallback: Boolean, val at: Double, val priority: AudioPriority)
    val windows = sortedMapOf<Long, MutableMap<String, Rank>>()
    val order = compareBy<Rank> { it.fallback }.thenBy { it.at }.thenByDescending { it.priority }.thenBy { it.definition.id }
    plan.forEach { cue ->
        checkpoint()
        val definition = definitions.resolve(cue.family, cue.variantKey, cue.loop) ?: return@forEach
        val start = (cue.atMs / runtime.battleBankWindowMs).toLong() * runtime.battleBankWindowMs
        val ids = windows.getOrPut(start) { mutableMapOf() }
        val candidate = Rank(definition, cue.fallback != null, cue.atMs, cue.priority)
        if (ids[definition.id]?.let { order.compare(candidate, it) < 0 } != false) ids[definition.id] = candidate
    }
    return windows.map { (start, ids) -> BattleAudioWindow(start, ids.values.sortedWith(order).map { it.definition }) }
}

/** Revisions/cold prefixes and explicit jumps discard elapsed one-shots. A backgrounded or
 * muted period advances the cursor silently; returning never catches up old combat sounds. */
class BattleAudioCursor {
    private var plan = emptyList<BattleAudioCue>()
    private var next = 0
    private var position = 0.0
    fun replace(cues: List<BattleAudioCue>, fromMs: Double) {
        require(fromMs.isFinite() && fromMs >= 0)
        plan = cues
        var low = 0; var high = cues.size
        while (low < high) { val mid = (low + high) ushr 1; if (cues[mid].atMs < fromMs) low = mid + 1 else high = mid }
        next = low; position = fromMs
    }
    fun advance(toMs: Double, audible: Boolean, jumped: Boolean = false): List<BattleAudioCue> {
        require(toMs.isFinite() && toMs >= position)
        val result = mutableListOf<BattleAudioCue>()
        while (next < plan.size && plan[next].atMs <= toMs) {
            val cue = plan[next++]
            if (audible && !jumped && cue.dispatch == null) result += cue
        }
        position = toMs
        return result
    }
}
