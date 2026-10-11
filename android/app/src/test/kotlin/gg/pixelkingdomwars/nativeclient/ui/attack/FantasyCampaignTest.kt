package gg.pixelkingdomwars.nativeclient.ui.attack

import gg.pixelkingdomwars.nativeclient.data.WorldContentPhase
import gg.pixelkingdomwars.nativeclient.data.WorldContentProgress
import gg.pixelkingdomwars.nativeclient.model.CampaignStage
import gg.pixelkingdomwars.nativeclient.model.CampaignState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class FantasyCampaignTest {
    private fun raw()=File("src/main/res/raw/pkw_campaign_presentation.json").readText()
    private fun stage(id:Int,act:Int?=1,stars:Int=0,unlocked:Boolean=false)=CampaignStage(stage=id,act=act,name="Server stage $id",bestStars=stars,unlocked=unlocked)
    @Test fun `authored source receipt and all chapter routes keep existing stage identities`() {
        val bytes=File("src/main/res/raw/pkw_campaign_presentation.json").readBytes()
        val provenance=Json.parseToJsonElement(File("src/main/res/raw/pkw_campaign_provenance.json").readText()).jsonObject
        assertEquals(provenance.getValue("sha256").jsonPrimitive.content,MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)})
        val art=CampaignArtwork.read(raw());val names=mutableSetOf<String>()
        art.chapters.forEach { chapter->chapter.names.indices.forEach { index->
            val stage=stage((chapter.id-1)*chapter.names.size+index+1,chapter.id)
            assertEquals(chapter.names[index],art.name(stage,chapter.names.size));names+=art.name(stage,chapter.names.size)
            val point=requireNotNull(art.point(stage,chapter.names.size))
            assertTrue(point.first>0&&point.first<1&&point.second>0&&point.second<1)
        } }
        assertEquals(art.chapters.sumOf { it.names.size },names.size)
        assertEquals(listOf("crownlands","crownlands","elderwood","elderwood","sunscar","sunscar","frostveil","frostveil","crownlands","frostveil"),art.chapters.map { it.region })
    }
    @Test fun `unknown act or catalogue keeps server name and never invents route positions`() {
        val art=CampaignArtwork.read(raw())
        assertEquals("Server stage 1",art.name(stage(1,999),10));assertNull(art.point(stage(1,999),10))
        assertEquals("Server stage 1",art.name(stage(1),null));assertNull(art.point(stage(1),null))
    }
    @Test fun `selection lost after deed change returns current server frontier rather than former numeric stage`() {
        val first=listOf(stage(1,stars=3,unlocked=true),stage(2,unlocked=true),stage(3))
        assertEquals(2,campaignSelection(first,null)?.stage)
        assertEquals(3,campaignSelection(first,3)?.stage) // Locked stages remain inspectable, never implicitly unlocked.
        val replacement=listOf(stage(1,unlocked=true))
        assertEquals(1,campaignSelection(replacement,3)?.stage);assertNull(campaignSelection(emptyList(),3))
        assertEquals("locked",campaignStageState(first.last()));assertEquals("available",campaignStageState(first[1]));assertEquals("cleared",campaignStageState(first[0]))
    }
    @Test fun `reward is selected Keep catalogue value and missing data remains unknown`() {
        val constants=Json.parseToJsonElement("""{"CAMPAIGN":{"firstThreeStarShardsByKeep":[120,450]}}""").jsonObject
        assertEquals("450",campaignReward(constants,stage(1).copy(keepLevel=2)))
        assertNull(campaignReward(constants,stage(1)));assertNull(campaignReward(constants,stage(1).copy(keepLevel=3)));assertNull(campaignReward(null,stage(1).copy(keepLevel=1)))
    }
    @Test fun `phone flows and short landscape separates route from details at source breakpoints`() {
        assertTrue(campaignFlow(390f,844f));assertTrue(campaignFlow(575f,1280f));assertFalse(campaignFlow(844f,390f));assertFalse(campaignFlow(1440f,900f))
        assertTrue(campaignFlow(599f,480f));assertFalse(campaignFlow(600f,480f))
    }
    @Test fun `region decode refuses out of bounds crops before touching texture memory`() {
        val region=CampaignArtwork.read(raw()).regions.getValue("crownlands")
        assertTrue(region.inside(768,384));assertFalse(region.inside(500,384));assertFalse(region.copy(crop=listOf(Int.MAX_VALUE,0,100,100)).inside(768,384))
    }
    @Test fun `new display fields do not require old campaign histories to contain them`() {
        val state=CampaignState.from(Json.parseToJsonElement("""{"stages":[{"stage":1,"name":"Old","unlocked":true},{"stage":2,"name":"New","profile":"FORTRESS","defenderHero":"vex"}]}""").jsonObject)
        assertNull(state.stages[0].profile);assertNull(state.stages[0].defenderHero)
        assertEquals("FORTRESS",state.stages[1].profile);assertEquals("vex",state.stages[1].defenderHero)
    }

    @Test fun `route names the pending map art instead of showing a bare field`() {
        // WHY (owner 2026-09-17): the Seeker rendered the campaign as a flat ground colour with faint nodes for minutes
        // because the optional globe generation was still arriving and nothing said so.
        assertEquals("PREPARING MAP ART",campaignArtStatus(hasImage=false,artError=false,leased=false,progress=null))
        assertEquals("DOWNLOADING MAP ART · 3/40",campaignArtStatus(false,false,false,WorldContentProgress(WorldContentPhase.DOWNLOADING,3,40)))
        assertEquals("VERIFYING MAP ART · 40/40",campaignArtStatus(false,false,false,WorldContentProgress(WorldContentPhase.VERIFYING,40,40)))
        assertEquals("DRAWING THE ROAD",campaignArtStatus(false,false,true,WorldContentProgress(WorldContentPhase.READY,40,40)))
        assertNull(campaignArtStatus(true,false,true,null)) // the art itself is the status
        assertNull(campaignArtStatus(false,true,false,null)) // the error line with RETRY MAP owns this case
    }
}
