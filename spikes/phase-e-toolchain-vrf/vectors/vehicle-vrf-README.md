# D153.207 vehicle provider ABI compatibility vector

Generated locally by the installed, locked **ephemeral-vrf-sdk 0.17.2**, `anchor-compat`, using `instructions::create_request_randomness_ix`. The standalone S2 spike remains outside `programs/`; no production dependency, manifest, lockfile or toolchain change is required.

`vehicle-vrf-v1.json` is the common Rust/TypeScript vector. SHA-256:
`7ac25a928a5cbcec24af81e01c082f35904c583e9729655712d309d3387afecb`.
The SDK produces all **192 request bytes and all five account metas**. This is not a hand-written copy of production Borsh encoding. Complete expected bytes also live in `vehicle-vrf-request-v1.hex`; `vehicle-vrf-callback-v1.hex` records the **72-byte** callback ABI. Rust can consume the sidecars via `include_str!` without adding a JSON dependency. TypeScript can import the complete JSON.

Deterministic inputs:

- Craft program: existing `DUXczJ1EUMgyRVRFbToB95SiuAKEkewJ4iarhDaZTNMt`.
- Root ID: 16 bytes of `0x11`; attempt ID: 16 bytes of `0x22`.
- Caller seed/terms commitment: bytes `00` through `1f`. This is a synthetic known commitment, not a live recipe/material or issued permit.
- Root, attempt and oracle escrow use the production seeds `vehicle_root`, `vehicle_attempt`, `vehicle_oracle` with the corresponding IDs. Addresses and exact privileges are in JSON.
- Callback discriminator: `e239a17d61021614`, SHA-256(`global:consume_vehicle_randomness`)[0:8]. Callback metas are root readonly/nonsigner, attempt writable/nonsigner; the provider prepends its scoped signer.
- Saved callback args: root ID followed by attempt ID. Callback body is discriminator + 32 randomness bytes `a0` through `bf` + those saved args. Anchor Borsh argument serialization is independently compared to that complete vector.
- Scoped provider identity: `J99pUPr4rRoHcZ2auQ1WpRVUqdhrxnwaXajXgwSrJ3ou`, derived from `[identity, craft_program_id]` under the provider. It differs from the legacy global identity and craft request-signing identity.

The focused integration tests passed **3/3, zero failures, ignored or filtered cases**. They pin the complete JSON/request bytes and five metas; deserialize all saved callback capabilities through the selected SDK's Borsh type without a tail; distinguish scoped versus global/cross-program identities; and verify the callback's exact randomness-first Anchor argument order. Existing S2 tests were not repeated or changed. Raw logs and source fingerprints are in `../evidence/2026-09-30-vehicle-vrf-sdk/`. Unchanged Anchor macro cfg warnings remain warnings; do not follow their generic suggestion to update the pinned dependency graph.

Run from repository root:

```sh
cargo test --manifest-path spikes/phase-e-toolchain-vrf/Cargo.toml -p spike-vrf --test vehicle_vrf_compat --locked --offline
```

The explicit generator prints SDK-derived JSON; it never rewrites a fixture during tests:

```sh
cargo run --manifest-path spikes/phase-e-toolchain-vrf/Cargo.toml -p spike-vrf --example vehicle_vrf_vector --locked --offline
```

The program owner consumes these same immutable sidecars in production `vehicle_protocol::provider_request` and generated `ConsumeVehicleRandomness` instruction tests. Its production-host/SBF acceptance is separate from these three SDK tests; do not claim production execution merely from the standalone vector. No live provider, queue, network request, unpredictable draw, oracle liveness, callback delivery, K140 terminal behavior, release or deployment is proven or attempted here. The fixture's randomness is intentionally public and deterministic.
