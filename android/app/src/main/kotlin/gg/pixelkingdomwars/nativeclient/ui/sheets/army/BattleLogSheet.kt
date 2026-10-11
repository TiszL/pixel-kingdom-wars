package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/*
 * Design component: the Battle log, DEFENCE tab (design/final/army/SPEC.md R2.1 + critic fixes, defence-log.png; registry
 * row 4, `Destination.BattleLog("DEFENCE")`): who hit me, what did I lose, can I see it, can I answer it, and my shield.
 * A FULL card (wood frame x 8..404, y 60..901; world parked under the 60 % scrim). Tab ATTACK lists the player's own raids
 * with the RECENT RAIDS row grammar of raid.png. No primary on this surface: each row carries its own red REVENGE.
 */

/** The shield card (SPEC R2.1 `ShieldUi`). */
@Immutable data class ShieldUi(
    /** True: green "4h 10m left" and the coloured shield; false: "none now", the dashed body, a grey shield. */
    val active: Boolean,
    /** "4h 10m" while active; null otherwise ("…" when active but unknown). */
    val timeLeft: String?,
    /** The rule line ("No one can raid you while it lasts. Attacking ends it." / "A shield starts when the raid on you ends."). */
    val line: String,
    val stateLabel: String? = null,
)

/** A raid on the player that is running now (SPEC R2.1 `LiveDefenceUi`): no outcome until the server scores it. */
@Immutable data class LiveDefenceUi(
    /** "Ashgrove". */
    val attacker: String,
    /** The attacker's keep portrait (`ui_portrait_keep_t<n>`). */
    val portrait: String,
    /** The watch target; null hides WATCH. */
    val watchId: String?,
)

/** One defence (SPEC R2.1 `DefenceRowUi`; named DefenceEntryUi because the round 1 raid chooser's `DefenceRowUi` already
 *  exists in this package). The same row feeds the Raid chooser's REVENGE tab. */
@Immutable data class DefenceEntryUi(
    val id: String,
    /** "Ironjaw". */
    val attacker: String,
    /** The attacker tier's keep portrait (56 art, cropped by the 48 × 56 well). */
    val portrait: String,
    /** "[IW]"; null draws none. */
    val clanTag: String?,
    /** A Seeker player. No mark is drawn until the 24 px Seeker crest art exists (ART ASK); kept for screen readers. */
    val seeker: Boolean,
    /** "3h ago". */
    val ago: String,
    /** LOST (red tag) or HELD (green tag). */
    val outcome: Outcome,
    /** Stars against the player, 0-3. */
    val stars: Int,
    /** Destruction percent. */
    val destructionPct: Int,
    /** Shards lost ("-8,200"), red; "0" on a held defence; null with [lootRedacted]. */
    val lootLost: String?,
    /** The server redacted the loot: "LOOT REDACTED" verbatim. */
    val lootRedacted: Boolean,
    /** "-12" / "+9", toned by its sign. */
    val trophyDelta: String,
    /** Their army, up to 6 mini portraits. */
    val army: List<String>,
    /** The replay; null hides REPLAY. */
    val replayId: String?,
    /** Whether it can be answered (AVAILABLE and ATTACK_BACK both draw the red REVENGE). */
    val revenge: RevengeState,
    /** Not looked at yet (counts into the DEFENCE tab badge). */
    val unseen: Boolean,
    /** The row's own request (REVENGE pressed / answer lost). */
    val action: RowActionState = RowActionState.IDLE,
    /** UNAVAILABLE: the server's authoritative words ("SHIELDED · try in 2h"). */
    val unavailableNote: String? = null,
    val outcomeKnown: Boolean = true,
    val starsKnown: Boolean = true,
    val destructionLabel: String = destructionPct.toString(),
    val lootIcon: String = "shards",
)

/** Everything the Battle log draws (SPEC R2.1 `BattleLogUi`). */
@Immutable data class BattleLogUi(
    /** "DEFENCE" or "ATTACK". */
    val tab: String,
    val shield: ShieldUi,
    /** The raid on the player running now; null hides the row. */
    val live: LiveDefenceUi?,
    /** Defences, newest first (the last 7 days, then older as the player scrolls). */
    val defences: List<DefenceEntryUi>,
    /** The player's own raids (ATTACK tab). */
    val attacks: List<RaidRecordUi>,
    /** Loading: the last good rows stay, values "…". */
    val loading: Boolean,
    /** The error toast is the OverlayHost's ("The battle log can't reach the server. Try again." + Report); shown here as a
     *  VT line while the last good rows stay. */
    val error: String?,
    /** No raids yet: "No raids on you yet. Your walls are waiting." + GO TO WALLS; landless: "Claim land to be raided and to
     *  raid back" + GO. Used when [defences] is empty. */
    val empty: EmptyStateUi? = null,
    /** Defences in the 7-day window ("4 raids"); null = "…". Header and footer say the same window. */
    val windowCount: Int? = null,
    val sectionTitle: String = "LAST 7 DAYS",
    val revengeGate: String? = null,
    val actionsEnabled: Boolean = true,
)

/** Battle log callbacks (SPEC R2.1). */
class BattleLogActions(
    val onTab: (String) -> Unit,
    /** REPLAY (replay id). */
    val onReplay: (String) -> Unit,
    /** REVENGE / RETRY (row id): stone dots "Finding Ironjaw" until the scene opens (220 ms fade through the scene colour). */
    val onRevenge: (String) -> Unit,
    /** WATCH on the live row (watch id). */
    val onWatch: (String) -> Unit,
    /** Red close / Back / the scrim. */
    val onClose: () -> Unit,
    /** An EmptyState GO (GO TO WALLS: FocusBuilding wall; claim land). */
    val onGo: (FeatureId) -> Unit = {},
    /** A REVENGE that is off: the host says why. */
    val onExplain: (String) -> Unit = {},
)

const val LOG_TAB_DEFENCE = "DEFENCE"
const val LOG_TAB_ATTACK = "ATTACK"

/**
 * The Battle log FULL card (defence-log.png). The host gives it the FULL geometry (top 60 dp, bottom 14 dp + the gesture
 * inset) and scales it 0.96 → 1 + fades it in over 160 ms; rows stagger 20 ms; the live row's border pulses gold every 2 s
 * (reduced motion: static). [scrollState] is hoisted so the SheetHost can keep the offset.
 *
 * Pointer rule: a painted panel inside the SheetHost; no full-screen clickable, pointerInput, scrim or draggable here. The
 * 60 % scrim of a FULL card is the SheetHost's (`SheetScrim(SheetSize.FULL)`), composed only while it is shown.
 */
@Composable fun BattleLogSheet(ui: BattleLogUi, on: BattleLogActions, modifier: Modifier = Modifier, scrollState: ScrollState = rememberScrollState(),
    leading: (@Composable ColumnScope.() -> Unit)? = null, trailing: (@Composable ColumnScope.() -> Unit)? = null) {
    val unseen = ui.defences.count { it.unseen }
    val tabs = listOf(TabUi(LOG_TAB_DEFENCE, "shield", "DEFENCE", unseenBadge(unseen), false), TabUi(LOG_TAB_ATTACK, "attack", "ATTACK", null, false))
    SheetFrame(SheetFrameUi("BATTLE LOG", null, SheetSize.FULL, tabs, ui.tab), onClose = on.onClose, modifier = modifier, onTab = on.onTab,
        scrollState = scrollState) {
        if (ui.loading) PkwText("Updating…", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        ui.error?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.shortText, maxLines = 2) }
        leading?.invoke(this)
        if (ui.tab == LOG_TAB_ATTACK) AttackTab(ui, on) else DefenceTab(ui, on)
        trailing?.invoke(this)
    }
}

@Composable private fun DefenceTab(ui: BattleLogUi, on: BattleLogActions) {
    ShieldCard(ui.shield)
    ui.live?.let { LiveDefenceRow(it, on) }
    val empty = ui.empty
    if (ui.defences.isEmpty() && empty != null && !ui.loading) { EmptyState(empty, on.onGo); return }
    SectionLine(ui.sectionTitle, trailing = { PkwText(raidCountLine(ui.windowCount ?: ui.defences.size.takeIf { !ui.loading }), PkwTokens.Type.small,
        color = PkwTokens.Colors.textOnParch2) })
    ui.defences.forEachIndexed { i, row ->
        RowStagger(i) { DefenceEntryRow(row, gate = ui.revengeGate, compact = false, onRevenge = on.onRevenge, onReplay = on.onReplay, onExplain = on.onExplain) }
    }
}

@Composable internal fun AttackTab(ui: BattleLogUi, on: BattleLogActions) {
    val c = PkwTokens.Colors
    SectionLine("YOUR RAIDS")
    if (ui.attacks.isEmpty()) PkwText(if (ui.loading) UNKNOWN else "No raids yet.", PkwTokens.Type.small, color = c.textOnParch2)
    ui.attacks.forEachIndexed { i, r -> RowStagger(i) { RaidRecordRow(r, on.onReplay) } }
}

/** A delta the row draws, or null when the server did not send it ("…" here is never loading: a scored row is complete).
 *  BattleRecord carries no trophy change, so rows omit it instead of showing "…" forever (never "0"). */
internal fun shownDelta(delta: String): String? = delta.trim().takeUnless { it.isEmpty() || it == UNKNOWN }

/**
 * `RecentRaidRow` (raid.png, 56): "vs Ironjaw" + 3 stars 24 (1 dp apart, unearned grey); "2h ago · +8,200 Shards ·
 * +14 trophies" with gains green and losses #A3261A ("LOOT REDACTED" verbatim; an unsent trophy change is omitted); the
 * stone replay 58 × 44. Shared by the Raid chooser's RECENT RAIDS and the Battle log's ATTACK tab (one row grammar).
 */
@Composable internal fun RaidRecordRow(r: RaidRecordUi, onReplay: (String) -> Unit) {
    val c = PkwTokens.Colors
    val trophies = shownDelta(r.trophyDelta)
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 56.dp), padding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Column(Modifier.weight(1f).clearAndSetSemantics {
                contentDescription = listOfNotNull("vs ${r.opponent}", "${if (r.starsKnown) r.stars else UNKNOWN} stars", r.ago, r.lootLabel, trophies).joinToString(", ")
            }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText("vs ${r.opponent}", PkwTokens.Type.body, color = c.textOnParch)
                    if (r.starsKnown) StarRow(r.stars, 3, 24.dp, gap = 1.dp) else PkwText(UNKNOWN, PkwTokens.Type.body, color = c.textOnParch2)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    PkwText("${r.ago} ·", PkwTokens.Type.small, color = c.textOnParch2)
                    ToneText(r.lootLabel, leadingTone(r.lootLabel))
                    if (trophies != null) {
                        PkwText("·", PkwTokens.Type.small, color = c.textOnParch2)
                        ToneText(trophies, leadingTone(trophies))
                    }
                }
            }
            r.replayId?.let { id -> StoneReplay({ onReplay(id) }, "Watch the replay against ${r.opponent}", 58.dp, 44.dp) }
        }
    }
}

/** The stone replay button at the frame's own size (raid.png 58 × 44, raid-revenge.png 48 × 52): replay icon 24. */
@Composable internal fun StoneReplay(onClick: () -> Unit, contentDescription: String, width: Dp, height: Dp) {
    ChunkyBox(PkwTokens.Colors.stone, onClick, contentDescription, Modifier.size(width, height)) {
        PkwIcon("replay", 24.dp, tint = PkwTokens.Colors.label)
    }
}

/** Rows fade in with a 20 ms stagger (previews and reduced motion: at once). */
@Composable internal fun RowStagger(index: Int, content: @Composable () -> Unit) {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val a = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (still) return@LaunchedEffect
        delay(index * PkwTokens.Motion.DRAWER_ROW_STAGGER.toLong())
        a.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out))
    }
    Box(Modifier.graphicsLayer { alpha = a.value }) { content() }
}

/** `ShieldCard` (80): a 56 well with the shield 36, "SHIELD" + state, the rule line; no shield = dashed body, grey icon. */
@Composable private fun ShieldCard(s: ShieldUi) {
    val c = PkwTokens.Colors
    val state = s.stateLabel ?: if (s.active) "${s.timeLeft ?: UNKNOWN} left" else "none now"
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 80.dp), dashed = !s.active, padding = PaddingValues(8.dp),
        description = "Shield, $state. ${s.line}") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(56.dp).background(c.ink).padding(2.dp).background(c.creamLo), contentAlignment = Alignment.Center) {
                PkwIcon("shield", 36.dp, if (s.active) Modifier else Modifier.toned(0f), alpha = if (s.active) 1f else 0.6f)
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText("SHIELD", PkwTokens.Type.label, color = c.textOnParch)
                    PkwText(state, PkwTokens.Type.label, color = if (s.active) c.green.lo else c.textOnParch2)
                }
                PkwText(s.line, PkwTokens.Type.small, color = c.textOnParch, maxLines = 2)
            }
        }
    }
}

/** `LiveDefenceRow` (76, gold-rimmed): the attacker's keep, "Ashgrove is raiding", "Scored when it ends", blue WATCH. The
 *  log's "being checked" state: no outcome until the server scores it. The rim pulses gold once per 2 s. */
@Composable private fun LiveDefenceRow(live: LiveDefenceUi, on: BattleLogActions) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 76.dp), body = c.selectedTint, rim = c.gold.face, padding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PortraitWell(live.portrait, Modifier.size(48.dp, 56.dp), wellSize = 56.dp, artSize = 56.dp)
            Column(Modifier.weight(1f).clearAndSetSemantics { contentDescription = "${live.attacker} is raiding you now. Scored when it ends." }) {
                PkwText("${live.attacker} is raiding", PkwTokens.Type.body, color = c.textOnParch)
                PkwText("Scored when it ends", PkwTokens.Type.small, color = c.textOnParch2)
            }
            live.watchId?.let { id -> SecondaryButton("WATCH", { on.onWatch(id) }, Modifier.width(104.dp), verb = Verb.BLUE, icon = "scout",
                contentDescription = "Watch the raid by ${live.attacker}") }
        }
    }
}

/**
 * One defence row, shared by the Battle log (122 tall: tag + stars + %, loot line, their army; REVENGE 104 × 52 above
 * REPLAY 104 × 48) and, [compact], the Raid chooser's REVENGE tab (80: no army; stone replay 48 × 52 beside REVENGE).
 * [gate] turns REVENGE off for the whole chooser ("Energy 0 · next in 38m", "No troops ready"). An answered row is dimmed
 * with a moss ANSWERED tag and REPLAY only.
 */
@Composable internal fun DefenceEntryRow(row: DefenceEntryUi, gate: String?, compact: Boolean, onRevenge: (String) -> Unit,
    onReplay: (String) -> Unit, onExplain: (String) -> Unit) {
    val c = PkwTokens.Colors
    val look = revengeLook(row.revenge, row.action, row.attacker, gate, row.unavailableNote)
    val answered = look.kind == RevengeKind.ANSWERED
    val (tagText, tagVerb) = outcomeTag(row.outcome)
    val loot = if (row.lootRedacted) "LOOT REDACTED" else row.lootLost ?: UNKNOWN
    val trophies = shownDelta(row.trophyDelta)
    // raid-revenge.png: a held defence's compact row reads "Held" where the loss would be (no tag column there).
    val heldLine = compact && row.outcomeKnown && row.outcome == Outcome.HELD
    val spoken = listOfNotNull(row.attacker, row.clanTag, row.ago, if (row.outcomeKnown) tagText else "Outcome unavailable", "${if (row.starsKnown) row.stars else UNKNOWN} stars", "${row.destructionLabel}%",
        if (heldLine) null else "${row.lootIcon} $loot", trophies?.let { "trophies $it" }, if (answered) "answered" else null).joinToString(", ")
    // Critic fix: an ANSWERED card is parch-2 (#E8D3A0) with a parch-dk lip; the cream plate's own lip would vanish into
    // that body, so the 4 dp parch-dk lip is drawn over its bottom inside the ink rim (the row's 8 dp bottom padding).
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = if (compact) 80.dp else 122.dp)
        .then(if (!answered) Modifier else Modifier.drawWithContent {
            drawContent()
            val inset = 4.dp.toPx()
            drawRect(ArmyInk.parchDk, Offset(inset, size.height - 6.dp.toPx()), Size(size.width - 2 * inset, 4.dp.toPx()))
        }), body = if (answered) c.creamLo else null,
        padding = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PortraitWell(row.portrait, Modifier.size(48.dp, 56.dp), wellSize = 56.dp, artSize = 56.dp)
            Column(Modifier.weight(1f).clearAndSetSemantics { contentDescription = spoken }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PkwText(listOfNotNull(row.attacker, row.clanTag).joinToString(" "), PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch)
                    PkwText(row.ago, PkwTokens.Type.small, color = c.textOnParch2)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (!compact && row.outcomeKnown) Tag(tagText, tagVerb)
                    if (row.starsKnown) StarRow(row.stars, 3, 24.dp, gap = 0.dp) else PkwText(UNKNOWN, PkwTokens.Type.body, color = c.textOnParch2)
                    PkwText("${row.destructionLabel}%", PkwTokens.Type.caption, color = c.textOnParch2)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (heldLine) PkwText("Held", PkwTokens.Type.body, color = c.textOnParch)
                    else {
                        PkwIcon(row.lootIcon, 24.dp)
                        PkwText(loot, if (row.lootRedacted) PkwTokens.Type.caption else PkwTokens.Type.body,
                            color = if (row.lootRedacted) c.textOnParch2 else deltaColor(deltaTone(loot)))
                    }
                    if (trophies != null) {
                        PkwIcon("trophy", 24.dp, Modifier.padding(start = 6.dp))
                        PkwText(trophies, PkwTokens.Type.body, color = deltaColor(deltaTone(trophies)))
                    }
                }
                if (!compact && row.army.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) { row.army.take(6).forEach { MiniPortrait(it) } }
                if (look.kind == RevengeKind.GONE || look.kind == RevengeKind.RETRY) look.note?.let { Tag(it, Verb.STONE) }
            }
            val replay: @Composable () -> Unit = {
                row.replayId?.let { id ->
                    // raid-revenge.png: stone replay 48 × 52 beside REVENGE; defence-log.png: stone REPLAY 104 × 48 under it.
                    if (compact) StoneReplay({ onReplay(id) }, "Watch the replay against ${row.attacker}", 48.dp, 52.dp)
                    else SecondaryButton("REPLAY", { onReplay(id) }, Modifier.size(104.dp, 48.dp), icon = "replay",
                        contentDescription = "Watch the replay against ${row.attacker}")
                }
            }
            if (compact) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                replay(); AnswerControl(row, look, onRevenge, onExplain)
            } else Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AnswerControl(row, look, onRevenge, onExplain); replay()
            }
        }
    }
}

/** The red REVENGE 104 × 52 (caption only, so the word fits), stone dots while busy, red RETRY when being checked, off with a
 *  reason, the moss ANSWERED tag, or nothing when the target is gone (its tag says why). */
@Composable private fun AnswerControl(row: DefenceEntryUi, look: RevengeLook, onRevenge: (String) -> Unit, onExplain: (String) -> Unit) {
    val c = PkwTokens.Colors
    val size = Modifier.size(104.dp, 52.dp)
    when (look.kind) {
        RevengeKind.REVENGE, RevengeKind.RETRY -> ChunkyBox(c.red, { onRevenge(row.id) }, "${look.label} ${row.attacker}", size) {
            PkwText(look.label, PkwTokens.Type.caption, color = c.label, outline = 1.dp)
        }
        RevengeKind.BUSY -> ChunkyBox(c.stone, {}, look.label, size, enabled = false) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) { BusyDots(); PkwText(look.label, PkwTokens.Type.small, color = c.text) }
        }
        RevengeKind.OFF -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
            ChunkyBox(c.off, { onExplain(look.note ?: "") }, "${look.label}, ${look.note ?: ""}", size) {
                PkwText(look.label, PkwTokens.Type.caption, color = c.text)
            }
            look.note?.let { PkwText(it, PkwTokens.Type.small, Modifier.width(104.dp), color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2) }
        }
        RevengeKind.ANSWERED -> Tag("ANSWERED", Verb.MOSS)
        RevengeKind.GONE -> Unit
    }
}

// ---- Previews ----

internal object BattleLogSamples {
    private val keep = "ui_portrait_keep_t3"
    private fun row(id: String, name: String, ago: String, outcome: Outcome, stars: Int, pct: Int, loot: String, trophies: String, army: List<String>,
        revenge: RevengeState = RevengeState.AVAILABLE, unseen: Boolean = false) =
        DefenceEntryUi(id, name, keep, null, false, ago, outcome, stars, pct, loot, false, trophies, army, "replay-$id", revenge, unseen)
    val rows = listOf(
        row("d1", "Ironjaw", "3h ago", Outcome.LOST, 2, 64, "-8,200", "-12", listOf("ui_portrait_highlander_t2", "ui_portrait_troll_t2",
            "ui_portrait_bowman_t2", "ui_portrait_mage_t2"), unseen = true),
        row("d2", "Saltmere", "5h ago", Outcome.LOST, 1, 41, "-3,100", "-6", listOf("ui_portrait_highlander_t2", "ui_portrait_bowman_t2"), unseen = true),
        row("d3", "Grimhold", "20h ago", Outcome.HELD, 0, 22, "0", "+9", listOf("ui_portrait_bowman_t2", "ui_portrait_kegrunner_t2", "ui_portrait_giant_t2"),
            revenge = RevengeState.ATTACK_BACK),
        row("d4", "Vexmoor", "1d ago", Outcome.LOST, 3, 100, "-11,400", "-18", emptyList(), revenge = RevengeState.ANSWERED),
    )
    val log = BattleLogUi(LOG_TAB_DEFENCE, ShieldUi(false, null, "A shield starts when the raid on you ends."),
        LiveDefenceUi("Ashgrove", keep, "watch-1"), rows,
        listOf(RaidRecordUi("r1", "Ironjaw", "2h ago", 2, "+8,200 Shards", "+14 trophies", "replay-1")), loading = false, error = null, windowCount = 4)
}

private val previewActions = BattleLogActions(onTab = {}, onReplay = {}, onRevenge = {}, onWatch = {}, onClose = {})

@Composable private fun LogPreviewFrame(ui: BattleLogUi) {
    Box(Modifier.fillMaxSize().background(ArmyInk.grass)) {
        Box(Modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.FULL_CARD)))
        BattleLogSheet(ui, previewActions, Modifier.fillMaxSize().padding(start = 8.dp, end = 8.dp, top = PkwTokens.Dims.fullSheetTop,
            bottom = PkwTokens.Dims.fullSheetBottom))
    }
}

@Preview(name = "Battle log: DEFENCE (defence-log.png)", widthDp = 412, heightDp = 915)
@Composable private fun BattleLogDefencePreview() = LogPreviewFrame(BattleLogSamples.log)

@Preview(name = "Battle log: shield up, empty, ATTACK tab", widthDp = 1236, heightDp = 915)
@Composable private fun BattleLogStatesPreview() {
    Row {
        Box(Modifier.width(412.dp)) { LogPreviewFrame(BattleLogSamples.log.copy(live = null, shield = ShieldUi(true, "4h 10m",
            "No one can raid you while it lasts. Attacking ends it."))) }
        Box(Modifier.width(412.dp)) { LogPreviewFrame(BattleLogSamples.log.copy(live = null, defences = emptyList(), windowCount = 0,
            empty = EmptyStateUi("shield", "No raids on you yet.", "Your walls are waiting.", "GO TO WALLS", FeatureId("focus.wall")))) }
        Box(Modifier.width(412.dp)) { LogPreviewFrame(BattleLogSamples.log.copy(tab = LOG_TAB_ATTACK)) }
    }
}

@Preview(name = "Battle log: loading, error, busy REVENGE, being checked, redacted, shielded", widthDp = 412, heightDp = 915)
@Composable private fun BattleLogBusyPreview() {
    val r = BattleLogSamples.rows
    LogPreviewFrame(BattleLogSamples.log.copy(loading = true, error = "Updated 2 min ago", live = null, defences = listOf(
        r[0].copy(action = RowActionState.BUSY), r[1].copy(action = RowActionState.CHECKING),
        r[2].copy(lootLost = null, lootRedacted = true, revenge = RevengeState.UNAVAILABLE, unavailableNote = "SHIELDED · try in 2h"), r[3])))
}
