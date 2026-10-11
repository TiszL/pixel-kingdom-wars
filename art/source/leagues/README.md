# Ranked-league crests

Owner-authored 40×40 pixel masters copied byte-for-byte from
`NEW UI HUD HANDOUT/assets/league_*.png`.

| file | sha256 |
|---|---|
| `league_bronze.png` | `851cae2429b7e769ba4ea61b9c6753ff5e4dc40bcccae19f964b66be093fda98` |
| `league_silver.png` | `9682ef687b07aa07cb541e701d6e68cf8c014607d96120666bdc553e922996f9` |
| `league_gold.png` | `35c4cfcc6035bacbd0c4c8821697abfdbb7ee5783a863eac2c2ae974204a2305` |
| `league_sol.png` | `d8a0337e2b1297ac61e0e341b7f876105008951bc79bc7deade48f7d944a912f` |

They are React DOM images, not Phaser atlas frames. Vite emits them as hashed
files; do not add an overlay-policy rule unless they first gain target-ledger
atlas keys.
