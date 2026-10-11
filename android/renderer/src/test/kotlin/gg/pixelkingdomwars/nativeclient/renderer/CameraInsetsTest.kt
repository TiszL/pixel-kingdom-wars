package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test

class CameraInsetsTest {
    private val spec = BaseCameraSpec(8f,22f,4f,.14f,1.6f)
    @Test fun `parent HUD and kingdom tools reserve pixels once while surface remains full size`() {
        val parent=CameraInsets(top=180,right=228)
        val tools=CameraInsets(top=80,bottom=130)
        val view=assertNotNull((parent+tools).visible(2400,1080))
        assertEquals(2400,view.viewportWidth);assertEquals(1080,view.viewportHeight)
        assertEquals(2172,view.width);assertEquals(690,view.height)
        assertFalse(view.contains(2399,600));assertFalse(view.contains(500,200));assertTrue(view.contains(500,600))
    }
    @Test fun `zero insets preserve existing camera framing and panning exactly`() {
        val visible = requireNotNull(CameraInsets().visible(400,600))
        assertEquals(400,visible.width); assertEquals(600,visible.height)
        val frame = fitBaseFrame(spec,400,600,1f,2432f,64f)
        assertEquals(frame,fitBaseFrame(spec,visible.width,visible.height,1f,2432f,64f))
        assertEquals(frame.center,visible.cameraX(frame.center,frame.zoom))
        assertEquals(frame.center,visible.cameraY(frame.center,frame.zoom))
        assertEquals(clampBaseCameraAxis(-100f,400f*frame.zoom,-256f,2176f),visible.clampX(-100f,frame.zoom,-256f,2176f))
    }
    @Test fun `asymmetric tools HUD and footer put the claim centre inside the visible field`() {
        for ((width,height,insets) in listOf(
            Triple(400,800,CameraInsets(top=150,bottom=170)),
            Triple(900,420,CameraInsets(left=230,top=62,bottom=90)),
            Triple(1200,800,CameraInsets(left=286,top=72,right=20,bottom=96)))) {
            val visible = requireNotNull(insets.visible(width,height))
            val frame = fitBaseFrame(spec,visible.width,visible.height,1f,2432f,64f)
            val x = visible.cameraX(frame.center,frame.zoom)
            val y = visible.cameraY(frame.center,frame.zoom)
            assertEquals((visible.left+visible.right)/2f,width/2f+(frame.center-x)/frame.zoom,.001f)
            assertEquals((visible.top+visible.bottom)/2f,height/2f+(frame.center-y)/frame.zoom,.001f)
            assertEquals(frame.center,visible.visibleX(x,frame.zoom),.001f)
            assertEquals(frame.center,visible.visibleY(y,frame.zoom),.001f)
        }
    }
    @Test fun `visible edge clamps keep panned playable ground on the existing skirt`() {
        val view = requireNotNull(CameraInsets(left=200,top=100,right=20,bottom=70).visible(900,600))
        val zoom=2f
        val west=view.clampX(-10_000f,zoom,-256f,2176f)
        val east=view.clampX(10_000f,zoom,-256f,2176f)
        val north=view.clampY(-10_000f,zoom,-256f,2176f)
        val south=view.clampY(10_000f,zoom,-256f,2176f)
        assertEquals(-256f,view.visibleX(west,zoom)-view.width*zoom/2,.001f)
        assertEquals(2176f,view.visibleX(east,zoom)+view.width*zoom/2,.001f)
        assertEquals(-256f,view.visibleY(north,zoom)-view.height*zoom/2,.001f)
        assertEquals(2176f,view.visibleY(south,zoom)+view.height*zoom/2,.001f)
    }
    @Test fun `physical density preserves the visible world and authored zoom band`() {
        val one=requireNotNull(CameraInsets(80,60,10,100).visible(600,400))
        val three=requireNotNull(CameraInsets(240,180,30,300).visible(1800,1200))
        val a=fitBaseFrame(spec,one.width,one.height,1f,2432f,64f)
        val b=fitBaseFrame(spec,three.width,three.height,3f,2432f,64f)
        assertEquals(a.zoom/3,b.zoom,.00001f)
        assertEquals(one.cameraX(a.center,a.zoom),three.cameraX(b.center,b.zoom),.001f)
        assertEquals(one.cameraY(a.center,a.zoom),three.cameraY(b.center,b.zoom),.001f)
    }
    @Test fun `covered and transiently oversized layouts never manufacture a tappable rectangle`() {
        assertNull(CameraInsets(top=200,bottom=200).visible(600,400))
        assertNull(CameraInsets(left=Int.MAX_VALUE,right=Int.MAX_VALUE).visible(600,400))
        assertNull(CameraInsets().visible(0,400))
        assertFailsWith<IllegalArgumentException> { CameraInsets(top=-1) }
        val view=requireNotNull(CameraInsets(10,20,30,40).visible(300,500))
        assertFalse(view.contains(9,20)); assertFalse(view.contains(10,19))
        assertTrue(view.contains(10,20)); assertTrue(view.contains(269,459))
        assertFalse(view.contains(270,459)); assertFalse(view.contains(269,460))
    }
}
