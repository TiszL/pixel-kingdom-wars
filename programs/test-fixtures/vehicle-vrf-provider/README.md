# Synthetic local vehicle provider

This crate is only an owned-loopback validator fixture for D153.207. It deliberately
uses the selected provider's address so the real craft program executes its fixed
CPI and callback checks. The fixture controller chooses every output. This proves
consumer account/signature/escrow behavior, **not** oracle entropy, liveness,
technical failure, K140, production provider behavior, or replacement authority.
It is not in Anchor's deployment workspace, has no deployment keypair, and must
never be deployed to a public cluster.

Build with the existing pinned toolchain:

```sh
cargo build-sbf --manifest-path test-fixtures/vehicle-vrf-provider/Cargo.toml -- --locked
```

The owning validator harness preloads the fixed provider-owned queue with 4096
bytes: `SYNVRF01`, controller public key(32), failure mode(u8), fixed oracle charge
(u64 little endian), request count(u32 little endian), then zero padding. Saved
requests are length-prefixed exact selected SDK request bytes. No entries are
removed. Raw request discriminator10 requires the craft identity signer and exact
five selected accounts; the fixture charges only the original oracle escrow.

The controller-only commands are:

- `200 | failure mode(u8) | charge(u64)`, with controller signer and writable queue.
  Mode0 accepts, mode1 refuses with synthetic error9000, mode2 spends charge+1 to
  test that the consumer's original oracle budget cannot be exceeded.
- `201 | request index(u32) | randomness(32) | mode(u8)`, with controller signer,
  queue, executable craft, provider identity, saved root, saved writable attempt.
  Mode0 delivers the saved exact callback;1 uses the wrong global identity;2
  corrupts the original root argument;3 omits the identity signature. Deliberate
  repeat delivery tests that the consumer rejects a second outcome.
- `202 | raw craft request instruction`, with the original14 request accounts and
  executable craft as the15th. This probe grants no extra capability and only
  forwards existing signer/writable privileges. It tests rejection of admission
  through an unapproved CPI wrapper.

Amounts in this fixture header are synthetic test inputs, never live game numbers.
The production consumer compares its full request against independent SDK-derived
vectors under `spikes/phase-e-toolchain-vrf/vectors/`.
