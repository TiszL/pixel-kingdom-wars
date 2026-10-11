package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWorkshopState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.PrimaryAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.styleLines
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** STYLE uses the existing appearance owners. Execution belongs to Cedar3. */
class WorkshopStyleOwnerMapperTest {
    // Synthetic server facts shaped like the existing owner's view (values are placeholders, not tuning).
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val building = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-10-04T07:00:00.000Z"
    private val cosmetic = BoundCosmeticIdentity("https://example.invalid", "devnet", wallet)
    private val verified = (1..4).associate { "artisan_market_awning_t$it" to it }
    private fun row(tier: Int) = BoundCosmeticCatalogueRow(
        BoundCosmeticRecipe("craft_artisan_market_awning_t${tier}_v1", 1, "artisan_market_awning_t$tier", "1", 3600,
            listOf(BoundCosmeticInput("thornsilk", "6")), BoundCosmeticFacility("market", tier.toLong()),
            "architect_blueprint_artisan_finishes_v1"),
        BoundCosmeticAppearance(1, "artisan_market_awning_t$tier", "artisan-market-t$tier", "a".repeat(64), "b".repeat(64), "c".repeat(64)))
    private fun ownedProof(tier: Int): BoundCosmeticProof {
        val key = "00000000-0000-4000-8000-00000000001$tier"
        val r = row(tier)
        return BoundCosmeticProof(1, wallet, key, now, "accepted", BoundCosmeticReceipt(wallet, key,
            BoundCosmeticRequest(key, base, r.recipe.recipeId, 1, r.appearance.bindingSha256), r.recipe, r.appearance,
            BoundCosmeticBlueprint("architect_blueprint_artisan_finishes_v1", key, base, wallet, now), now, now),
            BoundCosmeticCompletion(now))
    }
    private fun awnings(marketLevel: Long, preference: Boolean = false, owned: Set<Int> = emptySet()): BoundCosmeticWorkshopState {
        val selected = BoundCosmeticSelectedBase.Available(base, emptyList(), emptyList(),
            listOf(BoundCosmeticCompletedFacility(building, marketLevel, now)), emptyList(),
            BoundCosmeticPreference(preference, "0"), BoundCosmeticBaseRead("available", BoundCosmeticBaseVisual(1, emptyList())))
        val view = BoundCosmeticWorkshopView(1, wallet, now, true, true, BoundCosmeticBlueprintEligibility("not-earned", null, null),
            (1..4).map { row(it) }, owned.map { ownedProof(it) }, selected)
        return BoundCosmeticWorkshopState(BoundCosmeticJournal(1, cosmetic, 0, null, emptyList()), view, advertised = true)
    }
    private fun owner(state: BoundCosmeticWorkshopState?, selectedTier: Int? = null, accountCurrent: Boolean = true,
        verifiedTiers: Map<String, Int> = verified) = workshopStyleOwnerUi(state, null, wallet, base,
        awningCurrent = state != null, wakeCurrent = false, accountCurrent = accountCurrent, busy = false, actionsAllowed = true,
        nativeAwningReady = true, verifiedTiers = verifiedTiers, completedMarketOutput = { "artisan_market_awning_t$it" },
        selectedTier = selectedTier, wakeSelected = false)

    @Test fun `MKT n comes only from the server completed Markets and every other hold stays HELD`() {
        // workshop-style.png: a tier above the Market reads "MKT n" and is dimmed. A blueprint or material hold is not a
        // Market lock, so it must never borrow that tag.
        val ui = owner(awnings(marketLevel = 2))
        assertEquals(2, ui.marketLevel)
        assertEquals(listOf("HELD", "HELD", "MKT 3", "MKT 4"), ui.awning.tiers.map { it.ownerTag })
        assertNull(ui.awning.tiers.first { it.tier == 2 }.lockReason)
        assertEquals("Market 3", ui.awning.tiers.first { it.tier == 3 }.lockReason!!.requirement)
        assertTrue(ui.awning.tiers.none { it.craftable })
    }

    @Test fun `a tier above every completed Market is the locked Market primary`() {
        val primary = owner(awnings(marketLevel = 2), selectedTier = 4).ownerControls!!.primary!!
        assertEquals(CommandState.LOCKED, primary.state)
        assertEquals("Market 4", primary.label)
        assertEquals(PrimaryAction.SHAKE, primary.action)
        assertEquals("Requires completed Market level 4.", primary.reason)
    }

    @Test fun `a held craft keeps its designed time line and says why it is held`() {
        val primary = owner(awnings(marketLevel = 2), selectedTier = 1).ownerControls!!.primary!!
        assertEquals("CRAFT AWNING I", primary.label)
        assertEquals("takes 1h 00m · once", primary.sub)
        assertEquals(CommandState.DISABLED, primary.state)
        assertTrue(primary.reason!!.contains("Blueprint"))
    }

    @Test fun `an owned tier a completed Market can show is the free green SHOW ON MARKET`() {
        val primary = owner(awnings(marketLevel = 2, owned = setOf(2)), selectedTier = 2).ownerControls!!.primary!!
        assertEquals("SHOW ON MARKET", primary.label)
        assertEquals(Verb.GREEN, primary.verb)
        assertEquals(PrimaryAction.SHOW, primary.action)
        assertEquals(CommandState.ENABLED, primary.state)
        assertNull(primary.price)
    }

    @Test fun `an owned tier above every completed Market is L Market n while awnings are hidden`() {
        // SPEC §2.7 owner-specific state: SHOW could not put this tier on any Market yet, so it is not offered.
        val ui = owner(awnings(marketLevel = 2, owned = setOf(3)), selectedTier = 3)
        assertEquals("OWNED", ui.awning.tiers.first { it.tier == 3 }.ownerTag)
        val primary = ui.ownerControls!!.primary!!
        assertEquals(CommandState.LOCKED, primary.state)
        assertEquals("Market 3", primary.label)
    }

    @Test fun `HIDE stays reachable from every owned tier while the kingdom shows awnings`() {
        // The owner keeps one kingdom-wide setting; whichever owned tier is selected, the player can still turn it off.
        val primary = owner(awnings(marketLevel = 2, preference = true, owned = setOf(3)), selectedTier = 3).ownerControls!!.primary!!
        assertEquals(PrimaryAction.HIDE, primary.action)
        assertEquals("HIDE", primary.label)
        assertEquals(Verb.STONE, primary.verb)
        assertEquals(CommandState.ENABLED, primary.state)
    }

    @Test fun `YOU NEED names the server input instead of printing its raw id`() {
        val ui = owner(awnings(marketLevel = 2), selectedTier = 1)
        assertEquals("Thornsilk", ui.items.getValue("thornsilk").name)
        assertEquals("Thornsilk", styleLines(ui).single().name)
        assertEquals(6L, styleLines(ui).single().need)
    }

    @Test fun `an unverified preview holds crafting with an off primary`() {
        // SPEC §2.7: previewVerified false shows "Preview unavailable. Crafting is held." and the primary is X.
        val ui = owner(awnings(marketLevel = 4), verifiedTiers = emptyMap())
        assertFalse(ui.awning.previewVerified)
        assertTrue(ui.awning.tiers.isEmpty())
        val primary = ui.ownerControls!!.primary!!
        assertEquals(CommandState.DISABLED, primary.state)
        assertEquals(PrimaryAction.SHAKE, primary.action)
        assertTrue(source("ui/sheets/craft/WorkshopStyleTab.kt").contains("\"Preview unavailable. Crafting is held.\""))
    }

    @Test fun `original requests are hidden rather than silently disabled without a current account`() {
        // A door never does nothing: with no current account the originals cannot open, so no control is drawn for them.
        assertFalse(owner(null, accountCurrent = false).ownerControls!!.canOpenOriginals)
        assertTrue(owner(null, accountCurrent = true).ownerControls!!.canOpenOriginals)
        val style = source("ui/sheets/craft/WorkshopStyleTab.kt")
        assertTrue(style.contains("if (owner.canOpenOriginals) SecondaryButton(\"ORIGINAL REQUESTS\", on.onHistory, Modifier.fillMaxWidth())"))
    }

    @Test fun `stale STYLE taps say why instead of doing nothing`() {
        val host = source("ui/economy/WorkshopStyleOwnerScreen.kt")
        assertTrue(host.contains("fun read(action: () -> Unit) { if (current()) action() else Toasts.post(\"Return to the current Workshop before continuing.\") }"))
    }

    @Test fun `the boat trail button and the preview line follow the frame`() {
        val style = source("ui/sheets/craft/WorkshopStyleTab.kt")
        assertTrue(style.contains("Modifier.size(84.dp, 44.dp)"))
        assertTrue(style.contains("\"For a level \${selected.requiredMarketLevel} Market. Crafted once, yours for good.\""))
        // The owner's status no longer sits between the section label and the tier picker.
        val body = style.substringAfter("fun ColumnScope.WorkshopStyleBody(").substringBefore("/** One TierPicker card")
        assertTrue(body.indexOf("SectionLabel(\"MARKET AWNING\"") < body.indexOf("PkwText(it.status"))
        assertTrue(body.indexOf("SectionLabel(\"BOAT TRAIL\"") < body.indexOf("PkwText(it.status"))
    }
    @Test fun `unknown preference never becomes a false hidden state`() {
        assertNull(styleAwningPreferencePrimary(null, true, false, true, true))
        assertFalse(styleWakePreferenceAllowed(null, true, false, true, true, true, true))
    }
    @Test fun `awning off stays available when verified artwork cannot be loaded`() {
        val primary = requireNotNull(styleAwningPreferencePrimary(true, true, false, true, false))
        assertEquals(PrimaryAction.HIDE, primary.action)
        assertEquals(CommandState.ENABLED, primary.state)
        assertTrue(primary.label.contains("HIDE"))
    }
    @Test fun `awning show needs the current matching owned appearance and application readiness`() {
        val held = requireNotNull(styleAwningPreferencePrimary(false, true, false, true, false))
        assertNotEquals(CommandState.ENABLED, held.state)
        val ready = requireNotNull(styleAwningPreferencePrimary(false, true, false, true, true))
        assertEquals(PrimaryAction.SHOW, ready.action)
        assertEquals(CommandState.ENABLED, ready.state)
        // Rewritten for workshop-style.png: the owned-tier primary carries the designed label; the PreviewCard's kingdom
        // setting line still says SHOW enables matching owned tiers rather than choosing one.
        assertEquals("SHOW ON MARKET", ready.label)
        assertEquals(Verb.GREEN, ready.verb)
        assertEquals(Verb.STONE, requireNotNull(styleAwningPreferencePrimary(true, true, false, true, true)).verb)
    }
    @Test fun `stale paused or busy owners cannot change the awning preference`() {
        for ((current, busy, allowed) in listOf(Triple(false, false, true), Triple(true, true, true), Triple(true, false, false))) {
            val value = styleAwningPreferencePrimary(true, current, busy, allowed, true)
            assertTrue(value == null || value.state != CommandState.ENABLED)
        }
    }
    @Test fun `wake off remains an account action without C5 admission or a selected kingdom`() {
        assertTrue(styleWakePreferenceAllowed(true, true, false, true, false, false, false))
        assertFalse(styleWakePreferenceAllowed(false, true, false, true, false, true, true))
        assertFalse(styleWakePreferenceAllowed(false, true, false, true, true, false, true))
        assertFalse(styleWakePreferenceAllowed(false, true, false, true, true, true, false))
        assertTrue(styleWakePreferenceAllowed(false, true, false, true, true, true, true))
    }
    @Test fun `wake preference retains currentness action and busy guards`() {
        assertFalse(styleWakePreferenceAllowed(true, false, false, true, false, false, false))
        assertFalse(styleWakePreferenceAllowed(true, true, true, true, false, false, false))
        assertFalse(styleWakePreferenceAllowed(true, true, false, false, false, false, false))
    }
    @Test fun `only verified appearance metadata supplies a tier`() {
        assertNull(styleVerifiedTier("artisan_market_awning_t4", emptyMap()))
        assertEquals(2, styleVerifiedTier("server-output", mapOf("server-output" to 2)))
        assertNull(styleVerifiedTier("other-output", mapOf("server-output" to 2)))
        assertNull(styleVerifiedTier("server-output", mapOf("server-output" to 0)))
    }
    @Test fun `normal STYLE mounts both existing owners and retires the old appearance dialog`() {
        val ordinary = source("ui/economy/OrdinaryWorkshopScreen.kt")
        assertTrue(ordinary.contains("WorkshopStyleOwnerScreen("))
        assertFalse(ordinary.contains("ORIGINAL APPEARANCE REQUESTS"))
        val host = source("ui/economy/WorkshopStyleOwnerScreen.kt")
        assertTrue(host.contains("WorkshopSheet("))
        assertTrue(host.contains("art.preview("))
        // Rewritten (c-gap-craft): the old awning / Aurora screens inside a chrome AlertDialog were the STYLE tab's last old
        // surface. The review is now the designed half sheet and the originals the designed records page; both still run
        // the owners' own verbs (review, confirm, check, archive), and no second lifecycle driver is started for them.
        assertFalse(host.contains("AlertDialog("))
        assertFalse(host.contains("BoundCosmeticWorkshopScreen("))
        assertTrue(host.contains("review = reviewUi"))
        assertTrue(host.contains("CraftRecordsOverlay("))
        for (call in listOf("awnings?.confirm(r, true)", "awnings.reviewSaved()", "awnings.check()", "awnings.archive()",
            "awnings.checkArchived(", "wake.check()", "wake.archive()", "wake.checkArchived("))
            assertTrue("Owner verb kept on the designed surface: $call", host.contains(call))
        // The confirm only runs where the old CRAFT AWNING button was enabled: not busy, orders allowed, verified art.
        assertTrue(host.contains("!actionsAllowed -> Toasts.post("))
        assertTrue(host.contains("!nativeReady -> Toasts.post("))
        assertTrue(host.contains("setPreference(false)"))
        assertFalse(host.contains("BoundCosmeticWorkshopRepository("))
        assertFalse(host.contains("BoundCosmeticWakeWorkshopRepository("))
    }
    @Test fun `both original permanent material consent implementations remain present`() {
        val awning = source("ui/economy/BoundCosmeticWorkshopScreen.kt")
        val wake = source("ui/economy/BoundCosmeticWakeWorkshopScreen.kt")
        assertTrue(awning.contains("model.confirm(review, consent)"))
        assertTrue(awning.contains("I agree to consume these materials permanently."))
        assertTrue(awning.contains("consent && !busy && actionsAllowed && nativeApplicationReady"))
        assertTrue(wake.contains("model.confirm(review, consent)"))
        assertTrue(wake.contains("consent && !busy && mutationsAllowed && nativeApplicationReady"))
        for (body in listOf(awning, wake)) {
            assertTrue(body.contains("model.reviewSaved()"))
            assertTrue(body.contains("model.checkArchived("))
            assertTrue(body.contains("model.archive()"))
        }
    }
    @Test fun `owner style bypasses preview defaults only through explicit owner controls`() {
        val sheet = source("ui/sheets/craft/WorkshopSheet.kt")
        val style = source("ui/sheets/craft/WorkshopStyleTab.kt")
        assertTrue(sheet.contains("ownerControls"))
        assertTrue(style.contains("canToggleWake"))
        assertTrue(style.contains("destinationsAvailable"))
        assertTrue(style.contains("on.style.preview"))
        // Rewritten: ORIGINAL REQUESTS is no longer a silent disabled control; without a current account it is not drawn.
        assertTrue(style.contains("if (owner.canOpenOriginals) SecondaryButton(\"ORIGINAL REQUESTS\""))
        assertFalse(style.contains("enabled = owner.canOpenOriginals"))
    }
    @Test fun `held cosmetic recipes retain visible ingredient requirements without fake Market locks`() {
        val style = source("ui/sheets/craft/WorkshopStyleTab.kt")
        assertTrue(style.contains("selected?.owned == false"))
        assertTrue(style.contains("ownerTag"))
        val mapper = source("ui/sheets/money/live/WorkshopStyleOwnerMapper.kt")
        assertTrue(mapper.contains("\"HELD\""))
    }
    @Test fun `account originals retain their completion receipts beyond the local journal`() {
        val awning = source("ui/economy/BoundCosmeticWorkshopScreen.kt")
        assertTrue(awning.contains("view?.originals?.filter"))
        assertTrue(awning.contains("requireNotNull(proof.completion).completedAt"))
        assertTrue(awning.contains("Owned by this account · one craft"))
    }
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
}
