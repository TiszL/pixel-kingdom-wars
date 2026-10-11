# Tracked renderer17 vehicle metadata and resident pair

Partial historical fixture, not an installable pack. Original immutable input:
`candidate-6f7a9e81-sim18-r17-fleet-vehicle-d918afd4`, manifest SHA256
`7ce8c43ec191e9b6ba7be4d3b399c46acc3913c3ef1f06ef16209472483c981c`.

The catalogue, manifest and workshop tier1 JSON/PNG are exact source copies.
The compressed render catalogue is copied from the existing tracked renderer17
fleet fixture; decompression yields the exact vehicle candidate render bytes,
SHA256 `f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133`.

This lets ServiceContentResidentTest run without a generated/ignored bundle or
Desktop path. It promotes descriptor tiers inside its temporary fixture and
acquires only the included workshop pair. Its explicit environment override
continues to support the content pipeline's pinned historical RED and integration GREEN.
No graph, constant or expected assertion was rewritten. Other optional pixels
are deliberately absent. The exporter can reuse this tracked metadata in labelled
ServiceContentR17Test / ActualFixtureRendererSmokeTest input-root hunks.
