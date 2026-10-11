package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId

/** Distinct entrances owned by the existing vehicle client/model/journal. Presentation only. */
internal enum class VehicleEntryPoint(val featureId: FeatureId, val page: String) {
    BERTH(FeatureId("berth.vehicles"), "fleet"),
    LODGE(FeatureId("lodge.dispatch"), "fleet"),
    SOLANA_PUBLIC(FeatureId("island.solana.public"), "craft"),
}

/** Compatibility bridge for one-to-one existing doors. Aggregated rewards, Gold Forge parent,
 * history and vehicle sections require their explicit owning callback; never pick one arbitrarily. */
internal fun existingPhaseEDoor(featureId: FeatureId): PhaseEActivity? = when (featureId.value) {
    "market.keepMarket" -> PhaseEActivity.KEEP_MARKET
    "workshop.equipment" -> PhaseEActivity.WORKSHOP
    "workshop.ingots" -> PhaseEActivity.INGOT_WORKSHOP
    "workshop.refine" -> PhaseEActivity.REFINING
    "workshop.cosmetics" -> PhaseEActivity.COSMETICS
    "lodge.passport" -> PhaseEActivity.REALM_PASSPORT
    "island.seeker.permit" -> PhaseEActivity.REALM_PERMITS
    "lodge.paid" -> PhaseEActivity.PAID_EXPEDITIONS
    "profile.freeKingdom" -> PhaseEActivity.FREE_KINGDOM
    "berth.starter" -> PhaseEActivity.STARTER_FLEET
    "lodge.starter" -> PhaseEActivity.STARTER_EXPEDITIONS
    "harvester.harvest" -> PhaseEActivity.HARVESTERS
    "clan.charter" -> PhaseEActivity.CHARTERS
    "clan.tournament" -> PhaseEActivity.TOURNAMENTS
    "island.divine.trials" -> PhaseEActivity.DIVINE_TRIALS
    "island.divine.fragments" -> PhaseEActivity.FRAGMENTS
    else -> null
}
