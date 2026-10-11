package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Assert.*
import org.junit.Test

class GlobeGestureStateTest {
    @Test fun `orphan move and up never claim a contact or select land`() {
        val state=GlobeGestureState(8.0)
        assertNull(state.drag(3,200,200));assertNull(state.up(3));assertEquals(0,state.contacts)
        state.down(1,100,100);state.clear()
        assertNull(state.drag(1,101,101));assertNull(state.up(1));assertEquals(0,state.contacts)
    }
    @Test fun `cancelled touch cannot be revived by a late up`() {
        val state=GlobeGestureState(8.0);state.down(1,100,100)
        assertTrue(state.cancel(1));assertNull(state.up(1));assertFalse(state.cancel(1))
        assertTrue(state.down(1,100,100));assertTrue(state.up(1)!!.tap)
    }
    @Test fun `pinch returning to one finger pans from its last owned position and never taps`() {
        val state=GlobeGestureState(8.0);state.down(1,100,100);state.down(2,200,100)
        assertEquals(1.5,state.drag(2,250,100)!!.scale,0.0)
        assertFalse(state.up(2)!!.settled)
        val delta=state.drag(1,110,105)!!;assertEquals(10,delta.dx);assertEquals(5,delta.dy);assertEquals(1.0,delta.scale,0.0)
        val end=state.up(1)!!;assertTrue(end.settled);assertFalse(end.tap)
    }
    @Test fun `Android cancellation of one pinch pointer ends the stream so the next finger pans and a fresh pinch works`() {
        val state=GlobeGestureState(8.0);state.down(0,100,100);state.down(1,200,100)
        state.drag(1,250,100)
        assertTrue(state.cancel(0));assertEquals(0,state.contacts)
        assertNull(state.drag(1,260,100));assertNull(state.up(1))
        assertTrue(state.down(0,100,100))
        val pan=state.drag(0,115,105)!!
        assertEquals(15,pan.dx);assertEquals(5,pan.dy);assertEquals(1.0,pan.scale,0.0)
        assertFalse(state.up(0)!!.tap)
        state.down(0,100,100);state.down(1,200,100)
        assertEquals(1.5,state.drag(1,250,100)!!.scale,0.0)
        assertFalse(state.up(1)!!.settled);assertFalse(state.up(0)!!.tap)
    }
    @Test fun `slow accumulated movement exceeds tap slop without a large individual delta`() {
        val state=GlobeGestureState(8.0);state.down(1,100,100)
        for(x in 101..112)state.drag(1,x,100)
        assertFalse(state.up(1)!!.tap)
    }
    @Test fun `an unowned third contact cannot move the pinch but Android cancellation still ends all contacts`() {
        val state=GlobeGestureState(8.0);state.down(1,100,100);state.down(2,200,100)
        assertFalse(state.down(3,300,100));assertNull(state.drag(3,400,200));assertNull(state.up(3))
        assertEquals(2,state.contacts);assertEquals(1.5,state.drag(2,250,100)!!.scale,0.0)
        assertFalse(state.cancel(3));assertEquals(0,state.contacts);assertNull(state.up(1));assertNull(state.up(2))
    }
}
