package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
class TournamentUiTest {
 @Test fun `unconfigured busy and held originals cannot prompt or deliver`()=runBlocking {
  val f=TournamentFixtures;val s=TournamentStore(TournamentFixtures.Memory(),f.identity());val r=s.operation(f.operation);s.observe(r.key,f.operation);s.accept(r.key,f.operation)
  val state=TournamentState(loaded=true,journal=s.read(),selectedOperation=r.key,reviewed=true)
  assertTrue(tournamentControls(state,true).approve);assertFalse(tournamentControls(state,false).approve);assertFalse(tournamentControls(state.copy(busy=true),true).approve)
  s.observe(r.key,f.operation);assertFalse(tournamentControls(state.copy(journal=s.read()),true).approve);Unit
 }
 @Test fun `wallet marker hides another approval while retaining recovery`()=runBlocking {
  val f=TournamentFixtures;val s=TournamentStore(TournamentFixtures.Memory(),f.identity());val r=s.operation(f.operation);s.observe(r.key,f.operation);s.accept(r.key,f.operation);s.attempt(r.key,"wallet")
  val c=tournamentControls(TournamentState(loaded=true,journal=s.read(),selectedOperation=r.key,reviewed=true),true);assertFalse(c.approve);assertFalse(c.review);assertTrue(c.recover);Unit
 }
}
