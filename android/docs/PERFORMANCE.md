# Owner-operated live Seeker performance collection

`tools/measure-live-seeker.mjs` reads an already running optimized APK. It does
not install, launch, navigate, unlock, connect wallets, collect logcat, clear
counters or enable tracing. APK minification, non-debuggable status and the wallet
module's framework-log removal remain unchanged. The old `measure-seeker.mjs`
is still an offline debug-fixture collector; its output is not live acceptance.

## Preconditions and owner command

The owner installs the exact reviewed standalone APK and starts full gameplay.
Complete sensitive authentication before collecting. The selected device must
already be authorized for ADB. No app process may restart or update during a run.
The owner must separately have enabled SurfaceFlinger TimeStats collection;
Android documents `dumpsys SurfaceFlinger --timestats -enable`. This collector
never enables, disables or clears those global counters. A baseline excludes old
frames, so clearing counters is unnecessary. Concurrent collection/reset tools
must remain stopped. If this device does not expose the required statistics,
stop and record the missing capability; do not enable debugging to bypass it.

The owner can inspect `adb -s "$ANDROID_SERIAL" shell dumpsys SurfaceFlinger
--timestats -dump` locally to identify the exact game layer. Do not publish this
raw system dump. Select the game's `SurfaceView[...]` layer for GL base/battles,
and the corresponding app layer for Compose-only screens. The chosen layer must
already have rendered frames and occur exactly once in the dump. Multiple
refresh-rate records for the same layer are ambiguous and intentionally refused.
No automatic layer discovery, switching or merging is performed.

```sh
node tools/measure-live-seeker.mjs \
  --serial "$ANDROID_SERIAL" \
  --package gg.pixelkingdomwars.twa.debug \
  --layer 'SurfaceView[gg.pixelkingdomwars.twa.debug/gg.pixelkingdomwars.nativeclient.MainActivity]@0(BLAST)#REPLACE' \
  --apk '/absolute/path/to/reviewed-optimized.apk' \
  --out '.reports/device/live-battle-unique' \
  --scenario battle --minutes 30 --interval-seconds 30
```

Replace the complete layer string with the exact observed name; the example is
not a usable default. Release package selection is `gg.pixelkingdomwars.twa`.
`--serial`, `--package`, `--layer`, `--apk`, `--out` and `--scenario` are mandatory.
Scenarios are `dense-base`, `battle`, `globe` or `mixed`. The output directory must
be new and its parent must already exist. A 1–29 minute diagnostic is allowed,
but does not satisfy the 30-minute gate. Interval must be10–60 seconds and divide
the duration. `ADB` can identify an existing platform-tools binary; otherwise the
existing local Bubblewrap SDK path is used. No installation/download runs.

Keep the selected surface visible and exercise representative gameplay manually.
Record loading, background/resume and other layers as separate scenarios; a
static UI, wallet screen, layer replacement or app restart cannot be silently
counted as active game frames. Disappearance, ambiguous layers, non-advancing
counters, resets, timing gaps, dropped frames or incomplete frame coverage stop
the run with incomplete evidence. Start a new owner-controlled run afterward;
there is no retry or automatic game action. Ctrl-C preserves incomplete output.

## Meaning of the report

`measurement.json` records exact installed/local APK SHA-256 agreement, package,
version code, non-debuggable status, a hash of the chosen layer, numeric timing
buckets and health samples. Split APKs are refused because one local artifact
cannot prove their complete identity. No serial, raw layer name, APK/device path,
wallet, player, session, raw process dump or callback text is written. Report
files use0600 permissions in a new0700 directory. Raw command data is transient;
errors contain fixed local codes. The APK hash identifies the exact artifact;
its existing build receipt supplies source/content/signature provenance.

Each window subtracts the preceding cumulative counters. Counters must remain in
one uninterrupted generation; process identity is rechecked after final health
and final package verification as well as before every window. The local APK is
hashed through one opened handle with an actual byte limit and unchanged
identity/size/timestamps; the installed package hash must match before and after.
PSS memory, measured thermal status/HAL readiness and battery temperature/level
are sampled approximately each minute. A synthetic thermal override or absent
health data refuses completion. Numeric PSS is a snapshot, not a peak-allocation
profile; battery temperature is not CPU/GPU junction temperature. No thermal
policy or clock setting is changed.

SurfaceFlinger measures **present-to-present intervals**, including the GL game
surface. This differs from the existing renderer callback sampler and does not
measure GPU execution time or touch latency. Android's histogram converts to
integer milliseconds and uses discrete buckets. We conservatively include the
lost fractional millisecond: a20ms bucket means [20,21)ms, so it cannot prove
p95≤20ms; a33ms bucket cannot prove p99≤33ms. The1000ms overflow bucket has no
finite upper bound. A percentile is `within-bound`, `exceeds-bound` or
`inconclusive`; raw bucket labels are never presented as exact percentiles.

`status: complete` and exit0 mean collection completed, including when timing
exceeds a bound. `acceptance` is always `not-certified`. Review per-window timing
and FPS as well as totals; a good aggregate can hide sustained degradation.
Do not average per-window percentiles. Retain source/artifact receipts and an
owner scenario record, then evaluate PARITY's30-minute dense-base/full-army/globe
requirements, memory/thermal trend, loading/input latency and comparable TWA
conditions. This tool never marks a release gate passed.

The command limits each read to5 seconds and8MiB, the APK hash input to512MiB,
collection to30 minutes plus bounded metadata reads, at most180 timing windows,
and the sole output to1MiB. No retries, heap dumps or long Perfetto capture are
used. Missing/ambiguous device counters remain a real acceptance limitation.
If histogram bounds are inconclusive, precise presentation timestamps need a
separately reviewed collector; do not weaken the threshold or wallet log rules.

## Source and verification

The [official Android game measurement procedure](https://developer.android.com/games/optimize/vitals/slow-session)
uses SurfaceFlinger timing for OpenGL/Vulkan and Android UI layers. The parser
supports the AOSP `presentToPresent`/`present2present` text names and85-bucket
[TimeStats schema](https://android.googlesource.com/platform/frameworks/native/+/9cf89269c1/services/surfaceflinger/TimeStats/timestatsproto/TimeStatsHelper.cpp).
[Android meminfo](https://developer.android.com/tools/dumpsys) describes package
PSS snapshots. Generic gfxinfo is not complete GL evidence, and
[Perfetto FrameTimeline](https://perfetto.dev/docs/data-sources/frametimeline)
currently documents SurfaceView coverage limitations. No profileable manifest
change is needed for these system counters.

Run `node --test tools/live-seeker-stats.test.mjs` for deterministic synthetic
AOSP-shaped command-output tests. These test false-pass refusal, identity,
counter coverage, race/reset/gap behavior and privacy; they invoke no ADB or
device operation. Physical Seeker compatibility and performance remain untested.
