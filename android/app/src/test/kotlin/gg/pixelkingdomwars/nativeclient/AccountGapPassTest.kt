package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.LandCheckoutBounds
import gg.pixelkingdomwars.nativeclient.data.LandCheckoutState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.ui.land.LAND_CHOOSE_TILE
import gg.pixelkingdomwars.nativeclient.ui.land.LandUiState
import gg.pixelkingdomwars.nativeclient.ui.land.TileCell
import gg.pixelkingdomwars.nativeclient.ui.land.TilePicker
import gg.pixelkingdomwars.nativeclient.ui.land.landDraftUnavailable
import gg.pixelkingdomwars.nativeclient.ui.land.landSettleTile
import gg.pixelkingdomwars.nativeclient.ui.land.liveRealmPicker
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.profile.profileLastNews
import gg.pixelkingdomwars.nativeclient.ui.profile.profileNewsLoad
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.live.SupplyTarget
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.live.suppliesSolBuy
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.live.suppliesSolLines
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.live.suppliesSolTitle
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.realmHeaderRows
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.realmHeaderTop
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.realmHeaderZoom
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.SOL_SIGN_ONCE
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The account-group gap pass (morning 2026-10-06; owner: "always loading", "I should not see any even 1 of old screens",
 * design/final/account frames). Each case pins WHY the behaviour matters to the player, not only what it returns.
 */
class AccountGapPassTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
    private fun source(path: String) = File("$root/$path").readText()
    private fun home(baseId: String?) = BaseState(base = BaseSnapshot(baseId = baseId, visualContext = null, player = PlayerSummary(keepLevel = 3),
        energy = null, armyStatus = null, claim = null, buildings = emptyList(), obstacles = emptyList(), jobs = emptyList(),
        freeBuilders = 0, raw = JsonObject(emptyMap())))

    // ---- Profile opens with last known data and refreshes silently ----

    // WHY: reopening Profile must show the kingdom the player just saw, not a skeleton, but never another kingdom's news.
    @Test fun `Profile opens with the selected kingdom last read and never another kingdom read`() {
        assertEquals("base-a", profileLastNews(home("base-a"), "base-a")?.base?.baseId)
        assertNull("Another kingdom's read is not this kingdom's news", profileLastNews(home("base-b"), "base-a"))
        assertNull("No read yet means nothing to show", profileLastNews(BaseState(), "base-a"))
    }

    // WHY: the owner saw "always loading"; a routine refresh over shown news must not drop back to the skeleton.
    @Test fun `a refresh over known news stays ready and only an empty open shows loading`() {
        assertEquals(LoadState.Ready, profileNewsLoad(home("base-a"), valid = true, readError = null, asOf = null))
        assertEquals(LoadState.Loading, profileNewsLoad(null, valid = true, readError = null, asOf = null))
        assertEquals(LoadState.Loading, profileNewsLoad(home("base-a"), valid = false, readError = null, asOf = null))
        val failed = profileNewsLoad(home("base-a"), valid = true, readError = "Can't reach your kingdom.", asOf = "14:02")
        assertEquals("A failed read keeps the news under its error and says when it is from",
            LoadState.Error("Can't reach your kingdom.", asOf = "14:02"), failed)
    }

    // WHY: the wallet, deed directory and security status the player already saw stay on screen through a failed refresh.
    @Test fun `Profile seeds every tab from last known state and keeps it through a failed refresh`() {
        val hub = source("ui/profile/ProfileHub.kt")
        assertTrue(hub.contains("mutableStateOf(profileLastNews(session.base.state.value, account.selectedBaseId))"))
        assertTrue(hub.contains("mutableStateOf(skrFaucetKeptFunds(null, session.economy.state.value))"))
        assertTrue(hub.contains("mutableStateOf(account.directory != null)"))
        assertTrue(hub.contains("funds = observed.wallet ?: funds"))
        for (blanking in listOf("directoryRead && readError == null", "securityRead && readError == null", "funds.takeIf { valid && readError == null }"))
            assertFalse(blanking, hub.contains(blanking))
        assertFalse("A directory read must not turn every SWITCH into busy dots", hub.contains("accountBusy || reading"))
    }

    // ---- the living header shows real art, not a flat box ----

    // WHY: pixel art is only ever drawn at whole-number zoom, and the header band must stay inside the painting.
    @Test fun `the header band is a whole-number zoom crop that stays inside the painting`() {
        assertEquals(3, realmHeaderZoom(540, 1152f))
        assertEquals(1, realmHeaderZoom(540, 300f))
        val rows = realmHeaderRows(1200, 414f, 3)
        assertEquals(138, rows)
        val top = realmHeaderTop(1200, rows, 0.27f)
        assertEquals(324 - 69, top)
        assertEquals("A focus at the bottom edge never reads past the painting", 1200 - rows, realmHeaderTop(1200, rows, 1f))
        assertEquals(0, realmHeaderTop(1200, rows, 0f))
        assertEquals("A band taller than the painting is the whole painting", 1200, realmHeaderRows(1200, 9_000f, 1))
    }

    @Test fun `Profile and land gate headers draw the realm painting when no live crop exists`() {
        assertTrue(source("ui/sheets/account/ProfileCard.kt").contains("else RealmHeaderArt(Modifier.fillMaxSize())"))
        assertTrue(source("ui/sheets/account/LandGateCard.kt").contains("else RealmHeaderArt(Modifier.fillMaxSize())"))
    }

    // ---- BUILD › SUPPLIES SOL offers stay on the designed shelf ----

    // WHY: the Seal's first word is its confirm button; a builder is hired, everything else is bought.
    @Test fun `SOL supply Seals read HIRE for a builder and BUY for everything else`() {
        assertEquals("BUY SHIELD EXTENSION", suppliesSolTitle("SHIELD EXTENSION"))
        assertEquals("HIRE A BUILDER", suppliesSolTitle("HIRE A BUILDER"))
        assertEquals("BUY RAID ENERGY", suppliesSolTitle("raid energy"))
        assertEquals("BUY", suppliesSolTitle(null))
        val buy = suppliesSolBuy(SupplyTarget.BasePurchase("shield", "base-a"), "SHIELD EXTENSION")
        assertEquals("shield", buy.kind); assertEquals("base-a", buy.baseId)
    }

    // WHY: consent must carry the purchase screen's own shield risk sentence and the sign-once line; the fee line only once
    // the owner's review of this exact purchase arrived.
    @Test fun `SOL supply Seal lines keep the purchase screen facts and the fee only after review`() {
        val before = suppliesSolLines("shield", null)
        assertTrue(before.first().startsWith("Extends your current shield. If the shield breaks"))
        assertTrue(before.contains(SOL_SIGN_ONCE))
        assertEquals(2, before.size)
        val review = BasePurchaseOffer(kind = "energy", baseId = "base-a", amountLamports = "1000000", energyQuantity = 5)
        val energy = suppliesSolLines("energy", review)
        assertEquals("Energy has no extra fact; the owner's fee line follows the sign-once line", listOf(SOL_SIGN_ONCE), energy.dropLast(1))
        assertTrue(energy.last().contains("+5 RAID ENERGY"))
    }

    // WHY: the shelf must not leave for the old dark PURCHASES page; the money still runs only through the existing owner.
    @Test fun `Home Supplies raise SOL offers in place through the existing purchase owner`() {
        val body = source("ui/sheets/account/live/SuppliesHomeBody.kt")
        assertTrue(body.contains("solPurchase: HomeSolPurchase? = null"))
        assertTrue(body.contains("rememberSuppliesSolVisit(owner, buy"))
        assertTrue(body.contains("SolPurchaseOverlay(solPurchase, visit.flow, visit.buy.title, visit.lines)"))
        assertTrue("Without the Home owner (ShopRoute) the purchase screen still takes the buy", body.contains("if (solPurchase == null) { onPurchase(target.kind, target.baseId) }"))
        val sol = source("ui/sheets/account/live/SuppliesSolBuy.kt")
        assertTrue(sol.contains("rememberSolPurchase(purchase, buy.kind, buy.baseId, null"))
        for (money in listOf("BasePurchaseViewModel(", ".buy(", "retryPay(", "signAndSend", "Repository("))
            assertFalse("No new money code: $money", sol.contains(money))
        val app = source("ui/nav/PkwApp.kt")
        val mount = app.substringAfter("supplies = { tabs, onTab, onBuilders, onClose, placed ->").substringBefore("onReviewBlockedChanged = reportReview")
        assertTrue(mount.contains("solPurchase = homeSolPurchase"))
    }

    // ---- land-realm: realm card → SETTLE → Seal, no tile grid ----

    private val bounds = LandCheckoutBounds(1_000, 1_000, 1_000, 1_000)

    // WHY: the frame settles a realm in one tap; the first tile the picker did not see taken is the one the owner inspects.
    @Test fun `SETTLE picks the first free candidate of the realm and skips tiles already seen taken`() {
        val picked = LandUiState(picker = TilePicker("crownlands", tiles = listOf(TileCell(10, occupied = true),
            TileCell(11, occupied = false, availability = "held"), TileCell(12, occupied = false), TileCell(13, occupied = false))), bounds = bounds)
        assertEquals(LAND_CHOOSE_TILE, landDraftUnavailable(picked, false))
        assertEquals(12, landSettleTile(picked, false))
        assertEquals("The realm sheet's SETTLE is live when it can settle by itself",
            CommandState.ENABLED, liveRealmPicker(picked).primaryOverride?.state)
    }

    // WHY: SETTLE may only clear the missing-tile hold; a busy owner, a saved reservation or no free tile keeps it shut.
    @Test fun `SETTLE does nothing by itself while another hold applies or nothing is free`() {
        val free = TilePicker("crownlands", tiles = listOf(TileCell(12, occupied = false)))
        assertNull(landSettleTile(LandUiState(picker = free, bounds = bounds), busy = true))
        assertNull("No recovery rules, no reservation", landSettleTile(LandUiState(picker = free), false))
        assertNull("A drafted tile is reviewed as drafted", landSettleTile(LandUiState(picker = free, bounds = bounds,
            checkout = LandCheckoutState(draftedTile = 40)), false))
        val taken = LandUiState(picker = TilePicker("crownlands", tiles = listOf(TileCell(12, occupied = true))), bounds = bounds)
        assertNull(landSettleTile(taken, false))
        assertEquals(CommandState.DISABLED, liveRealmPicker(taken).primaryOverride?.state)
        assertNull("No realm chosen", landSettleTile(LandUiState(bounds = bounds), false))
    }

    @Test fun `the realm sheet draws no numbered tile grid and SETTLE goes through the owner settle`() {
        val screen = source("ui/land/LandGateScreen.kt")
        assertFalse(screen.contains("LandTilePicker("))
        assertTrue(screen.contains("model.settleTile(settle)"))
        val model = source("ui/land/LandViewModel.kt")
        val settle = model.substringAfter("fun settleTile(tileId: Int) = run {").substringBefore("fun reserveRandom()")
        assertTrue("The exact parcel is inspected first", settle.contains("world.parcel(tileId)"))
        assertTrue("Only an available tile is reserved", settle.contains("if (parcel.available)"))
    }
}
