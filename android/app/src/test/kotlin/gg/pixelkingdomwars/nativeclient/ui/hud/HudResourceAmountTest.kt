package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.ui.features.ResourceAmount
import gg.pixelkingdomwars.nativeclient.ui.features.ResourceUnit
import org.junit.Assert.assertEquals
import org.junit.Test

/** MS-B owns quantities. Formatting cannot infer a balance, round a price or start a read. */
class HudResourceAmountTest {
    @Test fun loadingRemainsUnknown() {
        assertEquals("…", hudAmountText(ResourceAmount.Loading))
    }

    @Test fun unavailableRemainsUnknownWithoutExposingProviderDetails() {
        assertEquals("…", hudAmountText(ResourceAmount.Unavailable("private provider detail")))
    }

    @Test fun absentRemainsDistinctFromLoadingAndKnownZero() {
        assertEquals("—", hudAmountText(ResourceAmount.Absent))
    }

    @Test fun admittedBaseUnitZeroIsReallyZero() {
        assertEquals("0", hudAmountText(ResourceAmount.Known("0", 9)))
    }

    @Test fun admittedDecimalZeroIsReallyZero() {
        assertEquals("0", hudAmountText(ResourceAmount.Known("0.000000", 6, ResourceUnit.DECIMAL)))
    }

    @Test fun integerCurrenciesRetainEveryDigit() {
        assertEquals("9007199254740993", hudAmountText(ResourceAmount.Known("9007199254740993", 0)))
    }

    @Test fun tokenBaseUnitsApplyTheProvidedDecimalsExactly() {
        assertEquals("18446744073.709551615", hudAmountText(ResourceAmount.Known("18446744073709551615", 9)))
    }

    @Test fun oneBaseUnitDoesNotRoundToZero() {
        assertEquals("0.000000001", hudAmountText(ResourceAmount.Known("1", 9)))
    }

    @Test fun decimalUnitsAreNotScaledTwice() {
        assertEquals("12.345678", hudAmountText(ResourceAmount.Known("12.345678", 6, ResourceUnit.DECIMAL)))
    }

    @Test fun insignificantDecimalZeroesDoNotImplyExtraPrecision() {
        assertEquals("1200.5", hudAmountText(ResourceAmount.Known("1200.5000", 6, ResourceUnit.DECIMAL)))
    }

    @Test fun decimalPrecisionBeyondMintDecimalsIsUnknown() {
        assertEquals("…", hudAmountText(ResourceAmount.Known("1.0000001", 6, ResourceUnit.DECIMAL)))
    }

    @Test fun negativeAndNoncanonicalBaseUnitsAreUnknown() {
        listOf("-1", "+1", "01", " 1", "1 ", "1.0", "1e3", "NaN", "", "１").forEach {
            assertEquals(it, "…", hudAmountText(ResourceAmount.Known(it, 6)))
        }
    }

    @Test fun negativeExponentAndNoncanonicalDecimalsAreUnknown() {
        listOf("-1.0", "+1", "01", " 1", "1 ", ".1", "1.", "1e3", "Infinity", "").forEach {
            assertEquals(it, "…", hudAmountText(ResourceAmount.Known(it, 6, ResourceUnit.DECIMAL)))
        }
    }

    @Test fun invalidDecimalsAreUnknown() {
        listOf(-1, 256, Int.MAX_VALUE).forEach {
            assertEquals("…", hudAmountText(ResourceAmount.Known("1", it)))
        }
    }

    @Test fun boundedInputAvoidsUnboundedNumberParsing() {
        assertEquals("…", hudAmountText(ResourceAmount.Known("1".repeat(257), 0)))
    }

    @Test fun displayUsesNoScientificNotationEvenAtMaximumDecimals() {
        assertEquals("0." + "0".repeat(254) + "1", hudAmountText(ResourceAmount.Known("1", 255)))
    }
}
