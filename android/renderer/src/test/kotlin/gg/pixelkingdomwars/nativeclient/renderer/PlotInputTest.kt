package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Assert.*
import org.junit.Test

class PlotInputTest {
    @Test fun `signed home tiles remain selectable and field exterior never produces placement`() {
        val selected=mutableListOf<Pair<Float,Float>>()
        fun tap(x:Float,y:Float) = dispatchSceneTap(x,y,50,50,false,{a,b->selected+=a to b},-10,-10) {}
        tap(-9.5f,-9.5f);tap(39.5f,39.5f);tap(-10.1f,0f);tap(40f,0f)
        assertEquals(listOf(-9.5f to -9.5f,39.5f to 39.5f),selected)
    }
    @Test fun `signed wall stroke keeps original coordinates through release and skips occupied tiles`() {
        val events=mutableListOf<WallStrokeEvent>();val input=WallStrokeInput {events+=it}
        val mode=WallStrokeMode("plot2","base",50,50,1,1,setOf(WallStrokeTile(-10,-10),WallStrokeTile(-9,-10)),-10,-10)
        input.frame(mode,1,"base",false,100,100);input.down(0,true,true)
        input.move(0,-9.5f,-9.5f,true);input.move(0,-8.5f,-9.5f,true);input.move(0,-7.5f,-9.5f,true)
        input.up(0,-7.5f,-9.5f,true)
        assertEquals(listOf(WallStrokeTile(-10,-10),WallStrokeTile(-9,-10)),events.filterIsInstance<WallStrokeEvent.Released>().single().tiles)
    }
    @Test fun `expanded camera preserves centre and symmetric scenery bounds`() {
        val bounds=baseWorldBounds(50,50,64f,24f,-10,-10)
        assertEquals(BaseWorldBounds(-2176f,-2176f,4096f,4096f),bounds)
        val frame=fitBaseFrame(BaseCameraSpec(-10f,40f,2f,.1f,3f),1080,2400,3f,bounds.width,64f)
        assertEquals(15*64f,frame.center)
    }
}
