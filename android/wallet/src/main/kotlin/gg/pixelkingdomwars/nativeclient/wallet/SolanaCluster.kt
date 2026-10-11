package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.Blockchain
import com.solana.mobilewalletadapter.clientlib.Solana

/** The only economy clusters the game understands (web `lib/cluster.ts`). Anything else is a
 * configuration error, never permission to let a wallet library guess. */
enum class SolanaCluster(val id: String, val label: String, internal val blockchain: Blockchain) {
    DEVNET("devnet", "DEVNET", Solana.Devnet),
    MAINNET("mainnet-beta", "MAINNET", Solana.Mainnet);

    /** `solana:<cluster>` as wallet-standard chains name it. */
    val chain: String get() = if (this == DEVNET) "solana:devnet" else "solana:mainnet"
    /** Public protocol identity; mirrors canonical packages/chain/src/cluster.ts (K159). */
    val genesisHash: String get() = when (this) {
        DEVNET -> "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
        MAINNET -> "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
    }

    companion object {
        fun parse(id: String): SolanaCluster = entries.firstOrNull { it.id == id } ?: throw IllegalArgumentException("Unsupported Solana cluster $id")
    }
}
