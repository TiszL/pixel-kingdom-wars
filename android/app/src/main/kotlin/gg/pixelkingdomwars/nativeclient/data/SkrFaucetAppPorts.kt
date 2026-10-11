package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.wallet.ChainProfile
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** [flow], [bounds], [pin] and [testSkr] exist only when [configured] (a pinned devnet test build). [testSkr] is the
 *  wallet's pinned test SKR in base units (null until read); [readTestSkr] re-reads it. */
data class SkrFaucetClient(val repository: SkrFaucetRepository, val journal: SkrFaucetJournal, val configured: Boolean,
    val flow: SkrFaucetFlow, val bounds: SkrFaucetBoundsSource, val pin: SkrIdentity?, val testSkr: StateFlow<String?>,
    val readTestSkr: suspend () -> Unit)

/** The SKR identity this build may claim against: the profile's, only when it is this devnet build's own and online.
 *  Callers pass `ChainPins.current?.chainProfile` ([AppGraph.chainPins]), which exists only when the build's own faucet
 *  switch (pkwSkrFaucet=on) is set beside the SKR pins: the auction's SKR mint alone never lights the faucet (owner
 *  2026-10-10), so a production build pinned for auctions keeps every faucet surface dark. No identity fallback. */
fun skrFaucetPin(profile: ChainProfile?, cluster: SolanaCluster, offline: Boolean): SkrIdentity? =
    profile?.takeIf { it.cluster == cluster.id && cluster == SolanaCluster.DEVNET && !offline }?.skr

/** The faucet's sign-only wallet step: the player approves the claim transaction in the wallet app on the phone
 *  ([WalletLogin.signTransactionOnlyWithEvidence]); the app holds no key and never sends it (the faucet authority
 *  co-signs and sends it server-side). Null without a wallet app connection. */
fun AppGraph.skrFaucetSigner(session: SessionGraph, mwa: WalletLogin?): SkrFaucetSigner? {
    val login = mwa ?: return null
    return { prepared, guard, retain ->
        login.signTransactionOnlyWithEvidence(prepared, cluster, session.session.token, retain) {
            holder.requireCurrent(session.session); guard()
        }
        Unit
    }
}

/** Shared AppGraph/WalletLogin mount hunks supply the reviewed profile and MWA sign-only adapter.
 * This file can compile before those hunks land, and has no production identity fallback. */
fun AppGraph.skrFaucetClient(session: SessionGraph, profile: ChainProfile?, external: SkrFaucetSigner?,
    requireView: () -> Unit, visitEpoch: () -> Long): SkrFaucetClient {
    holder.requireCurrent(session.session)
    val pin = skrFaucetPin(profile, cluster, mode.offline)
    val journal = SkrFaucetJournal(EncryptedStore(application, storageNamespace(origin, "skr-faucet-${cluster.id}-${session.session.wallet}")),
        session.session.wallet, origin, cluster.id)
    suspend fun walletAvailable() {
        holder.requireCurrent(session.session)
        check(!socialBinding.isBoundForSecurity(session.session.wallet)) { "This wallet cannot claim test SKR yet." }
        holder.requireCurrent(session.session)
        requireNotNull(external) { "A wallet with sign-only approval is required." }
    }
    val rpc = SolanaRpc { request -> session.api.post("/rpc/solana/${cluster.id}", request) }
    val testSkr = MutableStateFlow<String?>(null)
    suspend fun readTestSkr() {
        holder.requireCurrent(session.session)
        val raw = skrTestBalanceRaw(rpc, session.session.wallet, requireNotNull(pin) { "No pinned test SKR." })
        holder.requireCurrent(session.session)
        testSkr.value = raw
    }
    val bounds = SkrFaucetBoundsSource({ SkrFaucetBounds.from(content.state.value.catalogue) }, pin) {
        session.api.get("/devnet-skr-faucet/status", emptyMap())
    }
    val repo = SkrFaucetRepository(session.session, holder, session.api, journal, { pin },
        bounds::current, { account.state.value.selectedBaseId },
        signer = { prepared, guard, retain ->
            walletAvailable(); guard(); requireNotNull(external)(prepared, guard, retain)
        }, refreshWallet = {
            // The arrival waits for the balance the sheet shows: the pinned test SKR (the wallet hub's SKR is mainnet).
            readTestSkr()
        }, actionGuard = {
            holder.requireCurrent(session.session); requireView()
            check(pin != null && content.state.value.allowsGameOrders(versionCode) && session.interlock.state.value.actionsAllowed)
            val battle = session.battle.state.value
            check(!battle.battleVisible && battle.replay == null && battle.spectator == null)
        }, walletAvailable = ::walletAvailable, actionEpoch = {
            listOf(account.state.value.baseSelectionGeneration, content.state.value.manifest?.contentVersion, visitEpoch())
        })
    return SkrFaucetClient(repo, journal, pin != null, SkrFaucetFlow(repo, bounds::current), bounds, pin, testSkr.asStateFlow(), ::readTestSkr)
}
