package gg.pixelkingdomwars.nativeclient.seekerauction

/** A refusal classification is not proof that an earlier submitted signature did not land. */
enum class SeekerAuctionRefusalKind { REFRESH_REQUIRED, UNAVAILABLE, INVALID_TRANSACTION, INVALID_REQUEST, OTHER }
data class SeekerAuctionRefusal(val status: Int, val code: String?, val kind: SeekerAuctionRefusalKind) {
    companion object {
        fun from(status: Int, code: String?): SeekerAuctionRefusal = SeekerAuctionRefusal(status, code, when {
            status == 409 && code == "SEEKER_AUCTION_REFRESH_REQUIRED" -> SeekerAuctionRefusalKind.REFRESH_REQUIRED
            status == 503 && code == "SEEKER_AUCTION_UNAVAILABLE" -> SeekerAuctionRefusalKind.UNAVAILABLE
            status == 400 && code == "SEEKER_AUCTION_INVALID_TRANSACTION" -> SeekerAuctionRefusalKind.INVALID_TRANSACTION
            status == 400 && code == null -> SeekerAuctionRefusalKind.INVALID_REQUEST
            else -> SeekerAuctionRefusalKind.OTHER
        })
    }
}
