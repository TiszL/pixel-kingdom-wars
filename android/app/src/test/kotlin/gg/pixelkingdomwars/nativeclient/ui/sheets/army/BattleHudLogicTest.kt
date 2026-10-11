package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The in-battle HUD's rules (design/final/army/SPEC.md §6A). Why they matter: this is the screen players spend most of
 * their time on, and the server alone decides the battle. A HUD that shows 0 % or 0 stars before the server has said
 * anything, lets a used-up card swallow a tap meant for the field, fires the hero ability while it is cooling, or makes the
 * player confirm leaving a battle they never committed to, misreports a fight that costs real troops.
 */
class BattleHudLogicTest {

    @Test fun `the clock warns in the last thirty seconds and stays calm with reduced motion`() {
        assertEquals(ClockLook("starts", danger = false, pulse = false), clockLook(ClockPhase.SCOUT, false))
        assertEquals("ends in", clockLook(ClockPhase.FIGHT, false).label)
        val late = clockLook(ClockPhase.LAST_30, reducedMotion = false)
        assertTrue(late.danger); assertTrue(late.pulse)
        val calm = clockLook(ClockPhase.LAST_30, reducedMotion = true)
        assertTrue("reduced motion keeps the colour", calm.danger); assertFalse(calm.pulse)
    }

    @Test fun `destruction and stars never invent a value before the server`() {
        assertEquals("…%", destructionText(null))
        assertNull(destructionFraction(null))
        assertEquals("0%", destructionText(0))
        assertEquals("100%", destructionText(140))
        assertEquals(0.5f, destructionFraction(50)!!, 0.0001f)
        assertEquals(0, starsLit(null))
        assertEquals(3, starsLit(5))
    }

    @Test fun `deck counts read as the design and unknown is the ellipsis`() {
        assertEquals("x5", deckCountText(5, false))
        assertEquals("x0", deckCountText(0, false))
        assertEquals("x…", deckCountText(null, false))
        assertEquals("HERO", deckCountText(null, isHero = true))
        assertEquals("SKILL", deckCountText(null, isHero = true, heroSent = true))
        assertEquals("12s", deckCountText(null, isHero = true, heroSent = true, abilityReadyIn = "12s"))
    }

    @Test fun `a used-up card stays in place but takes no tap`() {
        assertTrue(deckCardUsedUp(0, false))
        assertFalse("unknown is not used up: the server re-checks every deploy", deckCardUsedUp(null, false))
        assertFalse(deckCardUsedUp(0, isHero = true))
        assertEquals(DeckTap.NONE, deckCardTap(0, false, false, null))
        assertEquals(DeckTap.SELECT, deckCardTap(3, false, false, null))
        assertEquals(DeckTap.SELECT, deckCardTap(null, false, false, null))
    }

    @Test fun `the hero is selected until sent, then fires its ability only when ready`() {
        assertEquals(DeckTap.SELECT, deckCardTap(null, isHero = true, heroSent = false, abilityReadyIn = null))
        assertEquals(DeckTap.ABILITY, deckCardTap(null, isHero = true, heroSent = true, abilityReadyIn = null))
        assertEquals(DeckTap.NONE, deckCardTap(null, isHero = true, heroSent = true, abilityReadyIn = "12s"))
    }

    @Test fun `leaving before any troop is sent needs no confirm, ending after does`() {
        assertEquals(EndRoute.LEAVE, endRoute(canLeaveFree = true)); assertEquals("LEAVE", endLabel(true))
        assertEquals(EndRoute.CONFIRM, endRoute(canLeaveFree = false)); assertEquals("END", endLabel(false))
    }

    @Test fun `more than six cards scroll instead of shrinking`() {
        assertFalse(deckScrolls(6))
        assertTrue(deckScrolls(7))
    }
}
