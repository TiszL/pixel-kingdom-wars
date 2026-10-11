package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*

class CameraFramingTest {
    private val spec=BaseCameraSpec(8f,22f,4f,0.14f,1.6f)
    @Test fun `explicit full50 fits the whole claim below the legacy zoom floor in short viewports`() {
        val wide=spec.copy(claimMin=-10f,claimMax=40f,extendedPlot=true)
        val world=98*64f
        for((width,height) in listOf(1080 to 2400,2400 to 1080)) {
            val insets=CameraInsets(top=150,bottom=180)
            val frame=fitBaseFrame(wide,width,height,3f,world,64f,insets)
            val expectedScale=minOf(width/3f,(height-330)/3f)/((50+8)*64f)
            assertEquals(1/(expectedScale*3),frame.zoom,.00001f,"Match source extendedPlot fit rather than cropping the claim")
            assertEquals(frame.zoom,frame.maxZoom)
            assertEquals(15*64f,frame.center)
            assertTrue(maxOf(width,height)*frame.zoom>world,"This scenario must exercise outside-field rendering")
            val legacy=fitBaseFrame(wide.copy(extendedPlot=false),width,height,3f,world,64f,insets)
            assertTrue(legacy.zoom<frame.zoom,"Missing/v1 plot metadata keeps the historical camera floor")
        }
    }
    @Test fun `extended render bounds keep painted edges reachable after a deliberate closer zoom`() {
        val bounds=BaseWorldBounds(-34*64f,-34*64f,64*64f,64*64f)
        val wide=spec.copy(claimMin=-10f,claimMax=40f,extendedPlot=true)
        val frame=fitBaseFrame(wide,2400,1080,3f,bounds.width,64f)
        val extended=extendedBaseRenderBounds(bounds,2400,1080,frame.maxZoom)
        assertEquals(2400*frame.maxZoom,extended.width,.001f)
        assertEquals(bounds.height,extended.height)
        assertEquals(bounds.left+bounds.right,extended.left+extended.right,.001f)
        assertEquals(960f,clampBaseCameraAxis(99999f,2400*frame.zoom,extended.left,extended.right),.001f)
        assertTrue(clampBaseCameraAxis(99999f,2400f,extended.left,extended.right)>bounds.right-1200,
            "Closer zoom retains the expanded presentation pan bounds, like web")
        assertEquals(bounds,extendedBaseRenderBounds(bounds,400,600,1f))
        assertFailsWith<IllegalArgumentException> { extendedBaseRenderBounds(bounds,2400,1080,Float.NaN) }
    }
    @Test fun `HOME fit ignores corner builder and docks while preserving their exact input exclusions`() {
        for(font in listOf(1f,1.3f,2f)) {
            val header=SceneInputRegion(24,24,1500,(48*font*3+48).toInt())
            val builder=SceneInputRegion(24,header.bottom+24,240,header.bottom+24+(144*font).toInt())
            val primary=SceneInputRegion(1800,1080-(168*font).toInt()-48,2376,1056)
            val dock=SceneInputRegion(24,1080-(144*font).toInt()-48,570,1056)
            val safe=CameraInsets(bottom=24)
            val insets=homeCameraInsets(2400,1080,safe,listOf(header,builder),listOf(primary,dock))
            assertEquals(header.bottom,insets.top,"Only the resource row crosses the landscape fitted square")
            assertEquals(24,insets.bottom,"Empty space above floating corner controls stays available")
            assertTrue(1080-insets.top-insets.bottom>=720)
            val input=SceneInputGeometry(2400,1080,listOf(header,builder,primary,dock))
            assertFalse(input.accepts(40,builder.top+1,2400,1080),"Ignoring corner fit space must not admit its HUD touches")
            assertFalse(input.accepts(2000,primary.top+1,2400,1080))
            assertTrue(input.accepts(1200,1000,2400,1080),"The gap between floating docks remains touchable")
        }
    }
    @Test fun `measured 258 landscape HOME regains its central height without losing safe cutout alignment`() {
        // home-landscape.xml: resource chips [153,21]..[1397,147], candidate
        // notice ends189, header includes21px outer padding; cutout is132px.
        val safe=CameraInsets(left=132)
        val insets=homeCameraInsets(2400,1080,safe,
            listOf(SceneInputRegion(132,0,1418,210),SceneInputRegion(153,236,300,362)),
            listOf(SceneInputRegion(1812,891,2400,1080),SceneInputRegion(153,928,586,1054)))
        assertEquals(CameraInsets(left=132,top=210),insets)
        val frame=fitBaseFrame(spec.copy(claimMin=-10f,claimMax=40f,extendedPlot=true),2400,1080,2.625f,6272f,64f,insets)
        assertEquals(3712f/870,frame.zoom,.00001f)
        val visible=requireNotNull(insets.visible(2400,1080))
        assertEquals(678.4f,visible.cameraX(frame.center,frame.zoom),.001f)
        assertEquals(512f,visible.cameraY(frame.centerY,frame.zoom),.001f)
        assertEquals(750f,50*64/frame.zoom,.001f,"Claim height improves from467px to750px, with all four-tile margins")
    }
    @Test fun `portrait HOME keeps the clean full-width square and larger text cannot collapse fitting`() {
        val safe=CameraInsets(left=9,top=84,right=12,bottom=72)
        assertEquals(safe,homeCameraInsets(1080,2400,safe,
            listOf(SceneInputRegion(0,84,1080,360),SceneInputRegion(24,384,240,600)),
            listOf(SceneInputRegion(400,2100,1080,2328))))
        val large=homeCameraInsets(320,480,CameraInsets(top=20,bottom=10),
            listOf(SceneInputRegion(0,0,320,300)),listOf(SceneInputRegion(0,310,320,480)))
        assertEquals(CameraInsets(top=170,bottom=160),large)
    }
    @Test fun `HOME full50 safe-centre survives clamping and closer deliberate pans remain bounded`() {
        val bounds=BaseWorldBounds(-34*64f,-34*64f,64*64f,64*64f)
        val wide=spec.copy(claimMin=-10f,claimMax=40f,extendedPlot=true)
        for((width,height,insets) in listOf(
            Triple(1080,2400,CameraInsets(top=84,bottom=72)),
            Triple(2400,1080,CameraInsets(top=180,bottom=24,right=72)),
            Triple(2400,1080,CameraInsets(top=300,bottom=100,left=84)),
            Triple(1080,1080,CameraInsets(top=210,bottom=140)))) {
            val frame=fitBaseFrame(wide,width,height,3f,bounds.width,64f,insets)
            val visible=requireNotNull(insets.visible(width,height))
            val extended=extendedBaseRenderBounds(bounds,width,height,frame.maxZoom,insets)
            val intendedX=visible.cameraX(frame.center,frame.zoom)
            val intendedY=visible.cameraY(frame.centerY,frame.zoom)
            val x=clampBaseCameraAxis(intendedX,width*frame.zoom,extended.left,extended.right)
            val y=clampBaseCameraAxis(intendedY,height*frame.zoom,extended.top,extended.bottom)
            assertEquals(intendedX,x,.001f,"Landscape fit must not be pinned back to world centre")
            assertEquals(intendedY,y,.001f,"Portrait fit must retain the unequal safe-inset shift")
            for((size,center,near,far) in listOf(listOf(width.toFloat(),x,insets.left.toFloat(),insets.right.toFloat()),
                listOf(height.toFloat(),y,insets.top.toFloat(),insets.bottom.toFloat()))) {
                val start=size/2+((wide.claimMin-wide.padTiles)*64-center)/frame.zoom
                val end=size/2+((wide.claimMax+wide.padTiles)*64-center)/frame.zoom
                assertTrue(start>=near-.001f && end<=size-far+.001f,"Every claim edge and its padding stays visible")
            }
            val closer=maxOf(frame.minZoom,frame.zoom/2)
            assertEquals(x+50,clampBaseCameraAxis(x+50,width*closer,extended.left,extended.right),.001f)
            assertEquals(y+50,clampBaseCameraAxis(y+50,height*closer,extended.top,extended.bottom),.001f)
            val east=clampBaseCameraAxis(1e8f,width*closer,extended.left,extended.right)
            assertEquals(extended.right,east+width*closer/2,.001f,"Bounds never grow from the current camera position")
        }
    }
    @Test fun `SIM15 entry matches source occupied footprint fit, the authored band spans the field`() {
        // The scene does not pull back this far: drawnWorldFrame stops it where the drawn field covers the surface (D-185,
        // DrawnWorldCameraTest).
        val policy=BattlefieldInputPolicy(2,1,2,-34,64,-10,40,emptySet(),1)
        val camera=BattleCameraSpec(.14f,1.6f,1.1f,2f,4f,32f)
        val occupied=BaseWorldBounds(4f,8f,20f,18f)
        val insets=CameraInsets(top=60,bottom=80)
        for((w,h) in listOf(390 to 844,844 to 390,2048 to 1536)) {
            val result=fitExpandedBattleFrame(policy,camera,w,h,1f,64f,insets,occupied)
            val short=minOf(w,h-140).toFloat()
            val expectedScale=minOf(maxOf(short/(16*64f+12*64f),maxOf(w,h)/(98*64f)),short/(16*64f+128+64))
            assertEquals(1/expectedScale,result.zoom,.00001f,"Match source fitRing, noWaste and deployFits")
            assertEquals(12*64f,result.center);assertEquals(13*64f,result.centerY)
            assertEquals(98*64f/short,result.maxZoom,.00001f,"The authored pull-back fits every battlefield tile; the scene bounds it")
            val emptyClaim=fitExpandedBattleFrame(policy,camera,w,h,1f,64f,insets)
            assertTrue(result.zoom<emptyClaim.zoom,"Empty expansion space must not make the defender a postage stamp")
            val differentClaim=fitExpandedBattleFrame(policy.copy(claimMin=8,claimMax=22),camera,w,h,1f,64f,insets,occupied)
            assertEquals(result,differentClaim,"Claim size has no effect on occupied SIM15 entry")
            val density=fitExpandedBattleFrame(policy,camera,w*3,h*3,3f,64f,CameraInsets(top=180,bottom=240),occupied)
            assertEquals(result.zoom/3,density.zoom,.00001f);assertEquals(result.centerY,density.centerY)
        }
    }
    @Test fun `legacy framing ignores occupied bounds and empty SIM15 snapshots use their claim`() {
        val policy=BattlefieldInputPolicy(1,1,2,-4,34,8,22,emptySet(),1)
        val camera=BattleCameraSpec(.14f,1.6f,1.1f,2f,4f,32f)
        val original=fitExpandedBattleFrame(policy,camera,390,844,1f,64f,CameraInsets())
        assertEquals(original,fitExpandedBattleFrame(policy,camera,390,844,1f,64f,CameraInsets(),BaseWorldBounds(2f,3f,5f,6f)))
        assertEquals(15*64f,original.center);assertEquals(original.center,original.centerY)
    }
    @Test fun `battle chrome cannot zoom the full landscape surface beyond its admitted painting`() {
        // Observed 873dp landscape: fitting behind floating chrome gave 3.5265 inverse zoom,
        // sampling past both edges of the 98-tile v2 painting and visibly stretching its trees.
        val bounds=BaseWorldBounds(-34f*64,-34f*64,64f*64,64f*64)
        for((width,height) in listOf(2400 to 1080,1080 to 2400)) {
            val zoom=paintedViewportZoom(3.526531f,width,height,bounds)
            assertTrue(width*zoom<=bounds.width+.001f)
            assertTrue(height*zoom<=bounds.height+.001f)
            assertTrue(zoom<3.526531f,"The reproduced fit must be capped, not merely re-centred")
            for(center in listOf(-10000f,960f,10000f)) {
                val x=clampBaseCameraAxis(center,width*zoom,bounds.left,bounds.right)
                val y=clampBaseCameraAxis(center,height*zoom,bounds.top,bounds.bottom)
                assertTrue(x-width*zoom/2>=bounds.left-.001f && x+width*zoom/2<=bounds.right+.001f)
                assertTrue(y-height*zoom/2>=bounds.top-.001f && y+height*zoom/2<=bounds.bottom+.001f)
            }
            assertEquals(1f,paintedViewportZoom(1f,width,height,bounds),"Deliberate closer framing is preserved")
        }
    }
    @Test fun `painted viewport cap respects rectangular bounds and fails on invalid geometry`() {
        val bounds=BaseWorldBounds(-100f,-200f,1100f,2200f)
        assertEquals(.5f,paintedViewportZoom(8f,2400,1080,bounds))
        assertEquals(1f,paintedViewportZoom(8f,1080,2400,bounds))
        assertFailsWith<IllegalArgumentException> { paintedViewportZoom(Float.NaN,2400,1080,bounds) }
        assertFailsWith<IllegalArgumentException> { paintedViewportZoom(1f,0,1080,bounds) }
    }
    @Test fun `density changes pixels without changing visible world or authored closeup limit`() {
        val logical=fitBaseFrame(spec,400,600,1f,1920f,64f)
        val physical=fitBaseFrame(spec,1200,1800,3f,1920f,64f)
        assertEquals(logical.zoom/3,physical.zoom,0.00001f)
        assertEquals(logical.minZoom/3,physical.minZoom,0.00001f)
        assertEquals(logical.maxZoom/3,physical.maxZoom,0.00001f)
        assertEquals(logical.center,physical.center)
    }
    @Test fun `live claim is centred in the unobstructed surface across orientation and expansion`() {
        val portrait=fitBaseFrame(spec,400,600,1f,1920f,64f)
        val landscape=fitBaseFrame(spec,600,400,1f,1920f,64f)
        assertEquals(portrait,landscape)
        assertEquals(15f*64,portrait.center)
        val expanded=fitBaseFrame(spec.copy(claimMin=6f,claimMax=24f),400,600,1f,1920f,64f)
        assertTrue(expanded.zoom>=portrait.zoom,"Expanded claim cannot zoom in")
        assertEquals(portrait.center,expanded.center)
    }
    @Test fun `floating HUD insets fit the claim but never expose unpainted canvas at the zoom floor`() {
        val bounds=baseWorldBounds(30,30,64f,4f)
        for((width,height,insets) in listOf(
            Triple(1080,2160,CameraInsets(top=300,bottom=160)),
            Triple(2160,1080,CameraInsets(left=300,top=160,bottom=160)))) {
            val frame=fitBaseFrame(spec,width,height,3f,bounds.width,64f,insets)
            assertTrue(width*frame.maxZoom<=bounds.width+.001f)
            assertTrue(height*frame.maxZoom<=bounds.height+.001f,
                "Zooming out must retain terrain behind the transparent gaps between toolbar buttons")
        }
        val clear=fitBaseFrame(spec,800,800,1f,2432f,64f)
        val covered=fitBaseFrame(spec,800,800,1f,2432f,64f,CameraInsets(left=250))
        assertTrue(covered.zoom>clear.zoom,"Claim framing still uses the smaller unobscured width")
    }
    @Test fun `canonical skirt remains fixed while viewport-aware clamps keep every panned edge on grass`() {
        val bounds=baseWorldBounds(30,30,64f,4f)
        assertEquals(BaseWorldBounds(-256f,-256f,2176f,2176f),bounds)
        for((width,height) in listOf(1080 to 960,1080 to 1066,1920 to 1080)) {
            val frame=fitBaseFrame(spec,width,height,3f,bounds.width,64f)
            val viewW=width*frame.zoom;val viewH=height*frame.zoom
            val west=clampBaseCameraAxis(-10000f,viewW,bounds.left,bounds.right)
            val east=clampBaseCameraAxis(10000f,viewW,bounds.left,bounds.right)
            val north=clampBaseCameraAxis(-10000f,viewH,bounds.top,bounds.bottom)
            val south=clampBaseCameraAxis(10000f,viewH,bounds.top,bounds.bottom)
            assertEquals(bounds.left,west-viewW/2,.001f);assertEquals(bounds.right,east+viewW/2,.001f)
            assertEquals(bounds.top,north-viewH/2,.001f);assertEquals(bounds.bottom,south+viewH/2,.001f)
            assertEquals(frame.center,clampBaseCameraAxis(frame.center,viewH,bounds.top,bounds.bottom),.001f,
                "A resize preserves an in-bounds look-at point rather than jumping to a world edge")
        }
    }
    @Test fun `zoom band uses plot plus skirt and oversized fallback matches canonical near-edge clamp`() {
        val bounds=baseWorldBounds(30,30,64f,4f)
        val plotOnly=fitBaseFrame(spec,400,600,1f,1920f,64f)
        val withSkirt=fitBaseFrame(spec,400,600,1f,bounds.width,64f)
        assertTrue(withSkirt.zoom>plotOnly.zoom,"The source skirt permits fitting the claim without treating the plot boundary as the world edge")
        assertEquals(bounds.left+1500f,clampBaseCameraAxis(10000f,3000f,bounds.left,bounds.right))
        val legacy=baseWorldBounds(30,30,64f,0f)
        assertEquals(0f,legacy.left,0f);assertEquals(0f,legacy.top,0f)
        assertEquals(1920f,legacy.width,"Legacy metadata has no invented skirt")
        assertFailsWith<IllegalArgumentException> { spec.copy(skirtTiles=-1f) }
    }
    @Test fun `invalid surface or generated camera data fails instead of corrupting the view`() {
        assertFailsWith<IllegalArgumentException> { fitBaseFrame(spec,0,600,1f,1920f,64f) }
        assertFailsWith<IllegalArgumentException> { fitBaseFrame(spec,400,600,Float.NaN,1920f,64f) }
        assertFailsWith<IllegalArgumentException> { spec.copy(claimMax=spec.claimMin) }
    }
    @Test fun `new base raid realm or expanded claim refits but ordinary revisions preserve player framing`() {
        val framing=SceneCameraFraming()
        val base=BaseScene(emptyList(),30,30,64f,baseId="base-a",camera=spec,visual=RealmVisual("elderwood",2))
        framing.resize(411,914)
        assertTrue(framing.activate(base,null));framing.moved=true
        assertFalse(framing.activate(base.copy(keepLevel=2),null))
        assertTrue(framing.moved,"Fresh HUD or building state must not undo the player's camera")
        for((next,raid) in listOf(base to "raid-a",base to "raid-b",base to null,
            base.copy(baseId="base-b") to null,base.copy(visual=RealmVisual("frostveil",2)) to null,
            base.copy(camera=spec.copy(claimMin=6f,claimMax=24f)) to null)) {
            framing.moved=true
            assertTrue(framing.activate(next,raid));assertFalse(framing.moved)
            framing.moved=true
            assertFalse(framing.activate(next.copy(buildings=next.buildings.toList()),raid))
            assertTrue(framing.moved,"Another revision within the same battle or plot preserves deliberate movement")
        }
        framing.activate(base,null);framing.moved=true
        assertTrue(framing.activate(base.copy(camera=spec.copy(claimMin=6f,claimMax=24f)),null))
        assertFalse(framing.moved,"Unlocking a larger plot refits even when its base and realm are unchanged")
    }
    /** Owner 2026-09-17: deploying must never move the camera. The renderer frames a delivered scene only when
     * activation reports a new destination, so an acknowledged deploy's revision (same raid, same field) cannot
     * refit even an untouched camera; scene open, another raid, rotation and explicit FIT keep framing. */
    @Test fun `same battle revisions never request a fit even when the player has not moved the camera`() {
        val framing=SceneCameraFraming()
        val base=BaseScene(emptyList(),30,30,64f,baseId="base-a",camera=spec,visual=RealmVisual("elderwood",2))
        framing.resize(411,914)
        assertTrue(framing.activate(base,"raid-a"),"Opening the battle frames it")
        assertFalse(framing.moved)
        repeat(3) { revision->
            assertFalse(framing.activate(base.copy(buildings=base.buildings.toList()),"raid-a"),"Revision $revision after a deploy must not frame")
            assertFalse(framing.moved,"An untouched camera stays untouched, and still must not be refit")
        }
        assertTrue(framing.activate(base,"raid-b"),"Another raid is a new destination")
        assertTrue(framing.resize(914,411),"Rotation still refits")
    }
    @Test fun `rotation and changed surface refit while repeated same size callbacks preserve movement`() {
        val framing=SceneCameraFraming()
        assertTrue(framing.resize(411,914));framing.moved=true
        assertFalse(framing.resize(411,914));assertTrue(framing.moved)
        assertFalse(framing.resize(0,0));assertTrue(framing.moved,"Transient invalid surface cannot overwrite valid viewport identity")
        assertTrue(framing.resize(914,411));assertFalse(framing.moved,"Portrait pan and zoom must not carry into short landscape")
        framing.moved=true
        assertTrue(framing.resize(640,360));assertFalse(framing.moved)
    }

}
