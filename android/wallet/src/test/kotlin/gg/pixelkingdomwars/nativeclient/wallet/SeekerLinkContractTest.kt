package gg.pixelkingdomwars.nativeclient.wallet

import org.junit.Assert.*
import org.junit.Test

class SeekerLinkContractTest {
    private val game="DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val seeker="6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val nonce="a".repeat(48)
    private val message=listOf("play.pixelkingdomwars.com wants you to link a Solana Mobile Seeker wallet:",seeker,"",
        "Linking to Pixel Kingdom Wars account: $game","This proves you control the Seeker wallet. It grants no spending permission, triggers no blockchain transaction, and costs no fees.",
        "","Nonce: $nonce","Issued At: 2026-09-12T00:00:00.000Z").joinToString("\n")
    private fun checked(value:String=message,origin:String="https://play.pixelkingdomwars.com",ttl:Long=5)=SeekerLinkContract.message(origin,game,seeker,nonce,value,"2026-09-12T00:05:00.000Z",ttl)
    @Test fun `canonical link purpose and both wallets are exact signed bytes`() { assertEquals(message,checked().toString(Charsets.UTF_8)) }
    @Test fun `login spending other account domain nonce and lifetime substitutions cannot be signed`() {
        for(value in listOf(message.replace("link a Solana Mobile Seeker wallet","sign in with your Solana account"),message.replace(game,seeker),message.replace(nonce,"b".repeat(48)),message+"\nAuthorize spending"))
            assertThrows(IllegalArgumentException::class.java) { checked(value) }
        assertThrows(IllegalArgumentException::class.java) { checked(origin="https://other.example") }
        assertThrows(IllegalArgumentException::class.java) { checked(ttl=6) }
    }
}
