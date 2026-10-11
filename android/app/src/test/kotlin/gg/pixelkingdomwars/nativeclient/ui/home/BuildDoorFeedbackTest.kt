package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import org.junit.Assert.*
import org.junit.Test

class BuildDoorFeedbackTest {
    private data class Facts(val saved: Boolean = false, val busy: Boolean = false, val base: Boolean = true,
        val deed: Boolean = true, val known: Boolean = true, val raid: Boolean = false, val orders: Boolean = true) {
        val enabled get() = !busy && base && !saved && deed
        val readOnly get() = !orders || !deed
        fun reason() = homeBuildRefusalReason(saved, busy, base, deed, known, raid, orders)
    }
    private fun dispatch(f: Facts): Pair<List<HomeRequest>, List<String>> {
        val requests = mutableListOf<HomeRequest>(); val feedback = mutableListOf<String>()
        dispatchHomeBuildDoor(f.enabled, f.readOnly, f.reason(), { requests += HomeRequest.BuildMenu }, feedback::add)
        return requests to feedback
    }

    @Test fun `an admitted tap opens BUILD exactly once without feedback`() {
        // This navigation must not become a new admission or transaction owner.
        val (requests, feedback) = dispatch(Facts())
        assertEquals(listOf(HomeRequest.BuildMenu), requests); assertTrue(feedback.isEmpty())
    }

    @Test fun `each refused door says how to continue and never queues BUILD`() {
        // The visible green button must explain the same refusal that previously swallowed the tap.
        val cases = listOf(
            // Rewritten 2026-10-06 (owner field result, build 607a9c37): the old 84-character sentence was cut in the two-line
            // toast; the refusal still points at the saved request's card, in a sentence that fits.
            Facts(saved = true) to "Check the saved request on its card below your kingdom name.",
            Facts(busy = true) to "Your kingdom is updating. Wait, then try BUILD again.",
            Facts(base = false) to "Your kingdom is updating. Wait, then try BUILD again.",
            Facts(deed = false, known = false) to "Raid status is unavailable. Wait for your kingdom to reconnect, then try BUILD again.",
            Facts(deed = false, raid = true) to Copy.ACTIVE_RAID_MESSAGE,
            Facts(deed = false) to "This base is read-only. Open an available kingdom from your bases.",
            Facts(orders = false) to "Install the available native app update before submitting game orders. Your account is preserved.",
        )
        for ((facts, sentence) in cases) {
            val (requests, feedback) = dispatch(facts)
            assertTrue(requests.isEmpty()); assertEquals(listOf(sentence), feedback)
        }
    }

    @Test fun `saved payment then updating then deed then update wins overlapping refusals`() {
        // 5066e276 chooses a useful recovery-first reason without changing Boolean gate admission.
        assertEquals(Facts(saved = true).reason(), Facts(saved = true, busy = true, deed = false, orders = false).reason())
        assertEquals(Facts(busy = true).reason(), Facts(busy = true, deed = false, orders = false).reason())
        assertEquals(Facts(deed = false, raid = true).reason(), Facts(deed = false, known = false, raid = true, orders = false).reason())
        assertEquals(Facts(deed = false).reason(), Facts(deed = false, orders = false).reason())
    }

    @Test fun `feedback preserves every combination of the existing gates`() {
        // Inconsistent observation snapshots must not make the new reason grant or deny admission.
        for (saved in listOf(false, true)) for (busy in listOf(false, true)) for (base in listOf(false, true))
            for (deed in listOf(false, true)) for (known in listOf(false, true)) for (raid in listOf(false, true))
                for (orders in listOf(false, true)) {
                    val f = Facts(saved, busy, base, deed, known, raid, orders)
                    val allowed = f.enabled && !f.readOnly
                    val (requests, feedback) = dispatch(f)
                    assertEquals(if (allowed) 1 else 0, requests.size)
                    assertEquals(if (allowed) 0 else 1, feedback.size)
                    assertEquals(allowed, f.reason() == null)
                }
    }

    @Test fun `legacy callers still refuse visibly if they omit the new optional reason`() {
        // Optional mount metadata must not weaken an existing gate or silently drop a refused tap.
        var opened = 0; val feedback = mutableListOf<String>()
        dispatchHomeBuildDoor(false, false, null, { opened++ }, feedback::add)
        dispatchHomeBuildDoor(true, true, null, { opened++ }, feedback::add)
        assertEquals(0, opened); assertEquals(2, feedback.size); assertTrue(feedback.all { it.isNotBlank() })
        dispatchHomeBuildDoor(true, false, "stale reason", { opened++ }, feedback::add)
        assertEquals(1, opened); assertEquals(2, feedback.size)
    }

    @Test fun `only BUILD receives the same refusal state description and the other controls stay intact`() {
        // Assistive technology must hear the reason while the control remains a tappable explanation.
        val original = homeHudState(BaseState(), null, 0, false, 0, 0, selectionOpen = false)
        val reason = Facts(saved = true).reason()
        val described = homeHudWithBuildRefusal(original, reason)
        assertEquals(reason, described.deck.single { it.id == HudIds.BUILD }.stateDescription)
        for (button in original.deck.filter { it.id != HudIds.BUILD }) assertSame(button, described.deck.single { it.id == button.id })
        assertNull(homeHudWithBuildRefusal(original, null).deck.single { it.id == HudIds.BUILD }.stateDescription)
    }

    @Test fun `the production mount supplies the reason to tap feedback and the cleared button semantics`() {
        // ChunkyBox clears semantics; annotating an outer container would lose the reason on the actual button.
        fun source(path: String) = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
        val mount = source("ui/home/HomeScaffold.kt")
        assertTrue(mount.contains("dispatchHomeBuildDoor(buildEnabled, buildReadOnly, buildRefusalReason"))
        assertTrue(mount.contains("homeHudWithBuildRefusal("))
        assertTrue(source("ui/nav/PkwApp.kt").contains("buildRefusalReason = homeBuildRefusalReason("))
        assertTrue(source("ui/hud/HomeHud.kt").contains("stateDescription = ui.stateDescription"))
        val semantics = source("ui/kit/GameButton.kt").substringAfter(".clearAndSetSemantics {").substringBefore(".then(")
        assertTrue(semantics.contains("this.stateDescription = stateDescription"))
        assertTrue(semantics.contains("if (enabled) onClick(); enabled"))
    }
}
