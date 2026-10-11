package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.TutorialState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.retiredTutorialStep
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Design component: the first-run guide card on Home, drawn with the kit (a charcoal plate, kit text and buttons) in place
 * of KingdomScreen's KingdomGuidance plate. Same copy, same actions, same rules (web TutorialOverlay):
 * - welcome / camera / quests: CONTINUE advances; on the quests card OPEN QUESTS advances onto "done" AND opens the board,
 *   so the player never comes back to a card already finished; SKIP GUIDANCE skips the guide;
 * - a retired step (the pack no longer has it) offers only the way on to the current objectives (`skip`);
 * - nothing once the tutorial is complete or the guide was skipped. The objective strip that followed the cards is not
 *   here: the objective is the top-priority transient context chip now (HomeContextChip.kt, homeGuideObjective).
 * One gold primary per surface, last (CONTINUE); OPEN QUESTS is blue (go to a place); SKIP GUIDANCE is stone (utility).
 */

/** What the guide shows now. */
internal sealed interface HomeGuide {
    /** The pack retired this step: only the way on to the current objectives. */
    data object Retired : HomeGuide
    /** One first-run card: its step id ("welcome", "camera", "quests"), title and body. */
    data class Card(val step: String, val title: String, val body: String) : HomeGuide
}

/** KingdomGuidance's rules for [tutorial] against the pack's `TUTORIAL_STEPS.ids`; null shows nothing. */
internal fun homeGuide(tutorial: TutorialState, catalogue: JsonObject?): HomeGuide? {
    if (tutorial.guideSkipped || tutorial.completed) return null
    val ids = ((catalogue?.get("constants") as? JsonObject)?.get("TUTORIAL_STEPS") as? JsonObject)?.get("ids") as? JsonArray
    if (retiredTutorialStep(tutorial.step, tutorial.completed, ids)) return HomeGuide.Retired
    val step = (ids?.getOrNull(tutorial.step) as? JsonPrimitive)?.content ?: return null
    val copy = when (step) {
        "welcome" -> "Welcome, Keeper" to "Build your kingdom, train troops and follow the quest board for your first objectives."
        "camera" -> "Explore your kingdom" to "Drag to move around your base and pinch to zoom. Tap a building to inspect it. Hold a building still, then drag, to move it."
        "quests" -> "Your next objective" to "The quest board tracks construction, training and campaign progress. Claim completed objectives there."
        else -> return null
    }
    return HomeGuide.Card(step, copy.first, copy.second)
}

/**
 * The first-run guide card, only while the tutorial is incomplete and not skipped ([homeGuide]). [onAction] receives the
 * tutorial action exactly as KingdomGuidance sent it ("advance", "guide/skip", "skip"); [onOpenQuests] opens the quest
 * board after OPEN QUESTS advanced. While [busy] every button waits (the primary shows its busy dots).
 */
@Composable internal fun HomeGuideCard(tutorial: TutorialState, catalogue: JsonObject?, busy: Boolean, onAction: (String) -> Unit,
    onOpenQuests: () -> Unit, modifier: Modifier = Modifier) {
    val guide = homeGuide(tutorial, catalogue) ?: return
    val c = PkwTokens.Colors
    val primaryState = if (busy) CommandState.BUSY else CommandState.ENABLED
    Plate(PlateKind.CHARCOAL, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when (guide) {
                HomeGuide.Retired -> {
                    PkwText("Continue to your current objectives", PkwTokens.Type.body, color = c.text, maxLines = 2)
                    PrimaryButton("CONTINUE", { if (!busy) onAction("skip") }, Modifier.fillMaxWidth(), state = primaryState)
                }
                is HomeGuide.Card -> {
                    PkwText(guide.title.uppercase(), PkwTokens.Type.title, Modifier.semantics { heading() }, color = c.gold.hi, outline = 1.dp)
                    PkwText(guide.body, PkwTokens.Type.body, color = c.text, maxLines = 5)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton("SKIP GUIDANCE", { onAction("guide/skip") }, Modifier.weight(1f), enabled = !busy)
                        // Web TutorialOverlay: the last card's OPEN QUESTS advances onto 'done' AND opens the board. The board is
                        // asked for first, while Home is still idle, so it opens as the sheet over the base instead of leaving
                        // Home (which rebuilt the whole scene on return, owner 2026-10-06 "always loading").
                        if (guide.step == "quests") SecondaryButton("OPEN QUESTS", { onOpenQuests(); onAction("advance") },
                            Modifier.weight(1f), verb = Verb.BLUE, enabled = !busy)
                    }
                    PrimaryButton("CONTINUE", { if (!busy) onAction("advance") }, Modifier.fillMaxWidth(), state = primaryState)
                }
            }
        }
    }
}
