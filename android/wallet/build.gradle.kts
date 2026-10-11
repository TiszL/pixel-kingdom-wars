plugins { id("com.android.library"); kotlin("android") }
android { namespace = "gg.pixelkingdomwars.nativeclient.wallet"; compileSdk = 36
    defaultConfig { minSdk = 28; consumerProguardFiles("consumer-rules.pro") }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation(project(":network"))
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.7")
    // `api`, not `implementation`: the app manifest declares the SDK's PrivyRedirectActivity (OAuth callback), which
    // lint (MissingClass) and the app compile classpath must resolve. Game code still reaches Privy only through
    // PrivySurface / PrivyWalletAdapter; nothing in :app may call io.privy.* directly.
    api("io.privy:privy-core:0.14.0")
    // Ed25519 verification of a wallet-returned payment signature (SignedTransaction.kt). Privy already ships this
    // exact artifact at runtime; declaring it only puts it on this module's compile classpath, at the same version.
    implementation("org.bouncycastle:bcprov-jdk18on:1.79")
    testImplementation("junit:junit:4.13.2")
}
