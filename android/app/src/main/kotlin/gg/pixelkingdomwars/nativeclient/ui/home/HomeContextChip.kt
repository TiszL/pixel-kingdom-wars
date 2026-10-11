package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.TutorialState
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kingdom.questLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ContextChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject

/*
 * Design component: the Home context chip and the BUILD NEW badge producers (DESIGN-SYSTEM §6 ContextChip and BottomDeck;
 * §3 "Context chip is transient"; home.png, home-budget.png).
 *
 * The chip is the one transient opportunity line between ARMY and MAP: it shows for 6 s on arriving Home and whenever a
 * new opportunity appears, then hides, so it costs the owner's 12 % permanent budget nothing. One at a time, by the
 * design's priority (claimable > ready to collect > live auction > idle builder), with the first-run objective first: it
 * replaced KingdomScreen's permanent objective strip. There is no auction candidate: auctions have no system yet.
 *
 * Every id here is one HomeScaffold's `openHudFeature` already routes (`hud.quests`, `hud.dailyCache`, `mine.collect`,
 * `hud.builders`), so a tap is never a dead door. Every number comes from the server's Home read; an unknown mine buffer
 * never reads as ready. The two lines are short so they fit the 108 dp card at VT 18: "<what>" over "<place> ▸".
 */

/** How long the chip stays (DESIGN-SYSTEM §6 ContextChip "Shows for 6 s"; TOKENS.json has no key for it). */
internal const val CONTEXT_HOLD_MS = 6_000L

/** The Mine's collect door (registry row; HomeScaffold focuses the Mine with it). */
private val MINE_COLLECT = FeatureId("mine.collect")

/**
 * The opportunity the chip would show now, or null when nothing is pending. Priority: [objective] (the first-run step),
 * the daily cache when claimable, quest rewards when claimable, the Mine when Shards are waiting (a Mine exists and the
 * server's `mine/status` buffer is above zero; an unread status is unknown, never ready), then a free builder.
 */
internal fun homeContextCandidate(home: BaseState, objective: ContextChipUi? = null): ContextChipUi? {
    objective?.let { return it }
    if (home.mine?.cache?.claimable == true) return ContextChipUi(HudIds.DAILY_CACHE, "shape:chest", "Daily", "Cache ▸")
    val claimable = home.quests?.quests?.count { it.completed && !it.claimed } ?: 0
    if (claimable > 0) return ContextChipUi(HudIds.QUESTS, "quest", "$claimable ready", "Quests ▸")
    val base = home.base ?: return null
    val accrued = home.mine?.mining?.accrued
    if (base.buildings.any { it.type == "mine" } && accrued?.toBigDecimalOrNull()?.signum() == 1)
        return ContextChipUi(MINE_COLLECT, "shards", "+${compactAmount(accrued)}", "Mine ▸")
    if (base.freeBuilders > 0) return ContextChipUi(HudIds.BUILDERS, "builder", "Idle", "Builder ▸")
    return null
}

/**
 * The first-run objective as a chip (it replaced KingdomScreen's OnboardingStrip): the step's catalogue label, "Claim ▸"
 * once it is complete and unclaimed, else "Quests ▸". A tap opens Quests, where the chain step's own BUILD / TRAIN /
 * BUY / RAID / CLAIM doors live. Null when there is no step or it was already claimed.
 */
internal fun homeObjectiveChip(quest: Quest?, catalogue: JsonObject?): ContextChipUi? {
    val step = quest?.takeIf { !it.claimed && it.templateCode.isNotBlank() } ?: return null
    return ContextChipUi(HudIds.QUESTS, "quest", questLabel(catalogue, step.templateCode),
        if (step.completed) "Claim ▸" else "Quests ▸")
}

/**
 * [homeObjectiveChip] under KingdomGuidance's own rules: the objective showed only after the first-run cards were done
 * (tutorial completed) and never once the player skipped the guidance. The caller should prefer this over passing
 * `tutorial?.onboarding` straight to [homeObjectiveChip].
 */
internal fun homeGuideObjective(tutorial: TutorialState?, catalogue: JsonObject?): ContextChipUi? =
    homeObjectiveChip(tutorial?.takeIf { it.completed && !it.guideSkipped }?.onboarding, catalogue)

/**
 * [candidate] as the transient chip: shown for [holdMs] when it first arrives and again whenever its id or text changes,
 * then null; null at once when the candidate goes. Reduced motion changes only how it fades (HomeHud), not how long it
 * stays.
 */
@Composable internal fun rememberTransientContext(candidate: ContextChipUi?, holdMs: Long = CONTEXT_HOLD_MS): ContextChipUi? {
    var shown by remember { mutableStateOf<ContextChipUi?>(null) }
    val latest by rememberUpdatedState(candidate)
    LaunchedEffect(candidate?.id, candidate?.what, candidate?.where, holdMs) {
        val arrived = latest
        shown = arrived
        if (arrived == null) return@LaunchedEffect
        delay(holdMs)
        shown = null
    }
    return shown
}

/** [ui] with [context] in the deck gap; while the deck is hidden (a selection, BUILD) no chip is carried at all. */
internal fun homeHudWithContext(ui: HomeHudUi, context: ContextChipUi?): HomeHudUi =
    ui.copy(context = context.takeIf { ui.deckVisible })

/** The gold NEW badge on BUILD (DESIGN-SYSTEM §6 BottomDeck "gold NEW badge when a building unlocks") while [newTypes]
 *  (building types unlocked at this Keep level and not built yet) is not empty; otherwise [ui] is unchanged. */
internal fun homeHudWithBuildNew(ui: HomeHudUi, newTypes: Set<String>): HomeHudUi {
    if (newTypes.isEmpty()) return ui
    return ui.copy(deck = ui.deck.map { button ->
        if (button.id == HudIds.BUILD) button.copy(badge = BadgeUi("NEW", BadgeTone.REWARD, "A new building unlocked")) else button
    })
}
