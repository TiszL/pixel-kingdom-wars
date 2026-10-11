package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BuilderSlotStatus
import gg.pixelkingdomwars.nativeclient.ui.kingdom.builderOverview
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class BuilderOverviewTest {
    private fun catalogue(maximum: Int = 6) = Json.parseToJsonElement("""{
      "constants":{"CAPS":{"buildersMax":$maximum,"builderPricesSol":[2,10,20,40,80]}}
    }""").jsonObject
    private fun base(owned: Int, free: Int) = BaseSnapshot.from(Json.parseToJsonElement("""{
      "baseId":"11111111-1111-4111-8111-111111111111",
      "player":{"keepLevel":20,"builders":$owned},"freeBuilders":$free,"jobs":[]
    }""").jsonObject)

    @Test fun `full roster still opens an overview and never offers an impossible seventh hire`() {
        val overview = requireNotNull(builderOverview(catalogue(), base(6, 5)))
        assertEquals(6, overview.slots.size)
        assertEquals(1, overview.slots.count { it.status == BuilderSlotStatus.WORKING })
        assertEquals(5, overview.slots.count { it.status == BuilderSlotStatus.RESTING })
        assertFalse(overview.slots.any { it.status == BuilderSlotStatus.NEXT })
        assertNull(overview.hireOffer)
    }

    @Test fun `only next slot can hire and its price is the existing canonical purchase offer`() {
        val overview = requireNotNull(builderOverview(catalogue(), base(2, 0)))
        assertEquals(listOf(BuilderSlotStatus.WORKING, BuilderSlotStatus.WORKING, BuilderSlotStatus.NEXT,
            BuilderSlotStatus.LOCKED, BuilderSlotStatus.LOCKED, BuilderSlotStatus.LOCKED), overview.slots.map { it.status })
        assertEquals("10", overview.slots[2].priceSol)
        assertEquals("10000000000", overview.hireOffer?.amountLamports)
        assertEquals(2, overview.hireOffer?.expectedCount)
        assertEquals("11111111-1111-4111-8111-111111111111", overview.hireOffer?.baseId)
    }

    @Test fun `roster limit comes from content and missing or inconsistent counts cannot open hiring`() {
        val overview = requireNotNull(builderOverview(catalogue(4), base(4, 4)))
        assertEquals(4, overview.maximum)
        assertEquals(4, overview.slots.size)
        assertNull(overview.hireOffer)
        assertNull(builderOverview(null, base(2, 2)))
        assertNull(builderOverview(catalogue(), base(2, 3)))
        assertNull(builderOverview(catalogue(4), base(6, 1)))
    }
}
