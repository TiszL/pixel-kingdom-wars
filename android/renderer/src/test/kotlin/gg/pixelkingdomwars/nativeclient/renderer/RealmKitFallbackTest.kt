package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

/** A pack without the realm kit must still open the kingdom.
 *
 * Why this exists: the server presents `groundRevision` 5 to every renderer that declares the kit contract. On
 * 2026-10-04 the QA candidate carried pack ae8104ad (contract 15, pinned from a source older than the kit, so no
 * `layeredGroundV5`), `prepareGround` refused the first base preparation with "Realm kit content is unavailable", and
 * the owner's phone showed "Couldn't open your kingdom" instead of his base. A missing kit is a content gap, not a
 * reason to refuse the scene: the same realm's revision-4 painting is in every such pack and is what the server itself
 * serves to a renderer below the kit contract. BundledRealmKitAdmissionTest still requires the shipped pack to carry the
 * kits; this rule only decides what a pack without them draws. */
class RealmKitFallbackTest {
    private val kitContext = RealmVisual("crownlands", 2, 5)

    @Test fun `revision 5 without kit content presents the same realm at revision 4`() {
        assertEquals(RealmVisual("crownlands", 2, 4), presentableGroundVisual(kitContext, kitAvailable = false))
        assertEquals(RealmVisual("seeker-reach", 2, 4), presentableGroundVisual(RealmVisual("seeker-reach", 2, 5), kitAvailable = false))
    }

    @Test fun `revision 5 with kit content is drawn as the kit`() {
        assertSame(kitContext, presentableGroundVisual(kitContext, kitAvailable = true))
    }

    @Test fun `older revisions, painted ground and an absent context are never rewritten`() {
        val untouched = listOf(RealmVisual("thornwake", 2, 4), RealmVisual("sunscar", 2, 3), RealmVisual("crownlands", 2, 2),
            RealmVisual("crownlands", 2, null), RealmVisual("crownlands", 1, null))
        for (visual in untouched) for (kit in listOf(true, false)) assertSame(visual, presentableGroundVisual(visual, kit))
        assertNull(presentableGroundVisual(null, kitAvailable = false))
    }

    @Test fun `a revision-5 context of another art generation still fails closed`() {
        val odd = RealmVisual("crownlands", 1, 5)
        assertSame(odd, presentableGroundVisual(odd, kitAvailable = false))
    }
}
