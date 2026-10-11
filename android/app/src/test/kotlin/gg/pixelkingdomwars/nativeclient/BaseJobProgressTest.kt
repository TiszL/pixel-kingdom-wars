package gg.pixelkingdomwars.nativeclient

import org.junit.Assert.*
import org.junit.Test

class BaseJobProgressTest {
    @Test fun `elapsed deadline asks server to verify instead of claiming construction finished`() {
        val progress=baseJobProgress("1970-01-01T00:00:00Z","1970-01-01T00:01:00Z",90_000)!!
        assertEquals("Finishing…",progress.remaining)
        assertEquals(1f,progress.fraction,0f)
    }
    @Test fun `clock skew clamps progress and subsecond deadlines remain pending`() {
        assertEquals(0f,baseJobProgress("1970-01-01T00:00:10Z","1970-01-01T00:01:00Z",0)!!.fraction,0f)
        assertEquals("1s remaining",baseJobProgress("1970-01-01T00:00:00Z","1970-01-01T00:01:00Z",59_999)!!.remaining)
    }
    @Test fun `invalid or missing server deadlines do not become fabricated progress`() {
        assertNull(baseJobProgress(null,"1970-01-01T00:01:00Z",0))
        assertNull(baseJobProgress("1970-01-01T00:01:00Z","1970-01-01T00:00:00Z",0))
    }
}
