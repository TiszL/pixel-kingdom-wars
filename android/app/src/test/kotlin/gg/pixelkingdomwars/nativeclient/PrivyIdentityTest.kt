package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.wallet.PrivyPublicConfig
import org.junit.Assert.*
import org.junit.Test

/** The social-login track must bind to the EXISTING production Privy app and the Android
 * app client the owner registered for it; a blank or foreign identity would silently create
 * a second user base. The isolated candidate deliberately disables this track.
 * Both values are public identifiers (docs/PRIVY_ANDROID.md). */
class PrivyIdentityTest {
    @Test fun `production retains its Privy identity while isolated candidate excludes the social track`() {
        val config = PrivyPublicConfig.from(BuildConfig.PRIVY_APP_ID, BuildConfig.PRIVY_APP_CLIENT_ID)
        if (BuildConfig.NATIVE_CANDIDATE) {
            assertEquals("https://qa.pixelkingdomwars.com", BuildConfig.API_ORIGIN)
            assertEquals(BuildConfig.API_ORIGIN, BuildConfig.WALLET_IDENTITY_ORIGIN)
            assertEquals("", BuildConfig.PRIVY_APP_ID)
            assertEquals("", BuildConfig.PRIVY_APP_CLIENT_ID)
            assertNull("The test kingdom must not share production's social-login identity", config)
        } else {
            assertNotNull(config)
            assertEquals("cmrxb5f1w00vz0cjrxij9vz2e", config!!.appId)
            assertTrue(config.appClientId.startsWith("client-"))
            assertEquals(config.appClientId, config.appClientId.trim())
        }
    }
}
