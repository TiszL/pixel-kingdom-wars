package gg.pixelkingdomwars.nativeclient.wallet

/** Wallet metadata is a build-selected identity, never inferred from an incoming URL. */
object WalletIdentity {
    const val PRODUCTION = "https://play.pixelkingdomwars.com"
    const val CANDIDATE = "https://qa.pixelkingdomwars.com"
    fun origin(value: String): String {
        require(value == PRODUCTION || value == CANDIDATE) { "Unsupported wallet identity origin" }
        return value
    }
    fun name(value: String): String = if (origin(value) == CANDIDATE) "Pixel Kingdom Wars Test" else "Pixel Kingdom Wars"
}
