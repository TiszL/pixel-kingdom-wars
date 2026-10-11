package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow

/** MainActivity/MS-C owns the admitted source; this surface owns only construction leases.
 * Requires the approved AppGraph/MainActivity sink hunk to land with MS-C NR-5. */
internal fun bindPhaseEConstructionArt(graph: AppGraph, session: SessionGraph, scope: CoroutineScope,
    selected: Flow<String?>, selectedNow: () -> String?): PhaseEConstructionRuntime {
    val provider = PhaseEConstructionArtProvider(scope)
    PhaseEConstructionArtBinding(scope, session.session, requireNotNull(session.scope.coroutineContext[Job]),
        graph.account.state, session.base.state, graph.content.state, graph.constructionContentAdmissions,
        selected, selectedNow, session.interlock.state, graph.versionCode,
        requireSession = {
            graph.holder.requireCurrent(session.session)
            check(graph.sessionGraph.value === session && session.scope.active)
        }, update = provider::update)
    return PhaseEConstructionRuntime(provider.constructionArt, provider.preparation)
}
