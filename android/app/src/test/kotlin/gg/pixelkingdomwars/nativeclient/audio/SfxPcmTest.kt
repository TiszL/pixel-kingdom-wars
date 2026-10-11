package gg.pixelkingdomwars.nativeclient.audio

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

internal fun floatPcm(values: FloatArray) = ByteBuffer.allocate(values.size * 4).order(ByteOrder.nativeOrder()).apply {
    values.forEach { putFloat(it) }; flip()
}
internal fun pcm(budget: PcmBudget, values: FloatArray = floatArrayOf(.25f, .5f, .75f, 1f), rate: Int = 4, channels: Int = 1): PcmClip =
    PcmBuilder(budget, rate, channels).use { it.append(floatPcm(values), true); it.finish() }

class SfxPcmTest {
    @Test fun `four concurrent decoders reserve against one limit before allocating any page`() {
        val budget = PcmBudget(16); val start = CountDownLatch(1); val done = CountDownLatch(4)
        val pool = Executors.newFixedThreadPool(4); val accepted = AtomicInteger(); val rejected = AtomicInteger()
        val builders = java.util.Collections.synchronizedList(mutableListOf<PcmBuilder>())
        try {
            repeat(4) { pool.submit { try {
                val builder = PcmBuilder(budget, 4, 1); builders += builder; start.await()
                try { builder.append(floatPcm(floatArrayOf(.1f, .2f)), true); accepted.incrementAndGet() }
                catch (_: PcmCapacityException) { rejected.incrementAndGet() }
            } finally { done.countDown() } } }
            start.countDown(); assertTrue(done.await(5, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals(2, accepted.get()); assertEquals(2, rejected.get()); assertEquals(16L, budget.usedBytes())
        } finally { builders.forEach { it.close() }; pool.shutdownNow() }
        assertEquals(0L, budget.usedBytes())
    }
    @Test fun `oversized or invalid sample releases every partial page without exposing truncated audio`() {
        val budget = PcmBudget(12)
        PcmBuilder(budget, 4, 1).use { builder ->
            builder.append(floatPcm(floatArrayOf(.1f, .2f)), true)
            assertThrows(PcmCapacityException::class.java) { builder.append(floatPcm(floatArrayOf(.3f, .4f)), true) }
            assertEquals(8L, budget.usedBytes())
        }
        assertEquals(0L, budget.usedBytes())
        PcmBuilder(budget, 4, 1).use { builder ->
            assertThrows(IllegalArgumentException::class.java) { builder.append(floatPcm(floatArrayOf(Float.NaN)), true) }
        }
        assertEquals(0L, budget.usedBytes())
    }
    @Test fun `finished PCM keeps one reservation and reads every variable page in channel order`() {
        val budget = PcmBudget(32)
        val builder = PcmBuilder(budget, 4, 2)
        builder.append(floatPcm(floatArrayOf(.1f, .2f)), true)
        builder.append(floatPcm(floatArrayOf(.3f, .4f, .5f, .6f)), true)
        val clip = builder.finish(); builder.close()
        assertEquals(24L, budget.usedBytes()); assertEquals(3, clip.frames)
        assertEquals(.1f, clip.sample(0, 0)); assertEquals(.6f, clip.sample(2, 1))
        clip.close(); clip.close(); assertEquals(0L, budget.usedBytes())
    }
    @Test fun `signed 16bit PCM converts without losing the negative endpoint and partial stereo refuses`() {
        val budget = PcmBudget(32)
        PcmBuilder(budget, 4, 1).use { builder ->
            builder.append(ByteBuffer.allocate(4).order(ByteOrder.nativeOrder()).apply { putShort(Short.MIN_VALUE); putShort(Short.MAX_VALUE); flip() }, false)
            builder.finish().use { assertEquals(-1f, it.sample(0, 0)); assertEquals(32767f / 32768, it.sample(1, 0)) }
        }
        PcmBuilder(budget, 4, 2).use { builder ->
            assertThrows(IllegalArgumentException::class.java) { builder.append(ByteBuffer.allocate(2), false) }
        }
        assertEquals(0L, budget.usedBytes())
    }
    @Test fun `mixing reuses full PCM across voices and preserves source duration at another device rate`() {
        val budget = PcmBudget(16); val clip = pcm(budget)
        val mixer = SfxMixer(audioRuntime()); assertTrue(mixer.oneShot("cue", clip, 1f, AudioPriority.NORMAL, 0))
        val output = FloatArray(16); assertTrue(mixer.render(output, 8))
        assertArrayEquals(floatArrayOf(.25f,.25f,.375f,.375f,.5f,.5f,.625f,.625f,.75f,.75f,.875f,.875f,1f,1f,1f,1f), output, .00001f)
        mixer.render(FloatArray(2), 8); assertEquals(0, mixer.activeCount()); assertEquals(16L, budget.usedBytes())
        clip.close()
    }
    @Test fun `measured loop plays its prefix then repeats the range and shares maximum actor gain`() {
        val budget = PcmBudget(16); val clip = pcm(budget)
        val mixer = SfxMixer(audioRuntime()); val definition = AudioDefinition("loop", "loop.wav", .25, .75)
        val a = mixer.loop("loop", clip, definition, .25f); val b = mixer.loop("loop", clip, definition, .75f)
        assertEquals(1, mixer.activeCount()); assertEquals(1, mixer.retained("loop")); assertEquals(16L, budget.usedBytes())
        val first = FloatArray(12); mixer.render(first, 4)
        assertArrayEquals(floatArrayOf(.1875f,.1875f,.375f,.375f,.5625f,.5625f,.375f,.375f,.5625f,.5625f,.375f,.375f), first, .00001f)
        mixer.stopLoop("loop", b); val next = FloatArray(2); mixer.render(next, 4); assertEquals(.1875f, next[0])
        mixer.stopLoop("loop", b); assertEquals(1, mixer.activeCount())
        mixer.stopLoop("loop", a); assertEquals(0, mixer.activeCount()); clip.close()
    }
    @Test fun `loop outside decoded duration or MP3 without measured points refuses without retaining`() {
        val budget = PcmBudget(16); val clip = pcm(budget); val mixer = SfxMixer(audioRuntime())
        assertThrows(IllegalArgumentException::class.java) { mixer.loop("bad", clip, AudioDefinition("bad", "bad.mp3"), 1f) }
        assertThrows(IllegalArgumentException::class.java) { mixer.loop("bad", clip, AudioDefinition("bad", "bad.wav", 0.0, 2.0), 1f) }
        assertEquals(0, mixer.activeCount()); clip.close()
    }
    @Test fun `priority eviction and per cue limits apply to real mixer voices without extra PCM copies`() {
        val budget = PcmBudget(16); val clip = pcm(budget)
        val mixer = SfxMixer(audioRuntime().copy(maxOneShotVoices = 2, maxOneShotVoicesPerCue = 1))
        assertTrue(mixer.oneShot("a", clip, .1f, AudioPriority.CRITICAL, 0))
        assertTrue(mixer.oneShot("b", clip, .1f, AudioPriority.NORMAL, 30))
        assertFalse(mixer.oneShot("c", clip, .1f, AudioPriority.AMBIENT, 60))
        assertFalse(mixer.oneShot("a", clip, .1f, AudioPriority.NORMAL, 90))
        assertTrue(mixer.oneShot("c", clip, .1f, AudioPriority.CRITICAL, 120))
        assertEquals(0, mixer.retained("b")); assertEquals(2, mixer.activeCount()); assertEquals(16L, budget.usedBytes())
        mixer.stopAll(); val out = FloatArray(8) { 1f }; assertFalse(mixer.render(out, 4)); assertTrue(out.all { it == 0f })
        clip.close(); assertEquals(0L, budget.usedBytes())
    }
    @Test fun `resampled whole buffer loop interpolates its final frame toward the first frame`() {
        val clip = pcm(PcmBudget(16)); val mixer = SfxMixer(audioRuntime())
        mixer.loop("loop", clip, AudioDefinition("loop", "loop.wav"), 1f)
        val output = FloatArray(18); mixer.render(output, 8)
        assertEquals(1f, output[12], .00001f)
        assertEquals(.625f, output[14], .00001f) // Halfway from last1 to loop-start.25, not clamped1.
        assertEquals(.25f, output[16], .00001f)
        mixer.stopAll(); clip.close()
    }
    @Test fun `resampled measured loop excludes the following source sample while preserving the prefix`() {
        val clip = pcm(PcmBudget(16)); val mixer = SfxMixer(audioRuntime())
        mixer.loop("loop", clip, AudioDefinition("loop", "loop.wav", .25, .75), 1f)
        val output = FloatArray(14); mixer.render(output, 8)
        assertArrayEquals(floatArrayOf(.25f,.375f,.5f,.625f,.75f,.625f,.5f),
            output.filterIndexed { index, _ -> index % 2 == 0 }.toFloatArray(), .00001f)
        mixer.stopAll(); clip.close()
    }
    @Test fun `fractional loop endpoints become interpolated anchors and exclude fractional trailing content`() {
        val clip = pcm(PcmBudget(16)); val mixer = SfxMixer(audioRuntime())
        // Source-frame interval [1.25, 2.75), a 1.5-frame loop with a fractional seam.
        mixer.loop("loop", clip, AudioDefinition("loop", "loop.wav", .3125, .6875), 1f)
        val output = FloatArray(26); mixer.render(output, 16)
        val samples = output.filterIndexed { index, _ -> index % 2 == 0 }
        assertEquals(.5f, samples[4], .00001f) // Prefix frame1 remains original.
        assertEquals(.5625f, samples[5], .00001f) // Fractional start at1.25.
        assertEquals(.75f, samples[8], .00001f)
        assertEquals(.6875f, samples[9], .00001f) // Interpolate frame2 toward start at the exclusive2.75 end.
        assertEquals(.625f, samples[10], .00001f)
        assertEquals(.5625f, samples[11], .00001f) // Exact wrap at2.75 returns source1.25.
        assertEquals(.625f, samples[12], .00001f)
        mixer.stopAll(); clip.close()
    }

    @Test fun `slow PCM interpolation cannot hold Main controls or free its active reservation`() {
        val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val budget = PcmBudget(32); val clip = pcm(budget)
        val mixer = SfxMixer(audioRuntime()) { entered.countDown(); check(resume.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
        mixer.loop("loop", clip, AudioDefinition("loop", "loop.wav"), 1f)
        val output = FloatArray(16)
        val rendering = pool.submit<Boolean> { mixer.render(output, 8) }
        try {
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            // Main can mute/logout while the output worker is deliberately stalled. The
            // cache closes immediately, but PCM stays budgeted until that worker releases it.
            pool.submit { mixer.stopAll(); clip.close() }.get(1, java.util.concurrent.TimeUnit.SECONDS)
            assertEquals(0, mixer.activeCount()); assertEquals(1, mixer.retained("loop"))
            assertEquals(16L, budget.usedBytes())
            assertFalse(clip.retainForRender())
            resume.countDown(); assertTrue(rendering.get(5, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals(0L, budget.usedBytes()); assertEquals(0, mixer.retained("loop"))
            assertFalse(mixer.render(FloatArray(4), 8))
        } finally { resume.countDown(); pool.shutdownNow(); clip.close() }
    }

    @Test fun `stopped loop replacement during a block retains new gain and its own position`() {
        val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        val pool = Executors.newSingleThreadExecutor(); var first = true
        val clip = pcm(PcmBudget(16))
        val mixer = SfxMixer(audioRuntime()) { if (first) { first = false; entered.countDown(); check(resume.await(5, java.util.concurrent.TimeUnit.SECONDS)) } }
        val definition = AudioDefinition("loop", "loop.wav")
        val original = mixer.loop("loop", clip, definition, 1f)
        val rendering = pool.submit<Boolean> { mixer.render(FloatArray(8), 4) }
        try {
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            mixer.stopLoop("loop", original)
            mixer.loop("loop", clip, definition, .5f)
            resume.countDown(); rendering.get(5, java.util.concurrent.TimeUnit.SECONDS)
            val output = FloatArray(2); mixer.render(output, 4)
            assertEquals(.125f, output[0], .00001f) // New loop begins at its own prefix.
            assertEquals(1, mixer.activeCount())
        } finally { resume.countDown(); pool.shutdownNow(); mixer.stopAll(); clip.close() }
    }

}
