package gg.pixelkingdomwars.nativeclient.update

/** How the Title and Home mounts draw the update channel (owner 2026-09-25: a required update gets its own screen). */
enum class UpdatePresentation { None, Banner, FullScreen }

/** The one place that decides it; Compose only renders the answer. [mandatory] is the repository's `isMandatoryBlocking`
 * (orders are paused), the server's current word, not the copy carried inside a state that is already in progress. */
fun updatePresentation(state: UpdateState, mandatory: Boolean): UpdatePresentation {
    if (state.offer == null) return UpdatePresentation.None
    val pending = if (mandatory) UpdatePresentation.FullScreen else UpdatePresentation.Banner
    // No else branch: a new state must be classified here before it compiles.
    return when (state) {
        UpdateState.Idle, is UpdateState.Declined, is UpdateState.Installed -> UpdatePresentation.None
        is UpdateState.Offered, is UpdateState.WaitingForBattle, is UpdateState.NeedsMeteredConsent, is UpdateState.Downloading,
        is UpdateState.Verifying, is UpdateState.ReadyToInstall, is UpdateState.AwaitingUserAction, is UpdateState.AwaitingPermission,
        is UpdateState.Installing, is UpdateState.Failed -> pending
    }
}
