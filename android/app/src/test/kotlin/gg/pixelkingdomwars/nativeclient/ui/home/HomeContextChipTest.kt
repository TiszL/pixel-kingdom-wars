package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.DailyCache
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.Mining
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.model.TutorialState
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.hud.HOME_HUD_BUDGET
import gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.hud.HudRect
import gg.pixelkingdomwars.nativeclient.ui.hud.contextChipRect
import gg.pixelkingdomwars.nativeclient.ui.hud.deckSlots
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHudCoverage
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHudPlan
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHudRects
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHudTransientRects
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.ContextChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ProfileMedallionUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transient context chip and BUILD NEW (DESIGN-SYSTEM §6 ContextChip and BottomDeck, home.png, home-budget.png). Why it
 * matters: the chip is the only place Home still points at the player's next opportunity, including the first-run
 * objective that used to sit on the scene permanently, so its priority is the design's (claimable > ready to collect >
 * idle builder, with the objective first), it never claims something is ready when the server did not say so, and it
 * never costs the owner's 12 % permanent budget.
 */
class HomeContextChipTest {
    private val mine = Building("mine-1", "mine", 2, 10, 10)

    private fun home(
        cacheClaimable: Boolean = false,
        claimableQuests: Int = 0,
        accrued: String? = "0",
        mineStatus: Boolean = true,
        hasMine: Boolean = true,
        freeBuilders: Int = 0,
        base: Boolean = true,
    ) = BaseState(
        base = if (!base) null else BaseSnapshot("b1", null, PlayerSummary(keepLevel = 4, builders = 2), null, null, null,
            if (hasMine) listOf(mine) else emptyList(), emptyList(), emptyList(), freeBuilders, buildJsonObject {}),
        quests = QuestBoard(quests = List(claimableQuests) { Quest(id = "q$it", templateCode = "daily_raid", completed = true) } +
            Quest(id = "open", templateCode = "daily_train", completed = false)),
        mine = if (!mineStatus) null else MineStatus(mining = accrued?.let { Mining(accrued = it) }, cache = DailyCache(claimable = cacheClaimable)),
    )

    private val objective = ContextChipUi(HudIds.QUESTS, "quest", "Build a Mine", "Quests ▸")

    @Test fun `the chip follows the design's priority with the first-run objective first`() {
        val everything = home(cacheClaimable = true, claimableQuests = 2, accrued = "8400", freeBuilders = 1)
        assertEquals(objective, homeContextCandidate(everything, objective))
        assertEquals(HudIds.DAILY_CACHE, homeContextCandidate(everything)?.id)
        assertEquals(HudIds.QUESTS, homeContextCandidate(home(claimableQuests = 2, accrued = "8400", freeBuilders = 1))?.id)
        assertEquals("2 ready", homeContextCandidate(home(claimableQuests = 2, accrued = "8400", freeBuilders = 1))?.what)
        val mineChip = homeContextCandidate(home(accrued = "8400", freeBuilders = 1))
        assertEquals(FeatureId("mine.collect"), mineChip?.id)
        assertEquals("+8,400", mineChip?.what)
        assertEquals(HudIds.BUILDERS, homeContextCandidate(home(freeBuilders = 1))?.id)
    }

    @Test fun `every chip id is one Home already routes, so a tap is never a dead door`() {
        // HomeScaffold.openHudFeature handles exactly these; a new id here must get a route there first.
        val routed = setOf(HudIds.QUESTS, HudIds.DAILY_CACHE, FeatureId("mine.collect"), HudIds.BUILDERS)
        listOf(home(cacheClaimable = true), home(claimableQuests = 1), home(accrued = "1"), home(freeBuilders = 2))
            .forEach { assertTrue(homeContextCandidate(it)!!.id in routed) }
        assertTrue(homeObjectiveChip(Quest(id = "s", templateCode = "first_mine"), null)!!.id in routed)
    }

    @Test fun `nothing pending shows no chip at all`() {
        assertNull(homeContextCandidate(home()))
        assertNull("no base read yet: no mine or builder claim", homeContextCandidate(home(base = false, accrued = "8400")))
    }

    @Test fun `an unknown mine buffer never reads as ready to collect`() {
        assertNull("mine/status not read", homeContextCandidate(home(mineStatus = false)))
        assertNull("mining block absent", homeContextCandidate(home(accrued = null)))
        assertNull("an empty buffer", homeContextCandidate(home(accrued = "0")))
        assertNull("unreadable figure", homeContextCandidate(home(accrued = "lots")))
        assertNull("Shards waiting but no Mine to fly to", homeContextCandidate(home(accrued = "8400", hasMine = false)))
    }

    @Test fun `the objective says Claim only when the step is complete and unclaimed`() {
        val catalogue = buildJsonObject { putJsonObject("display") { putJsonObject("questLabels") { put("first_mine", "Build a Mine") } } }
        val running = homeObjectiveChip(Quest(id = "s", templateCode = "first_mine"), catalogue)!!
        assertEquals("Build a Mine", running.what)
        assertEquals("Quests ▸", running.where)
        assertEquals("Claim ▸", homeObjectiveChip(Quest(id = "s", templateCode = "first_mine", completed = true), catalogue)!!.where)
        assertNull("claimed: nothing left to do", homeObjectiveChip(Quest(id = "s", templateCode = "first_mine", completed = true, claimed = true), catalogue))
        assertNull(homeObjectiveChip(null, catalogue))
    }

    @Test fun `the objective follows the old guidance rules, after the first-run cards and never once skipped`() {
        val step = Quest(id = "s", templateCode = "first_mine")
        assertNotNull(homeGuideObjective(TutorialState(step = 3, completedAt = "2026-10-01T00:00:00Z", onboarding = step), null))
        assertNull("the first-run cards are still showing", homeGuideObjective(TutorialState(step = 1, onboarding = step), null))
        assertNull("the player skipped the guidance", homeGuideObjective(TutorialState(step = 3, completedAt = "2026-10-01T00:00:00Z",
            guideSkipped = true, onboarding = step), null))
        assertNull(homeGuideObjective(null, null))
    }

    @Test fun `BUILD carries the gold NEW only while a building has just unlocked`() {
        assertNull(homeHudWithBuildNew(hud, emptySet()).deck.single { it.id == HudIds.BUILD }.badge)
        val badged = homeHudWithBuildNew(hud, setOf("workshop"))
        assertEquals(BadgeUi("NEW", BadgeTone.REWARD, "A new building unlocked"), badged.deck.single { it.id == HudIds.BUILD }.badge)
        assertTrue("no other deck button changes", badged.deck.filter { it.id != HudIds.BUILD }.all { it.badge == null })
    }

    @Test fun `the chip rides only a visible deck`() {
        val chip = homeContextCandidate(home(freeBuilders = 1))
        assertEquals(chip, homeHudWithContext(hud, chip).context)
        assertNull("a selection or BUILD hid the deck", homeHudWithContext(hud.copy(deckVisible = false), chip).context)
    }

    @Test fun `the chip sits in the deck gap of home html and costs the permanent budget nothing`() {
        val plan = homeHudPlan(hud)
        assertEquals("x 156, y 853 on the 412 x 915 phone", HudRect(156, 853, 108, 48), contextChipRect(plan.deck))
        val chip = homeContextCandidate(home(freeBuilders = 1))
        assertEquals(homeHudCoverage(hud), homeHudCoverage(homeHudWithContext(hud, chip)), 0f)
        assertTrue(homeHudCoverage(homeHudWithContext(hud, chip)) <= HOME_HUD_BUDGET)
        val transient = homeHudTransientRects(plan, contextShown = true)
        assertEquals(2, transient.size)
        assertTrue("never under a deck button", homeHudRects(plan).none { r -> transient.first().let {
            it.left < r.right && r.left < it.right && it.top < r.bottom && r.top < it.bottom } })
        assertTrue(homeHudTransientRects(plan, contextShown = false).isEmpty())
    }

    @Test fun `on a phone too narrow for the gap the chip rises above the small deck buttons`() {
        val slots = deckSlots(hud.deck, mirrored = false)
        val narrow = contextChipRect(slots, screenW = 360)!!
        val armyTop = HudGeometry.SCREEN_H - HudGeometry.DECK_BOTTOM - HudGeometry.DECK_SMALL
        assertTrue("clears ARMY and MAP", narrow.bottom <= armyTop)
        assertEquals((360 - HudGeometry.CONTEXT_W) / 2, narrow.left)
        assertFalse(contextChipRect(slots)!!.bottom <= armyTop)
    }

    private val hud = HomeHudUi(
        profile = ProfileMedallionUi(HudIds.PROFILE, "4", null, "Profile, Keep level 4"),
        builders = ChipUi(HudIds.BUILDERS, "builder", "1/2", "Builders 1 of 2 free"),
        shield = ChipUi(HudIds.SHIELD, "shield", "4h", "Shield 4 hours"),
        resources = listOf(ResourceChipUi(HudIds.SHARDS, "shards", "40,943", null, false, null, name = "Shards")),
        rightEdge = emptyList(), leftEdge = emptyList(), herald = null,
        deck = listOf(
            DeckButtonUi(HudIds.ATTACK, "attack", "ATTACK", true, null, null, verb = Verb.RED),
            DeckButtonUi(HudIds.ARMY, "ui_portrait_highlander_t2", "ARMY", false, null, null, verb = Verb.CHARCOAL),
            DeckButtonUi(HudIds.MAP, "map", "MAP", false, null, null, verb = Verb.BLUE),
            DeckButtonUi(HudIds.BUILD, "shape:hammer", "BUILD", true, null, null, verb = Verb.GREEN),
        ),
        deckVisible = true,
    )
}
