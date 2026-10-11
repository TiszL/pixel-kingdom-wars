package gg.pixelkingdomwars.nativeclient.ui.boot

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * SHARDKEEP D-192 / D-193. The boot screens are Compose-only and the module has no Compose test runtime, so the rules
 * that fixed the 2026-09-27 flicker and the one version label are pinned in source, the way `TitleWallpaperTest` pins
 * the wallpaper: no fade-in on mount, no scroll column, no centred card, a one-way sweep that never ping-pongs, a text
 * crossfade on line 2 for the tip only with two reserved lines, no animation under reduced motion, every boot
 * destination on ONE strip in ONE BootScreen, and "PIXEL KINGDOM WARS v<version>" on both clients.
 */
class LoadingStripWiringTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
    private val boot = File("$root/ui/boot/BootScreen.kt").readText()
    private val strip = File("$root/ui/boot/LoadingStrip.kt").readText()
    private val app = File("$root/ui/nav/PkwApp.kt").readText()
    private val banner = File("$root/update/UpdateBanner.kt").readText()
    private val screen = File("$root/update/UpdateScreen.kt").readText()
    private val art = File("$root/ui/chrome/PixelArt.kt").readText()

    @Test fun `the version label is one product version in one format on both clients`() {
        // D-192: web printed "PIXEL KINGDOM WARS 0.6.1", native "PIXEL KINGDOM WARS · v0.6.5"; both now read "PIXEL KINGDOM WARS v0.6.6".
        assertTrue("internal const val VERSION_LABEL_PREFIX = \"PIXEL KINGDOM WARS v\"" in boot)
        assertTrue("val versionLabel = VERSION_LABEL_PREFIX + BuildConfig.VERSION_NAME" in boot)
        assertFalse("no dot before the version anywhere on the boot screen", "· v" in boot || "· v" in strip)
        assertTrue("the label keeps its reader description", "contentDescription = \"Version \$versionName\"" in strip)
    }

    @Test fun `the strip is simply there on the first frame and never moves`() {
        // The old screen centred a scrolling column of cards; the card moved when the font landed and on every state.
        for (forbidden in listOf("verticalScroll", "Arrangement.Center", "AnimatedVisibility", "animateFloatAsState", "animateDpAsState", ".alpha(", "LoadingCard("))
            assertFalse("$forbidden has no place on the boot screen", forbidden in boot || forbidden in strip)
        assertTrue("the strip is placed at the plan's rect, not centred", "absoluteOffset(plan.strip.x.dp, plan.strip.y.dp).size(plan.strip.w.dp, plan.strip.h.dp)" in strip)
        assertTrue("the version label too", "absoluteOffset(plan.label.x.dp, plan.label.y.dp)" in strip)
        assertTrue("the wallpaper stays the point", "LoadingBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .9f)" in boot)
        assertTrue("line 2 reserves two lines in every state", "minLines = 2, maxLines = 2" in strip)
        assertTrue("the title reserves its lines", "minLines = plan.titleLines, maxLines = plan.titleLines" in strip)
        assertTrue("portrait actions stay beside the column", "else Column(Modifier.width(NARROW_ACTION_WIDTH.dp)) { actions() }" in strip)
        assertFalse("no empty reserved actions row", "actionsSlot" in strip)
        // Line 2 is its two reserved lines, never a dp-rounded box, and on wide layouts the lines are measured unbounded and
        // centred: capped at the plate's inner height, the px rounding of the stacked items overflowed it by ~3 px at 2.625×
        // and the reason lost its second line to the ellipsis (emulator 2026-09-28, landscape).
        assertTrue("narrow: line 2 keeps the whole column, and its height is its two lines", "LineText(plan, content, tip, reduced, Modifier.fillMaxWidth())" in strip)
        assertFalse("never a dp box on line 2", ".height(plan.lineSlot.dp)" in strip)
        assertTrue("wide: the lines are never capped at the plate's rounded height", "Column(Modifier.weight(1f).wrapContentHeight(Alignment.CenterVertically, unbounded = true)) { StripLines(plan, content, tip, reduced) }" in strip)
        assertFalse("wide: no fillMaxHeight cap on the lines", "Column(Modifier.weight(1f).fillMaxHeight())" in strip)
    }

    @Test fun `the meter sweeps one way and the tip crossfades its text only, none of it under reduced motion`() {
        assertTrue("one-way, linear", "infiniteRepeatable(tween(1600, easing = LinearEasing), RepeatMode.Restart)" in strip)
        assertFalse("never a ping-pong", "RepeatMode.Reverse" in strip)
        // Rewritten 2026-10-06 (owner: "that yellow moving line goes beyond its box"): the sweep used to be a 30 % rect from
        // −30 % to 100 % of the track on an unclipped Canvas, faded at both ends. It is now a comet of whole blocks that enters
        // whole and leaves whole inside the track, and the meter's Canvas clips (StripIndicatorBoundsTest pins the geometry).
        assertTrue("the comet enters and leaves whole", "val positions = METER_BLOCKS + SWEEP_TAIL + SWEEP_HEAD" in strip)
        assertTrue("the meter clips to its track", "Canvas(Modifier.fillMaxWidth().height(LoadingStripPlan.METER.dp).clipToBounds()" in strip)
        assertFalse("no offset from outside the track", "p * (w + segment) - segment" in strip)
        assertTrue("no sweep under reduced motion", "if (meter is StripMeter.Sweep && !reduced)" in strip)
        assertTrue("200 ms text crossfade, none under reduced motion", "animationSpec = if (reduced) snap() else tween(200)" in strip)
        assertTrue("the sprite is outside the crossfade", strip.indexOf("GameArt(tip.art") < strip.indexOf("Crossfade("))
        assertTrue("the tip rotates every 6 s", "delay(6_000); tipIndex = (tipIndex + 1) % BOOT_TIPS.size" in boot)
        // Review 2026-09-28: keyed on the live words, "Downloading · N%" re-started the fade on every percent and was
        // perpetually half-faded. The key is the tip's words or ONE key for every state line, which updates in place.
        assertTrue("the crossfade key is the tip's words or the one state-line key",
            "val key = if (content.line != null) STATE_LINE else Line(tip.category, tip.text)" in strip && "Crossfade(key, modifier," in strip)
        assertFalse("never keyed on the state line's text", "Line(null, line)" in strip || "Line(null, content.line)" in strip)
        // A ticking percent is not read aloud; a reason is.
        assertTrue("assertive only for a reason", "if (drawn === STATE_LINE && content.reason) Modifier.semantics { liveRegion = LiveRegionMode.Assertive } else Modifier" in strip)
    }

    @Test fun `every boot destination is one strip in one BootScreen, and the update strips keep the boot card's decisions`() {
        // Review 2026-09-28: a BootScreen per destination disposed the wallpaper at LOADING → UPDATE_AVAILABLE (every launch
        // with an offer) and drew the gradient between them. The route computes the strip per destination and calls
        // BootScreen once; the wallpaper, plan, sweep and tip live outside the `when`.
        // Rewritten for the hub mount (designed boot gate): the route draws ONE BootGateScreen for every destination. Inside
        // it the loading surface and the background under the update gate are ONE D-193 BootScreen at one position, so
        // LOADING → UPDATE keeps the wallpaper and only the designed gate card arrives; a failed launch keeps its TRY AGAIN strip.
        val route = app.substring(app.indexOf("composable<BootRoute>"), app.indexOf("composable<PreviewRoute>"))
        assertEquals("exactly one boot gate call on the boot route", 1, Regex("""BootGateScreen\(""").findAll(route).count())
        assertFalse("the route composes no BootScreen of its own", "BootScreen(" in route)
        assertTrue("BootGateScreen(graph, destination, content.error, bootBusy) { boot.start() }" in route)
        val gate = File("$root/ui/boot/BootGate.kt").readText()
        assertTrue("D-193 strip under the gate", "BootScreen(bootLoadingStrip(null, retrying = false, onRetryBoot), rememberBootTip())" in gate)
        assertTrue("failed launch keeps TRY AGAIN", "BootScreen(bootLoadingStrip(contentError, retrying = bootBusy, onRetryBoot), rememberBootTip())" in gate)
        for ((name, source) in listOf("banner" to banner, "screen" to screen)) assertFalse("$name returns a BootStrip; it never composes a BootScreen of its own", "BootScreen(" in source)
        assertEquals("BootScreen is defined once, in BootScreen.kt", 1, Regex("""BootScreen\(""").findAll(boot).count())
        // A backdrop recreated for any reason starts from the cached painting, never from a gradient frame.
        assertTrue("val prepared by produceState(ShellImages.cached(resource), resources, resource) {" in art)
        assertTrue("optional: the boot card's buttons", "for (action in bootCardActions(state, requested)) UpdateActionButton(" in banner)
        assertTrue("optional: LATER is the way on", "onClose = onLater" in banner)
        // The required strip's own forward action, not the Title/Home UpdateScreen's further down the same file.
        val required = screen.substring(screen.indexOf("fun bootRequiredUpdateStrip("), screen.indexOf("fun UpdateScreen("))
        assertTrue("required: the forward action", "updateForwardAction(state)?.let { action -> UpdateActionButton(action, state, onDownload = { repository.updateNow(it) }, onInstall = { repository.updateNow() }," in required)
        assertTrue("required: CHECK AGAIN under the gate's rule", "if (retryOffered) StripButton(\"CHECK AGAIN\", onRetry, ghost = true)" in required)
        assertTrue("the strip's buttons are 48 dp tap targets", "this.heightIn(min = LoadingStripPlan.TAP.dp)" in strip && "const val TAP = 48f" in strip)
        assertTrue("a frame without an offer keeps the loading strip, never a blank screen",
            "val offer = state.offer ?: return BootStrip(bootStripContent(null, false))" in banner && "val offer = state.offer ?: return BootStrip(bootStripContent(null, false))" in required)
        // The held percent is a per-transfer high-water mark outside the snapshot (no state written during composition).
        assertTrue("the held percent is the transfer's own", "val held = rememberHeldFraction(state)" in banner && "val held = rememberHeldFraction(state)" in required)
        assertFalse("no snapshot write during composition", "mutableFloatStateOf" in banner || "mutableFloatStateOf" in screen)
    }
}
