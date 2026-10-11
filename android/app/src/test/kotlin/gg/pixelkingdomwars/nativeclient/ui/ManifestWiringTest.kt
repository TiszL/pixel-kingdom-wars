package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.AppGraph
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

/** The Privy OAuth callback only works when the manifest scheme, the dashboard's allowed scheme and the
 * scheme handed to the SDK agree; adding HTTPS App Links must retain the launcher identity and OAuth owner. */
class ManifestWiringTest {
    private val ns = "http://schemas.android.com/apk/res/android"
    private val activities = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
        .parse(File("src/main/AndroidManifest.xml")).documentElement.getElementsByTagName("activity").let { list -> (0 until list.length).map { list.item(it) as Element } }
    private fun Element.attr(name: String) = getAttributeNS(ns, name)
    private fun Element.children(tag: String) = getElementsByTagName(tag).let { l -> (0 until l.length).map { l.item(it) as Element } }

    @Test fun `the Privy redirect activity is exported, singleTask and filters exactly the SDK scheme`() {
        val redirect = activities.single { it.attr("name") == "io.privy.sdk.oAuth.PrivyRedirectActivity" }
        assertEquals("true", redirect.attr("exported")); assertEquals("singleTask", redirect.attr("launchMode"))
        val filter = redirect.children("intent-filter").single()
        assertEquals(listOf("android.intent.action.VIEW"), filter.children("action").map { it.attr("name") })
        assertEquals(setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"), filter.children("category").map { it.attr("name") }.toSet())
        val data = filter.children("data").single()
        assertEquals(AppGraph.PRIVY_APP_URL_SCHEME, data.attr("scheme"))
        assertTrue("A custom scheme carries no host or path", data.attr("host").isEmpty() && data.attr("path").isEmpty())
    }
    @Test fun `HTTPS game links preserve the launcher identity and separate OAuth owner`() {
        val main = activities.single { it.attr("name") == ".MainActivity" }
        assertEquals("true", main.attr("exported")); assertEquals("singleTop", main.attr("launchMode"))
        val filter = main.children("intent-filter").single { candidate ->
            candidate.children("action").any { it.attr("name") == "android.intent.action.MAIN" }
        }
        assertEquals(listOf("android.intent.action.MAIN"), filter.children("action").map { it.attr("name") })
        assertEquals(listOf("android.intent.category.LAUNCHER"), filter.children("category").map { it.attr("name") })
        assertTrue(filter.children("data").isEmpty())
        assertTrue("Game links cannot capture the wallet callback", main.children("data").none { it.attr("scheme") == AppGraph.PRIVY_APP_URL_SCHEME })
        assertEquals("Only the redirect activity claims the scheme", 1, activities.count { a -> a.children("data").any { it.attr("scheme") == AppGraph.PRIVY_APP_URL_SCHEME } })
    }
    // Owner 2026-10-06 16:53: the game follows the phone's rotation (fullUser) — the owner demos over scrcpy in landscape.
    // The morning's portrait lock (N-046, after the landscape Clan cut-off) removed landscape altogether; the landscape
    // sheet layouts are fixed on their own (K-night-A11). The runtime request in DeviceExperience says the same, or one
    // resume would undo the manifest (see DeviceExperienceTest).
    @Test fun `the game activity follows the user's rotation in every orientation`() {
        val main = activities.single { it.attr("name") == ".MainActivity" }
        assertEquals("fullUser", main.attr("screenOrientation"))
    }
    @Test fun `game code reaches Privy only through the wallet module's PrivySurface`() {
        // privy-core is `api` from :wallet only so the manifest's PrivyRedirectActivity resolves (wallet/build.gradle.kts).
        // The SDK's login, signing, MFA and session rules live behind PrivySurface / PrivyWalletAdapter and their tests;
        // a direct io.privy call in :app would bypass every one of them.
        val offenders = File("src/main/kotlin").walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            file.readLines().withIndex().filter { (_, line) -> "io.privy" in line && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") }
                .map { (index, _) -> "${file.path}:${index + 1}" }
        }.toList()
        assertEquals(emptyList<String>(), offenders)
    }
}
