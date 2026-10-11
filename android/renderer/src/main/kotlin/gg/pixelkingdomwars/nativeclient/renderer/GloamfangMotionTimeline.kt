package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import kotlin.math.abs
import kotlin.math.hypot

data class GloamfangBodyAction(
    val owner: Int, val eventOrdinal: Int, val state: String,
    val startMs: Float, val endMs: Float, val facing: String,
    val phaseStartMs: Float, val looping: Boolean, val automatic:Boolean=false,
)

data class GloamfangMotionPose(
    val x: Float, val y: Float, val groundY: Float, val facing: String,
    val clipState: String, val phaseStartMs: Float, val bodyOwner: Int,
    val bodyEventOrdinal: Int, val alive: Boolean, val moving: Boolean, val looping: Boolean,
    val controllerFacing:String=facing,
)

/** Continuous canonical-time presentation, rebuilt from a complete revision.
 * Phaser captures a sprite tween's start on its next manager update. Here that
 * delay is zero: a surviving Leap counter supplies its value at delivery time.
 * No browser/device frame cadence is copied into the event protocol. */
class GloamfangMotionTimeline(
    events: List<PresentationEvent>, actorId: Int,
    deliveries: Map<Int, PositionDelivery>, private val art: CombatArt,
    private val tickDurationMs: Float, private val unitScale: Float,
    private val leapDurationMs: Float = requireNotNull(art.leap).durationMs,
    private val leapHeightRatio: Float = requireNotNull(art.leap).heightRatio,
    private val nearZeroPositionDistance: Float = requireNotNull(art.leap).positionSnapDistance,
    actorEvents: List<Pair<Int, JsonValue>>? = null,
    private val nearestStandTarget: ((ms: Float, beforeEventOrdinal: Int, x: Float, y: Float) -> Pair<Float, Float>?)? = null,
    private val legacyAutomatic:Boolean=false,
    idleFacingEvents:List<Pair<Int,JsonValue>> = emptyList(),
    private val hitFromTick:Float=0f,
) {
    private data class Point(val x: Float, val y: Float, val groundY: Float = y)
    private data class Segment(val start: Float, val end: Float, val from: Point, val to: Point, val height: Float = 0f) {
        fun at(ms: Float): Point {
            val p = if (end == start) 1f else ((ms - start) / (end - start)).coerceIn(0f, 1f)
            val x = from.x + (to.x - from.x) * p
            val ground = from.y + (to.y - from.y) * p
            return Point(x, ground - height * 4f * p * (1f - p), ground)
        }
    }
    private data class State(
        val fixed: Point, val body: GloamfangBodyAction, val alive: Boolean = true,
        val moving: Boolean = false, val pendingSnap: Boolean = false,
        val arc: Segment? = null, val move: Segment? = null,
        val instant: Point? = null, val instantAt: Float = Float.NaN,
    ) {
        fun point(ms: Float): Point = if (ms == instantAt && instant != null) instant else
            move?.takeIf { ms <= it.end }?.at(ms) ?: arc?.takeIf { ms <= it.end }?.at(ms) ?: fixed
    }
    private data class Checkpoint(val ms: Float, val ordinal: Int, val state: State)
    private data class Cue(val ms: Float, val ordinal: Int, val data: JsonValue)
    private val checkpoints = mutableListOf<Checkpoint>()
    private val idleFacing=IdleFacingHistory()
    val bodyActions: List<GloamfangBodyAction>
    val motionEndMs: Float get() = checkpoints.lastOrNull()?.ms ?: 0f

    init {
        require(tickDurationMs.isFinite() && tickDurationMs > 0 && unitScale.isFinite() && unitScale > 0)
        require(leapDurationMs.isFinite() && leapDurationMs > 0 && leapHeightRatio.isFinite() && leapHeightRatio >= 0)
        require(nearZeroPositionDistance.isFinite() && nearZeroPositionDistance > 0)
        require(hitFromTick.isFinite() && hitFromTick >= 0)
        if (actorEvents == null) require(events.zipWithNext().all { (a, b) -> a.t <= b.t })
        else require(actorEvents.zipWithNext().all { (a, b) -> a.first < b.first })
        require(art.leap != null) { "Gloamfang facing metadata missing" }
        // A caller that already validates the complete journal can share its
        // parsed numeric-actor grouping; never parse the full log per actor.
        val parsed = if(actorEvents==null)events.mapIndexed { ordinal, event -> ordinal to JsonReader().parse(event.json) }
            else actorEvents+if(legacyAutomatic)idleFacingEvents else emptyList()
        val runTicks = mutableSetOf<Int>()
        val cues = mutableListOf<Cue>()
        parsed.forEach { (ordinal, e) ->
            require(e.getInt("t") == events[ordinal].t && e.getString("e") == events[ordinal].e)
            val id = e.get(if(e.getString("e")=="hit")"target" else "id")
            if (!(legacyAutomatic && e.getString("e")=="destroyed") && (id?.isNumber != true || id.asInt() != actorId)) return@forEach
            val t = e.getInt("t")
            if (e.getString("e") == "attackRun") {
                val count = e.getInt("count"); val cadence = e.getInt("cadenceTicks")
                require(count > 0 && cadence > 0 && count.toLong() * cadence <= (events.lastOrNull()?.t ?: 0).toLong() + cadence)
                repeat(count) { cycle ->
                    val at = Math.addExact(t, Math.multiplyExact(cycle, cadence))
                    runTicks += at; cues += Cue(at * tickDurationMs, ordinal, e)
                }
            } else {
                val delivery = deliveries[ordinal]
                if (e.getString("e") == "pos" && (delivery == null || delivery.skip)) return@forEach
                cues += Cue((delivery?.startTick ?: t.toFloat()) * tickDurationMs, ordinal, e)
            }
        }
        cues.removeAll { it.data.getString("e") in setOf("troopAttack", "troopFire") && it.data.getInt("t") in runTicks }
        cues.sortWith(compareBy<Cue> { it.ms }.thenBy { it.ordinal })
        val actions = mutableListOf<GloamfangBodyAction>()
        var current: State? = null
        var automatic=legacyAutomatic
        fun controllerFacing(s:State,ms:Float)=idleFacing.before(s.body.owner,ms,s.body.facing)
        var nextOwner = 0
        fun body(state: String, ms: Float, ordinal: Int, facing: String, loop: Boolean, preservePhase: Boolean = false,automatic:Boolean=false): GloamfangBodyAction {
            val clip = requireNotNull(art.clips[state]) { "Missing Gloamfang body $state" }
            val old = current?.body
            if (old != null) actions[old.owner] = old.copy(endMs = minOf(old.endMs, ms))
            val phase = if (preservePhase && old?.looping == true && old.state == state) old.phaseStartMs else ms
            return GloamfangBodyAction(nextOwner++, ordinal, state, ms,
                if (loop) Float.POSITIVE_INFINITY else ms + clip.durationMs, facing, phase, loop,automatic).also { actions += it }
        }
        fun stand(s: State, ms: Float, ordinal: Int = Int.MAX_VALUE): State {
            val state = if (s.moving) art.profile.getString("battleMove",null) ?: art.profile.getString("move") else art.profile.getString("stand")
            val visible = s.point(ms)
            val target = if (s.moving) null else nearestStandTarget?.invoke(ms, ordinal, visible.x, visible.y)
            val retained=controllerFacing(s,ms)
            val facing = target?.let { face(it.first - visible.x, it.second - visible.y, retained) } ?: retained
            val auto=automatic && !s.moving && target!=null && ms<(events.lastOrNull()?.t ?: 0)*tickDurationMs
            val attacks=if(auto)art.profile.get("attack").map { it.asString() } else emptyList()
            require(!auto || attacks.size==1) { "Legacy Gloamfang needs source-authored attack sequencing" }
            return s.copy(body = body(if(auto)attacks.single() else state, ms, s.body.eventOrdinal, facing, !auto, !auto,auto))
        }
        fun finishBefore(until: Float, inclusive: Boolean) {
            while (true) {
                val s = current ?: return
                val end = minOf(s.arc?.end ?: Float.POSITIVE_INFINITY, s.move?.end ?: Float.POSITIVE_INFINITY,
                    if (s.alive && !s.body.looping) s.body.endMs else Float.POSITIVE_INFINITY)
                if (!end.isFinite() || if (inclusive) end > until else end >= until) return
                val visible = s.point(end)
                var next = s.copy(instant = visible, instantAt = end)
                if (s.arc?.end == end) next = next.copy(fixed = s.arc.to, arc = null)
                if (s.move?.end == end) next = next.copy(fixed = s.move.to, move = null, moving = false)
                current = next
                if (s.body.endMs == end || (s.move?.end == end && s.body.looping)) next = stand(next, end)
                current = next; checkpoints += Checkpoint(end, Int.MAX_VALUE, next)
            }
        }
        for ((cueIndex,cue) in cues.withIndex()) {
            require(cue.ms.isFinite())
            finishBefore(cue.ms, false)
            val e = cue.data; val type = e.getString("e"); val ms = cue.ms; val ordinal = cue.ordinal
            fun at() = Point(e.getFloat("x") * unitScale, e.getFloat("y") * unitScale)
            var s = current
            if (type in setOf("deploy", "spawn", "troopSpawn")) {
                if (s != null) continue
                val state = art.profile.getString("spawn", null)?.takeIf { art.clips.containsKey(it) } ?: art.profile.getString("stand")
                val b = body(state, ms, ordinal, "s", state == art.profile.getString("stand"))
                s = State(at(), b)
            } else if (s == null || !s.alive) continue
            else when (type) {
                "pos" -> {
                    val target = at(); val visible = s.point(ms)
                    if (s.pendingSnap) {
                        s = s.copy(fixed = target, move = null, pendingSnap = false, instant = target, instantAt = ms)
                        current = s; s = stand(s, ms, ordinal)
                    } else {
                        s = s.copy(fixed = visible, move = null, instant = null)
                        if (abs(target.x - visible.x) < nearZeroPositionDistance && abs(target.y - visible.y) < nearZeroPositionDistance) {
                            val wasWalking=s.moving && s.body.looping
                            s = s.copy(fixed = target, moving = false, instant = target, instantAt = ms)
                            if (s.body.looping && (!legacyAutomatic || wasWalking)) { current = s; s = stand(s, ms, ordinal) }
                        } else {
                            val start = s.arc?.at(ms) ?: visible
                            val duration = requireNotNull(deliveries[ordinal]).durationMs
                            val retained=controllerFacing(s,ms)
                            val facing = if (s.body.looping || s.body.automatic) face(target.x - visible.x, target.y - visible.y, retained) else retained
                            s = s.copy(move = Segment(ms, ms + duration, start, target), moving = true)
                            if (s.body.looping || s.body.automatic) {
                                current = s
                                s = s.copy(body = body(art.profile.getString("battleMove",null) ?: art.profile.getString("move"), ms, ordinal, facing, true, true))
                            }
                        }
                    }
                }
                "troopAbility" -> {
                    val target = at(); val aimed = e.has("ix") && e.has("iy")
                    val retained=controllerFacing(s,ms)
                    val facing = if (aimed) face(e.getFloat("ix") * unitScale - target.x, e.getFloat("iy") * unitScale - target.y, retained) else retained
                    s = s.copy(fixed = target, arc = null, move = null, moving = false, instant = target, instantAt = ms,
                        body = s.body.copy(facing = facing))
                    val ability = e.getString("ability")
                    if (ability == "howl" || (aimed && ability in setOf("leap", "lunge"))) {
                        current = s; s = s.copy(body = body(ability, ms, ordinal, facing, false))
                        if (ability == "leap") {
                            val to = Point(e.getFloat("ix") * unitScale, e.getFloat("iy") * unitScale)
                            s = s.copy(arc = Segment(ms, ms + leapDurationMs, target, to,
                                hypot(to.x - target.x, to.y - target.y) * leapHeightRatio))
                        } else if (ability == "lunge") s = s.copy(pendingSnap = true)
                    }
                }
                "emerge" -> {
                    val wasWalking = s.moving && s.body.looping
                    s = s.copy(fixed = at(), arc = null, move = null, moving = false, instant = at(), instantAt = ms)
                    if (wasWalking) { current = s; s = stand(s, ms, ordinal) }
                }
                "troopDeath", "detonate" -> {
                    val visible = s.point(ms); current = s
                    s = s.copy(fixed = visible, arc = null, move = null, pendingSnap = false, moving = false, alive = false,
                        instant = visible, instantAt = ms,
                        body = body(art.profile.getString("death", "death"), ms, ordinal, controllerFacing(s,ms), false))
                }
                "hit" -> {
                    val hit=art.profile.getString("hit",null)
                    // Source onHit accepts only controller idle. Specialized
                    // movement/Howl/Leap/Lunge owners cannot be interrupted;
                    // historical hits do not acquire a body after cold entry.
                    if(e.getInt("t")>=hitFromTick && !s.moving && (s.body.looping || legacyAutomatic && s.body.automatic)
                        && hit!=null && hit in art.clips) {
                        current=s;s=s.copy(body=body(hit,ms,ordinal,controllerFacing(s,ms),false))
                    }
                }
                "troopAttack", "troopFire", "attackRun" -> {
                    val technique = e.getString("technique", "")
                    if (technique !in setOf("howl", "leap", "lunge", "firestorm", "maul", "detonate")) {
                        val kind = e.getString("targetKind", if (e.get("target")?.isNumber == true) "troop" else "building")
                        val state = art.profile.get("melee")?.getString(kind, null)
                        if (state != null && state in art.clips && (technique != "rend" || state == "rend") &&
                            (technique != "slam" || state in setOf("pound", "attack"))) {
                            automatic=false
                            val visible = s.point(ms)
                            val facing = face(e.getFloat("ix") * unitScale - visible.x, e.getFloat("iy") * unitScale - visible.y, controllerFacing(s,ms))
                            current = s; s = s.copy(body = body(state, ms, ordinal, facing, false))
                        }
                    }
                }
            }
            current = s; checkpoints += Checkpoint(ms, ordinal, s)
            if(legacyAutomatic && cues.getOrNull(cueIndex+1)?.ms!=ms) {
                finishBefore(ms,true)
                current?.takeIf { it.alive && !it.moving && (it.body.automatic || it.body.looping) }?.let { idle->
                    val p=idle.point(ms);val target=nearestStandTarget?.invoke(ms,Int.MAX_VALUE,p.x,p.y)
                    val direction=target?.let { face(it.first-p.x,it.second-p.y,controllerFacing(idle,ms)) } ?: controllerFacing(idle,ms)
                    idleFacing.record(idle.body.owner,ms,direction)
                    if(!automatic && idle.body.looping && direction!=idle.body.facing) {
                        current=idle.copy(body=body(idle.body.state,ms,Int.MAX_VALUE,direction,true,true))
                        checkpoints+=Checkpoint(ms,Int.MAX_VALUE,current!!)
                    }
                }
            }
        }
        finishBefore(if(legacyAutomatic)maxOf((events.lastOrNull()?.t ?: 0)*tickDurationMs,
            current?.body?.takeUnless { it.automatic }?.endMs?.takeIf { it.isFinite() } ?: 0f) else Float.POSITIVE_INFINITY, true)
        bodyActions = actions.toList()
    }

    private fun face(dx: Float, dy: Float, retained: String) = art.leap!!.aim.facing(dx, dy, retained)

    /** beforeEventOrdinal excludes that event and later source-order events at
     * this exact time; earlier delivered endpoints remain visible. */
    fun sample(tick: Float, beforeEventOrdinal: Int? = null): GloamfangMotionPose? {
        require(tick.isFinite() && tick >= 0)
        val ms = tick * tickDurationMs
        var low = 0; var high = checkpoints.size
        while (low < high) {
            val mid = (low + high) ushr 1; val c = checkpoints[mid]
            if (c.ms < ms || (c.ms == ms && (beforeEventOrdinal == null || c.ordinal < beforeEventOrdinal))) low = mid + 1 else high = mid
        }
        val s = checkpoints.getOrNull(low - 1)?.state ?: return null
        val p = s.point(ms); val b = s.body
        return GloamfangMotionPose(p.x, p.y, p.groundY, b.facing, b.state, b.phaseStartMs, b.owner, b.eventOrdinal, s.alive, s.moving, b.looping,
            idleFacing.before(b.owner,ms,b.facing))
    }
}
