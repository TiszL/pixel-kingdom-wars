package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The exact `GET /mail` body the server sends for a claimed KEEP-only welcome letter (owner's Seeker, 2026-10-06:
 * Profile MAIL showed "Mail could not be read for this view" with ALL 1). Built field by field from the server's
 * `messageDto`/`attachmentDto` (apps/api/src/mail/service.ts): Drizzle `timestamp` columns are `Date`s, so Fastify
 * writes them as `toISOString()` with milliseconds; nullable columns are written as JSON `null`, never omitted; a
 * KEEP attachment carries `retired: true` only when its KEEP was retired. If this decode ever fails, the Mail card
 * can never list a claimed welcome letter, so the wire shape is pinned here rather than in a hand-written fixture.
 */
class MailWireShapeTest {
    private val id = "6c1f0a8e-3b52-4d7e-9a41-0f2d5c7b8e93"
    private fun page(attachment: String, nextCursor: String = "null") = Json.parseToJsonElement("""{
        "messages":[{"id":"$id","sender":"system","kind":"reward","subject":"⚔ PLAYTEST WELCOME REWARD",
        "body":"Keeper — thank you for being here early.\n\nBuild, raid, and hold the line.",
        "attachments":[$attachment],"rewardState":"claimed","claimBaseId":null,
        "createdAt":"2026-08-22T14:03:51.274Z","expiresAt":"2026-09-21T14:03:51.274Z","readAt":"2026-08-22T14:05:02.009Z",
        "archivedAt":null,"claimedAt":"2026-08-22T14:05:09.731Z","expiredAt":null}],
        "nextCursor":$nextCursor}""").jsonObject

    @Test fun `the server's claimed KEEP-only welcome letter decodes as one claimed wallet reward`() {
        val page = MailPage.from(page("""{"kind":"KEEP","amount":"5000"}"""))
        val letter = page.messages.single()
        assertEquals(id, letter.id); assertNull(page.nextCursor)
        assertEquals(listOf(MailAttachment("KEEP", "5000")), letter.attachments)
        assertEquals("claimed", letter.rewardState); assertNull(letter.claimBaseId)
        // KEEP goes to the wallet, so a claimed KEEP-only reward names no base: that is the server's rule, not a gap.
        assertFalse(letter.needsBase)
        assertEquals("2026-08-22T14:05:09.731Z", letter.claimedAt)
    }

    @Test fun `a retired KEEP attachment still decodes, the extra flag is ignored and the amount kept exact`() {
        val page = MailPage.from(page("""{"kind":"KEEP","amount":"5000","retired":true}"""))
        assertEquals(listOf(MailAttachment("KEEP", "5000")), page.messages.single().attachments)
    }

    @Test fun `a full page names its last letter as the cursor, exactly as listMail does`() {
        assertEquals(id, MailPage.from(page("""{"kind":"KEEP","amount":"5000"}""", "\"$id\"")).nextCursor)
    }
}
