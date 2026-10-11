package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Source wiring pins complement ArmyEntryHeroesReadTest; Compose execution remains Cedar3's gate. */
class ArmyHeroEntrySourceContractTest {
    private fun source() = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/army/live/ArmyLiveHosts.kt").readText()
    @Test fun `Army entry opts into heroes inside the existing resumed owner effect`() {
        val source = source()
        val entry = source.substring(source.indexOf("LaunchedEffect(model, lifecycle, state.wallet"), source.indexOf("    val army = trainingCurrentArmy"))
        assertTrue(entry.contains("state.baseId, baseGeneration")); assertTrue(entry.contains("repeatOnLifecycle(Lifecycle.State.RESUMED)"))
        assertTrue(entry.contains("model.busy.first { !it }")); assertTrue(entry.contains("model.refreshTrainingFinish(includeHeroes = true)?.join()"))
        val timer = source.substring(source.indexOf("    LaunchedEffect(headFinish)"), source.indexOf("    // Saved armies"))
        assertTrue(timer.contains("model.refreshTrainingFinish()?.join()")); assertFalse(timer.contains("includeHeroes = true"))
    }
    @Test fun `explicit route hero keys remembered selection and synchronizes into the roster owner`() {
        val hero = source().substringAfter("@Composable internal fun HeroesLiveHost")
        assertTrue(hero.contains("rememberSaveable(model, initialHero) { mutableStateOf(initialHero ?: state.selectedHero) }"))
        assertTrue(hero.contains("LaunchedEffect(model, hero) { if (model.state.value.selectedHero != hero) model.selectHero(hero) }"))
        assertTrue(hero.contains("heroesLiveUi(state, hero, tab, now, busy, selectedSlot)"))
    }
    @Test fun `hero switch synchronizes owner while paid callbacks request existing reviews and mount their consent`() {
        val hero = source().substringAfter("@Composable internal fun HeroesLiveHost").substringBefore("// Raid chooser")
        assertTrue(hero.contains("onSwitchHero = { hero = otherHero(hero); model.selectHero(hero) }"))
        // Rewritten with A5: UPGRADE and FINISH rest used to hop to the legacy HeroesScreen; they now ask the existing
        // owner for its review and mount that consent on the sheet, and still never confirm, upgrade or recover directly.
        assertTrue(hero.contains("model.reviewHeroUpgrade(hero)")); assertTrue(hero.contains("model.reviewHeroRecovery(hero)"))
        assertTrue(hero.contains("HeroCurrencyConfirm(state, busy, model)"))
        // Rewritten with c-gap-army (2026-10-06): on Home the history icon opens the designed History sheet the caller passes
        // (onHistoryDoor); the bag on GEAR and the legacy HeroesScreen elsewhere remain only the standalone route's fallback.
        assertTrue(hero.contains("onHistory = { if (onHistoryDoor != null) onHistoryDoor() else if (tab == HERO_TAB_GEAR) onOpenGear() else legacyOpen = true }"))
        assertFalse(hero.contains("model.confirmHeroSpend(")); assertFalse(hero.contains("model.upgradeHero(")); assertFalse(hero.contains("model.recoverHero("))
    }
}
