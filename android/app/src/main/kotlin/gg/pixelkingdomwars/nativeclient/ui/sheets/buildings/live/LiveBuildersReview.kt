package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.BaseJobProgress
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*

/** [jobsByNumber] maps every row that carries a job (owned builder slots, then the extra rows) to its exact server job;
 *  [extraJobs] are the jobs no builder slot holds, drawn as extra rows of the same list. */
internal data class LiveBuildersReview(val ui: BuildersSheetUi, val jobsByNumber: Map<Int, BaseJob>, val extraJobs: List<BaseJob>)

internal data class LiveBuilderJobDetail(val line: String, val progress: BaseJobProgress?)
internal fun liveBuilderJobDetail(state: KingdomUiState, job: BaseJob, now: Long): LiveBuilderJobDetail {
    val building = state.base?.buildings?.firstOrNull { it.id == job.buildingId }
    return LiveBuilderJobDetail(listOfNotNull(building?.type?.let(::trayLabel), job.kind.replace('_', ' ').uppercase()).joinToString(" · "),
        baseJobProgress(job.startedAt, job.finishesAt, now))
}

/** The registered Home owner keeps first refusal; only a resolved scene tap dismisses this local half sheet. */
internal fun consumeBuildersTap(open: Boolean, owner: () -> Boolean, close: () -> Unit): Boolean =
    if (owner()) true else if (open) { close(); true } else false

/** The title of a row whose server job holds no builder slot (never "BUILDER n": no such builder exists). */
internal const val UNSLOTTED_JOB_TITLE = "JOB"

/** Builder numbers are display slots, not server worker identities. Free/working counts always come from the
 * existing overview. Jobs fill working slots in server order; a job no working slot holds becomes an extra row of the
 * same list (titled [UNSLOTTED_JOB_TITLE], keyed after the owned slots), never a second panel. */
internal fun liveBuildersReview(state: KingdomUiState, busy: Boolean, canHire: Boolean, now: Long): LiveBuildersReview? {
    val base = state.base ?: return null
    if (!base.raw.containsKey("freeBuilders")) return null
    val overview = builderOverview(state.catalogue, base) ?: return null
    val working = overview.owned - overview.free
    val extraJobs = base.jobs.drop(working)
    val jobs = (base.jobs.take(working).mapIndexed { index, job -> index + 1 to job } +
        extraJobs.mapIndexed { index, job -> overview.owned + index + 1 to job }).toMap()
    val allowed = !busy && !state.constructionBlocked && state.ordersAllowed && state.deedActionsAllowed
    fun row(number: Int, job: BaseJob?, title: String? = null): BuilderRowUi {
        val detail = job?.let { liveBuilderJobDetail(state, it, now) }
        val progress = detail?.progress
        val building = job?.let { j -> base.buildings.firstOrNull { it.id == j.buildingId } }
        val canView = job != null && (building != null || job.kind == "clear_obstacle" || base.obstacles.any { it.id == job.obstacleId })
        val priceStatus = when {
            !allowed || job == null -> PriceStatus.UNAVAILABLE
            builderFinishIsFree(job) -> PriceStatus.SERVER_ZERO
            builderFinishCanReview(job) -> PriceStatus.CHECKING
            else -> PriceStatus.UNAVAILABLE
        }
        val busyRow = number <= working || title != null
        return BuilderRowUi(number, if (busyRow) BuilderStatus.WORKING else BuilderStatus.FREE,
            detail?.line,
            progress?.remaining?.removeSuffix(" remaining"), progress?.fraction, queued = false,
            // PriceUi requires an enum, but this neutral placeholder never selects a payment currency.
            // Both its icon and spoken description are overridden; the exact-currency review owns paid amounts.
            finish = if (busyRow) PriceUi(Currency.ITEM, if (priceStatus == PriceStatus.SERVER_ZERO) "0" else null,
                priceStatus, icon = "shape:unknown", description = when (priceStatus) {
                    PriceStatus.SERVER_ZERO -> "Free finish"
                    PriceStatus.CHECKING -> "The finish review will show the price and currency."
                    else -> "The finish price is unavailable right now."
                }) else null,
            // Opaque local callback token only; never submitted to the feature registry or a payment endpoint.
            focus = if (canView) FeatureId(requireNotNull(job).id) else null, busy = busy, title = title)
    }
    val rows = (1..overview.owned).map { number -> row(number, jobs[number]) } +
        extraJobs.indices.map { index -> overview.owned + index + 1 }.map { number -> row(number, jobs[number], title = UNSLOTTED_JOB_TITLE) }
    val hire = overview.hireOffer?.let { offer -> HireBuilderUi(overview.owned + 1,
        PriceUi(Currency.SOL, basePurchaseSol(offer.amountLamports), if (canHire) PriceStatus.OK else PriceStatus.UNAVAILABLE),
        // builders.png "Builder 5 opens after 4.": slots are hired one at a time, up to the catalogue's maximum.
        nextLockedLine = if (overview.owned + 2 <= overview.maximum) "Builder ${overview.owned + 2} opens after ${overview.owned + 1}." else null) }
    return LiveBuildersReview(BuildersSheetUi(overview.owned, overview.free, overview.maximum, rows, hire,
        loading = state.home.loading, error = state.home.error,
        // SPEC R2.1: every slot owned reads "All builder slots are yours."; a missing offer is the locked "Hiring opens later".
        hireLine = if (overview.owned == overview.maximum) "All builder slots are yours." else if (hire == null) "Hiring opens later" else null),
        jobs, extraJobs)
}
