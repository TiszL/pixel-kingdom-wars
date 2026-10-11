package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.workshop.*
import java.util.Collections
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal enum class PhaseEReceiptFamily {
    WORKSHOP, REFINING, STARTER_FLEET, STARTER_EXPEDITION, HARVESTER,
    AWNING, WAKE, EQUIPMENT, VEHICLE, MARKET
}

internal enum class PhaseEReceiptSource { PENDING, ARCHIVED, SERVER }

internal data class PhaseEReceiptDetail(val label: String, val value: String)

/** A lookup selector only. The mounting owner resolves it against the current account's
 * saved originals before invoking its explicit GET observation API. */
internal data class PhaseEReceiptCheck(
    val family: PhaseEReceiptFamily,
    val source: PhaseEReceiptSource,
    val id: String,
)

/** No commands, JSON objects, repositories, wallet state or signing bytes cross this boundary. */
internal class PhaseEReceiptRow(
    val id: String,
    val family: PhaseEReceiptFamily,
    val source: PhaseEReceiptSource,
    val receiptKey: String,
    val title: String,
    val status: String,
    val baseId: String?,
    details: List<PhaseEReceiptDetail>,
    val check: PhaseEReceiptCheck? = null,
) {
    val details: List<PhaseEReceiptDetail> = immutable(details)
}

private fun <T> immutable(values: Collection<T>): List<T> =
    Collections.unmodifiableList(ArrayList(values))

/** Projections of already retained/validated state. Admission and the selected kingdom do
 * not filter history. Every local original remains separate from server observations. */
internal object PhaseEReceiptRows {
    private class Rows(private val family: PhaseEReceiptFamily) {
        private val rows = mutableListOf<PhaseEReceiptRow>()
        fun add(source: PhaseEReceiptSource, key: String, title: String, status: String,
            base: String?, details: List<PhaseEReceiptDetail>, checkId: String? = null) {
            rows += PhaseEReceiptRow("${family.name}:${source.name}:${rows.size}:$key", family,
                source, key, title, status, base, details,
                checkId?.let { PhaseEReceiptCheck(family, source, it) })
        }
        fun result(): List<PhaseEReceiptRow> = immutable(rows)
    }

    private fun details(vararg values: Pair<String, String?>): List<PhaseEReceiptDetail> =
        values.mapNotNull { (label, value) -> value?.let { PhaseEReceiptDetail(label, it) } }

    private fun status(accepted: Boolean, attempted: Boolean, refused: Boolean = false): String = when {
        accepted -> "ACCEPTED"
        refused -> "DECLINED"
        attempted -> "CHECK NEEDED"
        else -> "SAVED DRAFT"
    }

    fun workshop(state: WorkshopState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.WORKSHOP)
        fun saved(op: WorkshopOperation, source: PhaseEReceiptSource) {
            val command = op.command
            val proof = op.proof?.takeIf { it.status == "accepted" }
            val receipt = proof?.receipt
            rows.add(source, command.key, if (command.kind == "collect") "Ingot collection" else "Ingot refining",
                if (proof != null && command.kind == "collect") "COLLECTED"
                else status(proof != null, op.attempted, op.refusal != null), command.baseId,
                details("Ingots" to command.ingots.toString(), "Job" to (text(receipt, "jobId") ?: command.jobId),
                    "Receipt" to text(receipt, "receiptId"), "Started at" to text(receipt, "startedAt"),
                    "Ready at" to text(receipt, "readyAt"), "Collected at" to text(receipt, "collectedAt")),
                command.key.takeIf { source == PhaseEReceiptSource.PENDING })
        }
        state.journal.operation?.let { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal.archives.forEach { saved(it.operation, PhaseEReceiptSource.ARCHIVED) }
        state.view?.let { view -> view.jobs.forEach { job ->
            rows.add(PhaseEReceiptSource.SERVER, job.jobId, "Ingot job",
                when { job.collectedAt != null -> "COLLECTED"; job.ready -> "READY"; else -> "REFINING" },
                view.inventory.baseId, details("Ingots" to job.ingots.toString(),
                    "Started at" to job.startedAt, "Ready at" to job.readyAt, "Collected at" to job.collectedAt))
        } }
        return rows.result()
    }

    fun refining(state: OrdinaryCraftingState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.REFINING)
        fun saved(op: OrdinaryCraftingOperation, source: PhaseEReceiptSource) {
            val command = op.command
            val proof = op.proof?.takeIf { it.status == "accepted" }
            rows.add(source, command.key, "Material refining",
                if (proof?.completion != null) "COMPLETED" else status(proof != null, op.attemptRevision != null, op.refusal != null),
                command.request.baseId, details("Recipe" to command.request.recipeId,
                    "Output" to command.recipe.output.itemId, "Output quantity" to command.recipe.output.quantity,
                    "Job" to proof?.receipt?.jobId, "Started at" to proof?.receipt?.startedAt,
                    "Ready at" to proof?.receipt?.readyAt, "Completed at" to proof?.completion?.completedAt), command.key)
        }
        state.journal.operation?.let { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal.archives.forEach { saved(it.operation, PhaseEReceiptSource.ARCHIVED) }
        state.view?.let { view -> view.pendingJobs.forEach { job ->
            rows.add(PhaseEReceiptSource.SERVER, job.jobId, "Material refining job", "REFINING", view.baseId,
                details("Output" to job.recipe.output.itemId, "Output quantity" to job.recipe.output.quantity,
                    "Started at" to job.startedAt, "Ready at" to job.readyAt))
        } }
        return rows.result()
    }

    fun starterFleet(state: StarterFleetState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.STARTER_FLEET)
        fun saved(op: StarterFleetOperation, source: PhaseEReceiptSource) {
            val command = op.command
            val proof = op.proof?.takeIf { it.status == "accepted" }
            val installation = proof?.receipt?.installation
            rows.add(source, command.key, "Starter installation",
                if (installation != null) "INSTALLED" else status(false, op.attemptRevision != null, op.refusal != null),
                command.request.baseId, details("Berth" to command.request.berthId,
                    "Installation" to installation?.installationId, "Installed at" to installation?.installedAt), command.key)
        }
        state.journal.operation?.let { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal.archives.forEach { saved(it.operation, PhaseEReceiptSource.ARCHIVED) }
        state.view?.installation?.let { installed ->
            rows.add(PhaseEReceiptSource.SERVER, installed.installationId, "Starter installation", "INSTALLED",
                installed.baseId, details("Berth" to installed.berthId, "Installed at" to installed.installedAt))
        }
        return rows.result()
    }

    fun expeditions(state: StarterExpeditionState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.STARTER_EXPEDITION)
        fun saved(op: StarterExpeditionOperation, source: PhaseEReceiptSource) {
            val command = op.command
            val proof = op.proof?.takeIf { it.status == "accepted" }
            rows.add(source, command.key, "Starter expedition",
                if (proof?.returned != null) "RETURNED" else status(proof != null, op.attemptRevision != null, op.refusal != null),
                command.request.baseId, details("Route" to command.request.routeId,
                    "Installation" to command.request.installationId, "Resource" to command.route.resourceId,
                    "Expedition" to proof?.receipt?.expeditionId, "Departed at" to proof?.receipt?.departedAt,
                    "Scheduled return" to proof?.receipt?.returnsAt, "Returned at" to proof?.returned?.returnedAt), command.key)
        }
        state.journal.operation?.let { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal.archives.forEach { saved(it.operation, PhaseEReceiptSource.ARCHIVED) }
        state.view?.let { view -> view.flight?.let { flight ->
            rows.add(PhaseEReceiptSource.SERVER, flight.expeditionId, "Starter expedition", "ACCEPTED", view.baseId,
                details("Route" to flight.route.routeId, "Installation" to flight.installationId,
                    "Departed at" to flight.departedAt, "Scheduled return" to flight.returnsAt))
        } }
        return rows.result()
    }

    fun harvester(state: HarvesterState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.HARVESTER)
        fun saved(op: HarvesterOperation, source: PhaseEReceiptSource) {
            val command = op.command
            val proof = op.proof?.takeIf { it.status == "accepted" }
            val original = proof?.originalReceipt?.source
            val settlement = proof?.settlement
            val shown = details("Harvester" to command.request.harvesterId, "Realm" to command.realmId,
                "Source" to original?.sourceId, "Resource" to original?.resourceId,
                "Admitted at" to original?.admittedAt, "Lease expires at" to original?.leaseExpiresAt,
                "Closed at" to settlement?.closure?.cutoffAt).toMutableList()
            settlement?.events?.forEach { event ->
                shown += PhaseEReceiptDetail("Settled earning ${event.ordinal}",
                    "${event.netQuantity} ${event.resourceId} · ${event.settledAt}")
            }
            rows.add(source, command.key, "Harvester source",
                if (settlement?.closure != null) "CLOSED" else status(proof != null, op.attemptRevision != null, op.refusal != null),
                command.request.baseId, shown, command.key)
        }
        state.journal.operation?.let { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal.archives.forEach { saved(it.operation, PhaseEReceiptSource.ARCHIVED) }
        listOfNotNull(state.view?.source, state.view?.walletSource).distinct().forEach { source ->
            rows.add(PhaseEReceiptSource.SERVER, source.sourceId, "Harvester source", "OBSERVED", source.baseId,
                details("Harvester" to source.harvesterId, "Resource" to source.resourceId,
                    "Admitted at" to source.admittedAt, "Lease expires at" to source.leaseExpiresAt))
        }
        return rows.result()
    }

    fun awnings(state: BoundCosmeticWorkshopState): List<PhaseEReceiptRow> =
        cosmetics(PhaseEReceiptFamily.AWNING, "Awning", state.journal, state.view?.originals.orEmpty())

    fun wake(state: BoundCosmeticWakeWorkshopState): List<PhaseEReceiptRow> =
        cosmetics(PhaseEReceiptFamily.WAKE, "Aurora Wake", state.journal,
            listOfNotNull(state.original, state.view?.original).distinct())

    private fun cosmetics(family: PhaseEReceiptFamily, title: String, journal: BoundCosmeticJournal,
        originals: List<BoundCosmeticProof>): List<PhaseEReceiptRow> {
        val rows = Rows(family)
        fun saved(op: BoundCosmeticOperation, source: PhaseEReceiptSource) {
            val proof = op.proof?.takeIf { it.status == "accepted" }
            rows.add(source, op.command.key, title,
                if (proof?.completion != null) "COMPLETED" else status(proof != null, op.attempted),
                op.command.request.baseId, cosmeticDetails(proof) + details("Output" to op.command.recipe.outputId), op.command.key)
        }
        journal.operation?.let { saved(it, PhaseEReceiptSource.PENDING) }
        journal.archives.forEach { saved(it, PhaseEReceiptSource.ARCHIVED) }
        originals.forEach { proof ->
            rows.add(PhaseEReceiptSource.SERVER, proof.idempotencyKey, title,
                when { proof.status != "accepted" -> "CHECK NEEDED"; proof.completion != null -> "COMPLETED"; else -> "ACCEPTED" },
                proof.receipt?.request?.baseId, cosmeticDetails(proof) + details("Output" to proof.receipt?.recipe?.outputId))
        }
        return rows.result()
    }

    private fun cosmeticDetails(proof: BoundCosmeticProof?) = details("Job" to proof?.receipt?.jobId,
        "Started at" to proof?.receipt?.startedAt, "Ready at" to proof?.receipt?.readyAt,
        "Completed at" to proof?.completion?.completedAt)

    fun equipment(state: EquipmentState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.EQUIPMENT)
        fun saved(record: EquipmentRecord, source: PhaseEReceiptSource) {
            val response = record.response
            val accepted = text(response, "status") == "accepted"
            val completion = obj(response, "completion")
            val returned = obj(response, "return")
            val shownStatus = when {
                record.held -> "CHECK NEEDED"
                accepted && record.kind == "craft" && completion != null -> "COMPLETED"
                accepted && record.kind in setOf("starter", "advanced") && returned != null -> "RETURNED"
                accepted -> "ACCEPTED"
                record.refusal != null || record.closedRefusal -> "DECLINED"
                record.discardedUnsent -> "DRAFT CLOSED"
                record.closedUnknown -> "CLOSED"
                response != null -> "SAVED RECEIPT"
                else -> status(false, record.attempted)
            }
            rows.add(source, record.key, when (record.kind) {
                "craft" -> "Equipment crafting"; "starter", "advanced" -> "Fitted expedition"
                "collect" -> "Expedition collection"; else -> "Equipment original"
            }, shownStatus, text(record.request, "baseId"),
                details("Output" to record.recipe?.output?.itemId,
                    "Fitting" to text(obj(record.request, "fitting"), "itemId"),
                    "Installation" to text(record.request, "installationId"), "Route" to text(record.request, "routeId"),
                    "Completed at" to text(completion, "completedAt"), "Returned at" to text(returned, "returnedAt")), record.key)
        }
        state.journal?.pending?.forEach { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal?.archives?.forEach { saved(it, PhaseEReceiptSource.ARCHIVED) }
        state.view?.let { view -> view.pendingJobs.forEach { job ->
            rows.add(PhaseEReceiptSource.SERVER, job.jobId, "Equipment crafting job", "CRAFTING", view.baseId,
                details("Output" to job.recipe.output.itemId, "Started at" to job.startedAt, "Ready at" to job.readyAt))
        } }
        return rows.result()
    }

    fun vehicles(state: VehicleState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.VEHICLE)
        fun saved(record: VehicleRecord, source: PhaseEReceiptSource) {
            val response = record.response
            val originalRecord = obj(response, "record")
            val original = obj(originalRecord, if (record.kind == "installation") "reservation" else "intent")
            val originalRequest = obj(original, "request")
            val originalState = obj(original, "state")
            val terminal = obj(originalRecord, if (record.kind == "installation") "installation" else "application")
            val returned = obj(response, "return")
            val base = text(record.destination, "baseId") ?: text(record.request, "baseId")
                ?: text(if (record.kind == "installation") originalRequest else originalState, "baseId")
            val shownStatus = when {
                record.closedUnknown != null -> "CLOSED"
                record.held -> "CHECK NEEDED"
                record.kind == "installation" && terminal != null -> "INSTALLED"
                record.kind == "service" && terminal != null -> "APPLIED"
                record.kind == "expedition" && returned != null -> "RETURNED"
                record.kind == "expedition" && obj(response, "receipt") != null -> "ACCEPTED"
                response != null -> "SAVED RECEIPT"
                record.attempts.isNotEmpty() -> "CHECK NEEDED"
                else -> "SAVED DRAFT"
            }
            rows.add(source, record.key, vehicleTitle(record.kind), shownStatus, base,
                details("Installation" to (text(record.request, "installationId") ?: text(originalState, "installationId")),
                    "Berth" to (text(record.destination, "berthId") ?: text(record.request, "berthId")
                        ?: text(if (record.kind == "installation") originalRequest else originalState, "berthId")),
                    "Route" to text(record.request, "routeId"), "Returned at" to text(returned, "returnedAt")), record.id)
        }
        state.journal?.pending?.forEach { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal?.archives?.forEach { saved(it, PhaseEReceiptSource.ARCHIVED) }
        serverItems(state.activity).forEach { raw ->
            val row = raw as? JsonObject
            val kind = text(row, "kind")
            val id = text(row, "id")
            val key = text(row, "idempotencyKey")
            val base = text(row, "baseId")
            val serverStatus = text(row, "status")
            val shownStatus = when (kind) {
                "installation" -> when (serverStatus) { "reserved" -> "RESERVED"; "prepared" -> "PREPARED"; "signed" -> "APPROVED"; "installed" -> "INSTALLED"; else -> null }
                "service" -> when (serverStatus) { "reserved" -> "RESERVED"; "prepared" -> "PREPARED"; "signed" -> "APPROVED"; "applied" -> "APPLIED"; else -> null }
                "expedition" -> when (serverStatus) { "accepted" -> "ACCEPTED"; "returned" -> "RETURNED"; else -> null }
                else -> null
            }
            if (id == null || key == null || base == null || shownStatus == null) unavailable(rows)
            else rows.add(PhaseEReceiptSource.SERVER, key, vehicleTitle(kind), shownStatus, base,
                details("Activity" to id, "Recorded at" to text(row, "createdAt")), id)
        }
        return rows.result()
    }

    fun market(state: KeepEquipmentMarketState): List<PhaseEReceiptRow> {
        val rows = Rows(PhaseEReceiptFamily.MARKET)
        fun saved(record: KeepEquipmentMarketRecord, source: PhaseEReceiptSource) {
            val shownStatus = when {
                record.held -> "CHECK NEEDED"
                record.discardedUnsent -> "DRAFT CLOSED"
                record.closedAbsent && record.response == null -> "CLOSED"
                record.response != null -> "SAVED RECEIPT"
                record.attempts.isNotEmpty() -> "CHECK NEEDED"
                else -> "SAVED DRAFT"
            }
            rows.add(source, record.key, marketTitle(record.kind), shownStatus,
                text(record.request, "baseId") ?: text(record.request, "buyerBaseId") ?: text(record.preview, "sellerBaseId"),
                details("Item" to (text(record.request, "itemId") ?: text(record.preview, "itemId")),
                    "Quantity" to text(record.request, "quantity"), "Listing" to text(record.request, "listingId")), record.key)
        }
        state.journal?.pending?.forEach { saved(it, PhaseEReceiptSource.PENDING) }
        state.journal?.archives?.forEach { saved(it, PhaseEReceiptSource.ARCHIVED) }
        serverItems(state.history).forEach { raw ->
            val row = raw as? JsonObject
            val kind = text(row, "kind")
            val id = text(row, "id")
            val base = text(row, "baseId")
            if (kind !in setOf("listing", "fill", "cancellation") || id == null || base == null) unavailable(rows)
            else rows.add(PhaseEReceiptSource.SERVER, id, marketTitle(kind), "SAVED RECEIPT", base,
                details("Item" to text(row, "itemId"), "Recorded at" to text(row, "createdAt")), id)
        }
        return rows.result()
    }

    private fun vehicleTitle(kind: String?) = when (kind) {
        "installation" -> "Vehicle installation"; "service" -> "Vehicle service"
        "expedition" -> "Vehicle expedition"; "collect" -> "Expedition collection"
        else -> "Vehicle original"
    }

    private fun marketTitle(kind: String?) = when (kind) {
        "listing" -> "Market listing"; "fill" -> "Market purchase"
        "cancellation" -> "Market listing return"; else -> "Market original"
    }

    private fun unavailable(rows: Rows) = rows.add(PhaseEReceiptSource.SERVER, "Unavailable",
        "Saved server record", "UNAVAILABLE", null, emptyList())

    private fun serverItems(value: JsonObject?) = (value?.get("items") as? JsonArray).orEmpty()
    private fun obj(value: JsonObject?, key: String) = value?.get(key) as? JsonObject
    /** Only explicit, whitelisted scalar fields are read; nested payloads never stringify. */
    private fun text(value: JsonObject?, key: String): String? = (value?.get(key) as? JsonPrimitive)
        ?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }
}
