import fs from "node:fs";
import path from "node:path";
import { defineConfig, type HtmlTagDescriptor } from "vite";
import { nextMonthKey } from "./src/stats-months";

const wranglerPort = process.env.WRANGLER_PORT || "8788";

type StatsManifest = {
  schemaVersion?: number;
  archiveThroughPeriod?: string;
  chunks?: Array<{ file?: string }>;
};

const STATS_ARCHIVE_BASE_URL = "/assets/stats/";

function readStatsManifest(): StatsManifest {
  const manifestPath = path.resolve("public/assets/stats/manifests.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as StatsManifest;
}

function renderTag(tag: HtmlTagDescriptor): string {
  const attrs = Object.entries(tag.attrs || {})
    .map(([key, value]) => value === "" ? key : `${key}=${JSON.stringify(String(value))}`)
    .join(" ");
  return `<${tag.tag}${attrs ? ` ${attrs}` : ""}>`;
}

function buildApiPreloadLinks(): string[] {
  return buildApiPreloadTags().map(renderTag);
}

function injectStartupHtml(html: string): string {
  const moduleScriptPattern = /^\s*<script type="module" src="\/src\/main\.ts"><\/script>/m;
  if (!moduleScriptPattern.test(html)) {
    throw new Error("Unable to find the app module script for startup injection.");
  }

  const startupTags = [
    ...buildApiPreloadLinks(),
  ].map((tag) => `    ${tag}`).join("\n");

  return html.replace(moduleScriptPattern, `${startupTags}\n    <script type="module" src="/src/main.ts"></script>`);
}

function buildApiPreloadTags(manifest: StatsManifest = readStatsManifest()): HtmlTagDescriptor[] {
  if (manifest.schemaVersion !== 2 || !manifest.archiveThroughPeriod || !Array.isArray(manifest.chunks)) {
    throw new Error("Stats manifest must use schemaVersion 2.");
  }
  const firstRecentMonth = nextMonthKey(manifest.archiveThroughPeriod);
  const newestFile = manifest.chunks[0]?.file;

  const tags: HtmlTagDescriptor[] = [
    {
      tag: "link",
      attrs: {
        rel: "preload",
        href: `/api/stats/${firstRecentMonth}`,
        as: "fetch",
        crossorigin: "",
      },
      injectTo: "head",
    },
  ];
  if (newestFile) tags.push({
      tag: "link",
      attrs: {
        rel: "preload",
        href: new URL(newestFile, `https://mushmom.local${STATS_ARCHIVE_BASE_URL}`).pathname,
        as: "fetch",
        crossorigin: "",
      },
      injectTo: "head",
    });
  tags.push({
      tag: "link",
      attrs: {
        rel: "preload",
        href: "/api/current",
        as: "fetch",
        crossorigin: "",
      },
      injectTo: "head",
    });
  return tags;
}

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${wranglerPort}`,
        changeOrigin: true,
      },
    },
  },
  plugins: [
    {
      name: "mushmom-html-startup",
      transformIndexHtml: {
        order: "pre",
        handler: (html) => injectStartupHtml(html),
      },
    },
  ],
  build: {
    modulePreload: {
      polyfill: false,
    },
  },
});

export { buildApiPreloadTags, buildApiPreloadLinks, injectStartupHtml };
