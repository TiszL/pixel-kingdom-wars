package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import org.junit.Test
import kotlin.test.*

class LayeredGroundPreparationTest {
    private val realmIds = setOf("thornwake", "frostveil")
    private val image = byteArrayOf(1, 2, 3)
    private fun fixture(realm: String = "thornwake", status: String = "accepted"): ByteArray {
        val hash = LayeredGroundSource.sha256(image)
        return """{"schemaVersion":1,"groundRevision":3,"realmId":"$realm","status":"$status","tilePixels":32,
            "field":{"x":-1088,"y":-1088,"width":3136,"height":3136},"protectedFrame":{"x":-320,"y":-320,"width":1600,"height":1600},
            "ground":{"asset":"ground","sampling":"world"},"assets":[{"id":"ground","path":"atlas/fantasy/layered-ground/assets/$hash.webp","sha256":"$hash","size":3,
            "width":2,"height":2,"frameWidth":2,"frameHeight":2,"frameCount":1,"frameDurationMs":100,"anchor":{"x":0,"y":0},"reducedMotionFrame":0}],"placements":[]}""".toByteArray()
    }
    private fun descriptor(bytes: ByteArray, realm: String) = LayeredGroundSource.sha256(bytes).let { hash ->
        """{"realmId":"$realm","sha256":"$hash","manifestPath":"atlas/fantasy/layered-ground/$hash/manifest.json"}"""
    }
    private fun section(bytes: ByteArray, status: String = "accepted"): JsonValue = JsonReader().parse("""{"version":1,"status":"$status", "manifests":[${descriptor(bytes,"thornwake")},${descriptor(fixture("frostveil"),"frostveil") }]}""")
    private fun source(bytes: ByteArray = fixture()) = LayeredGroundSource.read(section(bytes),"thornwake",realmIds,false) { _, _ -> bytes }
    @Test fun `only active accepted realm is read and sized before worker decoding`() {
        val bytes=fixture();var reads=0
        val s=LayeredGroundSource.read(section(bytes),"thornwake",realmIds,false) { path, maximum ->
            assertTrue(path.contains(LayeredGroundSource.sha256(bytes)));assertEquals(256*1024,maximum);reads++;bytes
        }
        assertEquals(1,reads);var decoded=0
        val pages=s.prepare({ _, max -> assertEquals(3,max);image },LayeredImageDecoder { _, w, h ->
            decoded++;LayeredRgba(w,h,ByteArray(w*h*4) { if(it%4==3) 255.toByte() else 17 })
        },{})
        assertEquals(1,decoded);assertEquals(1,pages.pages.size);assertEquals(1600.0,s.rules.protectedFrame.width)
    }
    @Test fun `corrupt transport and cancelled preparation never invoke decoder`() {
        val s=source();var decoded=0;val decoder=LayeredImageDecoder { _,w,h -> decoded++;LayeredRgba(w,h,ByteArray(16)) }
        assertFailsWith<IllegalArgumentException> { s.prepare({_,_->byteArrayOf(9,8,7)},decoder,{}) }
        assertFailsWith<IllegalStateException> { s.prepare({_,_->image},decoder,{error("obsolete generation")}) }
        assertEquals(0,decoded)
        assertFailsWith<IllegalArgumentException> { LayeredGroundSource.read(section(fixture()),"thornwake",realmIds,false) {_,_->"changed".toByteArray()} }
    }
    @Test fun `preview admission is explicit and decoded layout or alpha cannot silently differ`() {
        val bytes=fixture(status="preview-only")
        assertFailsWith<IllegalArgumentException> { LayeredGroundSource.read(section(bytes,"preview-only"),"thornwake",realmIds,false) {_,_->bytes} }
        val s=LayeredGroundSource.read(section(bytes,"preview-only"),"thornwake",realmIds,true) {_,_->bytes}
        assertFailsWith<IllegalArgumentException> { s.prepare({_,_->image},LayeredImageDecoder {_,_,_->LayeredRgba(1,4,ByteArray(16))},{}) }
        assertFailsWith<IllegalArgumentException> { s.prepare({_,_->image},LayeredImageDecoder {_,w,h->LayeredRgba(w,h,ByteArray(16))},{}) }
        assertFailsWith<IllegalArgumentException> { source().prepare({_,_->image},LayeredImageDecoder {_,w,h->LayeredRgba(w,h,ByteArray(15))},{}) }
    }
}
