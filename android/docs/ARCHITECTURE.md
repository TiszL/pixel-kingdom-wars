# Native client architecture

The native client is a separate implementation: React and Phaser code do not automatically become Kotlin. Server rules, artwork, accounts, simulation and economy remain shared.

| Module | Responsibility | Current scope |
|---|---|---|
| app | Compose navigation and Android lifecycle; owns libGDX fragment | Native preview and selected account/base screens |
| renderer | Original atlas sprites, scene texture ownership, camera/touch, canonical event playback | Base and archived replay foundation; incomplete combat effects/globe |
| network | HTTPS cookies, async HTTP, generated core DTO validation, exact decimal balances | Existing APIs plus presentation transport |
| wallet | Official Kotlin Mobile Wallet Adapter and optional pinned Privy SDK | MWA challenge signing; Privy compile foundation, configured identity and physical acceptance pending |
| content | Hash/size verification, atomic activation and scene leases | Verified HTTPS download, staged activation and last-known-good recovery integrated; full scene/device acceptance pending |
| tools | Immutable source export, pack import, compatibility and release verification | Local pipeline functional; remote CI/release gates pending |

## Authority and identity

Every game cost/stat/cap comes from canonical `packages/shared/src/constants.ts` and server responses. Do not maintain Kotlin economy tables. BigInt JSON values become decimal strings; clients must not round balances through floating point. The native app submits explicit player orders and renders server state.

MWA authorizes an existing wallet and signs the existing server challenge. Native uses HTTPS host-only cookies, including pending-login/TOTP cookies, encrypted with Android Keystore AES-GCM outside backup. Chrome cookies cannot migrate into this client. A native login must recover the same wallet and progression. Social users require the same Privy app and embedded wallet; no substitute wallet may be created to claim parity.

Seed Vault is accessed through a compatible wallet/MWA, not directly by the game. Wallet approval, cancellation and interrupted return require physical acceptance. SDK integration follows [Solana Mobile's Kotlin guidance](https://docs.solanamobile.com/android-native/using_mobile_wallet_adapter). Privy continuity is unproven; see [the native foundation and remaining gates](PRIVY_ANDROID.md).

## Rendering and battle presentation

Compose owns menus and accessible controls. libGDX owns the game surface; AndroidFragmentApplication manages pause/resume and GL lifecycle. Image decoding and battle preprocessing run off the render thread. Sprites use original anchors/scales, canonical wall masks and scene-specific atlas loading. Standing fallback sprites do not slide where authored movement is absent.

The source support branch adds participant-authorized `/native/capabilities` and `/raids/:id/presentation`. Its isolated bounded worker service calls the exact TypeScript simulator and caches/coalesces work by frozen input and accepted-command revision. Existing settlement worker admission is separate. The feature defaults OFF; nothing was deployed.

Transport protocol1 retains full-reset envelopes. Negotiated transport2 uses immutable bounded command/event pages, a parent revision and an event-comparison-derived replacement boundary. Native validates and assembles complete journals/deltas off GL, then atomically supplies the renderer with a full timeline. First-page monotonic receipt time is retained separately from server clock fields. A future live coordinator must use that anchor, never assembly-completion time, and must not persist a process-local monotonic value.

Authored attack phases, release timing, facing, projectiles/shadows, defense fire, collapse, traps, dragon breath and some persistent/special effects now use a render-only canonical-time scheduler. Original-art CPU fixture proofs are inspected; complete GL/device visual parity remains pending. Remaining hero effects, health/status, battle audio/haptics, advanced attachments, complete base ambience and wall editing remain incomplete. Connected walls and breach retiling already use canonical masks. No client damage, attack-target or reward calculation was introduced.

Renderer11 separates Gloamfang body ownership, Leap's parabolic counter and ordinary
position segments. Position endpoints are delivered on the canonical source helper's
schedule. A later segment temporarily overrides the counter; a completed segment
can yield back to the surviving arc. Lunge consumes the next delivered position.
Frozen revisions compile these states off GL and sample them without replaying
callbacks. The continuous-time model captures a new segment from the arc at delivery;
Phaser's actual next-manager-step delay is cadence-dependent and is not copied into
the protocol. Idle art facing uses surviving building bottom-centers; this does not
select gameplay attacks. Metadata admission validates shared facing and locomotion
dependencies before a downloaded generation becomes ready.

Renderer12 adds a bounded Burrow controller for admitted Tunneler/Bilgewraith
profiles. Ordinary position segments, the source moving flag and ticker body
registration have separate ownership. Entry keeps motion; coordinate emerge kills
the segment without clearing the moving flag. Identical registrations retain phase
and callbacks, including at the exact completion boundary. Soil samples position
and depth at its authored key and expires independently after body replacement or
death. Automatic idle retarget follows all same-time commands; explicit stand
calls retain their source ordering. Admission requires controller policies,
locomotion/melee/hit dependencies and finite derived body/effect durations.

`BattlePresentationStart.Continuous` reconstructs the immutable accepted journal.
`ColdPrefix(fromTick: Float)` materializes the stable prefix and suppresses its old
entry/surface/soil, then schedules the suffix through `PositionDelivery`; fractional
boundaries must not be floored. The live adapter preserves the initial cold boundary
for same-raid revisions, while archive replay uses Continuous. This does not retain
source warm tween state: native full-reset revisions discard removed predictions.
Exact source warm-append continuity needs separate lifecycle acceptance. No client
pathfinding, attack targeting, damage or outcome calculation is added.

Complete live deployment coordination, server clock integration into gameplay, legacy recovery, spectators/batches and inherited-deed journeys remain open. Transport tests are not a complete playable battle.

## Content and compatibility

`client-pack.lock.json` pins source SHA, SIM version and a SHA-256 content identity. The exporter produces canonical display constants, atlas metadata, original artwork/audio, render catalogues with tier/variant/motion data, curated foundation JSON schemas, generated Kotlin DTOs and 15 complete simulator fixtures. It does not claim to export every API schema yet.

The importer verifies every listed file before activation. Core files are bundled; fixtures enter the debug asset overlay only. It stages assets, generated models, fixtures and the lock together, uses an exclusive import lock and rolls back ordinary rename failures. Abrupt interruption leaves recovery material and makes `--check` fail; do not delete recovery files blindly.

The app integrates same-origin cookie-free HTTPS content downloads, manifest/file verification, ready-candidate leases, explicit activation outside replay, and restart fallback. Keep one content-store instance per root; verification runs on IO. Local backend origins have separate caches and encrypted session/receipt/MWA namespaces. Never switch active battle assets mid-session; the future live coordinator must join the activation guard. See UPDATE_COMPATIBILITY.md for the installed-client release policy and explicit SIM/renderer limits.

| Change | Intended update path |
|---|---|
| Compatible balance/server behavior | Server and regenerated canonical catalogue |
| Compatible art/content | Owner-published compatible verified content, staged download and safe activation |
| Additive API fields | Generated contracts plus response/compatibility checks |
| New UI, renderer behavior, wallet SDK | New compiled APK |
| Unsupported event/SIM protocol | Gate affected gameplay until supported APK |

Native CI can build pinned source and create a review patch for a new source SHA. It does not translate new web features or automatically approve release readiness.
