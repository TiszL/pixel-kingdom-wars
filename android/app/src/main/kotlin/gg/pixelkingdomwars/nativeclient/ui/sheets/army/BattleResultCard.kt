package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.core.Animatable
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
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
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Toast
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Design component: the battle result (design/final/army/SPEC.md §7; result.png, result-defeat.png), a scene overlay
 * over the parked battle frame: stars, the VICTORY / DEFEAT ribbon, the verdict and opponent chip, then the card with
 * LOOT (paid only from the server's settlement), ARMY USED with RETRAIN, the saved replay, and NEXT + HOME. Victory adds
 * the rotating gold rays and, after the receipt, the loot count-up and the coin fly to the Shards readout.
 */

/** Which battle this was (SPEC §7 `mode`). */
enum class BattleMode { PVP, CAMPAIGN, DIVINE }

/** One loot row (SPEC §7 `LootRow`). */
@Immutable data class LootRowUi(
    /** 36 dp icon ("shards", "trophy"). */
    val icon: String,
    /** VT 20 name ("Shards"). */
    val name: String,
    /** VT 18 context ("Vaults 84% full", "1,284 ▸ 1,302", "Settled by the server"). */
    val context: String,
    /** PS 16 signed delta ("+12,400", "-9", "0"); "…" until settled. Its sign tones it. */
    val delta: String,
    /** True when storage capped this loot: a blue GO to the Vaults' upgrade (`onStorageFull`). */
    val storageFull: Boolean = false,
)

/** What the server has settled (SPEC §7 `SettlementUi`). Nothing pays out, counts up or flies before [Settled]. */
sealed interface SettlementUi {
    /** The receipt is not back: stars and ribbon play, loot rows read "…" with "Counting…". HOME still works. */
    data object Pending : SettlementUi
    /** Settled: count-up + coin fly. */
    @Immutable data class Settled(val loot: List<LootRowUi>) : SettlementUi
    /** "LOOT REDACTED" verbatim. */
    data object Redacted : SettlementUi
    /** The read failed: rows keep "…"; the host posts the error toast ("The result is still being settled. It will appear
     *  in your raid log." + Report). Never says nothing was paid: the result is still uncertain. */
    @Immutable data class Failed(val message: String) : SettlementUi
}

/** Everything the result draws (SPEC §7 `BattleResultUi`). */
@Immutable data class BattleResultUi(
    val won: Boolean,
    /** 0-3. */
    val stars: Int,
    /** Destruction percent. */
    val destroyedPct: Int,
    /** The server reason on defeat ("the walls held"); null shows none. */
    val reason: String?,
    /** The chip text: "vs Ironjaw · Gold league", or for the campaign "Stage 36 · Dreamwood Passage". */
    val opponent: String,
    val mode: BattleMode,
    val settlement: SettlementUi,
    /** Troops spent (portrait + count). */
    val armyUsed: List<ArmyTileUi>,
    /** Hero portraits used. */
    val heroesUsed: List<String>,
    /** The saved replay; null hides the row. */
    val replayId: String?,
    /** NEXT (→ `RaidChooser(MATCH)`), or RETRY / NEXT STAGE for the campaign. */
    val secondary: CommandUi,
    /** HOME (green): Home with the world kept. */
    val primary: CommandUi,
    /** The Shards readout at the top-right (the coin-fly target); set its `gain` once settled for the rising "+n". */
    val shards: ResourceChipUi? = null,
)

/** Result callbacks (SPEC §7). */
@Immutable data class BattleResultActions(
    val onHome: () -> Unit = {},
    val onNext: () -> Unit = {},
    /** RETRAIN: `Army(TRAIN, prefill = LAST_ARMY)`. */
    val onRetrain: () -> Unit = {},
    val onWatch: (String) -> Unit = {},
    /** A loot row capped by storage: GO to the Vaults' upgrade. */
    val onStorageFull: () -> Unit = {},
    val onResourceRow: (FeatureId) -> Unit = {},
    val onNeedMore: (PriceUi) -> Unit = {},
    val onRefused: (CommandUi) -> Unit = {},
)

/** The placeholder loot rows while the receipt is out (values "…", never 0). */
private val PENDING_LOOT = listOf(LootRowUi("shards", "Shards", "Counting…", UNKNOWN), LootRowUi("trophy", "Trophies", "Counting…", UNKNOWN))

/**
 * The battle result (result.png / result-defeat.png). It fills its host (the battle scene's overlay slot).
 *
 * Pointer rule: this is a FULL card over the parked battle, so it is the one surface in the cluster that draws a
 * full-screen [ModalScrim] (60 %, `PkwTokens.Scrim.FULL_CARD`), and only while it is composed (shown). The scrim swallows
 * taps (it never closes or confirms anything); every action is a painted button. The host must remove this composable
 * when the result is dismissed so nothing full-screen remains over the scene.
 */
@Composable fun BattleResultCard(ui: BattleResultUi, on: BattleResultActions, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val still = reduced || LocalInspectionMode.current
    val scrim = remember { Animatable(if (still) 1f else 0f) }
    val stars = remember { List(3) { Animatable(if (still) 1f else 0f) } }
    val ribbon = remember { Animatable(if (still) 1f else 0f) }
    val card = remember { Animatable(if (still) 1f else 0f) }
    val rays = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (still) return@LaunchedEffect
        launch { scrim.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN)) }
        listOf(160L, 340L, 520L).forEachIndexed { i, at ->
            launch { delay(at); stars[i].animateTo(1f, tween(PkwTokens.Motion.BADGE_POP, easing = PkwTokens.Motion.Pop)) }
        }
        launch { delay(700); ribbon.animateTo(1f, tween(PkwTokens.Motion.RIBBON_DROP, easing = PkwTokens.Motion.Pop)) }
        launch { delay(860); rays.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN)) }
        launch { delay(860); card.animateTo(1f, tween(PkwTokens.Motion.SHEET_IN, easing = PkwTokens.Motion.Out)) }
    }
    // Loot counts up and coins fly only after the server settled (receipt-gated).
    val settled = ui.settlement is SettlementUi.Settled
    val count = remember { Animatable(if (still) 1f else 0f) }
    val coins = remember { Animatable(0f) }
    val pulse = remember { Animatable(1f) }
    LaunchedEffect(settled) {
        if (!settled) return@LaunchedEffect
        if (still) { count.snapTo(1f); return@LaunchedEffect }
        launch { count.animateTo(1f, tween(PkwTokens.Motion.COUNT_UP, easing = PkwTokens.Motion.Out)) }
        coins.snapTo(0f)
        coins.animateTo(1f, tween(PkwTokens.Motion.COIN_FLY, easing = PkwTokens.Motion.In))
        pulse.animateTo(1.06f, tween(PkwTokens.Motion.BADGE_OUT / 2)); pulse.animateTo(1f, tween(PkwTokens.Motion.BADGE_OUT / 2))
    }
    var root by remember { mutableStateOf(Offset.Zero) }
    var coinFrom by remember { mutableStateOf<Offset?>(null) }
    var coinTo by remember { mutableStateOf<Offset?>(null) }

    Box(modifier.fillMaxSize().onGloballyPositioned { root = it.positionInRoot() }) {
        ModalScrim(PkwTokens.Scrim.FULL_CARD * scrim.value, onTap = {})
        if (ui.won) VictoryRays(rays.value, still, Modifier.align(Alignment.TopCenter).offset(y = 110.dp).size(412.dp, 420.dp))

        ui.shards?.let { row ->
            ArmySheetResources(listOf(row), ArmySheetKind.RESULT, on.onResourceRow,
                Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 8.dp)
                    .graphicsLayer { scaleX = pulse.value; scaleY = pulse.value }
                    .onGloballyPositioned { coinTo = it.positionInRoot() + Offset(it.size.width * 0.2f, it.size.height / 2f) })
        }

        ResultStars(ui.stars, stars.map { it.value }, Modifier.align(Alignment.TopCenter).offset(y = 172.dp))
        ResultRibbon(ui.won, ribbon.value, Modifier.align(Alignment.TopCenter).offset(y = 280.dp))
        Column(Modifier.align(Alignment.TopCenter).offset(y = 350.dp).graphicsLayer { alpha = ribbon.value },
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PkwText("${ui.destroyedPct}%", PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                PkwText(" destroyed" + (ui.reason?.let { " · $it" } ?: ""), PkwTokens.Type.lead, color = PkwTokens.Colors.text, outline = 1.dp)
            }
            Plate(PlateKind.VEIL, Modifier.heightIn(min = 30.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 2.dp), blocksScene = false) {
                PkwText(ui.opponent, PkwTokens.Type.body, color = PkwTokens.Colors.text)
            }
        }

        ResultSheet(ui, on, count.value, onShardsIcon = { coinFrom = it },
            modifier = Modifier.fillMaxSize().padding(start = 8.dp, end = 8.dp, top = 428.dp)
                .graphicsLayer { translationY = (1f - card.value) * 320.dp.toPx(); alpha = if (still) 1f else card.value })

        // The coin fly: six Shards coins from the loot row to the readout, staggered, along a small arc.
        val from = coinFrom; val to = coinTo
        if (settled && !still && from != null && to != null && coins.value > 0f && coins.value < 1f) {
            repeat(6) { i ->
                val t = ((coins.value * 1.4f) - i * 0.08f).coerceIn(0f, 1f)
                if (t in 0.001f..0.999f) {
                    val p = Offset(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t - sin(PI * t).toFloat() * 120f) - root
                    PkwIcon("shards", 24.dp, Modifier.offset { IntOffset(p.x.roundToInt() - 12.dp.roundToPx(), p.y.roundToInt() - 12.dp.roundToPx()) }
                        .clearAndSetSemantics { })
                }
            }
        }
    }
}

/** The three result stars at 72 dp (k = 6, SPEC §9 item 2): left 82 / 196, centre 170 / 172 (raised 24), right 258 / 196.
 *  Each drops in 1.6 → 1 over 180 ms (`pop`); unearned stars are grey at 35 % brightness. */
@Composable private fun ResultStars(earned: Int, drop: List<Float>, modifier: Modifier) {
    Box(modifier.size(248.dp, 96.dp).semantics(mergeDescendants = true) { contentDescription = "$earned of 3 stars" }) {
        listOf(Triple(0, 0.dp, 24.dp), Triple(1, 88.dp, 0.dp), Triple(2, 176.dp, 24.dp)).forEach { (i, x, y) ->
            val v = drop.getOrElse(i) { 1f }
            val on = i < earned
            PkwIcon("star", 72.dp, Modifier.offset(x, y).graphicsLayer {
                val s = 1f + 0.6f * (1f - v); scaleX = s; scaleY = s; alpha = v
            }.toned(if (on) 1f else 0f, if (on) 1f else 0.35f))
        }
    }
}

/** The ribbon (ink M shell, gold face "VICTORY" or stone "DEFEAT", PS 16 outlined): drops 8 dp and fades in. */
@Composable private fun ResultRibbon(won: Boolean, t: Float, modifier: Modifier) {
    val ramp = if (won) PkwTokens.Colors.gold else PkwTokens.Colors.stone
    Box(modifier.widthIn(min = 200.dp).heightIn(min = 60.dp)
        .graphicsLayer { translationY = -8.dp.toPx() * (1f - t); alpha = t }
        .semantics { heading() }
        .drawBehind { drawChunky(ramp, 0f, 6f) }
        .padding(start = 24.dp, end = 24.dp, top = 6.dp, bottom = 10.dp), contentAlignment = Alignment.Center) {
        PkwText(if (won) "VICTORY" else "DEFEAT", PkwTokens.Type.numeralL, color = PkwTokens.Colors.label, outline = 2.dp)
    }
}

/** Stepped gold sunrays (an 18° period, 20 % gold) masked to a radius, turning 8°/s; reduced motion keeps them still. */
@Composable private fun VictoryRays(t: Float, still: Boolean, modifier: Modifier) {
    val angle: Float = if (still) 0f else {
        val loop = rememberInfiniteTransition(label = "rays")
        val a by loop.animateFloat(0f, 360f, infiniteRepeatable(tween((360f / PkwTokens.Motion.RAYS_DEG_PER_S * 1000).toInt(), easing = LinearEasing)),
            label = "rays-angle")
        a
    }
    Canvas(modifier.clipToBounds().clearAndSetSemantics { }) {
        val cx = size.width / 2f; val cy = size.height * 0.28f
        val r = size.minDimension * 0.62f
        val gold = PkwTokens.Colors.gold.face.copy(alpha = 0.2f * t)
        for (k in 0 until 20) {
            val a0 = Math.toRadians((angle + k * 18f).toDouble()); val a1 = Math.toRadians((angle + k * 18f + 9f).toDouble())
            val path = Path().apply {
                moveTo(cx, cy)
                lineTo(cx + r * cos(a0).toFloat(), cy + r * sin(a0).toFloat())
                lineTo(cx + r * cos(a1).toFloat(), cy + r * sin(a1).toFloat())
                close()
            }
            drawPath(path, gold)
        }
    }
}

/** The card: wood frame + parchment, LOOT, ARMY USED, the replay row, and the footer (NEXT + HOME). */
@Composable private fun ResultSheet(ui: BattleResultUi, on: BattleResultActions, count: Float, onShardsIcon: (Offset) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.WOOD, modifier) {
        Plate(PlateKind.PARCHMENT, Modifier.fillMaxSize(), blocksScene = false) {
            Column(Modifier.fillMaxSize()) {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 2.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionLine("LOOT", lootHint(ui.settlement))
                    when (val s = ui.settlement) {
                        is SettlementUi.Settled -> s.loot.forEach { LootRow(it, count, on, onShardsIcon) }
                        SettlementUi.Pending, is SettlementUi.Failed -> PENDING_LOOT.forEach { LootRow(it, 1f, on, onShardsIcon) }
                        SettlementUi.Redacted -> LootRow(LootRowUi("shards", "Loot", "Settled by the server", "LOOT REDACTED"), 1f, on, onShardsIcon)
                    }
                    SectionLine("ARMY USED", "troops are spent each raid")
                    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 64.dp), padding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 10.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                ui.armyUsed.forEach { MiniPortrait(it.portrait, count = it.count) }
                                ui.heroesUsed.forEach { MiniPortrait(it, hero = true) }
                            }
                            SecondaryButton("RETRAIN", on.onRetrain, Modifier.width(104.dp), verb = Verb.BLUE, contentDescription = "Retrain the same army")
                        }
                    }
                    ui.replayId?.let { id ->
                        ArmyCard(Modifier.fillMaxWidth().heightIn(min = 56.dp), padding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                PkwIcon("replay", 36.dp)
                                Column(Modifier.weight(1f)) {
                                    PkwText("Replay saved", PkwTokens.Type.body, color = c.textOnParch)
                                    PkwText("In your raid log", PkwTokens.Type.small, color = c.textOnParch2)
                                }
                                SecondaryButton("WATCH", { on.onWatch(id) }, Modifier.width(84.dp), contentDescription = "Watch the replay")
                            }
                        }
                    }
                }
                FooterFade()
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val sec = ui.secondary
                    val off = effectiveState(sec) != CommandState.ENABLED
                    SecondaryButton(sec.caption, { routeCommand(sec, on.onNext, on.onNeedMore, on.onRefused) }, Modifier.width(120.dp).heightIn(min = 60.dp),
                        verb = if (off) Verb.OFF else Verb.STONE, icon = sec.icon.ifBlank { "attack" },
                        contentDescription = listOfNotNull(sec.caption, sec.reason?.takeIf { off }).joinToString(". "))
                    FooterPrimary(ui.primary, on.onHome, on.onNeedMore, on.onRefused, Modifier.weight(1f))
                }
            }
        }
    }
}

/** LootRow (56): icon 36, name + context, the PS 16 delta right (green gain, red loss, ink zero), counting up from 0 over
 *  600 ms once settled; a storage-capped row adds a blue GO. The Shards row reports its icon position for the coin fly. */
@Composable private fun LootRow(row: LootRowUi, count: Float, on: BattleResultActions, onShardsIcon: (Offset) -> Unit) {
    val c = PkwTokens.Colors
    val tone = deltaTone(row.delta)
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 56.dp), padding = PaddingValues(start = 8.dp, top = 4.dp, end = 8.dp, bottom = 6.dp),
        description = "${row.name}: ${row.delta}. ${row.context}") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PkwIcon(row.icon, 36.dp, if (row.icon == "shards") Modifier.onGloballyPositioned {
                onShardsIcon(it.positionInRoot() + Offset(it.size.width / 2f, it.size.height / 2f))
            } else Modifier)
            Column(Modifier.weight(1f)) {
                PkwText(row.name, PkwTokens.Type.body, color = c.textOnParch)
                PkwText(row.context, PkwTokens.Type.small, color = c.textOnParch2)
            }
            if (row.storageFull) GoButton(on.onStorageFull, "Upgrade the Vaults", Modifier.width(58.dp))
            PkwText(countUpSigned(row.delta, count), if (tone == DeltaTone.UNKNOWN && row.delta != UNKNOWN) PkwTokens.Type.caption else PkwTokens.Type.numeralL,
                color = deltaColor(tone))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------------------------------

internal object ResultSamples {
    private val home = CommandUi(FeatureId("result.home"), "", "HOME", null, true, CommandState.ENABLED, null, null, verb = Verb.GREEN)
    private val next = CommandUi(FeatureId("result.next"), "attack", "NEXT", null, false, CommandState.ENABLED, null, null)
    private val army = listOf(ArmyTileUi("highlander", "ui_portrait_highlander_t3", "L3", "8"), ArmyTileUi("bowman", "ui_portrait_bowman_t1", "L4", "10"),
        ArmyTileUi("kegrunner", "ui_portrait_kegrunner_t1", "L2", "2"), ArmyTileUi("mage", "ui_portrait_mage_t1", "L1", "2"))
    val victory = BattleResultUi(true, 2, 74, null, "vs Ironjaw · Gold league", BattleMode.PVP,
        SettlementUi.Settled(listOf(LootRowUi("shards", "Shards", "Vaults 84% full", "+12,400"), LootRowUi("trophy", "Trophies", "1,284 ▸ 1,302", "+18"))),
        army, listOf("hero_vex_portrait"), "replay-1", next, home,
        shards = ResourceChipUi(FeatureId("hud.shards"), "shards", "53,343", 0.84f, false, null, name = "Shards", accent = ResourceAccent.SHARDS, gain = "+12,400"))
    val defeat = victory.copy(won = false, stars = 0, destroyedPct = 37, reason = "the walls held", opponent = "vs Saltmere · Gold league",
        settlement = SettlementUi.Settled(listOf(LootRowUi("shards", "Shards", "Settled by the server", "0"), LootRowUi("trophy", "Trophies", "1,284 ▸ 1,275", "-9"))),
        shards = victory.shards?.copy(value = "40,943", gain = null, fill = 0.62f))
}

@Preview(name = "Result: victory after the receipt (result.png)", widthDp = 412, heightDp = 915)
@Composable private fun ResultVictoryPreview() {
    Box(Modifier.fillMaxSize().background(ArmyInk.grassLo)) { BattleResultCard(ResultSamples.victory, BattleResultActions()) }
}

@Preview(name = "Result: defeat (result-defeat.png)", widthDp = 412, heightDp = 915)
@Composable private fun ResultDefeatPreview() {
    Box(Modifier.fillMaxSize().background(ArmyInk.grassLo)) { BattleResultCard(ResultSamples.defeat, BattleResultActions()) }
}

@Preview(name = "Result: pending receipt, redacted, failed (+ toast)", widthDp = 1236, heightDp = 915)
@Composable private fun ResultStatesPreview() {
    Row(Modifier.fillMaxSize().background(ArmyInk.grassLo)) {
        Box(Modifier.weight(1f)) { BattleResultCard(ResultSamples.victory.copy(settlement = SettlementUi.Pending,
            shards = ResultSamples.victory.shards?.copy(value = "40,943", gain = null)), BattleResultActions()) }
        Box(Modifier.weight(1f)) { BattleResultCard(ResultSamples.victory.copy(settlement = SettlementUi.Redacted,
            secondary = CommandUi(FeatureId("result.retry"), "attack", "RETRY", null, false, CommandState.ENABLED, null, null),
            mode = BattleMode.CAMPAIGN, opponent = "Stage 36 · Dreamwood Passage"), BattleResultActions()) }
        Box(Modifier.weight(1f)) {
            BattleResultCard(ResultSamples.victory.copy(settlement = SettlementUi.Failed("timeout"), shards = ResultSamples.victory.shards?.copy(gain = null)),
                BattleResultActions())
            Toast(ToastUi("result.settle", "The result is still being settled. It will appear in your raid log.", null, ToastKind.ERROR, null, null, true, 0L),
                {}, {}, Modifier.align(Alignment.TopCenter).padding(top = 60.dp, start = 8.dp, end = 8.dp))
        }
    }
}
