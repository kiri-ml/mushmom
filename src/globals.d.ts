type SharedTranslationParams = Record<string, string | number>;
interface StatsPoint { date: Date; count: number; }
interface HistoricalSourcePayload { source?: string; sourceUrl?: string | null; }
interface LocaleConfig { code: string; label: string; aliases: string[]; documentLang: string; }
interface I18nData { messages?: Record<string, Record<string, string>>; localeRegistry?: LocaleConfig[]; }
interface MushmomI18nApi {
  ready: Promise<unknown> | null;
  t(key: string, params?: SharedTranslationParams, lang?: string): string;
  getCurrentLang(): string;
  setLang(lang: string): string;
  applyI18n(lang?: string): string;
  normalizeLang(lang: string | null | undefined): string;
  getCurrentTimeZone(): string;
  formatTimeZoneName(lang?: string): string;
  updateTimeZoneNotes(lang?: string): void;
  renderLanguageSelector(): void;
  getSupportedLocales(): LocaleConfig[];
  getLocaleConfig(lang: string): LocaleConfig | null;
  loadI18nData(fetcher?: typeof fetch): Promise<I18nData>;
  initI18n(): Promise<MushmomI18nApi>;
  setI18nData(data?: I18nData): void;
  readonly messages: Record<string, Record<string, string>>;
  readonly localeRegistry: LocaleConfig[];
  readonly localeLabels: Record<string, string>;
}
interface StatsManifestChunk { period: string; granularity: "month" | "year"; file: string; minTimestamp: number; maxTimestamp: number; rowCount: number; }
interface StatsManifestFormat { rowShape: ["epochSeconds", "usercount"]; timestampUnit: "seconds"; order: "ascending"; }
interface StatsManifest { schemaVersion: 2; dataset: "maplelegends-online-users"; archiveThroughPeriod: string; format: StatsManifestFormat; chunks: StatsManifestChunk[]; }
type RawPayloadRow = [unknown, unknown] | { timestamp?: unknown; time?: unknown; created_at?: unknown; date?: unknown; usercount?: unknown; users?: unknown; players?: unknown; count?: unknown; };
type StatsPayload = RawPayloadRow[] | { data?: RawPayloadRow[]; values?: RawPayloadRow[]; source?: string; sourceUrl?: string | null; };
interface InitialStatsHistoryResult<TPoint> { points: TPoint[]; recentPayload: StatsPayload; manifest: StatsManifest; }
interface ArchiveStatsHistoryResult<TPoint> { points: TPoint[]; chunks: StatsManifestChunk[]; }
interface LoadInitialStatsHistoryOptions<TPoint> { archiveBaseUrl?: string; statsApiBaseUrl?: string; manifest?: StatsManifest; normalizePayload: (payload: StatsPayload) => TPoint[]; onInitial?: (payload: InitialStatsHistoryResult<TPoint>) => void; fetcher?: (url: string) => Promise<unknown>; }
interface LoadArchiveStatsHistoryOptions<TPoint> { archiveBaseUrl?: string; recentPayload: StatsPayload; manifest: StatsManifest; normalizePayload: (payload: StatsPayload) => TPoint[]; onArchive?: (payload: ArchiveStatsHistoryResult<TPoint>) => void; fetcher?: (url: string) => Promise<unknown>; }
interface LoadStatsHistoryOptions<TPoint> extends LoadInitialStatsHistoryOptions<TPoint> { archiveBaseUrl?: string; onArchive?: (payload: ArchiveStatsHistoryResult<TPoint>) => void; }
interface MushmomStatsLoaderApi { loadStatsHistory<TPoint>(options: LoadStatsHistoryOptions<TPoint>): Promise<void>; loadInitialStatsHistory<TPoint>(options: LoadInitialStatsHistoryOptions<TPoint>): Promise<InitialStatsHistoryResult<TPoint>>; loadArchiveStatsHistory<TPoint>(options: LoadArchiveStatsHistoryOptions<TPoint>): Promise<ArchiveStatsHistoryResult<TPoint>>; selectArchiveChunks(manifest: StatsManifest, recentPayload: StatsPayload): StatsManifestChunk[]; oldestPayloadTimestamp(payload: StatsPayload): number; }
interface EChartsInstance { setOption(option: unknown, notMerge?: boolean): void; resize(): void; }
interface EChartsLike { init(element: Element, theme?: unknown, opts?: unknown): EChartsInstance; }
declare var MushmomI18n: MushmomI18nApi | undefined;
declare var MushmomStatsLoader: MushmomStatsLoaderApi | undefined;
declare var echarts: EChartsLike;
declare var __mushmomEchartsReady: Promise<unknown> | undefined;
declare var __MUSHMOM_TEST__: Record<string, unknown>;
interface Window { MushmomI18n?: MushmomI18nApi; MushmomStatsLoader?: MushmomStatsLoaderApi; echarts?: EChartsLike; __mushmomEchartsReady?: Promise<unknown>; }
declare module "*.css";
