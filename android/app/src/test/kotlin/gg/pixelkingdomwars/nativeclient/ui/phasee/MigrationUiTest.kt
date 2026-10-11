package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import org.junit.Assert.*
import org.junit.Test
class MigrationUiTest {
 private val f=MigrationFixtures
 private fun state(r:MigrationRecord)=MigrationState(loaded=true,journal=MigrationJournal(identity=f.identity(),records=listOf(r)),selected=r.key)
 @Test fun `paused controls preserve history while hiding new wallet and relay actions`() {
  val r=MigrationRecord(f.key,f.clan,response=f.prepared);val s=state(r);val c=migrationControls(s,false);assertFalse(c.review);assertFalse(c.approve);assertFalse(c.deliver);assertTrue(c.recover);assertTrue(c.cancel);assertTrue(migrationEntryAvailable(s,false,false))
 }
 @Test fun `unknown wallet and held terminal disable new approvals but retain original recovery`() {
  val r=MigrationRecord(f.key,f.clan,response=f.prepared,attempts=listOf("wallet"));assertFalse(migrationControls(state(r),true).review);assertFalse(migrationControls(state(r).copy(reviewed=true),true).approve)
  val held=r.copy(held=true);val c=migrationControls(state(held),true);assertFalse(c.upload);assertFalse(c.deliver);assertFalse(c.cancel);assertTrue(c.recover);assertEquals("OUTCOME NEEDS VERIFICATION",migrationStatus(held))
 }
 @Test fun `same original pending can retry while terminal disables every irreversible action`() {
  val pending=MigrationRecord(f.key,f.clan,response=f.status("pending"),attempts=listOf("prepare:0"));assertTrue(migrationControls(state(pending),true).prepare)
  val done=pending.copy(response=f.status("controlled"));val c=migrationControls(state(done),true);assertFalse(c.prepare);assertFalse(c.review);assertFalse(c.approve);assertFalse(c.deliver);assertFalse(c.cancel);assertFalse(c.recover);assertEquals("CHARTER REGISTERED",migrationStatus(done))
 }
 @Test fun `saved migration independently exposes entry without creation journal or trust`() {
  assertFalse(migrationEntryAvailable(MigrationState(loaded=true),false,false));assertTrue(migrationEntryAvailable(state(MigrationRecord(f.key,f.clan)),false,false));assertTrue(migrationEntryAvailable(null,false,true))
 }
}
