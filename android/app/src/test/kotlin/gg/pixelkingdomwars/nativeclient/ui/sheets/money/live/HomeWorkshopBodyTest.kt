package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** MS-UI4: designed observation surface; repository admission and original recovery belong to C3. AUTHORED/UNRUN. */
class HomeWorkshopBodyTest {
    private fun observation() = WorkshopSheetUi(
        CraftFrameUi("WORKSHOP", "LV 3", null, false, workshopTabs(), WorkshopTab.INGOTS), CraftHeaderUi(null),
        ingots = WorkshopIngotsUi(IngotInventoryUi(7, 2),
            IngotAllowanceUi(IngotDailyUi(4, 17, 13), IngotHoldingUi(7, 2, 31, 22), null),
            11, IngotBatchUi(5), null, 101, false, null))
    private fun display(ui: WorkshopSheetUi? = observation(), read: HomeWorkshopReadStatus = HomeWorkshopReadStatus.READY,
        admitted: Boolean = true, tab: String = WorkshopTab.INGOTS) = homeWorkshopDisplay(ui, read, admitted, tab)
    @Test fun `admitted ingots shows only exact observed inventory and allowance`() {
        val shown = display(); assertEquals(listOf("7", "2", "13", "22"), shown.inventory.map { it.value })
        assertFalse(shown.canRetry); assertEquals("Workshop inventory", shown.status)
    }
    @Test fun `retained body never establishes view admission`() {
        val shown = display(admitted = false)
        assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("not current"))
    }
    @Test fun `actual loading hides retained inventory and does not admit retry`() {
        val shown = display(read = HomeWorkshopReadStatus.LOADING)
        assertTrue(shown.inventory.isEmpty()); assertFalse(shown.canRetry)
        assertEquals("Loading Workshop information…", shown.status)
    }
    @Test fun `failed refresh hides retained inventory and offers a read retry`() {
        val shown = display(read = HomeWorkshopReadStatus.FAILED)
        assertTrue(shown.inventory.isEmpty()); assertTrue(shown.canRetry)
        assertTrue(shown.status.contains("could not be refreshed"))
    }
    @Test fun `completed read without a body is explicit unavailable never permanent loading`() {
        val shown = display(ui = null)
        assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("unavailable"))
        assertFalse(shown.status.contains("Loading")); assertFalse(shown.canRetry)
    }
    @Test fun `saved original supersedes current-base inventory and never leaks its key`() {
        val ui = observation(); val saved = ui.copy(ingots = ui.ingots!!.copy(saved = SavedOpUi("private-original-key")))
        val shown = display(saved)
        assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("saved Workshop request"))
        assertTrue(shown.status.contains("original receipt")); assertFalse(shown.toString().contains("private-original-key"))
    }
    @Test fun `saved original summary remains visible when another canonical tab was requested`() {
        val ui = observation(); val shown = display(ui.copy(ingots = ui.ingots!!.copy(saved = SavedOpUi("original"))), tab = WorkshopTab.REFINE)
        assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("saved Workshop request"))
    }
    @Test fun `unadmitted saved original cannot cross current owner boundary`() {
        val ui = observation(); val shown = display(ui.copy(ingots = ui.ingots!!.copy(saved = SavedOpUi("original"))), admitted = false)
        assertTrue(shown.inventory.isEmpty()); assertFalse(shown.status.contains("saved Workshop request"))
    }
    @Test fun `other canonical tabs state unavailable instead of borrowing INGOTS inventory`() {
        for (tab in listOf(WorkshopTab.REFINE, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS)) {
            val shown = display(tab = tab); assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("unavailable"))
        }
    }
    @Test fun `unknown or noncanonical tab does not silently select another section`() {
        for (tab in listOf("", "ingots", "AWNINGS", "UNKNOWN")) {
            val shown = display(tab = tab); assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("choose a section"))
        }
    }
    @Test fun `a body for an unadvertised tab is not evidence for that tab`() {
        val ui = observation(); val shown = display(ui.copy(frame = ui.frame.copy(tabs = workshopTabs(listOf(WorkshopTab.REFINE)))))
        assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("unavailable"))
    }
    @Test fun `partially observed amounts remain unknown rather than empty`() {
        val ui = observation(); val shown = display(ui.copy(ingots = ui.ingots!!.copy(inventory = IngotInventoryUi(null, 2))))
        assertEquals("…", shown.inventory.first().value); assertEquals("2", shown.inventory[1].value)
        assertTrue(shown.status.contains("partly unknown"))
    }
    @Test fun `known zero remains distinct from unknown`() {
        val ui = observation(); val shown = display(ui.copy(ingots = ui.ingots!!.copy(inventory = IngotInventoryUi(0, null))))
        assertEquals(listOf("0", "…"), shown.inventory.take(2).map { it.value })
    }
    @Test fun `large integer observations never pass through floating point`() {
        val ui = observation(); val shown = display(ui.copy(ingots = ui.ingots!!.copy(inventory = IngotInventoryUi(9_007_199_254_740_993, Long.MAX_VALUE))))
        assertEquals(listOf("9,007,199,254,740,993", "9,223,372,036,854,775,807"), shown.inventory.take(2).map { it.value })
    }
    @Test fun `negative counts cannot become a displayed inventory`() {
        val ui = observation(); val shown = display(ui.copy(ingots = ui.ingots!!.copy(inventory = IngotInventoryUi(-1, 2))))
        assertEquals("…", shown.inventory.first().value)
    }
    @Test fun `kit action gate cannot turn display projection into command controls`() {
        val ui = observation(); assertEquals(display(ui), display(ui.copy(ingots = ui.ingots!!.copy(actionsAllowed = true))))
    }
    @Test fun `admitted ready header without a representable bench states review unavailable truthfully`() {
        val ui = observation(); val shown = display(ui.copy(ingots = null,
            frame = ui.frame.copy(live = CraftLiveUi("ui:ready-status", "Forge Ingots ready", ready = true))))
        assertTrue(shown.inventory.isEmpty()); assertEquals("Forge Ingots are ready. Collection review is unavailable.", shown.status)
    }
    @Test fun `body hydration error cannot be advertised as a current empty bench`() {
        val ui = observation(); val shown = display(ui.copy(ingots = ui.ingots!!.copy(hydration = CraftHydration.Error("x"))))
        assertTrue(shown.inventory.isEmpty()); assertTrue(shown.status.contains("unavailable"))
    }

    private fun bodySourceWithoutComments(): String = File(
        "src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/money/live/HomeWorkshopBody.kt")
        .readText().replace(Regex("""/\*[\s\S]*?\*/|//[^\n]*"""), "")

    @Test fun `body mounts designed sheet with navigation read and original recovery only`() {
        val source = bodySourceWithoutComments()
        assertEquals(1, Regex("""\bWorkshopSheet\s*\(""").findAll(source).count())
        assertFalse(source.contains("OPEN WORKSHOP"))
        assertTrue(source.contains("homeWorkshopActions(ui, onTab, onRetry, onLegacy, onClose, onRefineSelect, onRefineQty)"))
        for (call in listOf("PrimaryButton", "clickable", "check", "collect", "resubmit", "onCheck", "onCollect", "Seal", "SealSheet"))
            assertFalse("Forbidden action call: $call", Regex("""\b$call\s*\(""").containsMatchIn(source))
        assertFalse(Regex("""\b\w*(?:Repository|ViewModel)\b""").containsMatchIn(source))
        assertFalse(Regex("""\bon(?:Check|Collect)\w*\b""").containsMatchIn(source))
    }
    @Test fun `status and inventory labels explicitly wrap inside the bounded body`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/craft/WorkshopSheet.kt").readText()
        assertTrue(source.contains("PkwText(observation.message, PkwTokens.Type.body, Modifier.fillMaxWidth(),"))
        assertTrue(source.contains("maxLines = 4"))
        assertTrue(source.contains("WorkshopIngotsBody(it, on, now, destinationsAvailable = false)"))
    }
    @Test fun `existing review hides inventory without opening a second review or read retry`() {
        val shown = display(observation().copy(review = CraftReviewUi("Existing review", "Review stays with its owner")))
        assertTrue(shown.inventory.isEmpty()); assertFalse(shown.canRetry)
        assertEquals("An existing Workshop review needs attention.", shown.status)
        assertFalse(shown.canOpenOriginal)
    }
    @Test fun `saved refine tools and style each hide otherwise valid ingot inventory`() {
        val ui = observation(); val saved = SavedOpUi("private-original-key")
        val views = listOf(
            ui.copy(refine = WorkshopRefineUi(emptyList(), emptyMap(), 1, false, emptyList(), false, null, 1, saved, CraftHydration.Ready)),
            ui.copy(tools = WorkshopToolsUi(emptyList(), emptyMap(), emptyList(), null, false, saved)),
            ui.copy(style = WorkshopStyleUi(AwningUi(emptyList(), null, false), WakeUi(false, false, null), null, null, saved)))
        for (view in views) {
            val shown = display(view)
            assertTrue(shown.inventory.isEmpty()); assertFalse(shown.canRetry)
            assertEquals("A saved Workshop request needs attention. Its original receipt is preserved.", shown.status)
            assertFalse(shown.toString().contains("private-original-key"))
        }
    }
    @Test fun `sending checking and either collecting observation hide retained inventory`() {
        val ui = observation(); val ingots = ui.ingots!!
        val states = listOf(ingots.copy(submit = SubmitUi(SubmitStage.SENDING)),
            ingots.copy(submit = SubmitUi(SubmitStage.CHECKING)), ingots.copy(collect = CollectStage.COLLECTING),
            ingots.copy(job = IngotJobUi("job", 2, null, IngotJobState.COLLECTING)))
        for (state in states) {
            val shown = display(ui.copy(ingots = state))
            assertTrue(shown.inventory.isEmpty()); assertFalse(shown.canRetry)
            assertEquals("A Workshop request is in progress. Its original receipt is preserved.", shown.status)
        }
    }
    @Test fun `ready and running jobs retain observed rows and state their observed progress`() {
        val ui = observation()
        for ((state, sentence) in listOf(IngotJobState.READY to "A batch is ready in the Workshop.",
            IngotJobState.RUNNING to "A batch is in progress.")) {
            val shown = display(ui.copy(ingots = ui.ingots!!.copy(job = IngotJobUi("job", 2, null, state))))
            assertEquals(sentence, shown.status); assertEquals(listOf("7", "2", "13", "22"), shown.inventory.map { it.value })
            assertFalse(shown.canRetry)
        }
    }
    @Test fun `idle refused and failed stages do not invent command outcomes or retries`() {
        val ui = observation(); val ingots = ui.ingots!!
        // The accepted producer emits IDLE. These otherwise admitted observations still describe inventory only.
        for (state in listOf(ingots, ingots.copy(submit = SubmitUi(SubmitStage.REFUSED)), ingots.copy(collect = CollectStage.FAILED))) {
            val shown = display(ui.copy(ingots = state))
            assertEquals("Workshop inventory", shown.status); assertEquals(listOf("7", "2", "13", "22"), shown.inventory.map { it.value })
            assertFalse(shown.canRetry)
        }
    }

    private fun sheet(ui: WorkshopSheetUi? = observation(), read: HomeWorkshopReadStatus = HomeWorkshopReadStatus.READY,
        admitted: Boolean = true, tab: String = WorkshopTab.INGOTS) = homeWorkshopSheetUi(ui, read, admitted, tab)

    @Test fun `all canonical tabs remain selectable without fabricated non ingot state`() {
        val tabs = listOf(WorkshopTab.REFINE, WorkshopTab.INGOTS, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS)
        for (tab in tabs) {
            val ui = sheet(tab = tab)
            assertEquals(tabs, ui.frame.tabs.map { it.id }); assertEquals(tab, ui.frame.selectedTab)
            assertNull(ui.refine); assertNull(ui.tools); assertNull(ui.style)
            if (tab != WorkshopTab.INGOTS) {
                assertNull(ui.ingots); assertTrue(ui.observation!!.message.contains("unavailable"))
            }
        }
    }
    @Test fun `designed ingot observation is current exact and cannot publish a transaction surface`() {
        val incoming = observation().let { it.copy(ingots = it.ingots!!.copy(actionsAllowed = true),
            celebration = CraftCelebrationUi("job", "DONE", "craft:inv_forge_ingot", "+1", "Already delivered")) }
        val ui = sheet(incoming)
        assertEquals(IngotInventoryUi(7, 2), ui.ingots!!.inventory); assertFalse(ui.ingots!!.actionsAllowed)
        assertNotNull(ui.observation); assertNull(ui.review); assertNull(ui.celebration); assertNull(ui.spend)
        assertFalse(ui.frame.history)
    }
    @Test fun `stale loading failed and missing observations remove retained body and header`() {
        val incoming = observation().copy(header = CraftHeaderUi("craft:workshop_t3_ready"))
        val views = listOf(sheet(incoming, admitted = false), sheet(incoming, HomeWorkshopReadStatus.LOADING),
            sheet(incoming, HomeWorkshopReadStatus.FAILED), sheet(null))
        for (ui in views) {
            assertNull(ui.ingots); assertNull(ui.header.sprite); assertNull(ui.frame.titleTag); assertNull(ui.frame.live)
            assertNull(ui.review); assertNull(ui.celebration); assertNull(ui.spend)
        }
        assertTrue(views[1].observation!!.loading); assertFalse(views[0].observation!!.loading)
        assertTrue(views[2].observation!!.canRetry); assertFalse(views[3].observation!!.canRetry)
    }
    @Test fun `saved original gives only admitted recovery with no current base or secret key projection`() {
        val incoming = observation().let { it.copy(ingots = it.ingots!!.copy(saved = SavedOpUi("private-original-key"))) }
        val ui = sheet(incoming, tab = WorkshopTab.COSMETICS)
        assertNull(ui.ingots); assertNull(ui.header.sprite); assertTrue(ui.observation!!.canOpenOriginal)
        assertFalse(ui.toString().contains("private-original-key"))
        assertFalse(sheet(incoming, admitted = false).observation!!.canOpenOriginal)
    }
    @Test fun `actions switch canonical tabs once and never route an unknown tab`() {
        val changed = mutableListOf<String>(); var closed = 0; var retried = 0; var originals = 0
        val on = homeWorkshopActions(sheet(), { changed += it }, { retried++ }, { originals++ }, { closed++ })
        on.onTab(WorkshopTab.REFINE); on.onTab(WorkshopTab.COSMETICS); on.onTab("UNKNOWN"); on.onClose(); on.onRetry()
        assertEquals(listOf(WorkshopTab.REFINE, WorkshopTab.COSMETICS), changed)
        assertEquals(1, closed); assertEquals(0, retried); assertEquals(0, originals); assertNull(on.onOpenOriginal)
    }
    @Test fun `retry and original recovery are independently visible only for their admitted state`() {
        var reads = 0; var originals = 0
        val failed = homeWorkshopActions(sheet(read = HomeWorkshopReadStatus.FAILED), {}, { reads++ }, { originals++ }, {})
        failed.onRetry(); assertEquals(1, reads); assertNull(failed.onOpenOriginal)
        val incoming = observation().let { it.copy(ingots = it.ingots!!.copy(saved = SavedOpUi("original"))) }
        val saved = homeWorkshopActions(sheet(incoming), {}, { reads++ }, { originals++ }, {})
        requireNotNull(saved.onOpenOriginal).invoke(); saved.onRetry()
        assertEquals(1, originals); assertEquals(1, reads)
    }
    @Test fun `ready job survives observation while collection remains unavailable`() {
        val incoming = observation().let { it.copy(ingots = it.ingots!!.copy(job = IngotJobUi("job", 2, null, IngotJobState.READY))) }
        val ui = sheet(incoming)
        assertEquals(IngotJobState.READY, ui.ingots!!.job!!.state); assertFalse(ui.ingots!!.actionsAllowed)
        assertEquals(CollectStage.IDLE, ui.ingots!!.collect); assertNotNull(ui.observation)
    }

    private fun refineObservation() = observation().copy(ingots = null,
        refine = WorkshopRefineUi(listOf(RecipeUi("refine_wood", "2", RecipeGroup.REFINE, "plank", 2,
            listOf(RecipeInputUi(InputKind.RAW, "wood", 3)), 11, "For tools", null)),
            mapOf("wood" to StockUi(17)), 8, true, emptyList(), true, "refine_wood", 2, null,
            CraftHydration.Ready, shards = 41, benchCapacity = 2))

    @Test fun `refine independent live observation retains recipes stock capacity and closes spending`() {
        val input = refineObservation()
        val ui = sheet(input, tab = WorkshopTab.REFINE)
        assertNotNull(ui.refine); assertNull(ui.ingots)
        assertEquals(input.refine!!.recipes, ui.refine!!.recipes)
        assertEquals(input.refine!!.stock, ui.refine!!.stock)
        assertEquals(2, ui.refine!!.benchCapacity); assertEquals(2, ui.refine!!.quantity)
        assertFalse(ui.refine!!.actionsAllowed); assertNull(ui.review); assertNull(ui.celebration); assertNull(ui.spend)
        assertFalse(ui.observation!!.message.contains("unavailable"))
    }
    @Test fun `refine admission never borrows a stale body or invents an empty queue`() {
        val input = refineObservation()
        for (read in listOf(HomeWorkshopReadStatus.LOADING, HomeWorkshopReadStatus.FAILED))
            assertNull(sheet(input, read, tab = WorkshopTab.REFINE).refine)
        assertNull(sheet(input, admitted = false, tab = WorkshopTab.REFINE).refine)
        assertNull(sheet(input.copy(refine = input.refine!!.copy(hydration = CraftHydration.Error("read failed"))),
            tab = WorkshopTab.REFINE).refine)
        assertNull(sheet(input.copy(frame = input.frame.copy(tabs = workshopTabs(listOf(WorkshopTab.INGOTS)))),
            tab = WorkshopTab.REFINE).refine)
    }
    @Test fun `refine local selection is bounded and has no order callback`() {
        val selected = mutableListOf<String>(); val deltas = mutableListOf<Int>()
        val ui = sheet(refineObservation(), tab = WorkshopTab.REFINE)
        val actions = homeWorkshopActions(ui, {}, {}, {}, {}, { selected += it }, { deltas += it })
        actions.refine.onSelectRecipe("refine_wood"); actions.refine.onSelectRecipe("unknown")
        actions.refine.onQty(1); actions.refine.onQty(-1); actions.refine.onQty(99)
        actions.refine.onStart("refine_wood", 2)
        assertEquals(listOf("refine_wood"), selected); assertEquals(listOf(1, -1), deltas)
        val absent = homeWorkshopActions(sheet(), {}, {}, {}, {}, { selected += it }, { deltas += it })
        absent.refine.onSelectRecipe("refine_wood"); absent.refine.onQty(1)
        assertEquals(listOf("refine_wood"), selected); assertEquals(listOf(1, -1), deltas)
    }
    @Test fun `host original request flag requires exact current completed admission`() {
        fun flagged(read: HomeWorkshopReadStatus, admitted: Boolean) = homeWorkshopSheetUi(null, read, admitted,
            WorkshopTab.REFINE, originalRequestPending = true)
        assertTrue(flagged(HomeWorkshopReadStatus.READY, true).observation!!.canOpenOriginal)
        assertFalse(flagged(HomeWorkshopReadStatus.READY, false).observation!!.canOpenOriginal)
        assertFalse(flagged(HomeWorkshopReadStatus.LOADING, true).observation!!.canOpenOriginal)
        assertFalse(flagged(HomeWorkshopReadStatus.FAILED, true).observation!!.canOpenOriginal)
    }
    @Test fun `observed refine suppresses unbound ingredient doors and uses a real local stepper`() {
        val sheet = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/craft/WorkshopSheet.kt").readText()
        val refine = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/craft/WorkshopRefineTab.kt").readText()
        assertTrue(sheet.contains("WorkshopRefineBody(it, on, now, destinationsAvailable = false)"))
        assertTrue(sheet.contains("on.refine.onQty(-1)")); assertTrue(sheet.contains("on.refine.onQty(1)"))
        assertTrue(refine.contains("showGo = destinationsAvailable"))
    }
    @Test fun `ordinary owners mount designed sheet without a second financial or delivery owner`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/OrdinaryWorkshopScreen.kt").readText()
        val body = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/OrdinaryCraftingScreen.kt").readText()
        assertTrue(host.contains("LocalWorkshopOwnerHost")); assertTrue(host.contains("maxConcurrentPerBase"))
        assertTrue(body.contains("WorkshopSheet(")); assertTrue(body.contains("workshopRefineTabUi("))
        assertTrue(body.contains("lifecycle.currentStateFlow.collectAsState()"))
        assertTrue(body.contains("remember(model, wallet, selectedBase, generation, ownerActive)"))
        assertTrue(body.contains("!busy && notice?.error != true"))
        for (call in listOf("model.reviewSaved()", "model.check()", "model.finish()", "model.archiveUnusedOrRefused()", "model.checkArchived("))
            assertTrue("Original recovery retained: $call", body.contains(call))
        assertFalse(body.contains("model.collect(")); assertFalse(body.contains("markDelivered("))
        assertFalse(body.contains("OrdinaryCraftingViewModel("))
    }

    @Test fun `the WorkshopScreen source keeps its original lifecycle and review consent bytes`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/WorkshopScreen.kt").readText()
        fun sha(text: String) = java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        // Rewritten for the in-place review (ui-craft S1): only the signature line gained the defaulted modifier and
        // onOpenDestination parameters; lines 56-74 (lifecycle, admission, Back) are byte-identical to before. The review
        // AlertDialog moved to the designed half sheet, whose consent wording is pinned verbatim in WorkshopReviewMapper.
        // 2026-10-10 (release lint NewApi): workshopDuration's BigInteger.longValueExact() (API 31, a NoSuchMethodError on
        // Android 9-11) became longValueExactCompat() and its import added one line, so the pinned region now ends at line
        // 75. The lifecycle, admission and Back lines (now 57-75) are byte-identical; the pin still ends at the review Back.
        assertEquals("ee8e75a312b34d109afab9049f5cd06e7e9d09ebf8d39bb9837d18d082d1c4f4", sha(source.lineSequence().take(75).joinToString("\n") + "\n"))
        assertTrue(source.lineSequence().drop(74).first().contains("BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }"))
        assertFalse(source.contains("    review?.let { r ->"))
        val mapper = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/money/live/WorkshopReviewMapper.kt").readText()
        for (sentence in listOf("SHARDS at start. Charge is final at start. No cancellation, refund or SOL fee.",
            "Collect from the original paid job. No new refining charge.",
            "This explicitly resends the same saved request only after its original receipt is checked."))
            assertTrue("Original consent wording kept: $sentence", mapper.contains(sentence))
    }

    @Test fun `the OrdinaryCraftingScreen source keeps its original lifecycle and review consent bytes`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/OrdinaryCraftingScreen.kt").readText()
        fun sha(text: String) = java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        // Rewritten for the in-place review (ui-craft S1): the content gained defaulted modifier/onOpenDestination, the
        // notice became a toast and the proof no longer auto-opens History; the pinned region still ends at the review Back.
        // 2026-10-06 (crafting gap audit + old-screen sweep): the receipts page moved onto the kit records page; the lifecycle
        // and the consent sentences (checked below) are unchanged, so the pinned bytes follow the new file.
        assertEquals("1445c1bd9ccb14b238fc39e192d20a957e60c0b5f25ca8b4336c347fc33d20c4", sha(source.lineSequence().take(85).joinToString("\n") + "\n"))
        assertTrue(source.lineSequence().drop(84).first().contains("BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }"))
        assertFalse(source.contains("    review?.let { r ->"))
        val mapper = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/money/live/WorkshopReviewMapper.kt").readText()
        assertTrue(mapper.contains("ordinaryCraftingIngredientConsent(recipe), \"No cancellation or refund. No SOL, KEEP or Gems payment.\""))
        val consent = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/OrdinaryCraftingViewModel.kt").readText()
        assertTrue(consent.contains("SHARDS are consumed as an ingredient alongside the listed materials. This is not a service fee or tax."))
    }

    @Test fun `ingot owner mounts designed frame and preserves original reviewed actions and recovery`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/WorkshopScreen.kt").readText()
        assertTrue(source.contains("WorkshopSheet(")); assertTrue(source.contains("LocalWorkshopOwnerHost"))
        assertFalse(source.contains("GamePage(\"INGOT WORKSHOP\""))
        for (call in listOf("model.start(", "model.collect(", "model.reviewSaved()", "model.check()", "model.finish()", "model.archiveUnusedOrRefused()"))
            assertTrue("Existing owner path retained: $call", source.contains(call))
        // Rewritten (ui-craft S1): destination doors exist only when the Home host binds an opener; the route passes none.
        assertTrue(source.contains("destinationsAvailable = onOpenDestination != null"))
        assertTrue(source.contains("lifecycle.currentStateFlow.collectAsState()"))
        assertTrue(source.contains("remember(model, selectedBase, generation, ownerActive)"))
        assertFalse(source.contains("WorkshopViewModel(")); assertFalse(source.contains("markCollected("))
        assertFalse(source.contains("LazyColumn(")) // The original chrome dialog already owns scrolling.
    }

    @Test fun `healthy Home tabs expose navigation to existing owners without opening a transaction`() {
        val calls = mutableListOf<String>()
        for ((input, tab) in listOf(observation() to WorkshopTab.INGOTS, refineObservation() to WorkshopTab.REFINE)) {
            val ui = sheet(input, tab = tab)
            assertTrue(ui.observation!!.canOpenControls)
            assertFalse(ui.observation!!.canOpenOriginal)
            assertNull(ui.review); assertNull(ui.celebration)
            assertFalse(ui.ingots?.actionsAllowed == true || ui.refine?.actionsAllowed == true)
            val on = homeWorkshopActions(ui, {}, {}, { calls += tab }, {})
            assertNotNull(on.onOpenControls); assertNull(on.onOpenOriginal)
            on.onOpenControls!!.invoke()
            on.refine.onStart("refine_wood", 2); on.ingots.onCast(2); on.ingots.onCollect("job")
        }
        assertEquals(listOf(WorkshopTab.INGOTS, WorkshopTab.REFINE), calls)
    }

    @Test fun `owner navigation requires a healthy current completed read on a supported tab`() {
        val ingots = observation()
        val blocked = listOf(
            sheet(ingots, admitted = false), sheet(ingots, HomeWorkshopReadStatus.LOADING),
            sheet(ingots, HomeWorkshopReadStatus.FAILED), sheet(null),
            sheet(ingots, tab = WorkshopTab.EQUIPMENT), sheet(ingots, tab = WorkshopTab.COSMETICS),
            sheet(ingots.copy(review = CraftReviewUi("Existing", "Keep original review"))),
            sheet(ingots.copy(ingots = ingots.ingots!!.copy(submit = SubmitUi(SubmitStage.SENDING)))),
            sheet(ingots.copy(ingots = ingots.ingots!!.copy(submit = SubmitUi(SubmitStage.CHECKING)))),
            sheet(ingots.copy(ingots = ingots.ingots!!.copy(submit = SubmitUi(SubmitStage.REFUSED)))),
            sheet(ingots.copy(ingots = ingots.ingots!!.copy(collect = CollectStage.FAILED))))
        for (ui in blocked) {
            assertFalse(ui.observation!!.canOpenControls)
            assertNull(homeWorkshopActions(ui, {}, {}, { fail("Unadmitted owner navigation") }, {}).onOpenControls)
        }
    }

    @Test fun `saved requests keep original recovery distinct from healthy owner navigation`() {
        val input = observation()
        val states = listOf(sheet(input.copy(ingots = input.ingots!!.copy(saved = SavedOpUi("key")))),
            homeWorkshopSheetUi(refineObservation(), HomeWorkshopReadStatus.READY, true, WorkshopTab.REFINE,
                originalRequestPending = true))
        for (ui in states) {
            assertTrue(ui.observation!!.canOpenOriginal); assertFalse(ui.observation!!.canOpenControls)
            val on = homeWorkshopActions(ui, {}, {}, {}, {})
            assertNotNull(on.onOpenOriginal); assertNull(on.onOpenControls)
        }
    }

    @Test fun `owner controls are separate navigation buttons and leave the unavailable primary closed`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/craft/WorkshopSheet.kt").readText()
        assertTrue(source.contains("OPEN REFINING")); assertTrue(source.contains("OPEN INGOTS"))
        assertTrue(source.contains("observation.canOpenControls && controls != null"))
        assertTrue(source.contains("offPrimary(\"REVIEW UNAVAILABLE\""))
        assertTrue(source.contains("val controls = on.onOpenControls"))
    }

    @Test fun `Home ingot foreground read is invalidated on exit and quantity range stays nonempty`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeRouteDispatcher.kt").readText()
        val body = source.substringAfter("@Composable internal fun HomeWorkshopSheet(")
            .substringBefore("internal class HomeMailReadCapture")
        assertTrue(body.contains("ingotForegroundReadCompleted = capture.refresh("))
        assertTrue(body.contains("finally { ingotForegroundReadCompleted = false }"))
        assertTrue(body.contains("lifecycleState == Lifecycle.State.RESUMED && ingotForegroundReadCompleted &&"))
        assertTrue(body.contains("refine.maxBatch.coerceAtLeast(1).toLong()"))
    }

    @Test fun `refining queue capacity does not depend on Awning application readiness`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/OrdinaryWorkshopScreen.kt").readText()
        // Queue capacity belongs to the core crafting catalogue; optional appearance art cannot disable refining.
        val capacity = source.lineSequence().single { it.contains("val capacity =") }
        assertTrue(capacity.contains("previewGuard(); art.maxConcurrentPerBase()"))
        assertFalse(capacity.contains("applicationReady"))
    }

    @Test fun `owner Workshop headers never infer a tier from missing admitted art`() {
        for (name in listOf("OrdinaryWorkshopScreen.kt", "OrdinaryCraftingScreen.kt")) {
            val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/$name").readText()
            // workshopHeader(null) silently selects tier one; null sprite is the honest unavailable state.
            assertFalse(source.contains("workshopHeader(null"))
            assertTrue(source.contains("gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi(null)"))
        }
    }

    @Test fun `accepted owner receipts open recovery after the review closes without another owner action`() {
        // Rewritten (ui-craft S1): proof no longer auto-opens the receipts dialog. The recovery row and its explicit
        // archive door are on the sheet as soon as the review closes; no effect reads, archives or resubmits.
        for ((name, label, autoOpen) in listOf(
            Triple("WorkshopScreen.kt", "ARCHIVE CONFIRMED RECEIPT", "showReceipts = true"),
            Triple("OrdinaryCraftingScreen.kt", "ARCHIVE ACCEPTED START", "RefiningPage.HISTORY"))) {
            val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/$name").readText()
            val door = source.substringAfter("SavedDoor.FINISH ->").substringBefore("SavedDoor.REVIEW ->")
            assertTrue(door.contains("\"$label\"")); assertTrue(door.contains("model.finish()"))
            var from = source.indexOf("LaunchedEffect(")
            while (from >= 0) {
                val open = source.indexOf('{', from); var depth = 0; var end = open
                for (i in open until source.length) {
                    if (source[i] == '{') depth++
                    if (source[i] == '}') { depth--; if (depth == 0) { end = i; break } }
                }
                val effect = source.substring(from, end + 1)
                assertFalse("$name effect: $effect", effect.contains(autoOpen) || effect.contains("finish()"))
                from = source.indexOf("LaunchedEffect(", end)
            }
        }
    }

    @Test fun `ordinary history yields to the unchanged original review dialog`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/economy/OrdinaryCraftingScreen.kt").readText()
        // Rewritten (c-gap-craft): History is now the designed records page drawn over the sheet instead of a chrome
        // AlertDialog; it still yields to an open review (and to the BATCH DONE celebration), never covering them.
        assertTrue(source.contains("if (page == RefiningPage.HISTORY && review == null && visibleCompletion == null) refiningRecords("))
        assertFalse(source.contains("if (page == RefiningPage.HISTORY) {"))
        assertFalse(source.contains("AlertDialog(onDismissRequest = { page = RefiningPage.REFINE }"))
    }

    @Test fun `Workshop owner tab routes replace the sibling destination instead of stacking it`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        val ingots = source.substringAfter("composable<WorkshopRoute>").substringBefore("composable<OrdinaryCraftingRoute>")
        val refine = source.substringAfter("composable<OrdinaryCraftingRoute>").substringBefore("composable<MiningContributionRoute>")
        // X and Back must leave the Workshop, not revisit the previous tab's owner route.
        assertEquals(1, ingots.split("popUpTo<WorkshopRoute> { inclusive = true }").size - 1)
        assertEquals(1, refine.split("popUpTo<OrdinaryCraftingRoute> { inclusive = true }").size - 1)
    }

    @Test fun `Home saved ingot recovery cannot be redirected by the selected refine tab`() {
        // Rewritten for the in-place mount (ui-craft): the Home sheet no longer hops to a route, so this rule now lives in the
        // mounted sheet's tab choice. An INGOTS journal original still takes precedence over a requested REFINE or STYLE tab
        // until the player picks a tab in the sheet, so its recovery row is the first thing the Workshop shows.
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeWorkshopOwnerSheet.kt").readText()
        assertTrue(source.contains("homeWorkshopOwnerTab(entry, ingotOriginalSaved = ingotState?.journal?.operation != null)"))
        val app = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        assertTrue(app.contains("is Destination.Workshop -> gg.pixelkingdomwars.nativeclient.ui.home.HomeWorkshopOwnerSheet("))
        for (requested in listOf(WorkshopTab.REFINE, WorkshopTab.COSMETICS)) {
            val entry = gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(gg.pixelkingdomwars.nativeclient.ui.features.Destination.Workshop(requested))
            assertEquals(WorkshopTab.INGOTS, gg.pixelkingdomwars.nativeclient.ui.home.homeWorkshopOwnerTab(entry, ingotOriginalSaved = true))
            assertEquals(requested, gg.pixelkingdomwars.nativeclient.ui.home.homeWorkshopOwnerTab(entry))
            // A tab the player picked in the sheet is honoured even with a saved original.
            assertEquals(requested, gg.pixelkingdomwars.nativeclient.ui.home.homeWorkshopOwnerTab(entry.copy(selectedTab = requested), ingotOriginalSaved = true))
        }
    }
}
