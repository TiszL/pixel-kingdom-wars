package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.json
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

class WorldContentGroupsTest {
    private fun fantasy():JsonObject=buildJsonObject {
        put("presentation",json("""{"regionalDetails":[{"id":"heartlands"}],"chains":[{"id":"aurora"}]}"""))
        put("globe",buildJsonObject {
            put("files",buildJsonArray {
                listOf("realm-texture.png","generated/heartlands-detail.png","generated/aurora-detail.png","generated/aurora-detail-mask.png").forEach { path->add(buildJsonObject {
                    put("path","atlas/fantasy/globe/$path");put("sha256","a".repeat(64));put("size",8)
                }) }
            })
        })
    }
    @Test fun `atomic chain groups have separate stable identities across ground and source updates`() {
        val original=fantasy()
        val groups=worldContentGroups(original)
        assertEquals(listOf("overview","region-heartlands","chain-aurora"),groups.map { it.id })
        assertEquals(2,groups.last().files.size)
        val changed=JsonObject(original+mapOf("ground" to json("""{"revision":3}"""),"source" to JsonPrimitive("new source")))
        assertEquals(groups,worldContentGroups(changed))
        assertEquals(3,groups.map { it.identity }.distinct().size)
    }
    @Test fun `missing masks overlapping groups and invalid explicit grouping are rejected`() {
        val original=fantasy();val globe=original.getValue("globe").jsonObject
        val missing=JsonObject(original+ ("globe" to JsonObject(globe+("files" to JsonArray(globe.getValue("files").jsonArray.dropLast(1))))))
        assertThrows(IllegalArgumentException::class.java) { worldContentGroups(missing) }
        val invalid=JsonObject(original+("globe" to JsonObject(globe+("groups" to JsonPrimitive("untrusted grouping")))))
        assertThrows(IllegalArgumentException::class.java) { worldContentGroups(invalid) }
        val overlap=JsonObject(original+("presentation" to json("""{"regionalDetails":[{"id":"aurora"}],"chains":[{"id":"aurora"}]}""")))
        assertThrows(IllegalArgumentException::class.java) { worldContentGroups(overlap) }
    }
}
