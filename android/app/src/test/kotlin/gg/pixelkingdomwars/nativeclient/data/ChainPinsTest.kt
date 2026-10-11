package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.wallet.ChainProfile
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.MiningTaxClaimsSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleFailureTrust
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** WHY: the money owners (auction verifier, realm sale, mining claim and tax signers, SKR faucet) refuse every prepared
 *  message that differs from these pins. A test build must therefore carry exactly the deployment it was built for, and a
 *  half-configured family must stay dark instead of trusting a guess.
 *  Rewritten 2026-10-10 (owner: Phase E to production): production builds were dark by design (every pin blank). They now
 *  carry the tracked app/chain-pins.release.properties, all or nothing, so a signed release can light the accepted
 *  deployment, a half-filled file lights no money path at all, and a test id can never ship. The SKR faucet has its own
 *  switch, so pinning the real auction SKR mint on production does not open a "test SKR" faucet.
 *  Rewritten 2026-10-11 (D26 withdrawn after the runbook reviewer's 07:20Z devnet finding): the KEEP reserve owner is
 *  OPTIONAL in a tracked set. Production must not set GEMS_RESERVE_OWNER (api and worker boot would refuse on the missing
 *  reserve ATA, or bind the pair write-once), so a release cannot carry a reserve the server does not serve. Blank, it
 *  darkens only the two mining families that sign against it; every other family stays lit, and a blank REQUIRED pin
 *  still darkens the whole set. */
class ChainPinsTest {
    // A server-generated mining identity: the API derived this configAddress from this programId (miningConfigPda).
    private val pair = Json.parseToJsonElement(String(requireNotNull(javaClass.getResourceAsStream("/mining-ordered-http-pair.json")).readBytes()))
        .jsonObject.getValue("trust").jsonObject
    private fun fixture(key: String) = pair.getValue(key).jsonPrimitive.content
    private val economy = fixture("programId")
    // Public ids of the devnet TEST deployment.
    private val craft = "17sCdP3nT1p1AYSA29oczoVMMfzYThJAV7o6FVokvR3"
    private val league = "2VjgKKMbjJWaB4wKo4e2qtVrGrQ7RF1hfmgZ3NaxCFW1"
    private val skr = "A68QYUbmEqNQjmumg7ta1m3KezFSVYCsfZLpSNyyUNQ2"
    private val treasury = "EY9tW9FamdSMEUADaNANfHzzyFoEZDXXVgyKug8sBNTk"
    private val upgradeAuthority = "HjR878onP7hytXFrRS5xvudV3dipEGyhtnwznBb3LRno"
    private val sha = "563a079e91a560c4d3d90609ecd276da0bb8da9eda236d92cbf9799725f57bf4"
    private val revision = "night-devnet-test-2026-10-06"
    private val full = ChainPinValues("devnet", economy, craft, league, skr, "6", fixture("keepMint"), fixture("reserveOwner"),
        "89", sha, upgradeAuthority, treasury, revision, skrFaucet = "on")
    private val genesis = SolanaCluster.DEVNET.genesisHash
    private fun parsed(values: ChainPinValues) = requireNotNull(ChainPins.parse(values, "devnet"))

    @Test fun `every family of a complete devnet test deployment is pinned to that deployment`() {
        val pins = parsed(full)
        assertEquals(SeekerAuctionPins(economy, skr, 6), pins.seekerAuction)
        assertEquals(ChainProfile("devnet", SkrIdentity(skr, 6)), pins.chainProfile)
        val config = fixture("configAddress")
        assertEquals(MiningClaimSigningTrust(genesis, economy, config, fixture("keepMint"), fixture("reserveOwner")), pins.miningClaim)
        assertEquals(MiningTaxClaimsSigningTrust(genesis, economy, config, fixture("keepMint"), fixture("reserveOwner"), 89L, sha), pins.miningTax)
        val sale = RealmSaleSigningTrust(genesis, economy, treasury, sha, 89L, revision)
        assertEquals(sale, pins.realmSale)
        assertEquals(RealmSaleFailureTrust(sale, upgradeAuthority), pins.realmSaleFailure)
        assertEquals(craft, pins.craftProgramId); assertEquals(league, pins.leagueProgramId)
        assertEquals("auction=on faucet=on realmSale=on realmSaleFailure=on miningClaim=on miningTax=on craft=on league=on", pins.summary())
    }

    @Test fun `the mining config account is the economy PDA the server derives and is never typed`() {
        assertEquals(fixture("configAddress"), ChainPins.economyConfig(economy))
        assertNotEquals(fixture("configAddress"), ChainPins.economyConfig(craft))
    }

    @Test fun `a missing field darkens only the families that need it`() {
        val noSkr = parsed(full.copy(skrMint = ""))
        // The faucet switch without an SKR identity lights nothing: the faucet claims the pinned SKR only.
        assertNull(noSkr.seekerAuction); assertNull(noSkr.chainProfile); assertNotNull(noSkr.miningClaim); assertNotNull(noSkr.realmSale)
        assertTrue(noSkr.summary(), noSkr.summary().startsWith("auction=off faucet=off realmSale=on"))
        val noReview = parsed(full.copy(economyProgramDataSha256 = ""))
        assertNull(noReview.realmSale); assertNull(noReview.realmSaleFailure); assertNull(noReview.miningTax)
        assertNotNull(noReview.miningClaim); assertNotNull(noReview.seekerAuction)
        val noDeveloper = parsed(full.copy(realmSaleDeveloper = ""))
        assertNull(noDeveloper.realmSale); assertNull(noDeveloper.realmSaleFailure); assertNotNull(noDeveloper.miningTax)
        val noReserve = parsed(full.copy(keepReserveOwner = ""))
        assertNull(noReserve.miningClaim); assertNull(noReserve.miningTax); assertNotNull(noReserve.realmSale)
        // The demo's auction-only build (with the faucet switch) lights the auction and the faucet profile and nothing else,
        // and derives nothing.
        var derived = 0
        val auctionOnly = requireNotNull(ChainPins.parse(ChainPinValues(cluster = "devnet", economyProgramId = economy, skrMint = skr,
            skrDecimals = "6", skrFaucet = "on"), "devnet") { derived++; it })
        assertEquals(SeekerAuctionPins(economy, skr, 6), auctionOnly.seekerAuction); assertNotNull(auctionOnly.chainProfile)
        assertEquals(listOf(null, null, null, null), listOf(auctionOnly.realmSale, auctionOnly.realmSaleFailure, auctionOnly.miningClaim, auctionOnly.miningTax))
        assertEquals(0, derived)
    }

    @Test fun `no devnet cluster or no economy program means no pins at all`() {
        assertNull(ChainPins.parse(ChainPinValues(), "devnet"))
        assertNull(ChainPins.parse(full.copy(cluster = ""), "devnet"))
        assertNull(ChainPins.parse(full.copy(cluster = "mainnet-beta"), "devnet"))
        assertNull(ChainPins.parse(full, "mainnet-beta"))
        assertNull(ChainPins.parse(full.copy(economyProgramId = ""), "devnet"))
    }

    @Test fun `a malformed pin is refused rather than trusted`() {
        assertNull(ChainPins.parse(full.copy(economyProgramId = economy.dropLast(1) + "0"), "devnet"))
        assertNull(parsed(full.copy(skrDecimals = "256")).seekerAuction)
        assertNull(parsed(full.copy(skrDecimals = "06")).seekerAuction)
        assertNull(parsed(full.copy(skrMint = "1".repeat(32))).seekerAuction)
        assertNull(parsed(full.copy(economyProgramDataSha256 = sha.uppercase())).realmSale)
        assertNull(parsed(full.copy(economyDeploymentSlot = "-1")).miningTax)
        assertNull(parsed(full.copy(realmSalePolicyRevision = "night test")).realmSale)
        assertNull(parsed(full.copy(economyUpgradeAuthority = "nobody")).realmSaleFailure)
        assertNull(parsed(full.copy(keepMint = "not-a-key")).miningClaim)
    }

    @Test fun `an immutable economy program pins its failure trust with no upgrade authority`() {
        val pins = parsed(full.copy(economyUpgradeAuthority = "none"))
        assertEquals(RealmSaleFailureTrust(requireNotNull(pins.realmSale), null), pins.realmSaleFailure)
        assertNull(parsed(full.copy(economyUpgradeAuthority = "")).realmSaleFailure)
    }

    // 2026-10-10: the SKR faucet no longer rides the auction's SKR pin. Production pins the real auction mint; a faucet
    // there would hand out "test SKR" and apply the QA lane's deedless rule (N-045) to real players.
    @Test fun `the SKR faucet needs its own switch, the auction's SKR pin alone never lights it`() {
        val noSwitch = parsed(full.copy(skrFaucet = ""))
        assertEquals(SeekerAuctionPins(economy, skr, 6), noSwitch.seekerAuction)
        assertNull("the auction mint alone is no faucet", noSwitch.chainProfile)
        assertTrue(noSwitch.summary(), noSwitch.summary().startsWith("auction=on faucet=off realmSale=on"))
        assertNull(parsed(full.copy(skrFaucet = "off")).chainProfile)
        assertEquals(ChainProfile("devnet", SkrIdentity(skr, 6)), parsed(full).chainProfile)
    }

    // 2026-10-10: a production build carries the tracked set whole or not at all. A half-filled file would otherwise light
    // the auction (real SKR) while the realm sale or mining tax it was released beside stays dark or trusts a stale slot.
    // 2026-10-11: "whole" means every REQUIRED pin. A blank reserve owner left this list (it is optional, next test); a blank
    // KEEP mint joined it (it is required on its own now, no longer only through the mining family), and a SET but
    // malformed reserve still darkens everything, because a filled reserve keeps the 2026-10-10 rule.
    @Test fun `a tracked production set is all or nothing, never a partial money path`() {
        val whole = requireNotNull(ChainPins.parse(full.copy(skrFaucet = ""), "devnet", wholeSet = true))
        assertEquals("auction=on faucet=off realmSale=on realmSaleFailure=on miningClaim=on miningTax=on craft=on league=on", whole.summary())
        for (blank in listOf(full.copy(skrMint = ""), full.copy(economyProgramDataSha256 = ""), full.copy(realmSaleDeveloper = ""),
            full.copy(keepMint = ""), full.copy(keepReserveOwner = "not-a-key"), full.copy(economyUpgradeAuthority = ""),
            full.copy(craftProgramId = ""), full.copy(leagueProgramId = ""), full.copy(realmSalePolicyRevision = ""),
            full.copy(skrDecimals = "06"))) {
            assertNull("a partial or malformed tracked set lights nothing: $blank", ChainPins.parse(blank, "devnet", wholeSet = true))
            assertNotNull("the same values in a test-origin build keep their independent families", ChainPins.parse(blank, "devnet"))
        }
        assertNull("blank (today) is dark and never crashes", ChainPins.parse(ChainPinValues(), "devnet", wholeSet = true))
        assertTrue(ChainPins.trackedOrigin("https://play.pixelkingdomwars.com"))
        assertFalse(ChainPins.trackedOrigin("https://qa.pixelkingdomwars.com"))
    }

    // 2026-10-11 (D26 withdrawn; reviewer 07:20Z, verified on devnet read-only): production cannot set GEMS_RESERVE_OWNER
    // (the api and worker refuse to boot on the missing KEEP v3 reserve ATA, or bind that pair write-once in
    // economy_chain_identity), so the release ships with the reserve pin blank. That must cost players only the two families
    // the server cannot serve without a reserve (mining claim and mining tax), never the Seeker auction or the realm sale.
    @Test fun `a blank KEEP reserve owner in a tracked set darkens only the mining families, every other family stays lit`() {
        var derived = 0
        val noReserve = requireNotNull(ChainPins.parse(full.copy(keepReserveOwner = "", skrFaucet = ""), "devnet", wholeSet = true) { derived++; it })
        assertEquals("auction=on faucet=off realmSale=on realmSaleFailure=on miningClaim=off miningTax=off craft=on league=on", noReserve.summary())
        assertEquals("the auction keeps the real SKR pins", SeekerAuctionPins(economy, skr, 6), noReserve.seekerAuction)
        assertEquals(RealmSaleSigningTrust(genesis, economy, treasury, sha, 89L, revision), noReserve.realmSale)
        assertNull(noReserve.miningClaim); assertNull(noReserve.miningTax)
        assertEquals("no reserve, no mining config is derived", 0, derived)
        // The reserve is the ONLY optional identity pin: next to a blank reserve, a blank required pin still darkens the set.
        for (blank in listOf(full.copy(skrMint = ""), full.copy(keepMint = ""), full.copy(economyDeploymentSlot = ""),
            full.copy(economyProgramDataSha256 = ""), full.copy(realmSaleDeveloper = ""), full.copy(economyUpgradeAuthority = ""),
            full.copy(craftProgramId = ""), full.copy(leagueProgramId = ""), full.copy(realmSalePolicyRevision = "")))
            assertNull("a blank required pin darkens the whole set: $blank", ChainPins.parse(blank.copy(keepReserveOwner = ""), "devnet", wholeSet = true))
        assertNull("a reserve alone is no set", ChainPins.parse(ChainPinValues(cluster = "devnet", keepReserveOwner = fixture("reserveOwner")), "devnet", wholeSet = true))
        // The Gems wallet buy (KEEP -> Gems) never reads a chain pin: its reserve ATA and switch come from the server's
        // /native/capabilities, which advertises no wallet-keep source while GEMS_RESERVE_OWNER is unset. Blanking this pin
        // therefore cannot light or darken it; it stays dark because the server keeps it dark.
        val gemsBuy = File("src/main/kotlin").walkTopDown().filter { it.isFile && it.name.startsWith("GemsBuy") }.toList()
        assertTrue("the Gems wallet-buy sources exist", gemsBuy.isNotEmpty())
        for (f in gemsBuy) assertFalse("${f.name} reads no chain pin", Regex("""ChainPins|keepReserveOwner|PKW_KEEP_RESERVE_OWNER""").containsMatchIn(f.readText()))
    }

    /** The tracked file as the build reads it: java.util.Properties, every value trimmed. */
    private fun trackedFile(): Map<String, String> {
        val properties = java.util.Properties().apply { File("chain-pins.release.properties").reader().use { load(it) } }
        return properties.stringPropertyNames().associateWith { properties.getProperty(it).trim() }
    }
    private val trackedKeys = listOf("pkwChainCluster", "pkwEconomyProgramId", "pkwCraftProgramId", "pkwLeagueProgramId", "pkwSkrMint",
        "pkwSkrDecimals", "pkwKeepMint", "pkwKeepReserveOwner", "pkwEconomyDeploymentSlot", "pkwEconomyProgramDataSha256",
        "pkwEconomyUpgradeAuthority", "pkwRealmSaleDeveloper", "pkwRealmSalePolicyRevision", "pkwSkrFaucet")
    private fun ChainPinValues.ordered() = listOf(cluster, economyProgramId, craftProgramId, leagueProgramId, skrMint, skrDecimals, keepMint,
        keepReserveOwner, economyDeploymentSlot, economyProgramDataSha256, economyUpgradeAuthority, realmSaleDeveloper,
        realmSalePolicyRevision, skrFaucet)

    @Test fun `a build on the production origin carries exactly the tracked release pins, and stays dark unless they are whole`() {
        assumeTrue("a production-origin build (a test-origin build carries -Ppkw* instead)", ChainPins.trackedOrigin(BuildConfig.API_ORIGIN))
        val file = trackedFile()
        assertEquals("BuildConfig is the tracked file, field for field", trackedKeys.map { file.getValue(it) }, ChainPins.buildValues().ordered())
        val identity = trackedKeys.dropLast(1).map { file.getValue(it) }
        if (identity.all { it.isEmpty() }) {
            assertNull("blank (before the accepted deployment): every family dark", ChainPins.current); assertNull(seekerAuctionPins())
        } else {
            val pins = requireNotNull(ChainPins.current) { "a release refuses a partial file, so a filled one is whole" }
            // 2026-10-11: the optional KEEP reserve decides the two mining families and nothing else.
            val mining = if (file.getValue("pkwKeepReserveOwner").isEmpty()) "off" else "on"
            assertTrue(pins.summary(), Regex("""auction=on faucet=(on|off) realmSale=on realmSaleFailure=on miningClaim=$mining miningTax=$mining craft=on league=on""").matches(pins.summary()))
            assertNotNull("the auction is lit on the production origin", seekerAuctionPins())
            assertEquals(file.getValue("pkwSkrFaucet") == "on", pins.chainProfile != null)
        }
    }

    // The release reads only this file: its shape, its documentation and its values are what a signed APK trusts.
    @Test fun `the tracked release pin file documents every pin's server source and holds no test identity`() {
        val text = File("chain-pins.release.properties").readText()
        val file = trackedFile()
        assertEquals("exactly the build script's pins", trackedKeys.toSet(), file.keys)
        val header = text.lines().filter { it.startsWith("#") }.joinToString("\n")
        for (key in trackedKeys) assertTrue("the header maps $key to its source", Regex("""# ${key}\s*<-|# ${key} \(""").containsMatchIn(header))
        for (env in listOf("SEEKER_REALM_SALE_PROGRAM_ID", "SEEKER_AUCTION_MINT", "SEEKER_REALM_SALE_DEPLOYMENT_SLOT",
            "SEEKER_REALM_SALE_PROGRAM_DATA_SHA256", "SEEKER_REALM_SALE_UPGRADE_AUTHORITY", "SEEKER_REALM_SALE_DEVELOPER",
            "SEEKER_REALM_SALE_POLICY_REVISION", "PHASE_E_KEEP_RESERVE_OWNER")) assertTrue("names $env", header.contains(env))
        val testIds = listOf(economy, craft, league, skr, treasury, upgradeAuthority, "xdBqCYi7DeTg8HBbkCU4Zy1zZDbvw5dubXoxRtcn2xs",
            "7Hc8YFE6GjeYTF7uMMdgLomNN6Bd9A9XMyFa9UdkiGdn", "BVwQhLH5oBYLdWCshUHbkMZ6QrGvdATdiFwHtKGfaS4x",
            "4pMr6X5dr93K7S1YUTEWqME5uyBBtPd9r3Dmx3EELta6")
        assertTrue("no devnet TEST id is tracked for a release", file.values.none { it in testIds })
        // 2026-10-11: blank or whole over the REQUIRED pins; the KEEP reserve owner is optional, and documented as such.
        val filled = file.filterKeys { it != "pkwSkrFaucet" && it != "pkwKeepReserveOwner" }.values
        assertTrue("blank or whole, never partial", filled.all { it.isEmpty() } || filled.none { it.isEmpty() })
        if (filled.any { it.isNotEmpty() }) assertEquals("devnet", file["pkwChainCluster"])
        if (filled.all { it.isEmpty() }) assertEquals("a reserve alone is a partial set", "", file["pkwKeepReserveOwner"])
        assertTrue("the header states the optional reserve rule", header.contains("pkwKeepReserveOwner is OPTIONAL"))
        // 2026-10-11 (owner decision 15:00Z): the production API now serves the devnet tSKR faucet (DEVNET_SKR_FAUCET_ENABLED=true).
        // Code 33 shipped the switch blank, so players saw no claim the server would honour; from code 34 the release lights the
        // faucet family, and the switch stays tied to that decision so it is never flipped without the server serving it.
        assertEquals("the release lights the faucet the production server serves", "on", file["pkwSkrFaucet"])
        assertTrue("the header names the owner decision that turned it on",
            header.contains("pkwSkrFaucet=on: owner decision 2026-10-11") && header.contains("DEVNET_SKR_FAUCET_ENABLED=true"))
        // The 07:20Z finding: CVKo5i8a... is the KEEP v4 RESERVE and has no KEEP v3 (5GQh8Dg2...) account on devnet, so that pair
        // is a reserve no production server can serve (D26, withdrawn). It is valid only beside the KEEP v4 mint.
        assertFalse("the reserve is never paired with the KEEP v3 mint it holds no account for",
            file["pkwKeepReserveOwner"] == "CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q" && file["pkwKeepMint"] == "5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC")
    }

    @Test fun `the build script gives a test-origin debug build its -P pins and every other build the tracked file`() {
        val build = File("build.gradle.kts").readText()
        val android = build.substringAfter("\nandroid {")
        val defaults = android.substringAfter("defaultConfig {").substringBefore("buildTypes {")
        assertTrue("every build starts from the tracked file", defaults.contains("""releaseChainPins.forEach { (field, value) -> buildConfigField("String", field, "\"${'$'}value\"") }"""))
        assertTrue("which is the tracked properties file", build.contains("""val releaseChainPinsFile = file("chain-pins.release.properties")"""))
        val types = android.substringAfter("buildTypes {")
        val debug = types.substringAfter("debug {").substringBefore("release {")
        val release = types.substringAfter("release {").substringBefore("\n")
        assertTrue("only a test-origin debug build overrides them with -P", debug.contains("if (nativeCandidateOrigin != null || nativeLocalOrigin != null) chainPins.forEach"))
        assertFalse("release keeps the tracked file", release.contains("chainPins"))
        assertEquals("one place assigns -P values", 1, Regex("""\bchainPins\.forEach""").findAll(build).count())
        assertEquals("one place assigns tracked values", 1, Regex("""releaseChainPins\.forEach""").findAll(build).count())
        assertTrue("a -P pin passed to any other build fails it", build.contains("require(nativeCandidateOrigin != null || nativeLocalOrigin != null)"))
        // The release gate: wired to assemble, refusing a partial set, a non-devnet cluster and the night's test ids.
        val hook = build.substringAfter("androidComponents.onVariants { variant ->")
        val releaseHook = hook.substringAfter("if (variant.buildType == \"release\") {")
        assertTrue(releaseHook.contains("tasks.register<ReleaseChainPinsGate>(\"check${'$'}{cap}ChainPins\")"))
        assertTrue(releaseHook.contains("pins.set(releaseChainPins)"))
        assertTrue(releaseHook.contains("tasks.named { it == \"assemble${'$'}cap\" }.configureEach { dependsOn(chainPinsGate) }"))
        val gate = build.substringAfter("abstract class ReleaseChainPinsGate").substringBefore("\n}\n")
        assertTrue(gate.contains("partial set, blank"))
        assertTrue(gate.contains("the cluster must be devnet"))
        // 2026-10-11: the gate's partial check runs over the REQUIRED pins, and the reserve owner is the only optional one.
        assertTrue(gate.contains("required.filterValues { it.isEmpty() }"))
        assertTrue(releaseHook.contains("optional.set(mapOf(\"PKW_KEEP_RESERVE_OWNER\" to \"miningClaim and miningTax\"))"))
        for (id in listOf("xdBqCYi7DeTg8HBbkCU4Zy1zZDbvw5dubXoxRtcn2xs", "7Hc8YFE6GjeYTF7uMMdgLomNN6Bd9A9XMyFa9UdkiGdn", craft, league))
            assertTrue("the gate refuses test id $id", build.substringAfter("val devnetTestChainIds = mapOf(").substringBefore("\n)\n").contains("\"$id\""))
    }
}
