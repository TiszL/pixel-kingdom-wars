package gg.pixelkingdomwars.nativeclient.ui.phasee

/** Public actor identity only. A restored flag is not evidence that it belongs to this actor. */
internal data class PhaseERegistrationActor(val wallet: String, val origin: String)

internal enum class PhaseERegistrationBody { CLOSED, LIVE, RECEIPTS }

/** Presentation only: no saved command, review, wallet approval or repository capability. */
internal data class PhaseERegistrationPresentation(
    val show: Boolean = false,
    val historyOnly: Boolean = false,
    val entryPoint: VehicleEntryPoint? = null,
) {
    val body: PhaseERegistrationBody
        get() = when {
            !show -> PhaseERegistrationBody.CLOSED
            historyOnly -> PhaseERegistrationBody.RECEIPTS
            else -> PhaseERegistrationBody.LIVE
        }
    val initialPage: String get() = entryPoint?.page ?: "fleet"

    fun openLive() = PhaseERegistrationPresentation(show = true)
    fun openHistory(entry: VehicleEntryPoint? = null) = PhaseERegistrationPresentation(true, true, entry)
    fun openEntry(entry: VehicleEntryPoint) = PhaseERegistrationPresentation(true, false, entry)
    fun close() = PhaseERegistrationPresentation()
}

/** Also used at render time, before an effect can repair a mismatched restored actor stamp. */
internal fun phaseERegistrationPresentation(
    savedActor: PhaseERegistrationActor,
    currentActor: PhaseERegistrationActor,
    show: Boolean,
    historyOnly: Boolean,
    entryPoint: VehicleEntryPoint? = null,
): PhaseERegistrationPresentation =
    if (!show || currentActor.wallet.isBlank() || currentActor.origin.isBlank() || savedActor != currentActor)
        PhaseERegistrationPresentation()
    else PhaseERegistrationPresentation(true, historyOnly, entryPoint)

/** The public FleetCommandOwner seam carries a name without exposing this internal enum. */
internal fun phaseEVehicleEntry(name: String): VehicleEntryPoint? =
    VehicleEntryPoint.entries.singleOrNull { it.name == name }
