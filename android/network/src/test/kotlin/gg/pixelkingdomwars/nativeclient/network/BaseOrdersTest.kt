package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BaseOrdersTest {
    @Test fun `mine display selects the canonical ordinal and never clamps an unsupported price`() {
        val catalogue=Json.parseToJsonElement("""{"constants":{"BUILD_COSTS":{"mine":{"costShards":99,"buildSec":7}},"MINING":{"MINE_BUILD_KEEP":[13,29]}}}""").jsonObject
        fun base(count: Int)=buildJsonObject { put("buildings",buildJsonArray { repeat(count) { add(jsonBody("type" to "mine")) } }) }
        assertEquals(BaseOrderPrice("SHARDS","13","7"),buildingPrice(catalogue,base(0),"mine"))
        assertEquals(BaseOrderPrice("KEEP","29","7"),buildingPrice(catalogue,base(1),"mine"))
        assertNull(buildingPrice(catalogue,base(2),"mine"))
    }
    @Test fun `paid upgrades cannot silently use the shard only order route`() {
        val root=Json.parseToJsonElement("""{"constants":{"UPGRADE_COSTS":{"mine":[31,47]}},"display":{"upgradeSolLamports":{"mine":{"2":"0","3":"12000000"}}}}""").jsonObject
        assertEquals("31",buildingUpgradePrice(root,jsonBody("type" to "mine","level" to "1"))?.amount)
        assertNull(buildingUpgradePrice(root,jsonBody("type" to "mine","level" to "2")))
        assertNull(buildingUpgradePrice(JsonObject(root-"display"),jsonBody("type" to "mine","level" to "1")))
    }
    // Owner, 0.5.3: "we can't upgrade any building" — UPGRADE was dimmed on every cannon, mortar, tower, trap and wall
    // while the Keep worked. Every published pack exports `upgradeSolLamports` as `{}` for those types (the exporter
    // reads `settings.maxLevel`, which DEFENSES lack); the canonical rule is "no SOL step = 0". A defence must price
    // its shard upgrade (walls without a build time), a real SOL step must still refuse the shard route, and a pack
    // with no table for the type at all stays unsupported.
    @Test fun `a defence whose exported SOL table is empty still prices its shard upgrade`() {
        val root=Json.parseToJsonElement("""{"constants":{"UPGRADE_COSTS":{"cannon":[120,296],"wall":[48],"mine":[31,47]},"UPGRADE_TIMES_SEC":{"cannon":[600,1200],"wall":[0]}},
            "display":{"upgradeSolLamports":{"cannon":{},"wall":{},"mine":{"2":"0","3":"12000000"}}}}""").jsonObject
        assertEquals(BaseOrderPrice("SHARDS","296","1200"),buildingUpgradePrice(root,jsonBody("type" to "cannon","level" to "2")))
        assertEquals(BaseOrderPrice("SHARDS","48",null),buildingUpgradePrice(root,jsonBody("type" to "wall","level" to "1")))
        assertNull(buildingUpgradePrice(root,jsonBody("type" to "mine","level" to "2")))
        assertNull(buildingUpgradePrice(root,jsonBody("type" to "mortar","level" to "1")))
    }
}
