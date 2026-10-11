import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.BuildConfigField
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Properties

plugins { id("com.android.application"); kotlin("android"); kotlin("plugin.serialization"); id("org.jetbrains.kotlin.plugin.compose") }
// Local/CI Firebase config is never committed. Unconfigured builds cannot register for push.
val nativeFirebaseConfigured = file("google-services.json").isFile
if (providers.gradleProperty("nativeRequireFirebase").orNull == "true") {
    require(nativeFirebaseConfigured) { "Release messaging requires app/google-services.json for both Android packages" }
}
if (nativeFirebaseConfigured) apply(plugin = "com.google.gms.google-services")
val nativeVersionCode = providers.gradleProperty("nativeVersionCode").map(String::toInt).orElse(1)
val nativeVersionName = providers.gradleProperty("nativeVersionName").orElse("0.1.0-foundation")
// Attribute feedback to the native binary, independently of its content/source pack.
// A working copy is honestly "dev"; it must not impersonate its last clean commit.
val nativeGitHead = providers.exec {
    workingDir(rootProject.projectDir); commandLine("git", "rev-parse", "HEAD"); isIgnoreExitValue = true
}.standardOutput.asText.map(String::trim)
val nativeGitStatus = providers.exec {
    workingDir(rootProject.projectDir); commandLine("git", "status", "--porcelain", "--untracked-files=normal"); isIgnoreExitValue = true
}.standardOutput.asText.map(String::trim)
val nativeBuildSha = nativeGitHead.zip(nativeGitStatus) { head, status ->
    if (!head.matches(Regex("[a-f0-9]{40}"))) "unknown" else if (status.isNotEmpty()) "dev" else head
}
// Real OAuth tests require the wallet's log-removal rules, including in the separate debug APK.
val nativeOptimizedDebug = providers.gradleProperty("nativeOptimizedDebug").map(String::toBooleanStrict).orElse(false)
// Opt-in, debug-only local API. The release origin and trust resources stay fixed.
val nativeLocalOrigin = providers.gradleProperty("nativeLocalOrigin").orNull
// An isolated remote candidate uses platform TLS and separate debug-app data.
// This exact allowlist is independent of the private-LAN certificate override.
val nativeCandidateOrigin = providers.gradleProperty("nativeCandidateOrigin").orNull
if (nativeCandidateOrigin != null) {
    require(nativeCandidateOrigin == "https://qa.pixelkingdomwars.com") {
        "nativeCandidateOrigin must be exactly https://qa.pixelkingdomwars.com"
    }
    require(nativeLocalOrigin == null && !providers.gradleProperty("nativeLocalCa").isPresent) {
        "Candidate HTTPS cannot be combined with a local origin or private CA"
    }
    require(nativeOptimizedDebug.get()) { "Candidate testing requires -PnativeOptimizedDebug=true" }
}
val nativeLocalUri = nativeLocalOrigin?.let { raw ->
    val uri = URI(raw)
    val labels = uri.host?.split('.').orEmpty()
    val octets = labels.mapNotNull(String::toIntOrNull)
    val privateHost = uri.host in listOf("localhost", "127.0.0.1") ||
        (labels.size == 4 && octets.size == 4 && octets.all { it in 0..255 } &&
            (octets[0] == 10 || (octets[0] == 172 && octets[1] in 16..31) || (octets[0] == 192 && octets[1] == 168)))
    require(uri.scheme == "https" && privateHost && uri.port == 18443 && uri.rawUserInfo == null &&
        uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null) {
        "nativeLocalOrigin must be a bare HTTPS private IPv4/localhost origin on port 18443"
    }
    uri
}
// Chain pins (data/ChainPins.kt): the public ids of ONE devnet deployment, each a String BuildConfig field. Two sources,
// never mixed (owner 2026-10-10: Phase E to production):
//  - a test-origin debug build (-PnativeCandidateOrigin / -PnativeLocalOrigin) takes them from -Ppkw* (night 2026-10-06);
//    passing any of them to another build fails it, so a stray test pin can never reach a release.
//  - every other build (the release players install, a production-origin debug build) takes them from the tracked
//    app/chain-pins.release.properties. checkReleaseChainPins fails a release whose file is missing a REQUIRED pin,
//    names a devnet TEST id or a cluster other than devnet; the app keeps every family dark on such a set. The KEEP reserve
//    owner is OPTIONAL (2026-10-11, D26 withdrawn): blank darkens only the mining claim and mining tax families.
// Each value is shape-checked here, so a typo fails the build instead of silently leaving a feature dark.
val chainPinB58 = "[1-9A-HJ-NP-Za-km-z]{32,44}"
val chainPinShapes = listOf(
    Triple("pkwChainCluster", "PKW_CHAIN_CLUSTER", "devnet"),
    Triple("pkwEconomyProgramId", "PKW_ECONOMY_PROGRAM_ID", chainPinB58),
    Triple("pkwCraftProgramId", "PKW_CRAFT_PROGRAM_ID", chainPinB58),
    Triple("pkwLeagueProgramId", "PKW_LEAGUE_PROGRAM_ID", chainPinB58),
    Triple("pkwSkrMint", "PKW_SKR_MINT", chainPinB58),
    Triple("pkwSkrDecimals", "PKW_SKR_DECIMALS", "0|[1-9][0-9]{0,2}"),
    Triple("pkwKeepMint", "PKW_KEEP_MINT", chainPinB58),
    Triple("pkwKeepReserveOwner", "PKW_KEEP_RESERVE_OWNER", chainPinB58),
    Triple("pkwEconomyDeploymentSlot", "PKW_ECONOMY_DEPLOYMENT_SLOT", "0|[1-9][0-9]{0,15}"),
    Triple("pkwEconomyProgramDataSha256", "PKW_ECONOMY_PROGRAM_DATA_SHA256", "[0-9a-f]{64}"),
    Triple("pkwEconomyUpgradeAuthority", "PKW_ECONOMY_UPGRADE_AUTHORITY", "none|$chainPinB58"),
    Triple("pkwRealmSaleDeveloper", "PKW_REALM_SALE_DEVELOPER", chainPinB58),
    Triple("pkwRealmSalePolicyRevision", "PKW_REALM_SALE_POLICY_REVISION", "[A-Za-z0-9_.:-]{1,128}"),
    // The SKR faucet's own switch, not an identity: the auction's SKR mint no longer lights the faucet on its own.
    Triple("pkwSkrFaucet", "PKW_SKR_FAUCET", "on|off"),
)
fun chainPinValues(source: String, read: (String) -> String?) = chainPinShapes.associate { (property, field, shape) ->
    val value = read(property)?.trim().orEmpty()
    require(value.isEmpty() || value.matches(Regex(shape))) { "$source$property must match $shape" }
    field to value
}
val chainPins = chainPinValues("-P") { providers.gradleProperty(it).orNull }
if (chainPins.values.any { it.isNotEmpty() }) {
    require(nativeCandidateOrigin != null || nativeLocalOrigin != null) {
        "Chain pins (-Ppkw*) are for test builds only: add -PnativeLocalOrigin or -PnativeCandidateOrigin"
    }
    require(chainPins.getValue("PKW_CHAIN_CLUSTER") == "devnet" && providers.gradleProperty("nativeSolanaCluster").orElse("devnet").get() == "devnet") {
        "Chain pins name a devnet test deployment: pass -PpkwChainCluster=devnet on a devnet build"
    }
}
val releaseChainPinsFile = file("chain-pins.release.properties")
val releaseChainPins = run {
    require(releaseChainPinsFile.isFile) { "${releaseChainPinsFile.name} is missing: it is tracked, blank until the accepted deployment" }
    // Imported, not java.util.Properties(): in this script `java` is the Java extension accessor, so the FQN fails to compile.
    val tracked = Properties().apply { releaseChainPinsFile.reader().use { load(it) } }
    val unknown = tracked.stringPropertyNames() - chainPinShapes.map { it.first }.toSet()
    require(unknown.isEmpty()) { "${releaseChainPinsFile.name} names unknown pins $unknown" }
    chainPinValues("${releaseChainPinsFile.name}: ") { tracked.getProperty(it) }
}
val localTrustResources = layout.buildDirectory.dir("generated/nativeLocalTrust")
val natives by configurations.creating
android {
    namespace = "gg.pixelkingdomwars.nativeclient"
    compileSdk = 36
    defaultConfig {
        applicationId = "gg.pixelkingdomwars.twa"
        manifestPlaceholders["nativeAppLabel"] = "Pixel Kingdom Wars"
        manifestPlaceholders["nativeLinkHost"] = "play.pixelkingdomwars.com"
        buildConfigField("boolean", "NATIVE_FCM_CONFIGURED", nativeFirebaseConfigured.toString())
        minSdk = 28; targetSdk = 36
        versionCode = nativeVersionCode.get(); versionName = nativeVersionName.get()
        buildConfigField("String", "NATIVE_BUILD_SHA", "\"${nativeBuildSha.get()}\"")
        testInstrumentationRunner = "gg.pixelkingdomwars.nativeclient.LocalUiHarness"
        buildConfigField("String", "API_ORIGIN", "\"https://play.pixelkingdomwars.com\"")
        buildConfigField("boolean", "NATIVE_CANDIDATE", "false")
        buildConfigField("String", "WALLET_IDENTITY_ORIGIN", "\"https://play.pixelkingdomwars.com\"")
        // The economy cluster of this build (web `lib/cluster.ts` SOLANA_CLUSTER): production is the devnet alpha.
        buildConfigField("String", "SOLANA_CLUSTER", "\"${providers.gradleProperty("nativeSolanaCluster").orElse("devnet").get()}\"")
        // Chain pins (data/ChainPins.kt): the tracked release file's values, for the release and a production-origin debug
        // build alike; blank today, so dark. Only a test-origin debug build overrides them, below.
        releaseChainPins.forEach { (field, value) -> buildConfigField("String", field, "\"$value\"") }
        // Public Privy identifiers of the existing production app (docs/PRIVY_ANDROID.md): the
        // web app ID and the Android app client the owner created on 2026-09-11. Not secrets.
        buildConfigField("String", "PRIVY_APP_ID", "\"cmrxb5f1w00vz0cjrxij9vz2e\"")
        buildConfigField("String", "PRIVY_APP_CLIENT_ID", "\"client-WY6bNQwTMPpZkgx3u8HNWxGgVD4EZMypL5hue7G35GWGZ\"")
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"; versionNameSuffix = "-debug"
            isMinifyEnabled = nativeOptimizedDebug.get()
            isDebuggable = !nativeOptimizedDebug.get()
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (nativeLocalOrigin != null) buildConfigField("String", "API_ORIGIN", "\"$nativeLocalOrigin\"")
            // Only a candidate or local-origin test build receives the chain pins (any other build passing them fails above).
            if (nativeCandidateOrigin != null || nativeLocalOrigin != null) chainPins.forEach { (field, value) -> buildConfigField("String", field, "\"$value\"") }
            if (nativeCandidateOrigin != null) {
                // Separate instrumentation calls this small ABI after target R8.
                // Production/release and ordinary debug do not retain it.
                proguardFiles("candidate-test-api.pro")
                buildConfigField("boolean", "NATIVE_CANDIDATE", "true")
                buildConfigField("String", "API_ORIGIN", "\"$nativeCandidateOrigin\"")
                buildConfigField("String", "WALLET_IDENTITY_ORIGIN", "\"$nativeCandidateOrigin\"")
                buildConfigField("boolean", "NATIVE_FCM_CONFIGURED", "false")
                // This candidate exercises Seeker wallet login. Avoid sharing
                // production's custom-scheme Privy OAuth return between apps.
                buildConfigField("String", "PRIVY_APP_ID", "\"\"")
                buildConfigField("String", "PRIVY_APP_CLIENT_ID", "\"\"")
                manifestPlaceholders["nativeAppLabel"] = "Pixel Kingdom Wars Test"
                manifestPlaceholders["nativeLinkHost"] = "qa.pixelkingdomwars.com"
                versionNameSuffix = "-candidate"
            }
        }
        release { isMinifyEnabled = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro") }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("generated/jniLibs"))
    // One pure admission predicate, compiled only into test artifacts.
    sourceSets["androidTest"].java.srcDir("src/harnessTest/kotlin")
    sourceSets["test"].java.srcDir("src/harnessTest/kotlin")
    if (nativeLocalUri != null) sourceSets["debug"].res.srcDir(localTrustResources)
    if (nativeCandidateOrigin != null) sourceSets["debug"].manifest.srcFile("src/candidate/AndroidManifest.xml")
    packaging {
        jniLibs { useLegacyPackaging = false }
        // JSpecify and Bouncy Castle both carry this desktop OSGi bundle descriptor.
        // Android uses neither descriptor; retain all provider/service resources.
        resources.excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
    }
}
if (nativeLocalUri != null) {
    val caFile = rootProject.file(providers.gradleProperty("nativeLocalCa").orElse(".reports/local-dev/ca.pem").get())
    val generateLocalTrust by tasks.registering {
        inputs.file(caFile); inputs.property("origin", nativeLocalOrigin!!)
        outputs.dir(localTrustResources)
        doLast {
            val certificate = caFile.inputStream().use {
                CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
            }
            certificate.checkValidity()
            require(certificate.basicConstraints >= 0) { "nativeLocalCa must be a CA certificate" }
            val output = localTrustResources.get().asFile
            output.resolve("raw").mkdirs(); output.resolve("xml").mkdirs()
            caFile.copyTo(output.resolve("raw/native_local_ca.pem"), overwrite = true)
            val loopbackDomains = listOf("localhost", "127.0.0.1").filterNot { it == nativeLocalUri.host }
                .joinToString("") { "<domain includeSubdomains=\"false\">$it</domain>" }
            val localLoopback = nativeLocalUri.host in listOf("localhost", "127.0.0.1")
            output.resolve("xml/network_security_config.xml").writeText("""
                <network-security-config>
                    <base-config cleartextTrafficPermitted="false" />
                    <domain-config cleartextTrafficPermitted="true">$loopbackDomains</domain-config>
                    <domain-config cleartextTrafficPermitted="$localLoopback">
                        <domain includeSubdomains="false">${nativeLocalUri.host}</domain>
                        <trust-anchors><certificates src="@raw/native_local_ca" /><certificates src="system" /></trust-anchors>
                    </domain-config>
                </network-security-config>
            """.trimIndent())
        }
    }
    tasks.matching { it.name == "preDebugBuild" }.configureEach { dependsOn(generateLocalTrust) }
}
val extractNatives by tasks.registering {
    inputs.files(natives)
    outputs.dir(layout.buildDirectory.dir("generated/jniLibs"))
    doLast {
        natives.files.forEach { archive ->
            val abi = if (archive.name.contains("arm64-v8a")) "arm64-v8a" else "x86_64"
            copy { from(zipTree(archive)); include("*.so"); into(layout.buildDirectory.dir("generated/jniLibs/$abi")) }
        }
    }
}
tasks.named("preBuild") { dependsOn(extractNatives) }
// D-NEXT: every APK carries the new world's content (no download). `node tools/world-debug-content.mjs --source …` fills
// src/main/assets/world (gitignored like the client pack) from the pinned pack. No variant merges its assets unless
// content.json is there, names the pin and pack manifest world-shaders.lock.json tracks, every file it lists has its
// listed size and sha256 (D-175: hash-verified at build time; a bad copy would silently send every player to the legacy
// globe), and no retired D-171 debug-only copy is left for a debug APK to package over it. The pin check matters because
// the copy is gitignored and outlives a re-pin: an older pin's copy matches its own content.json file by file, and would
// ship that pin's realm packs beside this pin's shaders and renderer.
//
// CI only: native.yml cannot build the bundle (the pin names a web branch on no remote, and the pack is a built,
// gitignored output), so it passes -PpkwWorldContent=absent-ci, honoured only where CI=true (GitHub Actions sets it).
// The check then warns loudly and skips, and the build packages NO world: a bundle present anyway fails the check, so the
// opt-out never packages bytes nobody verified. Such an APK runs the legacy globe on every device and must never ship:
// tools/release.mjs refuses the property and builds with -PpkwWorldContent=required (the command line outranks every
// gradle.properties and ORG_GRADLE_PROJECT_ variable), and tools/check-release-world.mjs fails an APK without
// assets/world/content.json. Any other value is refused, so a typo means neither.
val worldContentAbsentCi = when (val mode = providers.gradleProperty("pkwWorldContent").orElse("required").get()) {
    "required" -> false
    "absent-ci" -> {
        require(providers.environmentVariable("CI").orNull == "true") {
            "pkwWorldContent=absent-ci is CI's opt-out (CI=true): a local build carries the verified world bundle"
        }
        true
    }
    else -> throw GradleException("pkwWorldContent must be required or absent-ci, not \"$mode\"")
}
abstract class VerifyWorldContent : DefaultTask() {
    @get:Internal abstract val world: DirectoryProperty
    @get:Internal abstract val legacy: DirectoryProperty
    @get:Internal abstract val lock: RegularFileProperty
    @get:Internal abstract val absentCi: Property<Boolean>
    @TaskAction fun verify() {
        val dir = world.get().asFile; val index = dir.resolve("content.json"); val problems = mutableListOf<String>()
        if (absentCi.get()) {
            val present = listOf(dir, legacy.get().asFile).filter { it.exists() }
            if (present.isNotEmpty()) throw GradleException("pkwWorldContent=absent-ci builds an APK with NO world content, but " +
                "${present.joinToString()} exists: drop the property so the bundle is verified")
            logger.warn("::warning title=World content absent (pkwWorldContent=absent-ci)::World content check SKIPPED: this " +
                "APK carries NO world content, so every device runs the legacy globe. It must never ship: tools/release.mjs " +
                "refuses this property and tools/check-release-world.mjs fails the APK.")
            return
        }
        if (legacy.get().asFile.exists()) problems += "${legacy.get().asFile} is the retired debug-only copy: a debug APK would package it over the bundle"
        val content = if (!index.isFile) null else groovy.json.JsonSlurper().parse(index) as? Map<*, *>
        val files = content?.get("files") as? List<*>
        if (!index.isFile) problems += "$index is missing: every APK carries the world content"
        else if (files.isNullOrEmpty()) problems += "$index lists no files"
        val pinned = lock.get().asFile.takeIf { it.isFile }?.let { groovy.json.JsonSlurper().parse(it) as? Map<*, *> }
        val pin = (pinned?.get("source") as? Map<*, *>)?.get("commit")
        val manifest = (pinned?.get("contentManifest") as? Map<*, *>)?.get("sha256")
        if (pin == null || manifest == null) problems += "${lock.get().asFile} names no pin and pack manifest"
        else if (content != null) {
            if (content["pin"] != pin) problems += "content.json is from pin ${content["pin"]}, the lock pins $pin"
            val got = (content["manifest"] as? Map<*, *>)?.get("sha256")
            if (got != manifest) problems += "content.json names pack manifest $got, the lock pins $manifest"
        }
        files.orEmpty().forEach { entry ->
            val rel = (entry as? Map<*, *>)?.get("path") as? String; val want = ((entry as? Map<*, *>)?.get("bytes") as? Number)?.toLong()
            val sha = (entry as? Map<*, *>)?.get("sha256") as? String
            val file = rel?.let(dir::resolve)
            when {
                file == null || want == null || sha == null -> problems += "malformed content.json entry $entry"
                !file.isFile -> problems += "missing $rel"
                file.length() != want -> problems += "size $rel: ${file.length()} bytes, content.json lists $want"
                sha256(file) != sha -> problems += "sha256 $rel differs from content.json"
            }
        }
        if (problems.isNotEmpty()) throw GradleException("World content check failed (${problems.size}):\n  ${problems.joinToString("\n  ")}\n" +
            "Fix: node tools/world-debug-content.mjs --source <SHARDKEEP-globe checkout with the pinned pack>, then --verify (docs/LOCAL_TESTING.md)")
        logger.lifecycle("world content: ${files.orEmpty().size} files match content.json at pin $pin")
    }
    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(1 shl 16)
        file.inputStream().use { input -> while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
val verifyWorldContent = tasks.register<VerifyWorldContent>("verifyWorldContent") {
    world.set(layout.projectDirectory.dir("src/main/assets/world")); legacy.set(layout.projectDirectory.dir("src/debug/assets/world"))
    lock.set(rootProject.layout.projectDirectory.file("world-shaders.lock.json")); absentCi.set(worldContentAbsentCi)
}
// Owner 2026-09-26 (D-NEXT, overrides D-172's release-off): Solana Island, Seeker Island and Divine Isle are visible to
// players in release builds too. Every APK packages the one bundle, whose content.json says "phaseEIslands": true, the
// only flag the native globe's Phase E layer and rail chips read; check<Variant>PhaseEOn reads the merged assets a
// release APK packages and fails if another copy of content.json (or a bundle without the islands) would hide them.
abstract class PhaseEOnGate : DefaultTask() {
    @get:InputDirectory abstract val assets: DirectoryProperty
    @get:Input abstract val absentCi: Property<Boolean>
    @TaskAction fun check() {
        val index = assets.get().asFile.resolve("world/content.json")
        if (!index.isFile && absentCi.get()) { logger.warn("Phase E islands: no world index in this APK (pkwWorldContent=absent-ci)"); return }
        if (!index.isFile) throw GradleException("$index is missing from the merged release assets")
        val flag = (groovy.json.JsonSlurper().parse(index) as? Map<*, *>)?.get("phaseEIslands")
        if (flag != true) throw GradleException("$index says \"phaseEIslands\": $flag: a release APK would hide the islands the owner wants players to see (2026-09-26)")
        logger.lifecycle("Phase E islands: on in the release world index")
    }
}
// Owner 2026-10-10 (Phase E to production): a release carries app/chain-pins.release.properties. Blank (before the
// accepted deployment) builds a dark release and says so; anything else must hold every REQUIRED pin of the accepted
// devnet set. A partial set (the app would keep every family dark), a cluster other than devnet, or any public id of the
// night 2026-10-06 devnet TEST deployments (the devnet TEST deployment record, v1 and v2) fails the release.
// 2026-10-11 (D26 withdrawn, reviewer 07:20Z): PKW_KEEP_RESERVE_OWNER is OPTIONAL. Production must not set
// GEMS_RESERVE_OWNER (api + worker boot would refuse on the missing reserve ATA, or bind the pair write-once), so the
// release cannot carry an invented reserve. Blank, only the mining claim and mining tax families (the two that sign
// against it) are dark; set, it is required and shape-checked like every other pin.
val devnetTestChainIds = mapOf(
    "xdBqCYi7DeTg8HBbkCU4Zy1zZDbvw5dubXoxRtcn2xs" to "test economy program v1",
    "7Hc8YFE6GjeYTF7uMMdgLomNN6Bd9A9XMyFa9UdkiGdn" to "test economy program v2",
    "17sCdP3nT1p1AYSA29oczoVMMfzYThJAV7o6FVokvR3" to "test craft program",
    "2VjgKKMbjJWaB4wKo4e2qtVrGrQ7RF1hfmgZ3NaxCFW1" to "test league program",
    "A68QYUbmEqNQjmumg7ta1m3KezFSVYCsfZLpSNyyUNQ2" to "test SKR mint",
    "BVwQhLH5oBYLdWCshUHbkMZ6QrGvdATdiFwHtKGfaS4x" to "test KEEP-style mint",
    "4pMr6X5dr93K7S1YUTEWqME5uyBBtPd9r3Dmx3EELta6" to "test KEEP reserve owner",
    "EY9tW9FamdSMEUADaNANfHzzyFoEZDXXVgyKug8sBNTk" to "test treasury",
    "HjR878onP7hytXFrRS5xvudV3dipEGyhtnwznBb3LRno" to "test economy upgrade authority",
)
abstract class ReleaseChainPinsGate : DefaultTask() {
    @get:Input abstract val pins: MapProperty<String, String>
    @get:Input abstract val switches: SetProperty<String>
    /** Identity pins a filled set may leave blank, each mapped to the families its blank darkens (data/ChainPins.kt). */
    @get:Input abstract val optional: MapProperty<String, String>
    @get:Input abstract val testIds: MapProperty<String, String>
    @get:Input abstract val solanaCluster: Property<String>
    @get:Input abstract val pinFile: Property<String>
    @TaskAction fun check() {
        val values = pins.get(); val identity = values.filterKeys { it !in switches.get() }; val problems = mutableListOf<String>()
        val required = identity.filterKeys { it !in optional.get() }
        values.forEach { (field, value) -> testIds.get()[value]?.let { problems += "$field is the $it $value" } }
        if (identity.values.all { it.isEmpty() }) {
            if (values.any { (field, value) -> field in switches.get() && value == "on" }) problems += "a switch is on with no pins"
            if (problems.isEmpty()) { logger.warn("release chain pins: ${pinFile.get()} is blank: every chain family is DARK in this release"); return }
        } else {
            required.filterValues { it.isEmpty() }.keys.takeIf { it.isNotEmpty() }?.let { problems += "partial set, blank: $it (the app keeps every family dark)" }
            if (values["PKW_CHAIN_CLUSTER"] != "devnet" || solanaCluster.get() != "devnet") problems += "the cluster must be devnet"
        }
        if (problems.isNotEmpty()) throw GradleException("Release chain pins (${pinFile.get()}) refused (${problems.size}):\n  ${problems.joinToString("\n  ")}")
        logger.lifecycle("release chain pins: the complete REQUIRED devnet set (${required.size} pins) from ${pinFile.get()}, economy ${values["PKW_ECONOMY_PROGRAM_ID"]}")
        optional.get().forEach { (field, families) ->
            if (values[field].isNullOrEmpty()) logger.lifecycle("release chain pins: optional $field is blank: $families DARK, every other family LIT")
            else logger.lifecycle("release chain pins: optional $field is set: $families LIT")
        }
    }
}
// The in-app updater refuses an APK over MAX_UPDATE_BYTES (app/src/main/kotlin/gg/pixelkingdomwars/nativeclient/update/
// UpdateEligibility.kt, 300 MiB = 314,572,800 bytes). From this release on, updates reach players through it (D-NEXT), so
// a release or optimized-debug (candidate) APK must stay 10 MB under that cap. tools/app-build-gates.test.mjs fails if
// these numbers and UpdateEligibility.kt drift apart.
val nativeUpdaterCapBytes = 300L * 1024 * 1024
val nativeApkLimitBytes = nativeUpdaterCapBytes - 10_000_000L
abstract class ApkSizeGate : DefaultTask() {
    @get:InputDirectory abstract val apks: DirectoryProperty
    @get:Input abstract val limitBytes: Property<Long>
    @TaskAction fun check() {
        val found = apks.get().asFile.listFiles { f -> f.extension == "apk" }.orEmpty()
        if (found.isEmpty()) throw GradleException("no APK in ${apks.get().asFile}")
        for (apk in found) {
            val size = apk.length(); val limit = limitBytes.get()
            if (size > limit) throw GradleException("${apk.name} is $size bytes, over the $limit-byte limit (the in-app updater's cap in UpdateEligibility.kt less 10 MB)")
            logger.lifecycle("APK size: ${apk.name} $size bytes, limit $limit (${limit - size} spare)")
        }
    }
}
// Owner-granted physical local-fixture admission belongs ONLY to the test APK.
// No defaultConfig/buildType/main-variant BuildConfig field receives this value.
androidComponents.onVariants(androidComponents.selector().withBuildType("debug")) { variant ->
    variant.androidTest?.buildConfigFields?.put("NATIVE_LOCAL_PHYSICAL_DEVICE",
        providers.gradleProperty("nativeLocalPhysicalDevice").orElse("").map { expected ->
            require(expected.isEmpty() || expected.matches(Regex("[a-f0-9]{64}"))) {
                "nativeLocalPhysicalDevice must be absent or a lowercase SHA-256 device proof"
            }
            BuildConfigField("String", "\"$expected\"", "Owner-granted local-fixture androidTest device proof; empty keeps emulator-only admission.")
        })
}

androidComponents.onVariants { variant ->
    val cap = variant.name.replaceFirstChar(Char::uppercase)
    tasks.named { it == "merge${cap}Assets" }.configureEach { dependsOn(verifyWorldContent) }
    if (variant.buildType == "release") {
        val phaseEOn = tasks.register<PhaseEOnGate>("check${cap}PhaseEOn") {
            assets.set(variant.artifacts.get(SingleArtifact.ASSETS)); absentCi.set(worldContentAbsentCi)
        }
        tasks.named { it == "assemble$cap" }.configureEach { dependsOn(phaseEOn) }
        val chainPinsGate = tasks.register<ReleaseChainPinsGate>("check${cap}ChainPins") {
            pins.set(releaseChainPins); switches.set(setOf("PKW_SKR_FAUCET")); testIds.set(devnetTestChainIds)
            optional.set(mapOf("PKW_KEEP_RESERVE_OWNER" to "miningClaim and miningTax"))
            solanaCluster.set(providers.gradleProperty("nativeSolanaCluster").orElse("devnet")); pinFile.set(releaseChainPinsFile.name)
        }
        tasks.named { it == "assemble$cap" }.configureEach { dependsOn(chainPinsGate) }
    }
    if (variant.buildType == "release" || nativeOptimizedDebug.get()) {
        val gate = tasks.register<ApkSizeGate>("check${cap}ApkSize") { apks.set(variant.artifacts.get(SingleArtifact.APK)); limitBytes.set(nativeApkLimitBytes) }
        tasks.named { it == "assemble$cap" }.configureEach { dependsOn(gate) }
    }
}
dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation(project(":network")); implementation(project(":wallet")); implementation(project(":renderer")); implementation(project(":content"))
    implementation(platform("androidx.compose:compose-bom:2025.03.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.fragment:fragment-ktx:1.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    // Type-safe routes (Boot → Title → Totp → LandGate → Home). 2.8.x is the line released with the 2025.03 Compose BOM.
    implementation("androidx.navigation:navigation-compose:2.8.9")
    implementation("com.badlogicgames.gdx:gdx-backend-android:1.13.1")
    natives("com.badlogicgames.gdx:gdx-platform:1.13.1:natives-arm64-v8a")
    natives("com.badlogicgames.gdx:gdx-platform:1.13.1:natives-x86_64")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}

// Phase E: explicit paired JVM acceptance, never discovered by ordinary units.
// It needs a sibling backend source checkout and disposable local PostgreSQL.
android.sourceSets["test"].java.srcDir("src/pairedTest/kotlin")
tasks.withType<Test>().configureEach {
    if (name != "pairedGemsApiTest") exclude("**/GemsApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedGemsApiTest") {
    group = "verification"
    description = "Pairs the native Gems repository with the fixture Fastify API and ledger (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/GemsApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeGemsApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must name the backend checkout containing nativeGemsApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }

// Phase E: wallet-buy paired JVM fixture (no APK/device task).
tasks.withType<Test>().configureEach {
    if (name != "pairedGemsBuyApiTest") exclude("**/GemsBuyApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedGemsBuyApiTest") {
    group = "verification"
    description = "Pairs the native wallet Gems purchase with the fixture Fastify API and ledger (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/GemsBuyApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeGemsBuyApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must name the backend checkout containing nativeGemsBuyApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }

// Phase E: second-free-base paired JVM acceptance; no APK or device task.
tasks.withType<Test>().configureEach {
    if (name != "pairedFreeBaseApiTest") exclude("**/FreeBaseApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedFreeBaseApiTest") {
    group = "verification"
    description = "Pairs the native second-base purchase with the fixture Fastify API and ledger (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/FreeBaseApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeFreeBaseApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must contain nativeFreeBaseApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }
// End Phase E second-free-base paired JVM acceptance.

// Phase E: mining claim paired JVM acceptance; no APK or device task.
tasks.withType<Test>().configureEach {
    if (name != "pairedMiningClaimsApiTest") exclude("**/MiningClaimsApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedMiningClaimsApiTest") {
    group = "verification"
    description = "Pairs native sign-only mining claims with the restricted fixture Fastify API (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/MiningClaimsApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeMiningClaimsApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must contain nativeMiningClaimsApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }
// End Phase E mining claim paired JVM acceptance.

// Phase E: cumulative mining claim paired JVM acceptance; no APK/device task.
tasks.withType<Test>().configureEach {
    if (name != "pairedMiningClaimsCumulativeApiTest") exclude("**/MiningClaimsCumulativeApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedMiningClaimsCumulativeApiTest") {
    group = "verification"
    description = "Pairs native cumulative claims with the restricted fixture Fastify API (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/MiningClaimsCumulativeApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeCumulativeMiningClaimsApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must contain nativeCumulativeMiningClaimsApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }
// End Phase E cumulative mining claim paired JVM acceptance.

// Phase E: Seeker-resource paired JVM acceptance; no APK or device task.
tasks.withType<Test>().configureEach {
    if (name != "pairedSeekerResourceApiTest") exclude("**/SeekerResourceApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedSeekerResourceApiTest") {
    group = "verification"
    description = "Pairs the native resource share claim with the fixture Fastify API and ledger (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/SeekerResourceApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeSeekerResourceApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must contain nativeSeekerResourceApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }
// End Phase E Seeker-resource paired JVM acceptance.

// Phase E: original KEEP tax paired JVM fixture, isolated from ordinary units.
tasks.withType<Test>().configureEach {
    if (name != "pairedMiningTaxClaimsApiTest") exclude("**/MiningTaxClaimsApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedMiningTaxClaimsApiTest") {
    group = "verification"
    description = "Pairs native KEEP tax recovery with the isolated authenticated fixture API (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit)); testClassesDirs = unit.testClassesDirs; classpath = unit.classpath
    include("**/MiningTaxClaimsApiPairedTest.class"); maxParallelForks = 1; outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeMiningTaxClaimsApiFixture.ts")?.isFile == true) { "PHASE_E_API_ROOT must contain nativeMiningTaxClaimsApiFixture.ts" }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) { "A disposable loopback native fixture database URL is required" }
    }
} }

// Phase E: original realm purchase paired JVM fixture, isolated from ordinary units.
tasks.withType<Test>().configureEach {
    if (name != "pairedRealmSalesApiTest") exclude("**/RealmSalesApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedRealmSalesApiTest") {
    group = "verification"
    description = "Pairs native realm purchases with the fixture Fastify API and verified settlement (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/RealmSalesApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeRealmSalesApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must contain nativeRealmSalesApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }

// Phase E: selected paid starter departure pairing; JVM only, no APK or device task.
tasks.withType<Test>().configureEach {
    if (name != "pairedPaidStarterExpeditionApiTest") exclude("**/PaidStarterExpeditionApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedPaidStarterExpeditionApiTest") {
    group = "verification"
    description = "Pairs native paid starter departures with isolated Fastify and finalized fixture evidence."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/PaidStarterExpeditionApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativePaidStarterExpeditionApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must contain nativePaidStarterExpeditionApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }
// End Phase E selected paid starter departure pairing.

// Phase E: Seeker SHARDS paired JVM acceptance; no APK or device task.
tasks.withType<Test>().configureEach {
    if (name != "pairedSeekerShardsApiTest") exclude("**/SeekerShardsApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedSeekerShardsApiTest") {
    group = "verification"
    description = "Pairs the native SHARDS tax claim with the fixture Fastify API and ledger (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/SeekerShardsApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val root = System.getenv("PHASE_E_API_ROOT")?.let(::File)
        require(root?.resolve("apps/api/test/fixtures/nativeSeekerShardsClaimsApiFixture.ts")?.isFile == true) {
            "PHASE_E_API_ROOT must contain nativeSeekerShardsClaimsApiFixture.ts"
        }
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank()) {
            "PHASE_E_NATIVE_TEST_DATABASE_URL must name a disposable loopback phase_e_native_*_test database"
        }
    }
} }
// End Phase E Seeker SHARDS paired JVM acceptance.

// Phase E: explicit Charter JVM/API fixture; ordinary units never start its controller or database.
tasks.withType<Test>().configureEach {
    if (name != "pairedCharterApiTest") exclude("**/CharterApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedCharterApiTest") {
    group = "verification"
    description = "Pairs native Charter creation and two-party sale recovery with the root-owned fixture API (JVM only)."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/CharterApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_CHARTER_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null) {
            "PHASE_E_CHARTER_PAIR_URL must identify the root-owned private loopback controller"
        }
        require(!System.getenv("PHASE_E_CHARTER_PAIR_TOKEN").isNullOrBlank()) {
            "The private Charter fixture controller must supply an authentication token"
        }
    }
} }
// End Phase E explicit Charter JVM/API fixture.

// Phase E: explicit tournament JVM/API fixture; root alone owns its database and clock.
tasks.withType<Test>().configureEach {
    if (name != "pairedTournamentApiTest") exclude("**/TournamentApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedTournamentApiTest") {
    group = "verification"
    description = "Pairs native Charter tournament entry, raid, prize and lock recovery with the root-owned fixture API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/TournamentApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_TOURNAMENT_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null) {
            "PHASE_E_TOURNAMENT_PAIR_URL must identify the root-owned private loopback controller"
        }
        require(!System.getenv("PHASE_E_TOURNAMENT_PAIR_TOKEN").isNullOrBlank()) {
            "The private tournament fixture controller must supply an authentication token"
        }
    }
} }
// End Phase E explicit tournament JVM/API fixture.
// Explicit root-owned ordinary vehicle JVM/API fixture. Never part of default unit tests.
tasks.withType<Test>().configureEach {
    if (name != "pairedVehicleApiTest") exclude("**/VehicleApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedVehicleApiTest") {
    group = "verification"
    description = "Pairs native installation, service, dispatch and original recovery with the root-owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/VehicleApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_VEHICLE_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        require(!System.getenv("PHASE_E_VEHICLE_PAIR_TOKEN").isNullOrBlank())
    }
} }
// D183: explicit root-owned ordinary route catalogue pair, excluded from normal CPU tests.
tasks.withType<Test>().configureEach {
    if (name != "pairedOrdinaryRouteApiTest") exclude("**/OrdinaryRouteApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedOrdinaryRouteApiTest") {
    group = "verification"
    description = "Pairs native v2 route dispatch, return and v1 recovery with the root-owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/OrdinaryRouteApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_ORDINARY_ROUTE_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        require(!System.getenv("PHASE_E_ORDINARY_ROUTE_PAIR_TOKEN").isNullOrBlank())
    }
} }
// D184: explicit root-owned Divine individual trial pair, excluded from normal CPU tests.
tasks.withType<Test>().configureEach {
    if (name != "pairedDivineTrialApiTest") exclude("**/DivineTrialApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedDivineTrialApiTest") {
    group = "verification"
    description = "Pairs native fixed-army trial submission and original prize recovery with the root-owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/DivineTrialApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_DIVINE_TRIAL_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        require(!System.getenv("PHASE_E_DIVINE_TRIAL_PAIR_TOKEN").isNullOrBlank())
    }
} }
// D188: explicit root-owned ordinary equipment pair; never an ordinary unit/API runner.
tasks.withType<Test>().configureEach {
    if (name != "pairedEquipmentApiTest") exclude("**/EquipmentApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedEquipmentApiTest") {
    group = "verification"
    description = "Pairs native Compass craft, fitted departures and original recovery with the root-owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/EquipmentApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_EQUIPMENT_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        require(!System.getenv("PHASE_E_EQUIPMENT_PAIR_TOKEN").isNullOrBlank())
    }
} }

// D189: explicit root-owned Survey Lens pair; never an ordinary unit/API runner.
tasks.withType<Test>().configureEach {
    if (name != "pairedSurveyLensApiTest") exclude("**/SurveyLensApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedSurveyLensApiTest") {
    group = "verification"
    description = "Pairs native Survey Lens craft, fitted departures and original recovery with the root-owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/SurveyLensApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_SURVEY_LENS_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        require(!System.getenv("PHASE_E_SURVEY_LENS_PAIR_TOKEN").isNullOrBlank())
    }
} }

// Explicit owned KEEP equipment JVM/API pair; excluded from normal unit tests.
tasks.withType<Test>().configureEach {
    if (name != "pairedKeepEquipmentMarketApiTest") exclude("**/KeepEquipmentMarketApiPairTest*")
}
afterEvaluate { tasks.register<Test>("pairedKeepEquipmentMarketApiTest") {
    group = "verification"
    description = "Pairs native KEEP equipment custody and recovery with the owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/KeepEquipmentMarketApiPairTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_KEEP_MARKET_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        require(!System.getenv("PHASE_E_KEEP_MARKET_PAIR_TOKEN").isNullOrBlank())
    }
} }

// D192: explicit owned native fragment/API pair, excluded from normal JVM suites.
tasks.withType<Test>().configureEach {
    if (name != "pairedDivineFragmentApiTest") exclude("**/DivineFragmentApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedDivineFragmentApiTest") {
    group = "verification"
    description = "Pairs native earned fragment delivery and permanent spot recovery with the owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/DivineFragmentApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_DIVINE_FRAGMENT_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        val token = System.getenv("PHASE_E_DIVINE_FRAGMENT_PAIR_TOKEN")
        require(!token.isNullOrBlank() && token.length <= 256 && token.all { it.code in 33..126 })
    }
} }

// D193: original clan delivery and cumulative Seeker top-up against the owned API.
tasks.withType<Test>().configureEach {
    if (name != "pairedClanDivineFragmentApiTest") exclude("**/ClanDivineFragmentApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedClanDivineFragmentApiTest") {
    group = "verification"
    description = "Pairs native clan fragment delivery and original Seeker top-up with the owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/ClanDivineFragmentApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_DIVINE_CLAN_FRAGMENT_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        val token = System.getenv("PHASE_E_DIVINE_CLAN_FRAGMENT_PAIR_TOKEN")
        require(!token.isNullOrBlank() && token.length <= 256 && token.all { it.code in 33..126 })
    }
} }

// D194: earned crafting stock through native KEEP purchase and original recovery.
tasks.withType<Test>().configureEach {
    if (name != "pairedKeepCraftingMarketApiTest") exclude("**/KeepCraftingMarketApiPairTest*")
}
afterEvaluate { tasks.register<Test>("pairedKeepCraftingMarketApiTest") {
    group = "verification"
    description = "Pairs native crafting-goods payment, delivery and recovery with the owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/KeepCraftingMarketApiPairTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_KEEP_CRAFTING_MARKET_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        val token = System.getenv("PHASE_E_KEEP_CRAFTING_MARKET_PAIR_TOKEN")
        require(!token.isNullOrBlank() && token.length <= 256 && token.all { it.code in 33..126 })
    }
} }

// D195: earned protected fragments through native KEEP purchase and original recovery.
tasks.withType<Test>().configureEach {
    if (name != "pairedKeepFragmentMarketApiTest") exclude("**/KeepFragmentMarketApiPairTest*")
}
afterEvaluate { tasks.register<Test>("pairedKeepFragmentMarketApiTest") {
    group = "verification"
    description = "Pairs native fragment payment, delivery and recovery with the owned API."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/KeepFragmentMarketApiPairTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        val endpoint = System.getenv("PHASE_E_KEEP_FRAGMENT_MARKET_PAIR_URL")?.let(URI::create)
        require(endpoint?.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.path == "/" && endpoint.rawUserInfo == null && endpoint.query == null && endpoint.fragment == null)
        val token = System.getenv("PHASE_E_KEEP_FRAGMENT_MARKET_PAIR_TOKEN")
        require(!token.isNullOrBlank() && token.length <= 256 && token.all { it.code in 33..126 })
    }
} }

// D153.199: real authenticated resource commitment and durable original recovery.
tasks.withType<Test>().configureEach {
    if (name != "pairedMiningContributionApiTest") exclude("**/MiningContributionApiPairedTest*")
}
afterEvaluate { tasks.register<Test>("pairedMiningContributionApiTest") {
    group = "verification"
    description = "Pairs native mining contributions with disposable authenticated API custody."
    val unit = tasks.named<Test>("testDebugUnitTest").get()
    dependsOn(unit.taskDependencies.getDependencies(unit))
    testClassesDirs = unit.testClassesDirs
    classpath = unit.classpath
    include("**/MiningContributionApiPairedTest.class")
    maxParallelForks = 1
    outputs.upToDateWhen { false }
    doFirst {
        require(!System.getenv("PHASE_E_API_ROOT").isNullOrBlank())
        require(!System.getenv("PHASE_E_NATIVE_TEST_DATABASE_URL").isNullOrBlank())
    }
} }
