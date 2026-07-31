# Stats Archive Schema v3

Schema v3 adds delta-encoded timestamps and counts to deterministic archive
chunks for the `maplelegends-online-users` dataset. Readers SHOULD continue to
support schema v2 during migration.

## Manifest

```json
{
  "schemaVersion": 3,
  "dataset": "maplelegends-online-users",
  "archiveThroughPeriod": "2026-12",
  "format": {
    "rowShape": ["timestampDeltaSeconds", "usercountDelta", "uniquecountDelta?"],
    "timestampUnit": "seconds",
    "order": "ascending"
  },
  "chunks": [
    {
      "period": "2026-12",
      "granularity": "month",
      "file": "2026-12.EHlyeNq9.json",
      "minTimestamp": 1796083210,
      "maxTimestamp": 1796083510,
      "rowCount": 2
    }
  ]
}
```

The manifest rules, archive horizon, partitioning, and chunk ordering are the
same as schema v2. `schemaVersion` MUST equal `3`, and `format.rowShape` MUST
equal the shape shown above. Manifest timestamp bounds remain absolute Unix
timestamps in seconds.

## Chunk

```json
{
  "schemaVersion": 3,
  "period": "2026-12",
  "timestampBase": 1796083210,
  "data": [
    [0, 1234, 600],
    [300, 16, 42],
    [300, null, 10]
  ]
}
```

- `timestampBase` MUST be a nonnegative safe integer and is the absolute Unix
  timestamp in seconds of the first row.
- The first row's delta MUST equal `0`.
- Every later delta MUST be a positive safe integer measured from the
  immediately preceding row.
- Decoding starts at `timestampBase` and cumulatively adds each later delta.
  Every decoded timestamp MUST remain a safe integer.
- Decoded timestamps MUST be unique, strictly ascending, and within the
  chunk's declared period.
- User and unique count decoder states each start at zero. Every non-null count
  is a signed safe-integer delta added to that field's current state.
- A decoded count MUST remain a nonnegative safe integer.
- A null count is missing and does not update that field's state. A missing
  trailing `uniquecountDelta` has the same meaning as null and is omitted by
  canonical encoders.
- A missing `usercountDelta` MUST be represented by null. This permits a unique
  count delta to remain present in the third tuple position.
- Empty chunks are not emitted. Manifest `rowCount`, `minTimestamp`, and
  `maxTimestamp` MUST match the decoded rows.

## Deterministic encoding

Given identical normalized input, generation MUST produce byte-identical
chunks, filenames, and manifests:

1. Sort absolute rows by timestamp ascending.
2. Set `timestampBase` to the first timestamp, encode the first delta as `0`,
   and encode later timestamps relative to the immediately preceding row.
3. Initialize both count states to zero. Encode each present count relative to
   its state, update that state, and leave the state unchanged for missing data.
4. Sort manifest chunks newest-first by period.
5. Serialize compact UTF-8 JSON in the field order shown above with exactly one
   trailing newline.
6. Compute SHA-256 over the serialized chunk, take the first six digest bytes,
   and encode them as an unpadded eight-character base64url filename token.
