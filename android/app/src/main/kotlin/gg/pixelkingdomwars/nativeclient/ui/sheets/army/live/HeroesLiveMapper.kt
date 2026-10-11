package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.roster.rosterHeroPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.Dir8
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.DotColor
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.FooterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_GEAR
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_HERO
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeaderArtUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeaderChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HealthUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroSwitchUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroTabExtrasUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroesUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SheetHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SkillUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SpriteRef
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.StatDeltaUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.WalkerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.armyDuration
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Live mapper of the Hero Altar sheet (HERO and SKILLS tabs): `RosterUiState` (what HeroesScreen receives today) -> the
 * Opus `HeroesUi` + `HeroTabExtrasUi`. Upgrading a hero and finishing its rest are KEEP / Gems spends: their commands
 * carry no price (the currency is decided by the existing server review) and their tap opens that review on the
 * current screen. GEAR uses the same current inventory/loadout and free versioned save as InventoryEquipment.
 */

/** The hero on the other side of the header switch. */
internal fun otherHero(hero: String): String = if (hero == "theodor") "vex" else "theodor"

/** "VEX" / "THEO": the switch's short name. */
internal fun heroShortName(hero: String, name: String?): String = if (hero == "theodor") "THEO" else (name ?: hero).uppercase()

/** The hero's 48 px body art for the showcase and the living header. */
internal fun heroBody(hero: String): String = if (hero == "theodor") "hero_theo_idle_f1" else "hero_vex_idle_f1"

/** Why hero spends are closed right now, in HeroesScreen's words; null while they are open. */
internal fun heroBlockedReason(state: RosterUiState): String? = when {
    state.heroesBlocked -> "A saved hero payment is still being checked. Open History to see it."
    state.domain.heroes?.heroConsentSupported == false -> "Hero upgrades and paid recovery need a server update."
    !state.ordersAllowed -> ordersBlockedReason(false, true)
    else -> null
}

/** A plain non-negative integer price text the server sent (HeroesScreen's `rosterKeepPrice`); null otherwise. */
private fun serverPrice(value: String?): String? = value?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }

/** The UPGRADE / RECRUIT / MAX primary of the HERO and SKILLS tabs. */
internal fun heroPrimary(state: RosterUiState, h: Hero?, busy: Boolean): FooterUi {
    if (h == null) return FooterUi(emptyList(), emptyList(),
        liveCommand(ArmyLiveIds.HERO_UPGRADE, "UPGRADE", CommandState.DISABLED, "Heroes are still loading.", verb = Verb.GREEN))
    if (!h.recruited) return FooterUi(listOf("Recruit at the ${heroHome(h)}"), emptyList(),
        liveCommand(ArmyLiveIds.HERO_RECRUIT, "RECRUIT", CommandState.ENABLED, sub = "Place the ${heroHome(h)}"))
    val next = h.next ?: return FooterUi(listOf("Max level"), emptyList(),
        liveCommand(ArmyLiveIds.HERO_UPGRADE, "MAX", CommandState.DISABLED, "${h.name} is at the highest level.", verb = Verb.GREEN))
    val blocked = heroBlockedReason(state)
    val primary = when {
        busy -> liveCommand(ArmyLiveIds.HERO_UPGRADE, "UPGRADE", CommandState.BUSY, verb = Verb.GREEN)
        blocked != null -> liveCommand(ArmyLiveIds.HERO_UPGRADE, "UPGRADE", CommandState.DISABLED, blocked, verb = Verb.GREEN)
        serverPrice(next.costKeep) == null -> liveCommand(ArmyLiveIds.HERO_UPGRADE, "UPGRADE", CommandState.DISABLED,
            "Price unavailable. Refresh the hero to read it again.", verb = Verb.GREEN)
        else -> liveCommand(ArmyLiveIds.HERO_UPGRADE, "UPGRADE", CommandState.ENABLED, verb = Verb.GREEN, sub = "${h.name} to Lv ${next.level}")
    }
    // heroes.png prices UPGRADE in the info block; the server review alone states the currency and amount, and a level
    // is bought instantly (no "takes" line), so the block names where the price is shown (A5's wording).
    return FooterUi(listOf("Price shown in review"), emptyList(), primary)
}

/** The building type a hero lives at (`heroaltar`, `siegestool`). */
internal fun heroBuildingType(h: Hero): String = h.altar ?: if (h.hero == "theodor") "siegestool" else "heroaltar"

/** The building a hero lives at ("Hero Altar", "Siege Stool"). */
internal fun heroHome(h: Hero): String = when (heroBuildingType(h)) {
    "siegestool" -> "Siege Stool"
    else -> "Hero Altar"
}

/** A skill's display name from the codex's upper-case key words ("DEGEN AWAKENING" -> "Degen Awakening", "SILENT BUT
 *  DEADLY" -> "Silent but Deadly"), as the hero frames write it ("Degen Awakening · 2 levels to go"). */
internal fun heroSkillName(codexName: String): String =
    codexName.lowercase().split(' ').mapIndexed { i, word ->
        if (i > 0 && word in SKILL_NAME_SMALL_WORDS) word else word.replaceFirstChar { it.uppercase() }
    }.joinToString(" ")

private val SKILL_NAME_SMALL_WORDS = setOf("a", "an", "and", "but", "of", "or", "the", "to")

/** The skills the catalogue lists for [hero], opened by the hero's real level. The icon is the authored atlas name (none
 *  for an unknown skill), so the strip and the next-skill row draw the same art. */
internal fun heroSkills(state: RosterUiState, hero: String, level: Int?): List<SkillUi> {
    val rows = ((state.catalogue?.get("constants") as? JsonObject)?.get("HERO_SKILLS") as? JsonObject)?.get(hero) as? JsonObject
    return CodexData.heroSkills(state.catalogue, hero).map { s ->
        val at = s.unlockLevel
        SkillUi(s.key, heroSkillIcon(hero, s.key).orEmpty(), heroSkillName(s.name), at ?: 0,
            unlocked = at != null && level != null && level >= at,
            oncePerBattle = (rows?.get(s.key) as? JsonObject)?.get("oncePerBattle") == JsonPrimitive(true))
    }
}

/** `RosterUiState` -> the Heroes sheet for [hero] on [tab], including its authoritative inventory loadout. */
internal fun heroesLiveUi(state: RosterUiState, hero: String, tab: String, nowMs: Long, busy: Boolean, selectedSlot: String? = null): HeroesUi {
    val h = state.hero(hero)
    val other = state.hero(otherHero(hero))
    val level = h?.level
    val remaining = h?.takeIf { !it.available }?.let { secondsUntil(it.recoveryUntil, nowMs) }?.takeIf { it > 0 }
    val chip = when {
        state.domain.heroes == null -> HeaderChipUi(null, "Checking", UNKNOWN)
        h == null || !h.recruited -> HeaderChipUi(null, "Not recruited", null)
        !h.available -> HeaderChipUi("timer", "Resting", remaining?.let { armyDuration(it) } ?: UNKNOWN)
        else -> HeaderChipUi(null, "Ready", null, DotColor.GREEN)
    }
    val switchTo = other?.let { o -> heroSwitch(state, o) }
    val health = when {
        h == null || !h.recruited -> HealthUi(null, null)
        h.available -> HealthUi(1f, null)
        else -> HealthUi(null, remaining)
    }
    val stats = if (h == null || !h.recruited) emptyList() else listOf(
        StatDeltaUi("Hitpoints", groupedAmount(h.hp) ?: UNKNOWN, h.next?.hp?.takeIf { it != h.hp }?.let { groupedAmount(it) ?: UNKNOWN }),
        StatDeltaUi("Damage/s", groupedAmount(h.dps) ?: UNKNOWN, h.next?.dps?.takeIf { it != h.dps }?.let { groupedAmount(it) ?: UNKNOWN }),
    )
    val skills = heroSkills(state, hero, level)
    val finishRest = h?.recoveryFinishNow?.let { finish ->
        val blocked = heroBlockedReason(state)
        when {
            busy -> liveCommand(ArmyLiveIds.HERO_FINISH_REST, "FINISH", CommandState.BUSY, primary = false, verb = Verb.GREEN)
            blocked != null -> liveCommand(ArmyLiveIds.HERO_FINISH_REST, "FINISH", CommandState.DISABLED, blocked, primary = false, verb = Verb.GREEN)
            serverPrice(finish.costKeep) == null -> liveCommand(ArmyLiveIds.HERO_FINISH_REST, "FINISH", CommandState.DISABLED,
                "Price unavailable. Refresh the hero to read it again.", primary = false, verb = Verb.GREEN)
            else -> liveCommand(ArmyLiveIds.HERO_FINISH_REST, "FINISH", CommandState.ENABLED, primary = false, verb = Verb.GREEN, sub = "Price shown in review")
        }
    }
    val portrait = rosterHeroPortrait(state.catalogue, hero, level).ifEmpty { "hero_vex_portrait" }
    val name = h?.name ?: hero.replaceFirstChar { it.uppercase() }
    val gear = gearLiveProjection(state, hero, selectedSlot, busy)
    return HeroesUi(
        hero = hero,
        header = SheetHeaderUi(name.uppercase(), if (h?.recruited == true) level?.let { "LV $it" } ?: "LV $UNKNOWN" else null, chip,
            HeaderArtUi(null, 1, listOf(WalkerUi(SpriteRef(heroBody(hero), 48), Dir8.S, 113, 40, 3))), switchTo),
        tab = tab,
        level = level ?: 0,
        maxLevel = h?.maxLevel ?: 0,
        health = health,
        stats = stats,
        skills = skills,
        nextSkill = skills.filter { !it.unlocked && it.unlockLevel > 0 }.minByOrNull { it.unlockLevel },
        gear = gear.gear,
        footer = if (tab == HERO_TAB_GEAR && h?.recruited != false) gear.footer else heroPrimary(state, h, busy),
        body = heroBody(hero),
        portrait = portrait,
        finishRest = finishRest,
        recruit = if (h != null && !h.recruited) EmptyStateUi(portrait, "Recruit $name at the ${heroHome(h)}",
            "Place the ${heroHome(h)} from the build tray to recruit $name.", "RECRUIT", FeatureId("hud.build")) else null,
        gearNew = gear.hasNew,
        loading = state.domain.heroes == null,
    )
}

/**
 * The header switch to [other] (SPEC §5 + E1.2): a recruited hero switches; a hero whose building this kingdom has not
 * built keeps the switch with a padlock (its tap opens that hero's recruit state, which says where to build); a built but
 * unrecruited hero, or an unread kingdom, hides it.
 */
internal fun heroSwitch(state: RosterUiState, other: Hero): HeroSwitchUi? {
    val portrait = rosterHeroPortrait(state.catalogue, other.hero, other.level)
    val short = heroShortName(other.hero, other.name)
    if (other.recruited) return HeroSwitchUi(other.hero, portrait, short, false, "Switch to ${other.name}")
    // Only the kingdom whose roster this is can say the building is missing.
    val buildings = state.home.base?.takeIf { it.baseId != null && it.baseId == state.domain.heroesBaseId }?.buildings ?: return null
    if (buildings.any { it.type == heroBuildingType(other) }) return null
    return HeroSwitchUi(other.hero, portrait, short, true, "${other.name}: build the ${heroHome(other)} first")
}

/** The re-done HERO tab's additions: "Being checked" while a saved rest payment is unresolved. No role line: the
 *  catalogue has no role copy for a hero (its `title` is an epithet, "The Shardborn"), and the frame's line is not
 *  paraphrased from combat numbers. */
internal fun heroTabExtrasLive(state: RosterUiState, hero: String): HeroTabExtrasUi =
    HeroTabExtrasUi(roleLine = null, restAsOf = null,
        finishChecking = state.interrupted.any { it.kind == IntentKind.HERO_RECOVERY })

/** True when the HERO tab of [ui] is drawn by the re-done `HeroTabV2` (recruited hero on HERO). */
internal fun usesHeroTabV2(ui: HeroesUi): Boolean = ui.tab == HERO_TAB_HERO && ui.recruit == null
