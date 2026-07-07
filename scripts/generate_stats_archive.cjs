#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LEGACY_SOURCE = "https://storage.googleapis.com/geospiza/query/maplelegends-online-count.json";
const CUTOVER_EPOCH = 1782864000;
const DATASET = "maplelegends-online-users";
const DEFAULT_OUTPUT_DIR = "public/assets/stats";
const DEFAULT_BUNDLED_MANIFEST_PATH = "src/assets/stats/manifests.json";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), options.output || DEFAULT_OUTPUT_DIR);
  const jsonlDir = options.jsonlDir ? path.resolve(process.cwd(), options.jsonlDir) : null;
  const legacyPayloadPromise = readJson(LEGACY_SOURCE);
  const r2Rows = jsonlDir ? readJsonlDirectory(jsonlDir) : [];
  const legacyPayload = await legacyPayloadPromise;
  const { chunks } = generateArchive(legacyPayload, outputDir, r2Rows);
  console.log(`Generated ${chunks.length} stats archive chunks in ${path.relative(process.cwd(), outputDir)}`);
}

function generateArchive(legacyPayload, outputDir, r2InputRows = []) {
  const legacyRows = normalizeLegacyRows(extractRows(legacyPayload))
    .filter((row) => row[0] < CUTOVER_EPOCH);
  const r2Rows = normalizeR2Rows(r2InputRows)
    .filter((row) => row[0] >= CUTOVER_EPOCH);
  const archiveThroughPeriod = r2Rows.length > 0
    ? previousMonthName(monthNameForTimestamp(Math.max(...r2Rows.map((row) => row[0]))))
    : previousMonthName(monthNameForTimestamp(CUTOVER_EPOCH));
  const rows = mergeRows(legacyRows, r2Rows)
    .filter((row) => monthNameForTimestamp(row[0]) <= archiveThroughPeriod);
  const chunkGroups = buildChunks(rows, archiveThroughPeriod);

  fs.mkdirSync(outputDir, { recursive: true });
  const chunks = chunkGroups.map(({ period, granularity, rows: chunkRows }) => {
    const body = serializeJson({ schemaVersion: 2, period, data: chunkRows });
    const token = crypto.createHash("sha256").update(body).digest().subarray(0, 6).toString("base64url");
    const file = `${period}.${token}.json`;
    fs.writeFileSync(path.join(outputDir, file), body);
    return {
      period,
      granularity,
      file,
      minTimestamp: chunkRows[0][0],
      maxTimestamp: chunkRows.at(-1)[0],
      rowCount: chunkRows.length,
    };
  });

  const manifest = {
    schemaVersion: 2,
    dataset: DATASET,
    archiveThroughPeriod,
    format: {
      rowShape: ["epochSeconds", "usercount"],
      timestampUnit: "seconds",
      order: "ascending",
    },
    chunks,
  };
  const manifestBytes = serializeJson(manifest);
  fs.writeFileSync(path.join(outputDir, "manifests.json"), manifestBytes);
  removeUnreferencedJson(outputDir, new Set(["manifests.json", ...chunks.map((chunk) => chunk.file)]));
  writeBundledManifest(outputDir, manifestBytes);
  return { manifest, chunks };
}

function normalizeLegacyRows(rows) {
  const normalized = rows.map((row, index) => {
    if (!row || Array.isArray(row) || typeof row !== "object") {
      throw new Error(`Invalid legacy row ${index + 1}: expected an object.`);
    }
    const timestamp = row.timestamp ?? row.time ?? row.created_at ?? row.date;
    const usercount = row.usercount ?? row.users ?? row.players ?? row.count;
    const epoch = parseTimestamp(timestamp);
    if (!isNonnegativeInteger(epoch) || !isNonnegativeInteger(usercount)) {
      throw new Error(`Invalid legacy row ${index + 1}: expected a timestamp and non-negative integer usercount.`);
    }
    return [epoch, usercount];
  });
  return dedupeLast(normalized);
}

function normalizeR2Rows(rows) {
  if (!Array.isArray(rows)) throw new Error("R2 input must be an array of tuples.");
  const normalized = rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 2
      || !isNonnegativeInteger(row[0]) || !isNonnegativeInteger(row[1])) {
      throw new Error(`Invalid R2 row ${index + 1}: expected a non-negative integer tuple.`);
    }
    return [row[0], row[1]];
  });
  return dedupeLast(normalized);
}

function dedupeLast(rows) {
  const byTimestamp = new Map();
  for (const row of rows) byTimestamp.set(row[0], row);
  return [...byTimestamp.values()].sort((a, b) => a[0] - b[0]);
}

function mergeRows(...sources) {
  const byTimestamp = new Map();
  for (const source of sources) for (const row of source) byTimestamp.set(row[0], row);
  return [...byTimestamp.values()].sort((a, b) => a[0] - b[0]);
}

function buildChunks(rows, archiveThroughPeriod) {
  const horizon = parseMonthKey(archiveThroughPeriod);
  if (!horizon) throw new Error(`Invalid archive horizon: ${archiveThroughPeriod}`);
  const groups = new Map();

  for (const row of rows) {
    const period = monthNameForTimestamp(row[0]);
    if (period > archiveThroughPeriod) continue;
    const key = isMonthlyArchivePeriod(period, horizon) ? period : period.slice(0, 4);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .map(([period, chunkRows]) => ({
      period,
      granularity: period.length === 4 ? "year" : "month",
      rows: chunkRows.sort((a, b) => a[0] - b[0]),
    }))
    .sort((a, b) => b.period.localeCompare(a.period));
}

function isMonthlyArchivePeriod(period, horizon) {
  const parsed = parseMonthKey(period);
  if (!parsed) return false;
  if (parsed.year === horizon.year) return parsed.month <= horizon.month;
  return horizon.month === 1 && parsed.year === horizon.year - 1;
}

function readJsonlDirectory(jsonlDir) {
  if (!fs.existsSync(jsonlDir) || !fs.statSync(jsonlDir).isDirectory()) {
    throw new Error(`JSONL directory not found: ${jsonlDir}`);
  }
  const files = fs.readdirSync(jsonlDir).filter((file) => file.endsWith(".jsonl")).sort();
  if (files.length === 0) return [];
  return files.flatMap((file) => parseJsonlFile(path.join(jsonlDir, file), file));
}

function parseJsonlFile(filePath, fileName = path.basename(filePath)) {
  const match = /^(\d{4}-\d{2})\.jsonl$/.exec(fileName);
  if (!match || !parseMonthKey(match[1])) throw new Error(`Invalid R2 JSONL filename: ${fileName}`);
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let previous = -1;
  return lines.map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: malformed JSON.`);
    }
    if (!Array.isArray(row) || row.length !== 2
      || !isNonnegativeInteger(row[0]) || !isNonnegativeInteger(row[1])) {
      throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: expected a non-negative integer tuple.`);
    }
    if (monthNameForTimestamp(row[0]) !== match[1]) {
      throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: timestamp does not match filename month.`);
    }
    if (row[0] < previous) {
      throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: timestamps must be ascending.`);
    }
    previous = row[0];
    return row;
  });
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.values)) return payload.values;
  if (Array.isArray(payload?.rows)) return payload.rows;
  throw new Error("Legacy source contained no row array.");
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseTimestamp(Number(value));
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

function monthNameForTimestamp(timestamp) {
  const dateKey = dateKeyForTimestamp(timestamp);
  if (!dateKey) throw new Error(`Invalid epoch-second timestamp: ${timestamp}`);
  return dateKey.slice(0, 7);
}

function dateKeyForTimestamp(timestamp) {
  if (!isNonnegativeInteger(timestamp)) return null;
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function previousMonthName(monthKey) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) throw new Error(`Invalid month key: ${monthKey}`);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 2, 1));
  return date.toISOString().slice(0, 7);
}

function parseMonthKey(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

function removeUnreferencedJson(outputDir, keep) {
  for (const file of fs.readdirSync(outputDir)) {
    if (file.endsWith(".json") && !keep.has(file)) fs.rmSync(path.join(outputDir, file));
  }
}

function writeBundledManifest(outputDir, bytes) {
  if (path.resolve(outputDir) !== path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR)) return;
  fs.mkdirSync(path.dirname(path.resolve(DEFAULT_BUNDLED_MANIFEST_PATH)), { recursive: true });
  fs.writeFileSync(path.resolve(DEFAULT_BUNDLED_MANIFEST_PATH), bytes);
}

function serializeJson(value) { return `${JSON.stringify(value)}\n`; }

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output" || arg === "--jsonl-dir") {
      const value = args[++index];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      options[arg === "--output" ? "output" : "jsonlDir"] = value;
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
  console.log(`Usage: node scripts/generate_stats_archive.cjs [--jsonl-dir <directory>] [--output <directory>]

Always reads legacy history from ${LEGACY_SOURCE}.
If R2 JSONL is absent, archives through the month before the fixed cutover.`);
}

async function readJson(source) {
  const response = await fetch(source, {
    headers: {
      accept: "application/json",
      "user-agent": "mushmom-stats-archive-generator/2.0",
    },
  });
  if (!response.ok) throw new Error(`Legacy stats source returned ${response.status}.`);
  return response.json();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  CUTOVER_EPOCH,
  LEGACY_SOURCE,
  buildChunks,
  generateArchive,
  normalizeLegacyRows,
  parseJsonlFile,
  readJsonlDirectory,
};
