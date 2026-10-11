package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.MailAttachment
import gg.pixelkingdomwars.nativeclient.model.MailMessage
import gg.pixelkingdomwars.nativeclient.model.MailPage
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LetterState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.*
import org.junit.Test

class MailLiveMapperTest {
    private val id = "00000000-0000-0000-0000-000000000001"
    private val base = "00000000-0000-0000-0000-000000000002"
    private val other = "00000000-0000-0000-0000-000000000003"
    private val time = "2026-10-05T01:00:00Z"
    private fun letter(rewards: List<MailAttachment> = listOf(MailAttachment("SHARDS", "9007199254740993"))) =
        MailMessage(id, "system", "reward", "A real reward", "The exact server body.", rewards,
            "pending", null, time, "2026-10-06T01:00:00Z", null, null, null, null)
    private fun pending(destination: String? = base, receipt: Boolean = false) = PendingIntent(
        IntentKind.MAIL_CLAIM, "wallet", destination, id, "/mail/$id/claim", buildJsonObject {}, "Claim mail reward",
        attempted = true, receipt = if (receipt) buildJsonObject {} else null)

    @Test fun `partial pages never turn pending reward count into a rewards filter total`() {
        val message = letter()
        val ui = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(message), id), status = MailStatus(21, 9, 4)))
        assertEquals(mapOf("ALL" to 21), ui.counts)
        assertTrue(ui.statusLine!!.contains("9 unread"))
        assertTrue(ui.statusLine!!.contains("4 pending rewards"))
        assertNull(ui.claimAll)
        assertTrue(ui.batchUnavailable!!.contains("each reward letter"))
    }

    @Test fun `empty inbox has the designed quests door but a partial filtered page does not`() {
        val empty = liveMailHubUi(CommunityState(mailbox = MailPage(emptyList(), null)), load = LoadState.Ready)
        assertEquals("SEE QUESTS", empty.empty.goLabel)
        assertEquals("hud.quests", empty.empty.go!!.value)
        val partial = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(letter()), id)), "NEWS")
        assertEquals("No matching letters loaded", partial.empty.headline)
        assertNull(partial.empty.go)
    }

    @Test fun `archive hides inbox totals and retains an honest empty archive state`() {
        val ui = liveMailHubUi(CommunityState(mailbox = MailPage(emptyList(), null), archived = true, status = MailStatus(21, 9, 4)))
        assertTrue(ui.archived)
        assertTrue(ui.counts.isEmpty())
        assertNull(ui.statusLine)
        assertEquals("No archived letters", ui.empty.headline)
        assertNull(ui.empty.go)
    }

    @Test fun `exact attached integers and server body survive the mapper`() {
        val ui = liveMailHubUi(CommunityState(detail = letter()), selectedBaseId = base)
        val open = requireNotNull(ui.open)
        assertEquals("The exact server body.", open.body)
        assertEquals("9,007,199,254,740,993", open.rewards.single().count)
        assertEquals(LetterState.CLAIMABLE, open.state)
        assertEquals(base, open.destination)
    }

    @Test fun `KEEP-only reward never invents a base destination`() {
        val message = letter(listOf(MailAttachment("KEEP", "0")))
        val ui = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(message), null), detail = message), selectedBaseId = base)
        assertEquals(Currency.KEEP, ui.letters.single().reward!!.currency)
        assertEquals("0", ui.open!!.rewards.single().count)
        assertFalse(ui.open!!.needsBase)
        assertNull(ui.open!!.destination)
        assertNull(ui.open!!.claimUnavailable)
    }

    @Test fun `missing deed visibly holds a base reward and supplies the kingdoms door`() {
        val open = liveMailHubUi(CommunityState(detail = letter())).open!!
        assertEquals("Select a Land Deed first.", open.claimUnavailable)
        assertEquals("profile.kingdoms", open.selectDeed!!.feature.value)
    }

    @Test fun `clock does not locally expire a server pending reward`() {
        val open = liveMailHubUi(CommunityState(detail = letter()), selectedBaseId = base,
            nowMillis = 1900000000000L).open!!
        assertEquals(LetterState.CLAIMABLE, open.state)
        assertNull(open.expiredLine)
        assertTrue(open.statusLine!!.startsWith("Expires "))
    }

    @Test fun `server claimed destination wins and historical letters do not auto-close`() {
        val message = letter().copy(rewardState = "claimed", claimBaseId = other, claimedAt = time)
        val open = liveMailHubUi(CommunityState(detail = message), selectedBaseId = base).open!!
        assertEquals(other, open.destination)
        assertEquals(LetterState.CLAIMED, open.state)
        assertFalse(open.closeAfterClaim)
        assertTrue(open.statusLine!!.contains(other))
    }

    @Test fun `only the newly acknowledged claim requests the close animation`() {
        val message = letter().copy(rewardState = "claimed", claimBaseId = base, claimedAt = time)
        assertTrue(liveMailHubUi(CommunityState(detail = message), claimedNowId = id).open!!.closeAfterClaim)
    }

    @Test fun `saved uncertainty keeps original destination and disables new claim and archive`() {
        val ui = liveMailHubUi(CommunityState(detail = letter(), pendingClaim = pending()), selectedBaseId = other)
        assertEquals(LetterState.CHECKING, ui.open!!.state)
        assertEquals(base, ui.open!!.destination)
        assertNotNull(ui.open!!.archiveUnavailable)
        assertNotNull(ui.recovery)
        assertFalse(ui.recovery!!.retryAllowed)
        assertTrue(ui.recovery!!.line.contains(base))
    }

    @Test fun `terminal proof offers only checking and unknown proof can explicitly retry same destination`() {
        val waiting = liveMailHubUi(CommunityState(pendingClaim = pending()), selectedBaseId = base).recovery!!
        assertTrue(waiting.retryAllowed)
        val accepted = liveMailHubUi(CommunityState(pendingClaim = pending(receipt = true)), selectedBaseId = base).recovery!!
        assertFalse(accepted.retryAllowed)
        assertTrue(accepted.line.contains("being updated"))
    }

    @Test fun `read hold and busy retain visible reasons while showing the last accepted letter`() {
        val state = CommunityState(detail = letter(), busy = true)
        val ui = liveMailHubUi(state, selectedBaseId = base, unavailable = "Mail is paused.")
        assertEquals("Mail is paused.", ui.open!!.claimUnavailable)
        assertEquals("Mail is paused.", ui.open!!.archiveUnavailable)
        assertTrue(ui.notice!!.contains("Mail is paused."))
    }

    private val news = MailMessage(other, "admin", "info", "Patch notes", "The exact news body.", emptyList(),
        null, null, time, null, null, null, null, null)

    // WHY: the Home mount restores exactly these filters; ARCHIVE is the fourth chip and selects the archived list.
    @Test fun `ARCHIVE is the fourth filter and the archived list selects it`() {
        assertEquals(setOf("ALL", "REWARDS", "NEWS", "ARCHIVE"), MAIL_HUB_FILTERS)
        val ui = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(news), null), archived = true))
        assertEquals("ARCHIVE", ui.filter)
        assertEquals(listOf("ARCHIVE"), ui.extraChips.map { it.id })
        assertNull(ui.batchUnavailable)
    }

    // WHY: switching to ARCHIVE must never show inbox letters as archived ones while the archive is read.
    @Test fun `an inbox page never stands in for the archive while it loads`() {
        val ui = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(letter()), null)), "ARCHIVE")
        assertTrue(ui.archived)
        assertTrue(ui.letters.isEmpty())
        assertEquals(LoadState.Loading, ui.load)
    }

    // WHY: REWARDS and NEWS filter the loaded letters by the server's kind, not by subject text.
    @Test fun `REWARDS and NEWS split loaded letters by server kind`() {
        val state = CommunityState(mailbox = MailPage(listOf(letter(), news), null))
        assertEquals(listOf(id), liveMailHubUi(state, "REWARDS").letters.map { it.id })
        assertEquals(listOf(other), liveMailHubUi(state, "NEWS").letters.map { it.id })
        assertEquals(2, liveMailHubUi(state, "UNKNOWN").letters.size)
    }

    // WHY: sender art comes only from the server sender; a subject never invents a league or clan crest.
    @Test fun `sender art follows the server sender only`() {
        val crestless = news.copy(subject = "League reward week 41")
        val rows = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(letter(), crestless), null))).letters
        assertEquals("ui_portrait_keep_t1", rows[0].senderIcon)
        assertEquals("shape:mail", rows[1].senderIcon)
        assertTrue(rows[1].senderLine.startsWith("Admin"))
        assertNull(rows[1].reward)
    }

    // WHY: only the server says a reward expired; the letter then offers no claim and no deed choice.
    @Test fun `a server expired reward shows its expiry and offers no claim`() {
        val expired = letter().copy(rewardState = "expired", expiredAt = time)
        val ui = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(expired), null), detail = expired))
        assertEquals(LetterState.EXPIRED, ui.open!!.state)
        assertTrue(ui.open!!.expiredLine!!.startsWith("This reward expired on"))
        assertNull(ui.open!!.selectDeed)
        assertNull(ui.open!!.claimUnavailable)
        assertNull(ui.letters.single().reward)
    }

    // WHY: an in-flight claim shows CLAIMING; only a refusal that left no saved claim shows FAILED with the server words.
    @Test fun `a claim in flight and a server refusal show their own letter states`() {
        val state = CommunityState(detail = letter())
        assertEquals(LetterState.CLAIMING, liveMailHubUi(state, selectedBaseId = base, claimingId = id).open!!.state)
        val refused = liveMailHubUi(state, selectedBaseId = base, failure = MailFailure(id, "Reward already claimed.")).open!!
        assertEquals(LetterState.FAILED, refused.state)
        assertEquals("Reward already claimed.", refused.failureLine)
        val saved = liveMailHubUi(state.copy(pendingClaim = pending()), selectedBaseId = base, failure = MailFailure(id, "Lost")).open!!
        assertEquals(LetterState.CHECKING, saved.state)
    }

    // WHY: item rewards keep the server quantity and use catalogue art; no amount is rounded or invented.
    @Test fun `item rewards keep their exact quantity and catalogue art`() {
        val item = letter(listOf(MailAttachment("ITEM", itemId = "crownsteel", qty = 2)))
        val ui = liveMailHubUi(CommunityState(mailbox = MailPage(listOf(item), null), detail = item), selectedBaseId = base)
        val tile = ui.open!!.rewards.single()
        assertEquals("x2", tile.count)
        assertEquals(craftItemIcon("crownsteel"), tile.icon)
        assertEquals(Currency.ITEM, ui.letters.single().reward!!.currency)
        assertTrue(ui.open!!.needsBase)
    }

    // WHY: the claim journal allows one saved mail claim; another letter's fresh claim is held with a visible reason.
    @Test fun `a saved claim for another letter holds a fresh claim visibly`() {
        val savedElsewhere = pending().copy(idempotencyKey = other)
        val open = liveMailHubUi(CommunityState(detail = letter(), pendingClaim = savedElsewhere), selectedBaseId = base).open!!
        assertEquals(LetterState.CLAIMABLE, open.state)
        assertEquals(MAIL_SAVED_CLAIM, open.claimUnavailable)
        assertNull(open.archiveUnavailable)
    }

    // WHY: an archived letter cannot be archived again, and says so.
    @Test fun `an archived letter explains why ARCHIVE is off`() {
        val archived = news.copy(archivedAt = time)
        assertEquals("This letter is already archived.", liveMailHubUi(CommunityState(detail = archived, archived = true)).open!!.archiveUnavailable)
    }
}
