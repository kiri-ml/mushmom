#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_OUTPUT_DIR = "public/assets/stats";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = options.source || process.env.GOOGLE_API_URL || readDevVar("GOOGLE_API_URL");
  const outputDir = path.resolve(process.cwd(), options.output || DEFAULT_OUTPUT_DIR);

  if (!source) {
    throw new Error("GOOGLE_API_URL is not set. Pass --source, set the env var, or add it to .dev.vars.");
  }

  const payload = await readJson(source);
  const { chunks } = generateArchive(payload, outputDir);

  console.log(
    `Generated ${chunks.length} stats archive chunks in ${path.relative(process.cwd(), outputDir)}`,
  );
}

function generateArchive(payload, outputDir) {
  const rows = extractRows(payload)
    .map(compactRow)
    .filter((row) => row !== null)
    .sort((a, b) => b[0] - a[0]);

  if (rows.length === 0) {
    throw new Error("Source contained no usable stats rows.");
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

  return { manifest, chunks: archiveFiles };
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--source") {
      options.source = args[++index];
    } else if (arg === "--output") {
      options.output = args[++index];
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
  const timestamp = row?.timestamp;
  const usercount = Number(row?.usercount);
  const date = truncateDateToSecond(parseTimestamp(timestamp));

  if (!date || !Number.isFinite(usercount)) return null;

  return [Math.floor(date.getTime() / 1000), usercount];
}

function parseTimestamp(value) {
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
};
