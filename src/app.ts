/// <reference path="./globals.d.ts" />

import uPlot from "uplot";

type ChartRange = "24h" | "7d" | "28d" | "90d" | "180d" | "ytd" | "1y" | "3y" | "all";
type ChartKind = "timeline" | "heatmap" | "distribution";
type BucketUnit = "hour" | "day" | "week";
type TimelineBucket = "raw" | "8h" | "1d" | "1w";

type MetricElementKey = "current" | "peak" | "average" | "lastSample" | "sampleCount" | "rangeLabel" | "sourceLabel";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

interface HistoricalSource {
  name: string;
  url: string | null;
}

interface CurrentStatus {
  kind: "loading" | "ready" | "failed";
  key: string;
  params: Record<string, string | number>;
}

interface TimelineConfig {
  labelKey: string;
}

interface DistributionBucket {
  label: string;
  count: number;
}

interface BucketSummary {
  time: number;
  min: number;
  max: number;
  avg: number;
  samples: number;
}

interface BucketAccumulator extends BucketSummary {
  total: number;
}

interface TimelineScaleSource {
  xValues: number[];
  lowValues: number[];
  highValues: number[];
}

type HeatmapValue = [hour: number, day: number, score: number | null, count: number, percentiles: Record<string, number>, samples: number];

interface ChartBuild {
  kind: ChartKind;
  options: uPlot.Options;
  data: uPlot.AlignedData;
  empty: boolean;
  timelineBuckets?: BucketSummary[];
  heatmapValues?: HeatmapValue[];
  distributionBuckets?: DistributionBucket[];
}

interface ChartInstance {
  destroy(): void;
  redraw?(rebuildPaths?: boolean, recalcAxes?: boolean): void;
  setScale?(key: string, opts: { min: number; max: number }): void;
  setSize(size: { width: number; height: number }): void;
}

type ChartFactory = (options: uPlot.Options, data: uPlot.AlignedData, target: HTMLElement) => ChartInstance;

type HeatmapHoverPlot = uPlot & {
  __mushmomHeatmapHover?: { hour: number; day: number } | null;
  __mushmomHeatmapColors?: Map<string, string>;
};

const chartElement = requireElement("#population-chart");
const rangeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-range]"));
const bucketButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-bucket]"));
const chartButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-chart]"));
const statusDot = requireElement("#status-dot");
const statusText = requireElement("#status-text");
const HEATMAP_VISUAL_MIN = 0;
const HEATMAP_VISUAL_MAX = 100;
const HEATMAP_OUTOFRANGE_COLOR = "#131617";
const HEATMAP_COLORS = [
  "#102a43",
  "#1e6091",
  "#2fbf71",
  "#f4d44d",
  "#f4a340",
  "#e84a4a",
  "#c62828",
];
const DISTRIBUTION_BAR_COLOR = "#f1c44f";
const DISTRIBUTION_STEP = 100;
const KNOWN_BAD_GAP_START = Date.parse("2020-06-15T15:30:55.664Z");
const KNOWN_BAD_GAP_END = Date.parse("2020-06-22T01:00:00.528Z");

const elements: Record<MetricElementKey, HTMLElement> = {
  current: requireElement("#current-count"),
  peak: requireElement("#peak-count"),
  average: requireElement("#average-count"),
  lastSample: requireElement("#last-sample"),
  sampleCount: requireElement("#sample-count"),
  rangeLabel: requireElement("#range-label"),
  sourceLabel: requireElement("#source-label"),
};

let allPoints: StatsPoint[] = [];
let currentRange: ChartRange = "7d";
let currentTimelineBucket: TimelineBucket = "raw";
let activeChart: ChartKind = "timeline";
let chart: ChartInstance | null = null;
let chartFactory: ChartFactory = (options, data, target) => new uPlot(options, data, target);
let historicalSource: HistoricalSource = { name: "Unknown", url: null };
let currentStatus: CurrentStatus = { kind: "loading", key: "status.loading", params: {} };
let pendingRender = false;
let resizeListenerAttached = false;

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`${selector} element is required`);
  return element;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function toHeatmapScore(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (v <= 0) return 0;

  const anchors: Array<[number, number]> = [
    [0, 0], [600, 12], [800, 24], [1000, 36], [1200, 50],
    [1400, 62], [1600, 70], [1800, 76], [2000, 82],
    [2200, 88], [2400, 94], [2600, 98], [3000, 100],
  ];

  for (let i = 1; i < anchors.length; i += 1) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (v <= x2) {
      const t = (v - x1) / (x2 - x1);
      return lerp(y1, y2, t);
    }
  }

  return 100;
}

function parseHexColor(color: string): [number, number, number] {
  const value = color.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function interpolateHeatmapColor(score: number | null): string {
  if (score == null || score <= HEATMAP_VISUAL_MIN) return HEATMAP_OUTOFRANGE_COLOR;
  if (score >= HEATMAP_VISUAL_MAX) return HEATMAP_COLORS[HEATMAP_COLORS.length - 1];
  const normalized = (score - HEATMAP_VISUAL_MIN) / (HEATMAP_VISUAL_MAX - HEATMAP_VISUAL_MIN);
  const scaled = normalized * (HEATMAP_COLORS.length - 1);
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(HEATMAP_COLORS.length - 1, lowerIndex + 1);
  const t = scaled - lowerIndex;
  const lower = parseHexColor(HEATMAP_COLORS[lowerIndex]);
  const upper = parseHexColor(HEATMAP_COLORS[upperIndex]);
  const [r, g, b] = lower.map((channel, index) => Math.round(lerp(channel, upper[index], t)));
  return `rgb(${r}, ${g}, ${b})`;
}

function getWindowLike(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function whenAppReady(): Promise<unknown[]> {
  const windowLike = getWindowLike();
  return Promise.all([windowLike?.MushmomI18n?.ready || Promise.resolve()]);
}

function getI18n(): MushmomI18nApi | null {
  return getWindowLike()?.MushmomI18n || null;
}

function tr(key: string, params: Record<string, string | number> = {}): string {
  const i18n = getI18n();
  if (!i18n) return key;
  return i18n.t(key, params, i18n.getCurrentLang());
}

function getCurrentLocale(): string | undefined {
  const getCurrentLang = getI18n()?.getCurrentLang;
  return typeof getCurrentLang === "function" ? getCurrentLang() : undefined;
}

function formatLocaleNumber(value: number): string {
  return Number(value).toLocaleString(getCurrentLocale());
}

function parseTimestamp(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return parseTimestamp(Number(value));
  }

  const normalized = String(value).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isKnownBadPoint(point: StatsPoint): boolean {
  const time = point.date?.getTime();
  return !Number.isFinite(time) || (time >= KNOWN_BAD_GAP_START && time < KNOWN_BAD_GAP_END) || point.count < 0;
}

function normalizePayload(payload: StatsPayload): StatsPoint[] {
  const rows: RawPayloadRow[] = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : Array.isArray(payload.values) ? payload.values : [];

  const normalized = rows
    .map((row): { timestamp: unknown; usercount: unknown } => {
      if (Array.isArray(row)) {
        return { timestamp: row[0], usercount: row[1] };
      }

      return {
        timestamp: row.timestamp ?? row.time ?? row.created_at ?? row.date,
        usercount: row.usercount ?? row.users ?? row.players ?? row.count,
      };
    })
    .map((row): { date: Date | null; count: number } => ({ date: parseTimestamp(row.timestamp), count: Number(row.usercount) }))
    .filter((point): point is StatsPoint => point.date instanceof Date && Number.isFinite(point.count))
    .filter((point) => !isKnownBadPoint(point))
    .map((point): StatsPoint => ({ date: truncateDateToSecond(point.date) as Date, count: point.count }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const byTimestamp = new Map<number, StatsPoint>();
  normalized.forEach((point) => byTimestamp.set(point.date.getTime(), point));
  return [...byTimestamp.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function truncateDateToSecond(date: Date | null): Date | null {
  return date ? new Date(Math.floor(date.getTime() / 1000) * 1000) : null;
}

function formatInteger(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString(getCurrentLocale()) : "--";
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function bucketDurationMs(config: { unit: BucketUnit; size: number }): number {
  const unitMs: Record<BucketUnit, number> = { hour: HOUR_MS, day: DAY_MS, week: WEEK_MS };
  return unitMs[config.unit] * config.size;
}

function formatShortDate(date: Date, includeYear = false): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), { month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}) }).format(date);
}

function formatTimelineAxisLabel(value: number, range: ChartRange = currentRange): string | number {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (range === "7d") {
    return `${formatShortDate(date)}\n${formatTime(date)}`;
  }
  return formatShortDate(date, ["1y", "3y", "all", "ytd"].includes(range));
}

function formatWeekdayLabels(): string[] {
  const formatter = new Intl.DateTimeFormat(getCurrentLocale(), { weekday: "short" });
  return Array.from({ length: 7 }, (_, dayOffset) => formatter.format(new Date(2026, 0, 4 + dayOffset, 12)));
}

function formatBucketRange(startMs: number, config: { unit: BucketUnit; size: number }): string {
  const start = new Date(startMs);
  const duration = bucketDurationMs(config);
  const exclusiveEndMs = duration > 0 ? startMs + duration : startMs;

  if (config.unit === "hour") {
    const end = new Date(Math.max(startMs, exclusiveEndMs - 60 * 1000));
    return `${formatDate(start)}<br />${formatTime(start)} - ${formatTime(end)}`;
  }

  const end = new Date(Math.max(startMs, exclusiveEndMs - 24 * 60 * 60 * 1000));
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return formatDate(start);
  const sameYear = start.getFullYear() === end.getFullYear();
  return sameYear ? `${formatShortDate(start)} - ${formatShortDate(end)}, ${end.getFullYear()}` : `${formatShortDate(start, true)} - ${formatShortDate(end, true)}`;
}

function setStatus(kind: CurrentStatus["kind"], key: string, params: Record<string, string | number> = {}): void {
  currentStatus = { kind, key, params };
  statusDot.classList.toggle("is-ready", kind === "ready");
  statusDot.classList.toggle("is-failed", kind === "failed");
  statusText.textContent = tr(key, params);
}

function refreshStatusText(): void {
  statusText.textContent = tr(currentStatus.key, currentStatus.params);
}

function lowerBoundPointIndex(points: StatsPoint[], minTime: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].date.getTime() < minTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function pointsForRange(points: StatsPoint[], range: ChartRange): StatsPoint[] {
  if (range === "all" || points.length === 0) return points;
  const latest = points[points.length - 1].date.getTime();

  if (range === "ytd") {
    const latestDate = points[points.length - 1].date;
    const yearStart = new Date(latestDate.getFullYear(), 0, 1).getTime();
    return points.slice(lowerBoundPointIndex(points, yearStart));
  }

  const windows: Record<Exclude<ChartRange, "all" | "ytd">, number> = {
    "24h": DAY_MS,
    "7d": 7 * DAY_MS,
    "28d": 28 * DAY_MS,
    "90d": 90 * DAY_MS,
    "180d": 180 * DAY_MS,
    "1y": 365 * DAY_MS,
    "3y": 3 * 365 * DAY_MS,
  };
  const windowMs = windows[range as Exclude<ChartRange, "all" | "ytd">] ?? windows["24h"];
  return points.slice(lowerBoundPointIndex(points, latest - windowMs));
}

function setSourceLabel(source: string, sourceUrl: string | null = null): void {
  elements.sourceLabel.textContent = "";
  if (!sourceUrl) {
    elements.sourceLabel.textContent = source;
    return;
  }
  const link = document.createElement("a");
  link.href = sourceUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = source;
  elements.sourceLabel.append(link);
}

function updateHistoricalMetrics(points: StatsPoint[], source: string, sourceUrl: string | null = null): void {
  const visible = pointsForRange(points, "24h");
  const latest = points[points.length - 1];
  const peak = visible.length > 0 ? Math.max(...visible.map((point) => point.count)) : Number.NaN;
  const avg = visible.length > 0 ? visible.reduce((total, point) => total + point.count, 0) / visible.length : Number.NaN;

  elements.peak.textContent = formatInteger(peak);
  elements.average.textContent = formatInteger(avg);
  elements.lastSample.textContent = latest ? formatTime(latest.date) : "--";
  elements.sampleCount.textContent = formatLocaleNumber(points.length);
  setSourceLabel(source, sourceUrl);
  elements.rangeLabel.textContent = points.length >= 2 ? `${formatDate(points[0].date)} - ${formatDate(points[points.length - 1].date)}` : latest ? formatDate(latest.date) : "--";
}

function clearHistoricalMetrics(source: string): void {
  elements.peak.textContent = "--";
  elements.average.textContent = "--";
  elements.lastSample.textContent = "--";
  elements.sampleCount.textContent = "0";
  elements.rangeLabel.textContent = "--";
  setSourceLabel(source);
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : Number.NaN;
}

function percentile(values: number[], percentileRank: number): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const index = (percentileRank / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return lerp(sorted[lower], sorted[upper], index - lower);
}

function getHeatmapVisualBounds(): { min: number; max: number } {
  return { min: HEATMAP_VISUAL_MIN, max: HEATMAP_VISUAL_MAX };
}

function getHeatmapPercentileRanks(visible: StatsPoint[]): number[] {
  if (visible.length < 2) return [];
  const spanMs = visible[visible.length - 1].date.getTime() - visible[0].date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (spanMs <= 7 * dayMs) return [];
  if (spanMs <= 45 * dayMs) return [50];
  return [90, 50, 10];
}

function buildDistributionBuckets(counts: number[]): DistributionBucket[] {
  const finiteCounts = counts.filter((value) => Number.isFinite(value));
  if (finiteCounts.length === 0) return [];
  const maxCount = finiteCounts.reduce((max, value) => Math.max(max, value), 0);
  const bucketCount = Math.max(1, Math.ceil((maxCount + 1) / DISTRIBUTION_STEP));
  const histogramBuckets = Array.from({ length: bucketCount }, (_, index) => ({ label: `${formatLocaleNumber(index * DISTRIBUTION_STEP)}-${formatLocaleNumber(Math.min(((index + 1) * DISTRIBUTION_STEP) - 1, maxCount))}`, count: 0 }));
  finiteCounts.forEach((count) => {
    const index = Math.min(Math.floor(count / DISTRIBUTION_STEP), histogramBuckets.length - 1);
    histogramBuckets[index].count += 1;
  });
  return histogramBuckets;
}

function heatmapSquarePaths(): uPlot.Series.Points.PathBuilder {
  return (self, seriesIdx, idx0, idx1, filtIdxs) => {
    const stroke = new Path2D();
    const clip = new Path2D();
    const heatmapPlot = self as HeatmapHoverPlot;
    const hover = heatmapPlot.__mushmomHeatmapHover;
    const colors = heatmapPlot.__mushmomHeatmapColors || new Map<string, string>();
    const xValues = self.data[0] as number[];
    const yValues = self.data[seriesIdx] as Array<number | null | undefined>;
    const fillByColor = new Map<string, Path2D>();
    const cellWidth = self.bbox.width / 24;
    const cellHeight = self.bbox.height / 7;
    const gap = 2;
    const width = Math.max(2, cellWidth - gap);
    const height = Math.max(2, cellHeight - gap);
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    clip.rect(self.bbox.left, self.bbox.top, self.bbox.width, self.bbox.height);

    const drawSquare = (index: number) => {
      const yValue = yValues[index];
      if (yValue == null) return;
      const xValue = xValues[index];
      const centerX = self.valToPos(xValues[index], "x", true);
      const centerY = self.valToPos(yValue, "y", true);
      const isHovered = hover?.hour === xValue && hover.day === yValue;
      const color = colors.get(`${yValue}-${xValue}`) || HEATMAP_OUTOFRANGE_COLOR;
      const fill = fillByColor.get(color) || new Path2D();
      fill.rect(centerX - halfWidth, centerY - halfHeight, width, height);
      fillByColor.set(color, fill);
      if (isHovered) stroke.rect(centerX - halfWidth, centerY - halfHeight, width, height);
    };

    if (filtIdxs) {
      filtIdxs.forEach(drawSquare);
    } else {
      for (let index = idx0; index <= idx1; index += 1) drawSquare(index);
    }

    return { fill: fillByColor, stroke, clip, flags: 3 } as unknown as uPlot.Series.Points.Paths;
  };
}

function formatHeatmapTooltip(value: HeatmapValue, weekdayLabels: string[]): string {
  const [hour, day, , count, percentiles, samples] = value;
  const rows = [
    `<strong>${weekdayLabels[day]} ${hour}:00</strong>`,
    `${tr("chart.tooltip.avg")}: ${formatInteger(count)}`,
  ];
  Object.entries(percentiles || {}).forEach(([label, percentileValue]) => {
    rows.push(`${label}: ${formatInteger(percentileValue)}`);
  });
  rows.push(tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(samples) }));
  return rows.join("<br />");
}

function heatmapTooltipPlugin(values: HeatmapValue[], weekdayLabels: string[]): uPlot.Plugin {
  const valuesByCell = new Map(values.map((value) => [`${value[1]}-${value[0]}`, value]));
  const colorsByCell = new Map(values.map((value) => [`${value[1]}-${value[0]}`, interpolateHeatmapColor(value[2])]));
  let tooltip: HTMLDivElement | null = null;
  let hoveredCell: string | null = null;

  const setHoveredCell = (self: HeatmapHoverPlot, hour: number | null, day: number | null) => {
    const nextCell = hour == null || day == null ? null : `${day}-${hour}`;
    if (nextCell === hoveredCell) return;
    hoveredCell = nextCell;
    self.__mushmomHeatmapHover = hour == null || day == null ? null : { hour, day };
    self.redraw(true, false);
  };

  return {
    hooks: {
      ready: [
        (self) => {
          (self as HeatmapHoverPlot).__mushmomHeatmapColors = colorsByCell;
          tooltip = document.createElement("div");
          tooltip.className = "chart-tooltip";
          tooltip.hidden = true;
          self.over.append(tooltip);
        },
      ],
      setCursor: [
        (self) => {
          if (!tooltip || self.cursor.left == null || self.cursor.top == null) {
            if (tooltip) tooltip.hidden = true;
            return;
          }

          const hour = Math.round(self.posToVal(self.cursor.left, "x"));
          const day = Math.round(self.posToVal(self.cursor.top, "y"));
          const value = valuesByCell.get(`${day}-${hour}`);
          if (!value || hour < 0 || hour > 23 || day < 0 || day > 6) {
            tooltip.hidden = true;
            setHoveredCell(self as HeatmapHoverPlot, null, null);
            return;
          }

          setHoveredCell(self as HeatmapHoverPlot, hour, day);

          tooltip.innerHTML = formatHeatmapTooltip(value, weekdayLabels);
          tooltip.hidden = false;
          const left = Math.min(self.over.clientWidth - tooltip.offsetWidth - 10, self.cursor.left + 14);
          const top = Math.min(self.over.clientHeight - tooltip.offsetHeight - 10, self.cursor.top + 14);
          tooltip.style.left = `${Math.max(10, left)}px`;
          tooltip.style.top = `${Math.max(10, top)}px`;
        },
      ],
      destroy: [
        () => {
          tooltip?.remove();
          tooltip = null;
        },
      ],
    },
  };
}

function formatPercentage(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (value >= 10) return `${value.toFixed(0)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

const TIMELINE_RANGE_CONFIG: Record<Exclude<ChartRange, "24h" | "ytd">, TimelineConfig> = {
  "7d": { labelKey: "chart.series.players" },
  "28d": { labelKey: "chart.series.players" },
  "90d": { labelKey: "chart.series.players" },
  "180d": { labelKey: "chart.series.players" },
  "1y": { labelKey: "chart.series.players" },
  "3y": { labelKey: "chart.series.players" },
  all: { labelKey: "chart.series.players" },
};

function getSeriesLabel(config: TimelineConfig): string {
  return tr(config.labelKey);
}

const RANGE_WINDOW_MS: Record<Exclude<ChartRange, "all" | "ytd">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "28d": 28 * DAY_MS,
  "90d": 90 * DAY_MS,
  "180d": 180 * DAY_MS,
  "1y": 365 * DAY_MS,
  "3y": 3 * 365 * DAY_MS,
};

const TIMELINE_BUCKET_CONFIG: Record<Exclude<TimelineBucket, "raw">, { unit: BucketUnit; size: number; labelKey: string }> = {
  "8h": { unit: "hour", size: 8, labelKey: "bucket.8h" },
  "1d": { unit: "day", size: 1, labelKey: "bucket.1d" },
  "1w": { unit: "week", size: 1, labelKey: "bucket.1w" },
};

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfLocalWeek(date: Date): number {
  const dayStart = startOfLocalDay(date);
  const day = new Date(dayStart).getDay();
  return dayStart - day * DAY_MS;
}

function bucketStart(timestamp: number, config: { unit: BucketUnit; size: number }): number {
  const date = new Date(timestamp);
  if (config.unit === "hour") {
    const dayStart = startOfLocalDay(date);
    const hour = date.getHours();
    return dayStart + Math.floor(hour / config.size) * config.size * 60 * 60 * 1000;
  }
  if (config.unit === "day") {
    const dayStart = startOfLocalDay(date);
    const epochDay = Math.floor(dayStart / DAY_MS);
    const bucketDay = Math.floor(epochDay / config.size) * config.size;
    return bucketDay * DAY_MS;
  }
  const weekStart = startOfLocalWeek(date);
  if (config.size <= 1) return weekStart;
  const anchor = startOfLocalWeek(new Date(0));
  const weekIndex = Math.floor((weekStart - anchor) / WEEK_MS);
  return anchor + Math.floor(weekIndex / config.size) * config.size * WEEK_MS;
}

function buildBucketSummaries(points: StatsPoint[], config: { unit: BucketUnit; size: number }): BucketSummary[] {
  const buckets = new Map<number, BucketAccumulator>();
  points.forEach((point) => {
    const bucket = bucketStart(point.date.getTime(), config);
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        min: point.count,
        max: point.count,
        avg: point.count,
        samples: 1,
        total: point.count,
      });
      return;
    }
    existing.min = Math.min(existing.min, point.count);
    existing.max = Math.max(existing.max, point.count);
    existing.samples += 1;
    existing.total += point.count;
    existing.avg = existing.total / existing.samples;
  });
  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map(({ total, ...bucket }) => bucket);
}

function getTimelineConfig(range: ChartRange, visible: StatsPoint[]): TimelineConfig {
  if (range !== "ytd") {
    if (range === "24h") return TIMELINE_RANGE_CONFIG["7d"];
    return TIMELINE_RANGE_CONFIG[range as Exclude<ChartRange, "24h" | "ytd">] || TIMELINE_RANGE_CONFIG["7d"];
  }
  if (visible.length === 0) return TIMELINE_RANGE_CONFIG["7d"];
  const latest = visible[visible.length - 1].date;
  const yearStart = new Date(latest.getFullYear(), 0, 1).getTime();
  const spanMs = latest.getTime() - yearStart;
  // if (spanMs <= RANGE_WINDOW_MS["7d"]) return TIMELINE_RANGE_CONFIG["7d"];
  // if (spanMs <= RANGE_WINDOW_MS["28d"]) return TIMELINE_RANGE_CONFIG["28d"];
  // if (spanMs <= RANGE_WINDOW_MS["90d"]) return TIMELINE_RANGE_CONFIG["90d"];
  // if (spanMs <= RANGE_WINDOW_MS["180d"]) return TIMELINE_RANGE_CONFIG["180d"];
  if (spanMs <= RANGE_WINDOW_MS["7d"]) return TIMELINE_RANGE_CONFIG["7d"];
  if (spanMs <= RANGE_WINDOW_MS["28d"]) return TIMELINE_RANGE_CONFIG["28d"];
  if (spanMs <= RANGE_WINDOW_MS["90d"]) return TIMELINE_RANGE_CONFIG["90d"];
  if (spanMs <= RANGE_WINDOW_MS["180d"]) return TIMELINE_RANGE_CONFIG["180d"];
  return TIMELINE_RANGE_CONFIG["1y"];
}

function getChartSize(): { width: number; height: number } {
  return {
    width: Math.max(320, chartElement.clientWidth || 840),
    height: Math.max(260, chartElement.clientHeight || 470),
  };
}

function axisStroke(): string {
  return "#a9b1ad";
}

function gridStroke(): string {
  return "rgba(169, 177, 173, 0.14)";
}

function buildBaseOptions(kind: ChartKind): uPlot.Options {
  const { width, height } = getChartSize();
  return {
    width,
    height,
    class: `mushmom-uplot-${kind}`,
    legend: { show: true, live: true },
    cursor: { drag: { x: true, y: false } },
    padding: [18, 18, 10, 8],
    series: [{}],
    axes: [
      { stroke: axisStroke(), grid: { show: false }, ticks: { stroke: "#35403e" } },
      { stroke: axisStroke(), grid: { stroke: gridStroke() }, ticks: { stroke: "#35403e" } },
    ],
  };
}

function buildEmptyChart(kind: ChartKind): ChartBuild {
  const options = buildBaseOptions(kind);
  options.title = tr("ui.noLiveData");
  options.scales = kind === "timeline" ? { x: { time: true }, y: { range: [0, 1] } } : { x: { time: false }, y: { range: [0, 1] } };
  options.series = [{}, { label: tr("ui.noLiveData"), stroke: "#7dd87d", width: 0, points: { show: false } }];
  return { kind, options, data: [[0], [null]], empty: true };
}

function timelineViewportBounds(points: StatsPoint[], range: ChartRange): { min: number; max: number } | null {
  if (points.length === 0) return null;
  const first = points[0].date.getTime();
  const latestPoint = points[points.length - 1];
  const latest = latestPoint.date.getTime();

  if (range === "all") return { min: first, max: latest };
  if (range === "ytd") {
    return { min: new Date(latestPoint.date.getFullYear(), 0, 1).getTime(), max: latest };
  }

  const windowMs = RANGE_WINDOW_MS[range as Exclude<ChartRange, "all" | "ytd">] ?? RANGE_WINDOW_MS["7d"];
  return { min: latest - windowMs, max: latest };
}

function timelineBucketsForMode(points: StatsPoint[], bucket: TimelineBucket): BucketSummary[] {
  if (bucket === "raw") return [];
  const config = TIMELINE_BUCKET_CONFIG[bucket];
  return buildBucketSummaries(points, config);
}

function timelineScaleSource(points: StatsPoint[], bucket: TimelineBucket = currentTimelineBucket): TimelineScaleSource {
  if (bucket === "raw") {
    const values = points.map((point) => point.count);
    return {
      xValues: points.map((point) => point.date.getTime()),
      lowValues: values,
      highValues: values,
    };
  }

  const buckets = timelineBucketsForMode(points, bucket);
  return {
    xValues: buckets.map((item) => item.time),
    lowValues: buckets.map((item) => item.min),
    highValues: buckets.map((item) => item.max),
  };
}

function timelineYBoundsForViewport(points: StatsPoint[], viewport: { min: number; max: number } | null, bucket: TimelineBucket = currentTimelineBucket): { min: number; max: number } {
  const source = timelineScaleSource(points, bucket);
  const indexes = source.xValues
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => !viewport || (value >= viewport.min && value <= viewport.max))
    .map(({ index }) => index);
  const sourceIndexes = indexes.length > 0 ? indexes : source.xValues.map((_, index) => index);
  const valueMax = sourceIndexes.length > 0 ? Math.max(...sourceIndexes.map((index) => source.highValues[index])) : 1;
  return { min: 0, max: Math.max(1, Math.ceil(valueMax * 1.04)) };
}

function expandedTimelineRange(currentMin: number | null | undefined, currentMax: number | null | undefined, xValues: number[]): { min: number; max: number } | null {
  if (xValues.length < 2) return null;
  const totalMin = xValues[0];
  const totalMax = xValues[xValues.length - 1];
  const totalSpan = totalMax - totalMin;
  if (!Number.isFinite(totalMin) || !Number.isFinite(totalMax) || totalSpan <= 0) return null;

  if (!Number.isFinite(currentMin) || !Number.isFinite(currentMax)) {
    return { min: totalMin, max: totalMax };
  }

  const minCurrent = currentMin as number;
  const maxCurrent = currentMax as number;
  const currentSpan = maxCurrent - minCurrent;
  if (currentSpan <= 0 || currentSpan >= totalSpan) {
    return { min: totalMin, max: totalMax };
  }

  const targetSpan = Math.min(currentSpan * 2, totalSpan);
  const center = (minCurrent + maxCurrent) / 2;
  let min = center - targetSpan / 2;
  let max = center + targetSpan / 2;

  if (min < totalMin) {
    max = Math.min(totalMax, max + (totalMin - min));
    min = totalMin;
  }
  if (max > totalMax) {
    min = Math.max(totalMin, min - (max - totalMax));
    max = totalMax;
  }

  return { min, max };
}

function applyTimelineViewport(plot: Pick<uPlot, "setScale">, points: StatsPoint[], viewport: { min: number; max: number } | null, bucket: TimelineBucket = currentTimelineBucket): void {
  if (!viewport) return;
  plot.setScale("x", viewport);
  plot.setScale("y", timelineYBoundsForViewport(points, viewport, bucket));
}

function handleTimelineDblClick(self: uPlot, points: StatsPoint[], bucket: TimelineBucket): void {
  const source = timelineScaleSource(points, bucket);
  const range = expandedTimelineRange(self.scales.x.min, self.scales.x.max, source.xValues);
  applyTimelineViewport(self, points, range, bucket);
}

function buildTimelineOptions(points: StatsPoint[]): ChartBuild {
  const visible = pointsForRange(points, currentRange);
  const config = getTimelineConfig(currentRange, visible);

  if (points.length === 0) {
    return buildEmptyChart("timeline");
  }

  const bucket = currentTimelineBucket;
  const buckets = timelineBucketsForMode(points, bucket);
  const bucketConfig = bucket === "raw" ? null : TIMELINE_BUCKET_CONFIG[bucket];
  const scaleSource = timelineScaleSource(points, bucket);
  const viewport = timelineViewportBounds(points, currentRange);
  const yBounds = timelineYBoundsForViewport(points, viewport, bucket);
  const seriesLabel = bucketConfig ? tr("chart.series.averagePlayersBucket", { bucket: tr(bucketConfig.labelKey) }) : getSeriesLabel(config);
  const options = buildBaseOptions("timeline");
  options.cursor = {
    ...options.cursor,
    bind: {
      ...options.cursor?.bind,
      dblclick: (self) => (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleTimelineDblClick(self, points, bucket);
        return null;
      },
    },
  };
  options.ms = 1;
  options.scales = {
    x: { time: true, ...(viewport || {}) },
    y: { range: [yBounds.min, yBounds.max] },
  };
  options.axes = [
    {
      stroke: axisStroke(),
      grid: { show: false },
      ticks: { stroke: "#35403e" },
      values: (_self, splits) => splits.map((value) => String(formatTimelineAxisLabel(value, currentRange))),
    },
    {
      stroke: axisStroke(),
      grid: { stroke: gridStroke() },
      ticks: { stroke: "#35403e" },
      values: (_self, splits) => splits.map((value) => formatInteger(value)),
    },
  ];

  if (bucketConfig) {
    options.series = [
      {},
      { label: tr("chart.tooltip.peak"), stroke: "rgba(241, 196, 79, 0.64)", width: 1, points: { show: false } },
      { label: tr("chart.tooltip.trough"), stroke: "rgba(169, 177, 173, 0.74)", width: 1, points: { show: false } },
      {
        label: seriesLabel,
        stroke: "#7dd87d",
        width: 3,
        points: { show: buckets.length < 80, size: 7, fill: "#f1c44f", stroke: "#35403e" },
      },
    ];
    options.bands = [{ series: [1, 2], fill: "rgba(125, 216, 125, 0.24)" }];
    return {
      kind: "timeline",
      options,
      data: [
        scaleSource.xValues,
        buckets.map((item) => item.max),
        buckets.map((item) => item.min),
        buckets.map((item) => Math.round(item.avg)),
      ],
      empty: false,
      timelineBuckets: buckets,
    };
  }

  const values = points.map((point) => point.count);
  options.series = [
    {},
    {
      label: seriesLabel,
      stroke: "#7dd87d",
      fill: "rgba(125, 216, 125, 0.16)",
      width: 3,
      points: { show: visible.length < 80, size: 7, fill: "#f1c44f", stroke: "#35403e" },
    },
  ];
  return {
    kind: "timeline",
    options,
    data: [scaleSource.xValues, values],
    empty: false,
  };
}

function applyCurrentTimelineViewport(): boolean {
  if (activeChart !== "timeline" || !chart?.setScale || allPoints.length === 0) return false;
  applyTimelineViewport(chart as unknown as Pick<uPlot, "setScale">, allPoints, timelineViewportBounds(allPoints, currentRange), currentTimelineBucket);
  return true;
}

function buildHeatmapOptions(points: StatsPoint[]): ChartBuild {
  const visible = pointsForRange(points, currentRange);
  const weekdayLabels = formatWeekdayLabels();
  const percentileRanks = getHeatmapPercentileRanks(visible);
  const buckets = new Map<string, number[]>();
  visible.forEach((point) => {
    const key = `${point.date.getDay()}-${point.date.getHours()}`;
    const bucket = buckets.get(key) || [];
    bucket.push(point.count);
    buckets.set(key, bucket);
  });
  const values: HeatmapValue[] = [];
  buckets.forEach((bucket, key) => {
    const [day, hour] = key.split("-").map(Number);
    const averageCount = Math.round(average(bucket));
    const percentiles = Object.fromEntries(percentileRanks.map((rank) => [`p${rank}`, Math.round(percentile(bucket, rank))]));
    values.push([hour, day, toHeatmapScore(averageCount), averageCount, percentiles, bucket.length]);
  });
  if (values.length === 0) return buildEmptyChart("heatmap");

  const hasCell = new Set(values.map(([hour, day]) => `${day}-${hour}`));
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const options = buildBaseOptions("heatmap");
  options.legend = { show: false };
  options.cursor = { ...options.cursor, points: { show: false } };
  options.scales = { x: { time: false, range: [-0.5, 23.5] }, y: { range: [-0.5, 6.5], dir: -1 } };
  options.plugins = [heatmapTooltipPlugin(values, weekdayLabels)];
  options.axes = [
    {
      stroke: axisStroke(),
      grid: { stroke: "rgba(255,255,255,0.04)" },
      ticks: { stroke: "#35403e" },
      splits: () => hours.filter((hour) => hour % 3 === 0),
      values: (_self, splits) => splits.map((hour) => `${hour}:00`),
    },
    {
      stroke: axisStroke(),
      grid: { stroke: gridStroke() },
      ticks: { stroke: "#35403e" },
      splits: () => weekdayLabels.map((_, day) => day),
      values: (_self, splits) => splits.map((day) => weekdayLabels[day] ?? ""),
    },
  ];
  options.series = [
    {},
    ...weekdayLabels.map((label): uPlot.Series => ({
      label,
      stroke: "#f4f1e8",
      width: 0,
      points: {
        show: true,
        paths: heatmapSquarePaths(),
        width: 2,
        fill: HEATMAP_COLORS[0],
      },
    })),
  ];
  const data: uPlot.AlignedData = [
    hours,
    ...weekdayLabels.map((_, day) => (
      hours.map((hour) => hasCell.has(`${day}-${hour}`) ? day : null)
    )),
  ];
  return { kind: "heatmap", options, data, empty: false, heatmapValues: values };
}

function buildDistributionOptions(points: StatsPoint[]): ChartBuild {
  const visible = pointsForRange(points, currentRange);
  const counts = visible.map((point) => point.count);
  const buckets = buildDistributionBuckets(counts);
  if (buckets.length === 0) return buildEmptyChart("distribution");

  const totalSamples = counts.length || 1;
  const percentageData = buckets.map((bucket) => (bucket.count / totalSamples) * 100);
  const indexes = buckets.map((_, index) => index);
  const options = buildBaseOptions("distribution");
  options.scales = {
    x: { time: false, range: [-0.5, Math.max(0.5, buckets.length - 0.5)] },
    y: { range: [0, Math.max(1, Math.ceil(Math.max(...percentageData) * 1.1))] },
  };
  options.axes = [
    {
      stroke: axisStroke(),
      grid: { show: false },
      ticks: { stroke: "#35403e" },
      splits: () => indexes,
      values: (_self, splits) => splits.map((index) => buckets[index]?.label ?? ""),
      rotate: 35,
      size: 82,
    },
    {
      stroke: axisStroke(),
      grid: { stroke: gridStroke() },
      ticks: { stroke: "#35403e" },
      values: (_self, splits) => splits.map((value) => formatPercentage(value)),
    },
  ];
  options.series = [
    {},
    {
      label: tr("chart.series.samplesPercent"),
      stroke: "#35403e",
      fill: DISTRIBUTION_BAR_COLOR,
      width: 1,
      paths: uPlot.paths.bars?.({ size: [0.72, 38], radius: [4, 0], gap: 2 }),
      points: { show: false },
    },
  ];
  return { kind: "distribution", options, data: [indexes, percentageData], empty: false, distributionBuckets: buckets };
}

function buildChartOptions(points: StatsPoint[]): ChartBuild {
  if (activeChart === "heatmap") return buildHeatmapOptions(points);
  if (activeChart === "distribution") return buildDistributionOptions(points);
  return buildTimelineOptions(points);
}

function renderChart(): void {
  if (!resizeListenerAttached) {
    window.addEventListener("resize", () => {
      if (chart) chart.setSize(getChartSize());
    });
    resizeListenerAttached = true;
  }
  const built = buildChartOptions(allPoints);
  chart?.destroy();
  chartElement.replaceChildren();
  chartElement.classList.toggle("is-empty", built.empty);
  chart = chartFactory(built.options, built.data, chartElement);
  if (built.kind === "heatmap") {
    const currentChart = chart;
    requestAnimationFrame(() => currentChart.redraw?.(true, true));
  }
}

function renderChartError(error: unknown): void {
  console.warn(error);
  chart?.destroy();
  chart = null;
  chartElement.replaceChildren();
  chartElement.classList.add("is-empty");
  chartElement.textContent = error instanceof Error ? error.message : tr("ui.noLiveData");
}

function render(): void {
  if (pendingRender) return;
  pendingRender = true;
  whenAppReady()
    .then(() => {
      pendingRender = false;
      renderChart();
    })
    .catch((error: unknown) => {
      pendingRender = false;
      renderChartError(error);
    });
}

function mergePoints(...groups: StatsPoint[][]): StatsPoint[] {
  const pointsByTime = new Map<number, StatsPoint>();
  groups.flat().forEach((point) => {
    const time = point.date.getTime();
    if (!pointsByTime.has(time)) pointsByTime.set(time, point);
  });
  return [...pointsByTime.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function fetchHistoricalStats(): Promise<void> {
  const loader = window.MushmomStatsLoader;
  if (!loader) throw new Error(tr("error.statsLoaderUnavailable"));
  const initial = await loader.loadInitialStatsHistory<StatsPoint>({
    normalizePayload,
    onInitial: ({ points, recentPayload }) => {
      allPoints = mergePoints([], points);
      historicalSource = { name: (recentPayload as HistoricalSourcePayload).source || "R2", url: (recentPayload as HistoricalSourcePayload).sourceUrl || null };
      updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
      render();
    },
  });

  await loader.loadArchiveStatsHistory<StatsPoint>({
    recentPayload: initial.recentPayload,
    manifest: initial.manifest,
    normalizePayload,
    onArchive: ({ points }) => {
      if (points.length === 0) return;
      allPoints = mergePoints(points, allPoints);
      updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
      render();
    },
  });
}

async function fetchCurrentUserCount(): Promise<void> {
  const response = await fetch("/api/current", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(tr("error.currentUserRequestFailed", { status: response.status }));
  const payload = await response.json() as { usercount?: unknown };
  const usercount = Number(payload.usercount);
  if (!Number.isFinite(usercount)) throw new Error(tr("error.currentUserMissingCount"));
  elements.current.textContent = formatInteger(usercount);
}

async function loadStats(): Promise<void> {
  const hadHistoricalData = allPoints.length > 0;
  setStatus("loading", "status.loading");
  const [statsResult, currentResult] = await Promise.allSettled([fetchHistoricalStats(), fetchCurrentUserCount()]);
  if (statsResult.status === "fulfilled") {
    setStatus("ready", "status.ready");
  } else {
    console.warn(statsResult.reason);
    if (!hadHistoricalData) {
      allPoints = [];
      clearHistoricalMetrics(tr("source.unavailable"));
    }
    setStatus("failed", "status.failed");
  }
  if (currentResult.status === "rejected") {
    console.warn(currentResult.reason);
    if (elements.current.textContent === "") elements.current.textContent = "--";
  }
  render();
}

rangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentRange = (button.dataset.range as ChartRange) || "7d";
    rangeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    if (!applyCurrentTimelineViewport()) render();
  });
});

function updateBucketButtonState(): void {
  bucketButtons.forEach((button) => {
    button.disabled = activeChart !== "timeline";
  });
}

bucketButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentTimelineBucket = (button.dataset.bucket as TimelineBucket) || "raw";
    bucketButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    if (activeChart === "timeline") render();
  });
});

chartButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeChart = (button.dataset.chart as ChartKind) || "timeline";
    chartButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    updateBucketButtonState();
    render();
  });
});

updateBucketButtonState();

window.addEventListener("mushmom:languagechange", () => {
  refreshStatusText();
  if (allPoints.length > 0) {
    updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
  } else if (currentStatus.kind === "failed") {
    clearHistoricalMetrics(tr("source.unavailable"));
  }
  render();
});

function initApp(): void {
  loadStats();
}

const testApi = {
  normalizePayload,
  isKnownBadPoint,
  formatTime,
  formatTimelineAxisLabel,
  formatWeekdayLabels,
  formatBucketRange,
  getHeatmapVisualBounds,
  getHeatmapPercentileRanks,
  pointsForRange,
  timelineViewportBounds,
  timelineBucketsForMode,
  timelineScaleSource,
  timelineYBoundsForViewport,
  expandedTimelineRange,
  applyTimelineViewport,
  buildDistributionBuckets,
  buildBucketSummaries,
  buildTimelineOptions,
  buildHeatmapOptions,
  buildDistributionOptions,
  setCurrentRangeForTest: (range: ChartRange) => { currentRange = range; },
  setCurrentTimelineBucketForTest: (bucket: TimelineBucket) => { currentTimelineBucket = bucket; },
  setActiveChartForTest: (chartName: ChartKind) => { activeChart = chartName; },
  setChartFactoryForTest: (factory: ChartFactory) => { chartFactory = factory; },
};

globalThis.__MUSHMOM_TEST__ = testApi;

export { initApp, normalizePayload, isKnownBadPoint, formatTime, formatTimelineAxisLabel, formatWeekdayLabels, formatBucketRange, getHeatmapVisualBounds, getHeatmapPercentileRanks, pointsForRange, timelineViewportBounds, timelineBucketsForMode, timelineScaleSource, timelineYBoundsForViewport, expandedTimelineRange, applyTimelineViewport, buildDistributionBuckets, buildBucketSummaries, buildTimelineOptions, buildHeatmapOptions, buildDistributionOptions, testApi };
