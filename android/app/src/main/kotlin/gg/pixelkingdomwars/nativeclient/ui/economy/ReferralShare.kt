package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.nav.GameLinkContract
import java.net.URLEncoder

/** Canonical web ReferralCodeChip: SHARE LINK copies a public URL, never account credentials. */
internal fun referralShareUrl(code: String): String =
    "${GameLinkContract.ORIGIN}/?ref=${URLEncoder.encode(code, "UTF-8").replace("+", "%20")}"
