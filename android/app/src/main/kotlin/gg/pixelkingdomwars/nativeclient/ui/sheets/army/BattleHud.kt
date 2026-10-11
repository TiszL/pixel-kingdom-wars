package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressRing
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/*
 * Design component: the in-battle HUD (design/final/army/SPEC.md §6A, battle-hud.png). The battle is the scene: the HUD
 * covers the top 80 dp (target plate with the loot still on the table; the battle clock, the game's only m:ss) and the
 * bottom (END, stars + destruction, the troop deck), nothing mid-field except the first-battles hint and the deploy line.
 * Deploying is the scene's: a tap or a held drag on the field goes through this overlay to the battle scene, which
 * places the troop and sends the order; the server decides damage, stars and loot, and this HUD only shows them.
 */

/** One card of the troop deck (SPEC §6A.3 `DeckCardUi`). */
@Immutable data class DeckCardUi(
    /** The troop id (or the hero id), handed back by [BattleHudActions.onSelect]. */
    val id: String,
    /** Spoken name ("Highlander", "Vex"). */
    val name: String,
    /** The 48 dp portrait (`ui_portrait_highlander_t2`, `hero_vex_portrait`). */
    val portrait: String,
    /** Troops left to send; null while unknown ("x…"). Ignored for the hero. */
    val count: Int?,
    /** The hero card (gold-framed well, "HERO"). */
    val isHero: Boolean = false,
    /** The hero is on the field: the card is its ability button. */
    val heroSent: Boolean = false,
    /** The ability cooldown ("12s"); null = ready (only meaningful once [heroSent]). */
    val abilityReadyIn: String? = null,
    /** The cooldown ring's progress (0..1), or null for no ring. */
    val abilityProgress: Float? = null,
    /** The live command owner's admission; disabled cards keep their place and their observed count. */
    val enabled: Boolean = true,
    /** Some battle owners have deployment but no hero ability endpoint. Never advertise one for them. */
    val abilitySupported: Boolean = true,
    /** Optional authoritative state caption, e.g. SENT for a deployed hero with no supported ability. */
    val statusText: String? = null,
    /** Why a tap on this card does nothing right now (a sent hero with no ability owner); the tap hands it to
     *  [BattleHudActions.onRefused] so the card is never a silent door. Null keeps a refused tap quiet. */
    val refusal: String? = null,
)

/** Everything the battle HUD draws (SPEC §6A.3). Every value comes from the server / battle state, formatted. */
@Immutable data class BattleHudUi(
    /** The defender's kingdom ("IRONJAW"). */
    val targetName: String,
    /** "Lv 11". */
    val targetLevel: String,
    /** The league crest (GameArt name: `league-gold`, …). */
    val leagueCrest: String,
    /** Shards still lootable ("18,200"; counts down as loot is taken); null is "…". */
    val lootLeft: String?,
    /** The battle clock, m:ss ("2:57"; D-070: the only m:ss in the game); null is "…". */
    val clock: String?,
    /** SCOUT / FIGHT / LAST_30. */
    val clockPhase: ClockPhase,
    /** Stars won so far (0..3); null while unknown. */
    val stars: Int?,
    /** Destruction percent (0..100) as the server last said; null while unknown. */
    val destructionPct: Int?,
    /** The deck, in camp order, hero last. */
    val deck: List<DeckCardUi>,
    /** The selected card's id (one at a time). */
    val selected: String?,
    /** First three battles: the hint pill (hides on the first valid deploy). */
    val showHint: Boolean,
    /** The hint's words. */
    val hint: String = "Tap outside the red line to send troops",
    /** Show the no-deploy line (first 3 s, while a finger is down, 1 s after an invalid tap: the scene's timing). */
    val showDeployLine: Boolean,
    /** The no-deploy boundary in window px (the scene's deploy mask, as a rectangle); null: the scene draws its own line. */
    val deployBounds: PxRect? = null,
    /** True before any troop is sent: the button reads LEAVE and needs no confirm. */
    val canLeaveFree: Boolean,
    /** False while the end is being sent (the button keeps its place, greyed). */
    val endEnabled: Boolean = true,
    /** The END confirm is up. */
    val endConfirmShown: Boolean = false,
    /** The confirm's sentence (what happens to sent and unsent troops: a server rule, so the mapper supplies it). */
    val endConfirmLine: String? = null,
    /** Preserve an existing owner's HOME / BACK label without changing its exit or confirmation rules. */
    val endText: String? = null,
    /** False while the server cannot take the end (no raid id yet, a blocked battle): the confirm's END greys. */
    val endConfirmEnabled: Boolean = true,
    /** The end is being sent ("CONFIRMING…"): the confirm's END reads this and both buttons hold. Null = idle. */
    val endConfirmBusyText: String? = null,
)

/** The HUD's callbacks (SPEC §6A.3 minus `onDeploy`: a field tap is the scene's, see MOUNT-EDITOR.md). */
class BattleHudActions(
    /** A troop card or the unsent hero card: select it (lift 90 ms). */
    val onSelect: (String) -> Unit,
    /** The sent hero's card while its ability is ready. */
    val onHeroAbility: () -> Unit,
    /** LEAVE before any troop is sent: back home, nothing committed. */
    val onLeave: () -> Unit,
    /** END after troops were sent: raise the confirm (the mapper sets [BattleHudUi.endConfirmShown]). */
    val onRequestEnd: () -> Unit,
    /** The confirm's END. */
    val onConfirmEnd: () -> Unit,
    /** The confirm's KEEP FIGHTING, its scrim, Back. */
    val onCancelEnd: () -> Unit,
    /** A card tap that cannot act ([DeckCardUi.refusal]): the host says why (its notice line or a toast). */
    val onRefused: (String) -> Unit = {},
)

/** The deck shelf (SPEC: ink 62 %). */
private val DECK_SHELF = Color(0x9E100E14)
private val CARD_WELL = Color(0xFF2A2430)
private val HERO_WELL = Color(0xFF3A2A14)
private val USED_UP_BODY = Color(0xFFDDD2B4)
private val CARD_W = 62.dp
private val CARD_H = 86.dp

/**
 * The in-battle HUD over the battle scene (battle-hud.png). Enter: the target plate and the clock drop 8 dp and fade in
 * 160 ms; the deck rises from below in 160 ms with a 30 ms card stagger. Stars pop (0 → 1.3 → 1, 180 ms) when the server
 * awards one; the destruction figure counts up in 1 % steps to the server's value (never ahead of it). Under 0:30 the
 * clock turns danger and pulses 1.04 once a second. Reduced motion: no drops, rises, pops or pulse (colour only).
 * The exit (fade 120 ms, then the result card) is the host's.
 *
 * Pointer rule: the root is a full-size, transparent layout with NO clickable, pointerInput, draggable or scrim, and the
 * deploy line and hint are paint only, so every tap and held drag on the field reaches the battle scene (deploys, camera).
 * Only the painted plates, END, and the deck shelf with its cards take touches. The one scrim is the END confirm's,
 * composed only while [BattleHudUi.endConfirmShown].
 */
@Composable fun BattleHudOverlay(ui: BattleHudUi, on: BattleHudActions, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    val enter = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        enter.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out))
    }
    val nav = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Box(modifier.fillMaxSize()) {
        DeployLine(ui.deployBounds.takeIf { ui.showDeployLine })

        Row(Modifier.align(Alignment.TopStart).fillMaxWidth().statusBarsPadding().padding(start = 8.dp, top = 10.dp, end = 8.dp)
            .graphicsLayer {
                alpha = enter.value
                if (!reduced) translationY = (1f - enter.value) * -8.dp.toPx()
            }, verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.SpaceBetween) {
            // 212 dp on the 412 dp phone; on a narrow one it gives way before the 118 dp clock does.
            TargetPlate(ui, Modifier.weight(1f, fill = false).padding(end = 8.dp).width(212.dp))
            ClockPlate(ui, reduced || still)
        }

        if (ui.showHint) {
            Box(Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 150.dp, start = 16.dp, end = 16.dp)
                .background(PkwTokens.Colors.ink.copy(alpha = 0.86f), PixelShapes.S).padding(horizontal = 12.dp, vertical = 5.dp)
                .clearAndSetSemantics { contentDescription = ui.hint; liveRegion = LiveRegionMode.Polite }) {
                PkwText(ui.hint, PkwTokens.Type.body, color = PkwTokens.Colors.text, textAlign = TextAlign.Center, maxLines = 2)
            }
        }

        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.Bottom) {
                EndButton(ui, on)
                Spacer(Modifier.weight(1f))
                StarsPlate(ui, reduced || still)
            }
            Spacer(Modifier.height(12.dp))
            Deck(ui, on, nav, reduced, still)
        }

        BattleHudEndConfirmLayer(ui, on)
    }
}

/**
 * The END confirm with its own 55 % scrim, composed only while [BattleHudUi.endConfirmShown]. Hosts that mount the split
 * [BattleHudRegion]s compose this once over the whole battle (after their chrome), so the confirm sits on top of
 * everything and its scrim keeps taps off the scene while it asks.
 */
@Composable fun BattleHudEndConfirmLayer(ui: BattleHudUi, on: BattleHudActions, modifier: Modifier = Modifier) {
    if (!ui.endConfirmShown) return
    Box(modifier.fillMaxSize()) {
        ModalScrim(PkwTokens.Scrim.SEAL, on.onCancelEnd)
        EndConfirm(ui, on, Modifier.align(Alignment.Center))
    }
}

/** Split only for hosts whose existing camera contract measures top and bottom chrome separately. */
enum class BattleHudRegion { TOP, BOTTOM }

/** Mount the same designed overlay into the live owner's measured edge regions, without replacing its scene. */
@Composable fun BattleHudOverlay(ui: BattleHudUi, on: BattleHudActions, region: BattleHudRegion,
    modifier: Modifier = Modifier, compact: Boolean = false) {
    when (region) {
        BattleHudRegion.TOP -> BattleHudTopBar(ui, modifier)
        BattleHudRegion.BOTTOM -> BattleHudBottomBar(ui, on, modifier, compact)
    }
}

/** Designed top plates for live hosts that already own safe insets and measured camera chrome. */
@Composable fun BattleHudTopBar(ui: BattleHudUi, modifier: Modifier = Modifier) {
    val calm = LocalReducedMotion.current || LocalInspectionMode.current
    Row(modifier.fillMaxWidth().padding(start = 8.dp, top = 10.dp, end = 8.dp, bottom = 6.dp),
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.SpaceBetween) {
        TargetPlate(ui, Modifier.weight(1f, fill = false).padding(end = 8.dp).width(212.dp))
        ClockPlate(ui, calm)
    }
}

/** Designed END, progress and deck. The live host owns its navigation inset and supplementary command shelf. */
@Composable fun BattleHudBottomBar(ui: BattleHudUi, on: BattleHudActions, modifier: Modifier = Modifier,
    compact: Boolean = false) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    if (compact) {
        Row(modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            EndButton(ui, on)
            Deck(ui, on, 0.dp, reduced, still, Modifier.weight(1f))
            StarsPlate(ui, reduced || still)
        }
    } else Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.Bottom) {
            EndButton(ui, on)
            Spacer(Modifier.weight(1f))
            StarsPlate(ui, reduced || still)
        }
        Spacer(Modifier.height(12.dp))
        Deck(ui, on, 0.dp, reduced, still)
    }
}

/** The dashed no-deploy line (3 dp `red.hi` at 90 %, a faint ink halo), fading 120 ms. Paint only. */
@Composable private fun DeployLine(bounds: PxRect?) {
    // Keep the last rectangle so the line can fade out where it was.
    val last = remember { mutableStateOf(bounds) }
    SideEffect { if (bounds != null && last.value != bounds) last.value = bounds }
    val alpha by animateFloatAsState(if (bounds != null) 1f else 0f, tween(PkwTokens.Motion.REDUCED_CROSSFADE), label = "deployLine")
    val shown = bounds ?: last.value ?: return
    if (alpha <= 0f) return
    Canvas(Modifier.fillMaxSize().clearAndSetSemantics { }) {
        val w = 3.dp.toPx()
        val dash = PathEffect.dashPathEffect(floatArrayOf(8.dp.toPx(), 6.dp.toPx()))
        val o = Offset(shown.left, shown.top); val s = Size(shown.width, shown.height)
        drawRect(PkwTokens.Colors.ink.copy(alpha = 0.35f * alpha), o, s, style = Stroke(w + 2.dp.toPx()))
        drawRect(PkwTokens.Colors.red.hi.copy(alpha = 0.9f * alpha), o, s, style = Stroke(w, pathEffect = dash))
    }
}

/** Top-left (212 × 70): crest + kingdom name + "Lv n"; "Loot" + Shards + what is still lootable. */
@Composable private fun TargetPlate(ui: BattleHudUi, modifier: Modifier) {
    val c = PkwTokens.Colors
    val loot = ui.lootLeft ?: UNKNOWN
    Plate(PlateKind.CHARCOAL, modifier.height(70.dp).clearAndSetSemantics {
        contentDescription = "Raiding ${ui.targetName}, ${ui.targetLevel}. Loot left $loot Shards"
    }, contentPadding = PaddingValues(start = 10.dp, top = 5.dp, end = 10.dp, bottom = 8.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwIcon(ui.leagueCrest, 24.dp)
                // battle-hud.png sets the kingdom name in capitals ("IRONJAW"); the spoken text above keeps it as named.
                PkwText(ui.targetName.uppercase(), PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = c.gold.hi, outline = 1.dp)
                PkwText(ui.targetLevel, PkwTokens.Type.small, color = c.muted)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText("Loot", PkwTokens.Type.small, color = c.muted)
                PkwIcon("shards", 24.dp)
                PkwText(loot, PkwTokens.Type.label, color = c.text, outline = 1.dp)
            }
        }
    }
}

/** Top-right (118 × 70): "ends in" / "starts" over the outlined m:ss; danger + pulse under 0:30. */
@Composable private fun ClockPlate(ui: BattleHudUi, calm: Boolean) {
    val c = PkwTokens.Colors
    val look = clockLook(ui.clockPhase, calm)
    val pulse = if (look.pulse) {
        val t = rememberInfiniteTransition(label = "clock")
        t.animateFloat(1f, 1f, infiniteRepeatable(keyframes {
            durationMillis = 1000
            1.04f at 120
            1f at 280
        }, RepeatMode.Restart), label = "clockPulse").value
    } else 1f
    val clock = ui.clock ?: UNKNOWN
    Plate(PlateKind.CHARCOAL, Modifier.size(width = 118.dp, height = 70.dp).graphicsLayer { scaleX = pulse; scaleY = pulse }
        .clearAndSetSemantics { contentDescription = "Battle ${look.label} $clock" }) {
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText(look.label, PkwTokens.Type.small, color = c.muted)
            PkwText(clock, PkwTokens.Type.numeralL, color = if (look.danger) c.danger else c.label, outline = 2.dp)
        }
    }
}

/** Right, above the deck (156 × 64): three stars at 28 dp, the outlined percent, a 12 dp gold meter with a 50 % tick. */
@Composable private fun StarsPlate(ui: BattleHudUi, calm: Boolean) {
    val c = PkwTokens.Colors
    val lit = starsLit(ui.stars)
    val pct = ui.destructionPct
    val counted by animateIntAsState(pct ?: 0, tween(if (calm) 0 else PkwTokens.Motion.COUNT_UP), label = "destruction")
    val text = if (pct == null) destructionText(null) else destructionText(counted)
    Plate(PlateKind.CHARCOAL, Modifier.width(156.dp).height(64.dp).clearAndSetSemantics {
        contentDescription = "${if (ui.stars == null) UNKNOWN else lit} of 3 stars, ${destructionText(pct)} destroyed"
    }, contentPadding = PaddingValues(start = 8.dp, top = 5.dp, end = 8.dp, bottom = 8.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                repeat(3) { i -> BattleStar(i < lit, calm) }
                Spacer(Modifier.weight(1f))
                PkwText(text, PkwTokens.Type.label, color = c.label, outline = 1.dp)
            }
            Box(Modifier.fillMaxWidth().height(12.dp)) {
                ProgressBar(if (pct == null) null else counted / 100f, "${destructionText(pct)} destroyed", verb = Verb.GOLD, height = 12.dp)
                Box(Modifier.align(Alignment.Center).width(2.dp).fillMaxHeight().background(c.ink))
            }
        }
    }
}

/** One 28 dp star: full colour when lit, grey at 35 % brightness when not; pops when the server awards it. */
@Composable private fun BattleStar(lit: Boolean, calm: Boolean) {
    val scale = remember { Animatable(1f) }
    val wasLit = remember { mutableStateOf(lit) }
    LaunchedEffect(lit) {
        if (lit && !wasLit.value && !calm) {
            scale.snapTo(0f)
            scale.animateTo(1f, keyframes {
                durationMillis = PkwTokens.Motion.BADGE_POP
                1.3f at 110 using PkwTokens.Motion.Pop
            })
        }
        wasLit.value = lit
    }
    PkwIcon("star", 28.dp, Modifier.graphicsLayer { scaleX = scale.value; scaleY = scale.value }
        .then(if (lit) Modifier else Modifier.toned(0f, 0.35f)))
}

/** Left, above the deck (104 × 54): red END (close + "END"), or LEAVE before any troop is sent. */
@Composable private fun EndButton(ui: BattleHudUi, on: BattleHudActions) {
    val c = PkwTokens.Colors
    val label = ui.endText ?: endLabel(ui.canLeaveFree)
    val spoken = ui.endText ?: if (ui.canLeaveFree) "Leave the battle; nothing has been sent" else "End the battle"
    ChunkyBox(PkwTokens.ramp(if (ui.endEnabled) Verb.RED else Verb.OFF), {
        when (endRoute(ui.canLeaveFree)) { EndRoute.LEAVE -> on.onLeave(); EndRoute.CONFIRM -> on.onRequestEnd() }
    }, spoken, Modifier.size(width = 104.dp, height = 54.dp), enabled = ui.endEnabled) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwIcon("shape:close", 24.dp, tint = c.label)
            PkwText(label, PkwTokens.Type.label, color = c.label, outline = 1.dp)
        }
    }
}

/** The troop deck: an ink 62 % shelf with a 2 dp ink rule, one row of 62 × 86 cards, scrolling past six. */
@Composable private fun Deck(ui: BattleHudUi, on: BattleHudActions, nav: androidx.compose.ui.unit.Dp, reduced: Boolean, still: Boolean, modifier: Modifier = Modifier) {
    val scrolls = deckScrolls(ui.deck.size)
    Box(modifier.fillMaxWidth().sceneInputRegion().drawBehind {
        drawRect(DECK_SHELF)
        drawRect(PkwTokens.Colors.ink, Offset.Zero, Size(size.width, 2.dp.toPx()))
    }.padding(bottom = nav)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
            .padding(start = 8.dp, top = 16.dp, end = if (scrolls) 22.dp else 8.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            ui.deck.forEachIndexed { index, card -> DeckCard(card, card.id == ui.selected, index, on, reduced, still) }
        }
    }
}

/** One card: cream body, portrait 48 in a 52 dp dark well (gold-framed for the hero), "xN" / HERO / SKILL under it. Selected
 *  lifts 10 dp with a gold 3 dp inner rim and the selected tint; used up greys the portrait and keeps its place. */
@Composable private fun DeckCard(card: DeckCardUi, selected: Boolean, index: Int, on: BattleHudActions, reduced: Boolean, still: Boolean) {
    val c = PkwTokens.Colors
    val usedUp = deckCardUsedUp(card.count, card.isHero) || (card.isHero && card.heroSent && !card.abilitySupported)
    val tap = if (!card.enabled || (card.isHero && card.heroSent && !card.abilitySupported)) DeckTap.NONE
        else deckCardTap(card.count, card.isHero, card.heroSent, card.abilityReadyIn)
    // A card that cannot act but knows why stays tappable and says so (a door never does nothing).
    val refusal = card.refusal?.takeIf { tap == DeckTap.NONE }
    val lift by animateDpAsState(if (selected) (-10).dp else 0.dp, tween(if (reduced) 0 else PkwTokens.Motion.RELEASE), label = "lift")
    val rise = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!reduced) delay(index * PkwTokens.Motion.COMMAND_STAGGER.toLong())
        rise.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.DECK_SWAP, easing = PkwTokens.Motion.Out))
    }
    val spoken = when {
        card.isHero && card.heroSent && !card.abilitySupported -> "Hero ${card.name}, sent; ${refusal ?: "no ability is available"}"
        !card.enabled -> "${card.name}, ${card.statusText ?: card.count?.let { "$it left" } ?: "deployment unavailable"}; unavailable"
        card.isHero && !card.heroSent -> "Hero ${card.name}, ready to send"
        card.isHero -> card.abilityReadyIn?.let { "${card.name}'s ability in $it" } ?: "${card.name}'s ability, ready"
        usedUp -> "${card.name}, none left"
        card.count == null -> "${card.name}, count unknown"
        else -> "${card.name}, ${card.count} left"
    }
    val act: () -> Unit = {
        when (tap) { DeckTap.SELECT -> on.onSelect(card.id); DeckTap.ABILITY -> on.onHeroAbility(); DeckTap.NONE -> refusal?.let(on.onRefused) }
    }
    val tappable = tap != DeckTap.NONE || refusal != null
    val body = when { selected -> c.selectedTint; usedUp -> USED_UP_BODY; else -> c.cream }
    Box(Modifier.size(CARD_W, CARD_H).offset(y = lift).graphicsLayer {
        alpha = rise.value
        if (!reduced) translationY = (1f - rise.value) * 40.dp.toPx()
    }.clearAndSetSemantics {
        contentDescription = spoken; role = Role.Button; this.selected = selected
        if (!tappable) disabled()
        onClick(label = null, action = { act(); tappable })
    }.clickable(enabled = tappable, role = Role.Button, onClick = act).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.M, if (selected) c.gold.lo else c.ink)
        val i = 2.dp.toPx()
        insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
            drawRect(body)
            drawRect(c.creamLo, Offset(i, size.height - i - 4.dp.toPx()), Size(size.width - 2 * i, 4.dp.toPx()))
            if (selected) {
                val r = 3.dp.toPx(); val g = c.gold.face
                drawRect(g, Offset(i, i), Size(size.width - 2 * i, r)); drawRect(g, Offset(i, size.height - i - r), Size(size.width - 2 * i, r))
                drawRect(g, Offset(i, i), Size(r, size.height - 2 * i)); drawRect(g, Offset(size.width - i - r, i), Size(r, size.height - 2 * i))
            }
        }
    }, contentAlignment = Alignment.TopCenter) {
        Column(Modifier.padding(top = 5.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(52.dp).background(if (card.isHero) c.gold.lo else c.ink).padding(2.dp)
                .background(if (card.isHero) HERO_WELL else CARD_WELL), contentAlignment = Alignment.Center) {
                PkwIcon(card.portrait, 48.dp, if (usedUp) Modifier.toned(0f, 0.5f) else Modifier)
                if (card.isHero && card.heroSent && card.abilitySupported && card.abilityReadyIn != null) {
                    ProgressRing(card.abilityProgress, card.abilityReadyIn, "${card.name}'s ability in ${card.abilityReadyIn}")
                }
            }
            PkwText(card.statusText ?: deckCountText(card.count, card.isHero, card.heroSent, card.abilityReadyIn), PkwTokens.Type.caption, Modifier.padding(top = 3.dp),
                color = when { card.isHero -> c.gold.lo; usedUp -> c.textOnParch2; else -> c.textOnParch })
        }
    }
}

/** "END THE BATTLE?" with KEEP FIGHTING (stone) and END (red). */
@Composable private fun EndConfirm(ui: BattleHudUi, on: BattleHudActions, modifier: Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.CHARCOAL, modifier.padding(horizontal = 24.dp).widthIn(max = 360.dp)) {
        Column(Modifier.padding(6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            PkwText("END THE BATTLE?", PkwTokens.Type.title, Modifier.semantics { heading() }, color = c.gold.hi, outline = 1.dp)
            ui.endConfirmLine?.let { PkwText(it, PkwTokens.Type.body, color = c.text, maxLines = 4) }
            // While the end is being sent END reads the busy words and both hold: nothing is sent twice, nothing dismissed.
            val sending = ui.endConfirmBusyText
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("KEEP FIGHTING", on.onCancelEnd, Modifier.weight(1f), enabled = sending == null)
                SecondaryButton(sending ?: "END", on.onConfirmEnd, Modifier.weight(1f), verb = Verb.RED,
                    enabled = sending == null && ui.endConfirmEnabled, contentDescription = sending ?: "End the battle now")
            }
        }
    }
}

// ---- Previews (sample data only; the real Ui comes from Codex's mapper) ----

private val previewActions = BattleHudActions(onSelect = {}, onHeroAbility = {}, onLeave = {}, onRequestEnd = {}, onConfirmEnd = {}, onCancelEnd = {})

private val sampleDeck = listOf(
    DeckCardUi("highlander", "Highlander", "ui_portrait_highlander_t2", 5),
    DeckCardUi("bowman", "Bowman", "ui_portrait_bowman_t2", 10),
    DeckCardUi("giant", "Giant", "ui_portrait_giant_t2", 1),
    DeckCardUi("dragon", "Dragon", "ui_portrait_dragon_t2", 2),
    DeckCardUi("turrider", "Turrider", "ui_portrait_turrider_t2", 0),
    DeckCardUi("vex", "Vex", "hero_vex_portrait", null, isHero = true),
)

private val sampleHud = BattleHudUi(
    targetName = "IRONJAW", targetLevel = "Lv 11", leagueCrest = "league-gold", lootLeft = "18,200",
    clock = "2:57", clockPhase = ClockPhase.FIGHT, stars = 0, destructionPct = 0, deck = sampleDeck, selected = "highlander",
    showHint = true, showDeployLine = true, deployBounds = PxRect(40f, 520f, 1040f, 1620f), canLeaveFree = false,
)

@Composable private fun HudPreviewFrame(ui: BattleHudUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFFE6B878))) { BattleHudOverlay(ui, previewActions) }
}

@Preview(name = "Battle HUD: first seconds (battle-hud.png)", widthDp = 412, heightDp = 915)
@Composable private fun BattleHudPreview() = HudPreviewFrame(sampleHud)

@Preview(name = "Battle HUD: before any troop (LEAVE, scout clock)", widthDp = 412, heightDp = 915)
@Composable private fun BattleHudScoutPreview() = HudPreviewFrame(sampleHud.copy(clock = "0:24", clockPhase = ClockPhase.SCOUT, canLeaveFree = true))

@Preview(name = "Battle HUD: last 30 s, two stars, hero ability cooling", widthDp = 412, heightDp = 915)
@Composable private fun BattleHudLatePreview() = HudPreviewFrame(sampleHud.copy(clock = "0:18", clockPhase = ClockPhase.LAST_30, stars = 2,
    destructionPct = 63, lootLeft = "4,120", showHint = false, showDeployLine = false, selected = "dragon",
    deck = sampleDeck.dropLast(1) + DeckCardUi("vex", "Vex", "hero_vex_portrait", null, isHero = true, heroSent = true, abilityReadyIn = "12s", abilityProgress = 0.4f)))

@Preview(name = "Battle HUD: unknown values", widthDp = 412, heightDp = 915)
@Composable private fun BattleHudUnknownPreview() = HudPreviewFrame(sampleHud.copy(clock = null, stars = null, destructionPct = null, lootLeft = null,
    deck = sampleDeck.map { if (it.isHero) it else it.copy(count = null) }, showDeployLine = false))

@Preview(name = "Battle HUD: END confirm", widthDp = 412, heightDp = 915)
@Composable private fun BattleHudConfirmPreview() = HudPreviewFrame(sampleHud.copy(showHint = false, endConfirmShown = true,
    endConfirmLine = "Troops on the field keep fighting for their loot; troops not sent go back to camp."))

@Preview(name = "Battle HUD: END confirm while the end is sent", widthDp = 412, heightDp = 915)
@Composable private fun BattleHudConfirmSendingPreview() = HudPreviewFrame(sampleHud.copy(showHint = false, endConfirmShown = true,
    endConfirmLine = "Troops on the field keep fighting for their loot; troops not sent go back to camp.", endConfirmBusyText = "CONFIRMING…"))

@Preview(name = "Battle HUD: eight cards scroll", widthDp = 412, heightDp = 915)
@Composable private fun BattleHudManyPreview() = HudPreviewFrame(sampleHud.copy(showHint = false,
    deck = sampleDeck.dropLast(1) + DeckCardUi("archer", "Archer", "ui_portrait_archer_t1", 8) + DeckCardUi("ram", "Ram", "ui_portrait_ram_t1", 3) + sampleDeck.last()))
