package gg.pixelkingdomwars.nativeclient.scene

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06: "no card over the base". When a new Home scene revision fails to prepare, the renderer keeps drawing the
 * previous one; SceneSurface used to put a "Couldn't update your base. TRY AGAIN" card over it. A covered Home now keeps
 * its picture, says it once as a kit toast and re-submits the same scene once; battles and other uncovered scenes keep
 * their card (their own transitions own that surface).
 */
class HomeUpdateToastTest {
    @Test fun `only a covered Home with a drawn scene trades the card for a toast`() {
        assertTrue(homeUpdateFailure(preparationError = true, sceneReady = true, coveredByParent = true))
        assertFalse("nothing failed", homeUpdateFailure(false, true, true))
        assertFalse("an opening failure is the cover's TRY AGAIN, not a toast", homeUpdateFailure(true, false, true))
        assertFalse("a battle keeps its card", homeUpdateFailure(true, true, false))
    }

    @Test fun `the card is never drawn over a covered Home and the toast retries once`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/SceneHost.kt").readText()
        assertTrue(host.contains("if (preparationError && sceneReady && onPreparationRetry == null && !coveredByParent) Card("))
        val effect = host.substring(host.indexOf("val updateFailed = homeUpdateFailure("), host.indexOf("retryPreparation()", host.indexOf("val updateFailed = homeUpdateFailure(")))
        assertTrue("said once, as an error toast", effect.contains("Toasts.post(HOME_UPDATE_FAILED, error = true)"))
        assertTrue("then one re-submission of the same scene", effect.contains("kotlinx.coroutines.delay(HOME_UPDATE_RETRY_MS)"))
        assertTrue("keyed on the failure, so a persisting failure neither repeats the toast nor loops", effect.contains("LaunchedEffect(fragment, updateFailed)"))
    }
}
