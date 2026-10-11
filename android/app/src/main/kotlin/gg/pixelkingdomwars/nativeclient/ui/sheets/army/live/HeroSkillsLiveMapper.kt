package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroSkillsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroesUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.LEVELS_PER_TIER
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.MAX_TIER
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.NextUnlockUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SkillRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.heroTier
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.tierCells
import java.math.BigDecimal
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Read-only R2 SKILLS mapping over the same roster/catalogue as HeroesScreen. Required integer UI fields cannot
 * represent unknown facts: null keeps the legacy screen, never a made-up Lv 0, guessed tier or partial skill list.
 * The base binding rejects another base's roster; these inputs do not carry selected-base generation, so this is
 * not an A→B→A freshness guarantee. The existing footer still owns every upgrade/recruit/recovery confirmation.
 */
internal fun heroSkillsLiveUi(state: RosterUiState, hero: String, existing: HeroesUi): HeroSkillsUi? {
    val baseId = state.home.base?.baseId?.takeIf { it.isNotBlank() } ?: return null
    if (state.domain.heroesBaseId != baseId || existing.hero != hero) return null
    val h = state.domain.heroes?.heroes?.singleOrNull { it.hero == hero } ?: return null
    if (!h.recruited) return null
    val displayMaximum = LEVELS_PER_TIER * MAX_TIER
    val level = h.level?.takeIf { it in 1..displayMaximum } ?: return null
    val tier = h.tier?.takeIf { it in 1..MAX_TIER && it == heroTier(level) } ?: return null
    val maximum = h.maxLevel
    // R2 has a fixed four-tier track. A shorter or longer server track needs a different presentation.
    if (maximum != null && maximum != displayMaximum) return null
    val constants = state.catalogue?.get("constants") as? JsonObject ?: return null
    val catalogue = (constants["HERO_SKILLS"] as? JsonObject)?.get(hero) as? JsonObject ?: return null
    if (catalogue.isEmpty()) return null
    val names = CodexData.heroSkills(state.catalogue, hero).associate { it.key to it.name }
    val skills = catalogue.map { (id, value) ->
        val raw = value as? JsonObject ?: return null
        val unlock = positiveSkillLevel(raw["unlockLevel"]) ?: return null
        if (unlock > displayMaximum) return null
        val once = raw["oncePerBattle"] == JsonPrimitive(true)
        val unlocked = level >= unlock
        SkillRowUi(id, heroSkillIcon(hero, id).orEmpty(), names[id]?.let(::heroSkillName) ?: id,
            // HERO_SKILLS currently has numeric mechanics, not authored effect prose. Preview copy is not evidence.
            effect = "Effect details unavailable.", unlockLevel = unlock, unlocked = unlocked,
            tierLabel = if (unlocked) "T$tier" else null,
            cooldown = if (once) null else skillCooldown(raw["cdSec"]), oncePerBattle = once)
    }.sortedBy { it.unlockLevel }
    val maxed = maximum != null && level == maximum
    // heroes-skills.png "Degen Awakening, all skills T3": the unlock level also starts a new tier when heroTier says so
    // (the same rule the tier track and the server's tier check use).
    val next = if (maxed) null else skills.firstOrNull { !it.unlocked }?.let {
        val nextTier = heroTier(it.unlockLevel)
        NextUnlockUi(it.icon, it.unlockLevel, if (nextTier > tier) "${it.name}, all skills T$nextTier" else it.name)
    }
    return HeroSkillsUi(h.name, level, tier, tierCells(level, maxed), skills, next, existing.footer,
        loading = state.domain.loading, recruit = existing.recruit)
}

/** Catalogue unlocks are whole positive levels; the codex's lenient numeric conversion must not truncate them. */
private fun positiveSkillLevel(value: JsonElement?): Int? = (value as? JsonPrimitive)?.contentOrNull
    ?.takeIf { it.matches(Regex("[1-9][0-9]*")) }?.toIntOrNull()

/** Some skills are passive and have duration without a cooldown. Preserve only the actual positive cdSec text. */
private fun skillCooldown(value: JsonElement?): String? {
    val text = (value as? JsonPrimitive)?.contentOrNull
        ?.takeIf { it.matches(Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")) } ?: return null
    return if (text.toBigDecimalOrNull()?.let { it > BigDecimal.ZERO } == true) "every ${text}s" else null
}

/** Exact aliases present in the bundled pkw_ui_art.json; camel-case catalogue ids are not atlas names.
 * Unknown future skills remain unillustrated instead of borrowing another skill's identity. */
internal fun heroSkillIcon(hero: String, id: String): String? = when (hero) {
    "vex" -> when (id) {
        "crimsonDash" -> "crimsondash"
        "moonsunderWave" -> "moonwave"
        "degenAwakening" -> "degenmode"
        "doubleOrNothing" -> "doubleornothing"
        "omegaShardstorm" -> "shardstorm"
        else -> null
    }
    "theodor" -> when (id) {
        "cheekQuake" -> "cheekquake"
        "snotRocket" -> "snotrocket"
        "cannonball" -> "cannonball"
        "skillIssue" -> "skillissue"
        "bellyBounce" -> "bellybounce"
        "brownNote" -> "brownnote"
        "rageQuit" -> "ragequit"
        "silentButDeadly" -> "silentbutdeadly"
        else -> null
    }
    else -> null
}?.let { "ui_skill_$it" }

internal data class HeroSkillMetricUi(val label: String, val values: List<String>)
internal data class HeroSkillInfoUi(
    val name: String, val icon: String, val unlockLevel: Int, val unlocked: Boolean,
    val currentTier: Int, val cooldown: String?, val oncePerBattle: Boolean,
    val metrics: List<HeroSkillMetricUi>,
)

/** Read-only values from the same validated hero/catalogue. This is a tier table, not authored
 * effect prose: no catalogue currently supplies that copy. Unknown fields and sentinel values
 * are never interpreted as a new combat rule. No repository, price or command is exposed. */
internal fun heroSkillInfoLiveUi(state: RosterUiState, hero: String, existing: HeroesUi, id: String): HeroSkillInfoUi? {
    if (state.selectedHero != hero) return null
    val skills = heroSkillsLiveUi(state, hero, existing) ?: return null
    val skill = skills.skills.singleOrNull { it.id == id } ?: return null
    val constants = state.catalogue?.get("constants") as? JsonObject ?: return null
    val raw = (((constants["HERO_SKILLS"] as? JsonObject)?.get(hero) as? JsonObject)?.get(id) as? JsonObject) ?: return null
    val unknown = gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
    fun value(element: JsonElement?): String = (element as? JsonPrimitive)?.contentOrNull
        ?.takeIf { Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?").matches(it) } ?: unknown
    val metrics = skillMetricLabels.mapNotNull { (key, label) ->
        val source = raw[key] ?: return@mapNotNull null
        val values = if (source is JsonArray) {
            if (source.size == MAX_TIER) source.map(::value) else List(MAX_TIER) { unknown }
        } else List(MAX_TIER) { value(source) }
        HeroSkillMetricUi(label, values)
    }
    if (metrics.none { metric -> metric.values.any { it != unknown } }) return null
    return HeroSkillInfoUi(skill.name, skill.icon, skill.unlockLevel, skill.unlocked, skills.tier,
        skill.cooldown, skill.oncePerBattle, metrics)
}

/** Labels translate the existing wire fields and units only; values always come from HERO_SKILLS.
 * Deciseconds remain labelled as tenths of a second, avoiding arithmetic or unknown sentinels. */
private val skillMetricLabels = linkedMapOf(
    "lineDmgPctDps" to "Line damage (% DPS)", "wallMult" to "Wall multiplier", "rangeTiles" to "Range (tiles)",
    "minGapTiles" to "Minimum gap (tiles)", "waveDmgPctDps" to "Wave damage (% DPS)",
    "bleedPctMaxHpPer4s" to "Bleed (% max HP / 4s)", "widthTiles" to "Width (tiles)", "bleedSec" to "Bleed (seconds)",
    "durationSec" to "Duration (seconds)", "dmgPct" to "Damage bonus (%)", "atkSpeedPct" to "Attack speed bonus (%)",
    "lifestealPct" to "Lifesteal (%)", "reviveHpPct" to "Revive HP (%)", "tailsRegenRefundPct" to "Tails recovery refund (%)",
    "headsPct" to "Heads chance (%)", "immuneSec" to "Immunity (seconds)", "novaDmgPctDps" to "Nova damage (% DPS)",
    "stunDeciSec" to "Stun (tenths of a second)", "crescents" to "Crescents", "novaRadiusTiles" to "Nova radius (tiles)",
    "aoeTiles" to "Area (tiles)", "aoeDmgPctDps" to "Area damage (% DPS)", "tauntTiles" to "Taunt range (tiles)",
    "dmgPctDps" to "Damage (% DPS)", "blindDeciSec" to "Blind (tenths of a second)", "castRangeTiles" to "Cast range (tiles)",
    "impactDmgPctDps" to "Impact damage (% DPS)", "leapRangeTiles" to "Leap range (tiles)",
    "partingGiftDps" to "Parting gift (damage / s)", "partingGiftSec" to "Parting gift (seconds)",
    "retargetTiles" to "Retarget range (tiles)", "dmgTakenReductionPct" to "Damage reduction (%)",
    "reflectPct" to "Reflected damage (%)", "knockbackTiles" to "Knockback (tiles)", "selfDrPct" to "Self damage reduction (%)",
    "wallSegments" to "Wall segments", "gasSec" to "Gas (seconds)", "gasDps" to "Gas (damage / s)", "gasRadiusTiles" to "Gas radius (tiles)",
    "fakeDeathHpPct" to "Fake death HP (%)", "untargetableSec" to "Untargetable (seconds)",
    "wakeStunSec" to "Wake stun (seconds)", "wakeStunRadiusTiles" to "Wake stun radius (tiles)",
    "eatWindupSec" to "Eat wind-up (seconds)", "swellWindupSec" to "Swell wind-up (seconds)",
    "fearSec" to "Fear (seconds)", "cloudSec" to "Cloud (seconds)", "cloudDps" to "Cloud (damage / s)",
)
