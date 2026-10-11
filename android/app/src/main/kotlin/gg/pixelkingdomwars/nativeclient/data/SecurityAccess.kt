package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.network.SessionToken

/** Recovery can have a pending-login cookie without an AccountSession. Both entry modes still bind
 * the same wallet, phase, original session reference and exact cookie generation for every callback. */
class SecurityAccess(
    initial: AccountState, val token: SessionToken,
    private val current: () -> AccountState, private val requireToken: (SessionToken) -> Unit,
) {
    val loginRecovery = initial.phase == AccountPhase.TOTP
    val wallet = requireNotNull(if (loginRecovery) initial.pendingWallet else initial.wallet)
    private val session = initial.session
    init {
        require(initial.phase == AccountPhase.TOTP || (initial.phase == AccountPhase.SIGNED_IN && session != null))
        if (!loginRecovery && session?.token !== token) throw SessionSupersededException()
    }
    fun requireCurrent() {
        requireToken(token)
        val now = current()
        val same = if (loginRecovery) now.phase == AccountPhase.TOTP && now.pendingWallet == wallet && now.session == null
            else now.phase == AccountPhase.SIGNED_IN && now.session === session && now.wallet == wallet
        if (!same) throw SessionSupersededException()
    }
}
