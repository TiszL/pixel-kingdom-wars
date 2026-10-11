plugins { kotlin("jvm") }
kotlin { jvmToolchain(17) }
dependencies {
    api("com.badlogicgames.gdx:gdx:1.13.1")
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
}
tasks.test {
    useJUnit()
    // Authored-pack tests read assets outside this module. A pack import must
    // invalidate cached test results even when Kotlin sources are unchanged.
    val combatPack=providers.environmentVariable("PKW_COMBAT_PACK").orNull
    inputs.property("combatPackOverride",combatPack ?: "bundled")
    inputs.dir(rootProject.file("app/src/main/assets/native"))
    if(combatPack!=null) inputs.dir(file(combatPack))
    if(combatPack==null) inputs.dir(rootProject.file("app/src/debug/assets/native/fixtures"))
    outputs.dir(rootProject.file(".reports/visual"))
}
// ZeroAllocationFrameTest's strict gate (GLOBE-NATIVE-PLAN §5.9). With the JIT off (-Xint), no escape analysis hides an
// allocation that ART would make, so one window of 600 steady frames must allocate exactly 0 bytes. `test` depends on
// it, so CI's :renderer:test runs it. Its report is build/reports/tests/zeroAllocationInterpreted.
val zeroAllocationInterpreted = tasks.register<Test>("zeroAllocationInterpreted") {
    description = "ZeroAllocationFrameTest under -Xint: one window of 600 frames, exactly 0 bytes"
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    useJUnit()
    filter { includeTestsMatching("gg.pixelkingdomwars.nativeclient.renderer.world.ZeroAllocationFrameTest") }
    jvmArgs("-Xint")
    systemProperty("pkw.zeroAllocation.interpreted", "true")
}
tasks.test { dependsOn(zeroAllocationInterpreted) }
