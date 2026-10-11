package android.os;

/**
 * JVM unit-test stand-in for the platform tracer. Compose runtime's composer brackets every composition with
 * android.os.Trace.beginSection/endSection, and the SDK stub jar throws "Method beginSection in android.os.Trace
 * not mocked" for both, so a test that composes on the JVM (HomeRouteDispatcherTest, HomeFourGroupMountTest) could
 * never run. AGP puts the mockable android.jar LAST on the unit-test classpath so test classes can shadow a stub class;
 * this one shadows only Trace (its public API, as the platform does with tracing off) instead of turning on
 * unitTests.isReturnDefaultValues, which would change every other stubbed call in the suite. Test-only: never packaged.
 */
public final class Trace {
    private Trace() {}

    public static boolean isEnabled() { return false; }

    public static void beginSection(String sectionName) {}

    public static void endSection() {}

    public static void beginAsyncSection(String methodName, int cookie) {}

    public static void endAsyncSection(String methodName, int cookie) {}

    public static void setCounter(String counterName, long counterValue) {}
}
