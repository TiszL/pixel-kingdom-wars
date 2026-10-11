package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens

/*
 * The battle result's celebration timeline (design/final/army/SPEC.md "Round 2, part two: battle result as a
 * celebration" + the second-pass critic fixes), as a pure function of time, so the composable only samples it every frame
 * and the order of events is unit-tested (ResultCelebrationTimelineTest). Times are ms from the battle's end:
 *
 *   0       scrim 0 → 60 % over 160 `out`
 *   160 / 400 / 640   the three stars land one by one (scale 1.6 → 1, 24 dp drop, 180 ms `pop`); earned stars sparkle
 *                     (3 frames at 12 fps), unearned stars land grey with no sparkle
 *   820     the plate drops 12 dp + fades in (160 `pop`); victory: the ribbon gleam sweeps (240 ms)
 *   980     victory rays fade in (200 ms) and turn 8°/s; the verdict chip fades in (120)
 *   1,100   medallions rise 16 dp + fade (180 `out`, 60 ms apart)
 *   receipt each medallion counts (600 ms); 6 shard coins fly to the readout (450 ms `in`, 40 ms apart); the readout
 *           pulses 1.06 (120 ms) and counts up. NEVER before the settlement receipt (and never on a defeat's coins).
 *   +200    after the count: the army chip fades in (120)
 *   +120    the doors rise with a 30 ms stagger (160 `out`), HOME last
 *   tap     before the count ends: skip to the end state (all values final); a second tap is a normal press
 *
 * PENDING: everything up to the medallions plays, medallions read "…", no coins fly, doors are live (army and doors follow
 * the medallions). Reduced motion: everything appears together in a 120 ms cross-fade; no rays, no flight, values final.
 */

/** The fixed beats of the timeline, in ms (TOKENS.json `motion` where a token exists). */
object ResultBeats {
    const val SCRIM_MS = PkwTokens.Motion.PLATE_IN
    val STAR_AT = longArrayOf(160, 400, 640)
    const val STAR_MS = 180
    const val SPARKLE_FRAME_MS = 83 // 12 fps
    const val SPARKLE_FRAMES = 3
    const val PLATE_AT = 820L
    const val PLATE_MS = PkwTokens.Motion.RIBBON_DROP
    const val GLEAM_MS = 240
    const val RAYS_AT = 980L
    const val RAYS_MS = 200
    const val VERDICT_MS = 120
    const val MEDALS_AT = 1_100L
    const val MEDAL_MS = 180
    const val MEDAL_STAGGER = 60
    const val COUNT_MS = PkwTokens.Motion.COUNT_UP
    const val COIN_MS = PkwTokens.Motion.COIN_FLY
    const val COIN_STAGGER = 40
    const val COINS = 6
    const val PULSE_MS = 120
    const val ARMY_AFTER = 200L
    const val ARMY_MS = 120
    const val DOORS_AFTER = 120L
    const val DOOR_STAGGER = 30
    const val DOOR_MS = 160
    const val REDUCED_MS = PkwTokens.Motion.REDUCED_CROSSFADE
}

/** What the timeline is for: a victory (rays, gleam, coins), the stars earned, how many medallions and doors. */
data class ResultTimelineSpec(val won: Boolean, val earned: Int, val medals: Int, val doors: Int, val reduced: Boolean = false)

/**
 * One sampled frame. Every progress is 0..1 (0 = not started, 1 = landed / fully in). [stars], [medals], [doors] have one
 * entry per element; [sparkle] is the sparkle frame (0..2) of each star, or null when none shows; [coins] is the flight
 * progress of each coin that is in the air right now (empty when none); [count] drives the medallion and readout
 * count-up (0 until the receipt); [pulse] is the readout's scale (1 at rest, up to 1.06); [done] = nothing left to animate.
 */
data class ResultFrame(
    val scrim: Float,
    val stars: List<Float>,
    val sparkle: List<Int?>,
    val plate: Float,
    val gleam: Float,
    val rays: Float,
    val verdict: Float,
    val medals: List<Float>,
    val count: Float,
    val coins: List<Float>,
    val pulse: Float,
    val army: Float,
    val doors: List<Float>,
    val done: Boolean,
)

/** 0..1 progress of a step that starts at [start] and lasts [duration] ms. */
fun stepProgress(t: Long, start: Long, duration: Int): Float =
    if (duration <= 0) (if (t >= start) 1f else 0f) else ((t - start).toFloat() / duration).coerceIn(0f, 1f)

/** When the last medallion has risen. */
fun medalsDoneAt(medals: Int): Long =
    ResultBeats.MEDALS_AT + ResultBeats.MEDAL_MS + (medals - 1).coerceAtLeast(0) * ResultBeats.MEDAL_STAGGER

/** When the count-in starts: after the receipt AND after the medallions are in; null before the receipt. */
fun countStartAt(spec: ResultTimelineSpec, settledAtMs: Long?): Long? = settledAtMs?.let { maxOf(it, medalsDoneAt(spec.medals)) }

/** How long the count-in runs: the 600 ms count, or on a victory the coin flight if it is longer (6 coins, 40 ms apart). */
fun countLength(spec: ResultTimelineSpec): Long {
    val coins = if (spec.won) ResultBeats.COIN_MS + (ResultBeats.COINS - 1) * ResultBeats.COIN_STAGGER + ResultBeats.PULSE_MS else 0
    return maxOf(ResultBeats.COUNT_MS, coins).toLong()
}

/**
 * When the army chip starts. If the receipt landed before the medallions finished, the chip waits for the count (+200).
 * Otherwise (PENDING, or a late receipt) it follows the medallions (+200), and a later count never hides it again.
 */
fun armyAt(spec: ResultTimelineSpec, settledAtMs: Long?): Long {
    val medalsDone = medalsDoneAt(spec.medals)
    val start = countStartAt(spec, settledAtMs)
    return if (settledAtMs != null && settledAtMs <= medalsDone && start != null) start + countLength(spec) + ResultBeats.ARMY_AFTER
    else medalsDone + ResultBeats.ARMY_AFTER
}

/** When door [i] starts rising (30 ms stagger after the army chip + 120). */
fun doorAt(spec: ResultTimelineSpec, settledAtMs: Long?, i: Int): Long =
    armyAt(spec, settledAtMs) + ResultBeats.DOORS_AFTER + i * ResultBeats.DOOR_STAGGER

/** True while a tap should skip to the end (before the count ends, or before the doors are up when there is no count). */
fun canSkip(t: Long, spec: ResultTimelineSpec, settledAtMs: Long?): Boolean = !resultFrame(t, spec, settledAtMs, skipped = false).done

/**
 * The frame at [t] ms after the battle's end. [settledAtMs] is when the settlement receipt arrived on the same clock
 * (null while PENDING / FAILED / REDACTED: nothing counts and no coin flies). [skipped] jumps to the end state.
 */
fun resultFrame(t: Long, spec: ResultTimelineSpec, settledAtMs: Long?, skipped: Boolean): ResultFrame {
    val b = ResultBeats
    val medalsN = spec.medals.coerceAtLeast(0)
    val doorsN = spec.doors.coerceAtLeast(0)
    if (skipped || spec.reduced) {
        // Reduced motion: one 120 ms cross-fade for everything; skip: the final state at once. Values are final either way.
        val a = if (skipped) 1f else stepProgress(t, 0, b.REDUCED_MS)
        val counted = if (settledAtMs != null) 1f else 0f
        return ResultFrame(a, List(3) { a }, List(3) { null }, a, 0f, 0f, a, List(medalsN) { a }, counted, emptyList(), 1f, a,
            List(doorsN) { a }, done = a >= 1f)
    }
    val stars = List(3) { i -> stepProgress(t, b.STAR_AT[i], b.STAR_MS) }
    val sparkle = List(3) { i ->
        val land = b.STAR_AT[i] + b.STAR_MS
        val frame = ((t - land) / b.SPARKLE_FRAME_MS).toInt()
        if (i < spec.earned && t >= land && frame < b.SPARKLE_FRAMES) frame else null
    }
    val plate = stepProgress(t, b.PLATE_AT, b.PLATE_MS)
    val gleam = if (spec.won) stepProgress(t, b.PLATE_AT + b.PLATE_MS, b.GLEAM_MS).let { if (it >= 1f) 0f else it } else 0f
    val rays = if (spec.won) stepProgress(t, b.RAYS_AT, b.RAYS_MS) else 0f
    val verdict = stepProgress(t, b.RAYS_AT, b.VERDICT_MS)
    val medals = List(medalsN) { i -> stepProgress(t, b.MEDALS_AT + i * b.MEDAL_STAGGER, b.MEDAL_MS) }
    val start = countStartAt(spec, settledAtMs)
    val count = if (start == null) 0f else stepProgress(t, start, b.COUNT_MS)
    val coins = if (start == null || !spec.won) emptyList() else List(b.COINS) { i -> stepProgress(t, start + i * b.COIN_STAGGER, b.COIN_MS) }
        .filter { it > 0f && it < 1f }
    val pulse = if (start == null || !spec.won) 1f else {
        val p = stepProgress(t, start + b.COIN_MS + (b.COINS - 1) * b.COIN_STAGGER, b.PULSE_MS)
        if (p <= 0f || p >= 1f) 1f else 1f + 0.12f * (if (p < 0.5f) p else 1f - p)
    }
    val army = stepProgress(t, armyAt(spec, settledAtMs), b.ARMY_MS)
    val doors = List(doorsN) { i -> stepProgress(t, doorAt(spec, settledAtMs, i), b.DOOR_MS) }
    val countDone = start == null || t >= start + countLength(spec)
    val doorsDone = doors.all { it >= 1f } && army >= 1f
    return ResultFrame(stepProgress(t, 0, b.SCRIM_MS), stars, sparkle, plate, gleam, rays, verdict, medals, count, coins, pulse, army, doors,
        done = countDone && doorsDone && plate >= 1f)
}
