package gg.pixelkingdomwars.nativeclient.ui.profile

import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseCapabilities
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.headlineWhere
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Profile doors that lead to money owners only navigate, and they must open the right flow: a player who already
 *  paid for land is never sent to buy the entry again, and the PROFILE tab's INVITE door reaches the referral owner. */
class ProfileDoorsTest {
    private val wallet = "7xKpQ2mN8vR4tY6uW3zA1bC5dE9fG2hJ4f2k"
    private fun paidBase(id: String = "b1") = BaseSummary(id = id, status = "active", keepLevel = 12, slot = 1, deedAssetId = "Deed$id",
        landPaidAt = "2030-01-01T00:00:00.000Z")
    private fun directory(next: String?, vararg bases: BaseSummary) =
        BaseDirectory(enabled = true, nextLandPurchaseKind = next, capabilities = BaseCapabilities(true, true, true), bases = bases.toList())
    private fun account(entryPaid: Boolean?, directory: BaseDirectory?) =
        AccountState(identity = Identity(wallet, name = "Rowan", entryPaid = entryPaid), directory = directory)
    private fun home() = BaseState(base = BaseSnapshot(baseId = "base-a", visualContext = null, player = PlayerSummary(keepLevel = 7),
        energy = null, armyStatus = null, claim = null, buildings = emptyList(), obstacles = emptyList(), jobs = emptyList(),
        freeBuilders = 0, raw = JsonObject(emptyMap())))

    @Test fun `landless and unknown owners open the land gate at the entry`() {
        // No land yet: the gate sells the entry (the first land).
        assertEquals("entry", profileLandKind(account(entryPaid = false, directory = directory("deed"))))
        // Unread account or unread ownership: the entry, which the land owner itself refuses to charge twice; the Profile
        // card never draws a land door in this state anyway.
        assertEquals("entry", profileLandKind(AccountState()))
        assertEquals("entry", profileLandKind(account(entryPaid = null, directory = null)))
    }

    @Test fun `a landed owner never buys the entry twice and follows the directory next kind`() {
        assertEquals("deed", profileLandKind(account(entryPaid = true, directory = directory("deed", paidBase()))))
        // The server names nothing yet: another deed, never the entry (BasesScreen's rule).
        assertEquals("deed", profileLandKind(account(entryPaid = true, directory = directory(null, paidBase()))))
        assertEquals("deed", profileLandKind(account(entryPaid = true, directory = null)))
        // An old server without entryPaid proves ownership through a paid deed in the directory.
        assertEquals("deed", profileLandKind(account(entryPaid = null, directory = directory(null, paidBase()))))
        // A kind the land owner does not accept never reaches it (LandRepository only takes entry or deed).
        assertEquals("deed", profileLandKind(account(entryPaid = true, directory = directory("auction", paidBase()))))
    }

    @Test fun `INVITE is a stone PROFILE door to the referral owner once the kingdom is read`() {
        // SPEC rule 0.4 moves INVITE onto the PROFILE tab; it must open `profile.invite` (onReferrals), a page, so stone.
        val door = requireNotNull(profileHubBody(home(), LoadState.Ready).inviteDoor)
        assertEquals("INVITE", door.label)
        assertEquals(Verb.STONE, door.verb)
        assertEquals("profile.invite", door.link?.feature?.value)
        assertNull(door.lockedReason)
        // Before the kingdom is read Profile does not advertise it (the ACCOUNT options keep REFERRALS reachable).
        assertNull(profileHubBody(null, LoadState.Loading).inviteDoor)
    }

    @Test fun `the headline card shows the state over the place as the frame splits them`() {
        // hub.png: "ready to claim" (ink) over "Gold Forge" (ink-2); a line without a separator stays whole.
        assertEquals("ready to claim" to "Gold Forge", headlineWhere("ready to claim · Gold Forge"))
        assertEquals("ready to claim" to "daily quests · your kingdom", headlineWhere("ready to claim · daily quests · your kingdom"))
        assertEquals("Spot 142" to null, headlineWhere("Spot 142"))
    }
}
