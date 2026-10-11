# Current craft C2 vector profile

This additive profile targets craft `4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59` with the existing ephemeral-vrf-sdk0.17.2/anchor-compat wire. All v1 files and their SDK tests remain historical evidence. SchemaVersion1 describes the unchanged wire schema; the v2 filename identifies this current program profile.

The fixture uses the original public root/attempt bytes11/22, payload00..1f and randomnessa0..bf. Its five PDA values and complete192-byte request were independently calculated with public SHA256/Edwards arithmetic from the frozen SDK generator layout, reproducing the entire historical profile first. The72-byte callback payload is unchanged because it contains only the discriminator, randomness and saved ids; callback account/program addresses differ in the JSON.

Source preparation has not executed the Rust SDK generator or tests. Added `vehicle_vrf_vector_v2` example and `vehicle_vrf_compat_v2` test target use the actual pinned SDK independently. Also run the current production Rust and TypeScript consumers. These are ABI fixtures, not signed transactions, provider delivery, unpredictability or deployment proof. No signing, minting or key access is involved in their source derivation.
