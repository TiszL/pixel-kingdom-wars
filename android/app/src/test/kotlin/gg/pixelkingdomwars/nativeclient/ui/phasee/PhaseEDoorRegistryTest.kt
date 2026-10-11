package gg.pixelkingdomwars.nativeclient.ui.phasee

import org.junit.Assert.*
import org.junit.Test

/** Missing new methods are assertion-RED on the baseline; no production stub or test-only registry is supplied. */
class PhaseEDoorRegistryTest {
    private fun method(name:String)=PhaseEActivityRegistry::class.java.declaredMethods.singleOrNull{it.name.substringBefore('$')==name}
        .also { assertNotNull("The single activity registry must implement $name",it) }!!.apply { isAccessible=true }
    private fun launch(r:PhaseEActivityRegistry,a:PhaseEActivity)=method("launch").invoke(r,a) as Boolean
    private fun door(r:PhaseEActivityRegistry,a:PhaseEActivity,owner:Any,allowed:()->Boolean={true},primary:()->Unit={},history:(()->Unit)?=null) {
        method("registerDoor").invoke(r,a,owner,allowed,primary,history)
    }
    @Test fun `a building can launch its current owner without opening the activity menu`() {
        val r=PhaseEActivityRegistry();var opens=0
        door(r,PhaseEActivity.WORKSHOP,Any(),primary={opens++})
        assertTrue(r.available.isEmpty());assertTrue(launch(r,PhaseEActivity.WORKSHOP));assertEquals(1,opens)
    }
    @Test fun `saved history opens only its read path even when the building is gone`() {
        val r=PhaseEActivityRegistry();var reads=0;var writes=0
        door(r,PhaseEActivity.VEHICLES,Any(),allowed={false},primary={writes++},history={reads++})
        assertEquals(listOf(PhaseEActivity.VEHICLES),r.available)
        assertFalse(launch(r,PhaseEActivity.VEHICLES));r.open();assertTrue(r.choose(PhaseEActivity.VEHICLES))
        assertEquals(1,reads);assertEquals(0,writes)
    }
    @Test fun `advertised new work with no saved history never becomes a secondary menu row`() {
        val r=PhaseEActivityRegistry();var opens=0
        door(r,PhaseEActivity.KEEP_MARKET,Any(),primary={opens++})
        r.open();assertFalse(r.expanded);assertFalse(r.choose(PhaseEActivity.KEEP_MARKET));assertEquals(0,opens)
    }
    @Test fun `a live guard rejects stale base session lifecycle and capability before callback`() {
        val r=PhaseEActivityRegistry();var eligible=true;var opens=0
        door(r,PhaseEActivity.WORKSHOP,Any(),allowed={eligible},primary={opens++})
        eligible=false;assertFalse(launch(r,PhaseEActivity.WORKSHOP));assertEquals(0,opens)
        eligible=true;assertTrue(launch(r,PhaseEActivity.WORKSHOP));assertEquals(1,opens)
        r.dispose();assertFalse(launch(r,PhaseEActivity.WORKSHOP));assertEquals(1,opens)
    }
    @Test fun `retired mount disposal cannot erase or invoke a replacement primary callback`() {
        val r=PhaseEActivityRegistry();val old=Any();val replacement=Any();var opens=0
        door(r,PhaseEActivity.WORKSHOP,old,primary={fail("Retired primary callback")})
        door(r,PhaseEActivity.WORKSHOP,replacement,primary={opens++})
        r.unregister(PhaseEActivity.WORKSHOP,old);assertTrue(launch(r,PhaseEActivity.WORKSHOP));assertEquals(1,opens)
        r.unregister(PhaseEActivity.WORKSHOP,replacement);assertFalse(launch(r,PhaseEActivity.WORKSHOP))
    }
    @Test fun `secondary selection closes before the read callback and rejects double taps`() {
        val r=PhaseEActivityRegistry();var reads=0
        door(r,PhaseEActivity.WORKSHOP,Any(),history={assertFalse(r.expanded);reads++})
        r.open();assertTrue(r.choose(PhaseEActivity.WORKSHOP));assertFalse(r.choose(PhaseEActivity.WORKSHOP));assertEquals(1,reads)
    }
}
