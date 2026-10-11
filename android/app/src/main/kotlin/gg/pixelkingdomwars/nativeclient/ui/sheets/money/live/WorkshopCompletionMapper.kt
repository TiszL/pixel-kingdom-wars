package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingHydration
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.data.WorkshopHydration
import gg.pixelkingdomwars.nativeclient.data.WorkshopState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftCelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import java.time.Instant
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/** Local presentation identity. It never becomes a request, reward, inventory delta, or durable receipt edit. */
data class WorkshopCompletionToken(val origin: String, val cluster: String, val wallet: String,
    val baseId: String, val requestKey: String, val jobId: String, val owner: String)

data class WorkshopCompletion(val token: WorkshopCompletionToken, val ui: CraftCelebrationUi,
    /** The exact separately hydrated delivery read retained for provenance, not used as live stock. */
    val view: Any)

/** One queue in the existing session-bound screen model. Old callbacks cannot consume another original receipt.
 * Previously archived records never enter this queue; only a successful existing finish() transition may offer.
 */
internal class WorkshopCompletionEvents {
    private val offered = mutableSetOf<WorkshopCompletionToken>()
    private val pending = mutableListOf<WorkshopCompletion>()
    private val mutable = MutableStateFlow<WorkshopCompletion?>(null)
    private var selectionSet = false
    private var selectedBase: String? = null
    val state = mutable.asStateFlow()
    fun offer(event: WorkshopCompletion?): Boolean {
        if (event == null) return false
        // A collected job is one delivery even if another saved key observes that same accepted receipt.
        if (!offered.add(event.token.copy(requestKey = ""))) return false
        pending += event
        publish()
        return true
    }
    fun selectBase(baseId: String?) {
        selectionSet = true
        selectedBase = baseId
        publish()
    }
    private fun publish() {
        mutable.value = pending.firstOrNull { !selectionSet || it.token.baseId == selectedBase }
    }
    fun acknowledge(token: WorkshopCompletionToken) {
        if (mutable.value?.token != token) return
        pending.removeAll { it.token == token }
        publish()
    }
}

/** Call only immediately around a successful OrdinaryCraftingRepository.finish(). That existing operation
 * observes the original receipt, hydrates selected stock under its session/base/generation guard, then archives.
 * The sticky hydration enum alone is insufficient: require its exact new accepted archive and a new view too.
 * Archived completion GETs have no delivery hydration and deliberately cannot produce this event.
 */
internal fun ordinaryWorkshopCompletion(before: OrdinaryCraftingState, after: OrdinaryCraftingState): WorkshopCompletion? = runCatching {
    val identity = before.journal.identity
    identity.validate()
    require(before.journal.version == 1 && after.journal.version == 1 && after.journal.identity == identity)
    require(after.journal.revision > before.journal.revision && after.journal.operation == null)
    val original = requireNotNull(before.journal.operation).command
    original.validate()
    require(after.journal.archives.size == before.journal.archives.size + 1)
    require(after.journal.archives.dropLast(1) == before.journal.archives)
    require(before.journal.archives.none { it.operation.command.key == original.key })
    val archive = after.journal.archives.last()
    require(archive.reason == "accepted" && archive.evidence == null && archive.operation.command == original)
    val proof = requireNotNull(archive.operation.proof)
    proof.validate(identity, original)
    require(proof.status == "accepted" && proof.completion != null)
    val receipt = requireNotNull(proof.receipt)
    require(!after.busy && after.review == null && after.hydration == OrdinaryCraftingHydration.CURRENT_ORIGINAL_BASE)
    val view = requireNotNull(after.view)
    require(view !== before.view)
    view.validate()
    require(view.wallet == identity.wallet && view.baseId == original.request.baseId)
    require(Instant.parse(view.serverNow) >= Instant.parse(proof.serverNow))
    val output = receipt.recipe.output
    require(view.craftingStock.any { it.itemId == output.itemId })
    val token = WorkshopCompletionToken(identity.origin, identity.cluster, identity.wallet, view.baseId,
        original.key, receipt.jobId, "ordinary")
    WorkshopCompletion(token, CraftCelebrationUi(receipt.jobId, "BATCH DONE", craftItemIcon(output.itemId),
        "+${output.quantity} ${output.itemId.replace('_', ' ').uppercase(Locale.ROOT)}",
        // workshop-done.png: "In your stores. The bench is free." — the second sentence only when the hydrated view
        // shows no other job still on the bench.
        if (view.pendingJobs.isEmpty()) "In your stores. The bench is free." else "In your stores."), view)
}.getOrNull()

/** Forge Ingots require their accepted COLLECT receipt plus the separately hydrated matching collected job.
 * A start receipt, ready timer, disappearing job, or an old archive supplies no delivery event.
 */
internal fun ingotWorkshopCompletion(before: WorkshopState, after: WorkshopState): WorkshopCompletion? = runCatching {
    val identity = before.journal.identity
    identity.validate()
    require(before.journal.version == 1 && after.journal.version == 1 && after.journal.identity == identity)
    require(after.journal.revision > before.journal.revision && after.journal.operation == null)
    val original = requireNotNull(before.journal.operation).command
    original.validate()
    require(original.kind == "collect")
    require(after.journal.archives.size == before.journal.archives.size + 1)
    require(after.journal.archives.dropLast(1) == before.journal.archives)
    require(before.journal.archives.none { it.operation.command.key == original.key })
    val archive = after.journal.archives.last()
    require(archive.reason == "accepted" && archive.evidence == null && archive.operation.command == original)
    val proof = requireNotNull(archive.operation.proof)
    proof.validate(identity, original)
    require(proof.status == "accepted")
    require(!after.busy && after.review == null && after.hydration == WorkshopHydration.CURRENT_ORIGINAL_BASE)
    val view = requireNotNull(after.view)
    require(view !== before.view)
    view.validate()
    require(view.inventory.baseId == original.baseId && Instant.parse(view.serverNow) >= Instant.parse(proof.serverNow))
    val receipt = requireNotNull(proof.receipt)
    val credits = receipt.getValue("ingotsCredited").jsonPrimitive.long
    val collectedAt = receipt.getValue("collectedAt").jsonPrimitive.content
    val job = view.jobs.single { it.jobId == original.jobId }
    require(job.ingots == credits && job.collectedAt == collectedAt)
    val token = WorkshopCompletionToken(identity.origin, identity.cluster, identity.wallet, original.baseId,
        original.key, job.jobId, "ingots")
    WorkshopCompletion(token, CraftCelebrationUi(job.jobId, "BATCH DONE", "craft:inv_forge_ingot",
        "+$credits FORGE INGOTS", "Delivered to your stores."), view)
}.getOrNull()
