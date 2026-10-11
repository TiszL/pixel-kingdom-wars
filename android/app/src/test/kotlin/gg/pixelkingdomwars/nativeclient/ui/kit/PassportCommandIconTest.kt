package gg.pixelkingdomwars.nativeclient.ui.kit

import gg.pixelkingdomwars.nativeclient.R
import org.junit.Assert.assertEquals
import org.junit.Test

class PassportCommandIconTest {
    @Test fun `Passport command resolves the existing book drawable`() {
        assertEquals(R.drawable.pkw_ui_item_realm_passport, kitDrawable("ui:realm-passport"))
    }
}
