package gg.pixelkingdomwars.nativeclient.ui.land

import gg.pixelkingdomwars.nativeclient.data.LandCheckoutBounds
import gg.pixelkingdomwars.nativeclient.data.LandCheckoutState
import gg.pixelkingdomwars.nativeclient.data.LandPhase
import gg.pixelkingdomwars.nativeclient.data.WorldState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.RealmLock
import gg.pixelkingdomwars.nativeclient.wallet.LandFundingEstimate
import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger
import java.io.File

class LandLiveMapperTest {
    private val bounds = LandCheckoutBounds(1_000, 1_000, 1_000, 1_000)
    private val reservation = LandDeposit(id = "deposit", kind = "entry", status = "pending", reference = "reference",
        baseId = "base", amountLamports = "200000001", landAddress = LandAddress.fantasy(42),
        fantasyLocation = FantasyTile("fantasy-v1", 42, "crownlands"),
        serverNow = "2026-10-05T00:00:00Z", payableUntil = "2026-10-05T00:01:00Z")
    private fun state() = LandUiState(checkout = LandCheckoutState(phase = LandPhase.READY, reservation = reservation,
        serverNowMs = java.time.Instant.parse("2026-10-05T00:00:00Z").toEpochMilli(), observedAtMs = 0L), bounds = bounds, wallet = "wallet",
        realmNames = mapOf("crownlands" to "Crownlands"))

    @Test fun `before the server freezes a reservation price remains unknown`() {
        val price = liveLandPrice(LandUiState())
        assertNull(price.amount)
        assertEquals(PriceStatus.CHECKING, price.status)
    }

    @Test fun `frozen SOL price preserves every lamport without float or two-decimal truncation`() {
        assertEquals("0.200000001", liveLandPrice(state()).amount)
        val large = state().copy(checkout = state().checkout.copy(reservation = reservation.copy(amountLamports = "9007199254740993")))
        assertEquals("9007199.254740993", liveLandPrice(large).amount)
    }

    @Test fun `negative malformed and zero purchase amounts never become a payable land quote`() {
        for (amount in listOf("-1", "wat", "0")) {
            val bad = state().copy(checkout = state().checkout.copy(reservation = reservation.copy(amountLamports = amount)))
            assertNotNull(landPayUnavailable(bad, busy = false, signerAvailable = true, now = 0L))
        }
    }

    @Test fun `additional deed preserves owner purchase support without the first-land ownership lock`() {
        val additional = state().copy(landOwned = true, checkout = state().checkout.copy(purchaseKind = "deed"))
        val gate = liveLandGate(additional)
        assertFalse(gate.alreadyOwned)
        assertFalse(gate.priceLine.contains("One land per wallet"))
        assertEquals("FOUND ANOTHER KEEP", gate.title)
    }

    @Test fun `realm counts come from server and reserved or full realms stay locked`() {
        val world = WorldState(globe = FantasyGlobe("fantasy-v1", ready = true, realms = listOf(
            FantasyRealm("crownlands", occupied = 7, available = 2),
            FantasyRealm("frostveil", occupied = 12, available = 0),
            FantasyRealm("seeker-reach", available = 10))))
        val picker = liveRealmPicker(LandUiState(world = world))
        assertEquals("7 kingdoms", picker.realms[0].kingdoms)
        assertEquals(RealmLock.FULL, picker.realms[1].lock)
        assertEquals(RealmLock.SKR_UNLOCK, picker.realms[2].lock)
    }

    @Test fun `settling a realm waits for an inspected exact tile instead of globally random land`() {
        val picked = LandUiState(picker = TilePicker("crownlands"), bounds = bounds)
        assertNotNull(landDraftUnavailable(picked, false))
        val inspected = picked.copy(checkout = LandCheckoutState(draftedTile = 42), picker = TilePicker("crownlands",
            parcel = FantasyParcel("fantasy-v1", FantasyTile("fantasy-v1", 42, "crownlands"), "available")))
        assertNull(landDraftUnavailable(inspected, false))
        assertNotNull(landDraftUnavailable(inspected.copy(picker = inspected.picker.copy(realmId = "frostveil")), false))
    }

    @Test fun `a map owner drafted tile remains reservable without a second list picker publication`() {
        assertNull(landDraftUnavailable(LandUiState(checkout = LandCheckoutState(draftedTile = 42), bounds = bounds), false))
    }

    @Test fun `payment review freezes exact quote wallet kind and network`() {
        val current = state()
        val review = requireNotNull(captureLandReview(current))
        assertTrue(landReviewCurrent(review, current))
        assertFalse(landReviewCurrent(review, current.copy(wallet = "other")))
        assertFalse(landReviewCurrent(review, current.copy(checkout = current.checkout.copy(purchaseKind = "deed"))))
        assertFalse(landReviewCurrent(review, current.copy(checkout = current.checkout.copy(reservation = reservation.copy(amountLamports = "200000002")))))
        assertFalse(landReviewCurrent(review, current.copy(checkout = current.checkout.copy(phase = LandPhase.PAYING))))
    }

    @Test fun `Seal contains exact frozen tile and correct additional deed copy`() {
        val current = state().copy(checkout = state().checkout.copy(purchaseKind = "deed", reservation = reservation.copy(kind = "deed")))
        val seal = liveLandSeal(requireNotNull(captureLandReview(current)), 42L)
        assertEquals("0.200000001", seal.price.amount)
        assertTrue(seal.lines.any { it.contains("42") })
        assertFalse(seal.lines.any { it.contains("One land per wallet") })
        assertEquals(42L, seal.armedAtMs)
    }

    @Test fun `unknown fee permits owner check but known shortfall missing signer and busy hold pay`() {
        val current = state()
        assertNull(landPayUnavailable(current, false, true, 0L))
        assertNotNull(landPayUnavailable(current, false, false, 0L))
        assertNotNull(landPayUnavailable(current, true, true, 0L))
        val estimate = LandFundingEstimate(BigInteger("200000001"), BigInteger.ONE, BigInteger.ZERO, BigInteger.ZERO)
        assertNotNull(landPayUnavailable(current.copy(checkout = current.checkout.copy(estimate = estimate)), false, true, 0L))
    }

    @Test fun `local payment window cannot strand a saved reservation before the owner rechecks the server`() {
        val current = state()
        assertEquals(0L, current.checkout.payableRemainingSec(61_000L))
        assertNull(landPayUnavailable(current, false, true, 61_000L))
        assertSame(reservation, current.reservation)
        // The explicit BUY LAND action still goes through owner pay(), which rereads the deposit and window.
    }

    @Test fun `existing ownership never manufactures a new purchase celebration`() {
        assertTrue(LandUiState(landOwned = true).paymentCredited)
        assertNull(liveLandDone(LandUiState(landOwned = true)))
        assertNull(liveLandDone(LandUiState(checkout = LandCheckoutState(phase = LandPhase.CREDITED))))
    }

    @Test fun `credited deposit celebrates without falsely claiming deed mint is finished`() {
        val credited = state().copy(checkout = state().checkout.copy(phase = LandPhase.CREDITED,
            reservation = reservation.copy(status = "credited")))
        val done = requireNotNull(liveLandDone(credited))
        assertEquals("deposit", done.receiptId)
        assertNull(done.keepTier)
        assertTrue(done.facts.any { it.text.contains("minting") })
        assertFalse(done.facts.any { it.text.contains("sent to your wallet") })
        assertTrue(done.facts.any { it.text.contains("42") })
    }

    @Test fun `server failed means payment was seen and must never be called a no-spend refusal`() {
        val failed = state().copy(checkout = state().checkout.copy(phase = LandPhase.FAILED))
        val text = requireNotNull(landCheckoutLine(failed))
        assertTrue(text.contains("payment was seen"))
        assertFalse(text.contains("Nothing was spent"))
        assertNotNull(landPayUnavailable(failed, false, true, 0L))
    }

    @Test fun `confirming remains visibly checking without a fake manual recheck action`() {
        val checking = state().copy(checkout = state().checkout.copy(phase = LandPhase.CONFIRMING))
        assertTrue(requireNotNull(landCheckoutLine(checking)).contains("checking"))
        assertNotNull(landPayUnavailable(checking, false, true, 0L))
    }
    @Test fun `land Seal owns Back until its visual exit finishes`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/land/LandGateScreen.kt").readText()
        val open = source.substringAfter("fun reviewLand()").substringBefore("fun reserveDraft()")
        assertTrue("Opening consent reserves Back ownership", open.contains("sealVisible = true"))
        assertTrue(source.contains("BackPriority.CONFIRM, enabled = sealVisible || confirmSignOut"))
        assertTrue(source.contains("BackPriority.SCREEN, enabled = !sealVisible && !confirmSignOut"))
        assertTrue("A second Back during fade only consumes the event", source.contains("sealVisible -> review = null"))
        assertTrue("Only the actual exit callback releases ownership", source.contains("onExitFinished = { sealVisible = false }"))
    }

    @Test fun `initial realm read failure retains an owner refresh door before opening the picker`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/land/LandGateScreen.kt").readText()
        val common = source.substringAfter("val common: @Composable ColumnScope.() -> Unit = {").substringBefore("val utilities:")
        assertTrue(common.contains("state.world.error != null || state.world.unavailable != null || state.realms.isEmpty()"))
        assertTrue(common.contains("SecondaryButton(\"REFRESH REALMS\""))
        assertTrue("Realm retry uses the existing busy-guarded owner", common.contains("action(model::refreshWorld)"))
        assertTrue("The initial gate mounts the shared recovery door", source.contains("beforeBenefits = common"))
    }

    // ---- land-gate / land-realm / land-seal / land-done frame parity (night 2026-10-06) ----

    @Test fun `first land gate promises only what the frame says`() {
        // "Your base stays" is the whole promise: what else carries over is an open owner decision.
        assertEquals("One land per wallet. Your base stays.", liveLandGate(state()).priceLine)
        assertEquals("CLAIM YOUR LAND", liveLandGate(state()).title)
    }

    @Test fun `realm counts are grouped server numbers and the Reach card keeps the designed SKR unlock words`() {
        val world = WorldState(globe = FantasyGlobe("fantasy-v1", ready = true, realms = listOf(
            FantasyRealm("crownlands", occupied = 3112, available = 2),
            FantasyRealm("seeker-reach", available = 10))))
        val picker = liveRealmPicker(LandUiState(world = world))
        assertEquals("3,112 kingdoms", picker.realms[0].kingdoms)
        assertEquals(RealmLock.SKR_UNLOCK, picker.realms[1].lock)
        assertNull("A null reason draws the frame's SKR unlock line", picker.realms[1].lockReason)
    }

    @Test fun `a locked Reach tap says plainly that its SKR unlock is not open`() {
        // reach-seal has no backing system: the door must say so instead of implying a sale.
        val reach = lockedRealmMessage("seeker-reach", "Solana Reach")
        assertTrue(reach.contains("SKR"))
        assertTrue(reach.contains("not open yet"))
        assertTrue(lockedRealmMessage("frostveil", "Frostveil").contains("full right now"))
    }

    @Test fun `settle names the chosen realm and shows only the server price`() {
        val picked = LandUiState(picker = TilePicker("crownlands"), bounds = bounds, realmNames = mapOf("crownlands" to "Crownlands"))
        val unknown = requireNotNull(liveRealmPicker(picked).primaryOverride)
        assertEquals("SETTLE IN CROWNLANDS", unknown.label)
        assertEquals("Before the server freezes a quote the price is the unknown mark, never a typed number",
            "… SOL · one land per wallet", unknown.sub)
        val quoted = requireNotNull(liveRealmPicker(state().copy(picker = TilePicker("crownlands"))).primaryOverride)
        assertEquals("0.200000001 SOL · one land per wallet", quoted.sub)
    }

    @Test fun `an additional deed never says one land per wallet on the realm sheet`() {
        val deed = LandUiState(picker = TilePicker("crownlands"), bounds = bounds, checkout = LandCheckoutState(purchaseKind = "deed"))
        assertFalse(requireNotNull(liveRealmPicker(deed).primaryOverride?.sub).contains("one land per wallet"))
    }

    @Test fun `a tile drafted outside the listed realm is reviewed by number and not under the wrong realm name`() {
        val mapDraft = LandUiState(picker = TilePicker("frostveil"), checkout = LandCheckoutState(draftedTile = 42), bounds = bounds)
        assertEquals("REVIEW TILE 42", liveRealmPicker(mapDraft).primaryOverride?.label)
        val inspected = mapDraft.copy(realmNames = mapOf("crownlands" to "Crownlands"), picker = TilePicker("crownlands",
            parcel = FantasyParcel("fantasy-v1", FantasyTile("fantasy-v1", 42, "crownlands"), "available")))
        val look = requireNotNull(liveRealmPicker(inspected).primaryOverride)
        assertEquals("SETTLE IN CROWNLANDS", look.label)
        assertTrue(requireNotNull(look.sub).startsWith("Tile 42 · "))
    }

    @Test fun `first land Seal carries the frame lines with the fee as fine print`() {
        val seal = liveLandSeal(requireNotNull(captureLandReview(state())), 7L)
        assertEquals("BUY LAND IN CROWNLANDS?", seal.title)
        assertEquals("BUY LAND", seal.confirmLabel)
        assertEquals("The pay token is the server's exact quote", "0.200000001", seal.price.amount)
        assertEquals("DEED", seal.gets?.amount)
        assertEquals("Paid from your wallet. You sign once.", seal.lines.first())
        val gets = seal.lines.indexOf("Your base gets a tile in Crownlands and a deed you own.")
        val fee = seal.lines.indexOf("One land per wallet. The network fee is shown in your wallet.")
        assertTrue(gets > 0)
        assertTrue("The network fee is fine print after what the player gets", fee > gets)
        assertTrue("The exact parcel the player signs for stays visible", seal.lines.any { it.contains("Tile 42") })
        assertTrue(seal.lines.last().contains("Devnet"))
    }

    @Test fun `celebration facts follow the frame with a grouped tile and what land opens`() {
        val credited = state().copy(deedReady = true, checkout = state().checkout.copy(phase = LandPhase.CREDITED,
            reservation = reservation.copy(status = "credited", landAddress = LandAddress.fantasy(4812))))
        val done = requireNotNull(liveLandDone(credited))
        assertEquals("Kingdom Deed is in your wallet", done.facts[0].text)
        assertEquals("Crownlands · tile 4,812", done.facts[1].text)
        assertEquals("Leagues and the Gold Forge are open", done.facts[2].text)
    }
}
