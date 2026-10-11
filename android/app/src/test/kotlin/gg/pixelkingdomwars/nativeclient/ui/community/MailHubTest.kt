package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.data.CommunityRepository
import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.data.LiveCommunityRepository
import gg.pixelkingdomwars.nativeclient.data.MailBounds
import gg.pixelkingdomwars.nativeclient.ops.PendingIntentStore
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.model.MailAttachment
import gg.pixelkingdomwars.nativeclient.model.MailMessage
import gg.pixelkingdomwars.nativeclient.model.MailPage
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.*
import org.junit.Test

class MailHubTest {
    private val session = Any()
    private val owner = MailScope(session, "base", 4L)
    private val message = MailMessage("00000000-0000-0000-0000-000000000001", "system", "reward",
        "Reward", "Server body", listOf(MailAttachment("SHARDS", "7")), "pending", null,
        "2026-10-05T01:00:00Z", "2026-10-06T01:00:00Z", null, null, null, null)
    private val otherId = "00000000-0000-0000-0000-000000000002"
    private val saved = PendingIntent(IntentKind.MAIL_CLAIM, "wallet", "base", message.id, "/mail/${message.id}/claim",
        buildJsonObject {}, "Claim mail reward", attempted = true)

    @Test fun `same wallet text cannot replace exact session identity`() {
        assertTrue(mailScopeCurrent(owner, owner.copy()))
        assertFalse(mailScopeCurrent(owner, owner.copy(session = Any())))
        assertFalse(mailScopeCurrent(owner, null))
    }

    @Test fun `A to B to A cannot revive old letter consent`() {
        assertFalse(mailScopeCurrent(owner, owner.copy(generation = 6L)))
        assertFalse(mailScopeCurrent(owner, owner.copy(baseId = "other")))
    }

    @Test fun `exact opened letter and original selected destination admit review`() {
        assertNull(mailClaimUnavailable(owner, owner, message, message, false, false, null))
    }

    @Test fun `changed server reward cannot be claimed through a retained callback`() {
        val changed = message.copy(attachments = listOf(MailAttachment("SHARDS", "8")))
        assertNotNull(mailClaimUnavailable(owner, owner, message, changed, false, false, null))
        assertNotNull(mailClaimUnavailable(owner, owner, message, null, false, false, null))
    }

    @Test fun `busy read hold and existing saved intent all refuse a fresh claim visibly`() {
        assertNotNull(mailClaimUnavailable(owner, owner, message, message, true, false, null))
        assertNotNull(mailClaimUnavailable(owner, owner, message, message, false, true, null))
        assertEquals("Review in progress", mailClaimUnavailable(owner, owner, message, message, false, false, "Review in progress"))
    }

    @Test fun `missing destination holds shards but KEEP-only remains wallet scoped`() {
        val noBase = owner.copy(baseId = null)
        assertNotNull(mailClaimUnavailable(noBase, noBase, message, message, false, false, null))
        val keep = message.copy(attachments = listOf(MailAttachment("KEEP", "7")))
        assertNull(mailClaimUnavailable(noBase, noBase, keep, keep, false, false, null))
    }

    @Test fun `request-scoped read returns exactly its accepted observation`() = runBlocking {
        val observed = CommunityState(detail = message)
        val actual = readCurrentMail({}, { observed })
        assertSame(observed, actual)
    }

    @Test fun `owner or lease change during read never adopts a stale publication`() = runBlocking {
        var current = true
        try {
            readCurrentMail({ if (!current) throw CancellationException("Owner changed") }) {
                current = false
                CommunityState(detail = message)
            }
            fail("A response after owner change must not enter the new Mail card")
        } catch (_: CancellationException) { }
    }

    // WHY: consent names one destination. SHARDS and items carry the deed reviewed; a KEEP-only reward carries none,
    // even while a deed is selected, so a wallet claim can never be redirected into a base.
    @Test fun `review freezes the selected deed only for a reward that needs one`() {
        assertEquals("base", mailClaimReview(owner, message).baseId)
        assertNull(mailClaimReview(owner, message.copy(attachments = listOf(MailAttachment("KEEP", "7")))).baseId)
    }

    // WHY: the confirmation is the consent: it must name the frozen destination and the exact server amounts.
    @Test fun `claim confirmation names the frozen destination and exact amounts`() {
        val shards = mailClaimConfirmUi(mailClaimReview(owner, message), null)
        assertTrue(shards.line.contains("base base"))
        assertTrue(shards.subLine!!.contains("7 Shards"))
        val keep = mailClaimConfirmUi(mailClaimReview(owner, message.copy(attachments = listOf(MailAttachment("KEEP", "12")))), null)
        assertFalse(keep.line.contains("base"))
        assertTrue(keep.subLine!!.contains("12 KEEP"))
    }

    // WHY: the confirmed claim goes through the existing claim owner with exactly the reviewed letter and destination.
    @Test fun `confirmed claim sends the frozen base and a KEEP-only claim sends no base`() = runBlocking {
        val mail = ScriptedMail(detail = message)
        claimMailLetter(mail, mailClaimReview(owner, message), false, { null }) {}
        val keep = message.copy(attachments = listOf(MailAttachment("KEEP", "7")))
        claimMailLetter(mail, mailClaimReview(owner, keep), false, { null }) {}
        assertEquals(listOf("claim:${message.id}:base", "list:false", "claim:${message.id}:null", "list:false"), mail.calls)
    }

    // WHY: a retained confirm cannot send a claim for a letter whose live server copy changed after review.
    @Test fun `a claim refused by the live recheck sends nothing`() = runBlocking {
        val mail = ScriptedMail(detail = message.copy(body = "Changed by the server"))
        try {
            claimMailLetter(mail, mailClaimReview(owner, message), false,
                { live -> mailClaimUnavailable(owner, owner, message, live, false, false, null) }) {}
            fail("A changed letter must not be claimed")
        } catch (_: IllegalStateException) { }
        assertTrue(mail.calls.none { it.startsWith("claim") })
    }

    // WHY: the design marks a letter read when it is opened, but only after the GET of that exact letter, and once.
    @Test fun `opening reads the letter then marks that unread letter read once and relists`() = runBlocking {
        val mail = ScriptedMail(letters = listOf(message))
        assertNull(openMailLetter(mail, message.id, false) {})
        assertEquals(listOf("open:${message.id}", "read", "list:false"), mail.calls)
    }

    // WHY: a lost mark-read POST is never repeated on its own; the letter stays open and the player is told.
    @Test fun `a failed mark read is reported and never repeated`() = runBlocking {
        val mail = ScriptedMail(letters = listOf(message)).apply { failRead = true }
        assertNotNull(openMailLetter(mail, message.id, false) {})
        assertEquals(1, mail.calls.count { it == "read" })
        assertTrue(mail.calls.none { it.startsWith("list") })
        assertEquals(message.id, mail.state.value.detail?.id)
    }

    @Test fun `an already read letter opens with no POST`() = runBlocking {
        val mail = ScriptedMail(letters = listOf(message.copy(readAt = "2026-10-05T02:00:00Z")))
        assertNull(openMailLetter(mail, message.id, true) {})
        assertEquals(listOf("open:${message.id}"), mail.calls)
    }

    // WHY: another owner's letter in the shared detail must never receive this card's mark-read.
    @Test fun `a detail that is not the tapped letter is never marked read`() = runBlocking {
        val mail = ScriptedMail(letters = listOf(message)).apply { answer = { message.copy(id = otherId) } }
        try { openMailLetter(mail, message.id, false) {}; fail("A different letter must not be adopted") }
        catch (_: IllegalStateException) { }
        assertFalse("read" in mail.calls)
    }

    // WHY: ARCHIVE acts only on the letter this card opened, then reads the list again rather than leaving it blank.
    @Test fun `archive acts only on the open letter and relists`() = runBlocking {
        val mail = ScriptedMail(detail = message)
        assertNull(archiveMailLetter(mail, message.id, false) {})
        try { archiveMailLetter(mail, otherId, false) {}; fail("Another letter must not be archived") }
        catch (_: IllegalStateException) { }
        assertEquals(listOf("archive", "list:false"), mail.calls)
    }

    // WHY: the card checks the saved claim before its list (as the old screen did), and a failed check never hides the inbox.
    @Test fun `the card read checks the saved claim then reads the chosen list`() = runBlocking {
        val mail = ScriptedMail().apply { failCheck = true }
        assertNotNull(readMailList(mail, true) {})
        assertEquals(listOf("check", "list:true"), mail.calls)
    }

    // WHY: CHECK AGAIN only reads; the list is read again only when the check settled the claim and cleared it.
    @Test fun `CHECK AGAIN reads the list again only when the claim settled`() = runBlocking {
        val mail = ScriptedMail(); mail.state.value = CommunityState(mailbox = MailPage(emptyList(), null))
        assertNull(checkMailClaim(mail, false) {})
        mail.settleOnCheck = true
        assertNull(checkMailClaim(mail, false) {})
        assertEquals(listOf("check", "check", "list:false"), mail.calls)
    }

    // WHY: RETRY resends the saved claim only; a proven receipt, another letter or another selected deed never resend it.
    @Test fun `retry is held for a receipt or another deed and allowed for the saved one`() {
        assertNull(mailRetryUnavailable(message.id, saved, "base"))
        assertNotNull(mailRetryUnavailable(message.id, saved, "other"))
        assertNotNull(mailRetryUnavailable(message.id, saved.copy(receipt = buildJsonObject {}), "base"))
        assertNotNull(mailRetryUnavailable(otherId, saved, "base"))
        assertNotNull(mailRetryUnavailable(message.id, null, "base"))
        assertNull(mailRetryUnavailable(message.id, saved.copy(baseId = null), null))
    }

    @Test fun `a held retry sends nothing and an allowed one resends the saved claim`() = runBlocking {
        val mail = ScriptedMail(); mail.state.value = CommunityState(pendingClaim = saved)
        try { retryMailClaim(mail, message.id, "other", false) {}; fail("A different deed must hold the retry") }
        catch (_: IllegalStateException) { }
        retryMailClaim(mail, message.id, "base", false) {}
        assertEquals(listOf("retry", "list:false"), mail.calls)
    }

    // WHY: an old cursor must never be appended to a list another owner replaced while this request waited.
    @Test fun `more appends only to the page this card shows`() = runBlocking {
        val page = MailPage(listOf(message), message.id)
        val mail = ScriptedMail(); mail.state.value = CommunityState(mailbox = page)
        moreMailLetters(mail, page, false)
        mail.state.value = CommunityState(mailbox = page, archived = true)
        moreMailLetters(mail, page, false)
        moreMailLetters(mail, MailPage(listOf(message), null), false)
        assertEquals(listOf("more", "list:false"), mail.calls)
    }

    // WHY: a mark-read, archive or claim clears the shared page; a routine step must not blank the list already shown.
    @Test fun `a step that cleared the shared page keeps the shown list`() {
        val page = MailPage(listOf(message), null)
        val shown = CommunityState(mailbox = page, status = MailStatus(1, 1, 1))
        val after = mailAccept(shown, CommunityState(detail = message), null, false, message.id, MailOp.LETTER)
        assertEquals(page, after.mailbox)
        assertEquals(message, after.detail)
        assertEquals(MailStatus(1, 1, 1), after.status)
    }

    // WHY (owner's Seeker, 2026-10-06, Profile MAIL with ALL 1): Home's resume prefetch reads the inbox first; the card's
    // own LIST then gets the same letters back, the repository keeps the equal page object, and the card must show that
    // page rather than "Mail could not be read for this view". The rows are the server's exact claimed KEEP welcome letter.
    @Test fun `a re-read of an unchanged inbox is the list step's own read`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val store = PendingIntentStore(MemoryStore())
        val repository = LiveCommunityRepository(session, holder, api, store, ReceiptObserver(store), { BASE_ID }, { MailBounds(20, 50) })
        api.onGet("/mail") { json("""{"messages":[{"id":"6c1f0a8e-3b52-4d7e-9a41-0f2d5c7b8e93","sender":"system","kind":"reward",
            "subject":"⚔ PLAYTEST WELCOME REWARD","body":"Keeper — thank you for being here early.","attachments":[{"kind":"KEEP","amount":"5000"}],
            "rewardState":"claimed","claimBaseId":null,"createdAt":"2026-08-22T14:03:51.274Z","expiresAt":"2026-09-21T14:03:51.274Z",
            "readAt":"2026-08-22T14:05:02.009Z","archivedAt":null,"claimedAt":"2026-08-22T14:05:09.731Z","expiredAt":null}],"nextCursor":null}""") }
        api.onGet("/mail/status") { json("""{"total":1,"unread":0,"pendingRewards":0}""") }
        repository.refreshMail(false) // Home's resume prefetch
        val before = repository.state.value.mailbox
        readMailList(repository, false) {} // the card's LIST step
        val observed = repository.state.value
        assertSame("an equal state is not published again", before, observed.mailbox)
        assertEquals(before, mailReadPage(MailOp.LIST, before, observed, false))
        assertNull("opening a letter read no list", mailReadPage(MailOp.LETTER, before, observed, false))
        assertNull("the other list never enters", mailReadPage(MailOp.LIST, before, observed, true))
    }

    // WHY: only this card's own response enters it: a foreign letter or the other list never does.
    @Test fun `a foreign detail and the other list never enter the card`() {
        val inbox = CommunityState(mailbox = MailPage(listOf(message), null))
        val foreign = CommunityState(mailbox = MailPage(emptyList(), null), archived = true, detail = message.copy(id = otherId))
        val after = mailAccept(inbox, foreign, null, false, message.id, MailOp.LIST)
        assertEquals(inbox.mailbox, after.mailbox)
        assertNull(after.detail)
        assertFalse(after.archived)
    }

    // WHY: the saved claim is the repository's end-of-request truth, but a claim notice belongs only to a claim step.
    @Test fun `saved claim always follows the response and claim notices only follow claim steps`() {
        val observed = CommunityState(pendingClaim = saved, claimNotice = "Reward claimed into base base.")
        assertEquals(saved, mailAccept(null, observed, null, false, null, MailOp.LIST).pendingClaim)
        assertNull(mailAccept(null, observed, null, false, null, MailOp.LIST).claimNotice)
        assertEquals("Reward claimed into base base.", mailAccept(null, observed, null, false, null, MailOp.CLAIM).claimNotice)
        assertNull(mailAccept(CommunityState(pendingClaim = saved), CommunityState(), null, false, null, MailOp.CLAIM).pendingClaim)
    }

    // WHY: Mail opens only SEE QUESTS and the kingdoms choice; any other link is explained, never swallowed.
    @Test fun `Mail opens only the quests and kingdoms doors`() {
        assertEquals(FeatureId("hud.quests"), mailDoor(FeatureId("hud.quests")))
        assertEquals(FeatureId("profile.kingdoms"), mailDoor(FeatureId("profile.kingdoms")))
        assertNull(mailDoor(FeatureId("hud.attack")))
    }

    @Test fun `more refreshes when the shared page or list changed`() {
        val page = MailPage(listOf(message), message.id)
        assertFalse(mailMoreRefreshes(CommunityState(mailbox = page), page, false))
        assertTrue(mailMoreRefreshes(CommunityState(mailbox = page, archived = true), page, false))
        assertTrue(mailMoreRefreshes(CommunityState(mailbox = MailPage(emptyList(), null)), page, false))
    }

    /** The existing repository port, scripted: every call is recorded so a test can prove what was (not) sent. */
    private class ScriptedMail(letters: List<MailMessage> = emptyList(), detail: MailMessage? = null) : CommunityRepository {
        override val state = MutableStateFlow(CommunityState(detail = detail))
        val calls = mutableListOf<String>()
        var failRead = false
        var failCheck = false
        var settleOnCheck = false
        var answer: (String) -> MailMessage? = { id -> letters.firstOrNull { it.id == id } }
        override suspend fun refreshMail(archived: Boolean) {
            calls += "list:$archived"
            state.value = state.value.copy(mailbox = MailPage(emptyList(), null), archived = archived)
        }
        override suspend fun moreMail() { calls += "more" }
        override suspend fun openMail(id: String) { calls += "open:$id"; state.value = state.value.copy(detail = answer(id)) }
        override fun closeMail() { calls += "close"; state.value = state.value.copy(detail = null) }
        override suspend fun markRead() {
            calls += "read"
            if (failRead) error("Connection lost")
            state.value = state.value.copy(detail = state.value.detail?.copy(readAt = "2026-10-05T02:00:00Z"), mailbox = null)
        }
        override suspend fun archive() {
            calls += "archive"
            state.value = state.value.copy(detail = state.value.detail?.copy(archivedAt = "2026-10-05T02:00:00Z"), mailbox = null)
        }
        override suspend fun claim(mailId: String, baseId: String?) { calls += "claim:$mailId:$baseId" }
        override suspend fun checkClaim() {
            calls += "check"
            if (failCheck) error("Connection lost")
            if (settleOnCheck) state.value = state.value.copy(mailbox = null)
        }
        override suspend fun retryClaim() { calls += "retry" }
        override suspend fun refreshLeagues(): Unit = error("Mail never reads leagues")
    }
}
