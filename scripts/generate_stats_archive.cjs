#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_OUTPUT_DIR = "public/assets/stats";
const DEFAULT_BUNDLED_MANIFEST_PATH = "src/assets/stats/manifests.json";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const defaultSource = process.env.GOOGLE_API_URL || readDevVar("GOOGLE_API_URL");
  const source = options.source || (options.jsonlDir ? "" : defaultSource);
  const outputDir = path.resolve(process.cwd(), options.output || DEFAULT_OUTPUT_DIR);
  const jsonlDir = options.jsonlDir ? path.resolve(process.cwd(), options.jsonlDir) : null;

  if (!source && !jsonlDir) {
    throw new Error("Pass --jsonl-dir or provide a JSON source with --source or GOOGLE_API_URL.");
  }

  const jsonlRows = jsonlDir ? readJsonlDirectory(jsonlDir) : [];
  const payload = source
    ? await readJson(source)
    : { data: readExistingArchiveRows(outputDir) };
  const { chunks } = generateArchive(payload, outputDir, jsonlRows);

  console.log(
    `Generated ${chunks.length} stats archive chunks in ${path.relative(process.cwd(), outputDir)}`,
  );
}

function generateArchive(payload, outputDir, additionalRows = []) {
  const rows = mergeRows(
    extractRows(payload).map(compactRow).filter((row) => row !== null),
    additionalRows.map(compactRow).filter((row) => row !== null),
  );

  if (rows.length === 0) {
    throw new Error("No usable stats rows found.");
  }

  const latest = new Date(rows[0][0] * 1000);
  const latestYear = latest.getUTCFullYear();
  const latestMonth = latest.getUTCMonth() + 1;
  const initialName = previousMonthName(latestYear, latestMonth);
  const chunks = buildChunks(rows, latestYear, latestMonth);
  const initialChunk = findChunk(chunks, initialName) || buildMonthChunk(rows, initialName);
  const archiveFiles = mergeChunks(chunks, initialChunk);

  fs.mkdirSync(outputDir, { recursive: true });

  const manifestBackfill = chunks
    .filter((chunk) => chunk.name !== initialName)
    .map(toManifestChunk);
  const manifestInitial = toManifestChunk(initialChunk);
  const manifest = {
    output: {
      rowShape: ["epochSeconds", "usercount"],
      order: "newest-first",
    },
    initial: manifestInitial,
    backfill: manifestBackfill,
  };

  for (const chunk of archiveFiles) {
    writeJson(path.join(outputDir, `${chunk.name}.json`), {
      period: chunk.name,
      data: chunk.rows,
    });
  }

  writeJson(path.join(outputDir, "manifests.json"), manifest);
  writeBundledManifest(outputDir, manifest);

  return { manifest, chunks: archiveFiles };
}

function writeBundledManifest(outputDir, manifest) {
  const defaultOutputDir = path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR);
  if (path.resolve(outputDir) !== defaultOutputDir) return;

  writeJson(path.resolve(process.cwd(), DEFAULT_BUNDLED_MANIFEST_PATH), manifest);
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--source") {
      options.source = args[++index];
    } else if (arg === "--output") {
      options.output = args[++index];
    } else if (arg === "--jsonl-dir") {
      options.jsonlDir = args[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/generate_stats_archive.cjs [options]

Options:
  --source <url-or-file>   Stats JSON source. Defaults to GOOGLE_API_URL or .dev.vars.
  --output <directory>     Output directory. Defaults to ${DEFAULT_OUTPUT_DIR}.
  --jsonl-dir <directory>  Daily R2 JSONL files to merge with existing archives.
`);
}

function readDevVar(name) {
  const devVarsPath = path.join(process.cwd(), ".dev.vars");
  if (!fs.existsSync(devVarsPath)) return "";

  const text = fs.readFileSync(devVarsPath, "utf8");
  const match = text.match(new RegExp(`^${escapeRegExp(name)}=(.*)$`, "m"));
  if (!match) return "";

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

async function readJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: {
        accept: "application/json",
        "user-agent": "mushmom-stats-archive-generator/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Stats source returned ${response.status}.`);
    }

    return response.json();
  }

  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), source), "utf8"));
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.values)) return payload.values;
  if (Array.isArray(payload?.rows)) return payload.rows;

  return [];
}

function compactRow(row) {
  const timestamp = Array.isArray(row) ? row[0] : row?.timestamp;
  const usercount = Number(Array.isArray(row) ? row[1] : row?.usercount);
  const date = truncateDateToSecond(parseTimestamp(timestamp));

  if (!date || !Number.isInteger(usercount) || usercount < 0) return null;

  return [Math.floor(date.getTime() / 1000), usercount];
}

function mergeRows(...groups) {
  const rowsByTimestamp = new Map();

  for (const row of groups.flat()) {
    rowsByTimestamp.set(row[0], row);
  }

  return [...rowsByTimestamp.values()].sort((a, b) => b[0] - a[0]);
}

function readExistingArchiveRows(outputDir) {
  const manifestPath = path.join(outputDir, "manifests.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Existing archive manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = new Set([
    manifest?.initial?.file,
    ...(Array.isArray(manifest?.backfill) ? manifest.backfill.map((chunk) => chunk?.file) : []),
  ].filter(Boolean));

  if (files.size === 0) {
    throw new Error(`Existing archive manifest contained no files: ${manifestPath}`);
  }

  return [...files].flatMap((file) => {
    const archivePath = path.join(outputDir, file);
    if (!fs.existsSync(archivePath)) {
      throw new Error(`Existing archive file not found: ${archivePath}`);
    }
    return extractRows(JSON.parse(fs.readFileSync(archivePath, "utf8")));
  });
}

function readJsonlDirectory(jsonlDir) {
  if (!fs.existsSync(jsonlDir) || !fs.statSync(jsonlDir).isDirectory()) {
    throw new Error(`JSONL directory not found: ${jsonlDir}`);
  }

  const files = fs.readdirSync(jsonlDir)
    .filter((file) => file.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    throw new Error(`JSONL directory contained no .jsonl files: ${jsonlDir}`);
  }

  return files.flatMap((file) => parseJsonlFile(path.join(jsonlDir, file)));
}

function parseJsonlFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];

  return text.split(/\r?\n/).map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: malformed JSON.`);
    }

    if (!Array.isArray(row)
      || row.length !== 2
      || !Number.isInteger(row[0])
      || row[0] < 0
      || !Number.isInteger(row[1])
      || row[1] < 0) {
      throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: expected a non-negative integer tuple.`);
    }
    return row;
  });
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return parseTimestamp(Number(value));
  }
  if (!value) return null;

  const normalized = String(value)
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

function truncateDateToSecond(date) {
  return date ? new Date(Math.floor(date.getTime() / 1000) * 1000) : null;
}

function buildChunks(rows, latestYear, latestMonth) {
  const groups = new Map();

  for (const row of rows) {
    const date = new Date(row[0] * 1000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const key =
      year < latestYear
        ? String(year)
        : year === latestYear && month < latestMonth
          ? `${year}-${String(month).padStart(2, "0")}`
          : null;

    if (!key) continue;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([name, chunkRows]) => ({ name, rows: chunkRows }));
}

function previousMonthName(latestYear, latestMonth) {
  const date = new Date(Date.UTC(latestYear, latestMonth - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function buildMonthChunk(rows, name) {
  const chunkRows = rows.filter((row) => monthNameForRow(row) === name);
  return { name, rows: chunkRows };
}

function monthNameForRow(row) {
  const date = new Date(row[0] * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function findChunk(chunks, name) {
  return chunks.find((chunk) => chunk.name === name) || null;
}

function mergeChunks(chunks, chunk) {
  if (findChunk(chunks, chunk.name)) return chunks;

  return [...chunks, chunk].sort((a, b) => b.name.localeCompare(a.name));
}

function toManifestChunk({ name, rows }) {
  return {
    file: `${name}.json`,
    period: name,
    start: rows.at(-1)?.[0] ?? null,
    end: rows[0]?.[0] ?? null,
    rows: rows.length,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  buildChunks,
  generateArchive,
  previousMonthName,
  readExistingArchiveRows,
  readJsonlDirectory,
};
