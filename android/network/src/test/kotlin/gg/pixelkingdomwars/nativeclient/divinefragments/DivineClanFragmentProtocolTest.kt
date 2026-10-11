package gg.pixelkingdomwars.nativeclient.divinefragments

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DivineClanFragmentProtocolTest {
 private val old=Json.parseToJsonElement(javaClass.classLoader!!.getResource("divine-fragment-vectors.json")!!.readText()).jsonObject
 private val f=Json.parseToJsonElement(javaClass.classLoader!!.getResource("divine-clan-fragment-vectors.json")!!.readText()).jsonObject
 private val r=DivineFragmentRules.from(old.fo("rules"));private val a=f.fo("award")
 private fun set(o:JsonObject,k:String,v:JsonElement)=JsonObject(o+(k to v))
 private fun clan(k:String,v:JsonElement)=set(a,"clan",set(a.fo("clan"),k,v))
 private fun reject(block:()->Unit){assertTrue(runCatching(block).isFailure)}

 @Test fun `strict old and clan variants preserve original JSON and consent without rewriting rules`() {
  assertEquals(old.fo("award").toString(),r.award(old.fo("award")).toString())
  assertEquals(a.toString(),r.award(a).toString())
  assertEquals(f.fo("delivery"),r.match(f.fo("delivery"),"delivery",f.fo("consent")))
  assertEquals(old.fo("rules"),r.raw)
 }
 @Test fun `clan shape cannot omit required provenance or smuggle it into an individual award`() {
  reject{r.award(JsonObject(a-"clan"))};reject{r.award(set(a,"clan",JsonNull))}
  reject{r.award(set(a,"site",old.fo("award").getValue("site")))}
  reject{r.award(set(old.fo("award"),"clan",a.getValue("clan")))}
  for(k in a.fo("clan").keys)reject{r.award(set(a,"clan",JsonObject(a.fo("clan")-k)))}
  reject{r.award(clan("currentLeader",a.getValue("wallet")))}
 }
 @Test fun `clan roster and site allowance must conserve their authenticated partition`() {
  for(v in listOf(0,257))reject{r.award(clan("rosterSize",JsonPrimitive(v)))}
  reject{r.award(clan("rosterSize",JsonPrimitive(2)))} // Different division cannot retain the old gross.
  reject{r.award(clan("rosterSize",JsonPrimitive("3")))}
  for(v in listOf("0","2001","41"))reject{r.award(clan("siteGross",JsonPrimitive(v)))}
  for(v in listOf("divine-clan-000","divine-clan-051","divine-clan-1","divine-individual-001"))reject{r.award(set(a,"site",JsonPrimitive(v)))}
 }
 @Test fun `full tournament domain is strict and its economic projection cannot drift`() {
  val domain=a.fo("clan").fo("tournamentDomain")
  for(k in listOf("genesisHash","economyProgram"))reject{r.award(clan("tournamentDomain",set(domain,k,JsonPrimitive("11111111111111111111111111111111"))))}
  reject{r.award(clan("tournamentDomain",JsonObject(domain-"treasury")))}
  reject{r.award(clan("tournamentDomain",set(domain,"craftProgram",JsonPrimitive("bad"))))}
  for(k in listOf("clanId","entryId"))reject{r.award(clan(k,JsonPrimitive("00000000-0000-0000-0000-000000000000")))}
  reject{r.award(clan("rosterHash",JsonPrimitive("c".repeat(63))))}
 }
 @Test fun `clan share continues the original individual carry and never reuses its gross`() {
  assertEquals(old.fo("award")["carryAfter"],a["carryBefore"])
  for((k,v) in listOf("gross" to "14","net" to "13","tax" to "0","carryBefore" to "0","carryAfter" to "0"))reject{r.award(set(a,k,JsonPrimitive(v)))}
  r.award(JsonObject(a+mapOf("winnerCount" to JsonPrimitive(0),"poolDisposition" to JsonPrimitive("held_zero_winners"))))
  reject{r.award(set(a,"winnerCount",JsonPrimitive(0)))}
 }
 @Test fun `one mixed award page keeps source identities and monotone original event order`() {
  fun page(rows:List<JsonObject>)=buildJsonObject{put("version",1);put("wallet",a.getValue("wallet"));put("rows",JsonArray(rows));put("nextCursor",JsonNull)}
  val individual=buildJsonObject{put("award",old.fo("award"));put("delivery",old.fo("delivery"))}
  val clan=buildJsonObject{put("award",a);put("delivery",JsonNull)}
  r.page(page(listOf(individual,clan)),a.ft("wallet"),"awards",null)
  reject{r.page(page(listOf(clan,individual)),a.ft("wallet"),"awards",null)}
  reject{r.page(page(listOf(clan,clan)),a.ft("wallet"),"awards",null)}
 }
 @Test fun `clan receipt never accepts individual amount or changed original destination`() {
  val receipt=f.fo("delivery");val consent=f.fo("consent")
  reject{r.match(set(receipt,"quantity",old.fo("delivery").getValue("quantity")),"delivery",consent)}
  for(k in listOf("eventId","baseId","idempotencyKey"))reject{r.match(set(receipt,k,JsonPrimitive("00000000-0000-4000-8000-000000000099")),"delivery",consent)}
 }
}
