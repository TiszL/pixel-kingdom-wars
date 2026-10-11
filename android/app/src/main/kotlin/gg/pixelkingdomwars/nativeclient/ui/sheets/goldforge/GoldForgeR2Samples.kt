package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

/**
 * Preview data for the Gold Forge round-2 LEGACY tab (the mock values of legacy.png). Every number here is a
 * placeholder: in the app all values come from the server, already formatted; the update day is not set, so the
 * sample has none. Not used outside @Preview functions.
 */
internal object GoldForgeR2Samples {
    /** legacy.png: 1,820 KEEP saved; 2 withdrawals on the way (one being checked) and 1 arrived. */
    val legacy = LegacyV2Ui(
        saved = "1,820",
        cutoverAt = null,
        rate = "Each KEEP becomes a Gem",
        withdrawals = listOf(
            LegacyWithdrawalUi("w-1", "200", WithdrawalState.UNLOCKING, "In your wallet in 2d 4h", canReturn = true, proof = null),
            LegacyWithdrawalUi("w-2", "120", WithdrawalState.CHECKING, "Being checked · stays saved", canReturn = false, proof = null),
            LegacyWithdrawalUi("w-3", "80", WithdrawalState.SENT, "In your wallet since 12 Sep", canReturn = false, proof = "hist-77"),
        ),
        refreshedAgo = "2 min ago",
        live = true,
        nextIn = "2d 4h",
    )
}
