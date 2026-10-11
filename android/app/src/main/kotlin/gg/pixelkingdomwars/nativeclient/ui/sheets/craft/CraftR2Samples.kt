package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Preview data for the craft cluster's round-2 frames (the mock values of market-owned.png, market-sol.png,
 * market-orders.png, market-sell.png and harvester-history.png). Every number here is a placeholder: in the app all
 * values come from the server, already formatted. Not used outside @Preview functions.
 */
internal object CraftR2Samples {
    private fun sol(amount: String) = PriceUi(Currency.SOL, amount, PriceStatus.OK)
    private fun keep(amount: String) = PriceUi(Currency.KEEP, amount, PriceStatus.OK)

    /** market-owned.png. */
    val owned = OwnedUi(
        stores = listOf(
            LotUi("frostglass", craftItemIcon("frostglass"), "×14", "Frostglass, 14 in your stores"),
            LotUi("crownsteel", craftItemIcon("crownsteel"), "×6", "Crownsteel, 6 in your stores"),
            LotUi("heartwood_beams", craftItemIcon("heartwood_beams"), "×22", "Heartwood Beams, 22 in your stores"),
            LotUi("embercore", craftItemIcon("embercore"), "×1", "Embercore, 1 in your stores"),
        ),
        storesTotal = 16,
        wallet = listOf(
            OwnedRowUi("deed-home", "ui_portrait_keep_t3", "Ironhold deed", "your home kingdom", OwnedState.IN_USE),
            OwnedRowUi("veh-b1", "voyage:veh-survey-balloon-t1", "Survey Balloon T1", "in your wallet", OwnedState.CAN_SELL),
            OwnedRowUi("veh-a3", "voyage:veh-courier-airship-t3", "Airship T3", "at the Berth", OwnedState.INSTALLED),
            OwnedRowUi("awning-2", "craft:awning_t2", "Awning II", "on this Market", OwnedState.IN_USE),
        ),
        selected = OwnedDetailUi("veh-b1", "voyage:veh-survey-balloon-t1", "Survey Balloon T1", "10/10 trips · spare, not installed",
            "Others sold for about 0.06 SOL", OwnedState.CAN_SELL),
        primary = CommandUi(FeatureId("market.collection"), "sol", "SELL BALLOON", null, true, CommandState.ENABLED, null, null, sub = "set your price next"),
        secondary = CommandUi(FeatureId("berth.fleet"), "shape:anchor", "INSTALL", null, false, CommandState.ENABLED, null, null,
            verb = Verb.BLUE, sub = "at the Berth"),
        walletLinked = true,
    )

    /** A spare deed that trades only on outside marketplaces: CAN SELL + blue OPEN (the design's "OPEN ↗"; the arrow glyph
     *  is not in the bundled faces, so the sub-line says where it goes). */
    val ownedOutside = owned.copy(
        wallet = owned.wallet + OwnedRowUi("deed-142", "itm_deed_earth", "Land deed #142", "in your wallet", OwnedState.OUTSIDE_ONLY),
        selected = OwnedDetailUi("deed-142", "itm_deed_earth", "Land deed #142", "a spare deed, not your home", null, OwnedState.OUTSIDE_ONLY),
        primary = CommandUi(FeatureId("market.collection"), "itm_deed_earth", "OPEN", null, true, CommandState.ENABLED, null, null,
            verb = Verb.BLUE, sub = "on an outside marketplace"),
        secondary = null,
    )

    /** market-sol.png lots. */
    val solStall = SolStallUi(
        filter = SOL_STALL_SECTION,
        lots = listOf(
            SolLotUi("lot-b2", "voyage:veh-survey-balloon-t2", "T2", sol("0.08"), "Rook of Ashford", "10/10 trips", "Survey Balloon T2"),
            SolLotUi("lot-c2", "voyage:veh-cargo-cutter-t2", "T2", sol("0.12"), "Mira of Glasswake", "10/10 trips", "Cargo Cutter T2"),
            SolLotUi("lot-a3", "voyage:veh-courier-airship-t3", "T3", sol("0.30"), "Duke Halvar", "10/10 trips", "Courier Airship T3"),
            SolLotUi("lot-x1", "voyage:veh-expedition-barge-t1", "T1", sol("0.05"), "Brin of Thornwake", "10/10 trips", "Expedition Barge T1"),
        ),
        selected = "lot-b2",
        seal = null,
        filters = listOf(MarketCategoryUi("materials", "MATERIALS"), MarketCategoryUi("tools", "TOOLS"),
            MarketCategoryUi(SOL_STALL_SECTION, "SOL STALL", "sol")),
        total = 12,
    )

    /** The market-sol.png Seal (fee 5 %). */
    val solSeal: MarketSealUi = solBuySeal(solStall.lots.first(), 500, 0L)

    private fun place(id: String, item: String, itemId: String, count: String, price: PriceUi, state: StallPlaceState, line: String,
        takeBack: Boolean) = StallPlaceUi(item, craftItemIcon(itemId), count, price, state, line,
        if (takeBack) CommandUi(FeatureId("market.trade"), "backpack", "BACK", null, false, CommandState.ENABLED, null, null) else null,
        listingId = id)

    /** market-orders.png (re-done): sold, two on the table, one being paid, two free. */
    val offers = MarketOffersUi(
        places = listOf(
            place("s-1", "Crownsteel", "crownsteel", "x6", keep("2.4"), StallPlaceState.SOLD, "14.4 to wallet", false),
            place("l-1", "Frostglass", "frostglass", "x6", keep("1.9"), StallPlaceState.ON_TABLE, "4 of 10 sold", true),
            place("l-2", "Fragments", "crystal_fragments", "x5", keep("4.0"), StallPlaceState.ON_TABLE, "none yet", true),
            place("l-3", "Land deed", "land_deed", "", sol("2.5"), StallPlaceState.PAYING, "being paid", false),
        ),
        freePlaces = 2, maxPlaces = 6,
    )

    /** market-sell.png (re-done). */
    val sellV2 = MarketSellV2Ui(CraftSamples.sell, earnLine = "You get 18.0 KEEP", cutLine = "the realm's cut is 1.0 of 19.0", othersPriceHint = "1.8")

    private val days = listOf("Fri" to 36L, "Sat" to 48L, "Sun" to 48L, "Mon" to 24L, "Tue" to 48L, "Wed" to 48L, "Today" to 36L)

    /** harvester-history.png. */
    val history = HarvesterHistoryTabUi(
        resourceId = "crown_iron_ore",
        days = days.map { (d, n) -> DayBarUi(d, n.toString(), d == "Today", n) },
        weekTotal = "288",
        groups = listOf(
            HaulGroupUi("TODAY", listOf(
                HaulRowUi("14:20", "12", HaulKind.HAUL, "into your stores", id = "h-6"),
                HaulRowUi("08:20", "12", HaulKind.HAUL, "into your stores", id = "h-5"),
                HaulRowUi("02:20", "12", HaulKind.HAUL, "into your stores", id = "h-4"),
            )),
            HaulGroupUi("MONDAY", listOf(
                HaulRowUi("20:20", "12", HaulKind.HAUL, "into your stores", id = "h-3"),
                HaulRowUi("11:05", "", HaulKind.LEVEL, "Reached Lv 2: +4 a haul", id = "lv-2", tag = "LV 2"),
            )),
        ),
        refreshedAgo = "2 min ago",
        nextCursor = null,
        resourceName = "Crown Iron Ore",
    )

    /** A round-2 Market sheet on [tab] with every round-2 state filled; the frame's live chip reads "2 on your stall". */
    fun marketR2(tab: String): MarketSheetR2Ui {
        val base = CraftSamples.market(buy = CraftSamples.buy).let { m ->
            m.copy(frame = m.frame.copy(selectedTab = tab, tabs = marketTabsR2(),
                live = CraftLiveUi("ui:queue-status", "2 on your stall")), sell = CraftSamples.sell, orders = CraftSamples.orders)
        }
        return MarketSheetR2Ui(base, owned = owned, offers = offers, sellV2 = sellV2)
    }
}
