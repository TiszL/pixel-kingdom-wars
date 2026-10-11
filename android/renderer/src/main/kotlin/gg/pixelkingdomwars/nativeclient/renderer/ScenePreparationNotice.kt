package gg.pixelkingdomwars.nativeclient.renderer

/** Preparation belongs to one admitted visual generation, even after its callback leaves GL. */
data class ScenePreparationNotice(val generation: Long, val message: String?, val fatal: Boolean = false) {
    fun isCurrent(admittedGeneration: Long, disposed: Boolean) = !disposed && generation == admittedGeneration
}

/** Check both the renderer and its host ownership when Main actually handles the notice. Checking
 * before posting lets an old failure overwrite a newer scene's clear (or an old clear hide failure). */
fun <T> dispatchSceneCallback(
    event: T,
    postToMain: (() -> Unit) -> Unit,
    isCurrent: (T) -> Boolean,
    receive: (T) -> Unit,
) {
    postToMain { if (isCurrent(event)) receive(event) }
}
