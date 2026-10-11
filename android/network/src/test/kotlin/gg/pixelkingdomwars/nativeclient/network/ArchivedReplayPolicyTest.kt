package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ArchivedReplayPolicyTest {
    private fun catalog(minimum:Int=1,maximum:Int=14)=Json.parseToJsonElement("""{"archivePresentation":{"version":1,"minimumSimVersion":$minimum,"maximumSimVersion":$maximum,"mode":"currentWebArchive","legacyMelee":{"mode":"sourceIdleAttack","selfDescribingSimVersion":7,"targetAwareSimVersion":5,"positionSnapDistance":1,"aim":{"minimumDeltaSquared":0.25,"retainWithinDegrees":32.5}}}}""").jsonObject
    @Test fun `read-only histories use their stored supported SIM without widening live content admission`() {
        assertTrue(archivedReplaySupported(13,14,catalog()))
        assertTrue(archivedReplaySupported(7,14,catalog()))
        assertTrue(archivedReplaySupported(6,14,catalog()))
        assertFalse(archivedReplaySupported(15,14,catalog()))
        assertFalse(archivedReplaySupported(13,null,catalog()))
    }
    @Test fun `old packs retain current archives only and stale catalogues never authorize a new content identity`() {
        assertTrue(archivedReplaySupported(14,14,null));assertFalse(archivedReplaySupported(13,14,null))
        assertFalse(archivedReplaySupported(13,15,catalog()))
        assertThrows(IllegalArgumentException::class.java) {ArchivedReplayPolicy.from(catalog(15,14)["archivePresentation"]!!.jsonObject)}
    }
    @Test fun `earliest archives require the explicit original legacy controller contract`() {
        val legacy=Json.parseToJsonElement("""{"archivePresentation":{"version":1,"minimumSimVersion":1,"maximumSimVersion":14,"mode":"currentWebArchive","legacyMelee":{"mode":"sourceIdleAttack","selfDescribingSimVersion":7,"targetAwareSimVersion":5,"positionSnapDistance":1,"aim":{"minimumDeltaSquared":0.25,"retainWithinDegrees":32.5}}}}""").jsonObject
        for(sim in 1..14)assertTrue(archivedReplaySupported(sim,14,legacy))
        assertFalse(archivedReplaySupported(0,14,legacy));assertFalse(archivedReplaySupported(15,14,legacy))
        val incomplete=JsonObject(legacy.getValue("archivePresentation").jsonObject-"legacyMelee")
        assertThrows(IllegalArgumentException::class.java) {ArchivedReplayPolicy.from(incomplete)}
    }
}
