package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.wallet.ChainProfile
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.MiningTaxClaimsSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleFailureTrust
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.economyConfigAddress
import gg.pixelkingdomwars.nativeclient.wallet.isCanonicalChainAddress
import kotlinx.coroutines.runBlocking

/** The Seeker island auction's public identity. The auction client refuses any prepared message whose program or mint
 *  differs from these, so a server can never point a bid at another program or token. */
data class SeekerAuctionPins(val programId: String, val mint: String, val decimals: Int)

/** The auction pins of this build's devnet deployment, read from [ChainPins.current]: a test-origin debug build's -Ppkw*
 *  values (night 2026-10-06), or the tracked app/chain-pins.release.properties in every other build (owner 2026-10-10).
 *  Null while that file is blank or incomplete. */
internal fun seekerAuctionPins(): SeekerAuctionPins? = ChainPins.current?.seekerAuction

/** One raw BuildConfig string per Gradle property (app/build.gradle.kts `chainPins`); "" means not set. */
internal data class ChainPinValues(val cluster: String = "", val economyProgramId: String = "", val craftProgramId: String = "",
    val leagueProgramId: String = "", val skrMint: String = "", val skrDecimals: String = "", val keepMint: String = "",
    val keepReserveOwner: String = "", val economyDeploymentSlot: String = "", val economyProgramDataSha256: String = "",
    val economyUpgradeAuthority: String = "", val realmSaleDeveloper: String = "", val realmSalePolicyRevision: String = "",
    /** The SKR faucet's own switch ("on" lights it), never derived from [skrMint]: the auction's real SKR mint must not
     *  open a "test SKR" faucet (owner 2026-10-10). */
    val skrFaucet: String = "")

/** In a test-origin build every family is independent: it is null unless every field it needs is set and well formed, so a
 *  test build lights only what its server lane serves. A tracked (production-origin) set is all or nothing over its
 *  REQUIRED pins ([ChainPins.parse] `wholeSet`); the KEEP reserve owner is optional there and, blank, darkens only
 *  [miningClaim] and [miningTax]. [chainProfile] is the SKR faucet, lit only by its own switch. [craftProgramId] and
 *  [leagueProgramId] have no client consumer yet. */
internal data class ChainPinSet(val seekerAuction: SeekerAuctionPins?, val chainProfile: ChainProfile?,
    val realmSale: RealmSaleSigningTrust?, val realmSaleFailure: RealmSaleFailureTrust?,
    val miningClaim: MiningClaimSigningTrust?, val miningTax: MiningTaxClaimsSigningTrust?,
    val craftProgramId: String?, val leagueProgramId: String?) {
    /** One logcat line, so the operator sees which family a test build lit before the demo. */
    fun summary(): String = listOf("auction" to seekerAuction, "faucet" to chainProfile, "realmSale" to realmSale,
        "realmSaleFailure" to realmSaleFailure, "miningClaim" to miningClaim, "miningTax" to miningTax,
        "craft" to craftProgramId, "league" to leagueProgramId).joinToString(" ") { (name, pin) -> "$name=${if (pin == null) "off" else "on"}" }
}

/** Shape rules of the auction family on their own (kept for SeekerAuctionRepositoryTest): all three or nothing, debug build
 *  type only, canonical base58 shapes, program != mint, decimals 0..19 (every u64 raw amount stays exact). The build's real
 *  pins come from [ChainPins.current]; this helper never reads BuildConfig. */
internal fun seekerAuctionPinsFrom(buildType: String, programId: String, mint: String, decimals: String): SeekerAuctionPins? {
    val address = Regex("[1-9A-HJ-NP-Za-km-z]{32,44}")
    if (buildType != "debug" || programId.isEmpty() || mint.isEmpty() || decimals.isEmpty()) return null
    if (!programId.matches(address) || !mint.matches(address) || programId == mint) return null
    val places = decimals.takeIf { it.matches(Regex("0|[1-9][0-9]?")) }?.toInt()?.takeIf { it in 0..19 } ?: return null
    return SeekerAuctionPins(programId, mint, places)
}

internal object ChainPins {
    // Shapes of the server's own config (apps/api/src/config.ts SEEKER_REALM_SALE_*), not game numbers.
    private val DECIMALS = Regex("0|[1-9][0-9]{0,2}")
    private val SLOT = Regex("0|[1-9][0-9]{0,15}")
    private val SHA256 = Regex("[0-9a-f]{64}")
    private val REVISION = Regex("[A-Za-z0-9_.:-]{1,128}")
    private const val MAX_SAFE_SLOT = 9_007_199_254_740_991L

    fun buildValues() = ChainPinValues(BuildConfig.PKW_CHAIN_CLUSTER, BuildConfig.PKW_ECONOMY_PROGRAM_ID,
        BuildConfig.PKW_CRAFT_PROGRAM_ID, BuildConfig.PKW_LEAGUE_PROGRAM_ID, BuildConfig.PKW_SKR_MINT,
        BuildConfig.PKW_SKR_DECIMALS, BuildConfig.PKW_KEEP_MINT, BuildConfig.PKW_KEEP_RESERVE_OWNER,
        BuildConfig.PKW_ECONOMY_DEPLOYMENT_SLOT, BuildConfig.PKW_ECONOMY_PROGRAM_DATA_SHA256,
        BuildConfig.PKW_ECONOMY_UPGRADE_AUTHORITY, BuildConfig.PKW_REALM_SALE_DEVELOPER, BuildConfig.PKW_REALM_SALE_POLICY_REVISION,
        BuildConfig.PKW_SKR_FAUCET)

    /** The production origin: a build talking to it carries the tracked pin file (app/build.gradle.kts), never -Ppkw*. */
    const val PRODUCTION_ORIGIN = "https://play.pixelkingdomwars.com"

    /** True when [apiOrigin]'s pins come from the tracked release file, which must be complete or is ignored whole. */
    fun trackedOrigin(apiOrigin: String): Boolean = apiOrigin == PRODUCTION_ORIGIN

    /** This build's pins, parsed once; null without a valid devnet cluster and economy id, and on the production origin
     *  unless the tracked set is complete. */
    val current: ChainPinSet? by lazy {
        val values = buildValues()
        val tracked = trackedOrigin(BuildConfig.API_ORIGIN)
        parse(values, BuildConfig.SOLANA_CLUSTER, wholeSet = tracked).also { pins ->
            // Debug build types only (candidate and production-origin test APKs): the release prints nothing.
            if (values != ChainPinValues() && BuildConfig.BUILD_TYPE == "debug") runCatching {
                // DeviceLog: a direct Log call is stripped by R8 in the optimized debug builds that carry pins.
                gg.pixelkingdomwars.nativeclient.diagnostics.DeviceLog.info("PKWChainPins", pins?.summary()
                    ?: if (tracked) "refused: the tracked pin set is missing a required pin, every chain family stays dark"
                    else "refused: pkwChainCluster must be devnet with a valid pkwEconomyProgramId")
            }
        }
    }

    /** CPU-only PDA derivation (no I/O), run once when a mining family is complete. */
    fun economyConfig(programId: String): String = runBlocking { economyConfigAddress(programId) }

    /** [wholeSet] (a tracked production-origin set): every REQUIRED family complete or none at all, so a half-filled file
     *  can never light one money path while another stays dark; the faucet switch is optional.
     *  2026-10-11 (D26 withdrawn, reviewer 07:20Z): the KEEP reserve owner is optional too. Production must not set
     *  GEMS_RESERVE_OWNER (the api and worker would refuse to boot on the missing reserve ATA, or bind that pair write-once
     *  in economy_chain_identity), so the release cannot carry a made-up value. Blank, it darkens ONLY the two families that
     *  sign against it ([ChainPinSet.miningClaim], [ChainPinSet.miningTax]; the server serves neither without a reserve)
     *  while the auction, realm sale, craft and league stay lit. Set, it is required like every other pin (today's rule),
     *  so a malformed reserve still darkens the whole set. */
    fun parse(v: ChainPinValues, buildCluster: String, wholeSet: Boolean = false,
        deriveConfig: (String) -> String = { economyConfig(it) }): ChainPinSet? {
        val devnet = SolanaCluster.DEVNET
        if (v.cluster != devnet.id || buildCluster != devnet.id) return null
        fun address(raw: String) = raw.takeIf(::isCanonicalChainAddress)
        val economy = address(v.economyProgramId) ?: return null
        val skr = SkrIdentity.fromProfile(devnet.id, address(v.skrMint), v.skrDecimals.takeIf { it.matches(DECIMALS) }?.toInt())
        val slot = v.economyDeploymentSlot.takeIf { it.matches(SLOT) }?.toLong()?.takeIf { it <= MAX_SAFE_SLOT }
        val sha = v.economyProgramDataSha256.takeIf { it.matches(SHA256) }
        val keep = address(v.keepMint); val reserve = address(v.keepReserveOwner)
        val config = if (keep == null || reserve == null) null else runCatching { deriveConfig(economy) }.getOrNull()
        val mining = if (keep == null || reserve == null || config == null) null
            else MiningClaimSigningTrust(devnet.genesisHash, economy, config, keep, reserve)
        val tax = if (mining == null || slot == null || sha == null) null
            else MiningTaxClaimsSigningTrust(devnet.genesisHash, economy, mining.configAddress, mining.keepMint, mining.reserveOwner, slot, sha)
        val developer = address(v.realmSaleDeveloper); val revision = v.realmSalePolicyRevision.takeIf { it.matches(REVISION) }
        val realmSale = if (developer == null || slot == null || sha == null || revision == null) null
            else RealmSaleSigningTrust(devnet.genesisHash, economy, developer, sha, slot, revision)
        val failure = when {
            realmSale == null -> null
            v.economyUpgradeAuthority == "none" -> RealmSaleFailureTrust(realmSale, null)
            else -> address(v.economyUpgradeAuthority)?.let { RealmSaleFailureTrust(realmSale, it) }
        }
        val faucet = if (v.skrFaucet == "on") skr?.let { ChainProfile(devnet.id, it) } else null
        val pins = ChainPinSet(skr?.let { SeekerAuctionPins(economy, it.mint, it.decimals) }, faucet,
            realmSale, failure, mining, tax, address(v.craftProgramId), address(v.leagueProgramId))
        val reserveOptionalBlank = v.keepReserveOwner.isEmpty()
        val required = listOf(pins.seekerAuction, pins.realmSale, pins.realmSaleFailure, pins.craftProgramId, pins.leagueProgramId, keep) +
            if (reserveOptionalBlank) emptyList() else listOf(pins.miningClaim, pins.miningTax)
        return if (wholeSet && required.any { it == null }) null else pins
    }
}
