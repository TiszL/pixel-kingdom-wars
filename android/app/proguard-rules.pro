-keep class com.badlogic.gdx.backends.android.AndroidGL* { *; }
-keepclassmembers class * { native <methods>; }
# libGDX Pools creates these through Class objects and a public no-arg constructor.
# Base creation initializes GlyphRun's pool; BitmapFontCache also pools GlyphLayout.
-keep,allowobfuscation class com.badlogic.gdx.graphics.g2d.GlyphLayout {
    public <init>();
}
-keep,allowobfuscation class com.badlogic.gdx.graphics.g2d.GlyphLayout$GlyphRun {
    public <init>();
}
# The realm map's detail tables are read with Class.getResourceAsStream("<name>.json"), a name relative to the class's
# own package; the JSON ships at the source package path. R8 renames packages (1953cc8 release: DecorTables -> f5.W),
# so the lookup searched f5/ and missed: the detail lanes (GROUND, LIFE, BASES) never loaded and the realm maps stayed
# at the overview in the release and optimized candidate APKs, silently in release. Keep the names, so the packages.
# tools/check-release-world.test.mjs requires a rule here for every such lookup in main sources.
-keepnames class gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorTables
-keepnames class gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeTablesFile
