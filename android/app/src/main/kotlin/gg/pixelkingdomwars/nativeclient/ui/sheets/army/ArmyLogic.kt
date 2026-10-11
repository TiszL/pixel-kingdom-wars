package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import java.util.Locale

/*
 * Design component: the pure rules of the army cluster (design/final/army/SPEC.md): durations, housing arithmetic and
 * the draft's step limit, tap routing for commands and cards (the M48 price rules and design correction 7), research
 * default selection, hero skill / gear summaries, the paper-doll split, energy pips, the campaign frontier, result
 * count-up and delta tones, the sheet-mode resource rows and the living header's motion. No Compose; JVM-tested in
 * `ArmyLogicTest`. Composables only call these; mappers (Codex) may call them too.
 */

// --- Durations --------------------------------------------------------------------------------------------------------

/**
 * A remaining or total duration for the army sheets (owner decision D-070: one duration style, days above 24 h; the
 * battle clock is the only m:ss). Null or negative-unknown is "…". Whole seconds; "0s" only shows when
 * the server said it is done. A zero second unit is dropped ("38m", "takes 6h"), as the mockups read.
 */
fun armyDuration(seconds: Long?): String {
    if (seconds == null || seconds < 0) return UNKNOWN
    val s = seconds
    fun pair(big: Long, bigUnit: String, small: Long, smallUnit: String) = if (small == 0L) "$big$bigUnit" else "$big$bigUnit $small$smallUnit"
    return when {
        s >= 86_400 -> pair(s / 86_400, "d", s % 86_400 / 3_600, "h")
        s >= 3_600 -> pair(s / 3_600, "h", s % 3_600 / 60, "m")
        s >= 60 -> pair(s / 60, "m", s % 60, "s")
        else -> "${s}s"
    }
}

private fun grouped(n: Int): String = String.format(Locale.US, "%,d", n)

// --- Housing ----------------------------------------------------------------------------------------------------------

/** The housing meter's three segments as fractions of capacity (0..1, summing to ≤ 1). */
data class HousingFractions(val ready: Float, val training: Float, val draft: Float)

/** The housing meter's segments. Unknown or zero capacity draws an empty track; each segment is clamped so the meter
 *  never overflows (SPEC §2: overflow is impossible). [showDraft] false (ARMY tab) drops the draft. */
fun housingFractions(h: HousingUi, showDraft: Boolean = true): HousingFractions {
    if (!h.known || h.capacity <= 0) return HousingFractions(0f, 0f, 0f)
    val cap = h.capacity.toFloat()
    val ready = (h.ready.coerceAtLeast(0) / cap).coerceIn(0f, 1f)
    val training = (h.training.coerceAtLeast(0) / cap).coerceIn(0f, 1f - ready)
    val draft = if (showDraft) (h.draft.coerceAtLeast(0) / cap).coerceIn(0f, 1f - ready - training) else 0f
    return HousingFractions(ready, training, draft)
}

/** The housing header's figures: "32" "+9" "50" (the draft part only when > 0 and shown); "…" while unknown. */
data class HousingCount(val current: String, val draft: String?, val capacity: String)

fun housingCount(h: HousingUi, showDraft: Boolean = true): HousingCount =
    if (!h.known) HousingCount(UNKNOWN, null, UNKNOWN)
    else HousingCount(grouped(h.ready + h.training), if (showDraft && h.draft > 0) "+${grouped(h.draft)}" else null, grouped(h.capacity))

/** The housing legend's parts (SPEC §2 / §3). */
data class HousingLegend(val ready: String, val training: String, val draft: String?, val fullNote: String?)

/** "24 ready", "8 training" (ARMY tab: "4 training · in 2m 10s"), "9 chosen", and "· full" when full. */
fun housingLegend(h: HousingUi, trainingDoneInSec: Long? = null, showDraft: Boolean = true): HousingLegend {
    if (!h.known) return HousingLegend("$UNKNOWN ready", "$UNKNOWN training", if (showDraft) "$UNKNOWN chosen" else null, null)
    val training = "${grouped(h.training)} training" + if (!showDraft && h.training > 0 && trainingDoneInSec != null) " · in ${armyDuration(trainingDoneInSec)}" else ""
    return HousingLegend("${grouped(h.ready)} ready", training, if (showDraft) "${grouped(h.draft)} chosen" else null, if (h.full) "· full" else null)
}

/** Points of room left for the draft: capacity − ready − training − draft, never below 0; 0 while unknown. */
fun roomLeft(h: HousingUi): Int = if (!h.known) 0 else (h.capacity - h.ready - h.training - h.draft).coerceAtLeast(0)

/** The draft's step limit (SPEC §2: the draft stops at capacity): one more troop of [pts] fits. Unknown housing or a
 *  troop with no housing value never fits (the server has not said there is room). */
fun canAddTroop(h: HousingUi, pts: Int): Boolean = h.known && !h.full && pts > 0 && roomLeft(h) >= pts

/** One line of a draft being loaded from a saved army: [count] troops of [pts] points each. */
data class DraftLine(val troop: String, val pts: Int, val count: Int)

/** The result of trimming a saved army to the room left: what fits, and how many troops did not ("3 troops didn't fit"). */
data class DraftTrim(val kept: List<DraftLine>, val droppedTroops: Int)

/** Fills [room] points from [wanted] in order, as many of each troop as fit (SPEC §3 `onLoadSaved`). */
fun trimDraft(room: Int, wanted: List<DraftLine>): DraftTrim {
    var left = room.coerceAtLeast(0)
    var dropped = 0
    val kept = wanted.mapNotNull { line ->
        val count = line.count.coerceAtLeast(0)
        val fits = if (line.pts <= 0) 0 else minOf(count, left / line.pts)
        left -= fits * line.pts.coerceAtLeast(0)
        dropped += count - fits
        if (fits > 0) line.copy(count = fits) else null
    }
    return DraftTrim(kept, dropped)
}

// --- Tap routing (M48 price rules + design correction 7) --------------------------------------------------------------

/** What a tap on a command does. */
enum class TapRoute {
    /** Run it (ENABLED; a CHECKING price is enabled navigation into the review). */
    RUN,
    /** Open the Need-more half sheet (SHORT); never auto-spends. */
    NEED_MORE,
    /** Show its reason (DISABLED / LOCKED / an UNAVAILABLE price). */
    EXPLAIN,
    /** Nothing (BUSY: nothing can be sent twice). */
    IGNORE,
}

/** The state a command is drawn in, after its price: an UNAVAILABLE price disables it; a SHORT price makes it SHORT. */
fun effectiveState(cmd: CommandUi): CommandState {
    if (cmd.state != CommandState.ENABLED) return cmd.state
    return when (cmd.price?.status) {
        PriceStatus.UNAVAILABLE -> CommandState.DISABLED
        PriceStatus.SHORT -> CommandState.SHORT
        else -> CommandState.ENABLED
    }
}

/** Where a tap on [cmd] goes (see [TapRoute]). */
fun commandTap(cmd: CommandUi): TapRoute = when (effectiveState(cmd)) {
    CommandState.ENABLED -> TapRoute.RUN
    CommandState.SHORT -> TapRoute.NEED_MORE
    CommandState.DISABLED, CommandState.LOCKED -> TapRoute.EXPLAIN
    CommandState.BUSY -> TapRoute.IGNORE
}

/** What a tap on a troop card does (SPEC §2 TroopCard table). */
enum class TroopTap { ADD, NEED_MORE, LOCKED, NO_ROOM, IGNORE }

/** Routes a troop-card tap; while TRAIN is sending ([sending]) cards are not tappable. */
fun troopTap(state: TroopCardState, sending: Boolean): TroopTap = when {
    sending -> TroopTap.IGNORE
    state == TroopCardState.DEFAULT || state == TroopCardState.CHOSEN -> TroopTap.ADD
    state == TroopCardState.SHORT -> TroopTap.NEED_MORE
    state == TroopCardState.LOCKED -> TroopTap.LOCKED
    else -> TroopTap.NO_ROOM
}

/** The FINISH price as drawn: "FREE" only when the server gave a zero AND says the first finish is free (SPEC §2
 *  `freeFinish`). Any other price is drawn exactly as the server gave it. */
fun finishPrice(price: PriceUi, freeFinish: Boolean): PriceUi =
    if (freeFinish && price.status == PriceStatus.SERVER_ZERO) price.copy(amount = "FREE", description = "Free finish") else price

// --- Tabs -------------------------------------------------------------------------------------------------------------

/** The red count on the TRAIN tab: queued groups, only when TRAIN is not the active tab (SPEC §2 / §3). */
fun trainTabBadge(queuedGroups: Int, trainActive: Boolean): BadgeUi? {
    if (trainActive || queuedGroups <= 0) return null
    val text = if (queuedGroups > 99) "99+" else queuedGroups.toString()
    return BadgeUi(text, BadgeTone.COUNT, "$queuedGroups training groups queued")
}

/** TRAIN · ARMY tabs of the Army sheet. [armyPortrait] is the troop portrait on the ARMY tab. */
fun armyTabs(selected: String, queuedGroups: Int, armyPortrait: String): List<TabUi> = listOf(
    TabUi(ARMY_TAB_TRAIN, "ui_icon_warhorn", "TRAIN", trainTabBadge(queuedGroups, selected == ARMY_TAB_TRAIN), false),
    TabUi(ARMY_TAB_ARMY, armyPortrait, "ARMY", null, false),
)

/** HERO · SKILLS · GEAR tabs; GEAR carries the gold NEW badge while a new item is in the bag. */
fun heroTabs(heroPortrait: String, firstSkillIcon: String, gearNew: Boolean): List<TabUi> = listOf(
    TabUi(HERO_TAB_HERO, heroPortrait, "HERO", null, false),
    TabUi(HERO_TAB_SKILLS, firstSkillIcon, "SKILLS", null, false),
    TabUi(HERO_TAB_GEAR, "itm_helm", "GEAR", if (gearNew) BadgeUi("NEW", BadgeTone.REWARD, "New gear in your bag") else null, false),
)

/** MATCH · CAMPAIGN · REVENGE tabs; REVENGE carries the red count of defences the player can answer. */
fun raidTabs(revengeCount: Int): List<TabUi> = listOf(
    TabUi(RAID_TAB_MATCH, "attack", "MATCH", null, false),
    TabUi(RAID_TAB_CAMPAIGN, "star", "CAMPAIGN", null, false),
    TabUi(RAID_TAB_REVENGE, "scout", "REVENGE",
        if (revengeCount > 0) BadgeUi(if (revengeCount > 99) "99+" else revengeCount.toString(), BadgeTone.COUNT, "$revengeCount raids to answer") else null, false),
)

const val ARMY_TAB_TRAIN = "TRAIN"
const val ARMY_TAB_ARMY = "ARMY"
const val HERO_TAB_HERO = "HERO"
const val HERO_TAB_SKILLS = "SKILLS"
const val HERO_TAB_GEAR = "GEAR"
const val RAID_TAB_MATCH = "MATCH"
const val RAID_TAB_CAMPAIGN = "CAMPAIGN"
const val RAID_TAB_REVENGE = "REVENGE"

// --- Research ---------------------------------------------------------------------------------------------------------

/** The default research selection (SPEC §4): the first affordable card; null when none can be researched now. */
fun defaultResearchSelection(cards: List<ResearchCardUi>): String? =
    cards.firstOrNull { it.state == ResearchCardState.DEFAULT || it.state == ResearchCardState.SELECTED }?.troop

/** What a tap on a research card does. */
enum class ResearchTap { SELECT, NEED_MORE, LAB_CAP, LOCKED, BUSY, NONE }

/** Routes a research-card tap: a tap selects, never starts (SPEC §4). While the Lab works, every card explains. */
fun researchTap(state: ResearchCardState, labBusy: Boolean): ResearchTap = when {
    labBusy || state == ResearchCardState.IN_LAB || state == ResearchCardState.BUSY -> ResearchTap.BUSY
    state == ResearchCardState.DEFAULT || state == ResearchCardState.SELECTED -> ResearchTap.SELECT
    state == ResearchCardState.SHORT -> ResearchTap.NEED_MORE
    state == ResearchCardState.LAB_CAP -> ResearchTap.LAB_CAP
    state == ResearchCardState.LOCKED -> ResearchTap.LOCKED
    else -> ResearchTap.NONE
}

// --- Heroes -----------------------------------------------------------------------------------------------------------

/** "2 of 5 · new at Lv 11"; "5 of 5" when every skill is open; "…" for an empty catalogue. */
fun skillSummary(skills: List<SkillUi>): String {
    if (skills.isEmpty()) return UNKNOWN
    val open = skills.count { it.unlocked }
    val next = skills.filter { !it.unlocked }.minByOrNull { it.unlockLevel }
    return "$open of ${skills.size}" + if (next != null) " · new at Lv ${next.unlockLevel}" else ""
}

/** "7 of 10 worn". */
fun gearSummary(worn: Int, slots: Int): String = if (slots <= 0) UNKNOWN else "$worn of $slots worn"

/** The awaken meter: the fill (worn / slots) and the 2 dp ink tick at the awaken threshold, both 0..1. */
data class AwakenMeter(val fill: Float, val tick: Float?)

fun awakenMeter(worn: Int, slots: Int, awakenAt: Int): AwakenMeter {
    if (slots <= 0) return AwakenMeter(0f, null)
    val fill = (worn.coerceAtLeast(0).toFloat() / slots).coerceIn(0f, 1f)
    val tick = if (awakenAt in 1..slots) awakenAt.toFloat() / slots else null
    return AwakenMeter(fill, tick)
}

/** The paper doll's columns (SPEC §5: left Helm Amulet Chest Cloak, right Gloves Ring Boots Banner, bottom Weapon
 *  Offhand): the first four slots in `GEAR_SLOTS` order go left, the next four right, the rest along the bottom. */
data class PaperDoll<T>(val left: List<T>, val right: List<T>, val bottom: List<T>)

fun <T> paperDoll(slots: List<T>): PaperDoll<T> = PaperDoll(slots.take(4), slots.drop(4).take(4), slots.drop(8))

/** The health line beside HEALTH (SPEC §5): "full", "back in 1h 20m", or "…" when unknown. */
fun healthLabel(fraction: Float?, remainingSec: Long?): String = when {
    remainingSec != null && remainingSec > 0 -> "back in ${armyDuration(remainingSec)}"
    fraction != null && fraction >= 1f -> "full"
    fraction == null -> UNKNOWN
    else -> "resting"
}

/** "LV 10" for the next level, "MAX" at the cap. */
fun nextLevelLabel(level: Int, maxLevel: Int): String = if (maxLevel in 1..level) "MAX" else "LV ${level + 1}"

/** The next-skill row's line: "Degen Awakening · 2 levels to go" ("1 level to go"); null at the cap or when the skill
 *  is already open (the row is hidden). */
fun nextSkillLine(skill: SkillUi?, level: Int, maxLevel: Int): String? {
    if (skill == null || skill.unlocked || (maxLevel in 1..level)) return null
    val left = (skill.unlockLevel - level).coerceAtLeast(1)
    return "${skill.name} · $left ${if (left == 1) "level" else "levels"} to go"
}

// --- Raid chooser -----------------------------------------------------------------------------------------------------

/** One pip per energy point: true = full. Null when energy is unknown (the chip shows "…"). At most [cap] pips. */
fun energyPips(now: Int?, max: Int?, cap: Int = 10): List<Boolean>? {
    if (now == null || max == null || max <= 0) return null
    val n = minOf(max, cap)
    return List(n) { it < now.coerceIn(0, n) }
}

/** The energy chip's line: "+1 in 38m" while refilling, "full" at max, "…" unknown. */
fun energyLine(now: Int?, max: Int?, nextInSec: Long?): String = when {
    now == null || max == null -> UNKNOWN
    now >= max -> "full"
    nextInSec == null -> UNKNOWN
    else -> "+1 in ${armyDuration(nextInSec)}"
}

/** "42/50", "…/…" while unknown. */
fun readyOfCapacity(ready: Int?, capacity: Int?): String = "${ready?.let(::grouped) ?: UNKNOWN}/${capacity?.let(::grouped) ?: UNKNOWN}"

/** The tone of a label that starts with a signed number ("+8,200 Shards" GAIN, "-9 trophies" LOSS, "defeat" UNKNOWN). */
fun leadingTone(label: String): DeltaTone = deltaTone(label.trim().substringBefore(' '))

/** Whether a campaign node may be selected (SPEC §6: never past the frontier). Cleared and NEXT nodes can be. */
fun canSelectStage(node: StageNodeUi): Boolean = node.state != StageNodeState.LOCKED

// --- Battle result ----------------------------------------------------------------------------------------------------

/** The tone of a loot or trophy delta: green gain, red loss, ink zero; "…" or anything unparseable is UNKNOWN. */
enum class DeltaTone { GAIN, LOSS, ZERO, UNKNOWN }

fun deltaTone(delta: String): DeltaTone {
    val t = delta.trim()
    val digits = t.removePrefix("+").removePrefix("-").removePrefix("−").replace(",", "").replace(".", "")
    if (digits.isEmpty() || !digits.all { it.isDigit() }) return DeltaTone.UNKNOWN
    if (digits.all { it == '0' }) return DeltaTone.ZERO
    return if (t.startsWith("-") || t.startsWith("−")) DeltaTone.LOSS else DeltaTone.GAIN
}

/**
 * The text a signed delta shows [t] (0..1) through its 600 ms count-up from zero ("+12,400" → "+6,200" halfway). Only
 * whole numbers, plain or comma-grouped, count; anything else ("…", "LOOT REDACTED", "1.2K") shows as given.
 */
fun countUpSigned(to: String, t: Float): String {
    if (t >= 1f) return to
    val trimmed = to.trim()
    val sign = when { trimmed.startsWith("+") -> "+"; trimmed.startsWith("-") -> "-"; trimmed.startsWith("−") -> "−"; else -> "" }
    val body = trimmed.removePrefix(sign)
    val isGrouped = Regex("^\\d{1,3}(,\\d{3})+$").matches(body)
    if (!isGrouped && !Regex("^\\d+$").matches(body)) return to
    val target = body.replace(",", "").toLongOrNull() ?: return to
    val v = (target * t.coerceIn(0f, 1f).toDouble()).toLong()
    return sign + if (isGrouped) String.format(Locale.US, "%,d", v) else v.toString()
}

/** The LOOT section's hint (SPEC §7): "sent to your storage" when the server settled a gain, "nothing taken this time"
 *  when it settled none, "Counting…" until the receipt, "still being settled" when the read failed (never "nothing was
 *  spent": the result is uncertain until the server answers). */
fun lootHint(settlement: SettlementUi): String? = when (settlement) {
    is SettlementUi.Settled -> if (settlement.loot.any { deltaTone(it.delta) == DeltaTone.GAIN }) "sent to your storage" else "nothing taken this time"
    SettlementUi.Pending -> "Counting…"
    SettlementUi.Redacted -> null
    is SettlementUi.Failed -> "still being settled"
}

// --- Sheet-mode resource rows ------------------------------------------------------------------------------------------

/** Which army surface a resource stack belongs to. */
enum class ArmySheetKind { TRAIN, ARMY, RESEARCH, HEROES, RAID, RESULT }

/**
 * The resource rows a sheet shows over the world strip (SPEC §1): only the currencies it spends. TRAIN and Research:
 * Shards + Gems; ARMY and Raid: Shards; Heroes: Gems; the result: Shards (the coin-fly target). Rows are matched by
 * their accent; SKR and KEEP never show on these sheets.
 */
fun sheetResourceRows(all: List<ResourceChipUi>, kind: ArmySheetKind): List<ResourceChipUi> {
    val wanted = when (kind) {
        ArmySheetKind.TRAIN, ArmySheetKind.RESEARCH -> listOf(ResourceAccent.SHARDS, ResourceAccent.GEMS)
        ArmySheetKind.ARMY, ArmySheetKind.RAID, ArmySheetKind.RESULT -> listOf(ResourceAccent.SHARDS)
        ArmySheetKind.HEROES -> listOf(ResourceAccent.GEMS)
    }
    return wanted.mapNotNull { accent -> all.firstOrNull { it.accent == accent } }.map { it.copy(drawerHandle = false) }
}

// --- Living header ----------------------------------------------------------------------------------------------------

/** The dp a sprite of [artPx] master px takes at [scale] device px per art px on the mock's DPR-2 phone (SPEC §8). */
fun artDp(artPx: Int, scale: Int): Float = artPx.coerceAtLeast(1) * scale.coerceAtLeast(1) / 2f

/** The frame name of a strip: the stem itself for one frame, else "<stem>_f<i>" with i 1-based. */
fun frameName(stem: String, index: Int, frames: Int): String = if (frames <= 1) stem else "${stem}_f${index.mod(frames) + 1}"

/** The frame index at [elapsedMs] for a strip at [fps]. */
fun headerFrame(elapsedMs: Long, fps: Int, frames: Int): Int =
    if (frames <= 1 || fps <= 0) 0 else ((elapsedMs * fps / 1000) % frames).toInt()

/** Walking speed along x in dp/s (SPEC §8: 12 dp/s): left for W / SW / NW, right for E / NE / SE, standing for S / N. */
fun walkerVelocityDp(dir: Dir8): Float = when (dir) {
    Dir8.W, Dir8.SW, Dir8.NW -> -12f
    Dir8.E, Dir8.NE, Dir8.SE -> 12f
    Dir8.S, Dir8.N -> 0f
}

/** A walker's x after [elapsedMs], wrapping so it leaves one edge and re-enters at the other ([widthDp] wide header,
 *  [spriteDp] wide sprite). */
fun walkerX(startDp: Float, velocityDp: Float, elapsedMs: Long, widthDp: Float, spriteDp: Float): Float {
    if (velocityDp == 0f || widthDp <= 0f) return startDp
    val span = widthDp + spriteDp
    val raw = startDp + spriteDp + velocityDp * elapsedMs / 1000f
    val wrapped = ((raw % span) + span) % span
    return wrapped - spriteDp
}
