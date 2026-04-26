const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const i18nDataJs = fs.readFileSync(path.join(__dirname, "../public/i18n-data.js"), "utf8");
const i18nJs = fs.readFileSync(path.join(__dirname, "../public/i18n.js"), "utf8");
const loadJs = fs.readFileSync(path.join(__dirname, "../public/load.js"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const i18nMessages = loadI18nMessages();

function loadI18nMessages() {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(i18nDataJs, context);
  return context.MUSHMOM_I18N_MESSAGES;
}

function loadAppTests() {
  let fetchCount = 0;
  let currentLang = "en";
  const windowListeners = new Map();
  const renderedOptions = [];
  const translate = (key, params = {}) => {
    const template = i18nMessages[currentLang]?.[key] ?? i18nMessages.en[key] ?? key;
    return String(template).replace(/\{([^{}]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  };
  const stubElement = () => ({
    textContent: "",
    disabled: false,
    dataset: {},
    classList: { toggle() {} },
    append() {},
    addEventListener() {},
  });
  const context = {
    console,
    Date,
    Intl,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    __mushmomEchartsReady: Promise.resolve(),
    MushmomI18n: {
      getCurrentLang: () => currentLang,
      setLang: (lang) => {
        currentLang = lang;
        windowListeners.get("mushmom:languagechange")?.({ detail: { lang } });
        return lang;
      },
    },
    t: translate,
    fetch: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({
          usercount: 0,
          data: [[1776945603, 1459]],
          chunks: [],
        }),
      };
    },
    echarts: {
      init: () => ({
        setOption(option) {
          renderedOptions.push(option);
        },
        resize() {},
      }),
    },
    document: {
      visibilityState: "visible",
      querySelector: () => stubElement(),
      querySelectorAll: () => [],
      createElement: () => stubElement(),
      addEventListener() {},
    },
    window: {
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
      setInterval() {},
      location: {
        origin: "https://mushmom.test",
      },
    },
  };

  context.window.window = context.window;
  context.window.globalThis = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(loadJs, context);
  vm.runInContext(appJs, context);
  return {
    ...context.__MUSHMOM_TEST__,
    ...context.MushmomStatsLoader,
    context,
    getFetchCount: () => fetchCount,
    renderedOptions,
    setLangForTest: (lang) => {
      currentLang = lang;
    },
    dispatchLanguageChange: (lang) => {
      currentLang = lang;
      windowListeners.get("mushmom:languagechange")?.({ detail: { lang } });
    },
  };
}

function loadI18nTests(options = {}) {
  const {
    languages = ["en"],
    language = languages[0] || "en",
    storedLang = null,
  } = options;
  const note = {
    textContent: "",
    dataset: { i18nTimezoneNote: "details.localTimezone" },
  };
  const textElement = {
    textContent: "",
    dataset: { i18n: "chartView.heatmap" },
  };
  const ariaElement = {
    dataset: { i18nAriaLabel: "language.label" },
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
  const selector = {
    value: "",
    addEventListener() {},
  };
  const storage = new Map();
  if (storedLang != null) storage.set("mushmom.lang", storedLang);
  const context = {
    console,
    CustomEvent: function CustomEvent(type, options = {}) {
      return { type, ...options };
    },
    Date,
    Intl,
    Map,
    Object,
    String,
    document: {
      documentElement: { lang: "" },
      querySelector: (selectorText) => (
        selectorText === "#language-select" ? selector : null
      ),
      querySelectorAll: (selectorText) => {
        if (selectorText === "[data-i18n-timezone-note]") return [note];
        if (selectorText === "[data-i18n]") return [textElement];
        if (selectorText === "[data-i18n-aria-label]") return [ariaElement];
        return [];
      },
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
    },
    navigator: { languages, language },
    dispatchEvent() {},
  };

  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(i18nDataJs, context);
  vm.runInContext(i18nJs, context);

  return {
    ariaElement,
    documentElement: context.document.documentElement,
    i18n: context.MushmomI18n,
    note,
    selector,
    textElement,
  };
}

test("toolbar defaults to 7d and no longer exposes 24h", () => {
  assert.match(appJs, /let currentRange = "7d";/);
  assert.doesNotMatch(indexHtml, /data-range="24h"/);
  assert.match(indexHtml, /class="is-active" data-range="7d"/);
});

test("language selector exposes every supported language", () => {
  const expectedOptions = [
    ["en", "English"],
    ["zh-CN", "简体中文"],
    ["zh-TW", "繁體中文"],
    ["ko", "한국어"],
    ["es", "Español"],
    ["pt-BR", "Português"],
    ["ja", "日本語"],
    ["nl", "Nederlands"],
  ];

  expectedOptions.forEach(([value, label]) => {
    assert.match(indexHtml, new RegExp(`<option value="${value}">${label}</option>`));
  });
});

test("i18n normalizes saved and browser languages to supported locales", () => {
  const { i18n: zhCnI18n } = loadI18nTests({ languages: ["fr-FR"], storedLang: "zh-Hans" });
  assert.equal(zhCnI18n.getCurrentLang(), "zh-CN");

  const { i18n: zhTwI18n } = loadI18nTests({ storedLang: "zh-HK" });
  assert.equal(zhTwI18n.getCurrentLang(), "zh-TW");

  const { i18n } = loadI18nTests({ languages: ["fr-FR", "pt-PT", "ja-JP"] });
  assert.equal(i18n.normalizeLang("zh"), "zh-CN");
  assert.equal(i18n.normalizeLang("zh-CN"), "zh-CN");
  assert.equal(i18n.normalizeLang("zh-SG"), "zh-CN");
  assert.equal(i18n.normalizeLang("zh-Hans"), "zh-CN");
  assert.equal(i18n.normalizeLang("zh-TW"), "zh-TW");
  assert.equal(i18n.normalizeLang("zh-HK"), "zh-TW");
  assert.equal(i18n.normalizeLang("zh-MO"), "zh-TW");
  assert.equal(i18n.normalizeLang("zh-Hant"), "zh-TW");
  assert.equal(i18n.normalizeLang("ko-KR"), "ko");
  assert.equal(i18n.normalizeLang("es-MX"), "es");
  assert.equal(i18n.normalizeLang("pt"), "pt-BR");
  assert.equal(i18n.normalizeLang("pt-PT"), "pt-BR");
  assert.equal(i18n.normalizeLang("ja-JP"), "ja");
  assert.equal(i18n.normalizeLang("nl-BE"), "nl");
  assert.equal(i18n.normalizeLang("fr-FR"), "en");
  assert.equal(i18n.getCurrentLang(), "pt-BR");
});

test("i18n applies static text, attributes, selector value, and English fallback", () => {
  const { ariaElement, documentElement, i18n, selector, textElement } = loadI18nTests({
    languages: ["nl-NL"],
  });

  i18n.applyI18n();
  assert.equal(documentElement.lang, "nl");
  assert.equal(textElement.textContent, i18nMessages.nl["chartView.heatmap"]);
  assert.equal(ariaElement.attrs["aria-label"], i18nMessages.nl["language.label"]);
  assert.equal(selector.value, "nl");

  delete i18n.messages.nl["chartView.heatmap"];
  assert.equal(i18n.t("chartView.heatmap", {}, "nl"), i18nMessages.en["chartView.heatmap"]);
});

test("echarts loader chooses one cdn from the user language", () => {
  assert.match(indexHtml, /const GLOBAL_CDN = "https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@5\.6\.0\/dist\/echarts\.min\.js";/);
  assert.match(indexHtml, /const CHINA_CDN = "https:\/\/cdn\.jsdmirror\.com\/npm\/echarts@5\.6\.0\/dist\/echarts\.min\.js";/);
  assert.match(indexHtml, /const preferChinaCdn = langs\.some\(\(lang\) => \/\^zh-CN\$\/i\.test\(lang\)\);/);
  assert.match(indexHtml, /const source = preferChinaCdn \? CHINA_CDN : GLOBAL_CDN;/);
  assert.match(indexHtml, /window\.__mushmomEchartsReady = new Promise\(\(resolve\) => \{/);
  assert.match(indexHtml, /script\.src = source;/);
  assert.match(indexHtml, /script\.onload = \(\) => \{/);
  assert.match(indexHtml, /window\.__mushmomEchartsReady = new Promise[\s\S]*<script src="\/app\.js" defer><\/script>/);
  assert.match(appJs, /const echartsReady = globalThis\.__mushmomEchartsReady;/);
  assert.doesNotMatch(indexHtml, /__mushmomEchartsReady\?\.\(\)/);
  assert.doesNotMatch(indexHtml, /__mushmomEchartsLoaded/);
  assert.doesNotMatch(indexHtml, /const sources = /);
  assert.doesNotMatch(indexHtml, /Promise\.race/);
  assert.doesNotMatch(indexHtml, /CDN_TIMEOUT_MS/);
  assert.doesNotMatch(indexHtml, /__mushmomEchartsFailed/);
});

test("timeline chart uses the current range mapping", () => {
  assert.match(appJs, /"7d": \{ type: "line", labelKey: "chart\.series\.players" \}/);
  assert.match(appJs, /"28d": \{ type: "candlestick", labelKey: "chart\.series\.playersBucket", bucketKey: "bucket\.4h", unit: "hour", size: 4 \}/);
  assert.match(appJs, /"90d": \{ type: "candlestick", labelKey: "chart\.series\.playersBucket", bucketKey: "bucket\.12h", unit: "hour", size: 12 \}/);
  assert.match(appJs, /"180d": \{ type: "candlestick", labelKey: "chart\.series\.playersBucket", bucketKey: "bucket\.1d", unit: "day", size: 1 \}/);
  assert.match(appJs, /"1y": \{ type: "candlestick", labelKey: "chart\.series\.playersBucket", bucketKey: "bucket\.48h", unit: "day", size: 2 \}/);
  assert.match(appJs, /"3y": \{ type: "candlestick", labelKey: "chart\.series\.playersBucket", bucketKey: "bucket\.1w", unit: "week", size: 1 \}/);
  assert.match(appJs, /all: \{ type: "candlestick", labelKey: "chart\.series\.playersBucket", bucketKey: "bucket\.1w", unit: "week", size: 1 \}/);
});

test("timeline candle tooltip uses compact bucket ranges", () => {
  const { formatBucketRange, setCurrentRangeForTest, buildTimelineOptions } = loadAppTests();
  const sameDay = formatBucketRange(new Date(2026, 3, 24, 12).getTime(), {
    unit: "hour",
    size: 4,
  });
  const halfDay = formatBucketRange(new Date(2026, 3, 24, 12).getTime(), {
    unit: "hour",
    size: 12,
  });
  const oneDay = formatBucketRange(new Date(2026, 3, 24).getTime(), {
    unit: "day",
    size: 1,
  });
  const multiDay = formatBucketRange(new Date(2026, 3, 24).getTime(), {
    unit: "day",
    size: 2,
  });

  assert.match(sameDay, /<br \/>/);
  assert.match(sameDay, /12:00 - 15:59/);
  assert.match(halfDay, /12:00 - 23:59/);
  assert.doesNotMatch(halfDay, /Apr 25/);
  assert.doesNotMatch(oneDay, / - /);
  assert.doesNotMatch(multiDay, /<br \/>/);
  assert.match(multiDay, /Apr 24 - Apr 25/);
  assert.match(multiDay, /2026/);

  setCurrentRangeForTest("28d");
  const options = buildTimelineOptions([
    { date: new Date(2026, 3, 24, 12), count: 1200 },
    { date: new Date(2026, 3, 24, 13), count: 1250 },
  ]);
  const tooltip = options.tooltip.formatter([{ value: options.series[0].data[0] }]);

  assert.match(tooltip, /^<strong>Apr 24, 2026<br \/>12:00 - 15:59<\/strong><br \/>/);
});


test("weekly candlesticks align to local calendar week boundaries", () => {
  const { buildCandles } = loadAppTests();
  const points = [
    { date: new Date(2024, 11, 29, 12), count: 1200 },
    { date: new Date(2024, 11, 30, 12), count: 1300 },
    { date: new Date(2025, 0, 4, 12), count: 1100 },
    { date: new Date(2025, 0, 5, 12), count: 1400 },
    { date: new Date(2025, 0, 6, 12), count: 1500 },
  ];

  const candles = buildCandles(points, { unit: "week", size: 1 });

  const normalizedCandles = candles.map(([time, open, close, low, high]) => ([
    new Date(time).getFullYear(),
    new Date(time).getMonth(),
    new Date(time).getDate(),
    open,
    close,
    low,
    high,
  ]));

  assert.equal(
    JSON.stringify(normalizedCandles),
    JSON.stringify([
      [2024, 11, 29, 1200, 1100, 1100, 1300],
      [2025, 0, 5, 1400, 1500, 1400, 1500],
    ]),
  );
});

test("stats load helper only runs while the document is visible", async () => {
  const { context, getFetchCount, loadStatsWhenVisible } = loadAppTests();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(getFetchCount(), 3);

  context.document.visibilityState = "hidden";
  loadStatsWhenVisible();
  await Promise.resolve();
  assert.equal(getFetchCount(), 3);

  context.document.visibilityState = "visible";
  loadStatsWhenVisible();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getFetchCount(), 6);
});

test("normalization accepts compact epoch-second rows", () => {
  const { normalizePayload } = loadAppTests();
  const points = normalizePayload({
    data: [
      [1776945603, 1459],
      [1776946503, 1460],
    ],
  });

  assert.equal(points.length, 2);
  assert.equal(points[0].date.toISOString(), "2026-04-23T12:00:03.000Z");
  assert.equal(points[0].count, 1459);
});

test("normalization truncates source timestamps to seconds", () => {
  const { normalizePayload } = loadAppTests();
  const points = normalizePayload([
    { timestamp: "2026-04-23 12:00:03.581+00", usercount: 1459 },
  ]);

  assert.equal(points.length, 1);
  assert.equal(points[0].date.toISOString(), "2026-04-23T12:00:03.000Z");
});

test("archive selection skips chunks overlapping latest payload", () => {
  const { selectArchiveChunks } = loadAppTests();
  const chunks = selectArchiveChunks(
    {
      chunks: [
        { file: "2025.json", period: "2025", end: 1767224700 },
        { file: "2026-03.json", period: "2026-03", end: 1775000707 },
        { file: "2026-04.json", period: "2026-04", end: 1777592707 },
      ],
    },
    {
      data: [
        [1777594504, 1700],
        [1775001608, 1317],
      ],
    },
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.file),
    ["2025.json", "2026-03.json"],
  );
});

test("ytd uses adaptive timeline thresholds", () => {
  assert.match(appJs, /if \(range !== "ytd"\)/);
  assert.match(appJs, /if \(spanMs <= RANGE_WINDOW_MS\["7d"\]\) return TIMELINE_RANGE_CONFIG\["7d"\];/);
  assert.match(appJs, /if \(spanMs <= RANGE_WINDOW_MS\["28d"\]\) return TIMELINE_RANGE_CONFIG\["28d"\];/);
  assert.match(appJs, /if \(spanMs <= RANGE_WINDOW_MS\["90d"\]\) return TIMELINE_RANGE_CONFIG\["90d"\];/);
  assert.match(appJs, /if \(spanMs <= RANGE_WINDOW_MS\["180d"\]\) return TIMELINE_RANGE_CONFIG\["180d"\];/);
  assert.match(appJs, /return TIMELINE_RANGE_CONFIG\["1y"\];/);
});

test("timeline y-axis is fixed at zero only for raw line ranges", () => {
  assert.match(
    appJs,
    /min:\s*config\.type === "candlestick"\s*\?\s*\(value\) => Math\.max\(0, Math\.floor\(value\.min \* 0\.94\)\)\s*:\s*0/,
  );
});

test("timeline leaves room between x-axis labels and cursor", () => {
  const { buildTimelineOptions } = loadAppTests();
  const points = Array.from({ length: 8 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 3, 20, index, 0, 0)),
    count: 1200 + index,
  }));
  const options = buildTimelineOptions(points);

  assert.equal(options.grid.bottom, 76);
  assert.equal(options.dataZoom[1].height, 24);
  assert.equal(options.dataZoom[1].bottom, 16);
});

test("timeline axis labels rerender with the selected locale", async () => {
  const {
    buildTimelineOptions,
    dispatchLanguageChange,
    renderedOptions,
    setCurrentRangeForTest,
    setLangForTest,
  } = loadAppTests();
  const timestamp = new Date(2026, 3, 24, 12, 0, 0).getTime();
  const points = [{ date: new Date(timestamp), count: 1200 }];

  setCurrentRangeForTest("7d");
  setLangForTest("en");
  const englishOptions = buildTimelineOptions(points);
  assert.match(englishOptions.xAxis.axisLabel.formatter(timestamp), /^Apr 24\n12:00$/);
  assert.equal(englishOptions.tooltip.valueFormatter(1200), "1,200");

  setLangForTest("zh-CN");
  const chineseOptions = buildTimelineOptions(points);
  assert.match(chineseOptions.xAxis.axisLabel.formatter(timestamp), /^4月24日\n12:00$/);
  setCurrentRangeForTest("28d");
  const chineseCandleOptions = buildTimelineOptions([
    { date: new Date(timestamp), count: 1200 },
    { date: new Date(timestamp + 60 * 60 * 1000), count: 1250 },
  ]);
  assert.match(
    chineseCandleOptions.tooltip.formatter([{ value: chineseCandleOptions.series[0].data[0] }]),
    /起始/,
  );

  await Promise.resolve();
  await Promise.resolve();
  renderedOptions.length = 0;
  dispatchLanguageChange("zh-CN");
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(renderedOptions.length > 0);
  const rendered = renderedOptions.at(-1);
  assert.match(rendered.xAxis.axisLabel.formatter(timestamp), /^4月24日$/);
});

test("expanded locales drive chart labels, tooltips, numbers, dates, and weekdays", async () => {
  const {
    buildDistributionOptions,
    buildHeatmapOptions,
    buildTimelineOptions,
    dispatchLanguageChange,
    renderedOptions,
    setActiveChartForTest,
    setCurrentRangeForTest,
    setLangForTest,
  } = loadAppTests();
  const date = new Date(2026, 3, 24, 12);
  const timestamp = date.getTime();
  const timeFormat = (locale) => new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const shortDateFormat = (locale) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
  const weekdayFormat = (locale, weekdayDate) => new Intl.DateTimeFormat(locale, {
    weekday: "short",
  }).format(weekdayDate);

  setLangForTest("es");
  setCurrentRangeForTest("7d");
  const timelineOptions = buildTimelineOptions([{ date, count: 1234567 }]);
  assert.equal(timelineOptions.series[0].name, i18nMessages.es["chart.series.players"]);
  assert.equal(timelineOptions.tooltip.valueFormatter(1234567), (1234567).toLocaleString("es"));
  assert.equal(
    timelineOptions.xAxis.axisLabel.formatter(timestamp),
    `${shortDateFormat("es")}\n${timeFormat("es")}`,
  );

  setCurrentRangeForTest("28d");
  const candleOptions = buildTimelineOptions([
    { date, count: 1200 },
    { date: new Date(timestamp + 60 * 60 * 1000), count: 1300 },
  ]);
  assert.match(candleOptions.tooltip.formatter([{ value: candleOptions.series[0].data[0] }]), /Inicio/);

  const heatmapOptions = buildHeatmapOptions([
    { date: new Date(2026, 3, 19, 12), count: 1000 },
    { date: new Date(2026, 3, 20, 12), count: 1200 },
  ]);
  assert.equal(heatmapOptions.yAxis.data[0], weekdayFormat("es", new Date(2026, 0, 4, 12)));
  assert.match(
    heatmapOptions.tooltip.formatter({ value: heatmapOptions.series[0].data[0] }),
    new RegExp(`^<strong>${heatmapOptions.yAxis.data[0]} `),
  );

  const distributionOptions = buildDistributionOptions([
    { date, count: 1000 },
    { date: new Date(timestamp + 60 * 60 * 1000), count: 1500 },
  ]);
  assert.equal(distributionOptions.series[0].name, i18nMessages.es["chart.series.samplesPercent"]);
  assert.match(distributionOptions.tooltip.formatter([{ dataIndex: 10, value: 50 }]), /muestras/);

  await Promise.resolve();
  await Promise.resolve();
  setActiveChartForTest("timeline");
  setCurrentRangeForTest("7d");
  renderedOptions.length = 0;
  dispatchLanguageChange("ja");
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(renderedOptions.length > 0);
  const rendered = renderedOptions.at(-1);
  assert.equal(rendered.series[0].name, i18nMessages.ja["chart.series.players"]);
  assert.equal(
    rendered.xAxis.axisLabel.formatter(timestamp),
    `${shortDateFormat("ja")}\n${timeFormat("ja")}`,
  );
});

test("i18n renders the details timezone note with localized native timezone names", () => {
  const { i18n, note } = loadI18nTests();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const expectedTimeZoneName = (locale) => {
    if (!timeZone) {
      return locale === "zh-CN" ? "你的本地时区" : "your local timezone";
    }

    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "long" })
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value || timeZone
    );
  };

  i18n.applyI18n("en");

  assert.equal(note.textContent, `Times shown in ${expectedTimeZoneName("en")}.`);
  assert.equal(i18n.formatTimeZoneName("zh-CN"), expectedTimeZoneName("zh-CN"));

  i18n.applyI18n("zh-CN");
  assert.equal(note.textContent, `时间以${expectedTimeZoneName("zh-CN")}显示。`);

  i18n.applyI18n("en");
  i18n.setLang("zh-CN");
  assert.equal(note.textContent, `时间以${expectedTimeZoneName("zh-CN")}显示。`);
});

test("removed chart tabs stay removed from the UI", () => {
  assert.doesNotMatch(indexHtml, /data-chart="daily"/);
  assert.doesNotMatch(indexHtml, /data-chart="monthly"/);
  assert.match(indexHtml, /data-chart="timeline"/);
  assert.match(indexHtml, /data-chart="heatmap"/);
  assert.match(indexHtml, /data-chart="distribution"/);
});

test("normalization removes known bad historical samples", () => {
  const { normalizePayload } = loadAppTests();
  const points = normalizePayload([
    { timestamp: "2020-06-15 15:30:55.663+00", usercount: 1832 },
    { timestamp: "2020-06-15 15:30:55.664+00", usercount: 1832 },
    { timestamp: "2020-06-22 00:19:46.558+00", usercount: 2045 },
    { timestamp: "2020-06-22 01:00:00.527+00", usercount: 2125 },
    { timestamp: "2020-06-22 01:00:00.528+00", usercount: 2125 },
    { timestamp: "2020-06-24 17:30:04.320+00", usercount: 1 },
    { timestamp: "2020-06-24 17:45:04.796+00", usercount: 991 },
  ]);

  assert.deepEqual(
    points.map((point) => [point.date.toISOString(), point.count]),
    [
      ["2020-06-15T15:30:55.000Z", 1832],
      ["2020-06-15T15:30:55.000Z", 1832],
      ["2020-06-24T17:45:04.000Z", 991],
    ],
  );
});

test("last sample time uses 24-hour format", () => {
  const { formatTime } = loadAppTests();
  const formatted = formatTime(new Date(2026, 0, 1, 23, 5, 0));

  assert.doesNotMatch(formatted, /AM|PM/i);
  assert.match(formatted, /23/);
});

test("heatmap bounds use the fixed score scale", () => {
  const { getHeatmapVisualBounds } = loadAppTests();
  const bounds = getHeatmapVisualBounds();

  assert.equal(bounds.min, 0);
  assert.equal(bounds.max, 100);
});

test("heatmap options use score values for color and average counts for tooltip", () => {
  const { buildHeatmapOptions, formatWeekdayLabels } = loadAppTests();
  const counts = [0, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2500, 3000, 3600];
  const points = counts.map((count, index) => ({
    date: new Date(Date.UTC(2026, 3, 20, index, 0, 0)),
    count,
  }));
  const options = buildHeatmapOptions(points);
  const dataByCount = new Map(options.series[0].data.map((item) => [item[3], item[2]]));

  assert.equal(options.grid.bottom, 88);
  assert.equal(options.visualMap.bottom, 18);
  assert.equal(options.visualMap.min, 0);
  assert.equal(options.visualMap.max, 100);
  assert.equal(options.visualMap.dimension, 2);
  assert.deepEqual(options.yAxis.data, formatWeekdayLabels());
  assert.equal(options.yAxis.data[0], "Sun");
  assert.equal(dataByCount.get(0), 0);
  assert.equal(dataByCount.get(600), 12);
  assert.equal(dataByCount.get(800), 25);
  assert.equal(dataByCount.get(1000), 40);
  assert.equal(dataByCount.get(1200), 55);
  assert.equal(dataByCount.get(1400), 68);
  assert.equal(dataByCount.get(1600), 78);
  assert.equal(dataByCount.get(1800), 86);
  assert.equal(dataByCount.get(2000), 94);
  assert.equal(dataByCount.get(2500), 98);
  assert.equal(dataByCount.get(3000), 100);
  assert.equal(dataByCount.get(3600), 100);
  assert.match(options.tooltip.formatter({ value: options.series[0].data[4] }), /<strong>.*<\/strong><br \/>avg: 1,200$/);
});

test("heatmap weekday labels rerender with the selected locale", async () => {
  const {
    buildHeatmapOptions,
    dispatchLanguageChange,
    renderedOptions,
    setActiveChartForTest,
    setLangForTest,
  } = loadAppTests();
  const points = [
    { date: new Date(2026, 3, 19, 12), count: 1000 },
    { date: new Date(2026, 3, 20, 12), count: 1200 },
  ];

  setLangForTest("en");
  const englishOptions = buildHeatmapOptions(points);
  assert.equal(englishOptions.yAxis.data[0], "Sun");
  assert.match(englishOptions.tooltip.formatter({ value: englishOptions.series[0].data[0] }), /^<strong>Sun /);

  setLangForTest("zh-CN");
  const chineseOptions = buildHeatmapOptions(points);
  assert.equal(chineseOptions.yAxis.data[0], "周日");
  assert.match(chineseOptions.tooltip.formatter({ value: chineseOptions.series[0].data[0] }), /^<strong>周日 /);

  await Promise.resolve();
  await Promise.resolve();
  setActiveChartForTest("heatmap");
  renderedOptions.length = 0;
  dispatchLanguageChange("zh-CN");
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(renderedOptions.length > 0);
  assert.equal(renderedOptions.at(-1).yAxis.data[0], "周日");
});

test("aggregated heatmap tooltip labels percentiles by visible timespan", () => {
  const { buildHeatmapOptions, setCurrentRangeForTest } = loadAppTests();
  const makePoints = (days) =>
    Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, index + 1, 12, 0, 0)),
      count: 1000 + index * 10,
    }));

  setCurrentRangeForTest("28d");
  const monthOptions = buildHeatmapOptions(makePoints(28));
  const monthTooltip = monthOptions.tooltip.formatter({ value: monthOptions.series[0].data[0] });

  assert.match(monthTooltip, /avg: /);
  assert.match(monthTooltip, /p50: /);
  assert.doesNotMatch(monthTooltip, /p90: /);
  assert.doesNotMatch(monthTooltip, /p10: /);

  setCurrentRangeForTest("90d");
  const quarterOptions = buildHeatmapOptions(makePoints(90));
  const quarterTooltip = quarterOptions.tooltip.formatter({ value: quarterOptions.series[0].data[0] });

  assert.match(quarterTooltip, /p90: .*<br \/>p50: .*<br \/>p10: /);
  assert.doesNotMatch(quarterTooltip, /p75: /);
  assert.doesNotMatch(quarterTooltip, /p25: /);

  setCurrentRangeForTest("3y");
  const threeYearOptions = buildHeatmapOptions(makePoints(3 * 365));
  const threeYearTooltip = threeYearOptions.tooltip.formatter({ value: threeYearOptions.series[0].data[0] });

  assert.match(threeYearTooltip, /p90: .*<br \/>p50: .*<br \/>p10: /);
  assert.doesNotMatch(threeYearTooltip, /p75: /);
  assert.doesNotMatch(threeYearTooltip, /p25: /);
});

test("distribution buckets include low-count samples in the regular histogram", () => {
  const { buildDistributionBuckets } = loadAppTests();
  const buckets = buildDistributionBuckets(distributionOutageCountsFixture());

  assert.equal(buckets[0].label, "0-99");
  assert.equal(buckets[0].count, 15);
  assert.equal(buckets[0].kind, undefined);
  assert.equal(buckets[1].label, "100-199");
  assert.equal(buckets[1].count, 0);
});

test("distribution buckets keep the normal histogram when no outage gap exists", () => {
  const { buildDistributionBuckets } = loadAppTests();
  const buckets = buildDistributionBuckets(normalCountsFixture());

  assert.equal(buckets[0].label, "0-99");
  assert.equal(buckets[0].count, 0);
  assert.equal(buckets[10].label, "1,000-1,099");
  assert.equal(buckets[10].count, 9);
});

test("distribution options use one visual style for every bucket", () => {
  const { buildDistributionOptions } = loadAppTests();
  const points = distributionOutageCountsFixture().map((count, index) => ({
    date: new Date(Date.UTC(2026, 3, 20, index, 0, 0)),
    count,
  }));
  const options = buildDistributionOptions(points);

  assert.equal(options.xAxis.data[0], "0-99");
  assert.equal(options.series[0].name, "Samples (%)");
  assert.equal(options.series[0].data[0], 37.5);
  assert.equal(options.series[0].itemStyle.color, "#f1c44f");
  assert.equal(options.yAxis.axisLabel.formatter(37.5), "38%");
  assert.equal(options.tooltip.formatter([{ dataIndex: 0, value: 37.5 }]), "0-99<br />38% of samples<br />15 samples");
});

function outageCountsFixture() {
  return [
    5, 6, 258, 297, 329, 770, 813, 925, 957, 971,
    1012, 1040, 1088, 1122, 1181, 1214, 1290, 1362, 1499, 1580,
    1595, 1601, 1615, 1628, 1640, 1654, 1668, 1681, 1694, 1708,
    1720, 1734, 1749, 1761, 1775, 1790, 1804, 1818, 1832, 1846,
  ];
}

function normalCountsFixture() {
  return [
    998, 1019, 1031, 1065, 1069, 1118, 1123, 1124, 1140, 1151,
    1165, 1170, 1204, 1247, 1279, 1330, 1418, 1495, 1702, 1851,
    1005, 1028, 1044, 1078, 1094, 1132, 1148, 1160, 1184, 1217,
    1259, 1291, 1344, 1392, 1458, 1520, 1587, 1635, 1760, 1810,
  ];
}

function distributionOutageCountsFixture() {
  return [
    0, 1, 1, 6, 6, 6, 6, 6, 6, 6,
    6, 11, 28, 28, 29, 448, 520, 657, 662, 721,
    760, 810, 813, 848, 853, 925, 957, 971, 1012, 1040,
    1088, 1122, 1181, 1214, 1290, 1362, 1499, 1580, 1694, 1846,
  ];
}
