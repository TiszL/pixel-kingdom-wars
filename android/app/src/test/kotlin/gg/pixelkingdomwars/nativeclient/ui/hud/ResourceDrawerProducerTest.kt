package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.ui.model.*
import org.junit.Assert.*
import org.junit.Test

/** Authored before the producer. Requires B ResourceCatalogue and M hudAmountText at composition. */
class ResourceDrawerProducerTest {
    private val wallet = "resource-owner"
    private val base = "base-a"
    private val account = AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(wallet), selectedBaseId = base)
    private val scope = ResourceScope(wallet = wallet, baseId = base)
    private val workshop = FeatureId("workshop.refine")
    private val metadata = listOf(
        ResourceDrawerSection("everyday", "EVERY DAY", "", "", ResourceGroupLayout.WIDE_ROWS,
            listOf(ResourceDrawerEntry("shards", "SHARDS", "shards", "Builds your kingdom.", "Mine"))),
        ResourceDrawerSection("workshop", "WORKSHOP", "ui:workshop-menu", "refined materials", ResourceGroupLayout.TILE_STRIP,
            listOf(ResourceDrawerEntry("plank", "PLANK", "admitted:plank", "A building material.", "Workshop"))),
    )
    private fun resource(id: String = "plank", amount: ResourceAmount = ResourceAmount.Known("12", 0)) =
        ResourceRow(id, "admitted:$id", amount, listOf(workshop), emptyList(), scope = scope)
    private fun map(rows: List<ResourceRow> = listOf(resource()), current: AccountState = account,
        scopes: Map<String, ResourceScope> = mapOf("shards" to scope, "plank" to scope),
        sections: List<ResourceDrawerSection> = metadata, focus: String? = null, linked: Boolean = false) =
        resourceDrawerUi(rows, current, scopes, sections, focus, linked)
    private fun ResourceDrawerUi.row(id: String) = groups.flatMap { it.rows }.single { it.id == id }

    @Test fun `maps admitted rows into caller catalogued groups and keeps exact focus`() {
        val ui = map(focus = "plank")
        assertEquals(listOf("everyday", "workshop"), ui.groups.map { it.id })
        assertEquals("plank", ui.focusRowId)
        assertEquals("12", ui.row("plank").value)
        assertEquals("admitted:plank", ui.row("plank").icon)
        assertEquals(workshop, ui.row("plank").earnedAtFeature)
        assertEquals("…", ui.row("shards").value)
    }

    @Test fun `missing or unknown observations are never zero or empty`() {
        for (amount in listOf(ResourceAmount.Loading, ResourceAmount.Unavailable("refresh"))) {
            val row = map(listOf(resource(amount = amount))).row("plank")
            assertEquals("…", row.value)
            assertFalse(row.empty)
        }
        assertEquals("…", map(emptyList()).row("plank").value)
        assertFalse(map(emptyList()).row("plank").empty)
    }

    @Test fun `observed absence and exact known zero remain distinct`() {
        val absent = map(listOf(resource(amount = ResourceAmount.Absent))).row("plank")
        assertEquals("—", absent.value)
        assertFalse(absent.empty)
        val zero = map(listOf(resource(amount = ResourceAmount.Known("0", 9)))).row("plank")
        assertEquals("0", zero.value)
        assertTrue(zero.empty)
        assertEquals(workshop, zero.earnedAtFeature)
    }

    @Test fun `scales base units exactly once without floating point or signed long truncation`() {
        val amount = ResourceAmount.Known("123456789012345678901234567891", 9)
        assertEquals("123,456,789,012,345,678,901.234567891", map(listOf(resource(amount = amount))).row("plank").value)
        val decimal = ResourceAmount.Known("0.000000001", 9, ResourceUnit.DECIMAL)
        assertEquals("0.000000001", map(listOf(resource(amount = decimal))).row("plank").value)
    }

    @Test fun `invalid quantity syntax or excess precision stays unknown`() {
        for (amount in listOf(ResourceAmount.Known("01", 0), ResourceAmount.Known("-1", 0),
            ResourceAmount.Known("1e9", 0), ResourceAmount.Known("1.001", 2, ResourceUnit.DECIMAL))) {
            assertEquals("…", map(listOf(resource(amount = amount))).row("plank").value)
        }
    }

    @Test fun `duplicate matching producers do not select or add a balance`() {
        val original = resource()
        assertEquals("…", map(listOf(original, original.copy())).row("plank").value)
        assertNull(map(listOf(original, original.copy())).row("plank").earnedAtFeature)
    }

    @Test fun `held claimable progression and partial observations cannot fund a spendable row`() {
        for (kind in listOf(ResourceBalanceKind.HELD, ResourceBalanceKind.CLAIMABLE, ResourceBalanceKind.PROGRESSION)) {
            assertEquals("…", map(listOf(resource().copy(kind = kind))).row("plank").value)
        }
        assertEquals("…", map(listOf(resource().copy(coverage = ResourceCoverage.PARTIAL))).row("plank").value)
    }

    @Test fun `other wallet base or opaque subject never supplies the requested scope`() {
        for (other in listOf(scope.copy(wallet = "other"), scope.copy(baseId = "other"), scope.copy(subject = "held"))) {
            assertEquals("…", map(listOf(resource().copy(scope = other))).row("plank").value)
        }
        assertEquals("…", map(current = account.copy(selectedBaseId = "other")).row("plank").value)
        assertEquals("…", map(current = account.copy(phase = AccountPhase.SIGNED_OUT)).row("plank").value)
        assertEquals("…", map(scopes = emptyMap()).row("plank").value)
    }

    @Test fun `shards and gems reject wallet only scope`() {
        val walletOnly = ResourceScope(wallet = wallet)
        val row = resource("shards").copy(scope = walletOnly)
        assertEquals("…", map(listOf(row), scopes = mapOf("shards" to walletOnly)).row("shards").value)
    }

    @Test fun `KEEP needs explicitly observed wallet linkage and never a custodial substitute`() {
        val entry = ResourceDrawerEntry("keep", "KEEP", "keep", "Wallet token", "Wallet")
        val section = metadata.first().copy(entries = listOf(entry))
        val walletScope = ResourceScope(wallet = wallet)
        val row = resource("keep", ResourceAmount.Known("7", 0)).copy(scope = walletScope)
        assertTrue(map(listOf(row), scopes = mapOf("keep" to walletScope), sections = listOf(section)).groups.isEmpty())
        assertEquals("7", map(listOf(row), scopes = mapOf("keep" to walletScope), sections = listOf(section), linked = true).row("keep").value)
        assertTrue(map(listOf(row), current = account.copy(identity = null), sections = listOf(section), linked = true).groups.isEmpty())
    }

    @Test fun `SOL is excluded even if included by the presentation catalog`() {
        val section = metadata.first().copy(entries = listOf(ResourceDrawerEntry("sol", "SOL", "sol", "fee", "Wallet")))
        assertTrue(map(listOf(resource("sol")), sections = listOf(section)).groups.isEmpty())
    }

    @Test fun `ambiguous earned destinations do not guess one and no money actions are manufactured`() {
        val row = map(listOf(resource().copy(earnedAt = listOf(workshop, FeatureId("building.harvester"))))).row("plank")
        assertNull(row.earnedAtFeature)
        assertNull(row.action)
        assertNull(row.actionLabel)
    }

    @Test fun `unknown focus falls back through the kit and duplicate metadata is refused`() {
        assertNull(map(focus = "not-a-row").focusRowId)
        try {
            map(sections = metadata + metadata.last().copy(id = "other"))
            fail("duplicate resource descriptor must be refused")
        } catch (_: IllegalArgumentException) { }
    }

    @Test fun `output collections detach from mutable caller metadata and observations`() {
        val rows = mutableListOf(resource())
        val sections = metadata.toMutableList()
        val ui = map(rows, sections = sections)
        rows.clear(); sections.clear()
        assertEquals(2, ui.groups.size)
        assertEquals("12", ui.row("plank").value)
    }

    @Test fun `Gems also requires a selected base scope and partial zero remains unknown`() {
        val section = metadata.first().copy(entries = listOf(ResourceDrawerEntry("gems", "GEMS", "gem", "Currency", "Gold Forge")))
        val walletOnly = ResourceScope(wallet = wallet)
        assertEquals("…", map(listOf(resource("gems").copy(scope = walletOnly)),
            scopes = mapOf("gems" to walletOnly), sections = listOf(section)).row("gems").value)
        val partial = resource(amount = ResourceAmount.Known("0", 0)).copy(coverage = ResourceCoverage.PARTIAL)
        val row = map(listOf(partial)).row("plank")
        assertEquals("…", row.value)
        assertFalse(row.empty)
    }

    @Test fun `linked wallet cannot turn base scoped custodial KEEP into wallet KEEP`() {
        val section = metadata.first().copy(entries = listOf(ResourceDrawerEntry("keep", "KEEP", "keep", "Wallet", "Wallet")))
        val scoped = map(listOf(resource("keep")), scopes = mapOf("keep" to scope), sections = listOf(section), linked = true)
        assertEquals("…", scoped.row("keep").value)
        assertNull(scoped.row("keep").earnedAtFeature)
        assertTrue(map(listOf(resource("keep")), current = account.copy(phase = AccountPhase.SIGNED_OUT),
            scopes = mapOf("keep" to scope), sections = listOf(section), linked = true).groups.isEmpty())
    }

    @Test fun `group GO and explicit row action preserve only destinations admitted by the resource owner`() {
        val bid = FeatureId("island.seeker.bid")
        val row = resource("skr").copy(spentAt = listOf(bid))
        val section = metadata.first().copy(go = workshop, entries = listOf(
            ResourceDrawerEntry("skr", "SKR", "skr", "Bids", "Seeker Island", actionLabel = "BID", action = bid)))
        val ui = map(listOf(row), scopes = mapOf("skr" to scope), sections = listOf(section))
        assertEquals(workshop, ui.groups.single().go)
        assertEquals(bid, ui.row("skr").action)
        assertEquals("BID", ui.row("skr").actionLabel)
    }

    @Test fun `presentation metadata alone cannot create a group or row action`() {
        val invented = FeatureId("unadmitted.destination")
        val section = metadata.last().copy(go = invented, entries = listOf(
            metadata.last().entries.single().copy(action = invented, actionLabel = "GO")))
        for (rows in listOf(listOf(resource()), emptyList())) {
            val ui = map(rows, sections = listOf(section))
            assertNull(ui.groups.single().go)
            assertNull(ui.row("plank").action)
            assertNull(ui.row("plank").actionLabel)
        }
    }
}
