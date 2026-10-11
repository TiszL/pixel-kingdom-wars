package gg.pixelkingdomwars.nativeclient.diagnostics

import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SceneLoadLogTest {
    @Before fun start() { SceneLoadLog.sink = null; SceneLoadLog.reset() }
    @After fun finish() { SceneLoadLog.sink = null; SceneLoadLog.reset() }

    @Test fun `marks count per event and reset clears them`() {
        assertTrue(SceneLoadLog.snapshot().values.all { it == 0 })
        SceneLoadLog.mark(LoadEvent.FRAGMENT_CREATE)
        SceneLoadLog.mark(LoadEvent.FRAGMENT_CREATE)
        SceneLoadLog.mark(LoadEvent.FRAGMENT_REMOVE)
        assertEquals(2, SceneLoadLog.count(LoadEvent.FRAGMENT_CREATE))
        assertEquals(1, SceneLoadLog.count(LoadEvent.FRAGMENT_REMOVE))
        assertEquals(0, SceneLoadLog.count(LoadEvent.SCENE_MAP))
        SceneLoadLog.reset()
        assertTrue(SceneLoadLog.snapshot().values.all { it == 0 })
    }

    @Test fun `http detail never carries query strings or identifiers`() {
        assertEquals("/base", SceneLoadLog.httpDetail("/base?baseId=Abc123"))
        assertEquals("/mail/:id/claim", SceneLoadLog.httpDetail("/mail/9f2c.../claim"))
        assertEquals("/wallet/:id", SceneLoadLog.httpDetail("/wallet/AbCd123456"))
        assertEquals("/mail/:id/claim", SceneLoadLog.httpDetail("/mail/alllowercasesecret/claim?token=secret"))
        assertEquals("/base/:id/:id", SceneLoadLog.httpDetail("/base/123/ABC/fourth"))
        assertEquals("/mail", SceneLoadLog.httpDetail("/mail#private"))
    }

    @Test fun `mark without a sink never touches android`() {
        SceneLoadLog.mark(LoadEvent.SCENE_MAP)
        assertEquals(1, SceneLoadLog.count(LoadEvent.SCENE_MAP))
    }

    @Test fun `frames are counted without emitting a log for every frame`() {
        val lines = mutableListOf<String>()
        SceneLoadLog.sink = lines::add
        repeat(12) { SceneLoadLog.mark(LoadEvent.GL_FRAME) }
        SceneLoadLog.mark(LoadEvent.PARK)
        assertEquals(12, SceneLoadLog.count(LoadEvent.GL_FRAME))
        assertEquals(listOf("PARK"), lines)
    }

    @Test fun `a failing diagnostic sink cannot break gameplay`() {
        SceneLoadLog.sink = { error("log unavailable") }
        SceneLoadLog.mark(LoadEvent.SCENE_SUBMIT)
        assertEquals(1, SceneLoadLog.count(LoadEvent.SCENE_SUBMIT))
    }
}
