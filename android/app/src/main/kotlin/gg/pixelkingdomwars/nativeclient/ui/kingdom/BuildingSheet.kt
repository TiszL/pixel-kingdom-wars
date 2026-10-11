package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Switch
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexEntry
import java.math.BigDecimal
import java.time.Instant
import kotlinx.serialization.json.JsonObject

/** Source sheets.tsx sheetPortrait: WARE/cannon/mortar use ART_V2 at the actual building level.
 * Walls use their independent five-tier family; unknown hero levels use the source base portrait. */
internal fun sheetBuildingPortrait(catalogue: JsonObject, type: String, level: Int, heroLevel: Int? = null): String {
    val tiered = setOf("cannon", "mortar", "airdefence", "airmine", "forge", "archertower", "barracks", "camp", "clanhall", "dragonnest", "electrictower", "goldforge", "keep", "lasertower", "magetower", "mine", "pitfall", "powdermine", "spiketrap", "vault")
    if (type == "heroaltar") return gg.pixelkingdomwars.nativeclient.ui.roster.rosterHeroPortrait(catalogue, "vex", heroLevel)
    if (type == "siegestool") return gg.pixelkingdomwars.nativeclient.ui.roster.rosterHeroPortrait(catalogue, "theodor", heroLevel)
    // Owner 2026-10-06: no old dark-box portrait for a building. The Keep is its own level's realm-kit strip.
    if (type == "keep") return gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.keepArtName(level)
    if (type !in tiered && type != "wall") return "building-$type"
    val art = ((catalogue["constants"] as? JsonObject)?.get(if (type == "wall") "WALL_ART" else "ART_V2") as? JsonObject)
    val tiers = art?.string("tiers")?.toIntOrNull()?.takeIf { it > 0 } ?: return "building-$type"
    val perTier = art.string("levelsPerTier")?.toIntOrNull()?.takeIf { it > 0 } ?: return "building-$type"
    val tier = (((level.coerceAtLeast(1).toLong() - 1) / perTier) + 1).coerceAtMost(tiers.toLong()).toInt()
    return if (type == "wall") "wall5_t${tier}_straight_intact_f1"
        else gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.designedBuildingArt(type, level, tier) ?: "building-$type"
}

/** `builderJobs.kind` as the noun the KEEP confirmation puts in a sentence (web `JOB_NOUN`). */
private fun jobNoun(kind: String) = when (kind) { "build" -> "BUILD"; "upgrade" -> "UPGRADE"; "clear_obstacle" -> "CLEARING"; else -> "JOB" }
private fun remainingSec(job: BaseJob, now: Long): Long = job.finishesAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }?.let { maxOf(0L, (it - now + 999) / 1000) } ?: 0L

/** A missing price cannot become a free-looking consent for an authoritative paid action. */
internal fun buildingFinishPrice(value: String?): String? = value?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }

/** How one stat chip states the next level. Web `HudStatDelta` prints "cur ▸ next"; the native chip keeps the
 * current value as THE value and puts the gain beside it ("+312", "+5%"), so the eye reaches what the upgrade
 * buys before it reaches the arithmetic. A pair the arithmetic does not understand (a "×1.7" multiplier), or
 * a next equal to the current, yields no delta: the chip then shows "▸ next" verbatim in gold. Nothing is
 * ever computed from a string that is not a plain decimal — a wrong gain on a paid upgrade is worse than none. */
internal data class StatDelta(val text: String, val positive: Boolean)
private val STAT_NUMBER = Regex("^(-?)([0-9][0-9,]*)(\\.[0-9]+)?(%?)$")
internal fun statDelta(current: String, next: String?): StatDelta? {
    val from = STAT_NUMBER.find(current.trim()) ?: return null
    val to = STAT_NUMBER.find((next ?: return null).trim()) ?: return null
    if (from.groupValues[4] != to.groupValues[4]) return null
    fun value(match: MatchResult) = BigDecimal(match.groupValues[1] + match.groupValues[2].replace(",", "") + match.groupValues[3])
    val delta = value(to) - value(from)
    if (delta.signum() == 0) return null
    val magnitude = delta.abs().stripTrailingZeros()
    val digits = if (magnitude.scale() <= 0) fmtN(magnitude.toPlainString()) else magnitude.toPlainString()
    return StatDelta((if (delta.signum() > 0) "+" else "−") + digits + from.groupValues[4], delta.signum() > 0)
}

/** Whether the sheet pins its heading and primary action around a scrolling body. The Seeker's landscape
 * viewport hands the sheet about 246dp; the heading (56) and the footer plate (72) still leave a readable body,
 * so UPGRADE stays visible without a scroll there. Only a really short window, or enlarged text, folds the
 * whole sheet into one scroller — the action must remain REACHABLE before it is pinned. */
internal fun sheetPinsActions(maxHeightDp: Float, fontScale: Float): Boolean = maxHeightDp >= 200f && fontScale <= 1.3f

/** A pending KEEP spend or cancellation the player must confirm before it is posted. */
sealed interface SheetConfirmation {
    data class KeepSpend(val costKeep: String, val what: String, val onConfirm: () -> Unit) : SheetConfirmation
    data class CancelJob(val what: String, val refundShards: String, val onConfirm: () -> Unit) : SheetConfirmation
}

/** The type's own action on the sheet and on the command bar (web ActionSheet's per-type button). */
internal enum class BuildingUse { TRAIN, RESEARCH, ARMY, FORGE, COLLECT, HERO }
internal fun buildingUse(type: String): BuildingUse? = when (type) {
    "barracks" -> BuildingUse.TRAIN; "forge" -> BuildingUse.RESEARCH; "camp" -> BuildingUse.ARMY
    "goldforge" -> BuildingUse.FORGE; "mine" -> BuildingUse.COLLECT; "heroaltar", "siegestool" -> BuildingUse.HERO
    else -> null
}

/** What one building can do right now: the catalogue lookups and server flags this sheet has always read, lifted out
 * so the command bar reads the SAME copy (it never re-derives a gate or a price). TODO(MS-C2): replace with the
 * registry's `GateContext` / `buildingCommands` once they exist. */
internal data class BuildingGates(
    val job: BaseJob?, val level: Int, val max: Int, val repair: TrapRepair?, val price: BaseOrderPrice?, val upgradeSol: Long?,
    val paidOffer: BasePurchaseOffer?, val upgradeCost: String?, val enabled: Boolean, val canShowUpgrade: Boolean, val finishPrice: String?,
)
internal fun buildingGates(state: KingdomUiState, building: Building, busy: Boolean): BuildingGates? {
    val catalogue = state.catalogue ?: return null
    val base = state.base ?: return null
    val job = base.jobs.firstOrNull { it.buildingId == building.id }
    val level = building.level
    val repair = trapRepairDetails(catalogue, building.type, level, building.trapSpentAt)
    val upgradeCost = ((catalogue["constants"] as? JsonObject)?.get("UPGRADE_COSTS") as? JsonObject)?.get(building.type)?.let { (it as? kotlinx.serialization.json.JsonArray)?.getOrNull(level - 1) }?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
    return BuildingGates(
        job = job, level = level, max = maxLevelFor(catalogue, building.type), repair = repair,
        price = buildingUpgradePrice(catalogue, base.raw.objects("buildings").first { it.string("id") == building.id }),
        upgradeSol = upgradeSolLamports(catalogue, building.type, level + 1),
        paidOffer = if (building.type in setOf("mine", "goldforge")) basePurchaseOffer(catalogue, base, "mine", building.id) else null,
        upgradeCost = upgradeCost,
        enabled = !busy && !state.constructionBlocked && state.ordersAllowed && state.deedActionsAllowed,
        canShowUpgrade = upgradeCost != null && job == null && repair == null && !(building.type == "wall" && state.local.wallRow) && state.constructionAvailable(building.type, level + 1, building.id),
        finishPrice = buildingFinishPrice(job?.finishCostKeep),
    )
}

/** The building action sheet (web `ui/sheets.tsx` ActionSheet): identity, the stat block quoting the next
 * level, the running job with CANCEL / FINISH, the type's own action, the primary UPGRADE plate and DETAILS.
 * Every price shown is a catalogue lookup or the server's own quote; the server re-prices every order.
 * [infoOnly]: the INFO sheet behind the command bar (identity, stats, running job with CANCEL, wall-row toggle,
 * codex); the bar owns the actions, so the action plates and the footer are dropped. */
@Composable fun BuildingSheet(
    state: KingdomUiState, building: Building, busy: Boolean, now: Long, mine: MineStatus?,
    onTrain: () -> Unit, onResearch: () -> Unit, onArmy: () -> Unit, onForge: () -> Unit,
    onUpgrade: () -> Unit, onFinish: () -> Unit, onCancel: () -> Unit, onRepair: () -> Unit, onCollect: () -> Unit,
    onToggleRow: () -> Unit, onQuoteRow: () -> Unit, onToggleInfo: () -> Unit, onClose: () -> Unit,
    onConfirm: (SheetConfirmation) -> Unit,
    onPaidUpgrade: () -> Unit = {},
    maxHeight: Dp = 360.dp,
    onHeroes: () -> Unit = {}, onRefresh: () -> Unit = {}, error: String? = null,
    infoOnly: Boolean = false,
) {
    val catalogue = state.catalogue ?: return
    val base = state.base ?: return
    val gates = buildingGates(state, building, busy) ?: return
    val job = gates.job
    val level = gates.level
    val max = gates.max
    val stats = levelStats(catalogue, building.type, level)
    val repair = gates.repair
    val price = gates.price
    val upgradeSol = gates.upgradeSol
    val paidOffer = gates.paidOffer
    val upgradeCost = gates.upgradeCost
    val enabled = gates.enabled
    val infoOpen = state.local.infoOpen ?: false
    val remaining = job?.let { remainingSec(it, now) } ?: 0L
    val finishPrice = gates.finishPrice
    val freeFinish = finishPrice == "0"
    val heroKey = when (building.type) { "heroaltar" -> "vex"; "siegestool" -> "theodor"; else -> null }
    val hero = heroKey?.let { key -> base.raw.objects("heroes").firstOrNull { it.string("hero") == key } }
    val heroAvailable = hero?.get("available")?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.content?.toBooleanStrictOrNull()
    val recoveryEnd = hero?.string("recoveryUntil")?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val recoverySeconds = recoveryEnd?.let { ((it - now + 999) / 1000).coerceAtLeast(0) }
    // The plate in the footer is THE primary (gold); the same action rendered in the body is a secondary tab.
    val useAction: (@Composable (Boolean) -> Unit)? = when (buildingUse(building.type)) {
        BuildingUse.TRAIN -> { { primary -> BuildingAction("TRAIN TROOPS", "Open your training queue", "army", primary = primary, onClick = onTrain) } }
        BuildingUse.RESEARCH -> { { primary -> BuildingAction("UPGRADE TROOPS", "Choose troop research", "energy", primary = primary, onClick = onResearch) } }
        BuildingUse.ARMY -> { { primary -> BuildingAction("VIEW ARMY", "Review troops and heroes", "army", primary = primary, onClick = onArmy) } }
        BuildingUse.FORGE -> { { primary -> BuildingAction("SMELT SHARDS", "Exchange SHARDS for KEEP", "keep", primary = primary, onClick = onForge) } }
        BuildingUse.COLLECT -> { { primary -> MineCollect(mine, busy, enabled, primary, onCollect) } }
        BuildingUse.HERO -> { { primary -> BuildingAction(if (heroAvailable == false) "HERO RECOVERY" else "MANAGE HERO", "Review upgrades and recovery", "army", primary = primary, onClick = onHeroes) } }
        null -> null
    }
    val canShowUpgrade = gates.canShowUpgrade
    val upgradeAction: @Composable (Boolean) -> Unit = { primary ->
        if (canShowUpgrade) {
            if (upgradeSol != null && upgradeSol > 0) {
                BuildingAction("UPGRADE TO LEVEL ${level + 1}", "${fmtN(upgradeCost ?: "0")} SHARDS + ${basePurchaseSol(upgradeSol.toString())} SOL${paidOffer?.seconds?.toLongOrNull()?.let { " · ${fmtDur(it)}" } ?: ""}",
                    "shards", enabled && paidOffer != null, primary, onPaidUpgrade)
            } else BuildingAction("UPGRADE TO LEVEL ${level + 1}", "${fmtN(upgradeCost ?: "0")} SHARDS${price?.seconds?.let { " · ${fmtDur(it.toLong())}" } ?: ""}",
                "shards", enabled && price != null, primary, onUpgrade)
        }
    }
    val heading: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth().background(Palette.ink).padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            PixelPlate("shard", Modifier.size(40.dp)) {
                GameArt(sheetBuildingPortrait(catalogue, building.type, building.level,
                    base.raw.objects("heroes").firstOrNull { it.string("hero") == if (building.type == "heroaltar") "vex" else "theodor" }?.string("level")?.toIntOrNull()),
                    Modifier.size(32.dp).align(Alignment.Center))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(trayLabel(building.type), color = Palette.gold, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                LevelPill(level, max)
            }
            SheetDockTab("DETAILS", "info", selected = infoOpen, description = if (infoOpen) "Hide building details" else "Show building details", onClick = onToggleInfo)
            SheetClosePlate("Close building details", onClose)
        }
    }
    val body: @Composable () -> Unit = {
        Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            error?.let { Notice(it, error = true); OutlinedButton(onClick = onRefresh, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("REFRESH BUILDING") } }
            if (hero != null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt("shield", Modifier.size(18.dp))
                Text(when (heroAvailable) {
                    true -> "READY · ATTACK + DEFENCE"
                    false -> "RECOVERING · ${if (recoverySeconds != null && recoverySeconds > 0) fmtDur(recoverySeconds) else "VERIFYING"} · CANNOT ATTACK OR DEFEND"
                    else -> "CHECK HERO READINESS"
                }, color = if (heroAvailable == true) Palette.success else Palette.gold, style = MaterialTheme.typography.bodyMedium)
            }
            stats?.let { StatGrid(it, level) }
            job?.let { running ->
                RunningJobCard(running, remaining, now, enabled, cancel = running.refundShards?.takeIf { running.canCancel }?.let { refund ->
                    { onConfirm(SheetConfirmation.CancelJob("${trayLabel(building.type)} LEVEL $level→${level + 1}", refund, onCancel)) }
                })
                if (!infoOnly) useAction?.invoke(false)
            }
            if (building.type == "clanhall") Text("CLAN WARFARE — COMING SOON", color = Palette.gold, style = MaterialTheme.typography.bodySmall)
            if (building.type == "wall") OutlinedButton(onClick = onToggleRow, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text(if (state.local.wallRow) "SELECT SINGLE WALL" else "SELECT WHOLE ROW", style = MaterialTheme.typography.labelMedium)
            }
            if (building.type == "wall" && state.local.wallRow && job != null) BuildingAction(if (busy) "CHECKING ROW…" else "UPGRADE ROW", "Review the selected wall row", "shards",
                !busy && !state.wallRowBlocked && state.ordersAllowed && state.deedActionsAllowed, false, onQuoteRow)
            if (building.type == "wall" && state.local.wallRow && state.wallRowBlocked) Text("Resolve the interrupted wall row purchase above before checking the row again.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            if (!infoOnly && useAction != null && canShowUpgrade) upgradeAction(false)
            if (canShowUpgrade && upgradeSol != null && upgradeSol > 0) Text("Review this building's paid upgrade before approving it with your wallet.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            // Web: DETAILS renders the building's own Codex prose in place, under the live numbers.
            if (infoOpen) Column(Modifier.fillMaxWidth().background(Palette.card).border(1.dp, Palette.borderLt).padding(10.dp)) { BuildingInfo(catalogue, building.type, level, max) }
        }
    }
    val hasFooter = !infoOnly && (job != null || repair != null || building.type == "wall" && state.local.wallRow || useAction != null || canShowUpgrade)
    val footer: @Composable () -> Unit = {
        if (hasFooter) Column(Modifier.fillMaxWidth().background(Palette.ink).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            when {
                job != null -> {
                    BuildingAction(if (freeFinish) "FINISH NOW · FREE" else "REVIEW FINISH", if (freeFinish) "Complete this ${jobNoun(job.kind).lowercase()}" else "Review current currency and maximum charge", "energy",
                        enabled && (freeFinish || builderFinishCanReview(job)), true, onFinish)
                    if (finishPrice == null) OutlinedButton(onClick = onRefresh, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("REFRESH FINISH PRICE") }
                }
                repair != null -> BuildingAction("REPAIR SPENT TRAP", "${fmtN(repair.costShards)} SHARDS · ${fmtDur(repair.repairSec)}", "shards", enabled, true, onRepair)
                building.type == "wall" && state.local.wallRow -> BuildingAction(if (busy) "CHECKING ROW…" else "UPGRADE ROW", "Review the selected wall row", "shards",
                    !busy && !state.wallRowBlocked && state.ordersAllowed && state.deedActionsAllowed, true, onQuoteRow)
                useAction != null -> useAction(true)
                else -> upgradeAction(true)
            }
        }
    }
    PixelPanel(Modifier.fillMaxWidth().heightIn(max = maxHeight)) {
        if (sheetPinsActions(maxHeight.value, LocalDensity.current.fontScale)) {
            heading()
            Box(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) { body() }
            footer()
        } else {
            // A short window or enlarged text must still reach the action; use one scroller there.
            Column(Modifier.verticalScroll(rememberScrollState())) { heading(); body(); footer() }
        }
    }
}

/** "LEVEL n / max" as a small pill under the name; MAX LEVEL is the one gold word at the top of the ladder. */
@Composable private fun LevelPill(level: Int, max: Int) {
    Row(Modifier.background(Palette.card).border(1.dp, Palette.borderLt).padding(horizontal = 6.dp, vertical = 1.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("LEVEL $level / $max", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
        if (level >= max) Text("· MAX LEVEL", style = MaterialTheme.typography.labelSmall, color = Palette.gold)
    }
}

/** A subordinate heading tool on the HUD dock plate (web dock tabs); pressed or open, it sits sunk. */
@Composable private fun SheetDockTab(label: String, art: String, selected: Boolean, description: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val sunk = pressed || selected
    PixelPlate(if (sunk) "dock-sunk" else "dock", Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp)
        .semantics { contentDescription = description; this.selected = selected }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick), PaddingValues(horizontal = 8.dp)) {
        Row(Modifier.heightIn(min = 48.dp).offset(y = if (sunk) 1.dp else 0.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            GameArt(art, Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.labelMedium.copy(fontSize = 14.sp, lineHeight = 15.sp), color = if (selected) Palette.text else Palette.textFaint, maxLines = 1, softWrap = false)
        }
    }
}

/** The one 48dp × plate every sheet heading closes with. */
@Composable internal fun SheetClosePlate(description: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    PixelPlate(if (pressed) "dock-sunk" else "dock", Modifier.size(48.dp).semantics { contentDescription = description }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)) {
        GameArt("close", Modifier.size(20.dp).align(Alignment.Center).offset(y = if (pressed) 1.dp else 0.dp))
    }
}

/** One action of the sheet on a forged plate: the icon, the title and its price line share one baseline
 * system. The footer's plate is gold — the same object RAID wears in the deck, so "the one thing this sheet
 * is for" is recognisably that everywhere; a secondary action wears the idle tab and cannot be mistaken. */
@Composable private fun BuildingAction(title: String, detail: String, art: String, enabled: Boolean = true, primary: Boolean = true, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val plate = if (primary) "gold" else "tab"
    PixelPlate(if (pressed) "$plate-sunk" else plate, Modifier.fillMaxWidth().heightIn(min = 56.dp).alpha(if (enabled) 1f else .5f)
        .clickable(enabled = enabled, interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick), PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).offset(y = if (pressed) 1.dp else 0.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            GameArt(art, Modifier.size(24.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(title, style = MaterialTheme.typography.labelLarge, color = if (primary) Palette.ink else Palette.text)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = if (primary) Palette.ink.copy(alpha = .8f) else Palette.muted)
            }
        }
    }
}

/** The running job on the KEEP-coloured well: what it is, how long remains, how far along, and the server's
 * refundable CANCEL where it offers one. FINISH lives on the primary plate underneath. */
@Composable private fun RunningJobCard(job: BaseJob, remaining: Long, now: Long, enabled: Boolean, cancel: (() -> Unit)?) {
    PixelPlate("keep", Modifier.fillMaxWidth(), PaddingValues(10.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt("timer", Modifier.size(20.dp))
                Text("${jobNoun(job.kind)} IN PROGRESS", Modifier.weight(1f), color = Palette.muted, style = MaterialTheme.typography.labelMedium)
                Text(fmtDur(remaining), color = Palette.goldHi, style = MaterialTheme.typography.titleMedium)
            }
            baseJobProgress(job.startedAt, job.finishesAt, now)?.let { LinearProgressIndicator(progress = { it.fraction }, modifier = Modifier.fillMaxWidth()) }
            cancel?.let { TextButton(enabled = enabled, modifier = Modifier.fillMaxWidth(), onClick = it) { Text("CANCEL ${jobNoun(job.kind)}", style = MaterialTheme.typography.labelMedium) } }
        }
    }
}

/** Web `HudStatBlock`/`HudStatDelta` as a two-column grid of chips: the current value is the value; when
 * there is a next level to buy, its gain sits beside it in green, so the block IS the quote for the plate
 * underneath. At max level there is nothing to quote and the chips are the plain live stats. */
@Composable private fun StatGrid(stats: LevelStats, level: Int) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("LEVEL $level", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
            stats.caption?.let { Text("GAINS $it", style = MaterialTheme.typography.labelSmall, color = Palette.success) }
        }
        stats.rows.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                pair.forEach { StatChip(it, Modifier.weight(1f)) }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable private fun StatChip(row: StatRow, modifier: Modifier) {
    PixelPlate("shard", modifier.heightIn(min = 44.dp), PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
        Column(Modifier.fillMaxWidth().heightIn(min = 36.dp), verticalArrangement = Arrangement.Center) {
            Text(row.label, style = MaterialTheme.typography.labelSmall, color = Palette.muted)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(row.current, style = MaterialTheme.typography.titleSmall, color = Palette.text)
                row.next?.let { next ->
                    val delta = statDelta(row.current, next)
                    if (delta != null) Text(delta.text, style = MaterialTheme.typography.labelMedium, color = if (delta.positive) Palette.success else Palette.danger)
                    else Text("▸ $next", style = MaterialTheme.typography.labelMedium, color = Palette.gold)
                }
            }
        }
    }
}

/** Web `MineCollect`: one tap settles each physical buffer on this deed. */
@Composable private fun MineCollect(mine: MineStatus?, busy: Boolean, enabled: Boolean, primary: Boolean, onCollect: () -> Unit) {
    val mining = mine?.mining
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BuildingAction(if (mining != null) "COLLECT SHARDS" else if (busy) "LOADING MINING…" else "MINING UNAVAILABLE",
            mining?.let { "${fmtN(it.accrued)} / ${fmtN(it.storageCap)} SHARDS${it.ratePerHour.takeIf { rate -> rate != "0" }?.let { rate -> " · ${fmtN(rate)}/H" } ?: ""}" } ?: "Check your mining status", "shards", enabled && mining != null, primary, onCollect)
        Text(if ((mining?.mineCount ?: 0) > 1) "Selected deed · all ${mining?.mineCount} mine buffers" else "Selected deed mining income", style = MaterialTheme.typography.labelSmall, color = Palette.muted, modifier = Modifier.align(Alignment.CenterHorizontally))
    }
}

/** Match a placed structure by its internal key; the ITEMS entry called KEEP is currency, not a building. */
internal fun sheetBuildingInfo(catalogue: JsonObject, type: String): CodexEntry? =
    (CodexData.defense(catalogue) + CodexData.buildings(catalogue)).firstOrNull { it.key == type }

/** Web `BuildingInfo.tsx`: the existing authored Codex prose and the Keep's derived unlock list. */
@Composable private fun BuildingInfo(catalogue: JsonObject, type: String, level: Int, maxLevel: Int) {
    val entry = remember(catalogue, type) { sheetBuildingInfo(catalogue, type) }
    val unlocks = if (type == "keep" && level < maxLevel) unlocksAtKeepLevel(catalogue, level + 1) else emptyList()
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        if (entry != null) {
            Text(entry.who, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            entry.strat?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.textFaint) }
        } else Text("Field reports on this structure are still being written. Its numbers above are live.",
            style = MaterialTheme.typography.bodySmall, color = Palette.textFaint)
        if (unlocks.isNotEmpty()) {
            Text("LEVEL ${level + 1} UNLOCKS", color = Palette.gold, style = MaterialTheme.typography.labelMedium)
            unlocks.forEach { Text("▸ ${unlockLabel(catalogue, it)}", style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Web `ObstacleSheet`: clearing costs SHARDS and rewards SHARDS. */
@Composable fun ObstacleSheet(catalogue: JsonObject, obstacle: Obstacle, busy: Boolean, blocked: Boolean, onClear: () -> Unit, onClose: () -> Unit) {
    val tier = obstacleTier(catalogue, obstacle.spriteKey.orEmpty()); val reward = obstacleClearRewardShards(catalogue)
    PixelPanel(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(Modifier.fillMaxWidth().background(Palette.ink).padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("CLEAR OBSTACLE", color = Palette.gold, style = MaterialTheme.typography.titleMedium)
                Text(obstacle.spriteKey.orEmpty().replace('_', ' ').uppercase(), color = Palette.muted, style = MaterialTheme.typography.labelSmall)
            }
            SheetClosePlate("Close obstacle details", onClose)
        }
        Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (reward != null) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt("shards", Modifier.size(18.dp))
                Text("CLEARING REWARD · +${fmtN(reward)} SHARDS", color = Palette.goldHi, style = MaterialTheme.typography.bodySmall)
            }
            BuildingAction("CLEAR OBSTACLE", tier?.let { "${fmtN(it.costShards)} SHARDS · ${fmtDur(it.clearSec)}" } ?: "Clearing cost unavailable", "shards", !busy && !blocked && tier != null, true, onClear)
        }
    }
}

/** Web `CancelJobConfirm.tsx`: one dialog in front of throwing away a running timer; the refund is the server's. */
@Composable fun CancelJobDialog(intent: SheetConfirmation.CancelJob, onDismiss: () -> Unit) {
    val amount = fmtN(intent.refundShards)
    // Owner 2026-10-06 (no old dark dialog on Home): the kit confirm, opened from the designed INFO sheet's running job. The
    // same words; the red door cancels (it used to be the outlined one), KEEP GOING is the stone back door.
    KingdomConfirmDialog(KingdomConfirmUi("CANCEL UPGRADE?",
        listOf("STOP ${intent.what}? PROGRESS SO FAR IS LOST.", "THE BUILDER IS FREED · A PAID FINISH IS NOT REFUNDED"),
        confirmLabel = "CANCEL UPGRADE · +$amount", backLabel = "KEEP GOING",
        confirmVerb = gg.pixelkingdomwars.nativeclient.ui.model.Verb.RED, emphasis = "REFUND +$amount SHARDS"),
        onConfirm = { onDismiss(); intent.onConfirm() }, onBack = onDismiss)
}

/** Web `KeepSpendConfirm.tsx`: one dialog in front of every KEEP spend; DON'T ASK AGAIN applies on CONFIRM only. */
@Composable fun KeepSpendDialog(intent: SheetConfirmation.KeepSpend, onDismiss: () -> Unit, onOptOut: () -> Unit) {
    var optOut by remember { mutableStateOf(false) }
    val amount = fmtN(intent.costKeep)
    AlertDialog(onDismissRequest = onDismiss, title = { Text("SPEND KEEP?", color = Palette.gold) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("$amount KEEP", style = MaterialTheme.typography.headlineSmall, color = Palette.gold)
            Text("SPEND $amount KEEP TO ${intent.what} IMMEDIATELY?")
            Text("KEEP IS THE HARD CURRENCY — NOT SHARDS.", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("DON'T ASK AGAIN", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall); Switch(checked = optOut, onCheckedChange = { optOut = it })
            }
            Button(onClick = { if (optOut) onOptOut(); onDismiss(); intent.onConfirm() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CONFIRM · $amount KEEP") }
            OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("CANCEL") }
        }
    }, confirmButton = {}, dismissButton = null)
}

/** Web `WallRowUpgrade.tsx` dialog: the quoted row grouped by level step, the total against the balance. */
@Composable fun WallRowDialog(quote: WallRowQuote, busy: Boolean, retry: Boolean, message: String?, onPurchase: () -> Unit, onRetry: () -> Unit, onCancel: () -> Unit) {
    val eligible = quote.eligible
    val groups = quote.walls.groupBy { wall ->
        when (wall.excluded) {
            "max_level" -> "LEVEL ${wall.level} · MAXED — UNCHANGED"
            "keep_level" -> "LEVEL ${wall.level} · NEEDS KEEP ${wall.level + 1} — UNCHANGED"
            "busy" -> "LEVEL ${wall.level} · BUSY — UNCHANGED"
            else -> "LEVEL ${wall.level} → ${wall.targetLevel}"
        }
    }
    AlertDialog(onDismissRequest = { if (!busy) onCancel() }, title = { Text("UPGRADE WALL ROW", color = Palette.gold) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${eligible.size} OF ${quote.walls.size} WALLS · ONE LEVEL EACH")
            groups.forEach { (label, walls) ->
                val cost = walls.sumOf { it.costShards.toLongOrNull() ?: 0L }
                Text("${walls.size} × $label" + (if (cost > 0) " · ${fmtN(cost)} SHARDS" else ""), style = MaterialTheme.typography.bodySmall)
            }
            Text("TOTAL ${fmtN(quote.totalCostShards)} SHARDS · BALANCE ${quote.balanceShards}")
            if (!quote.canAfford) Text("NOT ENOUGH SHARDS FOR THIS ROW", color = Palette.gold)
            message?.let { Text(it, color = Palette.gold, style = MaterialTheme.typography.bodySmall) }
        }
    }, confirmButton = {
        Button(onClick = { if (retry) onRetry() else onPurchase() }, enabled = !busy && quote.canAfford && eligible.isNotEmpty()) {
            Text(if (busy) "UPGRADING…" else if (retry) "RETRY SAME UPGRADE" else "UPGRADE ${eligible.size} WALLS · ${fmtN(quote.totalCostShards)} SHARDS")
        }
    }, dismissButton = { OutlinedButton(onClick = onCancel, enabled = !busy) { Text("CANCEL") } })
}

/** A clear job remains reachable after its obstacle leaves the current obstacle list. */
@Composable internal fun RunningObstacleSheet(job: BaseJob, now: Long, enabled: Boolean, onFinish: () -> Unit, onClose: () -> Unit) {
    // Owner 2026-10-06 (no old dark dialog on Home): the kit confirm with the same lines, the same enable rule and owners.
    KingdomConfirmDialog(KingdomConfirmUi("CLEARING OBSTACLE",
        listOfNotNull(baseJobProgress(job.startedAt, job.finishesAt, now)?.remaining, "Completion and price are confirmed by the server.", "Job ${job.id}"),
        confirmLabel = if (builderFinishIsFree(job)) "FINISH NOW · FREE" else "REVIEW FINISH", backLabel = "CLOSE",
        confirmVerb = gg.pixelkingdomwars.nativeclient.ui.model.Verb.GOLD,
        confirmEnabled = enabled && (builderFinishIsFree(job) || builderFinishCanReview(job))),
        onConfirm = onFinish, onBack = onClose)
}
