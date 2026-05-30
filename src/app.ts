/// <reference path="./globals.d.ts" />

type ChartRange = "24h" | "7d" | "28d" | "90d" | "180d" | "ytd" | "1y" | "3y" | "all";
type ChartKind = "timeline" | "heatmap" | "distribution";
type BucketUnit = "hour" | "day" | "week";

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
let activeChart: ChartKind = "timeline";
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
  return !Number.isFinite(time) || (time >= KNOWN_BAD_GAP_START && time < KNOWN_BAD_GAP_END) || point.count <= 1;
}

function normalizePayload(payload: StatsPayload): StatsPoint[] {
  const rows: RawPayloadRow[] = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : Array.isArray(payload.values) ? payload.values : [];

  return rows
    .map((row): { timestamp: unknown; usercount: unknown } => {
      if (Array.isArray(row)) {
        return { timestamp: row[0], usercount: row[1] };
      }

      return {
        timestamp: row.timestamp ?? row.time ?? row.created_at ?? row.date,
        usercount: row.usercount ?? row.users ?? row.players ?? row.count,
      };
    })
    .map((row): StatsPoint => ({ date: truncateDateToSecond(parseTimestamp(row.timestamp)) as Date, count: Number(row.usercount) }))
    .filter((point) => point.date instanceof Date && Number.isFinite(point.count))
    .filter((point) => !isKnownBadPoint(point))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
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

function emptyGraphic(text = tr("ui.noLiveData")) {
  return { type: "text", left: "center", top: "middle", style: { text, fill: "#a9b1ad", font: "700 16px Inter, sans-serif" } };
}

function baseAxisOption() {
  return { animationDuration: 450, backgroundColor: "transparent", tooltip: { trigger: "axis", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, valueFormatter: (value: number | string) => Number.isFinite(Number(value)) ? formatLocaleNumber(Number(value)) : value } };
}

function buildTimelineOptions(points: StatsPoint[]) {
  const visible = pointsForRange(points, currentRange);
  const config = getTimelineConfig(currentRange, visible);
  const values = visible.map((point) => [point.date.getTime(), point.count]);
  const bucketed = config.unit != null && config.size != null;
  const buckets = bucketed ? buildBucketSummaries(visible, { unit: config.unit as BucketUnit, size: config.size as number }) : [];
  const averageData = buckets.map((bucket) => [bucket.time, Math.round(bucket.avg)]);
  const rangeBaseData = buckets.map((bucket) => [bucket.time, bucket.min]);
  const rangeSpreadData = buckets.map((bucket) => [bucket.time, bucket.max - bucket.min]);
  const bucketMin = buckets.length > 0 ? Math.min(...buckets.map((bucket) => bucket.min)) : 0;
  const bucketMax = buckets.length > 0 ? Math.max(...buckets.map((bucket) => bucket.max)) : 0;

  return {
    ...baseAxisOption(),
    tooltip: bucketed ? {
      trigger: "axis",
      backgroundColor: "#22292a",
      borderColor: "#35403e",
      textStyle: { color: "#f4f1e8" },
      formatter: (params: Array<{ dataIndex?: number }>) => {
        const index = params[0]?.dataIndex;
        if (index == null) return "";
        const bucket = buckets[index];
        if (!bucket) return "";
        return [
          `<strong>${formatBucketRange(bucket.time, { unit: config.unit as BucketUnit, size: config.size as number })}</strong>`,
          `${tr("chart.tooltip.avg")}: ${formatInteger(bucket.avg)}`,
          `${tr("chart.tooltip.peak")}: ${formatInteger(bucket.max)}`,
          `${tr("chart.tooltip.trough")}: ${formatInteger(bucket.min)}`,
          tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(bucket.samples) }),
        ].join("<br />");
      },
    } : { trigger: "axis", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, valueFormatter: (value: number | string) => Number.isFinite(Number(value)) ? formatLocaleNumber(Number(value)) : value },
    grid: { left: 52, right: 24, top: 34, bottom: 76 },
    xAxis: { type: "time", axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad", formatter: (value: number) => formatTimelineAxisLabel(value, currentRange) }, splitLine: { show: false } },
    yAxis: { type: "value", min: bucketed ? Math.max(0, Math.floor(bucketMin * 0.94)) : 0, max: bucketed ? Math.ceil(bucketMax * 1.03) : undefined, axisLabel: { color: "#a9b1ad" }, splitLine: { lineStyle: { color: "rgba(169, 177, 173, 0.14)" } } },
    dataZoom: [{ type: "inside", throttle: 80 }, { type: "slider", height: 24, bottom: 16, borderColor: "#35403e", fillerColor: "rgba(125, 216, 125, 0.18)", handleStyle: { color: "#7dd87d" }, textStyle: { color: "#a9b1ad" } }],
    series: bucketed ? [
      { id: "range-base", type: "line", stack: "population-range", data: rangeBaseData, symbol: "none", lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
      { id: "range-spread", name: tr("chart.series.playerRange"), type: "line", stack: "population-range", data: rangeSpreadData, symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: "rgba(125, 216, 125, 0.16)" }, silent: true, tooltip: { show: false } },
      { id: "bucket-average", name: getSeriesLabel(config), type: "line", smooth: true, showSymbol: buckets.length < 80, symbolSize: 7, lineStyle: { width: 3, color: "#7dd87d" }, itemStyle: { color: "#f1c44f" }, data: averageData, z: 3 },
    ] : [
      { name: getSeriesLabel(config), type: "line", smooth: true, showSymbol: visible.length < 80, symbolSize: 7, lineStyle: { width: 3, color: "#7dd87d" }, itemStyle: { color: "#f1c44f" }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(125, 216, 125, 0.36)" }, { offset: 1, color: "rgba(125, 216, 125, 0.02)" }] } }, data: values },
    ],
    graphic: bucketed ? (buckets.length === 0 ? emptyGraphic() : null) : (values.length === 0 ? emptyGraphic() : null),
  };
}

function buildHeatmapOptions(points: StatsPoint[]) {
  const visible = pointsForRange(points, currentRange);
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
  return { animationDuration: 450, backgroundColor: "transparent", tooltip: { position: "top", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, formatter: (params: { value: [number, number, number | null, number, Record<string, number>, number] }) => { const [hour, day, , count, percentiles, samples] = params.value; const rows = [`<strong>${weekdayLabels[day]} ${hourLabels[hour]}</strong>`, `${tr("chart.tooltip.avg")}: ${formatInteger(count)}`]; Object.entries(percentiles || {}).forEach(([label, value]) => { rows.push(`${label}: ${formatInteger(value)}`); }); if (percentiles && Object.keys(percentiles).length > 0) rows.push(tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(samples) })); return rows.join("<br />"); } }, grid: { left: 52, right: 24, top: 34, bottom: 88 }, xAxis: { type: "category", data: hourLabels, axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad" }, splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.02)", "transparent"] } } }, yAxis: { type: "category", data: weekdayLabels, inverse: true, axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad" }, splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.02)", "transparent"] } } }, visualMap: { min: visualMin, max: visualMax, dimension: 2, calculable: true, orient: "horizontal", left: "center", bottom: 18, textStyle: { color: "#a9b1ad" }, inRange: { color: HEATMAP_COLORS }, outOfRange: { color: [HEATMAP_OUTOFRANGE_COLOR] } }, series: [{ name: tr("chart.series.averagePlayers"), type: "heatmap", data: values, emphasis: { itemStyle: { borderColor: "#f4f1e8", borderWidth: 1 } } }], graphic: values.length === 0 ? emptyGraphic() : null };
}

function buildDistributionOptions(points: StatsPoint[]) {
  const visible = pointsForRange(points, currentRange);
  const counts = visible.map((point) => point.count);
  const buckets = buildDistributionBuckets(counts);
  const totalSamples = counts.length || 1;
  const percentageData = buckets.map((bucket) => (bucket.count / totalSamples) * 100);
  return { ...baseAxisOption(), tooltip: { trigger: "axis", backgroundColor: "#22292a", borderColor: "#35403e", textStyle: { color: "#f4f1e8" }, formatter: (params: Array<{ dataIndex: number; value: number }>) => { const item = params[0]; if (!item) return ""; const bucket = buckets[item.dataIndex]; return [bucket.label, tr("chart.tooltip.ofSamples", { percent: formatPercentage(item.value) }), tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(bucket.count) })].join("<br />"); } }, grid: { left: 52, right: 24, top: 34, bottom: 74 }, xAxis: { type: "category", data: buckets.map((bucket) => bucket.label), axisLine: { lineStyle: { color: "#35403e" } }, axisLabel: { color: "#a9b1ad", rotate: 35 } }, yAxis: { type: "value", axisLabel: { color: "#a9b1ad", formatter: (value: number) => formatPercentage(value) }, splitLine: { lineStyle: { color: "rgba(169, 177, 173, 0.14)" } } }, series: [{ name: tr("chart.series.samplesPercent"), type: "bar", barMaxWidth: 38, itemStyle: { borderRadius: [4, 4, 0, 0], borderColor: "#35403e", borderWidth: 1, color: DISTRIBUTION_BAR_COLOR }, data: percentageData }], graphic: visible.length === 0 ? emptyGraphic() : null };
}

function buildChartOptions(points: StatsPoint[]) {
  if (activeChart === "heatmap") return buildHeatmapOptions(points);
  if (activeChart === "distribution") return buildDistributionOptions(points);
  return buildTimelineOptions(points);
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
    onInitial: ({ points, latestPayload }) => {
      allPoints = points;
      historicalSource = { name: (latestPayload as HistoricalSourcePayload).source || "Google API", url: (latestPayload as HistoricalSourcePayload).sourceUrl || null };
      updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
      render();
    },
  });

  await (globalThis.__mushmomEchartsReady || Promise.resolve());

  await loader.loadArchiveStatsHistory<StatsPoint>({
    latestPayload: initial.latestPayload,
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
    render();
  });
});

chartButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeChart = (button.dataset.chart as ChartKind) || "timeline";
    chartButtons.forEach((item) => item.classList.toggle("is-active", item === button));
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
  setCurrentRangeForTest: (range: ChartRange) => { currentRange = range; },
  setActiveChartForTest: (chartName: ChartKind) => { activeChart = chartName; },
};

globalThis.__MUSHMOM_TEST__ = testApi;

export { initApp, normalizePayload, isKnownBadPoint, formatTime, formatTimelineAxisLabel, formatWeekdayLabels, formatBucketRange, getHeatmapVisualBounds, getHeatmapPercentileRanks, buildDistributionBuckets, buildBucketSummaries, buildTimelineOptions, buildHeatmapOptions, buildDistributionOptions, testApi };
