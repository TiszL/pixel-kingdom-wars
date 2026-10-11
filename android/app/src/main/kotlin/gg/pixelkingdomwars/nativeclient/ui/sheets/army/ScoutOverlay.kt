package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandMedallion
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/*
 * Design component: the Scout scene's overlay (design/final/army/SPEC.md R2.3 + critic fixes, scout.png; registry row
 * 93; arch §4.1 "Scene"): look at a target base before spending the raid. The base itself (the target's live layout,
 * pinch / pan, the 0.9x → 1x ease, the SKIP slide, dimming it 40 % while the next match loads) is the scene's; this
 * overlay draws the target plate, the loot plate + trophy stakes, the level tags on defences and the Keep (never traps,
 * never on walls or non-defences), the info plate, the first-scouts hint, and the command shelf HOME · SKIP · ATTACK.
 */

/** The target (SPEC R2.3 `TargetUi`: name, level, crest, trophies, clan). */
@Immutable data class TargetUi(
    /** PS 12 gold-hi "IRONJAW". */
    val name: String,
    /** VT 18 "Lv 11". */
    val level: String,
    /** League crest 24 ("league-gold"). */
    val crest: String?,
    /** "1,310" ("…" unknown). */
    val trophies: String,
    /** "Iron Wardens"; null draws none. */
    val clan: String?,
)

/** One level tag on a defence or the Keep, anchored on the building's own foot (from the server layout). */
@Immutable data class WorldTagUi(
    /** The building id (a tap on the building is the scene's: [ScoutActions.onTapBuilding]). */
    val buildingId: String,
    /** "LV 4", "KEEP 9". */
    val label: String,
    /** The building's foot in screen px (the tag's bottom-centre sits on [PxRect.bottom], centred). */
    val anchor: PxRect,
)

/** Everything the scout overlay draws (SPEC R2.3 `ScoutUi`). */
@Immutable data class ScoutUi(
    val target: TargetUi,
    /** Lootable Shards ("18,200"); null = "…". */
    val lootable: String?,
    /** "+14" (green). */
    val trophiesWin: String?,
    /** "−9" (danger). */
    val trophiesLose: String?,
    /** Level tags (defences and the Keep only). */
    val tags: List<WorldTagUi>,
    /** Defences counted ("5 defences"); null when the layout or catalogue is unavailable. */
    val defences: Int?,
    /** "LV 5"; null = "…". */
    val wallLevel: String?,
    /** Stone "NO SHIELD", green "SHIELDED", or null when the shield state is unknown. */
    val shielded: Boolean?,
    /** SKIP with its CostPill (the search cost, server value); null on map / campaign / revenge scouts. */
    val skip: CommandUi?,
    /** The red ATTACK primary with its energy pill (BUSY "Landing"; DISABLED "Energy 0 · next in 38m" / "Shielded · 2h"). */
    val attack: CommandUi,
    /** HOME (close icon): back to where the player came from. */
    val home: CommandUi,
    /** The hint pill (first 3 scouts). */
    val showHint: Boolean,
    /** Where the scout came from (SKIP and the loot plate depend on it). */
    val source: ScoutSource,
    /** The next match is loading: the last base stays (the scene dims it 40 %) under a centred "Finding a base…" plate. */
    val loading: Boolean = false,
    /** ATTACK's answer was lost: "Being checked" over the shelf; ATTACK stays as RETRY. */
    val attackChecking: Boolean = false,
)

/** Scout callbacks (SPEC R2.3 `ScoutActions`). */
class ScoutActions(
    /** ATTACK: 220 ms fade through the scene colour into the battle. */
    val onAttack: () -> Unit,
    /** SKIP: the base slides out left 220 ms while the next slides in (never blank). */
    val onSkip: () -> Unit,
    /** HOME: back to where the player came from (the map from a map scout). */
    val onHome: () -> Unit,
    /** A building tapped in the scene: a NamePlate with its name and level, no sheet (the scene routes the tap here). */
    val onTapBuilding: (String) -> Unit,
    /** A SHORT pill (energy → SUPPLIES, Shards → Gold Forge): Need-more. */
    val onNeedMore: (PriceUi) -> Unit = {},
    /** A DISABLED / LOCKED command: the host shows its reason. */
    val onRefused: (CommandUi) -> Unit = {},
)

/** The plates' drop on enter (SPEC R2.3: 8 dp + fade 160 ms). */
private const val PLATE_DROP_DP = 8f

/** [ScoutUi.wallLevel] for a layout the server sent with no walls at all (a known fact, not an unknown "…"). */
internal const val SCOUT_NO_WALLS = "none"

/** The loot plate shows only on a scout that can have loot (never CAMPAIGN) AND when the server stated at least one of
 *  its facts. The current scout response states none of them, so the plate stays away instead of a "…" that never fills. */
internal fun scoutLootVisible(ui: ScoutUi): Boolean =
    scoutShowsLoot(ui.source) && (ui.lootable != null || ui.trophiesWin != null || ui.trophiesLose != null)

/** The info plate's line: "5 defences · walls LV 5" ("1 defence"; "no walls" when the layout has none; "…" unknown). */
internal fun scoutInfoLine(defences: Int?, wallLevel: String?): String {
    val count = when (defences) { null -> "$UNKNOWN defences"; 1 -> "1 defence"; else -> "$defences defences" }
    val walls = when (wallLevel) { null -> "walls $UNKNOWN"; SCOUT_NO_WALLS -> "no walls"; else -> "walls $wallLevel" }
    return "$count · $walls"
}

/** The info plate's shield tag: stone "NO SHIELD" / green "SHIELDED"; null when the server did not say (no tag drawn). */
internal fun scoutShieldTag(shielded: Boolean?): String? = when (shielded) { true -> "SHIELDED"; false -> "NO SHIELD"; null -> null }

/**
 * The scout overlay (scout.png). It fills the scene host above the target base.
 *
 * Pointer rule: this root is a full-size, transparent layout with NO clickable, pointerInput, draggable or scrim, so pinch,
 * pan and building taps reach the base scene underneath. Plates, tags, the hint and the shelf paint are paint only; the
 * shelf commands and any host status actions register their own scene-input regions.
 */
@Composable fun ScoutOverlay(ui: ScoutUi, on: ScoutActions, modifier: Modifier = Modifier,
    onHeaderMeasured: (Int) -> Unit = {}, onFooterMeasured: (Int) -> Unit = {},
    status: (@Composable ColumnScope.() -> Unit)? = null) {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val enter = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) { if (!still) enter.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out)) }
    val drop = Modifier.graphicsLayer { alpha = enter.value; translationY = -PLATE_DROP_DP * density * (1f - enter.value) }
    Box(modifier.fillMaxSize()) {
        ui.tags.forEachIndexed { i, tag -> key(tag.buildingId) { LevelTag(tag, i) } }
        BoxWithConstraints(Modifier.align(Alignment.TopCenter).fillMaxWidth().onSizeChanged { onHeaderMeasured(it.height) }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) {
            val loot = scoutLootVisible(ui)
            val lootWidth = if (maxWidth < 396.dp) 132.dp else 156.dp
            val targetWidth = (maxWidth - (if (loot) lootWidth + 24.dp else 16.dp)).coerceAtMost(232.dp).coerceAtLeast(0.dp)
            Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 10.dp).then(drop),
                horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                TargetPlate(ui.target, Modifier.width(targetWidth))
                if (loot) LootPlate(ui, Modifier.width(lootWidth))
            }
        }
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().onSizeChanged { onFooterMeasured(it.height) }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)),
            horizontalAlignment = Alignment.CenterHorizontally) {
            InfoPlate(ui, Modifier.padding(horizontal = 8.dp).then(drop))
            if (status != null) Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), content = status)
            if (ui.showHint) Plate(PlateKind.VEIL, Modifier.padding(top = 10.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                blocksScene = false) { PkwText("Tap a building to see what it is", PkwTokens.Type.body, color = PkwTokens.Colors.text) }
            if (ui.attackChecking) PkwText("Being checked", PkwTokens.Type.body, Modifier.padding(top = 6.dp), color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            ScoutShelf(ui, on)
        }
        if (ui.loading) Plate(PlateKind.CHARCOAL, Modifier.align(Alignment.Center), tint = PkwTokens.Colors.stone.lo, blocksScene = false) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText("Finding a base…", PkwTokens.Type.body, color = PkwTokens.Colors.text); BusyDots()
            }
        }
    }
}

/** The target plate (232 × 70 charcoal): crest + PS 12 name (upper case, as scout.png) + "Lv 11"; trophy + PS 12
 *  trophies + "· clan". A scouted response is complete, so trophies the server did not send are omitted, not "…". */
@Composable private fun TargetPlate(t: TargetUi, modifier: Modifier) {
    val c = PkwTokens.Colors
    val trophies = t.trophies.takeUnless { it == UNKNOWN }
    Plate(PlateKind.CHARCOAL, modifier.heightIn(min = 70.dp).clearAndSetSemantics {
        contentDescription = listOfNotNull(t.name, t.level, trophies?.let { "$it trophies" }, t.clan).joinToString(", ")
    }, blocksScene = false) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                t.crest?.let { PkwIcon(it, 24.dp) }
                PkwText(t.name.uppercase(), PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = c.gold.hi, outline = 1.dp)
                PkwText(t.level, PkwTokens.Type.small, color = c.muted)
            }
            if (trophies != null || t.clan != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (trophies != null) {
                    PkwIcon("trophy", 24.dp)
                    PkwText(trophies, PkwTokens.Type.label, color = c.text)
                }
                t.clan?.let { PkwText(if (trophies != null) "· $it" else it, PkwTokens.Type.small, Modifier.weight(1f, fill = false), color = c.muted) }
            }
        }
    }
}

/** The loot plate (156 × 70): "you can take" + Shards + the amount; under it the trophy stakes "+14 / −9". */
@Composable private fun LootPlate(ui: ScoutUi, modifier: Modifier) {
    val c = PkwTokens.Colors
    Column(modifier, horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Plate(PlateKind.CHARCOAL, Modifier.fillMaxWidth().heightIn(min = 70.dp).clearAndSetSemantics {
            contentDescription = "You can take ${ui.lootable ?: UNKNOWN} Shards"
        }, blocksScene = false) {
            Column {
                PkwText("you can take", PkwTokens.Type.small, color = c.muted)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwIcon("shards", 24.dp)
                    PkwText(ui.lootable ?: UNKNOWN, PkwTokens.Type.label, color = c.text)
                }
            }
        }
        // The win / lose stakes chip only when the server states both (never a half-known "+14 / …").
        val win = ui.trophiesWin
        val lose = ui.trophiesLose
        if (win != null && lose != null) Plate(PlateKind.VEIL, Modifier.heightIn(min = 30.dp).clearAndSetSemantics {
            contentDescription = "Win $win trophies, lose $lose"
        }, contentPadding = PaddingValues(start = 4.dp, end = 8.dp, top = 2.dp, bottom = 2.dp), blocksScene = false) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwIcon("trophy", 24.dp)
                PkwText(win, PkwTokens.Type.body, color = c.green.hi, outline = 1.dp)
                PkwText("/", PkwTokens.Type.body, color = c.muted)
                PkwText(lose, PkwTokens.Type.body, color = c.danger, outline = 1.dp)
            }
        }
    }
}

/** A level tag (veil, 22 tall, PS 11) whose bottom-centre sits on the building's foot; pops with a 30 ms stagger. */
@Composable private fun LevelTag(tag: WorldTagUi, index: Int) {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val pop = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (still) return@LaunchedEffect
        delay(index * PkwTokens.Motion.COMMAND_STAGGER.toLong())
        pop.animateTo(1f, tween(PkwTokens.Motion.BADGE_POP, easing = PkwTokens.Motion.Pop))
    }
    Plate(PlateKind.VEIL, Modifier.onFoot(tag.anchor).heightIn(min = 22.dp).graphicsLayer { scaleX = pop.value; scaleY = pop.value; alpha = pop.value }
        .clearAndSetSemantics { contentDescription = tag.label }, contentPadding = PaddingValues(horizontal = 6.dp, vertical = 1.dp), blocksScene = false) {
        PkwText(tag.label, PkwTokens.Type.caption, color = PkwTokens.Colors.text, outline = 1.dp)
    }
}

/** Places content centred on the anchor, its bottom on the anchor's bottom (the building's foot). */
private fun Modifier.onFoot(anchor: PxRect): Modifier = layout { measurable, _ ->
    val p = measurable.measure(Constraints())
    layout(p.width, p.height) { p.place((anchor.centerX - p.width / 2f).roundToInt(), (anchor.bottom - p.height).roundToInt()) }
}

/** The info plate (full width, 58): scout icon + "5 defences · walls LV 5" + "Traps stay hidden." + the shield tag (only
 *  when the server states the shield). */
@Composable private fun InfoPlate(ui: ScoutUi, modifier: Modifier) {
    val c = PkwTokens.Colors
    val line = scoutInfoLine(ui.defences, ui.wallLevel)
    val shield = scoutShieldTag(ui.shielded)
    Plate(PlateKind.CHARCOAL, modifier.fillMaxWidth().heightIn(min = 58.dp).clearAndSetSemantics {
        contentDescription = listOfNotNull("$line. Traps stay hidden.", shield).joinToString(" ")
    }, blocksScene = false) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("scout", 24.dp)
            Column(Modifier.weight(1f)) {
                PkwText(line, PkwTokens.Type.body, color = c.text)
                PkwText("Traps stay hidden.", PkwTokens.Type.small, color = c.muted)
            }
            shield?.let { Tag(it, if (ui.shielded == true) Verb.GREEN else Verb.STONE) }
        }
    }
}

/** The command shelf (command bar grammar): stone HOME 68 · stone SKIP 68 with its CostPill · red ATTACK 120 × 92 with the
 *  energy pill, over the 2-step paint shelf (ink 18 % for 16 dp, then 36 %). Taps route by the kit's [commandRoute]. */
@Composable private fun ScoutShelf(ui: ScoutUi, on: ScoutActions) {
    val commands = scoutShelf(ui.home, ui.skip, ui.attack.copy(primary = true, verb = Verb.RED), ui.source)
    Box(Modifier.fillMaxWidth().padding(top = 10.dp)) {
        Column(Modifier.matchParentSize().clearAndSetSemantics { }) {
            Box(Modifier.fillMaxWidth().height(16.dp).background(PkwTokens.Colors.ink.copy(alpha = 0.18f)))
            Box(Modifier.fillMaxWidth().weight(1f).background(PkwTokens.Colors.ink.copy(alpha = PkwTokens.Scrim.COMMAND_SHELF)))
        }
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 14.dp), verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            commands.forEach { cmd ->
                if (cmd.primary) Spacer(Modifier.weight(1f))
                CommandMedallion(cmd, { routeScout(cmd, ui, on) })
            }
        }
    }
}

private fun routeScout(cmd: CommandUi, ui: ScoutUi, on: ScoutActions) {
    when (commandRoute(cmd)) {
        CommandRoute.OPEN -> when (cmd.id) {
            ui.attack.id -> on.onAttack()
            ui.skip?.id -> on.onSkip()
            else -> on.onHome()
        }
        CommandRoute.NEED_MORE -> cmd.price?.let(on.onNeedMore)
        CommandRoute.EXPLAIN -> on.onRefused(cmd)
        CommandRoute.IGNORE -> Unit
    }
}

// ---- Previews (the base is the scene's; a flat field stands in) ----

@Composable private fun tagAt(id: String, label: String, xDp: Float, footDp: Float): WorldTagUi {
    val d = LocalDensity.current.density
    return WorldTagUi(id, label, PxRect((xDp - 30f) * d, (footDp - 60f) * d, (xDp + 30f) * d, footDp * d))
}

@Composable private fun sampleScout(): ScoutUi = ScoutUi(
    target = TargetUi("IRONJAW", "Lv 11", "league-gold", "1,310", "Iron Wardens"), lootable = "18,200", trophiesWin = "+14", trophiesLose = "−9",
    tags = listOf(tagAt("tower-1", "LV 4", 132f, 372f), tagAt("tower-2", "LV 3", 286f, 362f), tagAt("keep", "KEEP 9", 214f, 538f),
        tagAt("tower-3", "LV 5", 124f, 592f), tagAt("cannon-1", "LV 6", 286f, 592f)),
    defences = 5, wallLevel = "LV 5", shielded = false,
    skip = CommandUi(FeatureId("scout.skip"), "shape:go", "SKIP", PriceUi(Currency.SHARDS, "120", PriceStatus.OK), false, CommandState.ENABLED, null, null),
    attack = CommandUi(FeatureId("scout.attack"), "attack", "ATTACK", PriceUi(Currency.ITEM, "1", PriceStatus.OK, icon = "energy"), true, CommandState.ENABLED,
        null, null, verb = Verb.RED),
    home = CommandUi(FeatureId("scout.home"), "shape:close", "HOME", null, false, CommandState.ENABLED, null, null),
    showHint = true, source = ScoutSource.MATCH,
)

@Preview(name = "Scout: match (scout.png)", widthDp = 412, heightDp = 915)
@Composable private fun ScoutPreview() {
    Box(Modifier.size(412.dp, 915.dp).background(ArmyInk.grass)) { ScoutOverlay(sampleScout(), ScoutActions({}, {}, {}, {})) }
}

@Preview(name = "Scout: loading next, no energy, shielded map target, campaign", widthDp = 1648, heightDp = 915)
@Composable private fun ScoutStatesPreview() {
    val s = sampleScout()
    Row {
        listOf(
            s.copy(loading = true),
            s.copy(attack = s.attack.copy(price = s.attack.price?.copy(status = PriceStatus.SHORT), state = CommandState.SHORT, reason = "Energy 0 · next in 38m")),
            s.copy(source = ScoutSource.MAP, shielded = true, attack = s.attack.copy(state = CommandState.DISABLED, reason = "Shielded · 2h"), showHint = false),
            s.copy(source = ScoutSource.CAMPAIGN, lootable = null, attackChecking = true, attack = s.attack.copy(caption = "RETRY")),
        ).forEach { ui -> Box(Modifier.size(412.dp, 915.dp).background(ArmyInk.grass)) { ScoutOverlay(ui, ScoutActions({}, {}, {}, {})) } }
    }
}

/** Kept for the busy state's preview label ("Landing"): ATTACK stone dots while the battle loads. */
@Preview(name = "Scout: ATTACK busy (Landing)", widthDp = 412, heightDp = 300)
@Composable private fun ScoutBusyPreview() {
    val s = sampleScout()
    Box(Modifier.size(412.dp, 300.dp).background(ArmyInk.grass)) {
        ScoutOverlay(s.copy(attack = s.attack.copy(caption = "Landing", state = CommandState.BUSY), showHint = false), ScoutActions({}, {}, {}, {}),
            Modifier.offset(y = (-615).dp).size(412.dp, 915.dp))
    }
}
