package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import org.junit.Assert.*
import org.junit.Test

/** Cross-screen Home requests are a queue whose head implies its tab. BUILD on the quest board (reached
 * only through the More tab) must land on Kingdom with the build tray open — web `openBuild` sets the
 * category and the screen together — never on More with a latent tray request waiting for the next visit. */
class HomeRequestsTest {
    @Test fun `requests queue in order and only the head can be consumed`() {
        val requests = HomeRequests()
        requests.request(HomeRequest.Tab(HomeTab.KINGDOM)); requests.request(HomeRequest.BuildMenu)
        assertEquals("A second request no longer overwrites the first", HomeRequest.Tab(HomeTab.KINGDOM), requests.pending.value)
        requests.consume(HomeRequest.BuildMenu)
        assertEquals("A later request cannot be consumed ahead of the head", HomeRequest.Tab(HomeTab.KINGDOM), requests.pending.value)
        requests.consume(HomeRequest.Tab(HomeTab.KINGDOM)); assertEquals(HomeRequest.BuildMenu, requests.pending.value)
        requests.consume(HomeRequest.BuildMenu); assertNull(requests.pending.value)
        requests.consume(HomeRequest.BuildMenu); assertNull("Consuming an empty queue is harmless", requests.pending.value)
    }
    @Test fun `BUILD from the quest board implies the Kingdom tab and leaves the tray request for the Kingdom screen`() {
        val requests = HomeRequests()
        requests.request(HomeRequest.BuildMenu)
        val head = requireNotNull(requests.pending.value)
        assertEquals("The scaffold switches to Kingdom for a build-tray request", HomeTab.KINGDOM, head.homeTab); assertFalse(head is HomeRequest.Tab)
        assertEquals(HomeTab.KINGDOM, HomeRequest.FocusBuilding("b1").homeTab); assertEquals(HomeTab.ARMY, HomeRequest.Tab(HomeTab.ARMY).homeTab)
        // The scaffold consumes only bare tab requests; the tray request stays for the Kingdom screen once its base is loaded.
        requests.consume(HomeRequest.Tab(HomeTab.KINGDOM)); assertEquals(HomeRequest.BuildMenu, requests.pending.value)
        requests.consume(HomeRequest.BuildMenu); assertNull(requests.pending.value)
    }
    @Test fun `Barracks training survives the tab switch until Army opens its composer`() {
        val requests = HomeRequests()
        requests.request(HomeRequest.Training)
        val head = requireNotNull(requests.pending.value)
        assertEquals(HomeTab.KINGDOM, head.homeTab)
        assertFalse("The scaffold must not consume a composer request as a bare tab switch", head is HomeRequest.Tab)
        requests.consume(HomeRequest.Tab(HomeTab.ARMY))
        assertEquals(HomeRequest.Training, requests.pending.value)
        requests.consume(HomeRequest.Training)
        assertNull("Reopening Army must not repeat the previous Barracks request", requests.pending.value)
    }
    @Test fun `a rapid repeated training tap cannot strand later navigation behind an equal flow head`() {
        val requests = HomeRequests()
        requests.request(HomeRequest.Training)
        requests.request(HomeRequest.Training)
        requests.request(HomeRequest.BuildMenu)
        requests.consume(HomeRequest.Training)
        assertEquals("One handled training destination must expose the later build request", HomeRequest.BuildMenu, requests.pending.value)
        requests.consume(HomeRequest.BuildMenu)
        assertNull(requests.pending.value)
    }
    @Test fun `returning to the same destination after another request preserves the queued order`() {
        val requests = HomeRequests()
        requests.request(HomeRequest.Training)
        requests.request(HomeRequest.BuildMenu)
        requests.request(HomeRequest.Training)
        requests.consume(HomeRequest.Training)
        assertEquals(HomeRequest.BuildMenu, requests.pending.value)
        requests.consume(HomeRequest.BuildMenu)
        assertEquals("Only consecutive equal requests are coalesced", HomeRequest.Training, requests.pending.value)
        requests.consume(HomeRequest.Training)
        assertNull(requests.pending.value)
    }
}
