package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.charter.charterObject
import gg.pixelkingdomwars.nativeclient.charter.charterText
import gg.pixelkingdomwars.nativeclient.data.StarterFleetHydration
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.data.VehicleFixtures
import gg.pixelkingdomwars.nativeclient.data.VehicleJournal
import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.BaseServicePresentation
import gg.pixelkingdomwars.nativeclient.model.BerthPresentation
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.model.StarterPresence
import gg.pixelkingdomwars.nativeclient.model.StarterPresentation
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import java.time.Instant
import java.util.Locale
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Authored adapter contracts only: no wallet, repository effect, clock, or runner is invoked here. */
class BerthMoneyMapperTest {
    private val f = VehicleFixtures
    private val identity = VehicleProtocol.original(f.client).charterObject("identity")
    private val family = VehicleFamily.valueOf(identity.charterText("family").uppercase(Locale.ROOT))
    private val tier = identity.getValue("tier").jsonPrimitive.int
    private val installationId = VehicleProtocol.reference(f.client).charterText("id")
    private val now = Instant.parse("2035-01-01T00:00:01.000Z").toEpochMilli()
    private val account = StarterIdentity("https://berth-mapper.test", "devnet", f.wallet)
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun base() = BaseSnapshot(
        baseId = f.base, visualContext = null, player = PlayerSummary(wallet = f.wallet, keepLevel = 1),
        energy = null, armyStatus = null, claim = null,
        buildings = listOf(Building(f.berth, "berth", 3, 0, 0)), obstacles = emptyList(), jobs = emptyList(),
        freeBuilders = 0, raw = buildJsonObject {},
    )
    private fun row(remaining: Long = f.policy.completedUses, away: Boolean = false, pending: Boolean = false,
        rowTier: Int = tier, installedId: String = installationId, berth: String = f.berth,
        rowFamily: String = identity.charterText("family")) = buildJsonObject {
        put("installationId", installedId); put("berthId", berth); put("family", rowFamily); put("tier", rowTier)
        put("revision", 0); put("completedTotal", (f.policy.completedUses - remaining).toString())
        put("allowanceStart", "0"); put("remainingUses", remaining); put("away", away); put("pendingService", pending)
    }
    private fun fleet(rows: List<JsonObject> = listOf(row()), baseId: String = f.base,
        wallet: String = f.wallet, accepting: Boolean = true) = buildJsonObject {
        put("version", 1); put("wallet", wallet); put("baseId", baseId); put("serverNow", "2035-01-01T00:00:01.000Z")
        put("acceptingNewActions", accepting); put("vehicles", JsonArray(rows))
    }
    private fun assets(identities: List<JsonObject> = listOf(identity), cursor: String? = null,
        wallet: String = f.wallet) = buildJsonObject {
        put("version", 2); put("wallet", wallet); put("nextCursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
        put("items", JsonArray(identities.map { asset -> buildJsonObject {
            put("identity", asset); put("observedSlot", 100)
            put("provenance", buildJsonObject { put("kind", "owner_attested") })
        } }))
    }
    private fun state(fleet: JsonObject? = fleet(), assets: JsonObject? = assets()) =
        VehicleState(loaded = true, fleet = fleet, assets = assets)
    private fun record(client: JsonObject? = f.client, kind: String = "installation") = VehicleRecord(
        id = id(90), kind = kind, key = (client?.let(VehicleProtocol::request) ?: f.request).charterText("idempotencyKey"),
        request = client?.let(VehicleProtocol::request) ?: f.request, policy = f.policy.raw,
        response = client, destination = client?.let(VehicleProtocol::destination),
    )
    private fun selected(record: VehicleRecord, review: JsonObject? = null, current: VehicleState = state()) = current.copy(
        journal = VehicleJournal(identity = account, pending = listOf(record)), selectedId = record.id, review = review,
    )
    private fun starter(installed: Boolean = false): StarterFleetState {
        val berth = StarterFleetBerth(f.berth, id(82), "2035-01-01T00:00:00.000Z")
        val installation = if (installed) StarterFleetInstallation(id(83), f.base, f.berth, "starter",
            berth.completedBuildJobId, berth.berthCompletedAt, "2035-01-01T00:00:00.000Z") else null
        return StarterFleetState(StarterFleetJournal(1, account, 0, null, emptyList()),
            view = StarterFleetView(f.wallet, f.base, "2035-01-01T00:00:01.000Z",
                StarterFleetFeatures(StarterFleetFeature(1, 1)), true, installation, listOf(berth)), advertised = true)
    }
    private fun render(vehicles: VehicleState = state(), starter: StarterFleetState? = null,
        snapshot: BaseSnapshot? = base(), policy: VehiclePolicy? = f.policy, wallet: String? = f.wallet,
        allowed: Boolean = true, configured: Boolean = true, at: Long = now, tab: String = "FLEET",
        section: String? = null, selectedFamily: VehicleFamily? = family,
        selectedInstallation: String? = installationId, selectedAsset: String? = identity.charterText("assetId"),
        op: ServiceOp? = ServiceOp.UPGRADE, baseCurrent: Boolean = true, fleetCurrent: Boolean = true,
        assetsCurrent: Boolean = true, starterCurrent: Boolean = true, assetsComplete: Boolean = true): BerthSheetUi = berthMoneySheetUi(
        base = snapshot, vehicles = vehicles, starter = starter, policy = policy, wallet = wallet,
        ordersAllowed = allowed, configured = configured, nowMs = at, tab = tab, section = section,
        selectedFamily = selectedFamily, selectedInstallationId = selectedInstallation,
        selectedAssetId = selectedAsset, selectedOp = op,
        // Positive fixtures model a fresh owner-admitted bundle. Production defaults must stay closed.
        baseCurrent = baseCurrent, fleetCurrent = fleetCurrent, assetsCurrent = assetsCurrent,
        starterCurrent = starterCurrent, assetsComplete = assetsComplete,
    )

    private data class ServiceBundle(val base: BaseSnapshot, val state: VehicleState, val row: JsonObject,
        val asset: JsonObject, val installedId: String)

    private fun serviceBundle(policy: VehiclePolicy = f.policy): ServiceBundle {
        val client = f.rows.first { it.charterObject("client").charterText("kind") == "service" }.charterObject("client")
        val original = VehicleProtocol.original(client)
        val terms = original.charterObject("state")
        val asset = original.charterObject("identity")
        val currentRow = buildJsonObject {
            for (key in listOf("installationId", "berthId", "family", "tier", "revision", "completedTotal", "allowanceStart")) {
                put(key, terms.getValue(key))
            }
            put("remainingUses", policy.completedUses - terms.getValue("completedTotal").jsonPrimitive.content.toLong() +
                terms.getValue("allowanceStart").jsonPrimitive.content.toLong())
            put("away", false); put("pendingService", false)
        }
        val currentBase = base().copy(baseId = terms.charterText("baseId"),
            buildings = listOf(base().buildings.single().copy(id = terms.charterText("berthId"))))
        val saved = record(client, "service").copy(policy = policy.raw)
        val current = selected(saved, f.review(client), state(fleet(listOf(currentRow), baseId = currentBase.baseId!!), assets(listOf(asset))))
        return ServiceBundle(currentBase, current, currentRow, asset, terms.charterText("installationId"))
    }

    private fun reviewedService(bundle: ServiceBundle, vehicles: VehicleState = bundle.state,
        policy: VehiclePolicy = f.policy, at: Long = now) = render(vehicles, snapshot = bundle.base, policy = policy,
        selectedInstallation = bundle.installedId, selectedAsset = bundle.asset.charterText("assetId"), at = at).service

    @Test fun `quay uses current fleet identities trips and fixed family order`() {
        val ui = render()
        assertEquals(VehicleFamily.entries, ui.quay.map { it.family })
        val installed = ui.quay.single { it.family == family }
        assertEquals(installationId, installed.installationId)
        assertEquals(f.berth, installed.berthId)
        assertEquals(tier, installed.tier)
        assertEquals(f.policy.completedUses.toInt(), installed.tripsLeft)
        assertEquals(f.policy.completedUses.toInt(), installed.tripsMax)
        assertEquals(VehicleStatus.DOCKED, installed.status)
        assertTrue(ui.quay.filter { it.family != family }.all { it.installationId == null && it.tier == null })
    }

    @Test fun `away and service state take precedence over an exhausted allowance without inventing return time`() {
        for ((away, pending, expected) in listOf(Triple(true, false, VehicleStatus.AWAY),
            Triple(false, true, VehicleStatus.BUSY_SERVICE), Triple(false, false, VehicleStatus.WORN_OUT))) {
            val vehicle = render(state(fleet(listOf(row(0, away, pending))))).quay.single { it.family == family }
            assertEquals(expected, vehicle.status)
            assertEquals(if (away) "…" else null, vehicle.returnsAt)
        }
    }

    @Test fun `missing malformed and cross kingdom fleet never become actionable empty berths`() {
        val invalid = listOf(null, buildJsonObject {}, fleet(baseId = id(92)), fleet(wallet = identity.charterText("assetId")),
            fleet(listOf(row(), row())))
        invalid.forEach { raw ->
            val ui = render(state(fleet = raw))
            assertTrue(ui.fleet?.ordersAllowed != true)
            assertTrue(ui.service.options.none { it.available })
            assertNull(ui.install)
        }
    }

    @Test fun `unknown or uncompleted base cannot enable new money actions`() {
        for (snapshot in listOf(null, base().copy(buildings = emptyList()),
            base().copy(buildings = listOf(base().buildings.single().copy(underConstruction = true))))) {
            val ui = render(snapshot = snapshot, section = "install", vehicles = state(fleet(emptyList())))
            assertTrue(ui.fleet?.ordersAllowed != true)
            assertNull(ui.install)
            assertTrue(ui.service.options.none { it.available })
        }
    }

    @Test fun `wallet assets are read from validated nested identities and preserve paging`() {
        val ui = render(state(fleet(emptyList()), assets(cursor = "page-two")), section = "install")
        val picker = requireNotNull(ui.install)
        assertEquals(listOf(OwnedVehicleUi(identity.charterText("assetId"), tier)), picker.assets)
        assertEquals("page-two", picker.cursor)
        assertNull(ui.fleet?.walletAssetsByFamily)
        assertNull(picker.feeSol)
        assertEquals(VoyageSealState.IDLE, picker.sealState)
    }

    @Test fun `unknown malformed and foreign wallet inventory cannot supply a hand in`() {
        for (raw in listOf(null, buildJsonObject {}, assets(wallet = identity.charterText("assetId")),
            assets(listOf(identity, identity)))) {
            val ui = render(state(assets = raw))
            assertNull(ui.fleet?.walletAssetsByFamily)
            assertNull(ui.service.handIn)
            assertNull(ui.service.walletCount)
        }
    }

    @Test fun `service rules use the catalogue next tier and allowance without hard coded tuning`() {
        val raw = f.change(f.change(f.policy.raw, "vehicles.tiers", JsonArray(listOf(JsonPrimitive(tier), JsonPrimitive(tier + 2)))),
            "vehicles.completedUsesPerInstall", JsonPrimitive(7))
        val policy = VehiclePolicy.from(raw)
        val current = f.change(row(0), "completedTotal", JsonPrimitive("7"))
        val service = render(state(fleet(listOf(current))), policy = policy).service
        val restore = service.options.single { it.op == ServiceOp.RESTORE_USES }
        val upgrade = service.options.single { it.op == ServiceOp.UPGRADE }
        assertTrue(restore.available)
        assertEquals(7, restore.resultTrips)
        assertTrue(upgrade.available)
        assertEquals(tier + 2, upgrade.resultTier)
    }

    @Test fun `restoration requires exhaustion and upgrade refuses the catalogue maximum`() {
        val full = render().service.options.single { it.op == ServiceOp.RESTORE_USES }
        assertFalse(full.available)
        val max = f.policy.tiers.last().toInt()
        val owned = JsonObject(identity + ("tier" to JsonPrimitive(max)))
        val service = render(state(fleet(listOf(row(0, rowTier = max))), assets(listOf(owned)))).service
        assertTrue(service.options.single { it.op == ServiceOp.RESTORE_USES }.available)
        assertFalse(service.options.single { it.op == ServiceOp.UPGRADE }.available)
    }

    @Test fun `hand in must match installed family and current tier`() {
        val wrong = JsonObject(identity + ("tier" to JsonPrimitive(tier + 1)))
        assertNull(render(state(assets = assets(listOf(wrong)))).service.handIn)
        assertEquals(0, render(state(assets = assets(emptyList()))).service.walletCount)
        assertEquals(identity.charterText("assetId"), render().service.handIn?.assetId)
    }

    @Test fun `read only paused busy unconfigured and missing policy disable service options`() {
        val cases = listOf(render(allowed = false), render(configured = false), render(policy = null),
            render(state(fleet(accepting = false))), render(state().copy(busy = true)),
            render(state(fleet(listOf(row(pending = true))))))
        cases.forEach { ui ->
            assertTrue(ui.service.options.none { it.available })
            assertNull(ui.service.feeSol)
        }
    }

    @Test fun `only matching live review supplies the exact network fee to install`() {
        val current = selected(record(), f.review(), state(fleet(emptyList())))
        val ui = render(current, section = "install")
        assertEquals("0.000005", requireNotNull(ui.install).feeSol)
        val wrong = f.change(f.review(), "reference.id", JsonPrimitive(id(94)))
        for (candidate in listOf(current.copy(review = null), current.copy(review = wrong), current.copy(selectedId = null))) {
            assertNull(render(candidate, section = "install").install?.feeSol)
        }
        assertNull(render(current, section = "install", at = Instant.parse("2035-01-01T00:00:31.000Z").toEpochMilli()).install?.feeSol)
        assertNull(render(current, section = "install", at = Instant.parse("2034-12-31T23:59:59.000Z").toEpochMilli()).install?.feeSol)
    }

    @Test fun `wallet attempt and retained signature never become sent completion`() {
        for (saved in listOf(record().copy(attempts = listOf("wallet")),
            record(f.signed()).copy(attempts = listOf("wallet"), signed = f.wire))) {
            val ui = render(selected(saved, current = state(fleet(emptyList()))), section = "install")
            val picker = requireNotNull(ui.install)
            assertEquals(VoyageSealState.ERROR, picker.sealState)
            assertNull(picker.feeSol)
            assertEquals(family, ui.fleet?.pendingInstallFamily)
        }
    }

    @Test fun `uncertain service error remains nonauthoritative recoverable with no synthetic fee`() {
        val client = f.rows.first { it.charterObject("client").charterText("kind") == "service" }.charterObject("client")
        val original = VehicleProtocol.original(client)
        val serviceIdentity = original.charterObject("identity")
        val originalState = original.charterObject("state")
        val installedId = originalState.charterText("installationId")
        val currentRow = row(installedId = installedId, berth = originalState.charterText("berthId"),
            rowFamily = serviceIdentity.charterText("family"), rowTier = serviceIdentity.getValue("tier").jsonPrimitive.int)
        val currentBase = base().copy(baseId = originalState.charterText("baseId"),
            buildings = listOf(base().buildings.single().copy(id = originalState.charterText("berthId"))))
        val saved = record(client, "service").copy(attempts = listOf("wallet"))
        val current = selected(saved, current = state(fleet(listOf(currentRow), baseId = currentBase.baseId!!), assets(listOf(serviceIdentity))))
            .copy(error = "OWNERSHIP was mentioned in an unstructured timeout")
        val service = render(current, snapshot = currentBase, selectedInstallation = installedId).service
        assertEquals(VoyageSealState.ERROR, service.sealState)
        val error = requireNotNull(service.error)
        assertFalse(error.authoritative)
        assertTrue(error.recoverable)
        assertNull(service.feeSol)
    }

    @Test fun `starter availability requires current matching positive server eligibility`() {
        val source = starter()
        val originalView = requireNotNull(source.view)
        assertTrue(requireNotNull(render(state(fleet(emptyList())), starter = source, section = "starter").starter).available)
        for (view in listOf(null, originalView.copy(baseId = id(96)), originalView.copy(wallet = identity.charterText("assetId")),
            originalView.copy(acceptingInstallations = false), originalView.copy(eligibleBerths = emptyList()))) {
            val ui = render(state(fleet(emptyList())), starter = source.copy(view = view), section = "starter")
            val panel = requireNotNull(ui.starter)
            assertFalse(panel.available)
            assertFalse(panel.installed)
        }
    }

    @Test fun `retained accepted starter proof never substitutes for a current installation`() {
        val source = starter(installed = true)
        val view = source.view!!
        val command = StarterFleetCommand(StarterFleetRequest(id(97), f.base, f.berth), view.eligibleBerths.single(), null)
        val proof = StarterFleetProof(f.wallet, command.key, view.serverNow, "accepted",
            StarterFleetReceipt(f.wallet, command.request, view.installation!!, view.serverNow))
        val saved = source.copy(view = null, hydration = StarterFleetHydration.ORIGINAL_BASE_UNAVAILABLE,
            journal = source.journal.copy(revision = 1, operation = StarterFleetOperation(command, 1, proof, null)))
        val ui = render(state(fleet(emptyList())), starter = saved, section = "starter")
        val panel = requireNotNull(ui.starter)
        assertFalse(panel.installed)
        assertFalse(panel.available)
        assertNull(ui.quay.first().installationId)
    }

    @Test fun `current starter installation is read from its own endpoint and never receives service`() {
        val source = starter(installed = true)
        // The installation endpoint alone does not say whether this boat is docked or at sea.
        val current = base().copy(servicePresentation = BaseServicePresentation(1,
            listOf(BerthPresentation(f.berth, StarterPresentation("starter", StarterPresence.OCCUPIED)))))
        val ui = render(state(fleet(emptyList())), starter = source, snapshot = current, selectedFamily = VehicleFamily.STARTER)
        assertEquals(source.view!!.installation!!.installationId, ui.quay.first().installationId)
        assertNull(ui.quay.first().tier)
        assertNull(ui.quay.first().tripsMax)
        assertTrue(ui.service.installed.isEmpty())
    }

    @Test fun `missing starter presence never invents docked status or enables send`() {
        val ui = render(state(fleet(emptyList())), starter = starter(installed = true),
            selectedFamily = VehicleFamily.STARTER)
        assertNotEquals(VehicleStatus.DOCKED, ui.quay.first().status)
        assertNull(ui.selectedFamily)
        assertNull(ui.fleet?.selectedFamily)
        assertTrue(ui.starter?.available != true)
    }

    @Test fun `owner currentness defaults closed despite matching retained loaded snapshots`() {
        val ui = berthMoneySheetUi(base(), state(), starter(), f.policy, f.wallet, true, true, now,
            section = "starter", selectedFamily = family, selectedInstallationId = installationId,
            selectedAssetId = identity.charterText("assetId"), selectedOp = ServiceOp.UPGRADE)
        assertTrue(ui.quay.none { it.installationId != null })
        assertTrue(ui.fleet?.ordersAllowed != true)
        assertTrue(ui.service.options.none { it.available })
        assertNull(ui.service.feeSol)
        assertTrue(ui.starter?.available != true)
    }

    @Test fun `returning to the same base does not readmit retained fleet assets or starter generations`() {
        // A -> B -> A can preserve these identical wire bytes; owner admission is invalidated independently.
        val current = selected(record(), f.review(), state(fleet(emptyList())))
        val baseStale = render(current, section = "install", baseCurrent = false)
        val fleetStale = render(current, section = "install", fleetCurrent = false)
        for (ui in listOf(baseStale, fleetStale)) {
            assertTrue(ui.fleet?.ordersAllowed != true)
            assertNull(ui.install?.feeSol)
            assertTrue(ui.quay.none { it.installationId != null })
        }
        val assetsStale = render(current, section = "install", assetsCurrent = false)
        assertTrue(assetsStale.install?.assets.isNullOrEmpty())
        assertNull(assetsStale.install?.feeSol)
        assertNull(assetsStale.fleet?.walletAssetsByFamily)
        val starterStale = render(state(fleet(emptyList())), starter = starter(), section = "starter", starterCurrent = false)
        assertFalse(requireNotNull(starterStale.starter).available)
        assertNull(starterStale.quay.first().installationId)
    }

    @Test fun `currentness flags never override unloaded busy or failed native vehicle state`() {
        val candidates = listOf(state().copy(loaded = false), state().copy(busy = true), state().copy(error = "Read failed"))
        candidates.forEach { candidate ->
            val ui = render(candidate)
            assertTrue(ui.fleet?.ordersAllowed != true)
            assertTrue(ui.service.options.none { it.available })
            assertNull(ui.service.feeSol)
        }
    }

    @Test fun `starter journal operation blocks new installation in every base`() {
        val source = starter()
        val currentView = requireNotNull(source.view)
        val command = StarterFleetCommand(StarterFleetRequest(id(111), id(112), f.berth), currentView.eligibleBerths.single(), null)
        val operation = StarterFleetOperation(command, null, null, null)
        val retained = source.copy(journal = source.journal.copy(operation = operation))
        val ui = render(state(fleet(emptyList())), starter = retained, section = "starter")
        val panel = requireNotNull(ui.starter)
        assertFalse(panel.available)
        assertFalse(panel.installed)
        assertNotNull(panel.reason)
    }

    @Test fun `starter installation requires current healthy fleet and idle starter source`() {
        val source = starter()
        val candidates = listOf(
            render(state(fleet(emptyList())).copy(loaded = false), starter = source, section = "starter"),
            render(state(fleet(emptyList())).copy(busy = true), starter = source, section = "starter"),
            render(state(fleet(emptyList())).copy(error = "Refresh failed"), starter = source, section = "starter"),
            render(state(fleet = null), starter = source, section = "starter"),
            render(state(fleet(emptyList())), starter = source, section = "starter", fleetCurrent = false),
            render(state(fleet(emptyList())), starter = source.copy(busy = true), section = "starter"),
        )
        candidates.forEach { assertFalse(requireNotNull(it.starter).available) }
    }

    @Test fun `terminal asset page is not complete inventory without explicit owner witness`() {
        val ui = render(assetsComplete = false)
        assertNull(ui.fleet?.walletAssetsByFamily)
        assertNull(ui.service.walletCount)
        assertEquals(identity.charterText("assetId"), ui.service.handIn?.assetId)
        val anotherPage = render(state(assets = assets(emptyList())), assetsComplete = false)
        assertNull(anotherPage.fleet?.walletAssetsByFamily)
        assertNull(anotherPage.service.walletCount)
    }

    @Test fun `reviewed install cannot arm when another family now occupies its exact destination`() {
        val other = VehicleFamily.entries.first { it != family && it != VehicleFamily.STARTER }
        val occupied = row(installedId = id(114), rowFamily = other.name.lowercase(Locale.ROOT))
        val current = selected(record(), f.review(), state(fleet(listOf(occupied))))
        val picker = requireNotNull(render(current, section = "install").install)
        assertNull(picker.feeSol)
        assertEquals(VoyageSealState.ERROR, picker.sealState)
        val seal = installSealV2(picker.family, OwnedVehicleUi(identity.charterText("assetId"), tier),
            picker.feeSol, picker.sealState, now)
        assertEquals(SealV2Primary.CHECK, sealV2Primary(seal))
    }

    @Test fun `reviewed install cannot arm when authoritative starter occupies its exact destination`() {
        val currentBase = base().copy(servicePresentation = BaseServicePresentation(1,
            listOf(BerthPresentation(f.berth, StarterPresentation("starter", StarterPresence.OCCUPIED)))))
        val current = selected(record(), f.review(), state(fleet(emptyList())))
        val picker = requireNotNull(render(current, starter = starter(installed = true), snapshot = currentBase, section = "install").install)
        assertNull(picker.feeSol)
        assertEquals(VoyageSealState.ERROR, picker.sealState)
        val seal = installSealV2(picker.family, OwnedVehicleUi(identity.charterText("assetId"), tier),
            picker.feeSol, picker.sealState, now)
        assertEquals(SealV2Primary.CHECK, sealV2Primary(seal))
    }

    @Test fun `reviewed install cannot arm when its family already occupies a different completed berth`() {
        val otherBerth = id(115)
        val currentBase = base().copy(buildings = base().buildings + Building(otherBerth, "berth", 3, 1, 0))
        val elsewhere = row(installedId = id(116), berth = otherBerth)
        val current = selected(record(), f.review(), state(fleet(listOf(elsewhere))))
        val picker = requireNotNull(render(current, snapshot = currentBase, section = "install").install)
        assertNull(picker.feeSol)
        assertEquals(VoyageSealState.ERROR, picker.sealState)
        val seal = installSealV2(picker.family, OwnedVehicleUi(identity.charterText("assetId"), tier),
            picker.feeSol, picker.sealState, now)
        assertEquals(SealV2Primary.CHECK, sealV2Primary(seal))
    }

    @Test fun `matching current service original and live review supply the actual fee`() {
        val bundle = serviceBundle()
        val service = reviewedService(bundle)
        assertEquals("0.000005", service.feeSol)
        assertEquals(SealV2Primary.ARMING, sealV2Primary(requireNotNull(serviceSealV2(service, now))))
    }

    @Test fun `changed current service revision counters or away state keep original in check`() {
        val bundle = serviceBundle()
        val completed = bundle.row.getValue("completedTotal").jsonPrimitive.content.toLong()
        val start = bundle.row.getValue("allowanceStart").jsonPrimitive.content.toLong()
        val remaining = bundle.row.getValue("remainingUses").jsonPrimitive.long
        val changed = listOf(
            f.change(bundle.row, "revision", JsonPrimitive(1)),
            f.change(f.change(bundle.row, "completedTotal", JsonPrimitive((completed + 1).toString())), "remainingUses", JsonPrimitive(remaining - 1)),
            f.change(f.change(bundle.row, "allowanceStart", JsonPrimitive((start + 1).toString())), "remainingUses", JsonPrimitive(remaining + 1)),
            f.change(bundle.row, "away", JsonPrimitive(true)),
        )
        changed.forEach { row ->
            val service = reviewedService(bundle, bundle.state.copy(fleet = fleet(listOf(row), baseId = bundle.base.baseId!!)))
            assertNull(service.feeSol)
            assertEquals(SealV2Primary.CHECK, sealV2Primary(requireNotNull(serviceSealV2(service, now))))
            assertFalse(requireNotNull(service.error).authoritative)
        }
    }

    @Test fun `held wallet attempted and expired service originals cannot rearm`() {
        val bundle = serviceBundle()
        val saved = requireNotNull(bundle.state.selected)
        val invalid = listOf(saved.copy(held = true), saved.copy(attempts = listOf("wallet")))
        invalid.forEach { record ->
            val service = reviewedService(bundle, selected(record, bundle.state.review, bundle.state))
            assertNull(service.feeSol)
            assertEquals(SealV2Primary.CHECK, sealV2Primary(requireNotNull(serviceSealV2(service, now))))
        }
        val expired = reviewedService(bundle, at = Instant.parse("2035-01-01T00:00:31.000Z").toEpochMilli())
        assertNull(expired.feeSol)
        assertEquals(SealV2Primary.CHECK, sealV2Primary(requireNotNull(serviceSealV2(expired, now))))
    }

    @Test fun `unrepresentable catalogue allowance withholds service and install fee despite live reviews`() {
        val policy = VehiclePolicy.from(f.change(f.policy.raw, "vehicles.completedUsesPerInstall", JsonPrimitive(Int.MAX_VALUE.toLong() + 1)))
        val bundle = serviceBundle(policy)
        val service = reviewedService(bundle, policy = policy)
        assertNull(service.feeSol)
        assertTrue(service.options.none { it.available })
        assertEquals(SealV2Primary.CHECK, sealV2Primary(requireNotNull(serviceSealV2(service, now))))
        val saved = record().copy(policy = policy.raw)
        val current = selected(saved, f.review(), state(fleet(emptyList())))
        val picker = requireNotNull(render(current, policy = policy, section = "install").install)
        assertNull(picker.feeSol)
        assertEquals(VoyageSealState.ERROR, picker.sealState)
    }
}
