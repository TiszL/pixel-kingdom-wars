# Tracked exact fixture: bound-cosmetics candidate pack (renderer contract 16)

Exact bytes from the candidate client pack `client-packs/candidate-6f7a9e81-sim18-r16-cosmetics`
(contentVersion `96095940afe26b42d202ef8f9b1be485935a8f6249de7ef4d88dd5c66066f9b6`, base pack
`canonical-6f7a9e81-sim18-r15`, cosmetics source `bf27e0c14…`), so the four pack-reading test suites
(`renderer` PhaseECosmeticArtTest, BoundCosmeticPreviewArtTest; `app` BoundCosmeticArtAdmissionTest,
ServiceContentTest) run on a fresh checkout without the gitignored export. Nothing here is activated,
pinned into `client-pack.lock.json`, or read by production code.

| file | bytes | origin |
|---|---|---|
| `atlas/pe_cosmetics@1x.json` | 45,997 | verbatim (pin `d533e9fb…` in the `boundCosmetics` group and the manifest) |
| `atlas/pe_cosmetics@1x.png` | 913,168 | verbatim (pin `c96d27b5…`) |
| `manifest.json` | 322,097 | verbatim, keeps the candidate `contentVersion` |
| `catalogue.json` | 296,869 | verbatim |
| `render-catalog.json.gz` | 428,808 | `gzip -9 -n` of the exact 7,517,225-byte `render-catalog.json` (sha256 `77d99656a5e6a2279bf857c20692723f6ba06316c2bf157506201b6f8de41e87`); tests gunzip it and assert that digest before parsing |

`SHA256SUMS` pins every fixture file. The compressed bytes depend on the gzip implementation; the
**decompressed** digest is the contract the tests check.

## Reproduce from a candidate export
```sh
C=client-packs/candidate-6f7a9e81-sim18-r16-cosmetics
F=test-fixtures/candidate-6f7a9e81-sim18-r16-cosmetics
mkdir -p "$F/atlas"
cp "$C/atlas/pe_cosmetics@1x.json" "$C/atlas/pe_cosmetics@1x.png" "$F/atlas/"
cp "$C/manifest.json" "$C/catalogue.json" "$F/"
gzip -9 -n -c "$C/render-catalog.json" > "$F/render-catalog.json.gz"   # -n: no name, mtime 0 (deterministic)
(cd "$F" && shasum -a 256 -c SHA256SUMS)
gzip -dc "$F/render-catalog.json.gz" | shasum -a 256   # 77d99656…
```
The candidate itself is produced by
`node tools/extend-cosmetics-pack.mjs --pack client-packs/canonical-6f7a9e81-sim18-r15 --cosmetics-source <SHARDKEEP worktree at bf27e0c14> --out client-packs/candidate-6f7a9e81-sim18-r16-cosmetics`.
