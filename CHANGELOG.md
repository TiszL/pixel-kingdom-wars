# Changelog

Release history for Pixel Kingdom Wars. Generated from commit history by
`pnpm release` — do not hand-edit released sections; fix the commit message
convention instead and regenerate.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/), with the pre-1.0
rule that a breaking change bumps the **minor** while the major is `0`.

## Battle replay compatibility

`SIM_VERSION` is the live battle/event protocol version. It is tracked
separately because simulator compatibility does not follow the package release
number. The server resolves each raid and stores its authoritative result and
event log. A release that changes `SIM_VERSION`:

- requires older clients to update before creating a raid (the API responds
  with `426` and the client presents an update prompt); and
- preserves completed replays by rendering their archived event logs instead
  of recalculating them under newer balance or pathfinding rules.

Those releases are marked with a `Replay protocol → sim vN` banner at the top of
their section. See `packages/sim/src/version.ts`.

<!-- releases -->

## [0.3.3] — 2026-09-03

### Android shell

- dApp Store APK `pixel-kingdom-wars-v0.3.3-dappstore.apk`, versionCode 12 (`gg.pixelkingdomwars.twa`, same signing key).


## [0.1.0] — devnet alpha baseline

`0.1.0` is the package version used by the deployed devnet alpha; there is no
`v0.1.0` Git tag. Earlier development remains available in `git log`. Future
formal releases are generated above this baseline and must be backed by a tag.
