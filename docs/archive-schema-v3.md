# Stats Archive Schema v3

Schema v3 defines delta-encoded timestamps and counts for deterministic archive
chunks in the `maplelegends-online-users` dataset.

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

### Manifest fields

- `schemaVersion` MUST equal `3`.
- `dataset` MUST equal `maplelegends-online-users`.
- `archiveThroughPeriod` is the latest completed UTC month represented by the
  archive, including a month with no observations. It MUST use `YYYY-MM`.
- `format.rowShape` MUST equal
  `["timestampDeltaSeconds", "usercountDelta"]` or
  `["timestampDeltaSeconds", "usercountDelta", "uniquecountDelta?"]`.
- The compatibility name `usercount` stores the number of online characters.
  The compatibility name `uniquecount` stores the estimated number of players,
  identified by IP. Their names and tuple positions MUST remain unchanged.
- `format.timestampUnit` MUST equal `seconds`.
- `format.order` MUST equal `ascending`.
- `chunks` MUST be ordered newest-first and MUST NOT overlap.

Each chunk entry contains:

- `period`: `YYYY-MM` for a monthly chunk or `YYYY` for an annual chunk.
- `granularity`: `month` or `year`, matching `period`.
- `file`: a content-hashed filename relative to the manifest.
- `minTimestamp`: the smallest decoded sample timestamp in the chunk.
- `maxTimestamp`: the largest decoded sample timestamp in the chunk.
- `rowCount`: the number of rows in the chunk.

Manifest timestamp bounds remain absolute Unix timestamps in seconds. An empty
archived month advances `archiveThroughPeriod` but does not produce an empty
chunk.

### Partitioning

Monthly chunks cover observed months in the same calendar year as
`archiveThroughPeriod`, from January through `archiveThroughPeriod`. If
`archiveThroughPeriod` is January, observed months from the full previous
calendar year also remain monthly so the latest previous-year December can be
loaded without fetching a full annual chunk.

All earlier observations are grouped into non-overlapping complete annual
chunks. Annual chunks MUST NOT represent partial calendar years. Periods without
observations do not produce empty chunk files.

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
