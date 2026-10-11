package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import org.junit.Assert.*
import org.junit.Test

/** Pure host contracts against Opus-owned types; no scene lifetime or Compose execution is claimed. */
class SheetHostTest {
    private val scope = SheetScope("session-generation-1", "base-1", 3)

    @Test fun `portrait half is bottom anchored with at most half the available height and no scrim`() {
        val layout = sheetHostLayout(SheetSize.HALF, 412f, 915f)
        assertEquals(SheetHostPlacement.BOTTOM, layout.placement)
        assertEquals(412f, layout.widthDp, 0f)
        assertEquals(457.5f, layout.maxHeightDp, 0f)
        assertEquals(0f, layout.topInsetDp, 0f)
        assertEquals(0f, layout.bottomInsetDp, 0f)
        assertEquals(0f, layout.scrimAlpha, 0f)
    }

    @Test fun `portrait tall reserves the 104dp resource header and paints the 40 percent scrim`() {
        val layout = sheetHostLayout(SheetSize.TALL, 412f, 915f)
        assertEquals(SheetHostPlacement.BOTTOM, layout.placement)
        assertEquals(412f, layout.widthDp, 0f)
        assertEquals(104f, layout.topInsetDp, 0f)
        assertEquals(811f, layout.maxHeightDp, 0f)
        assertEquals(0.40f, layout.scrimAlpha, 0f)
    }

    @Test fun `portrait full card keeps 8dp side gutters and resource header above the 60 percent scrim`() {
        val layout = sheetHostLayout(SheetSize.FULL, 412f, 915f)
        assertEquals(SheetHostPlacement.CENTER, layout.placement)
        assertEquals(396f, layout.widthDp, 0f)
        assertEquals(60f, layout.topInsetDp, 0f)
        assertEquals(14f, layout.bottomInsetDp, 0f)
        assertEquals(841f, layout.maxHeightDp, 0f)
        assertEquals(0.60f, layout.scrimAlpha, 0f)
    }

    @Test fun `landscape half and tall are end panels at the lesser of 480dp or half the viewport`() {
        for (size in listOf(SheetSize.HALF, SheetSize.TALL)) {
            val phone = sheetHostLayout(size, 915f, 412f)
            assertEquals(SheetHostPlacement.END, phone.placement)
            assertEquals(457.5f, phone.widthDp, 0f)
            assertEquals(412f, phone.maxHeightDp, 0f)
            assertEquals(0f, phone.topInsetDp, 0f)
            assertEquals(0f, phone.bottomInsetDp, 0f)
            val wide = sheetHostLayout(size, 1600f, 800f)
            assertEquals(480f, wide.widthDp, 0f)
        }
        assertEquals(0f, sheetHostLayout(SheetSize.HALF, 915f, 412f).scrimAlpha, 0f)
        assertEquals(0.40f, sheetHostLayout(SheetSize.TALL, 915f, 412f).scrimAlpha, 0f)
    }

    @Test fun `landscape full card is centered at most 720dp within an 8dp outer gutter`() {
        // review 092decf3 supersedes the original all-sides 8dp draft: FULL uses 60dp above and 14dp below.
        val wide = sheetHostLayout(SheetSize.FULL, 915f, 412f)
        assertEquals(SheetHostPlacement.CENTER, wide.placement)
        assertEquals(720f, wide.widthDp, 0f)
        assertEquals(60f, wide.topInsetDp, 0f)
        assertEquals(14f, wide.bottomInsetDp, 0f)
        assertEquals(338f, wide.maxHeightDp, 0f)
        assertEquals(0.60f, wide.scrimAlpha, 0f)
        assertEquals(584f, sheetHostLayout(SheetSize.FULL, 600f, 360f).widthDp, 0f)
    }

    @Test fun `a square viewport follows the portrait layout`() {
        assertEquals(SheetHostPlacement.BOTTOM, sheetHostLayout(SheetSize.HALF, 600f, 600f).placement)
        assertEquals(300f, sheetHostLayout(SheetSize.HALF, 600f, 600f).maxHeightDp, 0f)
        assertEquals(104f, sheetHostLayout(SheetSize.TALL, 600f, 600f).topInsetDp, 0f)
    }

    @Test fun `every sheet clips dimensions and insets to a tiny or empty available viewport`() {
        for (size in SheetSize.entries) {
            for ((width, height) in listOf(0f to 0f, 10f to 20f, 20f to 10f, 60f to 80f, 80f to 60f)) {
                val layout = sheetHostLayout(size, width, height)
                assertTrue("$size $width x $height width", layout.widthDp in 0f..width)
                assertTrue("$size $width x $height height", layout.maxHeightDp in 0f..height)
                assertTrue(layout.topInsetDp >= 0f)
                assertTrue(layout.bottomInsetDp >= 0f)
                assertTrue(layout.topInsetDp + layout.maxHeightDp + layout.bottomInsetDp <= height)
            }
        }
    }

    @Test fun `invalid viewport numbers are refused before creating Compose constraints`() {
        for (invalid in listOf(-1f, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertThrows(IllegalArgumentException::class.java) { sheetHostLayout(SheetSize.TALL, invalid, 915f) }
            assertThrows(IllegalArgumentException::class.java) { sheetHostLayout(SheetSize.TALL, 412f, invalid) }
        }
    }

    @Test fun `ordinary half motion uses 180ms enter and 140ms exit`() {
        val motion = sheetHostMotion(SheetSize.HALF, reducedMotion = false)
        assertEquals(180, motion.enterMs)
        assertEquals(140, motion.exitMs)
        assertTrue(motion.slide)
    }

    @Test fun `ordinary tall and full motion use the 220ms and 160ms sheet tokens`() {
        for (size in listOf(SheetSize.TALL, SheetSize.FULL)) {
            val motion = sheetHostMotion(size, reducedMotion = false)
            assertEquals(220, motion.enterMs)
            assertEquals(160, motion.exitMs)
            assertTrue(motion.slide)
        }
    }

    @Test fun `reduced motion crossfades every sheet in 120ms without fly ins`() {
        for (size in SheetSize.entries) {
            val motion = sheetHostMotion(size, reducedMotion = true)
            assertEquals(120, motion.enterMs)
            assertEquals(120, motion.exitMs)
            assertFalse(motion.slide)
        }
    }

    @Test fun `only full cards report home coverage while entering visible or exiting`() {
        for (size in SheetSize.entries) {
            for (current in listOf(false, true)) {
                for (target in listOf(false, true)) {
                    assertEquals("$size current=$current target=$target",
                        size == SheetSize.FULL && (current || target),
                        sheetHostCoversHome(size, currentVisible = current, targetVisible = target))
                }
            }
        }
    }

    @Test fun `missing sheet content never reports coverage even if an old transition was visible`() {
        assertFalse(sheetHostCoversHome(null, currentVisible = true, targetVisible = true))
        assertFalse(sheetHostCoversHome(null, currentVisible = true, targetVisible = false))
    }

    @Test fun `an exiting full card stays covered until its last visible transition state clears`() {
        assertTrue(sheetHostCoversHome(SheetSize.FULL, currentVisible = false, targetVisible = true))
        assertTrue(sheetHostCoversHome(SheetSize.FULL, currentVisible = true, targetVisible = true))
        assertTrue(sheetHostCoversHome(SheetSize.FULL, currentVisible = true, targetVisible = false))
        assertFalse(sheetHostCoversHome(SheetSize.FULL, currentVisible = false, targetVisible = false))
    }

    @Test fun `content mapper sees the unchanged active entry with tab scroll and recovery hint`() {
        val entry = SheetEntry(Destination.Army(), selectedTab = "ARMY", scrollIndex = 4, scrollOffset = 30, restored = true)
        val frame = frame(SheetSize.TALL, selectedTab = "ARMY")
        var calls = 0
        val content = requireNotNull(sheetHostContent(scope, SheetStack().push(entry), { mapped ->
            calls++
            assertSame(entry, mapped)
            frame
        }))
        assertEquals(1, calls)
        assertEquals(scope, content.scope)
        assertSame(entry, content.entry)
        assertSame(frame, content.frame)
    }

    @Test fun `only the top sheet is mapped and hidden full parents do not cover home`() {
        val stack = SheetStack().push(Destination.Profile()).push(Destination.BuildingInfo("building-1"))
        val mapped = mutableListOf<Destination>()
        val content = requireNotNull(sheetHostContent(scope, stack, { entry ->
            mapped += entry.destination
            frame(SheetSize.HALF)
        }))
        assertEquals(listOf(Destination.BuildingInfo("building-1")), mapped)
        assertFalse(sheetHostCoversHome(content.frame.size, currentVisible = true, targetVisible = true))
    }

    @Test fun `empty stack retains its same scope entry and frame for the exit only`() {
        val previous = requireNotNull(sheetHostContent(scope, SheetStack().push(Destination.Profile()), { frame(SheetSize.FULL) }))
        val exiting = sheetHostContent(scope, SheetStack(), { error("empty stack must not map a destination") }, previous)
        assertSame(previous, exiting)
        assertTrue(sheetHostCoversHome(exiting?.frame?.size, currentVisible = true, targetVisible = false))
        assertFalse(sheetHostCoversHome(exiting?.frame?.size, currentVisible = false, targetVisible = false))
    }

    @Test fun `a new top replaces retained content immediately without a fake old full exit`() {
        val full = requireNotNull(sheetHostContent(scope, SheetStack().push(Destination.Profile()), { frame(SheetSize.FULL) }))
        val top = SheetEntry(Destination.Army(), selectedTab = "ARMY", scrollIndex = 2)
        val replaced = requireNotNull(sheetHostContent(scope, SheetStack().push(top), { frame(SheetSize.TALL) }, full))
        assertSame(top, replaced.entry)
        assertEquals(SheetSize.TALL, replaced.frame.size)
        assertFalse(sheetHostCoversHome(replaced.frame.size, currentVisible = true, targetVisible = true))
    }

    @Test fun `same destination presentation updates replace stale tab and scroll without changing history`() {
        val original = SheetStack().push(Destination.Army())
        val previous = requireNotNull(sheetHostContent(scope, original, { frame(SheetSize.TALL) }))
        val updated = original.updateTop(selectedTab = "ARMY", scrollIndex = 7, scrollOffset = 9)
        val content = requireNotNull(sheetHostContent(scope, updated, { frame(SheetSize.TALL, it.selectedTab) }, previous))
        assertEquals("ARMY", content.entry.selectedTab)
        assertEquals(7, content.entry.scrollIndex)
        assertEquals(9, content.entry.scrollOffset)
        assertEquals("ARMY", content.frame.selectedTab)
        assertEquals(1, updated.depth)
    }

    @Test fun `session base or selection generation change removes the previous user exit content`() {
        val previous = requireNotNull(sheetHostContent(scope, SheetStack().push(Destination.Mail), { frame(SheetSize.FULL) }))
        for (changed in listOf(scope.copy(sessionId = "other-session"), scope.copy(baseId = "other-base"),
            scope.copy(baseSelectionGeneration = 4))) {
            val content = sheetHostContent(changed, SheetStack(), { error("empty stack must not map") }, previous)
            assertNull(content)
            assertFalse(sheetHostCoversHome(content?.frame?.size, currentVisible = true, targetVisible = false))
        }
    }

    @Test fun `a new scope with a new entry maps only that current entry`() {
        val previous = requireNotNull(sheetHostContent(scope, SheetStack().push(Destination.Mail), { frame(SheetSize.FULL) }))
        val changed = scope.copy(baseSelectionGeneration = 4)
        val current = SheetEntry(Destination.Research)
        val content = requireNotNull(sheetHostContent(changed, SheetStack().push(current), { frame(SheetSize.TALL) }, previous))
        assertEquals(changed, content.scope)
        assertSame(current, content.entry)
        assertEquals(SheetSize.TALL, content.frame.size)
    }

    @Test fun `empty initial host never calls a mapper or invents content`() {
        assertNull(sheetHostContent(scope, SheetStack(), { error("no destination") }))
    }

    @Test fun `no visible sheet does not invoke close callbacks or consume the event`() {
        val calls = mutableListOf<String>()
        assertFalse(dispatchSheetClose(sheetVisible = false,
            onDismissNested = { calls += "nested"; true }, onPop = { calls += "pop" }))
        assertTrue(calls.isEmpty())
    }

    @Test fun `nested owner dismissal consumes close before the host may pop`() {
        val calls = mutableListOf<String>()
        assertTrue(dispatchSheetClose(sheetVisible = true,
            onDismissNested = { calls += "nested"; true }, onPop = { calls += "pop" }))
        assertEquals(listOf("nested"), calls)
    }

    @Test fun `unhandled nested close pops exactly once after consulting the owner`() {
        val calls = mutableListOf<String>()
        assertTrue(dispatchSheetClose(sheetVisible = true,
            onDismissNested = { calls += "nested"; false }, onPop = { calls += "pop" }))
        assertEquals(listOf("nested", "pop"), calls)
    }

    @Test fun `same close dispatch used by Back or X reveals the retained parent state`() {
        val parent = SheetEntry(Destination.Army(), selectedTab = "ARMY", scrollIndex = 9, scrollOffset = 14)
        var stack = SheetStack().push(parent).push(Destination.Heroes("vex"))
        var nested = true
        val close = { dispatchSheetClose(!stack.isEmpty, onDismissNested = { nested.also { nested = false } },
            onPop = { stack = stack.pop() }) }
        assertTrue(close())
        assertEquals(2, stack.depth)
        assertTrue(close())
        assertSame(parent, stack.top)
        assertEquals(1, stack.depth)
    }

    @Test fun `only half sheets close through the scene tap seam without a transparent pointer blocker`() {
        assertFalse(sheetClosesOnSceneTap(null))
        assertTrue(sheetClosesOnSceneTap(SheetSize.HALF))
        assertFalse(sheetClosesOnSceneTap(SheetSize.TALL))
        assertFalse(sheetClosesOnSceneTap(SheetSize.FULL))
    }

    private fun frame(size: SheetSize, selectedTab: String? = null): SheetFrameUi = SheetFrameUi(
        title = "Sheet", portrait = null, size = size, tabs = emptyList(), selectedTab = selectedTab,
    )
}
