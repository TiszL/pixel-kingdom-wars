package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/**
 * Design component: the buttons of DESIGN-SYSTEM §6 (PrimaryButton, SecondaryButton / DangerButton, the 48 dp close and
 * icon squares, GO, the money sequence button, the quiet text link) and the building CommandButton ([CommandMedallion]).
 *
 * Every button is a chunky face ([drawChunky]): pressing moves the face down 3 dp in 60 ms (linear) and releases in 90 ms
 * (`pop`). Every target is at least 48 × 48 dp and carries a screen-reader label. Pointer rule: only the painted button is
 * a touch target and a scene-input region; nothing here is full-screen.
 */

/** The shared chunky button: a [ramp] face, press motion, a ≥ 48 dp target and one merged screen-reader label. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable internal fun ChunkyBox(ramp: PkwTokens.Ramp, onClick: () -> Unit, contentDescription: String, modifier: Modifier = Modifier,
    enabled: Boolean = true, lip: Dp = 6.dp, buttonRole: Role = Role.Button,
    /** An optional long-press (the BUILD deck button's tools shelf); also offered to screen readers as [longClickLabel]. */
    onLongClick: (() -> Unit)? = null, longClickLabel: String? = null,
    stateDescription: String? = null,
    content: @Composable BoxScope.() -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed && enabled) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE,
            easing = if (pressed) PkwTokens.Motion.Linear else PkwTokens.Motion.Pop), label = "press")
    val lipDp = lip.value
    val longPress = onLongClick
    Box(modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics { this.contentDescription = contentDescription; role = buttonRole; if (!enabled) disabled()
            if (stateDescription != null) this.stateDescription = stateDescription
            this.onClick(label = null, action = { if (enabled) onClick(); enabled })
            if (longPress != null && enabled) this.onLongClick(label = longClickLabel, action = { longPress.invoke(); true }) }
        .then(if (longPress == null) Modifier.clickable(interactionSource = interaction, indication = null, enabled = enabled, role = buttonRole, onClick = onClick)
            else Modifier.combinedClickable(interactionSource = interaction, indication = null, enabled = enabled, role = buttonRole,
                onLongClickLabel = longClickLabel, onLongClick = longPress, onClick = onClick))
        .drawBehind { drawChunky(ramp, press, lipDp) }, contentAlignment = Alignment.Center) {
        Box(Modifier.padding(chunkyContentPadding(lip))
            .offset { IntOffset(0, (3.dp.toPx() * press.coerceIn(-0.4f, 1f)).roundToInt()) }, contentAlignment = Alignment.Center, content = content)
    }
}

/** The ramp a command or button state draws with. */
internal fun stateRamp(verb: Verb, state: CommandState): PkwTokens.Ramp = PkwTokens.ramp(when (state) {
    CommandState.ENABLED, CommandState.SHORT -> verb
    CommandState.DISABLED -> Verb.OFF
    CommandState.BUSY -> Verb.STONE
    CommandState.LOCKED -> Verb.CHARCOAL
})

/** The three busy dots (common.css `.dots`). */
@Composable fun BusyDots(modifier: Modifier = Modifier) {
    Row(modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(1f, 0.6f, 0.3f).forEach { a -> Box(Modifier.size(6.dp).background(PkwTokens.Colors.text.copy(alpha = a))) }
    }
}

/**
 * The surface's one primary (DESIGN-SYSTEM §6 PrimaryButton): full width × 60, gold by default; any [verb] gives a
 * non-gold face (green when the surface's job is "confirm": UPGRADE, editor SAVE; red ATTACK on attack surfaces). PS
 * label outlined, optional VT [sub] line inside. States: BUSY stone + dots + VT label; DISABLED off face with the
 * [reason] below; LOCKED charcoal + padlock + [reason]; a green "!" [badge] marks READY. Every state still calls
 * [onClick] so the caller can explain a refusal (BUSY does not: nothing can be sent twice).
 *
 * The reason line is `textOnParch2` on parchment (5.8:1, colour pass) or `danger` with [reasonOnDark] (6.4:1 on a dark
 * plate). [price] centres a cost pill on the button's top edge (−20 dp; crafting / army footers); [onPrice] makes that
 * pill its own 48 dp target (a SHORT pill opens Need-more). A CHECKING price stays enabled navigation (design
 * correction 7): pass the state the mapper gives, or [commandDrawState] for a [CommandUi].
 */
@Composable fun PrimaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, verb: Verb = Verb.GOLD,
    sub: String? = null, state: CommandState = CommandState.ENABLED, reason: String? = null, badge: BadgeUi? = null, icon: String? = null,
    reasonOnDark: Boolean = false, price: PriceUi? = null, onPrice: (() -> Unit)? = null) {
    val spoken = listOfNotNull(label, price?.let(::priceDescription), sub,
        reason?.takeIf { state == CommandState.DISABLED || state == CommandState.LOCKED }).joinToString(". ")
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.fillMaxWidth().padding(top = if (price != null) PRICE_ON_PRIMARY_OVERLAP else 0.dp)) {
            ChunkyBox(stateRamp(verb, state), onClick, spoken, Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.sheetPrimaryH),
                enabled = state != CommandState.BUSY) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when (state) {
                        CommandState.BUSY -> BusyDots()
                        CommandState.LOCKED -> PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
                        else -> if (icon != null) PkwIcon(icon, 32.dp)
                    }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        // kit.png PRIMARY BUTTON: the locked "CLAIM" is PS 12 with a 1 dp outline and the disabled "SMELT"
                        // PS 13; only the default face carries the PS 14 / 2 dp label. Busy keeps its VT sentence
                        // ("Checking the price", the money "Sending" grammar).
                        when (state) {
                            CommandState.BUSY -> PkwText(label, PkwTokens.Type.body, color = PkwTokens.Colors.text)
                            CommandState.LOCKED -> PkwText(label, PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
                            CommandState.DISABLED -> PkwText(label, PkwTokens.Type.title, color = PkwTokens.Colors.text, outline = 1.dp)
                            else -> PkwText(label, PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
                        }
                        if (sub != null) PkwText(sub, PkwTokens.Type.small, color = PkwTokens.Colors.text)
                    }
                }
            }
            if (badge != null) Badge(badge, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-8).dp))
            if (price != null) PriceChip(price, Modifier.align(Alignment.TopCenter).offset(y = -PRICE_ON_PRIMARY_OVERLAP), onClick = onPrice)
        }
        if (reason != null && (state == CommandState.DISABLED || state == CommandState.LOCKED)) {
            PkwText(reason, PkwTokens.Type.small, Modifier.padding(top = 3.dp),
                color = if (reasonOnDark) PkwTokens.Colors.danger else PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
        }
    }
}

/** How far a primary's cost pill rides above the button's top edge (craft/SPEC.md §1 PrimaryButton + CostPill). */
private val PRICE_ON_PRIMARY_OVERLAP = 20.dp

/** A secondary verb button (DESIGN-SYSTEM §6 SecondaryButton / DangerButton): 52 tall, [verb] face (stone by default,
 *  red for danger, blue for GO TO), PS label outlined, optional 24 dp [icon]. */
@Composable fun SecondaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, verb: Verb = Verb.STONE,
    icon: String? = null, enabled: Boolean = true, contentDescription: String = label) {
    ChunkyBox(PkwTokens.ramp(if (enabled) verb else Verb.OFF), onClick, contentDescription,
        modifier.heightIn(min = PkwTokens.Dims.secondaryH), enabled = enabled) {
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (icon != null) PkwIcon(icon, 24.dp)
            PkwText(label, PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

/** A quiet text link (the error toast's "Report", "History"): VT 18 underlined, a 48 dp target, no face. */
@Composable fun QuietButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, onParchment: Boolean = false,
    contentDescription: String = label) {
    Box(modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics { this.contentDescription = contentDescription; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
        PkwText(label, PkwTokens.Type.small.copy(textDecoration = TextDecoration.Underline),
            color = if (onParchment) PkwTokens.Colors.blue.lo else PkwTokens.Colors.blue.hi)
    }
}

/** The 48 × 48 red close square every sheet, drawer and seal uses. */
@Composable fun CloseSquare(onClick: () -> Unit, modifier: Modifier = Modifier, contentDescription: String = "Close") {
    IconSquare("shape:close", Verb.RED, onClick, contentDescription, modifier)
}

/** A 48 × 48 icon button ([verb] face): the sheet header's stone History, edge buttons, steppers. */
@Composable fun IconSquare(icon: String, verb: Verb, onClick: () -> Unit, contentDescription: String, modifier: Modifier = Modifier,
    enabled: Boolean = true) {
    ChunkyBox(PkwTokens.ramp(if (enabled) verb else Verb.OFF), onClick, contentDescription, modifier.size(PkwTokens.Dims.minTap), enabled = enabled) {
        PkwIcon(icon, 24.dp, tint = PkwTokens.Colors.label)
    }
}

/** The blue GO (DESIGN-SYSTEM §2: blue = go to a place), with the destination's 32 dp [icon] above the word when given
 *  (the drawer's 64 × 60 GO). */
@Composable fun GoButton(onClick: () -> Unit, contentDescription: String, modifier: Modifier = Modifier, label: String = "GO", icon: String? = null) {
    ChunkyBox(PkwTokens.Colors.blue, onClick, contentDescription, modifier) {
        Column(Modifier.padding(horizontal = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (icon != null) PkwIcon(icon, 32.dp)
            PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

/**
 * The money button (DESIGN-SYSTEM §6 Money sequence, [moneyLook]): gold [label] → stone "Check wallet" → stone dots
 * "Sending" → moss SENT, or red [retryLabel]. Only READY and FAILED call [onClick]. Celebrate only after the receipt.
 */
@Composable fun MoneyButton(stage: MoneyStage, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, retryLabel: String = "RETRY") {
    val look = moneyLook(stage, label, retryLabel)
    ChunkyBox(PkwTokens.ramp(look.verb), onClick, look.text, modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.sheetPrimaryH), enabled = look.accepts) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (look.dots) BusyDots()
            if (look.sentence) PkwText(look.text, PkwTokens.Type.body, color = PkwTokens.Colors.text)
            else PkwText(look.text, PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
        }
    }
}

/**
 * One command of the building command bar (DESIGN-SYSTEM §6 CommandButton): a 68 × 68 chunky face with a 36 dp icon and
 * an outlined caption 5 dp below, or the 120 × 92 primary with its icon pair and caption inside. A [CommandUi.price]
 * draws a cost pill above. Every state calls [onClick] with the id (DISABLED / LOCKED / SHORT so the caller can show the
 * reason or the Need-more sheet), except BUSY; route the tap with [commandRoute].
 *
 * Design correction 7 / design ruling 5ed31eb8: the look follows [commandDrawState] (a CHECKING price stays enabled
 * navigation, an UNAVAILABLE price draws DISABLED, a SHORT price draws SHORT). The primary is gold unless its
 * [CommandUi.verb] names another verb (a green UPGRADE primary). A LOCKED primary keeps its primary size and place:
 * charcoal face, padlock beside the caption, and its VT reason line in gold-hi under them ("Opens 14 Oct"); a LOCKED
 * secondary is the charcoal face with the padlock only (kit.png). A DISABLED secondary is the OFF face with its icon at
 * 60 % and an off-hi caption (states.png greyed EXPLORE).
 *
 * buildings/SPEC.md §1.3 / §1.6 on the primary: [CommandUi.value] is drawn beside the icon ("+8,400", "x3", FINISH's
 * time) in PS 12; [CommandUi.timer] is the 26 dp timer chip at left −6, top −10; [CommandUi.meter] is the 64 × 10 fill
 * meter under the icon (ARMY); a caption of 8+ glyphs (RESEARCH) drops from PS 14 to PS 12. The badge sits at right −6,
 * top −8.
 */
@Composable fun CommandMedallion(ui: CommandUi, onClick: (FeatureId) -> Unit, modifier: Modifier = Modifier) {
    val state = commandDrawState(ui)
    val verb = if (ui.primary && ui.verb == Verb.STONE) Verb.GOLD else ui.verb
    val spoken = listOfNotNull(ui.caption, ui.value, ui.timer?.let { "$it left" }, ui.price?.let(::priceDescription), ui.sub,
        ui.reason?.takeIf { state == CommandState.DISABLED || state == CommandState.LOCKED },
        ui.badge?.description).joinToString(". ")
    val price = ui.price?.let { if (state == CommandState.SHORT && it.status == PriceStatus.OK) it.copy(status = PriceStatus.SHORT) else it }
    val lockedReason = ui.reason?.takeIf { ui.primary && state == CommandState.LOCKED && it.isNotBlank() }
    val off = state == CommandState.DISABLED
    val captionStyle = if (ui.caption.length >= LONG_CAPTION) PkwTokens.Type.label else PkwTokens.Type.primary
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (price != null) { PriceChip(price); Spacer(Modifier.height(4.dp)) }
        Box {
            val box = if (ui.primary) Modifier.size(PkwTokens.Dims.commandPrimaryW, PkwTokens.Dims.commandPrimaryH) else Modifier.size(PkwTokens.Dims.command)
            ChunkyBox(stateRamp(verb, state), { onClick(ui.id) }, spoken, box, enabled = state != CommandState.BUSY) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(if (ui.primary) 2.dp else 0.dp)) {
                    when {
                        state == CommandState.BUSY -> BusyDots()
                        state == CommandState.LOCKED && ui.primary -> Row(verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
                            PkwText(ui.caption, captionStyle, color = PkwTokens.Colors.label, outline = 2.dp)
                        }
                        state == CommandState.LOCKED -> PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
                        else -> {
                            val value = ui.value?.takeIf { ui.primary }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (value != null) 4.dp else 2.dp)) {
                                PkwIcon(ui.icon, when { !ui.primary -> 36.dp; value != null -> valuedIconSize(ui.icon); else -> 40.dp },
                                    alpha = if (off) 0.6f else 1f)
                                if (ui.primary && ui.iconSecondary != null) PkwIcon(ui.iconSecondary, 40.dp)
                                if (value != null) PkwText(value, PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
                            }
                            val meter = ui.meter
                            if (ui.primary && meter != null) ProgressBar(meter.coerceIn(0f, 1f), "", Modifier.width(METER_W), height = METER_H)
                        }
                    }
                    if (ui.primary && state != CommandState.LOCKED) PkwText(ui.caption, captionStyle, color = PkwTokens.Colors.label, outline = 2.dp)
                    else if (!ui.primary && ui.sub != null && state != CommandState.LOCKED)
                        PkwText(ui.sub, PkwTokens.Type.small, color = if (off) PkwTokens.Colors.off.hi else PkwTokens.Colors.label, outline = 1.dp)
                    if (lockedReason != null) PkwText(lockedReason, PkwTokens.Type.small, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                }
            }
            val timer = ui.timer
            if (ui.primary && timer != null && state != CommandState.LOCKED) TimerVeil(timer, Modifier.align(Alignment.TopStart).offset(x = (-6).dp, y = (-10).dp))
            if (ui.badge != null) Badge(ui.badge, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-8).dp))
        }
        if (!ui.primary) PkwText(ui.caption, PkwTokens.Type.caption, Modifier.padding(top = 5.dp),
            color = if (off) PkwTokens.Colors.off.hi else PkwTokens.Colors.label, outline = 1.dp)
    }
}

/** A primary caption of this many glyphs or more uses PS 12 instead of PS 14 (buildings/SPEC.md §6.4: RESEARCH). */
private const val LONG_CAPTION = 8

/** The ARMY fill meter under the primary's icon (buildings/SPEC.md §1.4: 64 × 10). */
private val METER_W = 64.dp
private val METER_H = 10.dp

/** The icon beside a primary's value: 32 dp for 32 / 64 px art (gem 32, Phase E items), 36 dp for 24 px icons (shard). */
private fun valuedIconSize(icon: String): Dp = if (icon == "gem-32" || icon.startsWith("ui:")) 32.dp else 36.dp

/** The timer chip on a busy primary (buildings/SPEC.md §1.3): VeilChip 26 tall, timer icon 24 + the time in PS 11.
 *  Paint only; the medallion's face below stays the touch target. */
@Composable private fun TimerVeil(text: String, modifier: Modifier) {
    Plate(PlateKind.VEIL, modifier.height(TIMER_CHIP_H).clearAndSetSemantics { },
        contentPadding = PaddingValues(start = 2.dp, end = 6.dp), blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwIcon("timer", 24.dp)
            PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.text, outline = 1.dp)
        }
    }
}

private val TIMER_CHIP_H = 26.dp

@Preview(name = "Buttons", widthDp = 412, heightDp = 660)
@Composable private fun ButtonsPreview() {
    Column(Modifier.background(PkwTokens.Colors.bg).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        PrimaryButton("SMELT 2", {})
        PrimaryButton("CHECKING", {}, state = CommandState.BUSY)
        PrimaryButton("SMELT", {}, state = CommandState.DISABLED, reason = "Forge is upgrading")
        PrimaryButton("CLAIM", {}, state = CommandState.LOCKED, reason = "Claims open 14 Oct")
        PrimaryButton("UPGRADE", {}, verb = Verb.GREEN, price = PriceUi(Currency.SHARDS, "18,000", PriceStatus.OK))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SecondaryButton("UPGRADE", {}, verb = Verb.GREEN)
            SecondaryButton("GO", {}, verb = Verb.BLUE)
            CloseSquare({})
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            MoneyButton(MoneyStage.SENDING, "CLAIM", {}, Modifier.width(180.dp))
            QuietButton("Report", {})
        }
    }
}

@Preview(name = "Command medallions", widthDp = 412, heightDp = 220)
@Composable private fun CommandMedallionPreview() {
    Row(Modifier.background(PkwTokens.Colors.bg).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
        CommandMedallion(CommandUi(FeatureId("goldforge.info"), "shape:info", "INFO", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE), {})
        CommandMedallion(CommandUi(FeatureId("goldforge.upgrade"), "shape:up", "UPGRADE", PriceUi(Currency.SHARDS, "52,400", PriceStatus.SHORT),
            false, CommandState.SHORT, null, null, verb = Verb.GREEN, sub = "4h"), {})
        CommandMedallion(CommandUi(FeatureId("goldforge.forge"), "ui:ready-status", "FORGE", null, true, CommandState.ENABLED, null,
            BadgeUi("!", BadgeTone.READY, "Ready"), iconSecondary = "keep"), {})
    }
}

@Preview(name = "Command medallions: CHECKING navigates, locked primary, green primary", widthDp = 412, heightDp = 220)
@Composable private fun CommandMedallionRulesPreview() {
    Row(Modifier.background(PkwTokens.Colors.bg).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
        CommandMedallion(CommandUi(FeatureId("lodge.passport"), "ui:navigation-kit", "PASS", PriceUi(Currency.GEMS, null, PriceStatus.CHECKING),
            false, CommandState.ENABLED, null, null), {})
        CommandMedallion(CommandUi(FeatureId("lodge.expedition"), "ui:lodge-menu", "EXPLORE", null, true, CommandState.LOCKED, "Opens 14 Oct", null), {})
        CommandMedallion(CommandUi(FeatureId("building.upgrade"), "shape:chevron-up", "UPGRADE", PriceUi(Currency.SHARDS, "9,000", PriceStatus.OK),
            true, CommandState.ENABLED, null, null, verb = Verb.GREEN), {})
    }
}
