package gg.pixelkingdomwars.nativeclient.wallet

/** Public payment addresses of the shardkeep-core deployment on one cluster. Devnet mirrors the
 * checked-in registry `infra/devnet.addresses.json` (source `updatedAt` 2026-08-18) that the web
 * bundles at build time; a mainnet build must receive every address from the reviewed release
 * configuration, exactly like the web's `resolveWebSolanaConfig` (never hardcoded here). */
data class ChainAddresses(
    val coreProgram: String,
    val config: String,
    val treasuryLiquidity: String,
    val treasuryDev: String,
    val treasuryOps: String,
    val keepMint: String,
) {
    init { listOf(coreProgram, config, treasuryLiquidity, treasuryDev, treasuryOps, keepMint).forEach { require(base58Decode(it).size == 32) { "Invalid chain address" } } }

    companion object {
        val DEVNET = ChainAddresses(
            coreProgram = "mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b",
            config = "AEtsnqdSXDwGDBeovnD9XoutQmNptcPWC8ygieZSkKHH",
            treasuryLiquidity = "A1ja8GwrTM2KvS4tKJJaVaLk57xJeehuk2F9Exbz82QA",
            treasuryDev = "5sYVCRd1onSre8EKujE5vDKa9KeF2KuJvPA3rpRonfif",
            treasuryOps = "fCTc8TgJCvHUkn1aaME2gDcs69LpgtVXq1rmBSvS3Bx",
            keepMint = "5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC",
        )
        /** Fails closed for mainnet until the release configuration supplies addresses. */
        fun forCluster(cluster: SolanaCluster, mainnet: ChainAddresses? = null): ChainAddresses = when (cluster) {
            SolanaCluster.DEVNET -> DEVNET
            SolanaCluster.MAINNET -> mainnet ?: throw IllegalStateException("Mainnet payment addresses must be supplied by the reviewed release configuration")
        }
    }
}
