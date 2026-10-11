package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.ItemTile
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Heroes (design/final/army/SPEC.md §5; heroes.png, heroes-gear.png): one hero per sheet, tabs HERO ·
 * SKILLS · GEAR, the hero switch at the header's bottom-right. HERO: the re-done `HeroTabV2` (E1.2: the body showcase,
 * health with FINISH while resting, next-level stats, the skill strip ending in the SKILLS chevron, the gear summary with
 * GO and the next-skill row); primary green UPGRADE (Seal when the server price is Gems / KEEP / SOL). SKILLS: the skill
 * list (the designed tab with its tier track is `HeroSkillsTab`). GEAR: the paper doll (8 side slots + weapon and
 * offhand), the awaken meter, the bag strip filtered to the selected slot with the compare block; primary gold EQUIP or
 * stone UNEQUIP.
 */

/** Health (SPEC §5 `HealthUi`). */
@Immutable data class HealthUi(
    /** 0..1 health; null = unknown (empty meter, "…"). */
    val fraction: Float?,
    /** Seconds until rested; null when full. */
    val remainingSec: Long?,
)

/** One skill (SPEC §5 `SkillUi`). */
@Immutable data class SkillUi(
    val id: String,
    /** 32 px icon (`ui_skill_<name>`). */
    val icon: String,
    val name: String,
    /** The level it opens at. */
    val unlockLevel: Int,
    val unlocked: Boolean,
    /** "once per battle" (blue tag). */
    val oncePerBattle: Boolean,
    /** The catalogue's one-line effect (SKILLS tab). */
    val effect: String = "",
)

/** A gear slot's look (SPEC §5 `GearSlot` table). */
enum class GearSlotState { WORN, EMPTY, LOCKED }

/** One paper-doll slot. Selection is [GearUi.selectedSlot]. */
@Immutable data class GearSlotUi(
    /** Slot id in `GEAR_SLOTS` order ("helm", "amulet", "chest", "cloak", "gloves", "ring", "boots", "banner", "weapon",
     *  "offhand"). */
    val slot: String,
    /** VT caption ("Cloak"). */
    val label: String,
    /** The worn item's 32 px icon; null when empty. */
    val item: String?,
    /** Worn, empty or locked. */
    val state: GearSlotState,
    /** The slot's own icon, drawn greyed when empty (`itm_cloak`). */
    val slotIcon: String,
    /** LOCKED: why the slot is not open yet. */
    val lockReason: String? = null,
)

/** One compare line (VT 18 "Hero HP +4%"), toned against what is worn. */
@Immutable data class CompareLineUi(val label: String, val delta: String, val tone: DeltaTone)

/** The selected bag item compared to the worn one (SPEC §5 `ItemCompareUi`). */
@Immutable data class ItemCompareUi(
    val id: String,
    /** VT 20 name ("Rare cloak"). */
    val name: String,
    val lines: List<CompareLineUi>,
    /** True when the selected item is the one worn: the primary becomes stone UNEQUIP. */
    val worn: Boolean,
)

/** The GEAR tab (SPEC §5 `GearUi`). */
@Immutable data class GearUi(
    /** Slots in `GEAR_SLOTS` order (see [paperDoll]). */
    val slots: List<GearSlotUi>,
    /** Worn count. */
    val worn: Int,
    /** The awaken threshold. */
    val awakenAt: Int,
    /** The selected slot id; the bag is filtered to it. */
    val selectedSlot: String?,
    /** Bag items that fit the selected slot. */
    val bag: List<ItemTileUi>,
    /** The selected bag item's compare block; null shows none. */
    val selectedItem: ItemCompareUi?,
    /** Bag empty for this slot: "No cloaks yet" + "Dropped by the Gold Forge" + GO. */
    val bagEmpty: EmptyStateUi? = null,
    /** The existing native line when the equipment rollout is off: "Equipment saved · combat rollout off". */
    val rolloutNote: String? = null,
    /** "Wear 9 to awaken Vex". */
    val awakenLine: String = "",
    /** The selected slot's name for "FITS THE CLOAK". */
    val slotTitle: String = "",
    /** The HERO tab's gear row line, without the hero's name ("Wear 9 to awaken", heroes.png); blank uses [awakenLine]. */
    val awakenSummary: String = "",
)

/** Everything the Heroes sheet draws (SPEC §5 `HeroesUi`). */
@Immutable data class HeroesUi(
    /** Hero id ("vex"). */
    val hero: String,
    /** Header: hero name + "LV 9", chip "Ready" (green dot) or timer "Resting 1h 20m", [SheetHeaderUi.switchTo]. */
    val header: SheetHeaderUi,
    /** HERO, SKILLS or GEAR. */
    val tab: String,
    val level: Int,
    val maxLevel: Int,
    val health: HealthUi,
    /** Next-level stats (Hitpoints, Damage/s, Skill dmg, Speed); unchanged ones have next = null. */
    val stats: List<StatDeltaUi>,
    val skills: List<SkillUi>,
    /** The next skill to open; null at max. */
    val nextSkill: SkillUi?,
    val gear: GearUi,
    /** The current tab's footer: UPGRADE (HERO / SKILLS: price + "takes 6h", green "UPGRADE" "Vex to Lv 10"; LOCKED
     *  "Upgrading · 5h 12m" while upgrading), EQUIP / UNEQUIP (GEAR), RECRUIT (not recruited). */
    val footer: FooterUi,
    /** The 40 × 48 / 48 × 52 body art ("hero_vex_idle_f1"). */
    val body: String = "hero_vex_idle_f1",
    /** The 48 px portrait (tabs, empty state). */
    val portrait: String = "hero_vex_portrait",
    /** FINISH rest (Gems Seal): shown only while resting, beside the health meter. */
    val finishRest: CommandUi? = null,
    /** Not recruited: this EmptyState replaces the HERO tab ("Recruit Vex at the Hero Altar"); the footer is RECRUIT. */
    val recruit: EmptyStateUi? = null,
    /** True while a new gear item is in the bag (GEAR tab NEW badge). */
    val gearNew: Boolean = false,
    /** Loading: the panel keeps the last good view; with no stats yet, figures read "…". */
    val loading: Boolean = false,
)

/** Heroes callbacks (SPEC §1.2 + §5). */
@Immutable data class HeroesActions(
    val onClose: () -> Unit = {},
    val onHistory: () -> Unit = {},
    val onTab: (String) -> Unit = {},
    val onResourceRow: (FeatureId) -> Unit = {},
    /** The header switch: swaps the sheet to the other hero (cross-fade 160 ms). */
    val onSwitchHero: () -> Unit = {},
    /** UPGRADE: the Seal when the price is Gems / KEEP / SOL, otherwise a direct commit. */
    val onUpgrade: () -> Unit = {},
    val onSkill: (String) -> Unit = {},
    /** ALL: the SKILLS tab. */
    val onAllSkills: () -> Unit = {},
    /** The gear row's GO: the GEAR tab. */
    val onGearGo: () -> Unit = {},
    /** A slot: selects it and filters the bag. */
    val onSlot: (String) -> Unit = {},
    val onBagItem: (String) -> Unit = {},
    val onEquip: () -> Unit = {},
    val onUnequip: () -> Unit = {},
    /** FINISH rest: the Gems Seal. */
    val onFinishRest: () -> Unit = {},
    /** RECRUIT (existing recruit flow). */
    val onRecruit: () -> Unit = {},
    /** An EmptyState GO (bag empty → Gold Forge). */
    val onGo: (FeatureId) -> Unit = {},
    val onNeedMore: (PriceUi) -> Unit = {},
    val onRefused: (CommandUi) -> Unit = {},
)

/**
 * The Heroes sheet (heroes.png / heroes-gear.png). [modifier] must give it a bounded height.
 *
 * Pointer rule: a painted panel inside the SheetHost; no full-screen clickable, pointerInput, scrim or draggable here.
 */
@Composable fun HeroesSheet(ui: HeroesUi, on: HeroesActions, modifier: Modifier = Modifier) {
    val tabs = heroTabs(ui.portrait, ui.skills.firstOrNull()?.icon ?: "ui_skill_rally", ui.gearNew)
    val onPrimary: () -> Unit = when {
        ui.recruit != null -> on.onRecruit
        ui.tab == HERO_TAB_GEAR -> if (ui.gear.selectedItem?.worn == true) on.onUnequip else on.onEquip
        else -> on.onUpgrade
    }
    val switchTo = ui.header.switchTo
    ArmyTallSheet(ui.header, tabs, ui.tab, on.onClose, on.onHistory, on.onTab, modifier,
        headerTrailing = if (switchTo != null) ({ HeroSwitchButton(switchTo, on.onSwitchHero) }) else null,
        // heroes.html / heroes-gear.html: the info lines ("takes 6h", "Fills the empty / Cloak slot.") are t-ink.
        footer = { ArmyFooter(ui.footer, onPrimary, on.onNeedMore, on.onRefused, infoWidth = if (ui.tab == HERO_TAB_GEAR) 150.dp else 132.dp,
            infoColor = PkwTokens.Colors.textOnParch) }) {
        when {
            ui.recruit != null -> EmptyState(ui.recruit, on.onGo)
            ui.tab == HERO_TAB_SKILLS -> SkillsTab(ui, on)
            ui.tab == HERO_TAB_GEAR -> GearTab(ui, on)
            // E1.2 replaced the round 1 HERO tab for both heroes (no blue ALL tile; the strip ends in the SKILLS chevron).
            else -> HeroTabV2(ui, HeroTabExtrasUi(), on)
        }
    }
}

// --- SKILLS tab -------------------------------------------------------------------------------------------------------

/** The SKILLS list when no verified tier is known (the designed tab is `HeroSkillsTab`, which needs one): the E1.1 rows
 *  without the tier track. A row is 66 tall: dark well 52, PS 12 name, the effect, and the right column 104 with green
 *  READY or stone "LV 11" over "once a battle". Locked rows are cream-lo with the icon grey at 55 % brightness. */
@Composable private fun ColumnScope.SkillsTab(ui: HeroesUi, on: HeroesActions) {
    val c = PkwTokens.Colors
    SectionLine("SKILLS", skillSummary(ui.skills))
    ui.skills.forEach { s ->
        val cool = cooldownLine(s.oncePerBattle, null)
        ArmyCard(Modifier.fillMaxWidth().heightIn(min = 66.dp), body = if (s.unlocked) null else c.creamLo,
            padding = PaddingValues(start = 6.dp, top = 4.dp, end = 8.dp, bottom = 6.dp), onClick = { on.onSkill(s.id) },
            description = listOf(s.name, s.effect, if (s.unlocked) "ready" else "opens at level ${skillLevelText(s.unlockLevel)}", cool)
                .filter { it.isNotBlank() }.joinToString(". ")) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(52.dp).background(c.ink).padding(2.dp).background(ArmyInk.well), contentAlignment = Alignment.Center) {
                    PkwIcon(s.icon, 32.dp, Modifier.toned(if (s.unlocked) 1f else 0f, if (s.unlocked) 1f else 0.55f))
                }
                Column(Modifier.weight(1f)) {
                    PkwText(s.name.uppercase(), PkwTokens.Type.label, color = c.textOnParch)
                    if (s.effect.isNotBlank()) PkwText(s.effect, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                }
                Column(Modifier.width(104.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (s.unlocked) Tag("READY", Verb.GREEN) else Tag("LV ${skillLevelText(s.unlockLevel)}", Verb.STONE)
                    if (cool.isNotBlank()) PkwText(cool, PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
    }
}

/** A skill's unlock level as drawn: the catalogue's level, or "…" when it gave none (never "Lv 0"). */
internal fun skillLevelText(unlockLevel: Int): String = if (unlockLevel > 0) unlockLevel.toString() else UNKNOWN

// --- GEAR tab ---------------------------------------------------------------------------------------------------------

@Composable private fun ColumnScope.GearTab(ui: HeroesUi, on: HeroesActions) {
    val c = PkwTokens.Colors
    val doll = paperDoll(ui.gear.slots)
    val meter = awakenMeter(ui.gear.worn, ui.gear.slots.size, ui.gear.awakenAt)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { doll.left.forEach { GearSlotCell(it, ui.gear.selectedSlot == it.slot, on) } }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // The paper doll: the body at 4 dp per art px (k = 8 on the DPR-2 mock), standing 18 dp above the well's floor.
            Box(Modifier.fillMaxWidth().height(250.dp).background(c.ink).padding(2.dp).background(ArmyInk.heroWell), contentAlignment = Alignment.BottomCenter) {
                PkwIcon(ui.body, heroBodyBox(ui.hero, paperDoll = true), Modifier.padding(bottom = 18.dp))
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(if (ui.gear.slots.isEmpty()) UNKNOWN else "${ui.gear.worn}/${ui.gear.slots.size}", PkwTokens.Type.caption, color = c.textOnParch)
                if (ui.gear.slots.isNotEmpty()) AwakenBar(meter, Modifier.weight(1f))
            }
            if (ui.gear.awakenLine.isNotBlank()) {
                PkwText(ui.gear.awakenLine, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch, textAlign = TextAlign.Center)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { doll.right.forEach { GearSlotCell(it, ui.gear.selectedSlot == it.slot, on) } }
    }
    if (doll.bottom.isNotEmpty()) {
        // heroes-gear.html: Weapon and Offhand centred, 88 dp apart.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(88.dp, Alignment.CenterHorizontally)) {
            doll.bottom.forEach { GearSlotCell(it, ui.gear.selectedSlot == it.slot, on) }
        }
    }
    ui.gear.rolloutNote?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center) }
    SectionLine(if (ui.gear.slotTitle.isBlank()) "FROM YOUR BAG" else "FITS THE ${ui.gear.slotTitle.uppercase()}",
        if (ui.gear.slotTitle.isBlank()) null else "from your bag")
    val empty = ui.gear.bagEmpty
    if (empty != null && ui.gear.bag.isEmpty()) EmptyState(empty, on.onGo)
    else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()).padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.gear.bag.forEach { ItemTile(it, on.onBagItem) }
        }
        ui.gear.selectedItem?.let { item ->
            Column(Modifier.weight(1f).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(item.name, PkwTokens.Type.body, color = c.textOnParch)
                item.lines.forEach { line ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText(line.label, PkwTokens.Type.small, color = c.textOnParch)
                        ToneText(line.delta, line.tone)
                    }
                }
            }
        }
    }
}

/** A GearSlot (60 × 60) with its VT 18 caption: worn = cream + icon; empty = a flat square `#EAD8A6` with a 2 dp parch-dk
 *  rim and the slot icon grey at 28 %; selected = gold-lo shell, gold rim on the selected tint and a t-ink caption; locked =
 *  padlock (a tap still calls back so the host can say why). */
@Composable private fun GearSlotCell(s: GearSlotUi, selected: Boolean, on: HeroesActions) {
    val c = PkwTokens.Colors
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        ArmyCard(Modifier.size(60.dp).goldLoCardShell(selected),
            body = when { selected -> c.selectedTint; s.state == GearSlotState.WORN -> null; else -> ArmyInk.slotEmpty },
            rim = if (selected) c.gold.face else null, padding = PaddingValues(0.dp), onClick = { on.onSlot(s.slot) }, selected = selected,
            description = listOfNotNull(s.label, when (s.state) { GearSlotState.WORN -> "worn"; GearSlotState.EMPTY -> "empty"; GearSlotState.LOCKED -> s.lockReason ?: "locked" },
                if (selected) "selected" else null).joinToString(", ")) {
            // heroes-gear.html `.slot.empty`: square and flat over the whole cell (no ink plate), unless selected.
            val flat = s.state == GearSlotState.EMPTY && !selected
            Box(Modifier.fillMaxSize().then(if (flat) Modifier.background(ArmyInk.slotEmpty).border(2.dp, ArmyInk.parchDk) else Modifier),
                contentAlignment = Alignment.Center) {
                when (s.state) {
                    GearSlotState.WORN -> PkwIcon(s.item ?: s.slotIcon, 32.dp)
                    GearSlotState.EMPTY -> PkwIcon(s.slotIcon, 32.dp, Modifier.toned(0f), alpha = 0.28f)
                    GearSlotState.LOCKED -> PkwIcon("shape:lock", 24.dp, tint = c.textOnParch2)
                }
            }
        }
        PkwText(s.label, PkwTokens.Type.small, Modifier.clearAndSetSemantics { }, color = if (selected) c.textOnParch else c.textOnParch2)
    }
}

/** The hero body's square box at the frames' scales (the art fits it): Vex's 40 × 48 at 3 dp per art px on the HERO tab
 *  (120 × 144) and 4 on the paper doll (160 × 192); Theodor's 48 × 52 at 2.5 (120 × 130, E1.2) and 4 (192 × 208). */
internal fun heroBodyBox(hero: String, paperDoll: Boolean): Dp = when {
    hero == "theodor" -> if (paperDoll) 208.dp else 130.dp
    else -> if (paperDoll) 192.dp else 144.dp
}

/** The 12 dp gold awaken meter with the 2 dp ink tick at the threshold. */
@Composable private fun AwakenBar(meter: AwakenMeter, modifier: Modifier) {
    BoxWithConstraints(modifier) {
        ParchMeter(meter.fill, "Awaken meter", height = 12.dp, verb = Verb.GOLD)
        meter.tick?.let { tick ->
            Box(Modifier.offset(x = maxWidth * tick - 1.dp).size(2.dp, 12.dp).background(PkwTokens.Colors.ink).clearAndSetSemantics { contentDescription = "Awaken mark" })
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------------------------------

internal object HeroSamples {
    private val skills = listOf(
        SkillUi("crimsondash", "ui_skill_crimsondash", "Crimson Dash", 1, true, false, "Dashes through walls."),
        SkillUi("moonwave", "ui_skill_moonwave", "Moonwave", 5, true, true, "A wave that pushes troops back."),
        SkillUi("degenmode", "ui_skill_degenmode", "Degen Awakening", 11, false, false, "Doubles attack speed for a while."),
        SkillUi("doubleornothing", "ui_skill_doubleornothing", "Double or Nothing", 16, false, false, "A coin-flip strike."),
        SkillUi("shardstorm", "ui_skill_shardstorm", "Shardstorm", 20, false, true, "Rains shards on an area."),
    )
    private fun slot(id: String, label: String, worn: Boolean, state: GearSlotState? = null) =
        GearSlotUi(id, label, if (worn) "itm_$id" else null, state ?: if (worn) GearSlotState.WORN else GearSlotState.EMPTY, "itm_$id")
    private val gear = GearUi(
        slots = listOf(slot("helm", "Helm", true), slot("amulet", "Amulet", true), slot("chest", "Chest", true), slot("cloak", "Cloak", false),
            slot("gloves", "Gloves", true), slot("ring", "Ring", false, GearSlotState.LOCKED), slot("boots", "Boots", true),
            slot("banner", "Banner", false), GearSlotUi("weapon", "Weapon", "itm_hammer", GearSlotState.WORN, "itm_hammer"),
            GearSlotUi("offhand", "Offhand", "itm_shield", GearSlotState.WORN, "itm_shield")),
        worn = 7, awakenAt = 9, selectedSlot = "cloak",
        bag = listOf(ItemTileUi("cloak-rare", "itm_cloak", "rare", "Rare cloak, new", ItemTileState.SELECTED, isNew = true),
            ItemTileUi("cloak-common", "itm_cloak", "x2", "Common cloak, 2")),
        selectedItem = ItemCompareUi("cloak-rare", "Rare cloak", listOf(CompareLineUi("Hero HP", "+4%", DeltaTone.GAIN),
            CompareLineUi("First hit", "-6%", DeltaTone.LOSS)), worn = false),
        awakenLine = "Wear 9 to awaken Vex", slotTitle = "Cloak", awakenSummary = "Wear 9 to awaken",
    )
    val hero = HeroesUi(
        hero = "vex",
        header = SheetHeaderUi("VEX", "LV 9", HeaderChipUi(null, "Ready", null, DotColor.GREEN),
            HeaderArtUi(null, 1, listOf(WalkerUi(SpriteRef("hero_vex_idle_f1", 48), Dir8.S, 113, 40, 3)),
                buildingScale = 3, buildingXDp = 176, buildingYDp = 20),
            switchTo = HeroSwitchUi("theodor", "hero_theo_portrait", "THEO", locked = false, description = "Switch to Theodor")),
        tab = HERO_TAB_HERO, level = 9, maxLevel = 30, health = HealthUi(1f, null),
        stats = listOf(StatDeltaUi("Hitpoints", "2,340", "2,520"), StatDeltaUi("Damage/s", "180", "196"), StatDeltaUi("Skill dmg", "+12%", "14%"),
            StatDeltaUi("Speed", "1.6 tiles/s", null)),
        skills = skills, nextSkill = skills[2], gear = gear,
        footer = FooterUi(listOf("takes 6h"), listOf(ArmySamples.gems("420")), ArmySamples.cmd("heroaltar.upgrade", "UPGRADE", Verb.GREEN, sub = "Vex to Lv 10")),
        gearNew = true,
    )
    val gearTab = hero.copy(tab = HERO_TAB_GEAR, gearNew = false,
        footer = FooterUi(listOf("Fills the empty", "Cloak slot."), emptyList(), ArmySamples.cmd("heroaltar.equip", "EQUIP", Verb.GOLD)))
}

@Preview(name = "Heroes: Vex, HERO tab (heroes.png)", widthDp = 412, heightDp = 915)
@Composable private fun HeroesHeroPreview() {
    SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(HeroSamples.hero, HeroesActions(), it) }
}

@Preview(name = "Heroes: GEAR tab, empty Cloak selected (heroes-gear.png)", widthDp = 412, heightDp = 915)
@Composable private fun HeroesGearPreview() {
    SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(HeroSamples.gearTab, HeroesActions(), it) }
}

@Preview(name = "Heroes: SKILLS tab", widthDp = 412, heightDp = 915)
@Composable private fun HeroesSkillsPreview() {
    SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(HeroSamples.hero.copy(tab = HERO_TAB_SKILLS), HeroesActions(), it) }
}

@Preview(name = "Heroes: resting (FINISH) and upgrading (locked primary)", widthDp = 824, heightDp = 915)
@Composable private fun HeroesRestingPreview() {
    val resting = HeroSamples.hero.copy(health = HealthUi(0.35f, 4_800),
        header = HeroSamples.hero.header.copy(chip = HeaderChipUi("timer", "Resting", "1h 20m")),
        finishRest = CommandUi(FeatureId("heroaltar.finishRest"), "", "FINISH", ArmySamples.gems("12"), false, CommandState.ENABLED, null, null, verb = Verb.GREEN))
    val upgrading = HeroSamples.hero.copy(footer = HeroSamples.hero.footer.copy(
        primary = ArmySamples.cmd("heroaltar.upgrade", "UPGRADE", Verb.GREEN, CommandState.LOCKED, reason = "Upgrading · 5h 12m")))
    Row(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(resting, HeroesActions(), it) } }
        Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(upgrading, HeroesActions(), it) } }
    }
}

@Preview(name = "Heroes: not recruited, bag empty + rollout off", widthDp = 824, heightDp = 915)
@Composable private fun HeroesEmptyPreview() {
    val notRecruited = HeroSamples.hero.copy(
        header = HeroSamples.hero.header.copy(levelTag = null, chip = HeaderChipUi(null, "Not recruited", null), switchTo = null),
        recruit = EmptyStateUi("hero_vex_portrait", "Recruit Vex at the Hero Altar", "Vex joins every raid once recruited.", null, null),
        footer = FooterUi(emptyList(), listOf(ArmySamples.gems(null, gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.CHECKING)),
            ArmySamples.cmd("heroaltar.recruit", "RECRUIT", Verb.GOLD)))
    val bagEmpty = HeroSamples.gearTab.copy(gear = HeroSamples.gearTab.gear.copy(bag = emptyList(), selectedItem = null,
        bagEmpty = EmptyStateUi("itm_cloak", "No cloaks yet", "Dropped by the Gold Forge", "GO TO GOLD FORGE", FeatureId("goldforge.forge")),
        rolloutNote = "Equipment saved · combat rollout off"),
        footer = FooterUi(listOf("Pick a cloak", "from your bag."), emptyList(),
            ArmySamples.cmd("heroaltar.equip", "EQUIP", Verb.GOLD, CommandState.DISABLED, reason = "No cloak in your bag")))
    Row(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(notRecruited, HeroesActions(), it) } }
        Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(bagEmpty, HeroesActions(), it) } }
    }
}

@Preview(name = "Heroes: loading keeps the frame, figures read …", widthDp = 412, heightDp = 915)
@Composable private fun HeroesLoadingPreview() {
    val ui = HeroSamples.hero.copy(loading = true, health = HealthUi(null, null),
        stats = HeroSamples.hero.stats.map { StatDeltaUi(it.label, UNKNOWN, null) },
        footer = FooterUi(listOf(UNKNOWN), listOf(ArmySamples.gems(null, gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.CHECKING)),
            ArmySamples.cmd("heroaltar.upgrade", "UPGRADE", Verb.GREEN, sub = "checking price")))
    SheetPreviewFrame(ArmySheetKind.HEROES) { HeroesSheet(ui, HeroesActions(), it) }
}

@Preview(name = "Gear slot strip", widthDp = 300, heightDp = 120)
@Composable private fun GearSlotPreview() {
    Row(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        HeroSamples.hero.gear.slots.take(4).forEach { GearSlotCell(it, it.slot == "cloak", HeroesActions()) }
        Spacer(Modifier.width(1.dp))
    }
}
