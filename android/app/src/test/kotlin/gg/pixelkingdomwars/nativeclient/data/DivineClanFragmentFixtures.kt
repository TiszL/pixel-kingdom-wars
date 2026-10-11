package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.divinefragments.*
import kotlinx.serialization.json.*

object DivineClanFragmentFixtures {
 val raw=Json.parseToJsonElement(javaClass.classLoader!!.getResource("divine-clan-fragment-vectors.json")!!.readText()).jsonObject
 val award=raw.fo("award")
 fun command()=DivineFragmentCommand("delivery",raw.fo("consent"),DivineFragmentFixtures.rules.raw)
 fun receipt(c:DivineFragmentCommand)=JsonObject(raw.fo("delivery")+c.consent.fo("request"))
}
