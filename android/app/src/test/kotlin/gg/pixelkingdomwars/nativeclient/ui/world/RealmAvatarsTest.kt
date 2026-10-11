package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/**
 * The realm map's name-tag pictures. Owner 2026-09-26, Seeker code 31: "on this range only player profile picture and
 * name should be visible, in efficient way". 82c91fc drew one castle sprite in every tag. Now each tag shows its player's
 * profile image, fetched as the chat fetches avatars. A map pans past hundreds of kingdoms, so the fetches must stay
 * bounded: one per picture, a few at once, a capped number kept, and no retry storm on a broken one. The fetch may only
 * ever reach the server's own avatar path: a feed value pointing anywhere else is never requested.
 *
 * Integration review of 560fe54: a tag asks for its picture ONCE (HudNametag's LaunchedEffect never relaunches while the
 * tag stays on screen), so the bounds must never cost an on-screen tag its picture. A load over the cap waits instead of
 * being dropped; a passing failure (the radio still reconnecting after an unlock) is retried, and only a definite miss
 * is remembered, for one map visit; the picture dropped first is the one shown least recently, never one on screen.
 * Every test here drives each tag's load() exactly once, as the HUD does.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealmAvatarsTest {
    private fun path(n: Int) = "/api/avatars/3f2b6c1e-9d7a-4c55-8a10-%012x.webp".format(n)

    @Test fun `only the server's own avatar path is ever fetched`() = runTest {
        val asked = ArrayList<String>()
        val avatars = RealmAvatars { p -> asked += p; "img:$p" }
        val good = path(1)
        for (bad in listOf("https://evil.example$good", "//evil.example$good", "/api/avatars/../session.webp", "$good?x=1",
            good.replace(".webp", ".png"), "/api/avatars/3f2b6c1e-9d7a-1c55-8a10-000000000001.webp", "/avatars/3f2b6c1e-9d7a-4c55-8a10-000000000001.webp", "")) {
            assertFalse("rejects $bad", RealmAvatars.accepts(bad))
            avatars.load(bad); assertNull(avatars.image(bad))
        }
        assertTrue("nothing outside the avatar path was requested: $asked", asked.isEmpty())
        avatars.load(good)
        assertEquals(listOf(good), asked); assertEquals("img:$good", avatars.image(good))
        assertNull("a kingdom without a picture has none (the tag draws the default portrait)", avatars.image(null))
    }

    @Test fun `sixteen tags asking once each all end with their pictures, four fetches at a time`() = runTest {
        // the owner's code-31 screen: a realm opened at map zoom publishes up to 16 tags in one frame, each asking once
        var inFlight = 0; var most = 0; val asked = ArrayList<String>()
        val avatars = RealmAvatars { p -> asked += p; inFlight++; most = maxOf(most, inFlight); delay(300); inFlight--; "img:$p" }
        val tags = (1..16).map { i -> launch { avatars.load(path(i)) } }
        launch { avatars.load(path(1)) } // a second tag of the same player (several kingdoms): no second fetch
        runCurrent()
        assertEquals("only ${RealmAvatars.LOADS} fetches start at once", RealmAvatars.LOADS, asked.size)
        advanceUntilIdle()
        assertTrue("every tag's single ask finished", tags.all { it.isCompleted })
        assertEquals("all 16 tags show their player's picture, none asked again", (1..16).map { "img:${path(it)}" }, (1..16).map { avatars.image(path(it)) })
        assertEquals("one fetch per picture", (1..16).map { path(it) }, asked)
        assertEquals("never more than ${RealmAvatars.LOADS} at once", RealmAvatars.LOADS, most)
    }

    @Test fun `a tag that leaves while waiting for a slot gives up its place, and a shared picture survives one tag leaving`() = runTest {
        val gate = CompletableDeferred<Unit>(); val asked = ArrayList<String>()
        val avatars = RealmAvatars { p -> asked += p; gate.await(); "img:$p" }
        val busy = (1..RealmAvatars.LOADS).map { launch { avatars.load(path(it)) } }
        val gone = launch { avatars.load(path(50)) }; runCurrent()
        gone.cancel(); runCurrent()
        gate.complete(Unit); advanceUntilIdle()
        assertTrue(busy.all { it.isCompleted })
        assertFalse("the tag that left was never fetched", path(50) in asked)
        assertNull(avatars.image(path(50)))
        // two tags, one player: the first tag leaves mid-fetch, the second must not be stranded without the picture
        val slow = CompletableDeferred<Unit>(); var calls = 0
        val shared = RealmAvatars { p -> calls++; slow.await(); "img:$p" }
        val first = launch { shared.load(path(7)) }; val second = launch { shared.load(path(7)) }; runCurrent()
        assertEquals("one fetch while both wait", 1, calls)
        first.cancel(); runCurrent()
        slow.complete(Unit); advanceUntilIdle()
        assertTrue(second.isCompleted)
        assertEquals("the tag still on screen took the load over", "img:${path(7)}", shared.image(path(7)))
        assertEquals(2, calls)
    }

    @Test fun `a passing failure is retried with a bounded backoff and never remembered`() = runTest {
        // unlock → the resume lands the map while the radio reconnects: those tags must still get their pictures
        val fails = ArrayDeque<Exception>(listOf(IOException("timeout"), ApiException(503, null, "busy"),
            IllegalArgumentException("Profile rules are not loaded")))
        var calls = 0
        val avatars = RealmAvatars { p -> calls++; fails.removeFirstOrNull()?.let { throw it }; "img:$p" }
        val tag = launch { avatars.load(path(1)) }; runCurrent()
        assertEquals(1, calls)
        advanceTimeBy(RealmAvatars.BACKOFF_MS[0] - 1); runCurrent()
        assertEquals("no retry before its backoff", 1, calls)
        advanceUntilIdle()
        assertTrue(tag.isCompleted)
        assertEquals("three passing failures, then the picture", 4, calls)
        assertEquals("img:${path(1)}", avatars.image(path(1)))
        // a server that asks for more time is given it (429 Retry-After), within the longest backoff
        var busyCalls = 0
        val limited = RealmAvatars { p -> busyCalls++; if (busyCalls == 1) throw ApiException(429, null, "slow down", retryAfterSeconds = 10); "img:$p" }
        launch { limited.load(path(2)) }; runCurrent()
        advanceTimeBy(9_999); runCurrent()
        assertEquals("the server's 10 s are honoured", 1, busyCalls)
        advanceUntilIdle()
        assertEquals("img:${path(2)}", limited.image(path(2)))
        // bounded: an outage stops after the last backoff, and the tag's next ask (it came back) tries again
        var downCalls = 0
        val down = RealmAvatars<String> { downCalls++; throw IOException("offline") }
        val gaveUp = launch { down.load(path(3)) }; advanceUntilIdle()
        assertTrue(gaveUp.isCompleted)
        assertEquals("one try and one per backoff, then it stops", RealmAvatars.BACKOFF_MS.size + 1, downCalls)
        down.load(path(3))
        assertEquals("a passing failure is not remembered", 2 * (RealmAvatars.BACKOFF_MS.size + 1), downCalls)
    }

    @Test fun `a definite miss is fetched once and remembered for this map visit only`() = runTest {
        val misses = mapOf(path(1) to ApiException(404, null, "gone"), path(2) to ApiException(410, null, "gone"),
            path(3) to ApiCompatibilityException(path(3)), path(4) to RealmAvatars.Unusable("did not decode"))
        val asked = ArrayList<String>()
        val avatars = RealmAvatars { p -> asked += p; misses[p]?.let { throw it }; "img:$p" }
        for (p in misses.keys) repeat(3) { avatars.load(p) }
        assertEquals("each miss asked once: no backoff retries, no retry on every recomposition", misses.keys.toList(), asked)
        repeat(3) { avatars.load(path(9)) }
        assertEquals("a picture already shown is not fetched again", misses.keys.toList() + path(9), asked)
        val visit = avatars.visit
        avatars.clear()
        assertNotEquals("a new visit: a tag still composed asks again", visit, avatars.visit)
        assertNull("nothing decoded outlives the visit", avatars.image(path(9)))
        avatars.load(path(1))
        assertEquals("the next visit asks the missing picture again", 2, asked.count { it == path(1) })
    }

    @Test fun `the visit's end drops a picture still loading, and a cancelled load may run again`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val avatars = RealmAvatars { p -> gate.await(); "img:$p" }
        val old = launch { avatars.load(path(1)) }; runCurrent()
        avatars.clear()
        gate.complete(Unit); advanceUntilIdle()
        assertTrue(old.isCompleted)
        assertNull("a result that lands after the stop is discarded", avatars.image(path(1)))
        avatars.load(path(1))
        assertEquals("img:${path(1)}", avatars.image(path(1)))
        // a tag that leaves the screen cancels its load: that is not a failure, the picture loads when the tag is back
        val later = CompletableDeferred<Unit>()
        val slow = RealmAvatars { p -> later.await(); "img:$p" }
        val job = launch { slow.load(path(2)) }; runCurrent(); job.cancel(); runCurrent()
        later.complete(Unit)
        slow.load(path(2))
        assertEquals("img:${path(2)}", slow.image(path(2)))
    }

    @Test fun `a picture still on screen is never the one dropped`() = runTest {
        // your own tag stays in view (it is clamped into the box) while a long pan cycles the neighbours' tags past it
        var ownFetches = 0
        val avatars = RealmAvatars { p -> if (p == path(1)) ownFetches++; "img:$p" }
        avatars.load(path(1))
        for (i in 2..RealmAvatars.HELD + 40) {
            assertEquals("i=$i: your tag redraws with its picture", "img:${path(1)}", avatars.image(path(1))) // each landing recomposes it
            avatars.load(path(i))
        }
        assertEquals("your picture was kept, never re-downloaded", 1, ownFetches)
        assertNull("the pictures that left the screen longest ago went instead", avatars.image(path(2)))
        assertEquals("img:${path(RealmAvatars.HELD + 40)}", avatars.image(path(RealmAvatars.HELD + 40)))
    }

    @Test fun `a long pan keeps only the most recent pictures`() = runTest {
        val avatars = RealmAvatars { p -> "img:$p" }
        val n = RealmAvatars.HELD + 10
        for (i in 1..n) avatars.load(path(i))
        assertTrue("more than the 16 tags a map shows at once stay held", RealmAvatars.HELD > 16)
        assertEquals("the oldest pictures were dropped", List(10) { null }, (1..10).map { avatars.image(path(it)) })
        assertEquals((11..n).map { "img:${path(it)}" }, (11..n).map { avatars.image(path(it)) })
        avatars.load(path(1))
        assertEquals("a dropped picture loads again when its tag comes back", "img:${path(1)}", avatars.image(path(1)))
    }
}
