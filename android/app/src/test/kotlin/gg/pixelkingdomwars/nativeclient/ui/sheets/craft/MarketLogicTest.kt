package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules of the Market sheet (design/final/craft/SPEC.md §3). */
class MarketLogicTest {
    private val frostglass = CraftItemUi("frostglass", "Frostglass", craftItemIcon("frostglass"), "Refine here", usedFor = "For tools and kits.")
    private val items = mapOf("frostglass" to frostglass)
    private val keep = 1_000_000_000L
    private val lot = MarketOfferUi("o-1", "frostglass", 20, 18 * keep / 10, 9, Currency.KEEP, "base-a", "Ashford", 1, isMine = false)
    private val buy = MarketBuyUi("materials", listOf(lot), null, "o-1", 10, mapOf("frostglass" to 14L),
        MarketWalletUi(true, "312.5", keepBaseUnits = 312 * keep), "base-home", paymentsAvailable = true, feeBps = 500, items = items)

    // Base units stay integers; what the player pays rounds up, what they get rounds down.
    @Test fun `base-unit amounts format exactly and round in the player's disfavour`() {
        assertEquals("1.8", formatUnits(18 * keep / 10, 9))
        assertEquals("18", formatUnits(18 * keep, 9))
        assertEquals("0", formatUnits(0, 9))
        assertEquals("…", formatUnits(null, 9))
        assertEquals("1.24", formatUnits(1_234_567_891, 9, maxFraction = 2, roundUp = true))
        assertEquals("1.23", formatUnits(1_234_567_891, 9, maxFraction = 2))
        assertEquals("5%", feePercent(500))
        assertEquals("2.5%", feePercent(250))
        assertEquals("…", feePercent(null))
    }

    // SPEC §3.3: the fee comes from the server's feeBps; "You get" may never be more than the player will receive.
    @Test fun `listing proceeds round the fee up so you-get never flatters`() {
        val p = sellProceeds(10, 19 * keep / 10, 500)!!
        assertEquals(19 * keep, p.gross)
        assertEquals(950_000_000L, p.fee)
        assertEquals(18_050_000_000L, p.net)
        assertEquals(SellProceeds(1, 1, 0), sellProceeds(1, 1, 500))
        assertNull(sellProceeds(10, 19 * keep / 10, null))
        assertNull(sellProceeds(10, null, 500))
    }

    @Test fun `BUY shows the lot total and asks the host for the Seal`() {
        val primary = buyPrimary(buy)!!
        assertEquals("BUY 10", primary.label)
        assertEquals("for 18 KEEP", primary.sub)
        assertEquals(PrimaryAction.START, primary.action)
        assertNull(primary.price)
        assertEquals(10L, buyQuantity(buy, lot))
        assertEquals(20L, buyQuantity(buy.copy(quantity = 99), lot))
        assertEquals(5L, buyQuantity(buy.copy(quantity = 1), lot.copy(minimumPurchase = 5)))
    }

    @Test fun `BUY explains every refusal and never auto-spends`() {
        assertNull(buyPrimary(buy.copy(offers = listOf(lot.copy(isMine = true)))))
        val noWallet = buyPrimary(buy.copy(wallet = MarketWalletUi(false)))!!
        assertEquals(CommandState.LOCKED, noWallet.state)
        assertEquals(PrimaryAction.LINK_WALLET, noWallet.action)
        assertEquals("Wallet payments are not available in this build.", buyPrimary(buy.copy(paymentsAvailable = false))!!.reason)
        val short = buyPrimary(buy.copy(wallet = buy.wallet.copy(keepBaseUnits = 5 * keep)))!!
        assertEquals(CommandState.SHORT, short.state)
        assertEquals(PrimaryAction.NEED_MORE, short.action)
        assertEquals(PriceStatus.SHORT, short.price!!.status)
        // An unknown balance is never SHORT: the wallet decides.
        assertEquals(PrimaryAction.START, buyPrimary(buy.copy(wallet = buy.wallet.copy(keepBaseUnits = null)))!!.action)
    }

    // DESIGN-SYSTEM §6 money sequence: nothing can be sent twice; BOUGHT shows only after the receipt (the SENT stage).
    @Test fun `the money sequence never takes a second tap while in flight`() {
        assertEquals(CommandState.BUSY, buyPrimary(buy.copy(money = MoneyStage.CHECK_WALLET))!!.state)
        assertEquals(CommandState.BUSY, buyPrimary(buy.copy(money = MoneyStage.SENDING))!!.state)
        val bought = buyPrimary(buy.copy(money = MoneyStage.SENT))!!
        assertEquals("BOUGHT", bought.label)
        assertEquals(Verb.MOSS, bought.verb)
        assertEquals(PrimaryAction.NONE, bought.action)
        val retry = buyPrimary(buy.copy(money = MoneyStage.FAILED))!!
        assertEquals("RETRY", retry.label)
        assertEquals(PrimaryAction.START, retry.action)
    }

    @Test fun `the BUY seal names pay and get and never claims a result`() {
        val seal = buySeal(lot, 10, frostglass, armedAtMs = 42)
        assertEquals("BUY 10 FROSTGLASS", seal.title)
        assertEquals("18", seal.price.amount)
        assertEquals(Currency.KEEP, seal.price.currency)
        assertEquals("10", seal.gets!!.amount)
        assertEquals(frostglass.icon, seal.gets!!.icon)
        assertEquals("BUY", seal.confirmLabel)
        assertEquals(42L, seal.armedAtMs)
        assertTrue(seal.lines.none { it.contains("Nothing") })
        assertTrue(buySeal(lot.copy(currency = Currency.SOL), 1, frostglass, 0).lines.first().contains("SOL"))
    }

    // Design correction 7: only an authoritative failure may say nothing was sent.
    @Test fun `a lost buy answer is checked, not declared unsent`() {
        assertEquals("Wallet didn't answer. Nothing was sent.", buyFailureCopy(authoritative = true))
        assertFalse(buyFailureCopy(authoritative = false).contains("Nothing"))
    }

    @Test fun `lot lines name the price, the seller and what you hold`() {
        assertEquals("1.8 KEEP each · from Ashford" to "You hold 14. For tools and kits.", lotLines(lot, 14, frostglass))
        assertEquals("Your lot · manage it in ORDERS", lotLines(lot.copy(isMine = true), 14, frostglass).second)
        assertEquals("You hold ….", lotLines(lot, null, null).second)
    }

    private val sell = MarketSellUi(listOf(SellableUi("frostglass", 14, 3)), "frostglass", qty = 10, unitPrice = 19 * keep / 10,
        tick = keep / 10, lowestOffer = 18 * keep / 10, feeBps = 500, slots = MarketSlotsUi(3, 5), listingAllowed = true, items = items)

    @Test fun `SELL lists only what is free and explains locks and full slots`() {
        assertEquals("LIST 10", sellPrimary(sell)!!.label)
        assertEquals("Frostglass at 1.9 each", sellPrimary(sell)!!.sub)
        assertEquals(14L, sellQuantity(sell.copy(qty = 99)))
        assertEquals(CommandState.LOCKED, sellPrimary(sell.copy(listingAllowed = false))!!.state)
        val full = sellPrimary(sell.copy(slots = MarketSlotsUi(5, 5)))!!
        assertEquals(PrimaryAction.OPEN_ORDERS, full.action)
        assertEquals("All 5 slots are in use. Take one back in ORDERS.", full.reason)
        assertEquals("You get 18.05 KEEP" to "19 total, market fee 5%", proceedsLines(sell))
        assertEquals("LIST 10 FROSTGLASS", listReview(sell)!!.title)
    }

    @Test fun `price steps by one server tick and never below it`() {
        assertEquals(18 * keep / 10, stepPrice(19 * keep / 10, -1, keep / 10))
        assertEquals(keep / 10, stepPrice(keep / 10, -1, keep / 10))
        assertEquals(keep / 10, stepPrice(null, 1, keep / 10))
        assertEquals(5L, stepPrice(5, 1, null))
    }

    @Test fun `orders read sold, on sale, paying and free slots`() {
        assertEquals("CROWNSTEEL x6", orderTitle("Crownsteel", 6))
        assertEquals("LAND DEED", orderTitle("Land Deed", 1))
        val open = OpenOrderUi("l-1", "frostglass", 10, 4, "1.9", Currency.KEEP, OpenOrderState.OPEN, "b")
        assertEquals("4 sold · 1.9 each", openLine(open))
        assertEquals("none sold · 1.9 each", openLine(open.copy(sold = 0)))
        assertEquals("2.5 SOL · buyer paying", openLine(open.copy(unitPrice = "2.5", currency = Currency.SOL, state = OpenOrderState.PAYING)))
        assertEquals(0.4f, openProgress(open), 0.0001f)
        assertEquals("2 free slots. List from SELL.", freeSlotsLine(MarketSlotsUi(3, 5)))
        assertEquals("1 free slot. List from SELL.", freeSlotsLine(MarketSlotsUi(4, 5)))
        assertNull(freeSlotsLine(null))
        assertEquals("Take back 6 Frostglass? They return to your stores.", takeBackReview(open, frostglass).line)
        assertEquals("14.4 KEEP · 2h ago", soldLine(SoldOrderUi("s", "crownsteel", 6, "14.4", Currency.KEEP, "2h ago")))
        assertEquals(PrimaryAction.OPEN_SELL, ordersPrimary().action)
    }
}
