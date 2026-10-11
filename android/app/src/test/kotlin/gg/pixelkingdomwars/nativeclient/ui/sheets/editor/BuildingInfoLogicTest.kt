package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The BuildingInfo sheet's rules (design/final/buildings/SPEC.md §2A, design correction 7). Why they matter: INFO is the
 * door every building opens first. Its UPGRADE entry is navigation, so it must open the UPGRADE sheet even while the
 * price is still being checked or short (that sheet explains the shortfall); FINISH spends Gems, so a short FINISH must go
 * to Need-more and an unavailable price must explain itself instead of doing nothing. A sheet that is still loading must
 * never act, and a stat must never read as a made-up 0.
 */
class BuildingInfoLogicTest {
    private fun shards(status: PriceStatus) = PriceUi(Currency.SHARDS, "521", status)
    private fun gems(status: PriceStatus) = PriceUi(Currency.GEMS, "38", status)

    @Test fun `upgrade entry is navigation even when the price is checking or short`() {
        assertEquals(InfoTap.UPGRADE, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.UPGRADE, CommandState.ENABLED, null))
        assertEquals("correction 7: CHECKING is enabled navigation", InfoTap.UPGRADE,
            infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.UPGRADE, CommandState.ENABLED, shards(PriceStatus.CHECKING)))
        assertEquals("the UPGRADE sheet shows the shortfall; INFO never spends", InfoTap.UPGRADE,
            infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.UPGRADE, CommandState.SHORT, shards(PriceStatus.SHORT)))
        assertEquals(CommandState.ENABLED, infoDrawState(InfoPrimaryKind.UPGRADE, CommandState.SHORT, shards(PriceStatus.SHORT)))
    }

    @Test fun `finish opens the seal, or need-more when the gems are short`() {
        assertEquals(InfoTap.FINISH, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.FINISH, CommandState.ENABLED, gems(PriceStatus.OK)))
        assertEquals(InfoTap.FINISH, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.FINISH, CommandState.ENABLED, gems(PriceStatus.CHECKING)))
        assertEquals(InfoTap.NEED_MORE, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.FINISH, CommandState.ENABLED, gems(PriceStatus.SHORT)))
        assertEquals(CommandState.SHORT, infoDrawState(InfoPrimaryKind.FINISH, CommandState.ENABLED, gems(PriceStatus.SHORT)))
    }

    @Test fun `an unavailable price or a locked feature explains itself`() {
        val look = infoPrimaryLook(InfoLoad.READY, InfoPrimaryKind.FINISH, "FINISH", null, CommandState.ENABLED, null, gems(PriceStatus.UNAVAILABLE))
        assertEquals(CommandState.DISABLED, look.state)
        assertEquals("an off button always says why", "price unavailable right now", look.reason)
        assertEquals(InfoTap.EXPLAIN, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.FINISH, CommandState.ENABLED, gems(PriceStatus.UNAVAILABLE)))
        assertEquals(InfoTap.EXPLAIN, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.UPGRADE, CommandState.LOCKED, null))
        assertEquals("Opens 14 Oct",
            infoPrimaryLook(InfoLoad.READY, InfoPrimaryKind.UPGRADE, "UPGRADE TO LV 5", null, CommandState.LOCKED, "Opens 14 Oct", null).reason)
    }

    @Test fun `loading never acts and an error waits for the server`() {
        val loading = infoPrimaryLook(InfoLoad.LOADING, InfoPrimaryKind.UPGRADE, "UPGRADE TO LV 5", "Uses 1 builder", CommandState.ENABLED, null, null)
        assertEquals(CommandState.BUSY, loading.state); assertEquals("Checking", loading.label)
        assertEquals(InfoTap.NONE, infoPrimaryTap(InfoLoad.LOADING, InfoPrimaryKind.UPGRADE, CommandState.ENABLED, null))
        val error = infoPrimaryLook(InfoLoad.ERROR, InfoPrimaryKind.UPGRADE, "UPGRADE TO LV 5", "Uses 1 builder", CommandState.ENABLED, null, null)
        assertEquals(CommandState.DISABLED, error.state); assertEquals("waiting for the server", error.reason)
        assertEquals(InfoTap.EXPLAIN, infoPrimaryTap(InfoLoad.ERROR, InfoPrimaryKind.UPGRADE, CommandState.ENABLED, null))
    }

    @Test fun `max level is a plate, not a door`() {
        assertEquals(InfoTap.NONE, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.MAX, CommandState.ENABLED, null))
        assertEquals(InfoTap.NONE, infoPrimaryTap(InfoLoad.READY, InfoPrimaryKind.UPGRADE, CommandState.BUSY, null))
    }

    @Test fun `portraits get the frame, plain icons do not`() {
        assertEquals(true, statIconFramed("ui_portrait_dragon_t2"))
        assertEquals(true, statIconFramed("troop-giant"))
        assertEquals(false, statIconFramed("attack"))
        assertEquals(false, statIconFramed("shield"))
    }

    @Test fun `stats are spoken with their change and unknown is the ellipsis`() {
        assertEquals("Hitpoints: 360, next level 430", statSpoken("Hitpoints", "360", "430", null))
        assertEquals("Range: 7 tiles", statSpoken("Range", "7 tiles", null, null))
        assertEquals("Hits flying troops: yes", statSpoken("Hits flying troops", null, null, true))
        assertEquals("Damage per second: …", statSpoken("Damage per second", null, null, null))
    }
}
