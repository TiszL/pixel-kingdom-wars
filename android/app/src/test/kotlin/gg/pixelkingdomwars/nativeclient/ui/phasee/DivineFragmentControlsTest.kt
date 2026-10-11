package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import org.junit.Assert.*
import org.junit.Test
class DivineFragmentControlsTest {
 @Test fun `entry needs provider availability or saved originals and remains reachable without provider`(){assertFalse(fragmentEntryAvailable(DivineFragmentState()));assertTrue(fragmentEntryAvailable(DivineFragmentState(available=true)));assertTrue(fragmentEntryAvailable(DivineFragmentState(journal=DivineFragmentJournal(identity=DivineFragmentFixtures.identity(),commands=listOf(DivineFragmentFixtures.command())))));assertFalse(fragmentEntryAvailable(null))}
 private val f=DivineFragmentFixtures
 @Test fun `unknown attempted delivery asks for outcome rather than claiming success`(){val c=f.command().copy(sent=true);assertEquals("CHECK OUTCOME",fragmentPill(c).label);assertEquals("DELIVERED",fragmentPill(c.copy(receipt=f.receipt(c))).label)}
 @Test fun `review requires original selected kingdom and allowed idle destination`(){val c=f.command();assertTrue(fragmentCanReview(c,f.base,true,false));assertFalse(fragmentCanReview(c,f.id(8),true,false));assertFalse(fragmentCanReview(c,f.base,false,false));assertFalse(fragmentCanReview(c,f.base,true,true));assertFalse(fragmentCanReview(c.copy(receipt=f.receipt(c)),f.base,true,false))}
 @Test fun `closed unsent draft is historical without being presented as delivered`(){val c=f.command().copy(closed=true);assertEquals("DRAFT CLOSED",fragmentPill(c).label);assertFalse(fragmentCanReview(c,f.base,true,false))}
 @Test fun `clan earning explains original roster share while proof identifiers remain in details`() {
  val award=DivineClanFragmentFixtures.award
  assertEquals("DIVINE CLAN EARNING",fragmentSourceTitle(award))
  val summary=fragmentSourceSummary(award)
  assertTrue(summary.contains("3 members"));assertTrue(summary.contains("13 gross per member"));assertTrue(summary.contains("40 site allowance"))
  assertFalse(summary.contains(award.fo("clan").ft("clanId")));assertFalse(summary.contains(award.fo("clan").ft("rosterHash")))
  assertEquals(award.fo("clan").ft("rosterHash"),fragmentAwardDetails(award).single{it.label=="Frozen roster hash"}.value)
  assertEquals("DIVINE INDIVIDUAL EARNING",fragmentSourceTitle(f.award));assertEquals("Original individual occupation",fragmentSourceSummary(f.award))
 }
 @Test fun `saved clan delivery keeps destination gates and never appears delivered before a receipt`() {
  val command=DivineClanFragmentFixtures.command().copy(sent=true)
  assertEquals("CHECK OUTCOME",fragmentPill(command).label)
  assertFalse(fragmentCanReview(command,f.id(9),true,false));assertFalse(fragmentCanReview(command,command.base,false,false))
  assertEquals("DELIVERED",fragmentPill(command.copy(receipt=DivineClanFragmentFixtures.receipt(command))).label)
 }

}
