package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.ui.battle.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BattleChromeTest {
    private val catalogue = Json.parseToJsonElement("""{"constants":{"DEFENSES":{"pitfall":{"oneUse":true}},"ART_V2":{"tiers":4,"levelsPerTier":5}}}""").jsonObject
    private fun building(id: String, type: String, hp: Long?, max: Long? = hp) = RenderBuilding(id, "art", 0f, 0f, 1f, 1f, hp, max, type)
    private fun scene(buildings: List<RenderBuilding>, vararg events: String) = BattleScene(BaseScene(buildings,16,16,64f),
        PresentationRevision("raid","one",14,0,0,events.map(PresentationEvent::fromJson)), emptyMap(),256f,100f,10,10)

    @Test fun `live percentage uses canonical damage weighted by HP while walls and traps never inflate it`() {
        val hud = BattleHudProgress(scene(listOf(building("keep","keep",300),building("mine","mine",100),building("wall","wall",500),building("trap","pitfall",200)),
            """{"t":1,"e":"hit","target":"keep","dmg":100}""",
            """{"t":2,"e":"destroyed","id":"wall"}""",
            """{"t":3,"e":"destroyed","id":"trap"}""",
            """{"t":4,"e":"destroyed","id":"mine"}"""), catalogue)
        assertEquals(0 to 0, hud.at(0f))
        assertEquals(0 to 25, hud.at(1f))
        assertEquals(0 to 25, hud.at(3f))
        assertEquals(0 to 50, hud.at(4f))
    }

    @Test fun `future stars stay hidden and a corrected prefix can lower previously rendered progress`() {
        val buildings = listOf(building("keep","keep",100))
        val hud = BattleHudProgress(scene(buildings, """{"t":10,"e":"hit","target":"keep","dmg":50}""", """{"t":10,"e":"star","n":1}""", """{"t":20,"e":"star","n":2}"""),catalogue)
        assertEquals(0 to 0,hud.at(9f))
        assertEquals(1 to 50,hud.at(10f))
        assertEquals(2 to 50,hud.at(20f))
        assertEquals(0 to 0,hud.at(0f))
        val corrected = BattleHudProgress(scene(buildings),catalogue)
        assertEquals(0 to 0,corrected.at(20f))
    }

    @Test fun `missing health or trap metadata remains unknown instead of claiming zero destruction`() {
        assertNull(BattleHudProgress(scene(listOf(building("keep","keep",null))), catalogue).at(0f).second)
        assertNull(BattleHudProgress(scene(listOf(building("keep","keep",100))), null).at(0f).second)
        assertNull(BattleHudProgress(scene(listOf(building("keep","keep",100),building("mine","mine",null))),catalogue).at(0f).second)
    }

    @Test fun `field ledger counts only attacker bodies so an empty field under a running clock is named honestly`() {
        val hud = BattleHudProgress(scene(listOf(building("keep","keep",100)),
            """{"t":1,"e":"deploy","id":1,"troop":"bowman","x":1,"y":1}""",
            """{"t":1,"e":"deploy","id":2,"troop":"highlander","hero":"theodor","side":"defender","x":1,"y":1}""",
            """{"t":2,"e":"spawn","id":3,"from":"nest","troop":"wyrmling","x":1,"y":1}""",
            """{"t":3,"e":"troopSpawn","id":4,"from":1,"troop":"barrowling","level":1,"variant":0,"x":1,"y":1}""",
            """{"t":4,"e":"troopDeath","id":2}""",
            """{"t":5,"e":"troopDeath","id":1}""",
            """{"t":6,"e":"troopDeath","id":4}"""), catalogue)
        assertEquals(BattleHudProgress.Field(0,0), hud.fieldAt(0f))
        assertEquals(BattleHudProgress.Field(1,1), hud.fieldAt(1f))
        assertEquals("defender spawns and heroes never count", BattleHudProgress.Field(1,1), hud.fieldAt(2f))
        assertEquals(BattleHudProgress.Field(2,2), hud.fieldAt(3f))
        assertEquals("a defender death cannot empty the attacker's field", BattleHudProgress.Field(2,2), hud.fieldAt(4f))
        assertEquals(BattleHudProgress.Field(2,1), hud.fieldAt(5f))
        assertEquals(BattleHudProgress.Field(2,0), hud.fieldAt(6.5f))
    }

    @Test fun `hero art uses the frozen real level and leaves unknown levels on the original portrait`() {
        assertEquals("hero_vex_portrait",battleHeroPortrait(catalogue,"vex",null))
        assertEquals("hero_vex_portrait",battleHeroPortrait(catalogue,"vex",15))
        assertEquals("hero_vex_portrait_t4",battleHeroPortrait(catalogue,"vex",16))
        assertEquals("hero_theo_portrait_t4",battleHeroPortrait(catalogue,"theodor",20))
        assertEquals("hero_theo_portrait",battleHeroPortrait(null,"theodor",20))
    }

    @Test fun `timer uses the server duration and cannot run past it or invent a missing maximum`() {
        assertEquals("0:05 / 1:30",battleTimeLabel(5_999.0,90_000))
        assertEquals("1:30 / 1:30",battleTimeLabel(99_000.0,90_000))
        assertEquals("0:00 / 1:30",battleTimeLabel(-10.0,90_000))
        assertEquals("0:05 / —",battleTimeLabel(5_000.0,null))
    }
    @Test fun `replay reveal waits for measured chrome before exposing camera targets over its footer`() {
        assertNull(battleCameraRailPlacement(412f,915f,160f,null,10f))
        assertNull(battleCameraRailPlacement(412f,915f,null,60f,10f))
        val rail=requireNotNull(battleCameraRailPlacement(412f,915f,160f,60f,10f))
        assertFalse(rail.horizontal)
        assertTrue(rail.top>=160f)
        assertEquals(845f,rail.top+rail.height,0f)
        assertTrue(rail.top+rail.height<915f-60f) // Fit must end above RESULT's measured row, including safe padding.
    }

    @Test fun `larger replay footers and short landscape keep targets separate or fall back to Details`() {
        for(footer in listOf(60f,110f,170f)) {
            val rail=requireNotNull(battleCameraRailPlacement(412f,915f,160f,footer,10f))
            assertTrue(rail.top>=160f)
            assertEquals(915f-footer-10f,rail.top+rail.height,0f)
        }
        val landscape=requireNotNull(battleCameraRailPlacement(915f,412f,160f,150f,10f))
        assertTrue(landscape.horizontal)
        assertEquals(48f,landscape.height,0f)
        assertTrue(landscape.top>=160f && landscape.top+landscape.height<=252f)
        assertNull(battleCameraRailPlacement(915f,300f,160f,90f,10f))
        assertNull(battleCameraRailPlacement(412f,915f,Float.NaN,60f,10f))
    }

}
