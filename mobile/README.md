# Solana Mobile shell

Pixel Kingdom Wars ships to Android as a Trusted Web Activity (TWA) for
`https://play.pixelkingdomwars.com`. The thin APK contains the Android shell;
the game itself is the deployed web client and downloads its verified asset
pack at first launch. The current release has been submitted to the Solana dApp
Store; this repository does not claim an approval date or review duration.

## What changes require an APK

| Change | Delivery |
|---|---|
| Game logic, balance, art or UI | Deploy the API/web application on the production host |
| Solana program code with no shell-contract change | Upgrade the program; no APK rebuild |
| Android identity, icon, orientation, domain or shell metadata | Increment the TWA version, rebuild and submit a new APK |

Digital Asset Links binds the Android package and signing certificate to the
game domain. Mobile Wallet Adapter then lets the TWA request signatures from a
compatible wallet such as Seed Vault.

## Private Seeker acceptance app

D-122 authorizes `node mobile/build-qa-apk.mjs https://<test-host>` for installed
candidate testing. It uses only `gg.pixelkingdomwars.privateqa`, a generated key
under ignored `mobile/build/qa`, and an HTTPS `trycloudflare.com` or `ts.net` origin.
It cannot target the store domain/package. `--prepare` writes the test manifest
and `public/.well-known/assetlinks.json` before building. Serve that DAL at the test
origin and the candidate icons on loopback port18888, then run the build without
`--prepare`. Web and API must share the same candidate HTTPS origin.

This APK is for private sideloading, never store submission. Preserve the production
config, signing material and Digital Asset Links. Inspect the generated package,
certificate and served DAL, then capture physical Seed Vault login/resume/cancel and
the genuine tutorial/payment/mint/raid journey. A signed APK alone does not pass the
physical-device release gate. Stop the temporary tunnel after testing; its hostname
and availability are not a permanent metadata-host guarantee for test deeds.

## Tracked and untracked files

Tracked mobile source is intentionally small:

```text
mobile/
├── .gitignore
├── README.md
├── build-apk.sh
├── redact-build-output.mjs
└── twa.config.json
```

Signing material and output are local-only:

- `mobile/keystore/` — release key and passwords
- `mobile/build/` — signed and intermediate APKs
- `mobile/dappstore/` — publisher/submission artifacts, if created

All three are ignored. Never add them to Git, attach them to an issue, paste
their contents into a build log, or place them in a Docker build context. The
release keystore must be backed up off this machine; losing it prevents updates
to the existing Android application identity.

## Build

**Cut a store release with `pnpm apk:release <version> <versionCode>` — the
runbook is [`docs/APK-RELEASE.md`](../docs/APK-RELEASE.md) (D-101).** A real run
first acquires the exclusive external release lock, then stages the three
version files plus CHANGELOG in a durable transaction,
proves the keystore is THE store key before building, runs this script with the
password passed only to keytool/direct apksigner through the environment, verifies the APK and copies it
next to the previous releases. Ordinary file-state failures roll back; a changed
`mobile/build` is retained for deliberate reconciliation against its immutable
backup because the tool never approximates a no-replace directory swap. After an interrupted
process, rerun the exact same version/code **and copy mode** (preserve
`--no-copy`): the revisioned owner/marker CAS, checksummed tracked/DAL/build
snapshot, inode-pinned copy, and completion receipt either resume or fail
closed. A receipt repeats the normal release gates and derives the expected
signer independently. Concurrent rollback edits are preserved for manual
recovery. The wrapper unexports credentials before its first external child and
injects the value only into keytool and direct apksigner. Critical metadata
is fsynced where supported, but this is not a universal whole-tree power-loss
guarantee. `mobile/build-apk.sh` is an internal step and refuses direct
invocation; the guarded `pnpm apk:release` command is the only supported lane.

Prerequisites are a JDK, Android tooling and a reachable production manifest.
The config in [`twa.config.json`](twa.config.json) is the source of truth for the
domain, application ID and version code: the build uses `appVersionCode`
EXACTLY and dies if it does not beat the previous local build, so a fresh clone
and this Mac produce the same code for the same commit. The "Android shell
releases" table in the runbook records every code cut so far.

> **Store-update signing rule:** every future update to that version-code-9
> listing must use the exact same ignored signing identity: both the original
> keystore selected with `PKW_KEYSTORE_OVERRIDE` and its alias selected with
> `PKW_KEYSTORE_ALIAS`. Never invoke the internal build step or its
> `--new-keystore` implementation directly for an update to the existing
> listing; a new key creates a different, non-upgradable identity.

```sh
curl -I https://play.pixelkingdomwars.com/manifest.webmanifest
pnpm apk:release <version> <versionCode>
```

The guarded command reads the ignored store keystore, derives and independently
checks its public signing fingerprint, invokes the internal build step, verifies
[`assetlinks.json`](../apps/web/public/.well-known/assetlinks.json), regenerates
the Bubblewrap project and produces the ignored APK. Secret-bearing command
output is redacted; treat any unexpected raw tool output as sensitive anyway.

After a signing-certificate change, deploy the updated `assetlinks.json` before
testing the APK. A certificate mismatch produces a visible browser address bar.

## Device smoke test

Use a non-production test account and check:

1. the shell opens without browser chrome;
2. first-launch asset download can resume after interruption;
3. wallet connect reaches the installed mobile wallet;
4. authentication, base load and one battle complete;
5. force-quit/reopen and update prompts behave correctly.

The API exposes its build and simulator protocol through `/version`. A protocol
mismatch blocks starting a new raid until the client updates. Completed battle
replays render the authoritative event log stored by the server; they are not
re-simulated under the newer client.

## Publishing

Use the Solana Mobile Publisher Portal or official dApp Store CLI with local,
ignored submission artifacts; the step list and the release record live in
[`docs/APK-RELEASE.md`](../docs/APK-RELEASE.md). The public listing inputs include the signed APK,
icon, screenshots, descriptions and legal URLs. Never commit an API key,
publisher keypair, keystore, password file or APK as proof of submission.
