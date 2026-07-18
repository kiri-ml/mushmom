# Stats Archive Schema v2

Schema v2 defines deterministic manifests and archive chunks for the
`maplelegends-online-users` dataset.

## Manifest

```json
{
  "schemaVersion": 2,
  "dataset": "maplelegends-online-users",
  "archiveThroughPeriod": "2026-12",
  "format": {
    "rowShape": ["epochSeconds", "usercount", "uniquecount?"],
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

- `schemaVersion` MUST equal `2`.
- `dataset` MUST equal `maplelegends-online-users`.
- `archiveThroughPeriod` is the latest completed UTC month represented by the
  archive, including a month with no observations. It MUST use `YYYY-MM`.
- `format.rowShape` MUST equal `["epochSeconds", "usercount"]` for an
  existing legacy manifest or `["epochSeconds", "usercount", "uniquecount?"]`
  for a newly generated manifest.
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
- `minTimestamp`: the smallest actual sample timestamp in the chunk.
- `maxTimestamp`: the largest actual sample timestamp in the chunk.
- `rowCount`: the number of rows in the chunk.

An empty archived month advances `archiveThroughPeriod` but does not produce an
empty chunk.

If no R2 JSONL rows are available, generation uses only valid legacy rows before
the fixed cutover and deterministically sets `archiveThroughPeriod` to
`2026-06`, the month immediately before the cutover.

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
  "schemaVersion": 2,
  "period": "2026-12",
  "data": [
    [1796083210, 1234],
    [1796083510, 1250, 642]
  ]
}
```

### Chunk rules

- `schemaVersion` MUST equal `2`.
- `period` MUST match its manifest entry.
- Each row MUST contain two or three nonnegative integers: an epoch timestamp
  in UTC seconds, an online-character count (`usercount`), and an optional
  estimated-player count identified by IP (`uniquecount`). Two- and
  three-value rows MAY coexist in the same chunk. A missing estimated-player
  count means unavailable and MUST NOT imply zero.
- Timestamps MUST be unique and strictly ascending.
- Missing timestamps represent missing observations and MUST NOT imply a zero
  character count.
- `minTimestamp`, `maxTimestamp`, and `rowCount` in the manifest MUST match the
  chunk contents.

## Deterministic encoding

Given identical normalized input, generation MUST produce byte-identical chunk
files, filenames, and manifest output.

Encoding follows these rules:

1. Sort chunk rows by timestamp ascending.
2. Sort manifest chunks newest-first by period.
3. Serialize JSON as compact UTF-8 with the field order shown in this document
   and exactly one trailing newline.
4. Compute SHA-256 over the exact serialized chunk bytes.
5. Take the first six digest bytes and encode them as unpadded base64url. The
   resulting eight-character token forms the filename:
   `<period>.<token>.json`.

The manifest intentionally contains no generation timestamp or arbitrary
revision. Dataset-derived fields and content-hashed filenames provide stable
identity without making regeneration nondeterministic.
