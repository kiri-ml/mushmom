/// <reference path="../globals.d.ts" />

import { bundledLocaleRegistry, bundledMessages } from "./data";

type MessageCatalog = Record<string, string>;
type MessageMap = Record<string, MessageCatalog>;

const fallbackLang = "en-US";
const fallbackMessages: MessageMap = {
  [fallbackLang]: {
    "status.loading": "LOADING",
    "status.ready": "READY",
    "status.failed": "FAILED",
  },
};
const storageKey = "mushmom.lang";

function defaultLocaleConfig(): LocaleConfig {
  return { code: fallbackLang, label: fallbackLang, aliases: [fallbackLang], documentLang: fallbackLang };
}

function cloneFallbackMessages(): MessageMap {
  return {
    [fallbackLang]: {
      ...fallbackMessages[fallbackLang],
    },
  };
}

const state: {
  messages: MessageMap;
  localeRegistry: LocaleConfig[];
  localeLabels: Record<string, string>;
  localeByCode: Record<string, LocaleConfig>;
  ready: boolean;
} = {
  messages: cloneFallbackMessages(),
  localeRegistry: [defaultLocaleConfig()],
  localeLabels: { [fallbackLang]: fallbackLang },
  localeByCode: {},
  ready: false,
};

function normalizeAlias(alias: unknown): string {
  return String(alias || "").trim().toLowerCase();
}

function buildLocaleByCode(localeRegistry: LocaleConfig[] = []): Record<string, LocaleConfig> {
  return Object.fromEntries(
    localeRegistry
      .filter((locale) => locale.code)
      .map((locale) => [locale.code, locale]),
  );
}

function aliasMatches(value: string, alias: string): boolean {
  if (!alias) return false;
  if (alias.endsWith("*")) {
    return value.startsWith(alias.slice(0, -1));
  }

  return value === alias;
}

function matchesLocale(locale: LocaleConfig, lower: string): boolean {
  return locale.aliases.some((alias) => aliasMatches(lower, normalizeAlias(alias)));
}

function setI18nData(data: I18nData = {}): void {
  const messages = data.messages && typeof data.messages === "object"
    ? {
        ...cloneFallbackMessages(),
        ...data.messages,
        [fallbackLang]: {
          ...fallbackMessages[fallbackLang],
          ...(data.messages[fallbackLang] || {}),
        },
      }
    : cloneFallbackMessages();
  const localeRegistry = Array.isArray(data.localeRegistry) && data.localeRegistry.length > 0
    ? data.localeRegistry
    : [defaultLocaleConfig()];

  state.messages = messages;
  state.localeRegistry = localeRegistry;
  state.localeLabels = Object.fromEntries(localeRegistry.map(({ code, label }) => [code, label || code]));
  state.localeByCode = buildLocaleByCode(localeRegistry);
  state.ready = true;
}

async function loadI18nData(): Promise<I18nData> {
  const data: I18nData = {
    localeRegistry: bundledLocaleRegistry,
    messages: bundledMessages,
  };
  setI18nData(data);
  return data;
}

function findLocaleByAlias(lower: string): LocaleConfig | undefined {
  return state.localeRegistry.find((locale) => matchesLocale(locale, lower));
}

function normalizeLang(lang: string | null | undefined): string {
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

function getLocaleConfig(lang: string): LocaleConfig | null {
  const normalized = normalizeLang(lang);
  return state.localeByCode[normalized] || state.localeByCode[fallbackLang] || null;
}

function getBrowserLang(): string {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ""];

  for (const lang of langs) {
    const normalized = normalizeLang(lang);
    const lower = String(lang).toLowerCase();
    const isEnglish = lower === fallbackLang.toLowerCase() || lower.startsWith("en-");
    if (normalized !== fallbackLang || isEnglish) return normalized;
  }

  return fallbackLang;
}

function getCurrentLang(): string {
  return normalizeLang(localStorage.getItem(storageKey) || getBrowserLang());
}

function interpolate(template: string, params: SharedTranslationParams = {}): string {
  return String(template).replace(/\{([^{}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

function t(key: string, params: SharedTranslationParams = {}, lang: string = getCurrentLang()): string {
  const normalized = normalizeLang(lang);
  const fallbackValue = state.messages[fallbackLang]?.[key];
  const value = state.messages[normalized]?.[key] ?? fallbackValue ?? key;

  if (value === key && typeof fallbackValue === "string") {
    return interpolate(fallbackValue, params);
  }

  return interpolate(value, params);
}

function hasTranslation(key: string, lang: string = getCurrentLang()): boolean {
  const normalized = normalizeLang(lang);
  return state.messages[normalized]?.[key] != null || state.messages[fallbackLang]?.[key] != null;
}

function setTranslatedAttribute(selector: string, datasetKey: string, attr: string, lang: string): void {
  document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const key = (el.dataset as DOMStringMap & Record<string, string | undefined>)[datasetKey];
    if (key && hasTranslation(key, lang)) el.setAttribute(attr, t(key, {}, lang));
  });
}

function getCurrentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
}

function formatTimeZoneName(lang: string = getCurrentLang()): string {
  const normalized = normalizeLang(lang);
  const timeZone = getCurrentTimeZone();
  const localeConfig = getLocaleConfig(normalized);
  const formatterLocale = localeConfig?.documentLang || normalized;

  if (!timeZone) return t("details.fallbackTimeZone", {}, normalized);

  try {
    const formatter = new Intl.DateTimeFormat(formatterLocale, { timeZone, timeZoneName: "long" });
    const timeZoneName = formatter
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;

    return timeZoneName || timeZone;
  } catch (error) {
    console.warn(error);
    return timeZone;
  }
}

function updateTimeZoneNotes(lang: string = getCurrentLang()): void {
  const normalized = normalizeLang(lang);
  const timeZoneName = formatTimeZoneName(normalized);

  document.querySelectorAll<HTMLElement>("[data-i18n-timezone-note]").forEach((el) => {
    const key = el.dataset.i18nTimezoneNote || "details.localTimezone";
    el.textContent = t(key, { timeZoneName }, normalized);
  });
}

function getSupportedLocales(): LocaleConfig[] {
  return state.localeRegistry.filter((locale) => locale.code && state.messages[locale.code]);
}

function renderLanguageSelector(): void {
  const selector = document.querySelector<HTMLSelectElement>("#language-select");
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

function applyI18n(lang: string = getCurrentLang()): string {
  const normalized = normalizeLang(lang);
  const localeConfig = getLocaleConfig(normalized);

  document.documentElement.lang = localeConfig?.documentLang || normalized;

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
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

  const selector = document.querySelector<HTMLSelectElement>("#language-select");
  if (selector) selector.value = normalized;

  return normalized;
}

function setLang(lang: string): string {
  const normalized = normalizeLang(lang);
  localStorage.setItem(storageKey, normalized);
  applyI18n(normalized);
  window.dispatchEvent(new CustomEvent("mushmom:languagechange", { detail: { lang: normalized } }));
  return normalized;
}

function bindLanguageSelector(): void {
  const selector = document.querySelector<HTMLSelectElement>("#language-select");
  if (!selector) return;

  selector.value = getCurrentLang();
  selector.addEventListener("change", (event) => {
    const target = event.target;
    if (target && "value" in target) {
      setLang(String((target as HTMLSelectElement).value));
    }
  });
}

async function initI18n(): Promise<MushmomI18nApi> {
  await loadI18nData();
  renderLanguageSelector();
  applyI18n();
  bindLanguageSelector();
  return api;
}

const api: MushmomI18nApi = {
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

export { api as MushmomI18n, bundledLocaleRegistry, bundledMessages, initI18n, loadI18nData, setI18nData };
