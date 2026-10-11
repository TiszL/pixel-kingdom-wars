package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/** The designed tag colour of an owner's receipt pill on the craft records page (c-gap-craft): an open draft is gold (the
 *  player's job), a sent / accepted request blue (information), a finished one green, trouble red, a closed one stone. */
internal fun paymentRecordVerb(tone: PaymentTone): Verb = when (tone) {
    PaymentTone.OPEN -> Verb.GOLD
    PaymentTone.SENT -> Verb.BLUE
    PaymentTone.DONE -> Verb.GREEN
    PaymentTone.TROUBLE -> Verb.RED
    PaymentTone.CLOSED -> Verb.STONE
}
