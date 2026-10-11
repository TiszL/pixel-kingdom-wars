package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Graphics
import com.badlogic.gdx.Input
import com.badlogic.gdx.InputProcessor
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.OrthographicCamera
import com.badlogic.gdx.math.Matrix4
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.viewport.ScreenViewport
import org.junit.Assert.*
import org.junit.Test
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicLong

/** Exercises the actual input processor. The camera holds a previously rendered projection;
 * this JVM test performs no GL render, artwork load, platform touch delivery or device claim. */
class WallStrokeRendererTest {
    private fun field(renderer: NativeGameRenderer, name: String) = renderer.javaClass.getDeclaredField(name).apply { isAccessible = true }
    @Suppress("UNCHECKED_CAST") private fun <T> stub(type: Class<T>): T = Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, _ ->
        when (method.returnType) { java.lang.Integer.TYPE -> 120; java.lang.Boolean.TYPE -> false; java.lang.Float.TYPE -> 1f; else -> null }
    } as T
    private fun fixture(block: (NativeGameRenderer, InputProcessor, OrthographicCamera, MutableList<WallStrokeEvent>, MutableList<String>) -> Unit) {
        val oldGraphics = Gdx.graphics; val oldInput = Gdx.input
        Gdx.graphics = stub(Graphics::class.java); Gdx.input = stub(Input::class.java)
        val events = mutableListOf<WallStrokeEvent>(); val taps = mutableListOf<String>()
        val renderer = NativeGameRenderer(FileHandle("unused-headless-assets"), { taps += "building" },
            onGroundSelected = { _, _ -> taps += "ground" }, onWallStroke = { events += it })
        try {
            val camera = object : OrthographicCamera() { override fun update() {} }
            camera.position.set(6f, 6f, 0f)
            camera.invProjectionView.idt().also { matrix ->
                matrix.`val`[Matrix4.M00] = 6f; matrix.`val`[Matrix4.M03] = 6f
                matrix.`val`[Matrix4.M11] = -6f; matrix.`val`[Matrix4.M13] = 6f
            }
            field(renderer, "camera").set(renderer, camera)
            (field(renderer, "viewport").get(renderer) as ScreenViewport).apply { setCamera(camera); setScreenBounds(0, 0, 120, 120) }
            field(renderer, "scene").set(renderer, BaseScene(emptyList(), 12, 12, 1f, baseId = "A"))
            field(renderer, "sceneToken").setLong(renderer, 1)
            field(renderer, "renderedSceneToken").setLong(renderer, 1)
            (field(renderer, "generation").get(renderer) as AtomicLong).set(1)
            renderer.setWallStrokeMode(WallStrokeMode("draw", "A", 12, 12, 1, 1,
                (0 until 12).flatMap { y -> (0 until 12).map { x -> WallStrokeTile(x, y) } }.toSet()))
            block(renderer, field(renderer, "input").get(renderer) as InputProcessor, camera, events, taps)
        } finally { renderer.dispose(); Gdx.graphics = oldGraphics; Gdx.input = oldInput }
    }
    @Test fun `actual wall input suppresses camera pan and tap dispatch and emits one sampled release`() = fixture { _, input, camera, events, taps ->
        input.touchDown(20, 20, 0, Input.Buttons.LEFT)
        input.touchDragged(30, 20, 0); input.touchDragged(90, 20, 0)
        assertEquals(6f, camera.position.x); assertEquals(6f, camera.position.y)
        input.touchUp(100, 20, 0, Input.Buttons.LEFT)
        assertEquals(listOf(WallStrokeTile(3, 2), WallStrokeTile(9, 2)), events.filterIsInstance<WallStrokeEvent.Released>().single().tiles)
        assertTrue(taps.isEmpty())
    }
    @Test fun `actual pinch cancels walls and routes remaining drag to camera without accidental ground order`() = fixture { _, input, camera, events, taps ->
        input.touchDown(20, 20, 0, Input.Buttons.LEFT); input.touchDragged(30, 20, 0)
        input.touchDown(70, 20, 1, Input.Buttons.LEFT); input.touchDragged(90, 20, 1)
        assertTrue(camera.zoom < 1f); input.touchUp(90, 20, 1, Input.Buttons.LEFT)
        input.touchDragged(40, 20, 0); input.touchUp(40, 20, 0, Input.Buttons.LEFT)
        assertTrue(events.filterIsInstance<WallStrokeEvent.Released>().isEmpty()); assertTrue(taps.isEmpty())
    }
    @Test fun `real unready scene pause mode revocation and outside release refuse the pending batch`() {
        for (cancel in 0..3) fixture { renderer, input, _, events, taps ->
            input.touchDown(20, 20, 0, Input.Buttons.LEFT); input.touchDragged(30, 20, 0)
            when (cancel) { 0 -> (field(renderer, "generation").get(renderer) as AtomicLong).incrementAndGet()
                1 -> renderer.pause(); 2 -> renderer.setWallStrokeMode(null); else -> Unit }
            input.touchUp(if (cancel == 3) -1 else 30, 20, 0, Input.Buttons.LEFT)
            assertTrue(events.filterIsInstance<WallStrokeEvent.Released>().isEmpty()); assertTrue(taps.isEmpty())
        }
    }
    @Test fun `ordinary mode preserves ground tapping and camera drag when no wall drawing was admitted`() = fixture { renderer, input, camera, events, taps ->
        renderer.setWallStrokeMode(null)
        input.touchDown(20, 20, 0, Input.Buttons.LEFT); input.touchUp(20, 20, 0, Input.Buttons.LEFT)
        assertEquals(listOf("ground"), taps)
        input.touchDown(20, 20, 0, Input.Buttons.LEFT); input.touchDragged(40, 20, 0); input.touchUp(40, 20, 0, Input.Buttons.LEFT)
        assertNotEquals(6f, camera.position.x); assertEquals(listOf("ground"), taps); assertTrue(events.isEmpty())
    }
    @Test fun `actual Android pinch cancellation permits one finger pan and a later fresh pinch without a ghost contact`() = fixture { renderer, input, camera, _, taps ->
        renderer.setWallStrokeMode(null)
        input.touchDown(40, 40, 0, Input.Buttons.LEFT); input.touchDown(70, 40, 1, Input.Buttons.LEFT)
        input.touchCancelled(40, 40, 0, Input.Buttons.LEFT)
        input.touchDragged(80, 40, 1); input.touchUp(80, 40, 1, Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
        input.touchDown(40, 40, 0, Input.Buttons.LEFT); input.touchDragged(42, 42, 0)
        assertEquals(1f, camera.zoom, 0f); assertEquals(4f, camera.position.x, 0f); assertEquals(4f, camera.position.y, 0f)
        input.touchDragged(60, 42, 0); input.touchUp(60, 42, 0, Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
        input.touchDown(40, 40, 0, Input.Buttons.LEFT); input.touchDown(70, 40, 1, Input.Buttons.LEFT)
        input.touchDragged(90, 40, 1)
        assertEquals(.6f, camera.zoom, .0001f)
        input.touchUp(90, 40, 1, Input.Buttons.LEFT); input.touchUp(40, 40, 0, Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
    }
    @Test fun `Android cancellation discards wall contacts and lets a fresh stroke use the admitted token`() = fixture { _, input, _, events, taps ->
        input.touchDown(20, 20, 0, Input.Buttons.LEFT); input.touchDragged(30, 20, 0)
        input.touchDown(70, 20, 1, Input.Buttons.LEFT)
        input.touchCancelled(20, 20, 0, Input.Buttons.LEFT)
        input.touchUp(70, 20, 1, Input.Buttons.LEFT)
        assertTrue(events.filterIsInstance<WallStrokeEvent.Released>().isEmpty())
        input.touchDown(20, 20, 0, Input.Buttons.LEFT); input.touchUp(20, 20, 0, Input.Buttons.LEFT)
        assertEquals(listOf(WallStrokeTile(2, 2)), events.filterIsInstance<WallStrokeEvent.Released>().single().tiles)
        assertTrue(taps.isEmpty())
    }
    // Backend D-185, superseding D-183. Owner, 0.6.0 / code 26 on his Seeker (2026-09-27): "they should be able to see full base art but
    // they should not be able to zoom out in a way to see past it". The real renderer, not only CameraFraming, must hold it:
    // these drive NativeGameRenderer's own clamp after a real drag, on a scene whose realm kit is drawn. (D-183 bounded the
    // same scenes by the claim plus its one-tile ring and hid the themed art around it.)
    private val kitField=BaseWorldBounds(-34*64f,-34*64f,64*64f,64*64f) // RealmKitSurface.worldBounds: the 98-tile REALM_KIT field
    private fun drawKit(renderer: NativeGameRenderer, spec: BaseCameraSpec) {
        field(renderer,"scene").set(renderer,BaseScene(emptyList(),30,30,64f,baseId="A",camera=spec))
        field(renderer,"terrainBounds").set(renderer,kitField)
        field(renderer,"drawnWorld").set(renderer,kitField) // what scene activation sets while a realm kit is drawn
    }
    @Test fun `actual inset camera keeps the unobscured view inside the drawn world behind floating tools`() = fixture { renderer, input, camera, _, _ ->
        renderer.setWallStrokeMode(null)
        drawKit(renderer,BaseCameraSpec(8f,22f,4f,.14f,1.6f,4f))
        val insets=CameraInsets(top=30,bottom=20)
        field(renderer,"cameraInsets").set(renderer,insets)
        camera.viewportWidth=120f;camera.viewportHeight=120f;camera.zoom=4f
        camera.position.set(10_000f,10_000f,0f)
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchDragged(42,42,0)
        val visible=requireNotNull(insets.visible(120,120))
        assertEquals("a zoom inside the band is kept",4f,camera.zoom,0f)
        assertEquals("the unobscured view's east edge reaches the drawn field's, far past the claim and its ring",
            kitField.right,visible.visibleX(camera.position.x,camera.zoom)+visible.width*camera.zoom/2,.001f)
        assertEquals(kitField.bottom,visible.visibleY(camera.position.y,camera.zoom)+visible.height*camera.zoom/2,.001f)
        camera.position.set(-10_000f,-10_000f,0f)
        input.touchDragged(44,44,0)
        assertEquals(kitField.left,visible.visibleX(camera.position.x,camera.zoom)-visible.width*camera.zoom/2,.001f)
        assertEquals(kitField.top,visible.visibleY(camera.position.y,camera.zoom)-visible.height*camera.zoom/2,.001f)
    }
    @Test fun `actual pan brings the drawn world's outer rows out from under measured HUD chrome`() = fixture { renderer, input, camera, _, _ ->
        // The HOME fit insets ignore chrome that does not cross the fitted square (portrait resource bar, bottom dock), so the
        // pan uses the measured chrome itself: at the north limit the field's top edge sits just below the header.
        renderer.setWallStrokeMode(null)
        drawKit(renderer,BaseCameraSpec(8f,22f,4f,.14f,1.6f,4f))
        renderer.setInputGeometry(SceneInputGeometry(120,120,listOf(SceneInputRegion(0,0,120,25),SceneInputRegion(0,100,120,120))))
        camera.viewportWidth=120f;camera.viewportHeight=120f;camera.zoom=4f
        camera.position.set(0f,-10_000f,0f)
        input.touchDown(60,60,0,Input.Buttons.LEFT);input.touchDragged(62,62,0)
        assertEquals("the field's top edge sits exactly under the 25 px header",kitField.top,camera.position.y-60*camera.zoom+25*camera.zoom,.001f)
        camera.position.set(0f,10_000f,0f);input.touchDragged(64,64,0)
        assertEquals("...and its bottom edge exactly above the 20 px dock",kitField.bottom,camera.position.y+60*camera.zoom-20*camera.zoom,.001f)
    }
    @Test fun `actual camera zooms out to exactly the drawn world covering the surface, never past it`() = fixture { renderer, input, camera, _, _ ->
        renderer.setWallStrokeMode(null)
        val spec=BaseCameraSpec(8f,22f,4f,.14f,1.6f,4f,extendedPlot=true)
        drawKit(renderer,spec)
        camera.viewportWidth=120f;camera.viewportHeight=120f;camera.zoom=1_000f
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchDragged(42,42,0)
        assertEquals("the widest zoom is the drawn world covering the surface",1/drawnWorldCoverScale(kitField,120,120,1f),camera.zoom,.0001f)
        assertEquals("a square surface sees the whole 98-tile field and nothing past it",kitField.width,120*camera.zoom,.01f)
        assertEquals(kitField.left,camera.position.x-60*camera.zoom,.01f)
        assertEquals(kitField.top,camera.position.y-60*camera.zoom,.01f)
        assertTrue("wider than D-183's floor, the claim and its ring (16 tiles) covering the surface",120*camera.zoom>16*64f)
        // Neither bound is the authored one: the claim fit (22 tiles with its padding) alone would have stopped far short.
        assertTrue(120*fitBaseFrame(spec,120,120,1f,kitField.width,64f).maxZoom<kitField.width/2)
    }
    @Test fun `actual camera without a drawn world keeps the pre-D-183 painted clamp behind floating bottom tools`() = fixture { renderer, input, camera, _, _ ->
        // D-185 point 3: legacy plots, simulator fixtures and scenes whose ground has not loaded draw no realm kit or layered
        // painting, so they keep the historical frame: the full GL surface stays on the terrain bounds, the authored band.
        renderer.setWallStrokeMode(null)
        val bounds=baseWorldBounds(30,30,64f,4f)
        val spec=BaseCameraSpec(8f,22f,4f,.14f,1.6f,4f)
        field(renderer,"scene").set(renderer,BaseScene(emptyList(),30,30,64f,baseId="A",camera=spec))
        field(renderer,"terrainBounds").set(renderer,bounds)
        field(renderer,"cameraInsets").set(renderer,CameraInsets(top=30,bottom=20))
        camera.viewportWidth=120f;camera.viewportHeight=120f;camera.zoom=4f
        camera.position.set(10_000f,10_000f,0f)
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchDragged(42,42,0)
        assertEquals(bounds.right,camera.position.x+120*camera.zoom/2,.001f)
        assertEquals(bounds.bottom,camera.position.y+120*camera.zoom/2,.001f)
        camera.zoom=1_000f;input.touchDragged(44,44,0)
        assertEquals("the authored floor, not a drawn-world cover",
            fitBaseFrame(spec,120,120,1f,maxOf(bounds.width,bounds.height),64f,CameraInsets(top=30,bottom=20)).maxZoom,camera.zoom,.0001f)
    }
    // D-185 in battle, scout, campaign preview and replay: expandedBattleFrame bounds the authored whole-field band by the drawn
    // world, and clampCamera's battle branch keeps panning the whole versioned field, where troops may still deploy ("Keep whole
    // field", D-183 item 3). Code 28's portrait battle fit the field to the SHORT axis and showed a field's height of margin past it.
    private val battleField=BattlefieldInputPolicy(3,1,3,-34,64,8,22,emptySet(),1,deploymentSquareTiles=1) // RAID_BATTLEFIELD v3, a starter claim
    private val raidCamera=BattleCameraSpec(.14f,1.6f,1.1f,0f,4f,128f) // RAID_CAMERA, RAID_RULES.deployMarginTiles
    /** A live raid on a portrait 120x240 surface under a 20 px HUD bar and a 30 px deck: the renderer's own PreparedBattle (no
     *  events, walls or art) over a versioned field, with [drawn] as the drawn world scene activation chose. */
    private fun raid(renderer: NativeGameRenderer, camera: OrthographicCamera, drawn: BaseWorldBounds?): CameraInsets {
        val base=BaseScene(emptyList(),30,30,64f,baseId="A",battlefield=battleField,battleCamera=raidCamera)
        val scene=BattleScene(base,PresentationRevision("raid","r",14,0,0,emptyList()),emptyMap(),256f,100f,1,1)
        val model=BattleVisualModel(emptyList(),1)
        val prepared=Class.forName("${NativeGameRenderer::class.java.name}\$PreparedBattle").getDeclaredConstructor(BattleScene::class.java,
            BattleVisualModel::class.java,CombatVisualPlan::class.java,WallVisualModel::class.java,Set::class.java,WallFieldTimeline::class.java)
            .apply { isAccessible=true }.newInstance(scene,model,CombatVisualPlan(scene,model,emptyMap()),
                WallVisualModel(emptyList(),WallCatalogue(JsonReader().parse("{}"))),emptySet<String>(),null)
        field(renderer,"battle").set(renderer,prepared)
        field(renderer,"scene").set(renderer,base)
        field(renderer,"terrainBounds").set(renderer,drawn)
        field(renderer,"drawnWorld").set(renderer,drawn)
        val hud=CameraInsets(top=20,bottom=30)
        field(renderer,"cameraInsets").set(renderer,hud)
        (field(renderer,"viewport").get(renderer) as ScreenViewport).setScreenBounds(0,0,120,240)
        camera.viewportWidth=120f;camera.viewportHeight=240f
        return hud
    }
    @Test fun `actual battle camera zooms out to exactly the drawn field covering the surface and pans to every corner of the field`() = fixture { renderer, input, camera, _, _ ->
        renderer.setWallStrokeMode(null)
        val hud=raid(renderer,camera,kitField)
        camera.zoom=1_000f;camera.position.set(0f,0f,0f)
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchDragged(42,42,0)
        val cover=1/drawnWorldCoverScale(kitField,120,240,1f)
        assertEquals("the widest zoom is the drawn field covering the surface",cover,camera.zoom,.0001f)
        assertEquals("a portrait surface sees every row of the field and nothing past it",kitField.height,240*camera.zoom,.01f)
        assertEquals("the authored band alone fit the field to the short axis: twice as far out",
            2*cover,fitExpandedBattleFrame(battleField,raidCamera,120,240,1f,64f,hud).maxZoom,.001f)
        // A far drag toward each corner stops with the unobscured view on that corner of the versioned field.
        val visible=requireNotNull(hud.visible(120,240))
        for((east,south) in listOf(false to false,true to false,false to true,true to true)) {
            camera.position.set(if(east) 1e6f else -1e6f,if(south) 1e6f else -1e6f,0f)
            input.touchDragged(42,42,0)
            assertEquals("zoom kept while panning",cover,camera.zoom,.0001f)
            val x=visible.visibleX(camera.position.x,camera.zoom)+(if(east) 1 else -1)*visible.width*camera.zoom/2
            val y=visible.visibleY(camera.position.y,camera.zoom)+(if(south) 1 else -1)*visible.height*camera.zoom/2
            assertEquals("east=$east south=$south x",(if(east) battleField.maximum else battleField.minimum)*64f,x,.01f)
            assertEquals("east=$east south=$south y",(if(south) battleField.maximum else battleField.minimum)*64f,y,.01f)
        }
    }
    @Test fun `actual battle camera without a drawn world keeps the authored whole-field band`() = fixture { renderer, input, camera, _, _ ->
        // D-185 item 3: a battle whose ground has not loaded (or a fixture) draws no realm kit or layered painting, so the
        // authored band stands.
        renderer.setWallStrokeMode(null)
        val hud=raid(renderer,camera,null)
        camera.zoom=1_000f
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchDragged(42,42,0)
        assertEquals("the authored whole-field fit, not a drawn-world cover",
            fitExpandedBattleFrame(battleField,raidCamera,120,240,1f,64f,hud).maxZoom,camera.zoom,.0001f)
        assertEquals("the whole field across the short axis",kitField.width,120*camera.zoom,.01f)
    }
    @Test fun `floating gaps and physical edges admit taps independently of fit margins`() = fixture { renderer, input, _, _, taps ->
        renderer.setWallStrokeMode(null)
        field(renderer, "cameraInsets").set(renderer, CameraInsets(top = 50, bottom = 50))
        renderer.setInputGeometry(SceneInputGeometry(120, 120, listOf(SceneInputRegion(0, 0, 40, 40), SceneInputRegion(80, 80, 120, 120))))
        for ((x,y) in listOf(60 to 10, 10 to 110, 119 to 40)) {
            input.touchDown(x,y,0,Input.Buttons.LEFT); input.touchUp(x,y,0,Input.Buttons.LEFT)
        }
        assertEquals(listOf("ground", "ground", "ground"), taps)
        for ((x,y) in listOf(20 to 20, 100 to 100, 120 to 40, -1 to 40)) {
            input.touchDown(x,y,0,Input.Buttons.LEFT); input.touchUp(x,y,0,Input.Buttons.LEFT)
        }
        assertEquals(3, taps.size)
    }
    @Test fun `drag into painted chrome poisons release even after returning to field`() = fixture { renderer, input, _, events, taps ->
        renderer.setWallStrokeMode(null)
        renderer.setInputGeometry(SceneInputGeometry(120,120,listOf(SceneInputRegion(50,0,90,100))))
        input.touchDown(40,40,0,Input.Buttons.LEFT); input.touchDragged(55,40,0)
        input.touchDragged(40,40,0); input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertTrue(taps.isEmpty()); assertTrue(events.isEmpty())
        input.touchDown(40,40,0,Input.Buttons.LEFT); input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertEquals(listOf("ground"),taps)
    }
    @Test fun `HUD or dismissing scrim cancels held scene tap immediately without waiting for GL or layout`() = fixture { renderer, input, _, _, taps ->
        renderer.setWallStrokeMode(null)
        val chrome = SceneInputCancellation()
        renderer.setInputGeometry(SceneInputGeometry(120,120,emptyList(),chrome))
        input.touchDown(40,40,0,Input.Buttons.LEFT)
        chrome.beginContact()
        input.touchDown(80,40,1,Input.Buttons.LEFT)
        input.touchUp(80,40,1,Input.Buttons.LEFT)
        chrome.endContact()
        input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertEquals(listOf("ground"),taps)
    }
    @Test fun `rotation stale geometry fails closed until actual surface dimensions agree`() = fixture { renderer, input, _, _, taps ->
        renderer.setWallStrokeMode(null)
        renderer.setInputGeometry(SceneInputGeometry(240,120,emptyList()))
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
        renderer.setInputGeometry(SceneInputGeometry(120,120,emptyList()))
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertEquals(listOf("ground"),taps)
    }
    @Test fun `a blocked second finger cancels pinch and a fresh sequence can pan then pinch again`() = fixture { renderer, input, camera, _, taps ->
        renderer.setWallStrokeMode(null)
        renderer.setInputGeometry(SceneInputGeometry(120,120,listOf(SceneInputRegion(80,0,120,40))))
        input.touchDown(40,20,0,Input.Buttons.LEFT);input.touchDown(90,20,1,Input.Buttons.LEFT)
        input.touchUp(90,20,1,Input.Buttons.LEFT);input.touchUp(40,20,0,Input.Buttons.LEFT)
        assertEquals(1f,camera.zoom,0f);assertTrue(taps.isEmpty())
        input.touchDown(40,60,0,Input.Buttons.LEFT);input.touchDragged(42,60,0)
        assertEquals(1f,camera.zoom,0f)
        input.touchDown(70,60,1,Input.Buttons.LEFT);input.touchDragged(90,60,1)
        assertTrue(camera.zoom < 1f)
        input.touchUp(90,60,1,Input.Buttons.LEFT);input.touchUp(42,60,0,Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
    }

    @Test fun `HUD cancellation remains poisoned when a third finger taps before original contact lifts`() = fixture { renderer, input, _, _, taps ->
        renderer.setWallStrokeMode(null)
        val chrome = SceneInputCancellation()
        renderer.setInputGeometry(SceneInputGeometry(120,120,emptyList(),chrome))
        input.touchDown(40,40,0,Input.Buttons.LEFT)
        chrome.beginContact(); chrome.endContact()
        input.touchDown(80,40,2,Input.Buttons.LEFT); input.touchUp(80,40,2,Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
        input.touchUp(40,40,0,Input.Buttons.LEFT)
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertEquals(listOf("ground"),taps)
    }
    @Test fun `geometry cancellation cannot create a fresh third finger gesture until every known contact lifts`() = fixture { renderer, input, _, _, taps ->
        renderer.setWallStrokeMode(null)
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchDown(70,40,1,Input.Buttons.LEFT)
        renderer.setInputGeometry(SceneInputGeometry(120,120,listOf(SceneInputRegion(20,20,60,60))))
        input.touchDragged(40,40,0)
        renderer.setInputGeometry(SceneInputGeometry(120,120,emptyList()))
        input.touchUp(70,40,1,Input.Buttons.LEFT)
        input.touchDown(90,70,2,Input.Buttons.LEFT);input.touchUp(90,70,2,Input.Buttons.LEFT)
        assertTrue(taps.isEmpty())
        input.touchUp(40,40,0,Input.Buttons.LEFT)
        input.touchDown(40,40,0,Input.Buttons.LEFT);input.touchUp(40,40,0,Input.Buttons.LEFT)
        assertEquals(listOf("ground"),taps)
    }

}
