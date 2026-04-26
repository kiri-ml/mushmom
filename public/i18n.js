(() => {
  const fallbackLang = "en";
  const storageKey = "mushmom.lang";
  const messages = window.MUSHMOM_I18N_MESSAGES || { en: {} };

  function normalizeLang(lang) {
    if (!lang) return fallbackLang;

    const value = String(lang).trim();
    if (messages[value]) return value;

    const lower = value.toLowerCase();

    if (lower === "zh" || lower === "zh-cn" || lower === "zh-sg" || lower.startsWith("zh-hans")) {
      return messages["zh-CN"] ? "zh-CN" : fallbackLang;
    }

    if (
      lower === "zh-tw" ||
      lower === "zh-hk" ||
      lower === "zh-mo" ||
      lower.startsWith("zh-hant")
    ) {
      return messages["zh-TW"] ? "zh-TW" : fallbackLang;
    }

    if (lower === "pt" || lower.startsWith("pt-")) {
      return messages["pt-BR"] ? "pt-BR" : fallbackLang;
    }

    const base = lower.split("-")[0];
    if (messages[base]) return base;

    return fallbackLang;
  }

  function getBrowserLang() {
    const langs = navigator.languages?.length
      ? navigator.languages
      : [navigator.language || ""];

    for (const lang of langs) {
      const normalized = normalizeLang(lang);
      const lower = String(lang).toLowerCase();
      const isEnglish = lower === fallbackLang || lower.startsWith(`${fallbackLang}-`);
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
    const value = messages[normalized]?.[key] ?? messages[fallbackLang]?.[key] ?? key;
    return interpolate(value, params);
  }

  function setTranslatedAttribute(selector, datasetKey, attr, lang) {
    document.querySelectorAll(selector).forEach((el) => {
      const key = el.dataset[datasetKey];
      if (key) el.setAttribute(attr, t(key, {}, lang));
    });
  }

  function getCurrentTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  }

  function formatTimeZoneName(lang = getCurrentLang()) {
    const normalized = normalizeLang(lang);
    const timeZone = getCurrentTimeZone();

    if (!timeZone) return t("details.fallbackTimeZone", {}, normalized);

    try {
      const formatter = new Intl.DateTimeFormat(normalized, {
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

  function applyI18n(lang = getCurrentLang()) {
    const normalized = normalizeLang(lang);

    document.documentElement.lang = normalized;

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n, {}, normalized);
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

  window.MushmomI18n = {
    t,
    getCurrentLang,
    setLang,
    applyI18n,
    normalizeLang,
    getCurrentTimeZone,
    formatTimeZoneName,
    updateTimeZoneNotes,
    messages,
  };

  window.t = t;

  document.addEventListener("DOMContentLoaded", () => {
    applyI18n();
    bindLanguageSelector();
  });
})();
