# Only the exact-origin, optimized debug candidate includes this file.
# The bootstrap lives in androidTest, never in the main APK. R8 cannot see its
# calls or its SecretStore implementation while optimizing the target alone.
# Keep those entry-point shapes, including Kotlin default/suspend bridges.
# Obfuscation remains enabled: AGP applies the target mapping to the test APK.
# Do not add package-wide keeps or allowoptimization to these ABI declarations.

-keep,allowobfuscation,includedescriptorclasses interface gg.pixelkingdomwars.nativeclient.network.SecretStore {
    public java.lang.String read();
    public void write(java.lang.String);
    public void clear();
}
-keep,allowobfuscation,includedescriptorclasses class gg.pixelkingdomwars.nativeclient.network.EncryptedStore {
    public <init>(android.content.Context,java.lang.String);
    public java.lang.String read();
}
-keep,allowobfuscation,includedescriptorclasses class gg.pixelkingdomwars.nativeclient.network.SessionCookieJar {
    public <init>(okhttp3.HttpUrl,gg.pixelkingdomwars.nativeclient.network.SecretStore,kotlin.jvm.functions.Function0,int,kotlin.jvm.internal.DefaultConstructorMarker);
    public java.util.List loadForRequest(okhttp3.HttpUrl);
    public void saveFromResponse(okhttp3.HttpUrl,java.util.List);
}
-keep,allowobfuscation,includedescriptorclasses class gg.pixelkingdomwars.nativeclient.network.GameApi {
    public <init>(java.lang.String,gg.pixelkingdomwars.nativeclient.network.SessionCookieJar,java.lang.String,kotlin.jvm.functions.Function0);
    public <init>(java.lang.String,gg.pixelkingdomwars.nativeclient.network.SessionCookieJar,java.lang.String,kotlin.jvm.functions.Function0,int,kotlin.jvm.internal.DefaultConstructorMarker);
    public static java.lang.Object get$default(gg.pixelkingdomwars.nativeclient.network.GameApi,java.lang.String,java.util.Map,gg.pixelkingdomwars.nativeclient.network.SessionToken,kotlin.coroutines.Continuation,int,java.lang.Object);
}
-keep,allowobfuscation,includedescriptorclasses class gg.pixelkingdomwars.nativeclient.network.GameApiKt {
    public static java.lang.String string(kotlinx.serialization.json.JsonObject,java.lang.String);
    public static boolean flag(kotlinx.serialization.json.JsonObject,java.lang.String);
}
-keep,allowobfuscation,includedescriptorclasses class gg.pixelkingdomwars.nativeclient.network.StorageNamespaceKt {
    public static java.lang.String storageNamespace(java.lang.String,java.lang.String);
}
-keep,allowobfuscation,includedescriptorclasses class gg.pixelkingdomwars.nativeclient.network.NativeContentManifestKt {
    public static gg.pixelkingdomwars.nativeclient.network.NativeContentManifest nativeContentManifest(kotlinx.serialization.json.JsonObject,int);
}
-keep,allowobfuscation,includedescriptorclasses class gg.pixelkingdomwars.nativeclient.network.NativeContentManifest {
    public java.lang.String getContentVersion();
    public java.lang.String getSourceCommit();
}

# Cookie parsing/building stays the app's normal policy, with original expiry.
-keep,allowobfuscation,includedescriptorclasses class okhttp3.HttpUrl {
    public static okhttp3.HttpUrl$Companion Companion;
    public java.lang.String host();
    public okhttp3.HttpUrl resolve(java.lang.String);
}
-keep,allowobfuscation,includedescriptorclasses class okhttp3.HttpUrl$Companion {
    public okhttp3.HttpUrl get(java.lang.String);
}
-keep,allowobfuscation,includedescriptorclasses class okhttp3.Cookie {
    public static okhttp3.Cookie$Companion Companion;
    public java.lang.String name();
    public java.lang.String value();
    public java.lang.String domain();
    public java.lang.String path();
    public long expiresAt();
    public boolean hostOnly();
    public boolean secure();
    public boolean httpOnly();
}
-keep,allowobfuscation,includedescriptorclasses class okhttp3.Cookie$Companion {
    public okhttp3.Cookie parse(okhttp3.HttpUrl,java.lang.String);
}
-keep,allowobfuscation,includedescriptorclasses class okhttp3.Cookie$Builder {
    public <init>();
    public okhttp3.Cookie$Builder name(java.lang.String);
    public okhttp3.Cookie$Builder value(java.lang.String);
    public okhttp3.Cookie$Builder hostOnlyDomain(java.lang.String);
    public okhttp3.Cookie$Builder path(java.lang.String);
    public okhttp3.Cookie$Builder expiresAt(long);
    public okhttp3.Cookie$Builder secure();
    public okhttp3.Cookie$Builder httpOnly();
    public okhttp3.Cookie build();
}

# Exact JSON entry points compiled into the test-only manifest/session checks.
-keep,allowobfuscation,includedescriptorclasses class kotlinx.serialization.json.Json {
    public static kotlinx.serialization.json.Json$Default Default;
    public kotlinx.serialization.json.JsonElement parseToJsonElement(java.lang.String);
}
-keep,allowobfuscation class kotlinx.serialization.json.Json$Default
-keep,allowobfuscation,includedescriptorclasses class kotlinx.serialization.json.JsonObject {
    public boolean isEmpty();
    public java.util.Set keySet();
    public java.lang.String toString();
}
-keep,allowobfuscation,includedescriptorclasses class kotlinx.serialization.json.JsonArray {
    public boolean contains(java.lang.Object);
}
-keep,allowobfuscation,includedescriptorclasses class kotlinx.serialization.json.JsonObjectBuilder {
    public <init>();
    public kotlinx.serialization.json.JsonObject build();
}
-keep,allowobfuscation,includedescriptorclasses class kotlinx.serialization.json.JsonElementKt {
    public static kotlinx.serialization.json.JsonObject getJsonObject(kotlinx.serialization.json.JsonElement);
    public static kotlinx.serialization.json.JsonArray getJsonArray(kotlinx.serialization.json.JsonElement);
    public static kotlinx.serialization.json.JsonPrimitive getJsonPrimitive(kotlinx.serialization.json.JsonElement);
    public static int getInt(kotlinx.serialization.json.JsonPrimitive);
    public static long getLong(kotlinx.serialization.json.JsonPrimitive);
    public static kotlinx.serialization.json.JsonPrimitive JsonPrimitive(java.lang.Number);
}
-keep,allowobfuscation,includedescriptorclasses class kotlinx.serialization.json.JsonElementBuildersKt {
    public static kotlinx.serialization.json.JsonElement put(kotlinx.serialization.json.JsonObjectBuilder,java.lang.String,java.lang.Boolean);
    public static kotlinx.serialization.json.JsonElement put(kotlinx.serialization.json.JsonObjectBuilder,java.lang.String,java.lang.Number);
}

# The external suspend lambda and callbacks must remain valid implementations.
-keep,allowobfuscation,includedescriptorclasses class kotlinx.coroutines.BuildersKt {
    public static java.lang.Object runBlocking$default(kotlin.coroutines.CoroutineContext,kotlin.jvm.functions.Function2,int,java.lang.Object);
}
-keep,allowobfuscation,includedescriptorclasses interface kotlin.coroutines.Continuation { *; }
-keep,allowobfuscation,includedescriptorclasses class kotlin.coroutines.jvm.internal.BaseContinuationImpl { *; }
-keep,allowobfuscation,includedescriptorclasses class kotlin.coroutines.jvm.internal.ContinuationImpl { *; }
-keep,allowobfuscation,includedescriptorclasses class kotlin.coroutines.jvm.internal.SuspendLambda { *; }
-keep,allowobfuscation,includedescriptorclasses interface kotlin.jvm.functions.Function0 { *; }
-keep,allowobfuscation,includedescriptorclasses interface kotlin.jvm.functions.Function1 { *; }
-keep,allowobfuscation,includedescriptorclasses interface kotlin.jvm.functions.Function2 { *; }

# Named Kotlin facade methods used by the compiled bootstrap. Keep both the
# facade and the declaring parent where a JVM static call resolves by inheritance.
-keep,allowobfuscation class kotlin.collections.ArraysKt
-keep,allowobfuscation,includedescriptorclasses class kotlin.collections.ArraysKt___ArraysKt {
    public static java.lang.String joinToString$default(byte[],java.lang.CharSequence,java.lang.CharSequence,java.lang.CharSequence,int,java.lang.CharSequence,kotlin.jvm.functions.Function1,int,java.lang.Object);
}
-keep,allowobfuscation class kotlin.collections.CollectionsKt
-keep,allowobfuscation,includedescriptorclasses class kotlin.collections.CollectionsKt__CollectionsJVMKt {
    public static java.util.List listOf(java.lang.Object);
}
-keep,allowobfuscation class kotlin.collections.MapsKt
-keep,allowobfuscation,includedescriptorclasses class kotlin.collections.MapsKt__MapsKt {
    public static java.lang.Object getValue(java.util.Map,java.lang.Object);
}
-keep,allowobfuscation class kotlin.collections.SetsKt
-keep,allowobfuscation,includedescriptorclasses class kotlin.collections.SetsKt__SetsKt {
    public static java.util.Set setOf(java.lang.Object[]);
}
-keep,allowobfuscation class kotlin.coroutines.intrinsics.IntrinsicsKt
-keep,allowobfuscation class kotlin.coroutines.intrinsics.IntrinsicsKt__IntrinsicsKt {
    public static java.lang.Object getCOROUTINE_SUSPENDED();
}
-keep,allowobfuscation class kotlin.coroutines.jvm.internal.Boxing {
    public static java.lang.Integer boxInt(int);
}
-keep,allowobfuscation class kotlin.ResultKt { public static void throwOnFailure(java.lang.Object); }
-keep,allowobfuscation class kotlin.Unit { public static kotlin.Unit INSTANCE; }
-keep,allowobfuscation class kotlin.io.CloseableKt {
    public static void closeFinally(java.io.Closeable,java.lang.Throwable);
}
-keep,allowobfuscation class kotlin.io.FilesKt
-keep,allowobfuscation class kotlin.io.FilesKt__FileReadWriteKt {
    public static void writeText$default(java.io.File,java.lang.String,java.nio.charset.Charset,int,java.lang.Object);
}
-keep,allowobfuscation class kotlin.jvm.internal.Intrinsics {
    public static boolean areEqual(java.lang.Object,java.lang.Object);
    public static void checkNotNull(java.lang.Object);
    public static void checkNotNullExpressionValue(java.lang.Object,java.lang.String);
    public static void checkNotNullParameter(java.lang.Object,java.lang.String);
}
-keep,allowobfuscation class kotlin.text.Charsets { public static java.nio.charset.Charset UTF_8; }
-keep,allowobfuscation class kotlin.text.Regex {
    public <init>(java.lang.String);
    public boolean matches(java.lang.CharSequence);
}
-keep,allowobfuscation class kotlin.text.StringsKt
-keep,allowobfuscation class kotlin.text.StringsKt__StringsKt {
    public static boolean contains$default(java.lang.CharSequence,char,boolean,int,java.lang.Object);
    public static java.lang.CharSequence trim(java.lang.CharSequence);
}
