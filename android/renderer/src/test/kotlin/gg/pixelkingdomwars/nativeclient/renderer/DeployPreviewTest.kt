package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.test.*
import org.junit.Test

class DeployPreviewTest {
    private val reference=JsonReader().parse(checkNotNull(javaClass.getResourceAsStream("/sensory/source-reference.json")).bufferedReader().readText())
    private val policy=assertNotNull(DeployPreviewPolicy.parse(reference.get("policy").get("deploymentPreview")))
    private val key=DeployMarkerKey("giant",null,1,2)
    @Test fun `pending fan matches actual source offsets through later capped rings`() {
        assertEquals(0f to 0f,policy.offset(0,1))
        reference.get("deployment").get("previewSamples").forEach { sample->
            assertEquals(sample.getFloat("x") to sample.getFloat("y"),policy.offset(sample.getInt("index"),sample.getInt("total")))
        }
    }
    @Test fun `same tile shares one exact count while other tiles and authoritative keys stay unchanged`() {
        val marks=listOf(DeployPreviewMark(1,key),DeployPreviewMark(2,key.copy(hero="theodor")),DeployPreviewMark(3,key.copy(tx=-1,ty=-2)))
        val seats=policy.seats(marks,64f)
        assertEquals(listOf(2,2,1),seats.map {it.count})
        assertEquals(marks,seats.map {it.mark})
        assertEquals(-32f,seats.last().x);assertEquals(-96f,seats.last().y)
        val single=policy.seats(listOf(marks[1]),64f).single()
        assertEquals(96f,single.x);assertEquals(160f,single.y);assertEquals(1,single.count)
    }
    @Test fun `ambiguous preview identity and invalid metadata fail before rendering`() {
        assertFailsWith<IllegalArgumentException> {policy.seats(listOf(DeployPreviewMark(1,key),DeployPreviewMark(1,key)),64f)}
        assertFailsWith<IllegalArgumentException> {policy.copy(firstRadius=Float.NaN)}
        assertFailsWith<IllegalArgumentException> {policy.copy(directions=listOf(0f to 0f))}
        assertNull(DeployPreviewPolicy.parse(null))
        assertEquals("#f4d77b",policy.badge?.color)
        assertEquals(4f,policy.badge?.rightInset)
    }
}
