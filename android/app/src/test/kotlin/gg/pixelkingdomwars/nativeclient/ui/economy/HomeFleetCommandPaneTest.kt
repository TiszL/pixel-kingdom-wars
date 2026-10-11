package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.roundToInt

/** N-C5 GAMEPLAY UI-A/R1: the production root/pane seams — selection, the captured opening, the one starter driver, focus handoff,
 *  Back order and the bounded keyboard-aware layout — exercised as the pane/root use them (no Compose mount; Android stays unverified). */
class HomeFleetCommandPaneTest {
    // WHY: a receipt request must never fall through to a live form or invoke it before the root handoff.
    @Test fun `entry callbacks are selected without running and keep history separate from live controls`() {
        val calls = mutableListOf<String>()
        val owner = FleetCommandOwner(FleetCommandDestination.VEHICLES, true, false,
            open = { calls += "ordinary" }, close = {}, openHistory = { calls += "history" },
            openEntry = { calls += "live:$it" }, openHistoryEntry = { calls += "history:$it" }, form = {})
        val controls = owner.entryOpening("LODGE", historyOnly = false)
        val receipts = owner.entryOpening("BERTH", historyOnly = true)
        assertTrue(calls.isEmpty())
        requireNotNull(receipts).invoke()
        assertEquals(listOf("history:BERTH"), calls)
        requireNotNull(controls).invoke()
        assertEquals(listOf("history:BERTH", "live:LODGE"), calls)
        requireNotNull(owner.entryOpening(null, historyOnly = false)).invoke()
        requireNotNull(owner.entryOpening(null, historyOnly = true)).invoke()
        assertEquals(listOf("history:BERTH", "live:LODGE", "ordinary", "history"), calls)
    }

    @Test fun `a missing entry history callback refuses even when ordinary and generic history callbacks exist`() {
        var calls = 0
        val owner = FleetCommandOwner(FleetCommandDestination.VEHICLES, true, false,
            open = { calls++ }, close = {}, openHistory = { calls++ }, openEntry = { calls++ }, form = {})
        assertNull(owner.entryOpening("BERTH", historyOnly = true))
        assertEquals(0, calls)
        val legacy = FleetCommandOwner(FleetCommandDestination.STARTER, true, false,
            open = { calls++ }, close = {}, form = {})
        assertNull(legacy.entryOpening("LODGE", historyOnly = false))
        assertNull(legacy.entryOpening("LODGE", historyOnly = true))
        assertNull(legacy.entryOpening(null, historyOnly = true))
        assertEquals(0, calls)
    }

    private class Fake(val destination: FleetCommandDestination, var isOpen: Boolean) {
        var closed = 0; var opened = 0
        val owner get() = FleetCommandOwner(destination, available = true, isOpen = isOpen, open = { opened += 1 }, close = { closed += 1 }, form = {})
    }
    private fun owners(vararg fakes: Fake) = FleetCommandOwners(fakes.map { it.owner })

    @Test fun `one current form - earliest destination when owners disagree, none when nothing is open`() {
        assertNull(fleetCommandDestination(emptyList()))
        assertEquals(FleetCommandDestination.VEHICLES, fleetCommandDestination(listOf(FleetCommandDestination.VEHICLES)))
        assertEquals(FleetCommandDestination.PAID_STARTER, fleetCommandDestination(listOf(FleetCommandDestination.EQUIPMENT, FleetCommandDestination.PAID_STARTER)))
    }

    @Test fun `root view shows the open owner's exact form, closes only the others on selection, closes all on pane close`() {
        val starter = Fake(FleetCommandDestination.STARTER, false); val paid = Fake(FleetCommandDestination.PAID_STARTER, true)
        val vehicles = Fake(FleetCommandDestination.VEHICLES, false); val equipment = Fake(FleetCommandDestination.EQUIPMENT, false)
        val root = owners(starter, paid, vehicles, equipment)
        assertEquals(FleetCommandDestination.PAID_STARTER, root.destination())
        assertSame("the shown form is the open owner's own form", root.owners[1].form, root.form())
        root.closeExcept(FleetCommandDestination.VEHICLES)
        assertEquals(listOf(1, 1, 0, 1), listOf(starter.closed, paid.closed, vehicles.closed, equipment.closed))
        root.open(FleetCommandDestination.VEHICLES); assertEquals(1, vehicles.opened); assertEquals(0, starter.opened)
        root.closeAll(); assertEquals(listOf(2, 2, 1, 2), listOf(starter.closed, paid.closed, vehicles.closed, equipment.closed))
        assertNull("nothing open - no form", owners(starter, Fake(FleetCommandDestination.PAID_STARTER, false)).form())
    }

    @Test fun `a captured opening admits only its own session, base generation, content and live lifetime - stale attempts touch nothing`() {
        val session = Any(); val content = Any()
        var current = FleetCommandScopeIdentity(session, 3L, content)
        val lifetime = FleetPresentationLifetime()
        val starter = Fake(FleetCommandDestination.STARTER, true); val vehicles = Fake(FleetCommandDestination.VEHICLES, false)
        lifetime.owners = owners(starter, vehicles)
        var navigated = 0
        val opening = FleetCommandOpening(FleetCommandScopeIdentity(session, 3L, content), lifetime, { current }) { navigated += 1 }
        val open = { opening.attempt(FleetCommandDestination.VEHICLES) } // the exact callback an owner/entry captures
        assertTrue(open()); assertEquals(1, navigated); assertEquals("only the OTHER owners are dismissed", 1, starter.closed); assertEquals(0, vehicles.closed)
        current = FleetCommandScopeIdentity(session, 4L, content) // the selected-base generation moved on
        assertFalse(open()); assertEquals("no navigation", 1, navigated); assertEquals("no owner touched", 1, starter.closed)
        current = FleetCommandScopeIdentity(session, 3L, Any()) // admitted content replaced
        assertFalse(open()); assertEquals(1, navigated)
        val replacement = Fake(FleetCommandDestination.STARTER, true); val fresh = FleetPresentationLifetime(); fresh.owners = owners(replacement)
        current = FleetCommandScopeIdentity(Any(), 3L, content) // session replaced: the replacement lifetime's owners are unreachable
        assertFalse(open()); assertEquals(0, replacement.closed); assertEquals(1, navigated); assertTrue(fresh.active)
        // UI-R2: a REAL transition (stop/start or battle change) advances the lifetime revision; the pre-transition callback stays stale
        // even after eligibility returns, while a callback captured AFTER it is admitted.
        current = FleetCommandScopeIdentity(session, 3L, content); lifetime.advance(); current = current.copy(presentationRevision = lifetime.revision)
        assertFalse("captured before the transition", open()); assertEquals(1, navigated); assertEquals(1, starter.closed)
        val recaptured = FleetCommandOpening(FleetCommandScopeIdentity(session, 3L, content, lifetime.revision), lifetime, { current }) { navigated += 1 }
        assertTrue("captured after the transition", recaptured.attempt(FleetCommandDestination.VEHICLES)); assertEquals(2, navigated)
        lifetime.advance(); lifetime.advance(); current = current.copy(presentationRevision = lifetime.revision) // stop then start: both advance
        assertFalse(recaptured.attempt(FleetCommandDestination.VEHICLES)); assertEquals(2, navigated)
        navigated = 1
        current = FleetCommandScopeIdentity(session, 3L, content, lifetime.revision); lifetime.retire() // the scope composition was disposed
        assertFalse(open()); assertEquals(1, navigated); assertNull(lifetime.owners)
        val none = FleetCommandOpening(FleetCommandScopeIdentity(null, 0L, null), FleetPresentationLifetime(), { FleetCommandScopeIdentity(null, 0L, null) }) { navigated += 1 }
        assertFalse("no session never admits", none.attempt(FleetCommandDestination.STARTER)); assertEquals(1, navigated)
        assertTrue(fleetCommandOpeningAdmitted(FleetCommandScopeIdentity(session, 3L, content), FleetCommandScopeIdentity(session, 3L, content), lifetimeActive = true))
        assertFalse(fleetCommandOpeningAdmitted(FleetCommandScopeIdentity(session, 3L, content), FleetCommandScopeIdentity(session, 3L, content), lifetimeActive = false))
    }

    @Test fun `opening reads live eligibility at invocation - stopped or battle refuses even with a fresh revision, eligible admits`() {
        val session = Any(); val content = Any(); val lifetime = FleetPresentationLifetime()
        val starter = Fake(FleetCommandDestination.STARTER, true); lifetime.owners = owners(starter)
        var started = true; var battle = false; var navigated = 0
        fun current() = FleetCommandScopeIdentity(session, 1L, content, lifetime.revision)
        fun opening() = FleetCommandOpening(current(), lifetime, { current() }, { fleetCommandOpeningEligible(started, battle) }) { navigated += 1 }
        val first = opening()
        // the pre-effect battle gap: battle flips before any revision advance — the live read refuses, nothing is touched
        battle = true; assertFalse(first.attempt(FleetCommandDestination.VEHICLES)); assertEquals(0, navigated); assertEquals(0, starter.closed)
        battle = false; assertTrue(first.attempt(FleetCommandDestination.VEHICLES)); assertEquals(1, navigated); assertEquals(1, starter.closed)
        // background: ON_STOP advanced the revision; a NEW callback captured while still stopped refuses despite its matching revision
        started = false; lifetime.advance(); val whileStopped = opening()
        assertFalse(whileStopped.attempt(FleetCommandDestination.VEHICLES)); assertFalse("old callback stale", first.attempt(FleetCommandDestination.VEHICLES)); assertEquals(1, navigated)
        // resume: ON_START advanced again; the stopped-era callback stays stale, a fresh eligible one admits
        started = true; lifetime.advance()
        assertFalse(whileStopped.attempt(FleetCommandDestination.VEHICLES)); assertFalse(first.attempt(FleetCommandDestination.VEHICLES)); assertEquals(1, navigated)
        assertTrue(opening().attempt(FleetCommandDestination.VEHICLES)); assertEquals(2, navigated)
        // battle active with a fresh matching revision still refuses
        battle = true; lifetime.advance(); assertFalse(opening().attempt(FleetCommandDestination.VEHICLES)); assertEquals(2, navigated)
        assertTrue(fleetCommandOpeningEligible(lifecycleStarted = true, battleActive = false)); assertFalse(fleetCommandOpeningEligible(false, false)); assertFalse(fleetCommandOpeningEligible(true, true))
    }

    @Test fun `unusable layout selects the pane-local recovery - reachable 48dp target in the safe area, Home nonzero, form unplaced, same form restored`() {
        // Portrait 320x400 / font 1.3 / IME 250 / safe-top 24: 126dp of safe space = 48dp Home-visible region + the 48dp HIDE KEYBOARD target
        val portrait = fleetCommandLayout(320, 400, 1.3f, 250, 24); assertFalse(portrait.controlsFit)
        val recovery = requireNotNull(fleetCommandRecovery(portrait, 320, 400, 24, 250, keyboardShown = true))
        assertEquals(FleetCommandRecoveryKind.HIDE_KEYBOARD, recovery.kind); assertFalse(recovery.beside)
        assertEquals(FleetCommandPlacement.RECOVERY, fleetCommandPlacement(recovery))
        assertTrue("Home keeps a usable region", recovery.homeWidthDp == 320 && recovery.homeHeightDp >= FLEET_COMMAND_CONTROL_DP)
        assertEquals(48, recovery.controlHeightDp); assertEquals(320, recovery.controlWidthDp)
        assertTrue("target inside the safe area above the keyboard", recovery.controlYDp >= 24 && recovery.controlYDp + recovery.controlHeightDp <= 400 - 250)
        assertEquals("the control starts where Home ends - nothing overlaps", recovery.homeHeightDp, recovery.controlYDp)
        // Landscape 800x360 / IME 250 / safe-top 24: 86dp safe height - the recovery column sits beside Home
        val landscape = fleetCommandLayout(800, 360, 1f, 250, 24); assertFalse(landscape.controlsFit)
        val beside = requireNotNull(fleetCommandRecovery(landscape, 800, 360, 24, 250, keyboardShown = true))
        assertTrue(beside.beside); assertEquals(640, beside.homeWidthDp); assertEquals(360, beside.homeHeightDp)
        assertEquals(listOf(640, 24, 160, 48), listOf(beside.controlXDp, beside.controlYDp, beside.controlWidthDp, beside.controlHeightDp))
        assertTrue(beside.controlYDp + beside.controlHeightDp <= 360 - 250)
        // Restoration: the keyboard hides - the same inputs now fit, recovery is null and the SAME form is placed again
        val restored = fleetCommandLayout(320, 400, 1.3f, 0, 24); assertTrue(restored.controlsFit)
        assertNull(fleetCommandRecovery(restored, 320, 400, 24, 0, keyboardShown = false)); assertEquals(FleetCommandPlacement.FORM, fleetCommandPlacement(null))
        // Too-small window with NO keyboard: an honest non-command enlarge/close target where it fits...
        val small = fleetCommandLayout(320, 150, 1f, 0, 24); assertFalse(small.controlsFit)
        val enlarge = requireNotNull(fleetCommandRecovery(small, 320, 150, 24, 0, keyboardShown = false))
        assertEquals(FleetCommandRecoveryKind.ENLARGE_OR_CLOSE, enlarge.kind); assertEquals(FleetCommandPlacement.RECOVERY, fleetCommandPlacement(enlarge)); assertTrue(enlarge.homeHeightDp > 0)
        // ...and Home only when no 48dp target physically fits (never a clipped control)
        val tiny = fleetCommandLayout(100, 60, 1f, 0, 24); assertFalse(tiny.controlsFit)
        val none = requireNotNull(fleetCommandRecovery(tiny, 100, 60, 24, 0, keyboardShown = false))
        assertEquals(FleetCommandPlacement.HOME_ONLY, fleetCommandPlacement(none)); assertEquals(0, none.controlHeightDp); assertTrue(none.homeHeightDp > 0)
    }

    @Test fun `one visible starter driver - ordinary form or route wins, paid housekeeps only while ordinary is not visible`() {
        assertEquals(StarterDriver.ORDINARY, starterDriver(ordinaryVisible = true, paidFormVisible = false))
        assertEquals("a paid form left open under a visible ordinary route never drives", StarterDriver.ORDINARY, starterDriver(ordinaryVisible = true, paidFormVisible = true))
        assertEquals(StarterDriver.PAID, starterDriver(ordinaryVisible = false, paidFormVisible = true))
        assertEquals(StarterDriver.NONE, starterDriver(ordinaryVisible = false, paidFormVisible = false))
        assertFalse(paidStarterHousekeeps(StarterDriver.ORDINARY)); assertTrue(paidStarterHousekeeps(StarterDriver.PAID)); assertTrue(paidStarterHousekeeps(StarterDriver.NONE))
    }

    @Test fun `focus returns to Home exactly when a shown form closes - not on open, switch or repeated closed states`() {
        val handoff = FleetCommandFocusHandoff()
        assertFalse(handoff.transition(null)); assertFalse(handoff.transition(FleetCommandDestination.VEHICLES))
        assertFalse("switching forms keeps focus in the pane", handoff.transition(FleetCommandDestination.EQUIPMENT))
        assertTrue("header close or Back", handoff.transition(null)); assertFalse(handoff.transition(null))
        assertFalse(handoff.transition(FleetCommandDestination.STARTER)); assertTrue(handoff.transition(null))
    }

    @Test fun `review dismissal outranks pane close, which outranks Home`() {
        assertEquals(BackPriority.CONFIRM, fleetCommandBackPriority(reviewOpen = true))
        assertEquals(BackPriority.SHEET, fleetCommandBackPriority(reviewOpen = false))
        assertTrue(fleetCommandBackPriority(false) > BackPriority.SCREEN && BackPriority.SCREEN > BackPriority.HOME)
    }

    @Test fun `bounded layout sizes the real body viewport from unconsumed insets in both orientations and never fakes a fitting row`() {
        val chrome = FLEET_COMMAND_PAGE_HEADER_DP + FLEET_COMMAND_PAGE_BODY_PADDING_DP
        fun check(layout: FleetCommandLayout, total: Int, bottom: Int, top: Int, label: String) {
            assertTrue("$label home nonzero", layout.homeDp > 0); assertTrue("$label form nonzero", layout.formDp > 0)
            assertEquals("$label regions tile the axis exactly", total, layout.homeDp + layout.formDp)
            if (!layout.sideBySide) {
                assertEquals("$label the form region alone carries the bottom inset", bottom, layout.formDp - layout.usableFormDp)
                assertEquals("$label body = usable - top inset - header - padding", (layout.usableFormDp - top - chrome).coerceAtLeast(0), layout.bodyViewportDp)
            }
            assertEquals("$label controlsFit is the honest 48dp test", layout.bodyViewportDp >= FLEET_COMMAND_CONTROL_DP, layout.controlsFit)
        }
        val phone = fleetCommandLayout(360, 780, 1f, 0, 0); check(phone, 780, 0, 0, "phone")
        assertFalse(phone.sideBySide); assertTrue(phone.homeDp >= FLEET_COMMAND_HOME_MIN_DP); assertTrue(phone.controlsFit)
        val keyboard = fleetCommandLayout(360, 780, 1f, 300, 24); check(keyboard, 780, 300, 24, "keyboard+safe-top")
        assertTrue("three rows still fit above the keyboard", keyboard.bodyViewportDp >= 3 * FLEET_COMMAND_CONTROL_DP); assertTrue(keyboard.homeDp >= FLEET_COMMAND_HOME_MIN_DP)
        val largeFont = fleetCommandLayout(360, 780, 1.6f, 0, 24); check(largeFont, 780, 0, 24, "large font"); assertTrue(largeFont.controlsFit)
        val constrained = fleetCommandLayout(320, 400, 1.3f, 250, 24); check(constrained, 400, 250, 24, "constrained")
        assertTrue("Home stays a visible strip", constrained.homeDp > 0 && constrained.homeDp < FLEET_COMMAND_HOME_MIN_DP)
        assertFalse("320x400 / font 1.3 / IME 250 / safe-top 24 cannot fit a 48dp row - say so", constrained.controlsFit)
        assertTrue(constrained.bodyViewportDp < FLEET_COMMAND_CONTROL_DP)
        val landscapeIme = fleetCommandLayout(800, 360, 1f, 200, 24); check(landscapeIme, 800, 200, 24, "landscape+ime")
        assertTrue(landscapeIme.sideBySide); assertEquals("side by side: width split is unchanged by the keyboard", landscapeIme.formDp, landscapeIme.usableFormDp)
        assertEquals("landscape body comes from HEIGHT minus insets and chrome", 360 - 200 - 24 - chrome, landscapeIme.bodyViewportDp); assertTrue(landscapeIme.controlsFit)
        val landscapeTall = fleetCommandLayout(800, 360, 1f, 250, 24); assertFalse("a wide window cannot certify height", landscapeTall.controlsFit)
        val narrowLandscape = fleetCommandLayout(560, 360, 1f, 0, 24); assertFalse("below 600dp stays stacked", narrowLandscape.sideBySide); check(narrowLandscape, 360, 0, 24, "narrow landscape")
        val tablet = fleetCommandLayout(840, 1200, 1f, 0, 24); assertFalse(tablet.sideBySide); check(tablet, 1200, 0, 24, "tablet portrait"); assertTrue(tablet.controlsFit)
        assertEquals(48, FLEET_COMMAND_CONTROL_DP)
    }
}
