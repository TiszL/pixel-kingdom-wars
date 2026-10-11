# Privy 0.14.0's OAuth redirect Activity logs its callback URI independently of
# PrivyLogLevel. Strip framework logging in release and optimized debug builds
# before testing real social accounts (nativeOptimizedDebug=true).
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
    public static int w(...);
    public static int e(...);
    public static int wtf(...);
    public static int println(...);
}
