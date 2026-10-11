package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin

/**
 * The Seeker island auction for [session], or null (dark) unless this build carries auction pins ([seekerAuctionPins]: a
 * test-origin build's -Ppkw*, or the complete tracked release set), its cluster is devnet and it is not an offline preview. Reads and writes go through the S-A port
 * over GameApi's one authenticated session; the wallet step is the shared [WalletLogin.pay] rail ([AppGraph.walletPayer]),
 * relayed through the session's `/rpc/solana/<cluster>` proxy when the wallet only signs. No new signing or payment path.
 * A bound embedded wallet is not offered here (it would need the MFA prompt flow this surface does not draw).
 */
fun AppGraph.seekerAuctionClient(session: SessionGraph, mwa: WalletLogin?): SeekerAuctionRepository? {
    holder.requireCurrent(session.session)
    val pins = seekerAuctionPins() ?: return null
    if (cluster != SolanaCluster.DEVNET || mode.offline) return null
    val wallet = session.session.wallet
    val identity = StarterIdentity(origin.trimEnd('/'), cluster.id, wallet)
    val journal = SeekerAuctionJournal(EncryptedStore(application, storageNamespace(origin, "seeker-auction-${cluster.id}-$wallet")),
        wallet, origin, cluster.id)
    return SeekerAuctionRepository(session.session, holder, gameApi.seekerAuctionPort(identity, session.session.token), journal, pins, cluster,
        policy = { seekerAuctionProtocolPolicy(content.state.value.catalogue) },
        bounds = { LandCheckoutBounds.from(content.state.value.catalogue) },
        verifier = seekerAuctionPinnedVerifier(pins, wallet),
        payer = mwa?.let { walletPayer(session, it) },
        rpc = SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) },
        monotonicMs = android.os.SystemClock::elapsedRealtime,
        walletReady = {
            holder.requireCurrent(session.session)
            val embedded = socialBinding.isBoundForSecurity(wallet)
            holder.requireCurrent(session.session)
            !embedded
        },
        actionGuard = {
            check(content.state.value.allowsGameOrders(versionCode) && session.interlock.state.value.actionsAllowed)
            val battle = session.battle.state.value
            check(!battle.battleVisible && battle.replay == null && battle.spectator == null)
        })
}
