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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the Hero Altar SKILLS tab (design/final/army/SPEC.md E1.1 + critic fixes, heroes-skills.png;
 * registry rows 45/46 host, `Heroes(hero, "SKILLS")`). REPLACES the round 1 private `SkillsTab` inside HeroesSheet.kt.
 * Skills are not bought and have no skill points: each unlocks at a fixed hero level and grows by tier (T1 Lv 1-5 … T4
 * Lv 16-20), so this is a list with a tier track, not a tree, and it shows no per-skill price. The footer stays the HERO
 * tab's (Gems CostPill + "takes 6h" + green UPGRADE "Vex to Lv 10"), drawn by HeroesSheet from `HeroesUi.footer`.
 */

/** One skill row (SPEC E1.1 `SkillRowUi`). */
@Immutable data class SkillRowUi(
    val id: String,
    /** 32 px skill icon (`ui_skill_<name>`). */
    val icon: String,
    /** PS 12 name ("CRIMSON DASH"). */
    val name: String,
    /** The catalogue's effect, two lines max ("Dashes through defences. 3x damage to walls."). */
    val effect: String,
    /** The level it opens at (the stone "LV 11" tag while locked). */
    val unlockLevel: Int,
    val unlocked: Boolean,
    /** The current tier tag on the well ("T2"); null while locked. */
    val tierLabel: String?,
    /** "every 12s"; null when once a battle or unknown. */
    val cooldown: String?,
    /** "once a battle" (`oncePerBattle`). */
    val oncePerBattle: Boolean,
)

/** The next unlock card (SPEC E1.1 `NextUnlockUi`): icon + "AT LV 11" + "Degen Awakening, all skills T3". */
@Immutable data class NextUnlockUi(val icon: String, val level: Int, val line: String)

/** Everything the SKILLS tab draws (SPEC E1.1 `HeroSkillsUi`). */
@Immutable data class HeroSkillsUi(
    /** The hero's display name ("Vex"). */
    val hero: String,
    val level: Int,
    /** The current tier (1..4; `heroTier(level)`). */
    val tier: Int,
    /** The four tier cells ([tierCells]). */
    val tiers: List<TierCellUi>,
    /** In unlock order. */
    val skills: List<SkillRowUi>,
    /** Hidden at max level. */
    val next: NextUnlockUi?,
    /** The footer the sheet pins (the HERO tab's UPGRADE). */
    val footer: FooterUi,
    /** Loading: the last good list + a stone line. */
    val loading: Boolean = false,
    /** "Updated 2 min ago" after a failed refresh (+ CHECK); null draws none. */
    val staleSince: String? = null,
    /** Not recruited: the HERO tab's recruit EmptyState. */
    val recruit: EmptyStateUi? = null,
    /** The skill that just unlocked (flips locked → READY with a 0.9 → 1.1 → 1 pop, 220 ms `pop`); null = none. */
    val justUnlocked: String? = null,
)

/** SKILLS tab callbacks (SPEC E1.1). The tab switch, UPGRADE and the hero switch stay the sheet's (`HeroesActions`). */
class HeroSkillsActions(
    /** A skill row: the read-only SkillInfo half sheet (the T1-T4 table with the current tier highlighted). */
    val onSkill: (String) -> Unit,
    /** CHECK on the stale row. */
    val onCheck: () -> Unit = {},
    /** The recruit EmptyState GO. */
    val onGo: (gg.pixelkingdomwars.nativeclient.ui.features.FeatureId) -> Unit = {},
)

/** Tier-track colours (SPEC E1.1 literal hexes): done cream with a green-hi band, current gold rim on #FFF3C8, future #E9D7A6. */
private object TierInk {
    val future = Color(0xFFE9D7A6)
}

/**
 * The SKILLS tab body (heroes-skills.png), composed inside the Heroes `ArmyTallSheet` body column: "SKILL TIER grows as Vex
 * levels up" + the 4-cell tier track; "SKILLS 2 of 5 · Vex uses them on his own"; one 66 dp `SkillRow` per skill (dark well
 * with the tier tag, name, effect, READY / LV n + the cooldown); the gold-lo `NextLevelCard`.
 *
 * Pointer rule: content of a painted sheet; no full-screen clickable, pointerInput, scrim or draggable here.
 */
@Composable fun ColumnScope.HeroSkillsTab(ui: HeroSkillsUi, on: HeroSkillsActions) {
    val c = PkwTokens.Colors
    val recruit = ui.recruit
    if (recruit != null) { EmptyState(recruit, on.onGo); return }
    ui.staleSince?.let { NoticeRow("Updated $it", "CHECK", on.onCheck) }
    if (ui.loading) Box(Modifier.fillMaxWidth().heightIn(min = 2.dp).background(c.stone.face).clearAndSetSemantics { contentDescription = "Updating" })
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText("SKILL TIER", PkwTokens.Type.caption, color = c.textOnParch)
        PkwText("grows as ${ui.hero} levels up", PkwTokens.Type.small, color = c.textOnParch2)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ui.tiers.forEach { TierCell(it, Modifier.weight(1f)) }
    }
    SectionLine("SKILLS", skillsCountLine(ui.skills.count { it.unlocked }, ui.skills.size, ui.hero))
    ui.skills.forEach { SkillRow(it, it.id == ui.justUnlocked, on) }
    ui.next?.let { NextLevelCard(it) }
}

/** A tier cell (44 tall): PS 11 "T2" over VT 18 "Lv 6-10"; done = a green-hi 3 dp band on top and a 3 dp green-hi floor on
 *  cream, current = gold 3 dp rim on the selected tint, future = flat #E9D7A6 with a 3 dp parch-dk floor
 *  (heroes-skills.html `.tier`). */
@Composable private fun TierCell(cell: TierCellUi, modifier: Modifier) {
    val c = PkwTokens.Colors
    val body = when (cell.state) { TierState.DONE -> c.cream; TierState.CURRENT -> c.selectedTint; TierState.FUTURE -> TierInk.future }
    val spoken = "${cell.label}, ${cell.levels}, " + when (cell.state) { TierState.DONE -> "reached"; TierState.CURRENT -> "current"; TierState.FUTURE -> "later" }
    Column(modifier.heightIn(min = 44.dp).clearAndSetSemantics { contentDescription = spoken }.drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx(); val band = 3.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(body)
            when (cell.state) {
                TierState.DONE -> {
                    drawRect(c.green.hi, Offset(i, i), Size(w - 2 * i, band))
                    drawRect(c.green.hi, Offset(i, h - i - band), Size(w - 2 * i, band))
                }
                TierState.CURRENT -> {
                    val g = c.gold.face
                    drawRect(g, Offset(i, i), Size(w - 2 * i, band)); drawRect(g, Offset(i, h - i - band), Size(w - 2 * i, band))
                    drawRect(g, Offset(i, i), Size(band, h - 2 * i)); drawRect(g, Offset(w - i - band, i), Size(band, h - 2 * i))
                }
                TierState.FUTURE -> drawRect(ArmyInk.parchDk, Offset(i, h - i - band), Size(w - 2 * i, band))
            }
        }
    }.padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        PkwText(cell.label, PkwTokens.Type.caption, color = c.textOnParch)
        PkwText(cell.levels, PkwTokens.Type.small, color = c.textOnParch2)
    }
}

/** A `SkillRow` (66): dark 52 well with the icon 32 and the PS 11 gold-hi tier tag at the bottom-left; name; effect; right
 *  column 104: green READY or stone "LV 11" over the cooldown line. Locked rows: cream-lo body, icon grey 55 %. A newly
 *  unlocked row pops 0.9 → 1.1 → 1 (220 ms `pop`). A tap opens SkillInfo. */
@Composable private fun SkillRow(s: SkillRowUi, justUnlocked: Boolean, on: HeroSkillsActions) {
    val c = PkwTokens.Colors
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val pop = remember { Animatable(1f) }
    LaunchedEffect(justUnlocked) {
        if (!justUnlocked || still) return@LaunchedEffect
        pop.snapTo(0.9f); pop.animateTo(1f, tween(220, easing = PkwTokens.Motion.Pop))
    }
    val cool = cooldownLine(s.oncePerBattle, s.cooldown)
    val spoken = listOf(s.name, s.effect, if (s.unlocked) "ready" else "opens at level ${s.unlockLevel}", s.tierLabel ?: "", cool)
        .filter { it.isNotBlank() }.joinToString(". ")
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 66.dp).graphicsLayer { scaleX = pop.value; scaleY = pop.value },
        body = if (s.unlocked) null else c.creamLo, padding = PaddingValues(start = 6.dp, top = 4.dp, end = 8.dp, bottom = 6.dp),
        onClick = { on.onSkill(s.id) }, description = spoken) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(52.dp).background(c.ink).padding(2.dp).background(ArmyInk.well)) {
                PkwIcon(s.icon, 32.dp, Modifier.align(Alignment.Center).toned(if (s.unlocked) 1f else 0f, if (s.unlocked) 1f else 0.55f))
                s.tierLabel?.takeIf { s.unlocked }?.let { InkBox(it, c.gold.hi, Modifier.align(Alignment.BottomStart)) }
            }
            Column(Modifier.weight(1f)) {
                // heroes-skills.html `.srow .nm`: the PS 12 name in capitals ("CRIMSON DASH").
                PkwText(s.name.uppercase(), PkwTokens.Type.label, color = c.textOnParch)
                PkwText(s.effect, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
            }
            Column(Modifier.width(104.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (s.unlocked) Tag("READY", Verb.GREEN) else Tag("LV ${s.unlockLevel}", Verb.STONE)
                if (cool.isNotBlank()) PkwText(cool, PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
}

/** `NextLevelCard` (56, gold-lo rim on #FFF3C8): the next unlock icon in a 44 dp well + "AT LV 11" + the line
 *  (heroes-skills.html `.nextc`). Hidden at max level. */
@Composable private fun NextLevelCard(n: NextUnlockUi) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 56.dp), body = c.selectedTint, rim = c.gold.lo, rimWidth = 2.dp, padding = PaddingValues(6.dp),
        description = "At level ${n.level}: ${n.line}") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(44.dp).background(c.ink).padding(2.dp).background(ArmyInk.well), contentAlignment = Alignment.Center) { PkwIcon(n.icon, 32.dp) }
            Column(Modifier.weight(1f)) {
                PkwText("AT LV ${n.level}", PkwTokens.Type.caption, color = c.textOnParch)
                PkwText(n.line, PkwTokens.Type.body, color = c.textOnParch, maxLines = 2)
            }
        }
    }
}

// ---- Previews (inside the Heroes frame) ----

internal object SkillsSamples {
    private fun row(id: String, name: String, effect: String, unlock: Int, unlocked: Boolean, cooldown: String?, once: Boolean) =
        SkillRowUi(id, "ui_skill_$id", name, effect, unlock, unlocked, if (unlocked) "T2" else null, cooldown, once)
    val vex = HeroSkillsUi(
        hero = "Vex", level = 9, tier = heroTier(9), tiers = tierCells(9),
        skills = listOf(
            row("crimsondash", "CRIMSON DASH", "Dashes through defences. 3x damage to walls.", 1, true, "every 12s", false),
            row("moonwave", "MOONSUNDER WAVE", "A crescent cuts 6 tiles. Troops bleed.", 1, true, "every 16s", false),
            row("degenmode", "DEGEN AWAKENING", "10 s of fury: more damage, heals on hits.", 11, false, "every 40s", false),
            row("doubleornothing", "DOUBLE OR NOTHING", "Falls? A coin flip may bring him back.", 16, false, null, true),
            row("shardstorm", "OMEGA SHARDSTORM", "A shard nova and 8 crescents. Stuns.", 20, false, null, true)),
        next = NextUnlockUi("ui_skill_degenmode", 11, "Degen Awakening, all skills T3"),
        footer = HeroSamples.hero.footer,
    )
}

private val previewActions = HeroSkillsActions(onSkill = {})

@Composable private fun SkillsPreviewFrame(ui: HeroSkillsUi) {
    SheetPreviewFrame(ArmySheetKind.HEROES) { m ->
        ArmyTallSheet(HeroSamples.hero.header, heroTabs("hero_vex_portrait", "ui_skill_crimsondash", true), HERO_TAB_SKILLS, {}, {}, {}, m,
            headerTrailing = { HeroSamples.hero.header.switchTo?.let { HeroSwitchButton(it) {} } },
            footer = { ArmyFooter(ui.footer, {}, {}, {}) }) { HeroSkillsTab(ui, previewActions) }
    }
}

@Preview(name = "Heroes: SKILLS (heroes-skills.png)", widthDp = 412, heightDp = 915)
@Composable private fun HeroSkillsPreview() = SkillsPreviewFrame(SkillsSamples.vex)

@Preview(name = "Heroes: SKILLS max level, loading + stale, not recruited", widthDp = 1236, heightDp = 915)
@Composable private fun HeroSkillsStatesPreview() {
    val v = SkillsSamples.vex
    Row {
        Box(Modifier.width(412.dp).fillMaxSize()) { SkillsPreviewFrame(v.copy(level = 20, tier = 4, tiers = tierCells(20, maxed = true), next = null,
            skills = v.skills.map { it.copy(unlocked = true, tierLabel = "T4") })) }
        Box(Modifier.width(412.dp).fillMaxSize()) { SkillsPreviewFrame(v.copy(loading = true, staleSince = "2 min ago", justUnlocked = "moonwave")) }
        Box(Modifier.width(412.dp).fillMaxSize()) { SkillsPreviewFrame(v.copy(recruit = EmptyStateUi("hero_vex_portrait", "Recruit Vex at the Hero Altar",
            "Vex joins every raid once recruited.", null, null))) }
    }
}
