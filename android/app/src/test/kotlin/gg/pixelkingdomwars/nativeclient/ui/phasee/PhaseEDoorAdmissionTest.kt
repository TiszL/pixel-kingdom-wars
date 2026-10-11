package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.model.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PhaseEDoorAdmissionTest {
    private val session=Any();private val content=Any()
    private fun identity()=PhaseEDoorIdentity(session,"wallet","home",3L,content)
    private fun base(construction:Boolean=false)=BaseSnapshot.from(Json.parseToJsonElement("""{
        "baseId":"home","player":{"keepLevel":5},"buildings":[{"id":"workshop","type":"workshop","level":1,"tx":0,"ty":0,"underConstruction":$construction}]
    }""").jsonObject)
    @Test fun `a cached callback is invalid after same-base round trip sign-out wallet or content replacement`() {
        val original=identity()
        for (replacement in listOf(original.copy(session=null),original.copy(session=Any()),original.copy(wallet="other"),
            original.copy(baseId="other"),original.copy(generation=5),original.copy(content=Any()))) {
            assertFalse(phaseEDoorIdentityCurrent(original,replacement))
        }
        assertTrue(phaseEDoorIdentityCurrent(original,identity()))
    }
    @Test fun `loss of foreground or server advertisement cannot launch from a retained snapshot`() {
        val capture=identity()
        assertTrue(phaseEDoorAdmitted(capture,identity(),base(),"workshop",true,true,false,true))
        assertFalse(phaseEDoorAdmitted(capture,identity(),base(),"workshop",false,true,false,true))
        assertFalse(phaseEDoorAdmitted(capture,identity(),base(),"workshop",true,false,false,true))
        assertFalse(phaseEDoorAdmitted(capture,identity(),base(),"workshop",true,true,true,true))
        assertFalse(phaseEDoorAdmitted(capture,identity(),base(),"workshop",true,true,false,false))
    }
    @Test fun `unrelated base construction and deleted facility cannot offer a new command`() {
        val capture=identity()
        assertFalse(phaseEDoorAdmitted(capture,identity(),base(true),"workshop",true,true,false,true))
        assertFalse(phaseEDoorAdmitted(capture,identity(),base().copy(baseId="other"),"workshop",true,true,false,true))
        assertFalse(phaseEDoorAdmitted(capture,identity(),base().copy(buildings=emptyList()),"workshop",true,true,false,true))
    }
}
