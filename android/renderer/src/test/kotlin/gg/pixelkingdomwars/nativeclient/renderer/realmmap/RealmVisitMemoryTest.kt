package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * P0 (2026-09-26): after ~14 minutes and nine realm visits on the owner's Seeker (256 MB Java heap growth limit) the
 * world-load workers threw OutOfMemoryError inside the exact PNG decoder, the host fell back to the legacy globe and that
 * failed too: realm data piled up instead of being released on leave. The rule this test holds the real engine and its
 * three lanes to, over the real stage-B bundle (FakeGl3; WebP decoded to size-true stand-ins):
 * - after a realm is left and evicted, nothing decoded for it is reachable and the realm's GL pool is empty, however
 *   many realms came before;
 * - while a realm is resident, the decoded images still reachable are only what drawing and `classAt` need (GROUND's
 *   fields), at most [RESIDENT_DECODED_BYTES]; the REALM pool holds one realm, at most [REALM_GL_BYTES];
 * - a realm released while its lanes are still loading leaves nothing behind, in the engine or in the lanes the host
 *   keeps reachable.
 */
class RealmVisitMemoryTest {
    private companion object {
        /** A resident realm's decoded images (the plan's bar; 58–76 MB of upload-only pixels were held before the fix). */
        const val RESIDENT_DECODED_BYTES = 16L shl 20
        /** One realm's REALM GL pool (frostveil, the largest, measured 82.6 MB). */
        const val REALM_GL_BYTES = 90L shl 20
        fun mb(b: Long) = "%.2f MB".format(b / 1048576.0)
    }

    private fun visitOrder(ids: List<String>): List<String> {
        // A, B, A, C, D, … over every realm, then every realm again: revisits and long tours both
        val first = listOf(ids[0], ids[1], ids[0]) + ids.drop(2)
        return first + ids
    }

    @Test fun everyRealmVisitReleasesWhatItDecodedAndTheResidentRealmHoldsOnlyWhatItDraws() {
        MemoryProbe.Decoded().install().use { decoded ->
            val w = RealWorld(DirectExecutor, decoded)
            val ids = RealmLoader(w.bundle, w.images).index().map { it.id }
            assertEquals(8, ids.size, "the stage-B bundle ships eight realms: $ids")
            var glPeak = 0L
            val report = StringBuilder()
            for ((i, id) in visitOrder(ids).withIndex()) {
                val visit = "${i + 1}:$id"; decoded.tag = visit
                assertTrue(w.engine.prepare(id), "prepare $id")
                var n = 0
                while (!w.engine.ready && n < 4000) { w.globeFrame(); glPeak = maxOf(glPeak, w.realmBytes); n++ }
                assertTrue(w.engine.ready, "$id dive-ready (status ${w.engine.status}, ${w.engine.stats.failure})")
                val g = w.engine.grid!!
                assertTrue(w.engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0), "enter $id")
                n = 0
                while (!(w.settled() && w.uploads.waiting == 0) && n < 4000) { w.realmFrame(); glPeak = maxOf(glPeak, w.realmBytes); n++ }
                assertTrue(w.settled(), "$id: the lanes settled (ground ${w.ground.stats.status}, life ${w.life.stats.why}, bases ${w.bases.stats.why})")
                assertTrue(w.ground.stats.status == "ready" && w.life.stats.loaded && w.bases.stats.loaded,
                    "$id: every lane loaded its art, or holding nothing proves nothing (ground ${w.ground.stats.status}, life ${w.life.stats.why}, bases ${w.bases.stats.why})")
                // the player looks around: MAP, TRUE and back (the lanes build their per-view state)
                w.engine.zoomBy(8.0); repeat(90) { w.realmFrame(); glPeak = maxOf(glPeak, w.realmBytes) }
                w.engine.zoomBy(4.0); repeat(90) { w.realmFrame(); glPeak = maxOf(glPeak, w.realmBytes) }
                w.engine.zoomBy(1 / 32.0); repeat(60) { w.realmFrame(); glPeak = maxOf(glPeak, w.realmBytes) }

                MemoryProbe.gc()
                val resident = decoded.aliveBytes(visit)
                val others = decoded.alive().filter { it.tag != visit }
                val lanes = w.lanes.joinToString { "${it.name} ${mb(w.heldPixels(it))}" }
                report.append("visit $visit: decoded ${mb(decoded.decodedBytes(visit))}, still reachable ${mb(resident)}; REALM GL ${mb(w.realmBytes)}; lanes hold $lanes\n")
                assertTrue(others.isEmpty(), "$id resident: decodes of earlier realms are reachable: ${others.map { "${it.tag} ${it.bytes}" }}\n$report")
                assertTrue(resident <= RESIDENT_DECODED_BYTES, "$id resident: ${mb(resident)} of decoded images reachable (≤ ${mb(RESIDENT_DECODED_BYTES)})\n$report")
                assertEquals(0L, w.heldPixels(w.life), "$id: LIFE keeps no pixels once uploaded: ${w.holders(w.life).take(5)}\n$report")
                assertEquals(0L, w.heldPixels(w.bases), "$id: BASES keeps no pixels once uploaded: ${w.holders(w.bases).take(5)}\n$report")

                w.engine.leave(w.now); w.engine.fade.finish()
                repeat(((w.config.evictMs + 1500.0) / 100.0).toInt()) { w.globeFrame(100.0) } // the globe idles at 10 fps
                assertEquals(null, w.engine.realmId, "$id evicted ${w.config.evictMs} ms after leave")
                assertEquals(0L, w.realmBytes, "$id evicted: the REALM pool is empty\n$report")
                MemoryProbe.gc { decoded.alive().isEmpty() }
                assertTrue(decoded.alive().isEmpty(), "$id evicted: decodes still reachable: ${decoded.alive().map { "${it.tag} ${it.bytes}" }}\n$report")
                for (lane in w.lanes) assertEquals(0L, w.heldPixels(lane), "$id evicted: ${lane.name} still holds pixels: ${w.holders(lane).take(5)}\n$report")
            }
            report.append("REALM GL peak ${mb(glPeak)}")
            println(report)
            assertTrue(glPeak <= REALM_GL_BYTES, "the REALM pool never holds more than one realm: peak ${mb(glPeak)}\n$report")
        }
    }

    @Test fun aRealmReleasedWhileItsLanesLoadLeavesNothingBehind() {
        MemoryProbe.Decoded().install().use { decoded ->
            val q = QueuedExecutor() // the world-load threads, run when the test says
            val w = RealWorld(q, decoded)
            val id = "crownlands"; decoded.tag = id
            assertTrue(w.engine.prepare(id))
            var n = 0
            while (!w.engine.ready && n < 2000) { q.runAll(); w.globeFrame(); n++ }
            assertTrue(w.engine.ready, "dive-ready")
            val g = w.engine.grid!!
            assertTrue(w.engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
            // the map is left and the realm released (the player went back to the globe, the host was disposed) while a
            // lane reads its sprite atlas on a worker; the lanes before it may have finished, the ones after not started
            var released = false
            w.bundle.onRead = { if (!released && it == "realm/$id/spr.png") { released = true; w.engine.leave(w.now); w.engine.fade.finish(); w.engine.release() } }
            n = 0
            while (!released && n < 2000) { q.runAll(); w.realmFrame(); n++ }
            assertTrue(released, "a lane read the sprite atlas while loading (ground ${w.ground.stats.status}, life ${w.life.stats.why}, bases ${w.bases.stats.why})")
            while (q.tasks.isNotEmpty()) q.runAll() // the loads in flight finish after the release
            repeat(10) { w.globeFrame() }
            assertEquals(null, w.engine.realmId)
            assertEquals(0L, w.realmBytes, "no realm texture survives the release")
            MemoryProbe.gc { decoded.alive().isEmpty() }
            assertTrue(decoded.alive().isEmpty(), "decodes of the released load are reachable: ${decoded.alive().map { "${it.tag} ${it.bytes}" }}")
            for (lane in w.lanes) assertEquals(0L, w.heldPixels(lane), "${lane.name} kept pixels of a load that finished after its release: ${w.holders(lane).take(5)}")
        }
    }
}
