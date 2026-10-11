package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandMedallion
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.countUpText
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Design component: the RE-DONE battle result (design/final/army/SPEC.md "Round 2, part two: battle result as a
 * celebration" + "Round 2 critic fixes, second pass: result screens"; result.png, result-defeat.png). REPLACES
 * BattleResultCard.kt (§7's ledger card): one celebration over the frozen last battle frame under the 60 % full-card
 * scrim: three big stars land one by one, the VICTORY / DEFEAT plate, the verdict chip, two loot medallions that count
 * into the resource stack (only after the settlement receipt), the army spent, then four doors RETRAIN · REPLAY · NEXT ·
 * HOME. The motion is sampled from the pure [resultFrame] timeline (ResultCelebrationTimeline.kt).
 */

/** The settlement states of §7 (PENDING / SETTLED / REDACTED / FAILED). Nothing counts, flies or pays before SETTLED. */
enum class ResultSettlement { PENDING, SETTLED, REDACTED, FAILED }

/** A medallion's delta tone: green gain `#22701E`, red loss `#A3261A`, ink-2 zero. */
enum class MedalTone { GAIN, LOSS, ZERO }

/** One loot medallion (SPEC `LootMedalUi(icon, delta, tone, name, context, counting)`); at most three. */
@Immutable data class LootMedalUi(
    /** 36 dp icon ("shards", "trophy"; Divine mode SCORE / RANK art). */
    val icon: String,
    /** The PS 16 signed delta ("+12,400", "−9", "0"); counts from 0 after the receipt. "…" while unknown. */
    val delta: String,
    /** Its tone. */
    val tone: MedalTone,
    /** VT 20 name ("Shards", "Trophies"). */
    val name: String,
    /** VT 18 context ("into your stores", "Gold league", "nothing taken"). */
    val context: String,
    /** True on the medallion that counts into the readouts (Shards): selected tint + gold rim while counting, the coin source. */
    val counting: Boolean,
)

/** One top-right readout the loot counts into (VeilChip row 108 × 26). */
@Immutable data class ResultReadoutUi(
    /** The registry row (a tap is not offered during the result; kept for the mapper's identity). */
    val id: FeatureId,
    /** 24 dp icon ("shards", "trophy"). */
    val icon: String,
    /** The value before the battle ("40,943"), "…" unknown. */
    val before: String,
    /** The value after the receipt ("53,343"); the row counts before → after over 600 ms. */
    val after: String,
    /** The PS 11 delta beside the row ("+12,400" green, "−9" red-hi); null draws none. */
    val delta: String?,
    /** True: the delta is a loss (red-hi). */
    val loss: Boolean = false,
    /** Screen-reader text ("Shards 53,343, plus 12,400"). */
    val description: String = "",
)

/** Everything the result celebration draws (SPEC §7 `BattleResultUi` + Round 2 `medallions`, `retrainCount`). */
@Immutable data class BattleResultV2Ui(
    /** Victory or defeat. */
    val won: Boolean,
    /** 0-3 stars earned. */
    val stars: Int,
    /** Destruction percent (PS 13 gold-hi "74%"); null when the server result does not carry it: drawn "…", never 0. */
    val destroyedPct: Int?,
    /** The verdict after the percent: "destroyed · vs Ironjaw", "destroyed · the walls held", "destroyed · Stage 36". */
    val verdict: String,
    /** PvP, campaign or Divine. */
    val mode: BattleMode,
    /** Where the server's settlement stands. */
    val settlement: ResultSettlement,
    /** Two medallions (three on a campaign first clear; Divine: SCORE and RANK). PENDING / FAILED: deltas read "…". */
    val medallions: List<LootMedalUi>,
    /** The readouts the loot counts into (Shards first, then trophies). */
    val readouts: List<ResultReadoutUi>,
    /** Troops spent (mini portraits 28 with outlined counts). */
    val armySpent: List<ArmyTileUi>,
    /** Heroes used (24). */
    val heroesUsed: List<String>,
    /** RETRAIN (blue, portrait) → `Army(TRAIN, prefill = LAST_ARMY)`. */
    val retrain: CommandUi,
    /** REPLAY (stone) → `Replay(id)`; null when no replay was saved. */
    val replay: CommandUi?,
    /** NEXT (stone, attack icon) → `RaidChooser(MATCH)`; campaign RETRY / NEXT STAGE; LOCKED "Energy back in 12m". */
    val next: CommandUi,
    /** HOME, the green 120 × 92 primary → Home with the world kept. */
    val home: CommandUi,
    /** Troops to retrain (the blue count badge on RETRAIN); null = none. */
    val retrainCount: Int?,
    /** Defeat only: "REPLAY shows what held them off."; null draws none. */
    val defeatHint: String? = null,
    /** The saved replay's id for [BattleResultV2Actions.onReplay]. */
    val replayId: String? = null,
)

/** Result callbacks (SPEC §7, Round 2 doors). */
class BattleResultV2Actions(
    val onHome: () -> Unit,
    val onNext: () -> Unit,
    val onRetrain: () -> Unit,
    val onReplay: (String) -> Unit,
    /** A door that is LOCKED / DISABLED (NEXT with no energy): the host shows its reason as a toast. */
    val onRefused: (CommandUi) -> Unit = {},
    /** A SHORT door: Need-more. */
    val onNeedMore: (PriceUi) -> Unit = {},
    /** Sensory hooks (the SFX / haptic bridge): a star landed (index, earned); the count-in started (victory or not). */
    val onStarLanded: (Int, Boolean) -> Unit = { _, _ -> },
    val onCountStarted: (Boolean) -> Unit = {},
)

/** The fixed layout of the 412 × 915 frame (SPEC part two table), in dp from the top. */
private object ResultLayout {
    val readoutsTop = 10.dp
    val raysTop = (-20).dp
    val starsTop = 98.dp
    val plateTop = 216.dp
    val verdictTop = 302.dp
    val medalsTop = 352.dp
    val armyTop = 510.dp
    val hintTop = 576.dp
}

/**
 * The battle result celebration (result.png / result-defeat.png). It fills its host (the battle scene's overlay slot)
 * over the frozen last battle frame.
 *
 * Pointer rule: this is a FULL card over the parked battle, so it is the one surface here that composes a full-screen
 * [ModalScrim] (60 %, `PkwTokens.Scrim.FULL_CARD`), and only while it is shown; the host must remove this composable when
 * the result is dismissed. The scrim's only job is the SPEC's "any tap before the count ends skips to the end state"; it
 * never closes or confirms anything. Every action is a painted door (a 48+ dp target with a label).
 */
@Composable fun BattleResultCardV2(ui: BattleResultV2Ui, on: BattleResultV2Actions, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val doors = remember(ui.retrain, ui.replay, ui.next, ui.home, ui.retrainCount) { resultDoors(ui) }
    val spec = ResultTimelineSpec(ui.won, ui.stars.coerceIn(0, 3), ui.medallions.size.coerceAtMost(3), doors.size, reduced)
    val settled = ui.settlement == ResultSettlement.SETTLED
    var t by remember { mutableLongStateOf(if (inspection) 60_000L else 0L) }
    var settledAt by remember { mutableStateOf<Long?>(if (inspection && settled) 0L else null) }
    var skipped by remember { mutableStateOf(false) }
    LaunchedEffect(settled) { if (settled && settledAt == null) settledAt = t }
    LaunchedEffect(settled, skipped, reduced) {
        if (inspection) return@LaunchedEffect
        val origin = withFrameMillis { it } - t
        while (true) {
            val now = withFrameMillis { it } - origin
            t = now
            if (resultFrame(now, spec, settledAt, skipped).done) break
        }
    }
    val frame = resultFrame(t, spec, settledAt, skipped)
    ResultSensoryHooks(frame, spec, on)

    var root by remember { mutableStateOf(Offset.Zero) }
    var coinFrom by remember { mutableStateOf<Offset?>(null) }
    var coinTo by remember { mutableStateOf<Offset?>(null) }
    val count = frame.count

    Box(modifier.fillMaxSize().onGloballyPositioned { root = it.positionInRoot() }) {
        ModalScrim(PkwTokens.Scrim.FULL_CARD * frame.scrim, onTap = { if (!frame.done) skipped = true })
        if (ui.won && frame.rays > 0f) CelebrationRays(frame.rays, still = reduced || inspection,
            Modifier.align(Alignment.TopCenter).offset(y = ResultLayout.raysTop).size(412.dp, 560.dp))

        Column(Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = ResultLayout.readoutsTop, end = 8.dp), horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            ui.readouts.forEachIndexed { i, r ->
                ReadoutRow(r, count, if (i == 0) frame.pulse else 1f,
                    if (i == 0) Modifier.onGloballyPositioned { coinTo = it.positionInRoot() + Offset(it.size.width * 0.15f, it.size.height / 2f) } else Modifier)
            }
        }

        ResultStarsV2(ui.stars, frame, Modifier.align(Alignment.TopCenter).offset(y = ResultLayout.starsTop))
        ResultPlate(ui.won, frame.plate, frame.gleam, Modifier.align(Alignment.TopCenter).offset(y = ResultLayout.plateTop))
        val percent = ui.destroyedPct?.let { "$it%" } ?: UNKNOWN
        Plate(PlateKind.VEIL, Modifier.align(Alignment.TopCenter).offset(y = ResultLayout.verdictTop).heightIn(min = 34.dp)
            .graphicsLayer { alpha = frame.verdict }.clearAndSetSemantics { contentDescription = "$percent ${ui.verdict}" },
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 2.dp), blocksScene = false) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(percent, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                PkwText(ui.verdict, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
            }
        }

        MedalRow(ui, frame, onCoinSource = { coinFrom = it }, Modifier.align(Alignment.TopCenter).offset(y = ResultLayout.medalsTop))

        ArmySpentChip(ui, Modifier.align(Alignment.TopCenter).offset(y = ResultLayout.armyTop).graphicsLayer { alpha = frame.army })
        ui.defeatHint?.takeIf { !ui.won }?.let {
            // result-defeat.png: the hint is a 34 dp VeilChip (the kit chip's floor is 30).
            VeilChip(it, Modifier.align(Alignment.TopCenter).offset(y = ResultLayout.hintTop).heightIn(min = 34.dp)
                .graphicsLayer { alpha = frame.army })
        }

        DoorShelf(doors, frame, ui, on, Modifier.align(Alignment.BottomStart))

        // Coins in flight: shard icons on an arc from the counting medallion to the Shards readout (victory, after the receipt).
        val from = coinFrom; val to = coinTo
        if (from != null && to != null) frame.coins.forEach { p ->
            val pos = Offset(from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p - sin(PI * p).toFloat() * 120f) - root
            PkwIcon("shards", 24.dp, Modifier.offset { IntOffset(pos.x.roundToInt() - 12.dp.roundToPx(), pos.y.roundToInt() - 12.dp.roundToPx()) }
                .graphicsLayer { alpha = if (p < 0.3f) 0.55f else 1f }.clearAndSetSemantics { })
        }
    }
}

/** The doors in CommandBar order (≤ 4, primary last): RETRAIN (blue count badge), REPLAY, NEXT, HOME. */
private fun resultDoors(ui: BattleResultV2Ui): List<CommandUi> {
    val retrain = ui.retrain.copy(primary = false, verb = Verb.BLUE,
        badge = ui.retrainCount?.let { n -> badgeCount(n)?.let { BadgeUi(it, BadgeTone.INFO, "$n troops to retrain") } } ?: ui.retrain.badge)
    return listOfNotNull(retrain, ui.replay?.copy(primary = false), ui.next.copy(primary = false), ui.home.copy(primary = true, verb = Verb.GREEN))
}

/** Calls the sensory hooks once per beat (stars landing, the count starting); the bridge owns sounds and haptics. */
@Composable private fun ResultSensoryHooks(frame: ResultFrame, spec: ResultTimelineSpec, on: BattleResultV2Actions) {
    // fired[0..2] = star i landed, fired[3] = the count started. Plain flags (not state): firing never recomposes.
    val fired = remember { BooleanArray(4) }
    SideEffect {
        frame.stars.forEachIndexed { i, p -> if (p >= 1f && !fired[i]) { fired[i] = true; on.onStarLanded(i, i < spec.earned) } }
        if (frame.count > 0f && !fired[3]) { fired[3] = true; on.onCountStarted(spec.won) }
    }
}

/** A readout row: the PS 11 delta to its left (green / red-hi), then a 108 × 26 veil row with the icon and the counting
 *  value; the Shards row pulses 1.06 when the coins land. */
@Composable private fun ReadoutRow(r: ResultReadoutUi, count: Float, pulse: Float, modifier: Modifier) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.clearAndSetSemantics { contentDescription = r.description.ifBlank { listOfNotNull(r.after, r.delta).joinToString(", ") } }) {
        r.delta?.let { PkwText(it, PkwTokens.Type.caption, color = if (r.loss) PkwTokens.Colors.red.hi else PkwTokens.Colors.green.hi, outline = 1.dp) }
        Plate(PlateKind.VEIL, modifier.size(PkwTokens.Dims.resourceRowW, PkwTokens.Dims.resourceRowH).graphicsLayer { scaleX = pulse; scaleY = pulse },
            contentPadding = PaddingValues(start = 3.dp, end = 6.dp), blocksScene = false) {
            Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwIcon(r.icon, 24.dp)
                PkwText(if (count > 0f) countUpText(r.before, r.after, count) else r.before, PkwTokens.Type.label, Modifier.weight(1f),
                    color = PkwTokens.Colors.text, outline = 1.dp, textAlign = androidx.compose.ui.text.style.TextAlign.End)
            }
        }
    }
}

/** The three stars at 72 dp: x 82 / 170 (raised 28) / 258 of the 412 frame. Each drops 24 dp and scales 1.6 → 1; unearned
 *  stars land grey (35 % brightness, no sparkle); earned ones sparkle 3 frames. */
@Composable private fun ResultStarsV2(earned: Int, frame: ResultFrame, modifier: Modifier) {
    Box(modifier.size(248.dp, 100.dp).semantics(mergeDescendants = true) { contentDescription = "$earned of 3 stars" }) {
        listOf(Triple(0, 0.dp, 28.dp), Triple(1, 88.dp, 0.dp), Triple(2, 176.dp, 28.dp)).forEach { (i, x, y) ->
            val p = frame.stars.getOrElse(i) { 1f }
            val on = i < earned
            Box(Modifier.offset(x, y).size(72.dp)) {
                PkwIcon("star", 72.dp, Modifier.graphicsLayer {
                    val s = 1f + 0.6f * (1f - p); scaleX = s; scaleY = s; alpha = p; translationY = -24.dp.toPx() * (1f - p)
                }.toned(if (on) 1f else 0f, if (on) 1f else 0.35f))
                frame.sparkle.getOrNull(i)?.let { f -> Sparkle(f, Modifier.size(72.dp)) }
            }
        }
    }
}

/** A drawn 4-point pixel sparkle around a landed star (no `fx_sparkle` art is bundled; frame 0..2 grows then shrinks). */
@Composable private fun Sparkle(frameIndex: Int, modifier: Modifier) {
    Canvas(modifier.clearAndSetSemantics { }) {
        val arm = (if (frameIndex == 1) 8 else 5).dp.toPx(); val w = 2.dp.toPx()
        listOf(Offset(size.width * 0.12f, size.height * 0.2f), Offset(size.width * 0.9f, size.height * 0.15f), Offset(size.width * 0.85f, size.height * 0.85f))
            .forEach { c ->
                drawRect(PkwTokens.Colors.gold.hi, Offset(c.x - arm, c.y - w / 2), Size(2 * arm, w))
                drawRect(PkwTokens.Colors.gold.hi, Offset(c.x - w / 2, c.y - arm), Size(w, 2 * arm))
            }
    }
}

/** The ribbon plate (320 × 76): ink shell with notched tails, gold face (victory) or stone face (defeat), PS 16 outlined
 *  VICTORY / DEFEAT; drops 12 dp and fades in; a gold-hi band sweeps across on a victory (the gleam). */
@Composable private fun ResultPlate(won: Boolean, p: Float, gleam: Float, modifier: Modifier) {
    val ramp = if (won) PkwTokens.Colors.gold else PkwTokens.Colors.stone
    Box(modifier.size(320.dp, 76.dp).graphicsLayer { alpha = p; translationY = -12.dp.toPx() * (1f - p) }.semantics { heading() }
        .clipToBounds().drawBehind {
            // result.html `.plaque`: an ink shell with both tails notched 16 dp to the middle, padded 3 / 3 / 7; inside it
            // the face notched 14 dp: a 3 dp hi band, the face to 55 %, the mid colour below and a 6 dp lo lip.
            val w = size.width; val h = size.height
            fun ribbon(left: Float, top: Float, right: Float, bottom: Float, notch: Float): Path = Path().apply {
                val middle = (top + bottom) / 2f
                moveTo(left, top); lineTo(right, top); lineTo(right - notch, middle); lineTo(right, bottom)
                lineTo(left, bottom); lineTo(left + notch, middle); close()
            }
            drawPath(ribbon(0f, 0f, w, h, 16.dp.toPx()), PkwTokens.Colors.ink)
            val i = 3.dp.toPx(); val faceBottom = h - 7.dp.toPx(); val faceH = faceBottom - i
            clipPath(ribbon(i, i, w - i, faceBottom, 14.dp.toPx())) {
                drawRect(ramp.face, Offset(i, i), Size(w - 2 * i, faceH))
                drawRect(ramp.hi, Offset(i, i), Size(w - 2 * i, 3.dp.toPx()))
                drawRect(ramp.mid, Offset(i, i + faceH * 0.55f), Size(w - 2 * i, faceH * 0.45f))
                drawRect(ramp.lo, Offset(i, faceBottom - 6.dp.toPx()), Size(w - 2 * i, 6.dp.toPx()))
                if (gleam > 0f) drawRect(PkwTokens.Colors.gold.hi.copy(alpha = 0.55f), Offset(w * gleam - 12.dp.toPx(), i), Size(12.dp.toPx(), faceH))
            }
        }, contentAlignment = Alignment.Center) {
        PkwText(if (won) "VICTORY" else "DEFEAT", PkwTokens.Type.numeralL, color = PkwTokens.Colors.label, outline = 2.dp)
    }
}

/** Stepped gold sunrays (18° period, 24 % gold-hi) turning 8°/s, faded by [alpha]; reduced motion keeps them still (the
 *  timeline gives 0 anyway). The SPEC's radial mask is approximated by the ray length. Decorative. */
@Composable private fun CelebrationRays(alpha: Float, still: Boolean, modifier: Modifier) {
    val angle: Float = if (still) 0f else {
        val loop = rememberInfiniteTransition(label = "result-rays")
        val a by loop.animateFloat(0f, 360f, infiniteRepeatable(tween((360f / PkwTokens.Motion.RAYS_DEG_PER_S * 1000).toInt(), easing = LinearEasing)),
            label = "result-rays-angle")
        a
    }
    Canvas(modifier.clipToBounds().clearAndSetSemantics { }) {
        val cx = size.width / 2f; val cy = size.height * 0.3f; val r = size.minDimension * 0.75f
        val color = PkwTokens.Colors.gold.hi.copy(alpha = 0.24f * alpha)
        for (k in 0 until 20) {
            val a0 = Math.toRadians((angle + k * 18f).toDouble()); val a1 = Math.toRadians((angle + k * 18f + 9f).toDouble())
            drawPath(Path().apply {
                moveTo(cx, cy); lineTo(cx + r * cos(a0).toFloat(), cy + r * sin(a0).toFloat()); lineTo(cx + r * cos(a1).toFloat(), cy + r * sin(a1).toFloat()); close()
            }, color)
        }
    }
}

/** The medallions (CreamCards 176 × 140, or 3 × 116 on a campaign first clear); each rises 16 dp + fades, 60 ms apart; the
 *  counting one takes the selected tint + gold rim while it counts and reports its icon for the coin flight. */
@Composable private fun MedalRow(ui: BattleResultV2Ui, frame: ResultFrame, onCoinSource: (Offset) -> Unit, modifier: Modifier) {
    val medals = ui.medallions.take(3)
    val wide = medals.size <= 2
    Row(modifier.padding(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(if (wide) 12.dp else 8.dp)) {
        if (ui.settlement == ResultSettlement.REDACTED && medals.isEmpty()) {
            MedalCard(LootMedalUi("shards", "LOOT REDACTED", MedalTone.ZERO, "Loot", "Settled by the server", false), ui.settlement, 1f,
                frame.medals.firstOrNull() ?: 1f, 364.dp, {})
        }
        medals.forEachIndexed { i, m ->
            MedalCard(m, ui.settlement, frame.count, frame.medals.getOrElse(i) { 1f }, if (wide) 176.dp else 116.dp, onCoinSource)
        }
    }
}

@Composable private fun MedalCard(m: LootMedalUi, settlement: ResultSettlement, count: Float, rise: Float, width: androidx.compose.ui.unit.Dp,
    onCoinSource: (Offset) -> Unit) {
    val c = PkwTokens.Colors
    val settled = settlement == ResultSettlement.SETTLED
    val counting = m.counting && settled && count > 0f && count < 1f
    val delta = when {
        settled -> countUpSigned(m.delta, count)
        settlement == ResultSettlement.REDACTED -> m.delta
        else -> UNKNOWN
    }
    val context = if (settlement == ResultSettlement.PENDING) "Counting…" else m.context
    val tone = when { !settled -> c.textOnParch2; m.tone == MedalTone.GAIN -> c.green.lo; m.tone == MedalTone.LOSS -> c.shortText; else -> c.textOnParch2 }
    Box(Modifier.size(width, 140.dp).graphicsLayer { alpha = rise; translationY = 16.dp.toPx() * (1f - rise) }
        .clearAndSetSemantics { contentDescription = "${m.name}: $delta. $context" }
        .drawBehind {
            drawPlate(PlateKind.CREAM, if (counting) c.selectedTint else null)
            if (counting) {
                val i = 2.dp.toPx(); val r = 3.dp.toPx()
                drawRect(c.gold.face, Offset(i, i), Size(size.width - 2 * i, r)); drawRect(c.gold.face, Offset(i, size.height - i - r), Size(size.width - 2 * i, r))
                drawRect(c.gold.face, Offset(i, i), Size(r, size.height - 2 * i)); drawRect(c.gold.face, Offset(size.width - i - r, i), Size(r, size.height - 2 * i))
            }
        }.padding(8.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            PkwIcon(m.icon, 36.dp, if (m.counting) Modifier.onGloballyPositioned {
                onCoinSource(it.positionInRoot() + Offset(it.size.width / 2f, it.size.height / 2f))
            } else Modifier)
            PkwText(delta, PkwTokens.Type.numeralL, color = tone)
            PkwText(m.name, PkwTokens.Type.body, color = c.textOnParch)
            PkwText(context, PkwTokens.Type.small, color = c.textOnParch2)
        }
    }
}

/** "Army spent" + mini portraits 28 (outlined counts) + the hero (VeilChip 54). */
@Composable private fun ArmySpentChip(ui: BattleResultV2Ui, modifier: Modifier) {
    if (ui.armySpent.isEmpty() && ui.heroesUsed.isEmpty()) return
    Plate(PlateKind.VEIL, modifier.heightIn(min = 54.dp).clearAndSetSemantics {
        contentDescription = "Army spent: " + ui.armySpent.joinToString(", ") { it.description.ifBlank { "${it.count} ${it.troop}" } }
    }, contentPadding = PaddingValues(start = 10.dp, top = 4.dp, end = 12.dp, bottom = 6.dp), blocksScene = false) {
        // result.png: padding 0 12 0 10 and a 10 dp gap between the words and the minis.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PkwText("Army spent", PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
            // `.mini2`: the minis sit 4 dp apart.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                ui.armySpent.take(6).forEach { MiniPortrait(it.portrait, count = it.count) }
                ui.heroesUsed.take(2).forEach { MiniPortrait(it, hero = true) }
            }
        }
    }
}

/** The doors (CommandBar grammar) over the two-step shelf (ink 18 % for 16 dp, then 36 %); each rises with a 30 ms stagger,
 *  HOME last. Taps route by the kit's [commandRoute]: LOCKED NEXT explains, SHORT opens Need-more. */
@Composable private fun DoorShelf(doors: List<CommandUi>, frame: ResultFrame, ui: BattleResultV2Ui, on: BattleResultV2Actions, modifier: Modifier) {
    Box(modifier.fillMaxWidth()) {
        Column(Modifier.matchParentSize().clearAndSetSemantics { }) {
            Box(Modifier.fillMaxWidth().height(16.dp).background(PkwTokens.Colors.ink.copy(alpha = 0.18f)))
            Box(Modifier.fillMaxWidth().weight(1f).background(PkwTokens.Colors.ink.copy(alpha = PkwTokens.Scrim.COMMAND_SHELF)))
        }
        // result.html `.cmd`: the 68 dp doors stand at x 12 / 100 / 188 (20 dp apart) with their captions centred under them
        // and free to run wider than the face; HOME (120 × 92) stands 12 dp from the right edge, its foot level with theirs
        // (their faces start 24 dp lower). The shelf is 150 tall: 23 dp above HOME, 8 dp under the captions, then the
        // navigation bar.
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 12.dp, end = 12.dp, top = 23.dp, bottom = 8.dp),
            verticalAlignment = Alignment.Top) {
            doors.forEachIndexed { i, d ->
                if (d.primary) Spacer(Modifier.weight(1f)) else if (i > 0) Spacer(Modifier.width(20.dp))
                val p = frame.doors.getOrElse(i) { 1f }
                val rise = Modifier.graphicsLayer { alpha = p; translationY = 16.dp.toPx() * (1f - p) }
                if (d.primary) CommandMedallion(d, { routeDoor(d, ui, on) }, rise)
                else Box(Modifier.padding(top = PkwTokens.Dims.commandPrimaryH - PkwTokens.Dims.command).width(PkwTokens.Dims.command),
                    contentAlignment = Alignment.TopCenter) {
                    CommandMedallion(d, { routeDoor(d, ui, on) }, rise.wrapContentWidth(unbounded = true))
                }
            }
        }
    }
}

/** Which callback a door runs ([commandRoute]: OPEN runs it, NEED_MORE / EXPLAIN go to the host, BUSY does nothing). */
private fun routeDoor(d: CommandUi, ui: BattleResultV2Ui, on: BattleResultV2Actions) {
    when (commandRoute(d)) {
        CommandRoute.OPEN -> when (d.id) {
            ui.home.id -> on.onHome()
            ui.next.id -> on.onNext()
            ui.retrain.id -> on.onRetrain()
            ui.replay?.id -> ui.replayId?.let(on.onReplay)
            else -> Unit
        }
        CommandRoute.NEED_MORE -> d.price?.let(on.onNeedMore)
        CommandRoute.EXPLAIN -> on.onRefused(d)
        CommandRoute.IGNORE -> Unit
    }
}

// ---- Previews (the final frame; the timeline is exercised by its unit test) ----

internal object ResultV2Samples {
    private fun door(id: String, icon: String, caption: String, verb: Verb = Verb.STONE, state: CommandState = CommandState.ENABLED, reason: String? = null) =
        CommandUi(FeatureId(id), icon, caption, null, false, state, reason, null, verb = verb)
    private val army = listOf(ArmyTileUi("highlander", "ui_portrait_highlander_t3", "L3", "8"), ArmyTileUi("bowman", "ui_portrait_bowman_t1", "L4", "10"),
        ArmyTileUi("kegrunner", "ui_portrait_kegrunner_t1", "L2", "2"), ArmyTileUi("mage", "ui_portrait_mage_t1", "L1", "2"))
    val victory = BattleResultV2Ui(
        won = true, stars = 2, destroyedPct = 74, verdict = "destroyed · vs Ironjaw", mode = BattleMode.PVP, settlement = ResultSettlement.SETTLED,
        medallions = listOf(LootMedalUi("shards", "+12,400", MedalTone.GAIN, "Shards", "into your stores", counting = true),
            LootMedalUi("trophy", "+18", MedalTone.GAIN, "Trophies", "Gold league", counting = false)),
        readouts = listOf(ResultReadoutUi(FeatureId("hud.shards"), "shards", "35,743", "48,143", "+12,400"),
            ResultReadoutUi(FeatureId("hud.trophies"), "trophy", "1,284", "1,302", "+18")),
        armySpent = army, heroesUsed = listOf("hero_vex_portrait"),
        retrain = door("result.retrain", "ui_portrait_highlander_t3", "RETRAIN", Verb.BLUE), replay = door("result.replay", "replay", "REPLAY"),
        next = door("result.next", "attack", "NEXT"), home = door("result.home", "ui_portrait_keep_t3", "HOME", Verb.GREEN).copy(primary = true),
        retrainCount = 22, replayId = "replay-1",
    )
    // result-defeat.png: no medallion takes the counting tint (nothing flies on a defeat); the trophy loss counts down.
    val defeat = victory.copy(won = false, stars = 0, destroyedPct = 37, verdict = "destroyed · the walls held",
        medallions = listOf(LootMedalUi("shards", "0", MedalTone.ZERO, "Shards", "nothing taken", counting = false),
            LootMedalUi("trophy", "−9", MedalTone.LOSS, "Trophies", "1,275 now", counting = false)),
        readouts = listOf(ResultReadoutUi(FeatureId("hud.shards"), "shards", "40,943", "40,943", null),
            ResultReadoutUi(FeatureId("hud.trophies"), "trophy", "1,284", "1,275", "−9", loss = true)),
        defeatHint = "REPLAY shows what held them off.")
}

@Composable private fun ResultPreviewFrame(ui: BattleResultV2Ui) {
    Box(Modifier.size(412.dp, 915.dp).background(ArmyInk.grassLo)) { BattleResultCardV2(ui, BattleResultV2Actions({}, {}, {}, {})) }
}

@Preview(name = "Result V2: victory, settled (result.png)", widthDp = 412, heightDp = 915)
@Composable private fun ResultV2VictoryPreview() = ResultPreviewFrame(ResultV2Samples.victory)

@Preview(name = "Result V2: defeat (result-defeat.png)", widthDp = 412, heightDp = 915)
@Composable private fun ResultV2DefeatPreview() = ResultPreviewFrame(ResultV2Samples.defeat)

@Preview(name = "Result V2: pending receipt, failed, redacted, unknown values", widthDp = 1648, heightDp = 915)
@Composable private fun ResultV2StatesPreview() {
    Row {
        ResultPreviewFrame(ResultV2Samples.victory.copy(settlement = ResultSettlement.PENDING))
        ResultPreviewFrame(ResultV2Samples.victory.copy(settlement = ResultSettlement.FAILED))
        ResultPreviewFrame(ResultV2Samples.victory.copy(settlement = ResultSettlement.REDACTED, medallions = emptyList()))
        // A result without its destruction or loot reads "…", never 0 (the live mapper's rule).
        ResultPreviewFrame(ResultV2Samples.victory.copy(destroyedPct = null, readouts = emptyList(),
            medallions = listOf(LootMedalUi("shards", UNKNOWN, MedalTone.ZERO, "Shards", "Settled by the server", counting = false),
                LootMedalUi("trophy", "+18", MedalTone.GAIN, "Trophies", "Settled by the server", counting = false))))
    }
}

@Preview(name = "Result V2: campaign first clear (3 medallions), NEXT locked, empty loot", widthDp = 412, heightDp = 915)
@Composable private fun ResultV2CampaignPreview() = ResultPreviewFrame(ResultV2Samples.victory.copy(mode = BattleMode.CAMPAIGN, verdict = "destroyed · Stage 36",
    medallions = ResultV2Samples.victory.medallions + LootMedalUi("star", "+2,400", MedalTone.GAIN, "First clear", "paid once", counting = false),
    next = ResultV2Samples.victory.next.copy(caption = "NEXT STAGE", state = CommandState.LOCKED, reason = "Energy back in 12m")))
