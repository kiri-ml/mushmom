(() => {
  const fallbackLang = "en-US";
  const storageKey = "mushmom.lang";
  const dataUrl = "/i18n.json";

  const state = {
    messages: { [fallbackLang]: {} },
    localeRegistry: [{ code: fallbackLang, label: fallbackLang, aliases: [fallbackLang], documentLang: fallbackLang }],
    localeLabels: { [fallbackLang]: fallbackLang },
    localeByCode: {},
    ready: false,
  };

  function normalizeAlias(alias) {
    return String(alias || "").trim().toLowerCase();
  }

  function buildLocaleByCode(localeRegistry = []) {
    return Object.fromEntries(
      localeRegistry
        .filter((locale) => locale?.code)
        .map((locale) => [locale.code, locale]),
    );
  }

  function aliasMatches(value, alias) {
    if (!alias) return false;
    if (alias.endsWith("*")) {
      return value.startsWith(alias.slice(0, -1));
    }

    return value === alias;
  }

  function matchesLocale(locale, lower) {
    return Array.isArray(locale?.aliases)
      && locale.aliases.some((alias) => aliasMatches(lower, normalizeAlias(alias)));
  }

  function setI18nData(data = {}) {
    const messages = data.messages && typeof data.messages === "object"
      ? data.messages
      : { [fallbackLang]: {} };
    const localeRegistry = Array.isArray(data.localeRegistry) && data.localeRegistry.length > 0
      ? data.localeRegistry
      : [{ code: fallbackLang, label: fallbackLang, aliases: [fallbackLang], documentLang: fallbackLang }];

    state.messages = messages;
    state.localeRegistry = localeRegistry;
    state.localeLabels = Object.fromEntries(
      localeRegistry
        .filter((locale) => locale?.code)
        .map(({ code, label }) => [code, label || code]),
    );
    state.localeByCode = buildLocaleByCode(localeRegistry);
    state.ready = true;
  }

  async function loadI18nData(fetcher) {
    const resolvedFetcher = fetcher || window.fetch?.bind(window);

    if (!resolvedFetcher) {
      throw new Error("window.fetch is unavailable");
    }

    const response = await resolvedFetcher(dataUrl, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`${dataUrl} request failed: ${response.status}`);
    }

    const data = await response.json();
    setI18nData(data);
    return data;
  }

  function findLocaleByAlias(lower) {
    return state.localeRegistry.find((locale) => matchesLocale(locale, lower));
  }

  function getLocaleConfig(lang) {
    const normalized = normalizeLang(lang);
    return state.localeByCode[normalized] || state.localeByCode[fallbackLang] || null;
  }

  function normalizeLang(lang) {
    const { messages, localeByCode } = state;
    if (!lang) return fallbackLang;

    const value = String(lang).trim();
    if (messages[value] && localeByCode[value]) return value;

    const lower = value.toLowerCase();
    const matchingLocale = findLocaleByAlias(lower);

    if (matchingLocale?.code && messages[matchingLocale.code]) {
      return matchingLocale.code;
    }

    return fallbackLang;
  }

  function getBrowserLang() {
    const langs = navigator.languages?.length
      ? navigator.languages
      : [navigator.language || ""];

    for (const lang of langs) {
      const normalized = normalizeLang(lang);
      const lower = String(lang).toLowerCase();
      const isEnglish = lower === fallbackLang.toLowerCase() || lower.startsWith("en-");
      if (normalized !== fallbackLang || isEnglish) return normalized;
    }

    return fallbackLang;
  }

  function getCurrentLang() {
    return normalizeLang(localStorage.getItem(storageKey) || getBrowserLang());
  }

  function interpolate(template, params = {}) {
    return String(template).replace(/\{([^{}]+)\}/g, (match, key) => {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
    });
  }

  function t(key, params = {}, lang = getCurrentLang()) {
    const normalized = normalizeLang(lang);
    const value = state.messages[normalized]?.[key] ?? state.messages[fallbackLang]?.[key] ?? key;
    return interpolate(value, params);
  }

  function hasTranslation(key, lang = getCurrentLang()) {
    const normalized = normalizeLang(lang);
    return state.messages[normalized]?.[key] != null || state.messages[fallbackLang]?.[key] != null;
  }

  function setTranslatedAttribute(selector, datasetKey, attr, lang) {
    document.querySelectorAll(selector).forEach((el) => {
      const key = el.dataset[datasetKey];
      if (key && hasTranslation(key, lang)) el.setAttribute(attr, t(key, {}, lang));
    });
  }

  function getCurrentTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  }

  function formatTimeZoneName(lang = getCurrentLang()) {
    const normalized = normalizeLang(lang);
    const timeZone = getCurrentTimeZone();
    const localeConfig = getLocaleConfig(normalized);
    const formatterLocale = localeConfig?.documentLang || normalized;

    if (!timeZone) return t("details.fallbackTimeZone", {}, normalized);

    try {
      const formatter = new Intl.DateTimeFormat(formatterLocale, {
        timeZone,
        timeZoneName: "long",
      });
      const timeZoneName = formatter
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value;

      return timeZoneName || timeZone;
    } catch (error) {
      console.warn(error);
      return timeZone;
    }
  }

  function updateTimeZoneNotes(lang = getCurrentLang()) {
    const normalized = normalizeLang(lang);
    const timeZoneName = formatTimeZoneName(normalized);

    document.querySelectorAll("[data-i18n-timezone-note]").forEach((el) => {
      const key = el.dataset.i18nTimezoneNote || "details.localTimezone";
      el.textContent = t(key, { timeZoneName }, normalized);
    });
  }

  function getSupportedLocales() {
    return state.localeRegistry.filter((locale) => locale?.code && state.messages[locale.code]);
  }

  function renderLanguageSelector() {
    const selector = document.querySelector("#language-select");
    if (!selector) return;

    const fragment = document.createDocumentFragment();

    getSupportedLocales().forEach(({ code, label }) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label || code;
      fragment.append(option);
    });

    selector.replaceChildren(fragment);
  }

  function applyI18n(lang = getCurrentLang()) {
    const normalized = normalizeLang(lang);
    const localeConfig = getLocaleConfig(normalized);

    document.documentElement.lang = localeConfig?.documentLang || normalized;

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      if (key && hasTranslation(key, normalized)) {
        el.textContent = t(key, {}, normalized);
      }
    });

    setTranslatedAttribute("[data-i18n-title]", "i18nTitle", "title", normalized);
    setTranslatedAttribute("[data-i18n-placeholder]", "i18nPlaceholder", "placeholder", normalized);
    setTranslatedAttribute("[data-i18n-aria-label]", "i18nAriaLabel", "aria-label", normalized);
    setTranslatedAttribute("[data-i18n-alt]", "i18nAlt", "alt", normalized);
    setTranslatedAttribute("[data-i18n-content]", "i18nContent", "content", normalized);
    updateTimeZoneNotes(normalized);

    const selector = document.querySelector("#language-select");
    if (selector) selector.value = normalized;

    return normalized;
  }

  function setLang(lang) {
    const normalized = normalizeLang(lang);
    localStorage.setItem(storageKey, normalized);
    applyI18n(normalized);

    window.dispatchEvent(
      new CustomEvent("mushmom:languagechange", {
        detail: { lang: normalized },
      }),
    );

    return normalized;
  }

  function bindLanguageSelector() {
    const selector = document.querySelector("#language-select");
    if (!selector) return;

    selector.value = getCurrentLang();
    selector.addEventListener("change", (event) => {
      setLang(event.target.value);
    });
  }

  async function initI18n() {
    await loadI18nData();
    renderLanguageSelector();
    applyI18n();
    bindLanguageSelector();
    return api;
  }

  const api = {
    t,
    getCurrentLang,
    setLang,
    applyI18n,
    normalizeLang,
    getCurrentTimeZone,
    formatTimeZoneName,
    updateTimeZoneNotes,
    renderLanguageSelector,
    getSupportedLocales,
    getLocaleConfig,
    loadI18nData,
    initI18n,
    setI18nData,
    ready: null,
    get messages() {
      return state.messages;
    },
    get localeRegistry() {
      return state.localeRegistry;
    },
    get localeLabels() {
      return state.localeLabels;
    },
  };

  window.MushmomI18n = api;

  api.ready = initI18n().catch((error) => {
    console.error("Failed to initialize i18n", error);
    applyI18n(fallbackLang);
  });
})();
