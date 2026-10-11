package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The battle result celebration's timeline (design/final/army/SPEC.md "Round 2, part two"). Why it matters: the result is
 * the payoff of a raid. Stars must land one by one in order; loot must NEVER count up and coins must never fly before the
 * server's settlement receipt (a counted-up number that later changes is a promise the server did not make); a defeat has
 * no gold rays or coin shower; the doors must come last and must be reachable even if the receipt never comes; a tap must
 * be able to skip the show; and reduced motion must show the final state without loops or flights.
 */
class ResultCelebrationTimelineTest {
    private val victory = ResultTimelineSpec(won = true, earned = 2, medals = 2, doors = 4)
    private val defeat = victory.copy(won = false, earned = 0)

    @Test fun `stars land one by one, in order, before the plate`() {
        val at350 = resultFrame(350, victory, settledAtMs = 0, skipped = false)
        assertEquals("the first star has landed (160 + 180 ms)", 1f, at350.stars[0], 0f)
        assertEquals("the third has not started", 0f, at350.stars[2], 0f)
        val at700 = resultFrame(700, victory, 0, false)
        assertTrue(at700.stars[1] >= 1f); assertTrue(at700.stars[2] > 0f && at700.stars[2] < 1f)
        assertEquals("the plate waits for the third star", 0f, at700.plate, 0f)
        assertEquals(1f, resultFrame(1_000, victory, 0, false).plate, 0f)
    }

    @Test fun `only earned stars sparkle`() {
        val justAfterThird = resultFrame(ResultBeats.STAR_AT[2] + ResultBeats.STAR_MS + 10, victory, 0, false)
        assertEquals("2 earned: the third star lands grey with no sparkle", null, justAfterThird.sparkle[2])
        val justAfterFirst = resultFrame(ResultBeats.STAR_AT[0] + ResultBeats.STAR_MS + 10, victory, 0, false)
        assertEquals(0, justAfterFirst.sparkle[0])
    }

    @Test fun `nothing counts and no coin flies before the receipt`() {
        for (t in listOf(500L, 1_500L, 3_000L, 10_000L)) {
            val f = resultFrame(t, victory, settledAtMs = null, skipped = false)
            assertEquals("pending at $t ms", 0f, f.count, 0f)
            assertTrue("no coins while pending at $t ms", f.coins.isEmpty())
        }
    }

    @Test fun `the count starts after the medallions even if the receipt came early`() {
        val medalsDone = medalsDoneAt(2)
        assertEquals(medalsDone, countStartAt(victory, settledAtMs = 50))
        assertEquals(0f, resultFrame(medalsDone - 1, victory, 50, false).count, 0f)
        assertTrue(resultFrame(medalsDone + 300, victory, 50, false).count in 0.01f..0.99f)
        assertTrue("coins are in the air during the count", resultFrame(medalsDone + 100, victory, 50, false).coins.isNotEmpty())
        assertEquals("a late receipt counts when it lands", 5_000L, countStartAt(victory, settledAtMs = 5_000))
    }

    @Test fun `a defeat has no rays, no gleam and no coin flight, but its loss still counts`() {
        val t = medalsDoneAt(2) + 200
        val f = resultFrame(t, defeat, settledAtMs = 0, skipped = false)
        assertEquals(0f, f.rays, 0f); assertEquals(0f, f.gleam, 0f); assertTrue(f.coins.isEmpty())
        assertTrue("the trophy loss counts down", f.count > 0f)
        assertEquals(1f, f.pulse, 0f)
    }

    @Test fun `the army chip and the doors come last, HOME after the others`() {
        val settled = 0L
        val army = armyAt(victory, settled)
        assertEquals(countStartAt(victory, settled)!! + countLength(victory) + ResultBeats.ARMY_AFTER, army)
        val doors = (0 until 4).map { doorAt(victory, settled, it) }
        assertEquals(doors.sorted(), doors)
        assertEquals(ResultBeats.DOOR_STAGGER.toLong(), doors[3] - doors[2])
        assertTrue(doors[0] > army)
        assertFalse(resultFrame(army - 1, victory, settled, false).done)
        assertTrue(resultFrame(doors[3] + ResultBeats.DOOR_MS, victory, settled, false).done)
    }

    @Test fun `doors are live even if the receipt never comes, and a late receipt never hides them`() {
        val pendingArmy = armyAt(victory, null)
        assertEquals(medalsDoneAt(2) + ResultBeats.ARMY_AFTER, pendingArmy)
        val shown = resultFrame(doorAt(victory, null, 3) + ResultBeats.DOOR_MS, victory, null, false)
        assertTrue(shown.done); assertTrue(shown.doors.all { it >= 1f })
        val late = medalsDoneAt(2) + 5_000
        assertEquals("a late receipt keeps the army time", pendingArmy, armyAt(victory, late))
        val afterLate = resultFrame(late + 10, victory, late, false)
        assertTrue("doors stay up while the late count runs", afterLate.doors.all { it >= 1f })
        assertFalse("and the count is not finished yet", afterLate.done)
    }

    @Test fun `a tap skips to the final state with final values, never inventing a count without a receipt`() {
        val skipped = resultFrame(200, victory, settledAtMs = 100, skipped = true)
        assertTrue(skipped.done); assertEquals(1f, skipped.count, 0f); assertTrue(skipped.coins.isEmpty())
        assertTrue(skipped.doors.all { it >= 1f }); assertTrue(skipped.stars.all { it >= 1f })
        assertEquals("skipped while pending: values stay …", 0f, resultFrame(200, victory, null, true).count, 0f)
        assertTrue(canSkip(1_500, victory, 0)); assertFalse(canSkip(60_000, victory, 0))
    }

    @Test fun `reduced motion shows everything in one cross-fade with no rays and no flight`() {
        val reduced = victory.copy(reduced = true)
        val mid = resultFrame(60, reduced, 0, false)
        assertTrue(mid.plate in 0.01f..0.99f); assertEquals(mid.plate, mid.doors[3], 0f)
        val end = resultFrame(ResultBeats.REDUCED_MS.toLong(), reduced, 0, false)
        assertTrue(end.done); assertEquals(0f, end.rays, 0f); assertTrue(end.coins.isEmpty()); assertEquals(1f, end.count, 0f)
    }

    @Test fun `the readout pulses once the coins land and rests at 1`() {
        val start = countStartAt(victory, 0)!!
        val landed = start + ResultBeats.COIN_MS + (ResultBeats.COINS - 1) * ResultBeats.COIN_STAGGER
        assertTrue(resultFrame(landed + ResultBeats.PULSE_MS / 2, victory, 0, false).pulse > 1.05f)
        assertEquals(1f, resultFrame(landed + ResultBeats.PULSE_MS + 1, victory, 0, false).pulse, 0f)
    }
}
