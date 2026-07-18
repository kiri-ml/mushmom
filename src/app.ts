/// <reference path="./globals.d.ts" />

type ChartRange = "24h" | "7d" | "28d" | "90d" | "180d" | "ytd" | "1y" | "3y" | "all";
type ChartKind = "timeline" | "heatmap" | "distribution";
type ChartMetric = "players" | "uniqueIp";
type BucketUnit = "hour" | "day" | "week";

type MetricElementKey = "current" | "currentUnique" | "peak" | "peakUnique" | "average" | "averageUnique" | "lastSample" | "sampleCount" | "rangeLabel" | "sourceLabel";

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
  bucketKey?: string;
  unit?: BucketUnit;
  size?: number;
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

const chartElement = requireElement("#population-chart");
const rangeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-range]"));
const chartButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-chart]"));
const metricButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-metric]"));
const metricToggle = requireElement("#metric-toggle");
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
const UNIQUE_COLOR = "#55b6e8";
const UNIQUE_RANGE_COLOR = "rgba(85, 182, 232, 0.18)";
const DISTRIBUTION_STEP = 100;
const KNOWN_BAD_GAP_START = Date.parse("2020-06-15T15:30:55.664Z");
const KNOWN_BAD_GAP_END = Date.parse("2020-06-22T01:00:00.528Z");

const elements: Record<MetricElementKey, HTMLElement> = {
  current: requireElement("#current-count"),
  currentUnique: requireElement("#current-unique-count"),
  peak: requireElement("#peak-count"),
  peakUnique: requireElement("#peak-unique-count"),
  average: requireElement("#average-count"),
  averageUnique: requireElement("#average-unique-count"),
  lastSample: requireElement("#last-sample"),
  sampleCount: requireElement("#sample-count"),
  rangeLabel: requireElement("#range-label"),
  sourceLabel: requireElement("#source-label"),
};

let allPoints: StatsPoint[] = [];
let currentRange: ChartRange = "7d";
let activeChart: ChartKind = "timeline";
let activeMetric: ChartMetric = "players";
let chart: EChartsInstance | null = null;
let historicalSource: HistoricalSource = { name: "Unknown", url: null };
let currentStatus: CurrentStatus = { kind: "loading", key: "status.loading", params: {} };
let pendingRender = false;

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

function getWindowLike(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function whenAppReady(): Promise<unknown[]> {
  const windowLike = getWindowLike();
  return Promise.all([globalThis.__mushmomEchartsReady || Promise.resolve(), windowLike?.MushmomI18n?.ready || Promise.resolve()]);
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
    .map((row): { timestamp: unknown; usercount: unknown; uniquecount: unknown } => {
      if (Array.isArray(row)) {
        return { timestamp: row[0], usercount: row[1], uniquecount: row[2] };
      }

      return {
        timestamp: row.timestamp ?? row.time ?? row.created_at ?? row.date,
        usercount: row.usercount ?? row.users ?? row.players ?? row.count,
        uniquecount: row.uniquecount,
      };
    })
    .map((row): { date: Date | null; count: number; uniqueCount: number | null } => {
      const uniqueCount = row.uniquecount == null ? Number.NaN : Number(row.uniquecount);
      return {
        date: parseTimestamp(row.timestamp),
        count: Number(row.usercount),
        uniqueCount: Number.isFinite(uniqueCount) && uniqueCount >= 0 ? uniqueCount : null,
      };
    })
    .filter((point): point is { date: Date; count: number; uniqueCount: number | null } => point.date instanceof Date && Number.isFinite(point.count))
    .filter((point) => !isKnownBadPoint(point))
    .map((point): StatsPoint => ({ date: truncateDateToSecond(point.date) as Date, count: point.count, uniqueCount: point.uniqueCount }))
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

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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

function pointsForRange(points: StatsPoint[], range: ChartRange): StatsPoint[] {
  if (range === "all" || points.length === 0) return points;
  const latest = points[points.length - 1].date.getTime();

  if (range === "ytd") {
    const latestDate = points[points.length - 1].date;
    const yearStart = new Date(latestDate.getFullYear(), 0, 1).getTime();
    return points.filter((point) => point.date.getTime() >= yearStart);
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
  return points.filter((point) => latest - point.date.getTime() <= windowMs);
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
  const uniqueSummary = summarizeUniqueCounts(visible);

  elements.peak.textContent = formatInteger(peak);
  elements.peakUnique.textContent = formatInteger(uniqueSummary.peak);
  elements.average.textContent = formatInteger(avg);
  elements.averageUnique.textContent = formatInteger(uniqueSummary.average);
  elements.lastSample.textContent = latest ? formatTime(latest.date) : "--";
  elements.sampleCount.textContent = formatLocaleNumber(points.length);
  setSourceLabel(source, sourceUrl);
  elements.rangeLabel.textContent = points.length >= 2 ? `${formatDate(points[0].date)} - ${formatDate(points[points.length - 1].date)}` : latest ? formatDate(latest.date) : "--";
}

function clearHistoricalMetrics(source: string): void {
  elements.peak.textContent = "--";
  elements.peakUnique.textContent = "--";
  elements.average.textContent = "--";
  elements.averageUnique.textContent = "--";
  elements.lastSample.textContent = "--";
  elements.sampleCount.textContent = "0";
  elements.rangeLabel.textContent = "--";
  setSourceLabel(source);
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : Number.NaN;
}

function summarizeUniqueCounts(points: StatsPoint[]): { peak: number; average: number } {
  const counts = points
    .map((point) => point.uniqueCount)
    .filter((count): count is number => typeof count === "number" && Number.isFinite(count));
  return {
    peak: counts.length > 0 ? Math.max(...counts) : Number.NaN,
    average: average(counts),
  };
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

function formatPercentage(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (value >= 10) return `${value.toFixed(0)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

const TIMELINE_RANGE_CONFIG: Record<Exclude<ChartRange, "24h" | "ytd">, TimelineConfig> = {
  "7d": { labelKey: "chart.series.players" },
  "28d": { labelKey: "chart.series.averagePlayersBucket", bucketKey: "bucket.4h", unit: "hour", size: 4 },
  "90d": { labelKey: "chart.series.averagePlayersBucket", bucketKey: "bucket.12h", unit: "hour", size: 12 },
  "180d": { labelKey: "chart.series.averagePlayersBucket", bucketKey: "bucket.1d", unit: "day", size: 1 },
  "1y": { labelKey: "chart.series.averagePlayersBucket", bucketKey: "bucket.48h", unit: "day", size: 2 },
  "3y": { labelKey: "chart.series.averagePlayersBucket", bucketKey: "bucket.1w", unit: "week", size: 1 },
  all: { labelKey: "chart.series.averagePlayersBucket", bucketKey: "bucket.1w", unit: "week", size: 1 },
};

function getSeriesLabel(config: TimelineConfig): string {
  return config.bucketKey ? tr(config.labelKey, { bucket: tr(config.bucketKey) }) : tr(config.labelKey);
}

function getUniqueSeriesLabel(config: TimelineConfig): string {
  return config.bucketKey
    ? tr("chart.series.averageUniqueIpBucket", { bucket: tr(config.bucketKey) })
    : tr("metric.uniqueIp");
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

function buildBucketSummaries(
  points: StatsPoint[],
  config: { unit: BucketUnit; size: number },
  valueSelector: (point: StatsPoint) => number | null | undefined = (point) => point.count,
): BucketSummary[] {
  const buckets = new Map<number, BucketAccumulator>();
  points.forEach((point) => {
    const value = valueSelector(point);
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const bucket = bucketStart(point.date.getTime(), config);
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        min: value,
        max: value,
        avg: value,
        samples: 1,
        total: value,
      });
      return;
    }
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    existing.samples += 1;
    existing.total += value;
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

function emptyGraphic(text = tr("ui.noLiveData")) {
  return { type: "text", left: "center", top: "middle", style: { text, fill: "#a9b1ad", font: "700 16px Inter, sans-serif" } };
}

function baseAxisOption() {
  return { animationDuration: 450, backgroundColor: "transparent", tooltip: { trigger: "axis", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, valueFormatter: (value: number | string) => Number.isFinite(Number(value)) ? formatLocaleNumber(Number(value)) : value } };
}

function buildTimelineOptions(points: StatsPoint[]) {
  const visible = pointsForRange(points, currentRange);
  const config = getTimelineConfig(currentRange, visible);
  const playerValues = visible.map((point) => [point.date.getTime(), point.count]);
  const uniqueSampleCount = visible.filter((point) => typeof point.uniqueCount === "number" && Number.isFinite(point.uniqueCount)).length;
  const uniqueValues = visible.map((point) => [
    point.date.getTime(),
    typeof point.uniqueCount === "number" && Number.isFinite(point.uniqueCount) ? point.uniqueCount : null,
  ]);
  const bucketed = config.unit != null && config.size != null;
  const bucketConfig = { unit: config.unit as BucketUnit, size: config.size as number };
  const playerBuckets = bucketed ? buildBucketSummaries(visible, bucketConfig) : [];
  const uniqueBuckets = bucketed ? buildBucketSummaries(visible, bucketConfig, (point) => point.uniqueCount) : [];
  const playerBucketMap = new Map(playerBuckets.map((bucket) => [bucket.time, bucket]));
  const uniqueBucketMap = new Map(uniqueBuckets.map((bucket) => [bucket.time, bucket]));
  const bucketMax = Math.max(0, ...playerBuckets.map((bucket) => bucket.max), ...uniqueBuckets.map((bucket) => bucket.max));
  const uniqueBucketTimes = playerBuckets.map((bucket) => bucket.time);
  const playerName = getSeriesLabel(config);
  const uniqueName = getUniqueSeriesLabel(config);
  const summaryRows = (label: string, bucket: BucketSummary): string[] => [
    `<strong>${label}</strong>`,
    `${tr("chart.tooltip.avg")}: ${formatInteger(bucket.avg)}`,
    `${tr("chart.tooltip.peak")}: ${formatInteger(bucket.max)}`,
    `${tr("chart.tooltip.trough")}: ${formatInteger(bucket.min)}`,
    tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(bucket.samples) }),
  ];

  return {
    ...baseAxisOption(),
    tooltip: bucketed ? {
      trigger: "axis",
      backgroundColor: "#22292a",
      borderColor: "#35403e",
      textStyle: { color: "#f4f1e8" },
      formatter: (params: Array<{ axisValue?: number | string }>) => {
        const time = Number(params[0]?.axisValue);
        if (!Number.isFinite(time)) return "";
        const playerBucket = playerBucketMap.get(time);
        const uniqueBucket = uniqueBucketMap.get(time);
        if (!playerBucket && !uniqueBucket) return "";
        const rows = [`<strong>${formatBucketRange(time, bucketConfig)}</strong>`];
        if (playerBucket) rows.push(...summaryRows(tr("chart.series.players"), playerBucket));
        if (uniqueBucket) rows.push(...summaryRows(tr("metric.uniqueIp"), uniqueBucket));
        return rows.join("<br />");
      },
    } : { trigger: "axis", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, valueFormatter: (value: number | string) => Number.isFinite(Number(value)) ? formatLocaleNumber(Number(value)) : value },
    legend: { top: 8, data: [playerName, uniqueName], selectedMode: false, textStyle: { color: "#a9b1ad" } },
    grid: { left: 52, right: 24, top: 54, bottom: 76 },
    xAxis: { type: "time", axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad", formatter: (value: number) => formatTimelineAxisLabel(value, currentRange) }, splitLine: { show: false } },
    yAxis: { type: "value", min: 0, max: bucketed && bucketMax > 0 ? Math.ceil(bucketMax * 1.03) : undefined, axisLabel: { color: "#a9b1ad" }, splitLine: { lineStyle: { color: "rgba(169, 177, 173, 0.14)" } } },
    dataZoom: [{ type: "inside", throttle: 80 }, { type: "slider", height: 24, bottom: 16, borderColor: "#35403e", fillerColor: "rgba(125, 216, 125, 0.18)", handleStyle: { color: "#7dd87d" }, textStyle: { color: "#a9b1ad" } }],
    series: bucketed ? [
      { id: "player-range-base", type: "line", stack: "player-range", data: playerBuckets.map((bucket) => [bucket.time, bucket.min]), symbol: "none", lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
      { id: "player-range-spread", type: "line", stack: "player-range", data: playerBuckets.map((bucket) => [bucket.time, bucket.max - bucket.min]), symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: "rgba(125, 216, 125, 0.16)" }, silent: true, tooltip: { show: false } },
      { id: "player-average", name: playerName, type: "line", smooth: true, showSymbol: playerBuckets.length < 80, symbolSize: 7, lineStyle: { width: 3, color: "#7dd87d" }, itemStyle: { color: "#f1c44f" }, data: playerBuckets.map((bucket) => [bucket.time, Math.round(bucket.avg)]), z: 3 },
      { id: "unique-range-base", type: "line", stack: "unique-range", data: uniqueBucketTimes.map((time) => [time, uniqueBucketMap.get(time)?.min ?? null]), symbol: "none", connectNulls: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
      { id: "unique-range-spread", type: "line", stack: "unique-range", data: uniqueBucketTimes.map((time) => { const bucket = uniqueBucketMap.get(time); return [time, bucket ? bucket.max - bucket.min : null]; }), symbol: "none", connectNulls: false, lineStyle: { opacity: 0 }, areaStyle: { color: UNIQUE_RANGE_COLOR }, silent: true, tooltip: { show: false } },
      { id: "unique-average", name: uniqueName, type: "line", smooth: true, connectNulls: false, showSymbol: uniqueBuckets.length < 80, symbolSize: 7, lineStyle: { width: 3, color: UNIQUE_COLOR }, itemStyle: { color: UNIQUE_COLOR }, data: uniqueBucketTimes.map((time) => [time, uniqueBucketMap.has(time) ? Math.round(uniqueBucketMap.get(time)!.avg) : null]), z: 4 },
    ] : [
      { id: "players", name: playerName, type: "line", smooth: false, showSymbol: visible.length < 80, symbolSize: 7, lineStyle: { width: 3, color: "#7dd87d" }, itemStyle: { color: "#f1c44f" }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(125, 216, 125, 0.36)" }, { offset: 1, color: "rgba(125, 216, 125, 0.02)" }] } }, data: playerValues },
      { id: "unique-ip", name: uniqueName, type: "line", smooth: false, connectNulls: false, showSymbol: uniqueSampleCount < 80, symbolSize: 6, lineStyle: { width: 3, color: UNIQUE_COLOR }, itemStyle: { color: UNIQUE_COLOR }, data: uniqueValues, z: 4 },
    ],
    graphic: bucketed ? (playerBuckets.length === 0 ? emptyGraphic() : null) : (playerValues.length === 0 ? emptyGraphic() : null),
  };
}

function pointsForMetric(points: StatsPoint[], metric: ChartMetric = activeMetric): StatsPoint[] {
  if (metric === "players") return points;
  return points
    .filter((point) => typeof point.uniqueCount === "number" && Number.isFinite(point.uniqueCount))
    .map((point) => ({ ...point, count: point.uniqueCount as number }));
}

function buildHeatmapOptions(points: StatsPoint[]) {
  const visible = pointsForMetric(pointsForRange(points, currentRange));
  const weekdayLabels = formatWeekdayLabels();
  const hourLabels = Array.from({ length: 24 }, (_, hour) => `${hour}:00`);
  const percentileRanks = getHeatmapPercentileRanks(visible);
  const buckets = new Map<string, number[]>();
  visible.forEach((point) => {
    const key = `${point.date.getDay()}-${point.date.getHours()}`;
    const bucket = buckets.get(key) || [];
    bucket.push(point.count);
    buckets.set(key, bucket);
  });
  const values: Array<[number, number, number | null, number, Record<string, number>, number]> = [];
  buckets.forEach((bucket, key) => {
    const [day, hour] = key.split("-").map(Number);
    const averageCount = Math.round(average(bucket));
    const percentiles = Object.fromEntries(percentileRanks.map((rank) => [`p${rank}`, Math.round(percentile(bucket, rank))]));
    values.push([hour, day, toHeatmapScore(averageCount), averageCount, percentiles, bucket.length]);
  });
  const { min: visualMin, max: visualMax } = getHeatmapVisualBounds();
  const seriesName = activeMetric === "uniqueIp" ? tr("chart.series.averageUniqueIp") : tr("chart.series.averagePlayers");
  const emptyText = activeMetric === "uniqueIp" ? tr("ui.noUniqueIpData") : tr("ui.noLiveData");
  return { animationDuration: 450, backgroundColor: "transparent", tooltip: { position: "top", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, formatter: (params: { value: [number, number, number | null, number, Record<string, number>, number] }) => { const [hour, day, , count, percentiles, samples] = params.value; const rows = [`<strong>${weekdayLabels[day]} ${hourLabels[hour]}</strong>`, `${tr("chart.tooltip.avg")}: ${formatInteger(count)}`]; Object.entries(percentiles || {}).forEach(([label, value]) => { rows.push(`${label}: ${formatInteger(value)}`); }); if (percentiles && Object.keys(percentiles).length > 0) rows.push(tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(samples) })); return rows.join("<br />"); } }, grid: { left: 52, right: 24, top: 34, bottom: 88 }, xAxis: { type: "category", data: hourLabels, axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad" }, splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.02)", "transparent"] } } }, yAxis: { type: "category", data: weekdayLabels, inverse: true, axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad" }, splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.02)", "transparent"] } } }, visualMap: { min: visualMin, max: visualMax, dimension: 2, calculable: true, orient: "horizontal", left: "center", bottom: 18, textStyle: { color: "#a9b1ad" }, inRange: { color: HEATMAP_COLORS }, outOfRange: { color: [HEATMAP_OUTOFRANGE_COLOR] } }, series: [{ name: seriesName, type: "heatmap", data: values, emphasis: { itemStyle: { borderColor: "#f4f1e8", borderWidth: 1 } } }], graphic: values.length === 0 ? emptyGraphic(emptyText) : null };
}

function buildDistributionOptions(points: StatsPoint[]) {
  const visible = pointsForMetric(pointsForRange(points, currentRange));
  const counts = visible.map((point) => point.count);
  const buckets = buildDistributionBuckets(counts);
  const totalSamples = counts.length || 1;
  const percentageData = buckets.map((bucket) => (bucket.count / totalSamples) * 100);
  const emptyText = activeMetric === "uniqueIp" ? tr("ui.noUniqueIpData") : tr("ui.noLiveData");
  const barColor = activeMetric === "uniqueIp" ? UNIQUE_COLOR : DISTRIBUTION_BAR_COLOR;
  return { ...baseAxisOption(), tooltip: { trigger: "axis", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, formatter: (params: Array<{ dataIndex: number; value: number }>) => { const item = params[0]; if (!item) return ""; const bucket = buckets[item.dataIndex]; return [bucket.label, tr("chart.tooltip.ofSamples", { percent: formatPercentage(item.value) }), tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(bucket.count) })].join("<br />"); } }, grid: { left: 52, right: 24, top: 34, bottom: 74 }, xAxis: { type: "category", data: buckets.map((bucket) => bucket.label), axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad", rotate: 35 } }, yAxis: { type: "value", axisLabel: { color: "#a9b1ad", formatter: (value: number) => formatPercentage(value) }, splitLine: { lineStyle: { color: "rgba(169, 177, 173, 0.14)" } } }, series: [{ name: tr("chart.series.samplesPercent"), type: "bar", barMaxWidth: 38, itemStyle: { borderRadius: [4, 4, 0, 0], borderColor: "#35403e", borderWidth: 1, color: barColor }, data: percentageData }], graphic: visible.length === 0 ? emptyGraphic(emptyText) : null };
}

function buildChartOptions(points: StatsPoint[]) {
  if (activeChart === "heatmap") return buildHeatmapOptions(points);
  if (activeChart === "distribution") return buildDistributionOptions(points);
  return buildTimelineOptions(points);
}

function updateMetricToggle(): void {
  metricToggle.hidden = activeChart === "timeline";
  metricButtons.forEach((button) => {
    const selected = button.dataset.metric === activeMetric;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function selectChart(chartName: ChartKind): void {
  activeChart = chartName;
  activeMetric = "players";
  chartButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.chart === activeChart));
  updateMetricToggle();
}

function selectMetric(metric: ChartMetric): void {
  activeMetric = metric;
  updateMetricToggle();
}

function renderChart(): void {
  if (!chart) {
    chart = echarts.init(chartElement, null, { renderer: "canvas" });
    window.addEventListener("resize", () => {
      if (chart) chart.resize();
    });
  }
  chart.setOption(buildChartOptions(allPoints), true);
}

function render(): void {
  if (pendingRender) return;
  pendingRender = true;
  whenAppReady().then(() => {
    pendingRender = false;
    renderChart();
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

  await (globalThis.__mushmomEchartsReady || Promise.resolve());

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
  const payload = await response.json() as { usercount?: unknown; uniquecount?: unknown };
  const { usercount, uniquecount } = payload;
  if (!isNonnegativeInteger(usercount) || !isNonnegativeInteger(uniquecount)) throw new Error(tr("error.currentUserMissingCount"));
  elements.current.textContent = formatInteger(usercount);
  elements.currentUnique.textContent = formatInteger(uniquecount);
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
    if (elements.currentUnique.textContent === "") elements.currentUnique.textContent = "--";
  }
  render();
}

rangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentRange = (button.dataset.range as ChartRange) || "7d";
    rangeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    render();
  });
});

chartButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectChart((button.dataset.chart as ChartKind) || "timeline");
    render();
  });
});

metricButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectMetric((button.dataset.metric as ChartMetric) || "players");
    render();
  });
});

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
  summarizeUniqueCounts,
  isKnownBadPoint,
  formatTime,
  formatTimelineAxisLabel,
  formatWeekdayLabels,
  formatBucketRange,
  getHeatmapVisualBounds,
  getHeatmapPercentileRanks,
  buildDistributionBuckets,
  buildBucketSummaries,
  buildTimelineOptions,
  buildHeatmapOptions,
  buildDistributionOptions,
  pointsForMetric,
  selectChart,
  selectMetric,
  getChartStateForTest: () => ({ activeChart, activeMetric, metricToggleHidden: metricToggle.hidden }),
  setCurrentRangeForTest: (range: ChartRange) => { currentRange = range; },
};

globalThis.__MUSHMOM_TEST__ = testApi;

export { initApp, normalizePayload, summarizeUniqueCounts, isKnownBadPoint, formatTime, formatTimelineAxisLabel, formatWeekdayLabels, formatBucketRange, getHeatmapVisualBounds, getHeatmapPercentileRanks, buildDistributionBuckets, buildBucketSummaries, buildTimelineOptions, buildHeatmapOptions, buildDistributionOptions, pointsForMetric, testApi };
