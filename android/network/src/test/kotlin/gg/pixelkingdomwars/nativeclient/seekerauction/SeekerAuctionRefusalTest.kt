package gg.pixelkingdomwars.nativeclient.seekerauction

import org.junit.Assert.*
import org.junit.Test

class SeekerAuctionRefusalTest {
    @Test fun `409 refresh invalidates current intent only`() {
        assertEquals(SeekerAuctionRefusalKind.REFRESH_REQUIRED, SeekerAuctionRefusal.from(409, "SEEKER_AUCTION_REFRESH_REQUIRED").kind)
    }
    @Test fun `503 unavailable is an error never an empty success`() {
        assertEquals(SeekerAuctionRefusalKind.UNAVAILABLE, SeekerAuctionRefusal.from(503, "SEEKER_AUCTION_UNAVAILABLE").kind)
    }
    @Test fun `invalid transaction maps only at the emitted status`() {
        assertEquals(SeekerAuctionRefusalKind.INVALID_TRANSACTION, SeekerAuctionRefusal.from(400, "SEEKER_AUCTION_INVALID_TRANSACTION").kind)
        assertEquals(SeekerAuctionRefusalKind.OTHER, SeekerAuctionRefusal.from(503, "SEEKER_AUCTION_INVALID_TRANSACTION").kind)
    }
    @Test fun `plain400 has no invented machine code`() {
        val refusal = SeekerAuctionRefusal.from(400, null)
        assertEquals(SeekerAuctionRefusalKind.INVALID_REQUEST, refusal.kind); assertNull(refusal.code)
    }
    @Test fun `auth rate limit and unknown codes stay with shared transport`() {
        for (status in listOf(401, 403, 429, 500)) assertEquals(SeekerAuctionRefusalKind.OTHER, SeekerAuctionRefusal.from(status, null).kind)
        assertEquals(SeekerAuctionRefusalKind.OTHER, SeekerAuctionRefusal.from(400, "UNRECOGNIZED").kind)
    }
}
