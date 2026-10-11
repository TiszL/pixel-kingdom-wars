# Canonical command correlation fixtures

`source-reference.json` comes from the current source checkout's real
`nativeOrders` and `simulateRaid`, with SIM15, exact accepted journal sequences,
frozen hero levels and source troop options. It retains every canonical event,
its array order, full-event SHA-256, source input file hashes and the source policy.
Synthetic command IDs are local fixture labels, not player data.

From the native repository, generate using the source's installed tsx:

```sh
../apps/api/node_modules/.bin/tsx app/src/test/resources/command-correlation/generate.mts .. --check
```

Omit `--check` only after reviewing an intentional source change. Check mode
re-simulates all five small cases without changing the frozen fixture. This is
not a native pack export or historical replay rewrite.

The primary case records identical-position/offset held troops and two heroes,
plus two distinct millisecond offsets within one tick. It also contains a
defender hero and interleaved Nest births. The second pair proves actor IDs
change after a same-offset earlier-tile insertion. The early victory case ends
before an accepted future hero is emitted. The final case contains both Nest
and Hexbarrow births before the second direct command: its actor ID is 14,
not the direct deployment ordinal 1.

This fixture tests exact identity association only. It does not claim live
network ordering, frame timing, a physical device result or a measured latency.
