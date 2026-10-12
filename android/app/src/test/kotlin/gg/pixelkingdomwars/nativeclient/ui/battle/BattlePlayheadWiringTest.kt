package gg.pixelkingdomwars.nativeclient.ui.battle

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Owner 2026-10-11 (Seeker, code 33: after ATTACK the troops stood, then the battle played "accelerated"). The field now
 *  shows the battle a held lag behind the server clock (LiveBattlePlayback.kt). The two clocks must not swap: what the
 *  server decides (countdown, clock-due FINISH) stays on server time, and what the player watches (the field and the
 *  stars/destruction drawn over it) uses the shown time, in the attacker's view and the defender's WATCH LIVE alike. */
class BattlePlayheadWiringTest {
    private fun screens() = listOf(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/battle/BattleScreens.kt"),
        File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/battle/BattleScreens.kt")).first { it.isFile }.readText()

    @Test fun `the countdown and the clock due finish stay on server time`() {
        val source = screens()
        assertTrue("A lagged due check would send FINISH L seconds after the server deadline",
            source.contains("val clockDue = live.clock?.value?.let { it.anchorWallAt != null && playback.playhead >= it.durationMs } == true"))
        assertTrue("The attacker's countdown is the server deadline",
            source.contains("playback.playhead, live.clock?.value?.durationMs, deployTimer,"))
        assertTrue("The defender's clock is the server deadline too",
            source.contains("battleTimeLabel(playback.playhead, live.clock?.value?.durationMs)"))
    }

    @Test fun `the field and the progress drawn over it use the shown time in both views`() {
        val source = screens()
        assertEquals("Attacker and defender fields", 2,
            Regex("""livePlaybackScene\(active, playback\.rendererPlayhead,""").findAll(source).count())
        assertTrue("The renderer is given the shown time, not the server time",
            source.contains("liveShownPlayheadMs(live.clock, System.nanoTime(), lag, scene)) { preparationAttempt++ }"))
        assertEquals("Attacker and defender stars/destruction follow the field", 2,
            Regex("""floor\(playback\.shown / it\)""").findAll(source).count())
        assertFalse("No progress index reads the server clock (it would run L ahead of the field)",
            source.contains("floor(playback.playhead /"))
        // K-night-L2, 2026-10-12: the presentation-lag cap lives in livePresentationLagMs, so it reaches the defender's
        // WATCH LIVE only while both views share this one playback path.
        assertEquals("Attacker and defender share the one playback path (and so the lag cap)", 2,
            Regex("""val playback = rememberBattlePlayback\(""").findAll(source).count())
        assertTrue("The lag is fixed with the accepted scene, in the same snapshot",
            source.contains("lag = livePresentationLagMs(lag, candidate.takeIf { accepted === it }"))
    }
}
