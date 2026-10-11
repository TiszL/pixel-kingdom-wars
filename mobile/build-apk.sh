#!/bin/bash
#
# Internal signed-build step for `pnpm apk:release <version> <versionCode>`.
# Direct invocation is deliberately unsupported: the release wrapper supplies
# the locked identity, reviewed Android tool paths and scoped signing secret.
#
# What this produces is a THIN SHELL. It contains no game code — it opens
# https://<domain> full-screen and proves, via Digital Asset Links, that it is
# allowed to do so without browser chrome. That is the whole design: the game
# updates when we deploy web assets, and this APK only needs rebuilding when the
# shell itself changes (icon, name, orientation, target domain).
#
# Fails loudly and early rather than producing something subtly wrong, because
# every one of these mistakes may only surface after submission or device review.
set -euo pipefail

# --- credential boundary --------------------------------------------------
#
# This block MUST remain before HERE/dirname and every other external command.
# `pnpm apk:release` starts this process with the store password in the named
# PKW_* variable. Capture its value
# with Bash builtins, then immediately remove every credential from the exported
# environment. The captured RELEASE_* variables are deliberately shell-local;
# only the exact keytool and apksigner children receive it
# again below. This prevents unrelated Java, node, curl, dig and build-preflight
# children from inheriting the signing identity.
unset RELEASE_PASSWORD_ENV_NAME RELEASE_STORE_PASSWORD \
  RELEASE_APKSIGNER_PASSWORD
RELEASE_PASSWORD_ENV_NAME="${PKW_KEYSTORE_PASSWORD_ENV-}"
RELEASE_INTERNAL_CALL="${PKW_APK_RELEASE_INTERNAL-}"
RELEASE_STORE_PASSWORD=""
RELEASE_APKSIGNER_PASSWORD=""
RELEASE_CREDENTIAL_ERROR=""

if [[ -n "$RELEASE_PASSWORD_ENV_NAME" ]]; then
  if [[ ! "$RELEASE_PASSWORD_ENV_NAME" =~ ^PKW_[A-Z0-9_]+$ ]]; then
    RELEASE_CREDENTIAL_ERROR="PKW_KEYSTORE_PASSWORD_ENV must name a dedicated PKW_* environment variable"
  else
    RELEASE_STORE_PASSWORD="${!RELEASE_PASSWORD_ENV_NAME-}"
    if [[ -z "$RELEASE_STORE_PASSWORD" ]]; then
      RELEASE_CREDENTIAL_ERROR="the environment variable named by PKW_KEYSTORE_PASSWORD_ENV is empty or unset"
    else
      RELEASE_APKSIGNER_PASSWORD="$RELEASE_STORE_PASSWORD"
    fi
    unset "$RELEASE_PASSWORD_ENV_NAME"
  fi
fi
unset PKW_APK_RELEASE_INTERNAL PKW_KEYSTORE_PASSWORD_ENV PKW_STORE_KEYSTORE_PASSWORD \
  BUBBLEWRAP_KEYSTORE_PASSWORD BUBBLEWRAP_KEY_PASSWORD

if [[ -n "$RELEASE_CREDENTIAL_ERROR" ]]; then
  printf '\n\033[31m  build-apk: %s\033[0m\n\n' "$RELEASE_CREDENTIAL_ERROR" >&2
  exit 1
fi
unset RELEASE_CREDENTIAL_ERROR

if [[ "$RELEASE_INTERNAL_CALL" != "1" ]]; then
  printf '\n\033[31m  build-apk: internal only; run pnpm apk:release <version> <versionCode>\033[0m\n\n' >&2
  exit 1
fi
unset RELEASE_INTERNAL_CALL

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$HERE/twa.config.json"
KEYSTORE_DIR="$HERE/keystore"
OUT="$HERE/build"
BUBBLEWRAP_BIN="$HERE/../scripts/node_modules/.bin/bubblewrap"
BUBBLEWRAP_VERSION="1.25.0"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m  build-apk: %s\033[0m\n\n' "$*" >&2; exit 1; }
die_status() {
  local status="$1"
  shift
  printf '\n\033[31m  build-apk: %s\033[0m\n\n' "$*" >&2
  exit "$status"
}

# --- preflight -------------------------------------------------------------

command -v node >/dev/null || die "node is required."
[ -x "$BUBBLEWRAP_BIN" ] || die "repo-pinned Bubblewrap is missing; run pnpm install."
node -e '
  const { dirname } = require("path");
  const cli = require.resolve("@bubblewrap/cli/package.json", { paths: [process.argv[1]] });
  for (const name of ["@bubblewrap/cli", "@bubblewrap/core", "@bubblewrap/validator"]) {
    const version = require(require.resolve(`${name}/package.json`, { paths: [dirname(cli)] })).version;
    if (version !== process.argv[2]) throw new Error(`${name} is ${version}, expected ${process.argv[2]}`);
  }
' "$HERE/../scripts" "$BUBBLEWRAP_VERSION" || die "Bubblewrap dependency graph is not the reviewed 1.25.0 set."
[ -n "${PKW_APKSIGNER:-}" ] && [ -x "$PKW_APKSIGNER" ] || die "PKW_APKSIGNER must name the reviewed Android SDK apksigner."

# FIND A REAL JDK BEFORE ANYTHING ELSE.
#
# On macOS /usr/bin/java AND /usr/bin/keytool both exist as stubs that only fail
# when executed, so `command -v` passes and the build dies later at the keystore
# step with "Unable to locate a Java Runtime" — which is what happened on
# 2026-07-30. A previous version of this script warned that Bubblewrap would
# download its own JDK, which is true but useless here: keytool runs BEFORE
# Bubblewrap and is itself a JDK tool.
#
# Homebrew's openjdk FORMULA installs under the Homebrew prefix with no sudo,
# unlike the temurin CASK, which needs a password and cannot be scripted.
for candidate in "${JAVA_HOME:-}/bin" /opt/homebrew/opt/openjdk/bin /usr/local/opt/openjdk/bin; do
  if [ -x "$candidate/keytool" ] && "$candidate/java" -version >/dev/null 2>&1; then
    export PATH="$candidate:$PATH"
    export JAVA_HOME="$(dirname "$candidate")"
    break
  fi
done
if ! java -version >/dev/null 2>&1 || ! keytool -help >/dev/null 2>&1; then
  die "no working Java runtime.

  /usr/bin/java exists on macOS even with no JDK — it is a stub. Install one:
      brew install openjdk          # no sudo needed
  then re-run this script."
fi
echo "  jdk: $(java -version 2>&1 | head -1)"

# `command -v java` is NOT enough on macOS: /usr/bin/java exists as a stub even
# with no JDK installed, and only fails when you actually run it. Run it.
#
# A WARNING, not a failure: Bubblewrap offers to download its own JDK and Android
# SDK into ~/.bubblewrap on first run, which needs no sudo. `brew install --cask
# temurin` DOES need sudo and cannot be scripted non-interactively, so refusing
# to start here would block the build on a step that is optional.
if ! java -version >/dev/null 2>&1; then
  printf '\n\033[33m  no system Java runtime.\033[0m\n'
  printf '  Bubblewrap will offer to download its own JDK — accept that prompt.\n'
  printf '  (Or install one first: brew install --cask temurin)\n\n'
fi
# The release wrapper supplies and later independently verifies the locked
# production domain; this internal step never defines a public direct-build API.
DOMAIN="${DOMAIN:-$(node -p "require('$CONFIG').domain")}"
APP_ID="$(node -p "require('$CONFIG').applicationId")"
if [ "$DOMAIN" = "REPLACE_ME.example.com" ]; then
  die "set \"domain\" in mobile/twa.config.json first.

  It is compiled into the APK and verified against
  https://<domain>/.well-known/assetlinks.json at install time. Publishing with
  the wrong one means the app opens with a browser address bar visible, and
  fixing it needs a new store release."
fi

# The manifest must be REACHABLE — Bubblewrap reads it over the network to build
# the shell. Catching this now saves a confusing failure three minutes in.
MANIFEST_URL="https://$DOMAIN/manifest.webmanifest"
say "checking $MANIFEST_URL"
if curl -fsSL --max-time 15 "$MANIFEST_URL" >/dev/null 2>&1; then
  echo "  reachable"
else
  # DISTINGUISH TWO FAILURES that look identical from here:
  #   (a) the site is not deployed        -> fatal, the app would open a dead page
  #   (b) the site is up but THIS machine cannot resolve the name -> not fatal
  # (b) is real and common: a home ISP resolver may negative-cache a
  # freshly-created tunnel hostname that 1.1.1.1 resolves instantly (2026-07-30).
  # The PHONE resolves independently, and nothing in this build needs the public
  # host to be reachable from here — icons come from ICON_ORIGIN.
  PUB_IP="$(dig +short +time=3 @1.1.1.1 "$DOMAIN" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
  if [ -n "$PUB_IP" ] && curl -fsSL --max-time 20 --resolve "$DOMAIN:443:$PUB_IP" "$MANIFEST_URL" >/dev/null 2>&1; then
    printf '\n\033[33m  the site IS live, but this machine cannot resolve %s.\033[0m\n' "$DOMAIN"
    printf '  Verified via 1.1.1.1 (%s). Your phone resolves independently, so this\n' "$PUB_IP"
    printf '  does not affect the APK. Continuing.\n'
    printf '  To fix local DNS: System Settings > Wi-Fi > Details > DNS > add 1.1.1.1\n\n'
  else
    die "cannot fetch $MANIFEST_URL from here OR via 1.1.1.1.

  The site is not reachable, so the APK would open a dead page. Serve it first:
      ./infra/serve-single-origin.sh $DOMAIN
  and expose it (cloudflared tunnel / tailscale funnel)."
  fi
fi

# --- signing key -----------------------------------------------------------
#
# THE most consequential artefact in this directory. Android identifies an app by
# (applicationId, signing key). Lose this file or its password and you can never
# ship an update to this listing again — not a hard recovery, an impossible one.
# The only fix is a new listing and asking every player to reinstall.

mkdir -p "$KEYSTORE_DIR"
# PKW_KEYSTORE_OVERRIDE / PKW_KEYSTORE_ALIAS: the dApp Store lane signs with
# its OWN key (mobile/dappstore/, 2026-08-16) — same script, different key.
KEYSTORE="${PKW_KEYSTORE_OVERRIDE:-$KEYSTORE_DIR/pkw-release.keystore}"
KS_ALIAS="${PKW_KEYSTORE_ALIAS:-pkw}"

if [ -n "${PKW_KEYSTORE_OVERRIDE:-}" ] || [ -n "${PKW_KEYSTORE_ALIAS:-}" ]; then
  say "alternate signing identity selected"
  echo "  A future update to the existing store listing must use"
  echo "  that listing's exact original keystore AND alias. Never use"
  echo "  --new-keystore for an update to the existing store listing."
fi

# --new-keystore: archive the current key and generate a fresh one.
# NEVER use this option for an update to the existing store listing: Android
# only accepts an update signed by that listing's exact original identity
# (keystore + alias). It is solely for an unpublished/abandoned identity.
#
# The sanctioned release wrapper never exposes the password in argv: Bubblewrap
# emits an unsigned APK and direct apksigner reads the secret from its environment.
#
# The old key is MOVED, never deleted — if an APK signed with it is already
# installed anywhere, that file is the only way to update it.
if [ "${1:-}" = "--new-keystore" ] && [ -f "$KEYSTORE" ]; then
  ARCHIVED="$KEYSTORE.retired-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$KEYSTORE" "$ARCHIVED"
  say "archived the previous key"
  echo "  $ARCHIVED"
  echo "  A device with an APK signed by that key can only be updated by it —"
  echo "  uninstall the old app before installing the new one."
  shift
fi

if [ ! -f "$KEYSTORE" ]; then
  say "no release keystore yet — creating one"
  cat <<'EOF'
  You are about to generate the key that permanently identifies this app.

    * BACK IT UP somewhere that is not this machine, today.
    * Store the password in a password manager, not in your shell history.
    * It is gitignored and must stay that way.

  Losing it means this listing can never be updated again.

EOF
  read -r -p "  Continue? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || die "aborted."

  keytool -genkeypair \
    -alias "$KS_ALIAS" \
    -keystore "$KEYSTORE" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Pixel Kingdom Wars, OU=Games, O=Pixel Kingdom Wars, C=US"
fi

# --- digital asset links ---------------------------------------------------
#
# The fingerprint of the signing key, published on the domain, is what lets the
# TWA drop the browser UI. Printed every run: it is needed whenever the web host
# changes, and hunting for the keytool incantation later is pure friction.

say "SHA-256 fingerprint of the signing key"
# NO `2>/dev/null` HERE. keytool asks for the keystore password on STDERR, so
# redirecting it swallowed the prompt — keytool then got no password, failed, and
# `set -e` killed the script immediately after printing this heading, with no
# error shown. Silencing a tool's stderr also silences the questions it needs to
# ask you.
#
# PKW_KEYSTORE_PASSWORD_ENV (D-101, `pnpm apk:release`): the NAME of a variable
# holding the password. keytool reads it itself via `-storepass:env`, so the
# value never enters argv, this script's output, or shell history.
if [ -n "$RELEASE_PASSWORD_ENV_NAME" ]; then
  # Export the dynamic password variable only inside this command-substitution
  # process, then replace that process with keytool. No sibling child inherits
  # it and the value never enters argv.
  KT_OUT="$(
    export "$RELEASE_PASSWORD_ENV_NAME=$RELEASE_STORE_PASSWORD"
    exec keytool -list -v -keystore "$KEYSTORE" -alias "$KS_ALIAS" -storepass:env "$RELEASE_PASSWORD_ENV_NAME"
  )" \
    || die "could not read the keystore with \$$RELEASE_PASSWORD_ENV_NAME (wrong password?). The file itself is fine:
  $KEYSTORE"
else
  echo "  keytool will ask for the keystore password again:"
  KT_OUT="$(keytool -list -v -keystore "$KEYSTORE" -alias "$KS_ALIAS")" \
    || die "could not read the keystore (wrong password?). The file itself is fine:
  $KEYSTORE"
fi
FINGERPRINT="$(printf '%s' "$KT_OUT" | grep 'SHA256:' | head -1 | sed 's/.*SHA256: //')"
[ -n "$FINGERPRINT" ] || die "keytool succeeded but no SHA-256 line was found — cannot write
  assetlinks.json without it, and a wrong/absent fingerprint means the app opens
  with an address bar."
echo "  $FINGERPRINT"

ASSETLINKS="$HERE/../apps/web/public/.well-known/assetlinks.json"
mkdir -p "$(dirname "$ASSETLINKS")"
# MERGE, never overwrite. Two keys are legitimately in play — the sideload key
# and the dApp Store key — and a build that rewrote this file with only the key
# it just used would silently un-verify every device carrying the other APK
# (they would start opening the game with a browser address bar). Existing
# fingerprints are preserved; PKW_DISTRUST_FINGERPRINT drops a specific one,
# which is how a compromised key is retired (2026-08-16 rotation).
FINGERPRINT="$FINGERPRINT" APP_ID="$APP_ID" ASSETLINKS="$ASSETLINKS" \
DISTRUST="${PKW_DISTRUST_FINGERPRINT:-}" node -e '
  const fs = require("fs");
  const file = process.env.ASSETLINKS;
  const fresh = process.env.FINGERPRINT;
  const distrust = (process.env.DISTRUST || "").toUpperCase();
  let kept = [];
  try {
    const prior = JSON.parse(fs.readFileSync(file, "utf8"));
    kept = prior?.[0]?.target?.sha256_cert_fingerprints ?? [];
  } catch { /* first run, or unreadable — start clean */ }
  const list = [...new Set([...kept, fresh])]
    .filter((f) => f && f.toUpperCase() !== distrust);
  fs.writeFileSync(file, JSON.stringify([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: process.env.APP_ID,
      sha256_cert_fingerprints: list,
    },
  }], null, 2) + "\n");
  console.log(`  assetlinks trusts ${list.length} key(s)`);
'
say "updated apps/web/public/.well-known/assetlinks.json"
echo "  Deploy the web app again so it is live at"
echo "  https://$DOMAIN/.well-known/assetlinks.json BEFORE installing the APK,"
echo "  or the shell will open with an address bar."

# --- build -----------------------------------------------------------------

mkdir -p "$OUT"
cd "$OUT"

# GENERATE the TWA manifest instead of running `bubblewrap init`.
#
# `init` is interactive and does NOT read twa.config.json — it prompts for the
# application id, the keystore path and the locale list, and a typo in the
# application id permanently forks the app's Android identity (a different id is
# a different app: new listing, every player reinstalls). Generating the file
# from a checked-in config makes that unmissable rather than a typing test, and
# makes the build reproducible.
#
# It also removes a NETWORK dependency. `init` fetches the live web manifest, so
# it cannot run unless this machine can resolve the public host — which is not a
# given on a home ISP with a freshly-created tunnel hostname (hit exactly that on
# 2026-07-30: 1.1.1.1 resolved it instantly, the ISP resolver would not).
# `bubblewrap build` needs no such fetch: webManifestUrl is optional, and the
# only URL it reads is iconUrl, which is used ONCE at build time to generate
# Android resources and need not be on the same host the app opens. So icons come
# from ICON_ORIGIN (localhost by default) while `host` is the public name.
ICON_ORIGIN="${ICON_ORIGIN:-http://localhost:8080}"
# ALWAYS regenerate. This used to run only on --init or a missing file, which
# meant an edit to twa.config.json was silently ignored on a rebuild: the
# orientation unlock sat in the config while the generated manifest still said
# "portrait", so the next APK would have been portrait-locked again and the fix
# would have looked broken on the phone. The manifest is a pure function of
# twa.config.json + ICON_ORIGIN, so regenerating is always correct.
#
# appVersionCode must STRICTLY INCREASE or Android refuses the upgrade — and the
# TRACKED config is the single truth on every machine and checkout (D-101). This
# used to build "previous local code plus one, or the config floor" from the gitignored
# previous manifest, so a fresh clone built code 11 again while this Mac silently built
# 12 for the same commit. Now the config's code is used EXACTLY, and the build
# dies if it does not beat the previous local build: bump twa.config.json
# (`pnpm apk:release <version> <code>`) instead of letting the machine decide.
PREV_CODE=0
if [ -f "$OUT/twa-manifest.json" ]; then
  PREV_CODE="$(node -p "require('$OUT/twa-manifest.json').appVersionCode || 0" 2>/dev/null || echo 0)"
fi
NEXT_CODE="$(node -p "require('$CONFIG').appVersionCode")"
case "$NEXT_CODE" in
  ''|*[!0-9]*|0*) die "twa.config.json appVersionCode must be a positive integer, got '$NEXT_CODE'." ;;
esac
if [ "$PREV_CODE" -gt 0 ] && [ "$NEXT_CODE" -le "$PREV_CODE" ]; then
  die "twa.config.json appVersionCode ($NEXT_CODE) is not greater than the previous local build ($PREV_CODE).

  The tracked config is the only truth for the version code. Bump it with
      pnpm apk:release <version> <versionCode>
  rather than rebuilding — a silently auto-incremented code is how two machines
  produced different APKs for the same commit."
fi
if true; then
  say "generating twa-manifest.json"
  node -e '
    const fs = require("fs");
    const c = require(process.argv[1]);
    const iconOrigin = process.argv[2];
    const out = process.argv[3];
    const keystore = process.argv[4];
    const signingAlias = process.argv[5];
    const m = {
      packageId: c.applicationId,
      host: c.domain,
      name: c.name,
      launcherName: c.launcherName,
      display: c.display || "standalone",
      orientation: c.orientation || "portrait",
      themeColor: c.themeColor,
      themeColorDark: c.themeColor,
      navigationColor: c.navigationColor || c.themeColor,
      navigationColorDark: c.navigationColor || c.themeColor,
      navigationDividerColor: c.navigationColor || c.themeColor,
      navigationDividerColorDark: c.navigationColor || c.themeColor,
      backgroundColor: c.backgroundColor,
      enableNotifications: c.enableNotifications === true,
      startUrl: c.startUrl || "/",
      iconUrl: iconOrigin + c.iconUrl,
      // Only emit this when the owner pack explicitly supplies a safe-area
      // contract. `brand rework 2` does, so the checked-in config names it.
      ...(c.maskableIconUrl ? { maskableIconUrl: iconOrigin + c.maskableIconUrl } : {}),
      splashScreenFadeOutDuration: 300,
      // ABSOLUTE. twa.config.json stores it relative to mobile/, but bubblewrap
      // runs apksigner with mobile/build as the working directory, so a relative
      // path resolves to mobile/build/keystore/... and signing dies with
      // FileNotFoundException after the entire Android build has succeeded — the
      // most expensive place to fail.
      signingKey: { path: keystore, alias: signingAlias },
      appVersion: c.appVersionName,
      // EXACTLY the tracked config (D-101). The strictly-greater guard ran above.
      appVersionCode: c.appVersionCode,
      shortcuts: [],
      generatorApp: "shardkeep-build-apk",
      fallbackType: "customtabs",
      features: {},
      enableSiteSettingsShortcut: true,
      isChromeOSOnly: false,
      isMetaQuest: false,
      minSdkVersion: 23,
      fingerprints: [],
      additionalTrustedOrigins: [],
      retainedBundles: [],
      alphaDependencies: { enabled: false },
    };
    fs.writeFileSync(out, JSON.stringify(m, null, 2) + "\n");
  ' "$CONFIG" "$ICON_ORIGIN" "$OUT/twa-manifest.json" "$KEYSTORE" "$KS_ALIAS" "$PREV_CODE"
  echo "  packageId  : $APP_ID"
  echo "  host       : $DOMAIN"
  echo "  orientation: $(node -p "require('$CONFIG').orientation")"
  echo "  versionCode: $(node -p "require('$OUT/twa-manifest.json').appVersionCode")  (was $PREV_CODE)"
  echo "  icons from : $ICON_ORIGIN  (build-time only — not the runtime host)"
fi

# Generate or regenerate the Android project from the manifest. `update` accepts
# a standalone twa-manifest.json and creates the project in a clean checkout as
# well as replacing an existing one. Keeping this unconditional is important:
# `bubblewrap build` only compiles whatever project is already present, while
# mobile/build is intentionally gitignored.
say "bubblewrap update (generating Android project from twa-manifest.json)"
(cd "$OUT" && "$BUBBLEWRAP_BIN" update --skipVersionUpgrade) || \
  die "bubblewrap update failed — the APK would not carry your manifest changes."

# Bubblewrap has no locale-resource field in twa-manifest.json. Apply the
# checked-in language after EVERY generated-project update so dependency
# translations cannot make the APK claim dozens of unsupported locales. The
# marker replacement is idempotent and fails loud if Bubblewrap's template
# stops containing the expected defaultConfig block.
ANDROID_LANGUAGE="$(node -p "String(require('$CONFIG').language || 'en-US').split('-')[0].toLowerCase()")"
case "$ANDROID_LANGUAGE" in
  [a-z][a-z]|[a-z][a-z][a-z]) ;;
  *) die "invalid Android resource language derived from twa.config.json: $ANDROID_LANGUAGE" ;;
esac
APP_GRADLE="$OUT/app/build.gradle"
[ -f "$APP_GRADLE" ] || die "Bubblewrap project is missing $APP_GRADLE"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const language = process.argv[2];
  const begin = "        // PKW_LOCALE_FILTER_BEGIN\n";
  const end = "        // PKW_LOCALE_FILTER_END\n";
  let source = fs.readFileSync(file, "utf8");
  source = source.replace(/        \/\/ PKW_LOCALE_FILTER_BEGIN\n[\s\S]*?        \/\/ PKW_LOCALE_FILTER_END\n/g, "");
  const needle = "    defaultConfig {\n";
  if (!source.includes(needle)) throw new Error("Bubblewrap defaultConfig block not found");
  const block = begin + `        resourceConfigurations += ["${language}"]\n` + end;
  source = source.replace(needle, needle + block);
  fs.writeFileSync(file, source);
' "$APP_GRADLE" "$ANDROID_LANGUAGE"
echo "  locales    : $ANDROID_LANGUAGE only"

say "bubblewrap unsigned build"
# Bubblewrap/npm never receive the store password. The reviewed local CLI emits
# an aligned unsigned APK; signing is a separate direct build-tools operation.
"$BUBBLEWRAP_BIN" build --directory "$OUT" --skipSigning || \
  die "bubblewrap unsigned build failed."
UNSIGNED_APK="$OUT/app-release-unsigned-aligned.apk"
[ -f "$UNSIGNED_APK" ] || die "Bubblewrap reported success but its aligned unsigned APK is missing: $UNSIGNED_APK"
APK="$OUT/app-release-signed.apk"
[ -n "$RELEASE_APKSIGNER_PASSWORD" ] || die "release signing password was not supplied through PKW_KEYSTORE_PASSWORD_ENV."
(
  export "$RELEASE_PASSWORD_ENV_NAME=$RELEASE_APKSIGNER_PASSWORD"
  exec "$PKW_APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias "$KS_ALIAS" \
    --ks-pass "env:$RELEASE_PASSWORD_ENV_NAME" --key-pass "env:$RELEASE_PASSWORD_ENV_NAME" \
    --out "$APK" "$UNSIGNED_APK" >/dev/null 2>&1
) || die "direct apksigner signing failed; no signing-tool output was printed."
[ -f "$APK" ] || die "Bubblewrap reported success but the signed release APK is missing:
  $APK"

say "done"
echo "  APK: $APK"
echo
echo "  Sideload onto your Seeker:"
echo "      adb install -r \"$APK\""
echo
echo "  Or copy it to the device and open it from Files (allow install from"
echo "  unknown sources for whichever app you open it from)."
