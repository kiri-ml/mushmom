const chartElement = document.querySelector("#population-chart");
const rangeButtons = [...document.querySelectorAll("[data-range]")];
const chartButtons = [...document.querySelectorAll("[data-chart]")];
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const HEATMAP_VISUAL_MIN = 0;
const HEATMAP_VISUAL_MAX = 100;
const HEATMAP_OUTOFRANGE_COLOR = "#131617";
const HEATMAP_COLORS = [
  '#102a43', // deep blue
  '#1e6091', // muted blue
  '#2fbf71', // softer green
  '#f4d44d', // softer yellow
  '#f4a340', // softer orange
  '#e84a4a', // softer red
  '#c62828', // dark red
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function toHeatmapScore(v) {
  if (v == null) return null;
  if (v <= 0) return 0;

  const anchors = [
    [0,    0],
    [600,  12],
    [800,  25],
    [1000, 40],
    [1200, 55],
    [1400, 68],
    [1600, 78],
    [1800, 86],
    [2000, 94],
    [2500, 98],
    [3000, 100],
  ];

  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];

    if (v <= x2) {
      const t = (v - x1) / (x2 - x1);
      return lerp(y1, y2, t);
    }
  }

  return 100;
}

const DISTRIBUTION_BAR_COLOR = "#f1c44f";
const DISTRIBUTION_STEP = 100;
const KNOWN_BAD_GAP_START = Date.parse("2020-06-15T15:30:55.664Z");
const KNOWN_BAD_GAP_END = Date.parse("2020-06-22T01:00:00.528Z");

const elements = {
  current: document.querySelector("#current-count"),
  peak: document.querySelector("#peak-count"),
  average: document.querySelector("#average-count"),
  lastSample: document.querySelector("#last-sample"),
  sampleCount: document.querySelector("#sample-count"),
  rangeLabel: document.querySelector("#range-label"),
  sourceLabel: document.querySelector("#source-label"),
};

let allPoints = [];
let currentRange = "7d";
let activeChart = "timeline";
let chart;
let historicalSource = { name: "Unknown", url: null };
let currentStatus = { kind: "loading", key: "status.loading", params: {} };
let pendingRender = false;
const echartsReady = globalThis.__mushmomEchartsReady;

function whenAppReady() {
  return Promise.all([
    echartsReady,
    globalThis.MushmomI18n?.ready || Promise.resolve(),
  ]);
}

function getI18n() {
  return globalThis.MushmomI18n || null;
}

function tr(key, params = {}) {
  const translate = getI18n()?.t;
  return typeof translate === "function" ? translate(key, params) : key;
}

function getCurrentLocale() {
  const getCurrentLang = getI18n()?.getCurrentLang;
  return typeof getCurrentLang === "function" ? getCurrentLang() : undefined;
}

function formatLocaleNumber(value) {
  return Number(value).toLocaleString(getCurrentLocale());
}

function parseTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return parseTimestamp(Number(value));
  }

  const normalized = String(value)
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isKnownBadPoint(point) {
  const time = point.date?.getTime();

  return (
    !Number.isFinite(time) ||
    (time >= KNOWN_BAD_GAP_START && time < KNOWN_BAD_GAP_END) ||
    point.count <= 1
  );
}

function normalizePayload(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.values)
        ? payload.values
        : [];

  return rows
    .map((row) => {
      if (Array.isArray(row)) {
        return { timestamp: row[0], usercount: row[1] };
      }

      return {
        timestamp: row.timestamp ?? row.time ?? row.created_at ?? row.date,
        usercount: row.usercount ?? row.users ?? row.players ?? row.count,
      };
    })
    .map((row) => ({
      date: truncateDateToSecond(parseTimestamp(row.timestamp)),
      count: Number(row.usercount),
    }))
    .filter((point) => point.date && Number.isFinite(point.count))
    .filter((point) => !isKnownBadPoint(point))
    .sort((a, b) => a.date - b.date);
}

function truncateDateToSecond(date) {
  return date ? new Date(Math.floor(date.getTime() / 1000) * 1000) : null;
}

function formatInteger(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString(getCurrentLocale()) : "--";
}

function formatTime(date) {
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDate(date) {
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function bucketDurationMs(config) {
  const unitMs = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
  };

  return (unitMs[config.unit] || 0) * config.size;
}

function formatShortDate(date, includeYear = false) {
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(date);
}

function formatTimelineAxisLabel(value, range = currentRange) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  if (range === "7d") {
    return `${formatShortDate(date)}\n${formatTime(date)}`;
  }

  return formatShortDate(date, ["1y", "3y", "all", "ytd"].includes(range));
}

function formatWeekdayLabels() {
  const formatter = new Intl.DateTimeFormat(getCurrentLocale(), { weekday: "short" });

  return Array.from({ length: 7 }, (_, dayOffset) => {
    return formatter.format(new Date(2026, 0, 4 + dayOffset, 12));
  });
}

function formatBucketRange(startMs, config) {
  const start = new Date(startMs);
  const duration = bucketDurationMs(config);
  const exclusiveEndMs = duration > 0 ? startMs + duration : startMs;

  if (config.unit === "hour") {
    const end = new Date(Math.max(startMs, exclusiveEndMs - 60 * 1000));
    return `${formatDate(start)}<br />${formatTime(start)} - ${formatTime(end)}`;
  }

  const end = new Date(Math.max(startMs, exclusiveEndMs - 24 * 60 * 60 * 1000));
  const sameDay = start.toDateString() === end.toDateString();

  if (sameDay) {
    return formatDate(start);
  }

  const sameYear = start.getFullYear() === end.getFullYear();
  return sameYear
    ? `${formatShortDate(start)} - ${formatShortDate(end)}, ${end.getFullYear()}`
    : `${formatShortDate(start, true)} - ${formatShortDate(end, true)}`;
}

function setStatus(kind, key, params = {}) {
  currentStatus = { kind, key, params };
  statusDot.classList.toggle("is-ready", kind === "ready");
  statusDot.classList.toggle("is-failed", kind === "failed");
  statusText.textContent = tr(key, params);
}

function refreshStatusText() {
  statusText.textContent = tr(currentStatus.key, currentStatus.params);
}

function pointsForRange(points, range) {
  if (range === "all" || points.length === 0) return points;
  const latest = points.at(-1).date.getTime();

  if (range === "ytd") {
    const latestDate = points.at(-1).date;
    const yearStart = new Date(latestDate.getFullYear(), 0, 1).getTime();
    return points.filter((point) => point.date.getTime() >= yearStart);
  }

  const windows = {
    "24h": 864e5,
    "7d": 7 * 864e5,
    "28d": 28 * 864e5,
    "90d": 90 * 864e5,
    "180d": 180 * 864e5,
    "1y": 365 * 864e5,
    "3y": 3 * 365 * 864e5,
  };
  const windowMs = windows[range] ?? windows["24h"];

  return points.filter((point) => latest - point.date.getTime() <= windowMs);
}

function setSourceLabel(source, sourceUrl = null) {
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

function updateHistoricalMetrics(points, source, sourceUrl = null) {
  const visible = pointsForRange(points, "24h");
  const latest = points.at(-1);
  const peak = Math.max(...visible.map((point) => point.count));
  const average =
    visible.length > 0
      ? visible.reduce((total, point) => total + point.count, 0) / visible.length
      : Number.NaN;

  elements.peak.textContent = formatInteger(peak);
  elements.average.textContent = formatInteger(average);
  elements.lastSample.textContent = latest ? formatTime(latest.date) : "--";
  elements.sampleCount.textContent = formatLocaleNumber(points.length);
  setSourceLabel(source, sourceUrl);

  if (points.length >= 2) {
    elements.rangeLabel.textContent = `${formatDate(points[0].date)} - ${formatDate(points.at(-1).date)}`;
  } else {
    elements.rangeLabel.textContent = latest ? formatDate(latest.date) : "--";
  }
}

function clearHistoricalMetrics(source) {
  elements.peak.textContent = "--";
  elements.average.textContent = "--";
  elements.lastSample.textContent = "--";
  elements.sampleCount.textContent = "0";
  elements.rangeLabel.textContent = "--";
  setSourceLabel(source);
}

function average(values) {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : Number.NaN;
}

function percentile(values, percentileRank) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];

  const index = (percentileRank / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  return lerp(sorted[lower], sorted[upper], index - lower);
}

function getHeatmapVisualBounds() {
  return { min: HEATMAP_VISUAL_MIN, max: HEATMAP_VISUAL_MAX };
}

function getHeatmapPercentileRanks(visible) {
  if (visible.length < 2) return [];

  const spanMs = visible.at(-1).date.getTime() - visible[0].date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (spanMs <= 7 * dayMs) return [];
  if (spanMs <= 45 * dayMs) return [50];

  return [90, 50, 10];
}

function buildDistributionBuckets(counts) {
  const finiteCounts = counts.filter((value) => Number.isFinite(value));

  if (finiteCounts.length === 0) {
    return [];
  }

  const maxCount = finiteCounts.reduce((max, value) => Math.max(max, value), 0);
  const bucketCount = Math.max(1, Math.ceil((maxCount + 1) / DISTRIBUTION_STEP));
  const histogramBuckets = Array.from({ length: bucketCount }, (_, index) => ({
    label: `${formatLocaleNumber(index * DISTRIBUTION_STEP)}-${formatLocaleNumber(Math.min(((index + 1) * DISTRIBUTION_STEP) - 1, maxCount))}`,
    count: 0,
  }));

  finiteCounts.forEach((count) => {
    const index = Math.min(Math.floor(count / DISTRIBUTION_STEP), histogramBuckets.length - 1);
    histogramBuckets[index].count += 1;
  });

  return histogramBuckets;
}

function formatPercentage(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 10) return `${value.toFixed(0)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

const TIMELINE_RANGE_CONFIG = {
  "7d": { type: "line", labelKey: "chart.series.players" },
  "28d": { type: "candlestick", labelKey: "chart.series.playersBucket", bucketKey: "bucket.4h", unit: "hour", size: 4 },
  "90d": { type: "candlestick", labelKey: "chart.series.playersBucket", bucketKey: "bucket.12h", unit: "hour", size: 12 },
  "180d": { type: "candlestick", labelKey: "chart.series.playersBucket", bucketKey: "bucket.1d", unit: "day", size: 1 },
  "1y": { type: "candlestick", labelKey: "chart.series.playersBucket", bucketKey: "bucket.48h", unit: "day", size: 2 },
  "3y": { type: "candlestick", labelKey: "chart.series.playersBucket", bucketKey: "bucket.1w", unit: "week", size: 1 },
  all: { type: "candlestick", labelKey: "chart.series.playersBucket", bucketKey: "bucket.1w", unit: "week", size: 1 },
};

function getSeriesLabel(config) {
  if (config.bucketKey) {
    return tr(config.labelKey, { bucket: tr(config.bucketKey) });
  }

  return tr(config.labelKey);
}

const RANGE_WINDOW_MS = {
  "24h": 864e5,
  "7d": 7 * 864e5,
  "28d": 28 * 864e5,
  "90d": 90 * 864e5,
  "180d": 180 * 864e5,
  "1y": 365 * 864e5,
  "3y": 3 * 365 * 864e5,
};

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfLocalWeek(date) {
  const dayStart = startOfLocalDay(date);
  const day = new Date(dayStart).getDay();
  return dayStart - day * 24 * 60 * 60 * 1000;
}

function bucketStart(timestamp, config) {
  const date = new Date(timestamp);

  if (config.unit === "hour") {
    const dayStart = startOfLocalDay(date);
    const hour = date.getHours();
    return dayStart + Math.floor(hour / config.size) * config.size * 60 * 60 * 1000;
  }

  if (config.unit === "day") {
    const dayStart = startOfLocalDay(date);
    const epochDay = Math.floor(dayStart / (24 * 60 * 60 * 1000));
    const bucketDay = Math.floor(epochDay / config.size) * config.size;
    return bucketDay * 24 * 60 * 60 * 1000;
  }

  if (config.unit === "week") {
    const weekStart = startOfLocalWeek(date);

    if (config.size <= 1) {
      return weekStart;
    }

    const anchor = startOfLocalWeek(new Date(0));
    const weekIndex = Math.floor((weekStart - anchor) / (7 * 24 * 60 * 60 * 1000));
    return anchor + Math.floor(weekIndex / config.size) * config.size * 7 * 24 * 60 * 60 * 1000;
  }

  return timestamp;
}

function buildCandles(points, config) {
  const buckets = new Map();

  points.forEach((point) => {
    const bucket = bucketStart(point.date.getTime(), config);
    const existing = buckets.get(bucket);

    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        open: point.count,
        high: point.count,
        low: point.count,
        close: point.count,
      });
      return;
    }

    existing.high = Math.max(existing.high, point.count);
    existing.low = Math.min(existing.low, point.count);
    existing.close = point.count;
  });

  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map((candle) => [candle.time, candle.open, candle.close, candle.low, candle.high]);
}

function getTimelineConfig(range, visible) {
  if (range !== "ytd") {
    return TIMELINE_RANGE_CONFIG[range] || TIMELINE_RANGE_CONFIG["7d"];
  }

  if (visible.length === 0) {
    return TIMELINE_RANGE_CONFIG["7d"];
  }

  const latest = visible.at(-1).date;
  const yearStart = new Date(latest.getFullYear(), 0, 1).getTime();
  const spanMs = latest.getTime() - yearStart;

  if (spanMs <= RANGE_WINDOW_MS["7d"]) return TIMELINE_RANGE_CONFIG["7d"];
  if (spanMs <= RANGE_WINDOW_MS["28d"]) return TIMELINE_RANGE_CONFIG["28d"];
  if (spanMs <= RANGE_WINDOW_MS["90d"]) return TIMELINE_RANGE_CONFIG["90d"];
  if (spanMs <= RANGE_WINDOW_MS["180d"]) return TIMELINE_RANGE_CONFIG["180d"];

  return TIMELINE_RANGE_CONFIG["1y"];
}

function emptyGraphic(text = tr("ui.noLiveData")) {
  return {
    type: "text",
    left: "center",
    top: "middle",
    style: {
      text,
      fill: "#a9b1ad",
      font: "700 16px Inter, sans-serif",
    },
  };
}

function baseAxisOption() {
  return {
    animationDuration: 450,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: "#22292a",
      borderColor: "#35403e",
      textStyle: { color: "#f4f1e8" },
      valueFormatter: (value) =>
        Number.isFinite(Number(value)) ? formatLocaleNumber(Number(value)) : value,
    },
  };
}

function buildTimelineOptions(points) {
  const visible = pointsForRange(points, currentRange);
  const config = getTimelineConfig(currentRange, visible);
  const values = visible.map((point) => [point.date.getTime(), point.count]);
  const candles =
    config.type === "candlestick" ? buildCandles(visible, config) : [];

  return {
    ...baseAxisOption(),
    tooltip:
      config.type === "candlestick"
        ? {
            trigger: "axis",
            backgroundColor: "#22292a",
            borderColor: "#35403e",
            textStyle: { color: "#f4f1e8" },
            formatter: (params) => {
              const item = params[0];
              if (!item?.value) return "";

              const [time, open, close, low, high] = item.value;
              return [
                `<strong>${formatBucketRange(time, config)}</strong>`,
                `${tr("chart.tooltip.start")}: ${formatInteger(open)}`,
                `${tr("chart.tooltip.peak")}: ${formatInteger(high)}`,
                `${tr("chart.tooltip.trough")}: ${formatInteger(low)}`,
                `${tr("chart.tooltip.end")}: ${formatInteger(close)}`,
              ].join("<br />");
            },
          }
        : {
            trigger: "axis",
            backgroundColor: "#22292a",
            borderColor: "#35403e",
            textStyle: { color: "#f4f1e8" },
            valueFormatter: (value) =>
              Number.isFinite(Number(value)) ? formatLocaleNumber(Number(value)) : value,
          },
    grid: { left: 52, right: 24, top: 34, bottom: 76 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "#35403e" } },
      axisLabel: {
        color: "#a9b1ad",
        formatter: (value) => formatTimelineAxisLabel(value, currentRange),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      min:
        config.type === "candlestick"
          ? (value) => Math.max(0, Math.floor(value.min * 0.94))
          : 0,
      axisLabel: { color: "#a9b1ad" },
      splitLine: { lineStyle: { color: "rgba(169, 177, 173, 0.14)" } },
    },
    dataZoom: [
      { type: "inside", throttle: 80 },
      {
        type: "slider",
        height: 24,
        bottom: 16,
        borderColor: "#35403e",
        fillerColor: "rgba(125, 216, 125, 0.18)",
        handleStyle: { color: "#7dd87d" },
        textStyle: { color: "#a9b1ad" },
      },
    ],
    series: [
      config.type === "candlestick"
        ? {
            name: getSeriesLabel(config),
            type: "candlestick",
            data: candles,
            itemStyle: {
              color: "#7dd87d",
              color0: "#d96b5f",
              borderColor: "#7dd87d",
              borderColor0: "#d96b5f",
            },
          }
        : {
            name: getSeriesLabel(config),
            type: "line",
            smooth: true,
            showSymbol: visible.length < 80,
            symbolSize: 7,
            lineStyle: { width: 3, color: "#7dd87d" },
            itemStyle: { color: "#f1c44f" },
            areaStyle: {
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: "rgba(125, 216, 125, 0.36)" },
                  { offset: 1, color: "rgba(125, 216, 125, 0.02)" },
                ],
              },
            },
            data: values,
          },
    ],
    graphic:
      config.type === "candlestick"
        ? candles.length === 0
          ? emptyGraphic()
          : null
        : values.length === 0
          ? emptyGraphic()
          : null,
  };
}

function buildHeatmapOptions(points) {
  const visible = pointsForRange(points, currentRange);
  const weekdayLabels = formatWeekdayLabels();
  const hourLabels = Array.from({ length: 24 }, (_, hour) => `${hour}:00`);
  const percentileRanks = getHeatmapPercentileRanks(visible);
  const buckets = new Map();

  visible.forEach((point) => {
    const key = `${point.date.getDay()}-${point.date.getHours()}`;
    const bucket = buckets.get(key) || [];
    bucket.push(point.count);
    buckets.set(key, bucket);
  });

  const values = [];
  buckets.forEach((bucket, key) => {
    const [day, hour] = key.split("-").map(Number);
    const averageCount = Math.round(average(bucket));
    const percentiles = Object.fromEntries(
      percentileRanks.map((rank) => [`p${rank}`, Math.round(percentile(bucket, rank))]),
    );

    values.push([hour, day, toHeatmapScore(averageCount), averageCount, percentiles, bucket.length]);
  });

  const { min: visualMin, max: visualMax } = getHeatmapVisualBounds();

  return {
    animationDuration: 450,
    backgroundColor: "transparent",
    tooltip: {
      position: "top",
      backgroundColor: "#22292a",
      borderColor: "#35403e",
      textStyle: { color: "#f4f1e8" },
      formatter: (params) => {
        const [hour, day, , count, percentiles, samples] = params.value;
        const rows = [
          `<strong>${weekdayLabels[day]} ${hourLabels[hour]}</strong>`,
          `${tr("chart.tooltip.avg")}: ${formatInteger(count)}`,
        ];

        Object.entries(percentiles || {}).forEach(([label, value]) => {
          rows.push(`${label}: ${formatInteger(value)}`);
        });

        if (percentiles && Object.keys(percentiles).length > 0) {
          rows.push(tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(samples) }));
        }

        return rows.join("<br />");
      },
    },
    grid: { left: 52, right: 24, top: 34, bottom: 88 },
    xAxis: {
      type: "category",
      data: hourLabels,
      axisLine: { lineStyle: { color: "#35403e" } },
      axisLabel: { color: "#a9b1ad" },
      splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.02)", "transparent"] } },
    },
    yAxis: {
      type: "category",
      data: weekdayLabels,
      inverse: true,
      axisLine: { lineStyle: { color: "#35403e" } },
      axisLabel: { color: "#a9b1ad" },
      splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.02)", "transparent"] } },
    },
    visualMap: {
      min: visualMin,
      max: visualMax,
      dimension: 2,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 18,
      textStyle: { color: "#a9b1ad" },
      inRange: {
        color: HEATMAP_COLORS,
      },
      outOfRange: { color: [HEATMAP_OUTOFRANGE_COLOR] },
    },
    series: [
      {
        name: tr("chart.series.averagePlayers"),
        type: "heatmap",
        data: values,
        emphasis: {
          itemStyle: {
            borderColor: "#f4f1e8",
            borderWidth: 1,
          },
        },
      },
    ],
    graphic: values.length === 0 ? emptyGraphic() : null,
  };
}

function buildDistributionOptions(points) {
  const visible = pointsForRange(points, currentRange);
  const counts = visible.map((point) => point.count);
  const buckets = buildDistributionBuckets(counts);
  const totalSamples = counts.length || 1;
  const percentageData = buckets.map((bucket) => (bucket.count / totalSamples) * 100);

  return {
    ...baseAxisOption(),
    tooltip: {
      trigger: "axis",
      backgroundColor: "#22292a",
      borderColor: "#35403e",
      textStyle: { color: "#f4f1e8" },
      formatter: (params) => {
        const item = params[0];
        if (!item) return "";

        const bucket = buckets[item.dataIndex];
        return [
          bucket.label,
          tr("chart.tooltip.ofSamples", { percent: formatPercentage(item.value) }),
          tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(bucket.count) }),
        ].join("<br />");
      },
    },
    grid: { left: 52, right: 24, top: 34, bottom: 74 },
    xAxis: {
      type: "category",
      data: buckets.map((bucket) => bucket.label),
      axisLine: { lineStyle: { color: "#35403e" } },
      axisLabel: { color: "#a9b1ad", rotate: 35 },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: "#a9b1ad",
        formatter: (value) => formatPercentage(value),
      },
      splitLine: { lineStyle: { color: "rgba(169, 177, 173, 0.14)" } },
    },
    series: [
      {
        name: tr("chart.series.samplesPercent"),
        type: "bar",
        barMaxWidth: 38,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          borderColor: "#35403e",
          borderWidth: 1,
          color: DISTRIBUTION_BAR_COLOR,
        },
        data: percentageData,
      },
    ],
    graphic: visible.length === 0 ? emptyGraphic() : null,
  };
}

function buildChartOptions(points) {
  if (activeChart === "heatmap") {
    return buildHeatmapOptions(points);
  }
  if (activeChart === "distribution") return buildDistributionOptions(points);

  return buildTimelineOptions(points);
}

function renderChart() {
  if (!chart) {
    chart = echarts.init(chartElement, null, { renderer: "canvas" });
    window.addEventListener("resize", () => chart.resize());
  }

  chart.setOption(buildChartOptions(allPoints), true);
}

function render() {
  if (pendingRender) return;
  pendingRender = true;

  whenAppReady().then(() => {
    pendingRender = false;
    renderChart();
  });
}

function mergePoints(...groups) {
  const pointsByTime = new Map();

  groups.flat().forEach((point) => {
    const time = point.date.getTime();
    if (!pointsByTime.has(time)) pointsByTime.set(time, point);
  });

  return [...pointsByTime.values()].sort((a, b) => a.date - b.date);
}

async function fetchHistoricalStats() {
  const loader = globalThis.MushmomStatsLoader;
  if (!loader) throw new Error(tr("error.statsLoaderUnavailable"));

  await loader.loadStatsHistory({
    normalizePayload,
    onInitial: ({ points, latestPayload }) => {
      allPoints = points;
      historicalSource = {
        name: latestPayload.source || "Google API",
        url: latestPayload.sourceUrl || null,
      };
      updateHistoricalMetrics(
        allPoints,
        historicalSource.name,
        historicalSource.url,
      );
      render();
    },
    onArchive: ({ points }) => {
      if (points.length === 0) return;

      allPoints = mergePoints(points, allPoints);
      updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
      render();
    },
  });
}

async function fetchCurrentUserCount() {
  const response = await fetch("/api/current", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(tr("error.currentUserRequestFailed", { status: response.status }));

  const payload = await response.json();
  const usercount = Number(payload.usercount);
  if (!Number.isFinite(usercount)) throw new Error(tr("error.currentUserMissingCount"));

  elements.current.textContent = formatInteger(usercount);
}

async function loadStats() {
  const hadHistoricalData = allPoints.length > 0;

  if (!hadHistoricalData) setStatus("loading", "status.loading");

  const [statsResult, currentResult] = await Promise.allSettled([
    fetchHistoricalStats(),
    fetchCurrentUserCount(),
  ]);

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
    currentRange = button.dataset.range;
    rangeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    render();
  });
});

chartButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeChart = button.dataset.chart;
    chartButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    render();
  });
});

window.addEventListener("mushmom:languagechange", () => {
  refreshStatusText();

  if (allPoints.length > 0) {
    updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
  } else if (currentStatus.kind === "error") {
    clearHistoricalMetrics(tr("source.unavailable"));
  }

  render();
});

loadStats();

globalThis.__MUSHMOM_TEST__ = {
  normalizePayload,
  isKnownBadPoint,
  formatTime,
  formatTimelineAxisLabel,
  formatWeekdayLabels,
  formatBucketRange,
  getHeatmapVisualBounds,
  getHeatmapPercentileRanks,
  buildDistributionBuckets,
  buildCandles,
  buildTimelineOptions,
  buildHeatmapOptions,
  buildDistributionOptions,
  setCurrentRangeForTest: (range) => {
    currentRange = range;
  },
  setActiveChartForTest: (chartName) => {
    activeChart = chartName;
  },
};
