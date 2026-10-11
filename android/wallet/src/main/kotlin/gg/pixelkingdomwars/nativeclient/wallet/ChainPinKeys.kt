package gg.pixelkingdomwars.nativeclient.wallet

/** Test-build chain pins (app data/ChainPins.kt): a canonical, non-default 32-byte base58 address. */
fun isCanonicalChainAddress(value: String): Boolean = runCatching { realmSaleKey(value) }.isSuccess

/** The economy program's config account, PDA(["economy"], [programId]): the address packages/chain `miningConfigPda`
 *  derives and [MiningClaimTransaction] / [MiningTaxClaimsCrypto] require. Derived from the pinned program, never typed. */
suspend fun economyConfigAddress(programId: String): String = base58(realmSalePda(realmSaleKey(programId), "economy").bytes)
