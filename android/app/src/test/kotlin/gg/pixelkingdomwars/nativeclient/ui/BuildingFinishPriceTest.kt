package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.kingdom.buildingFinishPrice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BuildingFinishPriceTest {
    @Test fun missingOrMalformedPriceCannotLookLikeAFreeFinish() {
        listOf(null, "", "?", "-1", "1.5", "1e3", " 0", "00").forEach { assertNull(buildingFinishPrice(it)) }
    }

    @Test fun freeAndPaidServerPricesRemainExactForConsent() {
        listOf("0", "2688", "9007199254740993").forEach { assertEquals(it, buildingFinishPrice(it)) }
    }
}
