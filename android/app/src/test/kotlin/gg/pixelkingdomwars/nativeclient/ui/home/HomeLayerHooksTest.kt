package gg.pixelkingdomwars.nativeclient.ui.home

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MS-C3 mount contract §2 (HomeScaffold.kt `HomeLayerHooks` / `homeLayerHost`). Why it matters: the legacy Home must not
 * change until C3's typed host mounts; a typed host must start with resources blocked (a balance tap must not open the
 * drawer under a review or a Seal); exactly one resource stack may be painted (two would disagree mid count-up and
 * double the hit region); and the overlay must sit in one finite viewport with the system insets applied once, under
 * the required update screen, with no transparent full-screen pointer root that would eat taps meant for the kingdom.
 */
class HomeLayerHooksTest {
    private val scaffold = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt").readText()

    @Test fun `the legacy host keeps the old mount and typed hosts start blocked`() {
        assertFalse(LegacyHomeLayerHooks.homeCovered)
        assertFalse("legacy resources stay tappable", LegacyHomeLayerHooks.resourcesBlocked)
        assertFalse("legacy has no overlay", LegacyHomeLayerHooks.hasOverlay)
        assertTrue("typed hooks are blocked by default", HomeLayerHooks().resourcesBlocked)
        assertFalse(HomeLayerHooks().homeCovered)
        assertFalse(HomeLayerHooks().hasOverlay)
        assertTrue(scaffold.contains("homeLayerHost: HomeLayerHost = { _, layer -> layer(LegacyHomeLayerHooks) },"))
    }

    @Test fun `the stack is lifted only over a real overlay, with the HUD drawn and nothing of its own over its corner`() {
        assertTrue(homeStackLifted(overlay = true, hudShown = true, drawerOpen = false, menuOpen = false))
        assertFalse("legacy: no overlay to rise above, the HUD keeps its stack", homeStackLifted(false, true, false, false))
        assertFalse("no Kingdom HUD on this tab", homeStackLifted(true, false, false, false))
        assertFalse("the HUD's resource drawer paints over the stack", homeStackLifted(true, true, true, false))
        assertFalse("the MENU panel paints over the stack", homeStackLifted(true, true, false, true))
    }

    @Test fun `exactly one resource stack is painted in every state`() {
        val flags = listOf(false, true)
        for (overlay in flags) for (hud in flags) for (drawer in flags) for (menu in flags) {
            val lifted = homeStackLifted(overlay, hud, drawer, menu)
            val hudStack = if (hud && !lifted) 1 else 0 // HomeHud(stackLifted = lifted) skips its own when lifted
            val liftedStack = if (lifted) 1 else 0
            assertEquals("overlay=$overlay hud=$hud drawer=$drawer menu=$menu", if (hud) 1 else 0, hudStack + liftedStack)
        }
        assertEquals(1, Regex("HomeResourceStack\\(").findAll(scaffold).count())
        assertTrue(scaffold.contains("sealShown = hooks.resourcesBlocked || armySheetOpen, stackLifted = lifted,"))
        assertTrue(scaffold.contains("if (lifted) liftedHud = hudUi to hudOn"))
        assertTrue("identical ui/actions, above the overlay, blocked with the host",
            scaffold.contains("HomeResourceStack(ui, on, Modifier.zIndex(PkwTokens.Z.RESOURCE_STACK), sealShown = hooks.resourcesBlocked || armySheetOpen)"))
    }

    // Composables do not run on the JVM; these pin the mount the contract fixes.
    @Test fun `the host is called once with the actual tab, inside the one SceneInputScope, around the Home root`() {
        assertEquals(1, Regex("homeLayerHost\\(").findAll(scaffold).count())
        val scope = scaffold.indexOf("gg.pixelkingdomwars.nativeclient.scene.SceneInputScope {")
        val host = scaffold.indexOf("homeLayerHost(tab) { hooks ->")
        val root = scaffold.indexOf("BoxWithConstraints(Modifier.fillMaxSize().background(Palette.backdrop)")
        assertTrue(scope in 0 until host && host < root)
    }

    @Test fun `the overlay is one finite once-inset layout root under the update screen, with no pointer root`() {
        val overlay = scaffold.lines().single { "content = hooks.overlay" in it }.trim()
        assertEquals("Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), content = hooks.overlay)", overlay)
        // Hub mount: the required update is the designed NativeUpdateGate (drop-in for NativeUpdateScreen), still drawn last.
        val group = scaffold.substring(scaffold.indexOf("var liftedHud"), scaffold.indexOf("NativeUpdateGate()"))
        assertTrue("the overlay and the lifted stack sit inside the Home group, before the update screen",
            "content = hooks.overlay" in group && "HomeResourceStack(" in group)
        assertTrue("the Home group root is a plain layout (it only scopes zIndex)", group.lines().any { it.trim() == "Box(Modifier.fillMaxSize()) {" })
        assertTrue("covered Home leaves the semantics tree, without a geometry change or a pointer root",
            scaffold.contains("Box(Modifier.fillMaxSize().then(if (hooks.homeCovered) Modifier.clearAndSetSemantics {} else Modifier)) {"))
    }
}
