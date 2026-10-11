package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the Hero Altar HERO tab, re-done for both heroes (design/final/army/SPEC.md E1.2 + critic fixes,
 * heroes-theodor.png; registry row 45, `Heroes("theodor", "HERO")`). REPLACES the round 1 private `HeroTab` inside
 * HeroesSheet.kt. Differences from round 1: FINISH is 104 × 56 and carries its price INSIDE (PS 11 "FINISH" over gem 20 +
 * price, the builders.png pattern; CHECKING "…" is navigation into the Seal, UNAVAILABLE disables, SHORT opens Need-more);
 * the NEXT LEVEL block ends in the hero's role line; the skill strip shows 5 tiles and scrolls, ending in a stone chevron
 * 48 × 76 that opens the SKILLS tab (the blue ALL tile is gone: it duplicated the tab); a rest timer can be "as of 14:20".
 * Theodor's header (current grass, the stool and Theodor beside it, never overlapping; "Resting 1h 20m"; switch "VEX ▸")
 * is `HeroesUi.header` as before.
 */

/** What the re-done HERO tab adds to `HeroesUi` (a new class, so the committed sheet file stays untouched). */
@Immutable data class HeroTabExtrasUi(
    /** The role line under the stats ("Pulls guns within 6 tiles"); null draws none. Only catalogue role copy fills it
     *  (none exists today); it is never paraphrased from combat numbers. */
    val roleLine: String? = null,
    /** After a failed refresh the rest timer keeps its last value "as of 14:20"; null = live. */
    val restAsOf: String? = null,
    /** The live chip's "Being checked" after a FINISH whose answer was lost (FINISH stays as CHECK). */
    val finishChecking: Boolean = false,
)

/**
 * The HERO tab body (heroes.png / heroes-theodor.png), composed inside the Heroes `ArmyTallSheet` body column. [ui] is the
 * sheet's `HeroesUi` (hero, level, health, stats, skills, nextSkill, gear, finishRest, body, recruit); [extras] the round 2
 * additions; [on] the sheet's `HeroesActions` (`onAllSkills` = the chevron, `onFinishRest`, `onSkill`, `onGearGo`).
 *
 * Pointer rule: content of a painted sheet; no full-screen clickable, pointerInput, scrim or draggable here.
 */
@Composable fun ColumnScope.HeroTabV2(ui: HeroesUi, extras: HeroTabExtrasUi, on: HeroesActions) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        // Showcase 140 × 176: the body bottom-aligned 14 dp above the floor, Vex at 3 dp per art px (40 × 48 → 120 × 144,
        // heroes.png), Theodor at 2.5 (48 × 52 → 120 × 130, heroes-theodor.png).
        Box(Modifier.size(140.dp, 176.dp).background(c.ink).padding(2.dp).background(ArmyInk.heroWell)) {
            PkwIcon(ui.body, heroBodyBox(ui.hero, paperDoll = false), Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp))
            // Before the roster answers the level is unknown ("…", never "LV 0").
            InkBox("LV ${if (ui.loading) UNKNOWN else ui.level}", c.blue.hi, Modifier.align(Alignment.BottomStart))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val healthLine = healthLabel(ui.health.fraction, ui.health.remainingSec) + (extras.restAsOf?.let { " · as of $it" } ?: "")
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                PkwText("HEALTH", PkwTokens.Type.caption, Modifier.weight(1f), color = c.textOnParch)
                // heroes-theodor.html: "back in 1h 20m" / "full" is t-ink.
                PkwText(healthLine, PkwTokens.Type.small, color = c.textOnParch)
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ParchMeter(ui.health.fraction, "Health $healthLine", Modifier.weight(1f), height = 14.dp)
                ui.finishRest?.let { FinishRestButton(it, extras.finishChecking, on) }
            }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                PkwText("NEXT LEVEL", PkwTokens.Type.caption, Modifier.weight(1f), color = c.textOnParch)
                PkwText(if (ui.loading) UNKNOWN else nextLevelLabel(ui.level, ui.maxLevel), PkwTokens.Type.caption, color = ArmyInk.gain)
            }
            ui.stats.forEach { StatDeltaRow(it, keyWidth = 84.dp) }
            extras.roleLine?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2) }
        }
    }
    SectionLine("SKILLS", skillSummary(ui.skills))
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.skills.forEach { HeroSkillTile(it, on) }
        }
        ChunkyBox(c.stone, on.onAllSkills, "All skills", Modifier.size(48.dp, 76.dp)) {
            PkwIcon("shape:go", 24.dp, tint = c.label)
        }
    }
    SectionLine("GEAR", gearSummary(ui.gear.worn, ui.gear.slots.size))
    GearRow(ui, on)
    nextSkillLine(ui.nextSkill?.takeIf { !ui.loading }, ui.level, ui.maxLevel)?.let { line ->
        val skill = ui.nextSkill ?: return@let
        ArmyCard(Modifier.fillMaxWidth().heightIn(min = 64.dp), body = c.selectedTint, rim = c.gold.lo, rimWidth = 2.dp, padding = PaddingValues(8.dp),
            description = "Next skill at level ${skill.unlockLevel}: $line") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(48.dp).background(c.ink).padding(2.dp).background(ArmyInk.well), contentAlignment = Alignment.Center) { PkwIcon(skill.icon, 32.dp) }
                Column(Modifier.weight(1f)) {
                    PkwText("NEXT SKILL AT LV ${skill.unlockLevel}", PkwTokens.Type.caption, color = c.textOnParch)
                    PkwText(line, PkwTokens.Type.body, color = c.textOnParch)
                }
            }
        }
    }
}

/** FINISH 104 × 56 with its price inside: PS 11 "FINISH" over gem 20 + the price; stone dots "Finishing" while busy; off
 *  when the price is unavailable; SHORT opens Need-more; CHECKING stays enabled (the Gems Seal re-quotes). A price only
 *  the review knows (A5: no pill, sub "Price shown in review") is drawn as CHECKING, "…" without a currency, and the tap
 *  is the same navigation into the review. A lost answer reads "CHECK" (the recovery action). */
@Composable private fun FinishRestButton(cmd: CommandUi, checking: Boolean, on: HeroesActions) {
    val c = PkwTokens.Colors
    val state = effectiveState(cmd)
    val verb = when (state) { CommandState.DISABLED -> Verb.OFF; CommandState.BUSY -> Verb.STONE; CommandState.LOCKED -> Verb.CHARCOAL; else -> Verb.GREEN }
    val price = cmd.price
    val label = if (checking) "CHECK" else cmd.caption.ifBlank { "FINISH" }
    val spoken = listOfNotNull(label, price?.let(::priceDescription), cmd.sub,
        cmd.reason?.takeIf { state == CommandState.DISABLED || state == CommandState.LOCKED }).joinToString(". ")
    ChunkyBox(PkwTokens.ramp(verb), { routeCommand(cmd, on.onFinishRest, on.onNeedMore, on.onRefused) }, spoken, Modifier.size(104.dp, 56.dp),
        enabled = state != CommandState.BUSY) {
        if (state == CommandState.BUSY) Column(horizontalAlignment = Alignment.CenterHorizontally) {
            BusyDots(); PkwText("Finishing", PkwTokens.Type.small, color = c.text)
        } else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText(label, PkwTokens.Type.caption, color = c.label, outline = 1.dp)
            if (price != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                PkwIcon(currencyIcon(price.currency, price.icon), 20.dp)
                PkwText(priceText(price), PkwTokens.Type.caption, color = if (price.status == PriceStatus.SHORT) c.shortPill else c.label, outline = 1.dp)
            } else PkwText(UNKNOWN, PkwTokens.Type.caption, color = c.label, outline = 1.dp)
        }
    }
}

/** A skill tile (56 × 84): icon 32 + "ready" or "Lv 5"; locked tiles on the locked body with the icon grey at 55 %
 *  brightness (heroes.html `.sk.lock`). A tap opens SkillInfo. */
@Composable private fun HeroSkillTile(s: SkillUi, on: HeroesActions) {
    val level = skillLevelText(s.unlockLevel)
    ArmyCard(Modifier.size(56.dp, 84.dp), body = if (s.unlocked) null else ArmyInk.lockedBody, padding = PaddingValues(2.dp),
        onClick = { on.onSkill(s.id) }, description = "${s.name}, ${if (s.unlocked) "ready" else "opens at level $level"}") {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            PkwIcon(s.icon, 32.dp, Modifier.toned(if (s.unlocked) 1f else 0f, if (s.unlocked) 1f else 0.55f))
            PkwText(if (s.unlocked) "ready" else "Lv $level", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch)
        }
    }
}

/** The gear row's wells (heroes-theodor.html `.crow .well`): worn `#F6E6BD`, empty `#F4E3BC` with a dashed ink rim. */
private val GearWell = Color(0xFFF6E6BD)

/** The gear summary (64): the first four slots in 36 dp wells 2 dp apart (an empty one dashed), "Wear 9 to awaken" + the
 *  10 dp gold meter, blue GO 58 × 44 to the GEAR tab. */
@Composable private fun GearRow(ui: HeroesUi, on: HeroesActions) {
    val c = PkwTokens.Colors
    val meter = awakenMeter(ui.gear.worn, ui.gear.slots.size, ui.gear.awakenAt)
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 64.dp), padding = PaddingValues(start = 4.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                ui.gear.slots.take(4).forEach { slot ->
                    val item = slot.item
                    if (item != null && slot.state == GearSlotState.WORN) {
                        Box(Modifier.size(36.dp).background(c.ink).padding(2.dp).background(GearWell), contentAlignment = Alignment.Center) {
                            PkwIcon(item, 32.dp)
                        }
                    } else Box(Modifier.size(36.dp).clearAndSetSemantics { }.background(c.parchment).drawBehind {
                        val w = 2.dp.toPx()
                        drawRect(c.ink, topLeft = Offset(w / 2, w / 2), size = Size(size.width - w, size.height - w),
                            style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
                    })
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                val line = ui.gear.awakenSummary.ifBlank { ui.gear.awakenLine.ifBlank { gearSummary(ui.gear.worn, ui.gear.slots.size) } }
                PkwText(line, PkwTokens.Type.small, color = c.textOnParch)
                ParchMeter(meter.fill, gearSummary(ui.gear.worn, ui.gear.slots.size), verb = Verb.GOLD)
            }
            GoButton(on.onGearGo, "Open gear", Modifier.width(58.dp))
        }
    }
}

// ---- Previews ----

internal object TheodorSamples {
    private val skills = listOf(
        SkillUi("cheekquake", "ui_skill_cheekquake", "Cheekquake", 1, true, false),
        SkillUi("snotrocket", "ui_skill_snotrocket", "Snot Rocket", 1, true, false),
        SkillUi("cannonball", "ui_skill_cannonball", "Cannonball", 5, false, false),
        SkillUi("skillissue", "ui_skill_skillissue", "Skill Issue", 8, false, false),
        SkillUi("bellybounce", "ui_skill_bellybounce", "Belly Bounce", 11, false, false),
        SkillUi("brownnote", "ui_skill_brownnote", "Brown Note", 14, false, true),
        SkillUi("ragequit", "ui_skill_ragequit", "Rage Quit", 17, false, true),
        SkillUi("silentbutdeadly", "ui_skill_silentbutdeadly", "Silent but Deadly", 20, false, true),
    )
    val theodor = HeroSamples.hero.copy(
        hero = "theodor", level = 4, body = "hero_theo_idle_f1", portrait = "hero_theo_portrait",
        header = HeroSamples.hero.header.copy(title = "THEODOR", levelTag = "LV 4", chip = HeaderChipUi("timer", "Resting", "1h 20m"),
            switchTo = HeroSwitchUi("vex", "hero_vex_portrait", "VEX", locked = false, description = "Switch to Vex")),
        health = HealthUi(0.58f, 4_800),
        stats = listOf(StatDeltaUi("Hitpoints", "5,365", "5,821"), StatDeltaUi("Damage/s", "43", "45")),
        skills = skills, nextSkill = skills[2],
        finishRest = CommandUi(FeatureId("siegestool.finishRest"), "", "FINISH", ArmySamples.gems("18"), false, CommandState.ENABLED, null, null, verb = Verb.GREEN),
        footer = FooterUi(listOf("takes 4h"), listOf(ArmySamples.gems("260")), ArmySamples.cmd("siegestool.upgrade", "UPGRADE", Verb.GREEN, sub = "Theodor to Lv 5")),
    )
    val extras = HeroTabExtrasUi(roleLine = "Pulls guns within 6 tiles")
}

@Composable private fun HeroV2PreviewFrame(ui: HeroesUi, extras: HeroTabExtrasUi) {
    SheetPreviewFrame(ArmySheetKind.HEROES) { m ->
        ArmyTallSheet(ui.header, heroTabs(ui.portrait, ui.skills.firstOrNull()?.icon ?: "ui_skill_rally", false), HERO_TAB_HERO, {}, {}, {}, m,
            headerTrailing = { ui.header.switchTo?.let { HeroSwitchButton(it) {} } },
            footer = { ArmyFooter(ui.footer, {}, {}, {}) }) { HeroTabV2(ui, extras, HeroesActions()) }
    }
}

@Preview(name = "Heroes V2: Theodor resting (heroes-theodor.png)", widthDp = 412, heightDp = 915)
@Composable private fun TheodorPreview() = HeroV2PreviewFrame(TheodorSamples.theodor, TheodorSamples.extras)

@Preview(name = "Heroes V2: rested, finishing (busy), being checked + as of, price short", widthDp = 1648, heightDp = 915)
@Composable private fun TheodorStatesPreview() {
    val t = TheodorSamples.theodor
    val fin = t.finishRest!!
    Row {
        Box(Modifier.width(412.dp).fillMaxSize()) { HeroV2PreviewFrame(t.copy(health = HealthUi(1f, null), finishRest = null,
            header = t.header.copy(chip = HeaderChipUi(null, "Ready", null, DotColor.GREEN))), TheodorSamples.extras) }
        Box(Modifier.width(412.dp).fillMaxSize()) { HeroV2PreviewFrame(t.copy(finishRest = fin.copy(state = CommandState.BUSY)), TheodorSamples.extras) }
        Box(Modifier.width(412.dp).fillMaxSize()) { HeroV2PreviewFrame(t.copy(header = t.header.copy(chip = HeaderChipUi("timer", "Being checked", null))),
            TheodorSamples.extras.copy(finishChecking = true, restAsOf = "14:20")) }
        Box(Modifier.width(412.dp).fillMaxSize()) { HeroV2PreviewFrame(t.copy(finishRest = fin.copy(price = ArmySamples.gems("18", PriceStatus.SHORT))),
            TheodorSamples.extras) }
    }
}

@Preview(name = "Heroes V2: loading (stats …)", widthDp = 412, heightDp = 915)
@Composable private fun TheodorLoadingPreview() {
    val t = TheodorSamples.theodor
    HeroV2PreviewFrame(t.copy(loading = true, stats = t.stats.map { StatDeltaUi(it.label, UNKNOWN, null) }, health = HealthUi(null, null),
        finishRest = t.finishRest?.copy(price = ArmySamples.gems(null, PriceStatus.CHECKING))), TheodorSamples.extras)
}
