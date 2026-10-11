package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*

class GroundReuseAdmissionTest {
    @Test fun `reuse prepared against A cannot commit B when a prior scene changes the painting`() {
        val reuse = GroundReuseAdmission("realm-A:window-7")
        var repairs = 0
        assertFalse(reuse.prepareIfChanged("realm-A:window-7") { repairs++ })
        // The older GL activation passed its generation check before this worker read A, then committed B.
        repeat(20) { assertTrue(reuse.prepareIfChanged("realm-B:window-2") { repairs++ },"Keep must never admit the wrong painting") }
        assertEquals(1,repairs,"While the current scene remains visible, rendering cannot enqueue a repair every frame")
    }

    @Test fun `same admitted window reuses pixels while missing ground requires a real preparation`() {
        val reuse = GroundReuseAdmission("realm-A:window-7")
        var repairs = 0
        repeat(20) { assertFalse(reuse.prepareIfChanged("realm-A:window-7") { repairs++ }) }
        assertEquals(0,repairs,"Ordinary revisions must not decode and upload the unchanged large painting")
        assertTrue(reuse.prepareIfChanged(null) { repairs++ })
        assertEquals(1,repairs)
    }
}
