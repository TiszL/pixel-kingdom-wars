package gg.pixelkingdomwars.nativeclient.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

/** WHY: `X-PKW-Renderer-Contract` must declare the render catalogue the app has LOADED, never the
 * ceiling the APK could admit. A contract-15 APK still running the bundled contract-14 pack has no
 * `layeredGroundV5` section; declaring 15 would make the API name revision-5 ground that
 * `prepareGround` cannot draw ("Realm kit content is unavailable"). Declaring the loaded 14 keeps the
 * API on the revision-4 painting the pack actually carries (docs/UPDATE_COMPATIBILITY.md, E-12). */
class ContentStateRendererContractTest {
    @Test fun `the declared contract is the loaded render catalogue's, absent until content publishes`() {
        assertNull(ContentState().rendererContract)
        assertEquals(14, ContentState(renderCatalogue = buildJsonObject { put("rendererContractVersion", 14) }).rendererContract)
        assertEquals(15, ContentState(renderCatalogue = buildJsonObject { put("rendererContractVersion", 15) }).rendererContract)
    }
    @Test fun `a pack that predates the catalogue head field declares nothing`() {
        assertNull(ContentState(renderCatalogue = buildJsonObject { put("actors", "[]") }).rendererContract)
        assertNull(ContentState(renderCatalogue = buildJsonObject { put("rendererContractVersion", "fifteen") }).rendererContract)
    }
}
