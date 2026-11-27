// ============================================================================
// Backend `/api/stats?schema_version=1.0` Read-Only Data Contract
// Self-contained module (zero extension, DOM, or Chrome API dependencies)
// ============================================================================

// Wire interfaces are generated from Go's backend/internal/api StatsSnapshot
// via `cd backend && go run ./cmd/genstatstypes`.
import type {
  CircuitBreakerPlatformSnapshot,
  DailyStatsBucket,
  StatsSnapshot,
  YouTubeHelperStatsSnapshot,
  YTDLPStatsSnapshot,
} from "./statsTypes.generated";

export * from "./statsTypes.generated";
export * from "./statsValidation";
export * from "./chartGeometry";

export interface OwnerStatsResult {
  stats: StatsSnapshot;
  apiOrigin: string;
  fetchedAt: number;
}

// ============================================================================
// Pure Data Aggregations & Formatters (Zero DOM / Chrome / Extension Dependency)
// ============================================================================

const CORE_PLATFORM_LABEL_MAP = new Map<string, string>([
  ["douyin", "抖音"],
  ["bilibili", "B站"],
  ["weibo", "微博"],
  ["toutiao", "今日头条"],
  ["kuaishou", "快手"],
  ["pipixia", "皮皮虾"],
  ["pipigx", "皮皮搞笑"],
  ["zuiyou", "最右"],
  ["xiaohongshu", "小红书"],
  ["pinterest", "Pinterest"],
  ["x", "X / Twitter"],
  ["youtube", "YouTube"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["tumblr", "Tumblr"],
]);

const TIER2_PLATFORM_LABEL_MAP = new Map<string, string>([
  ["ted", "TED"],
  ["tedtalk", "TED"],
  ["ted_talk", "TED"],
  ["tedembed", "TED"],
  ["archiveorg", "Internet Archive"],
  ["archive_org", "Internet Archive"],
  ["tiktok", "TikTok"],
  ["tiktokuser", "TikTok"],
  ["tiktok_user", "TikTok"],
  ["vimeo", "Vimeo"],
  ["vimeo_album", "Vimeo"],
  ["vimeo_ondemand", "Vimeo"],
  ["vimeo_review", "Vimeo"],
  ["dailymotion", "Dailymotion"],
  ["dailymotion_playlist", "Dailymotion"],
  ["soundcloud", "SoundCloud"],
  ["soundcloud_set", "SoundCloud"],
  ["soundcloud_user", "SoundCloud"],
  ["twitch", "Twitch"],
  ["twitchvod", "Twitch"],
  ["twitch_vod", "Twitch"],
  ["twitchclips", "Twitch"],
  ["twitch_clips", "Twitch"],
  ["twitch_stream", "Twitch"],
  ["reddit", "Reddit"],
  ["redditr", "Reddit"],
  ["pinterest", "Pinterest"],
  ["pinterest_collection", "Pinterest"],
  ["vk", "VK"],
  ["vk_wall", "VK"],
  ["vkplay", "VK"],
  ["vkvideo", "VK"],
  ["nicovideo", "Niconico"],
  ["niconico", "Niconico"],
  ["niconico_playlist", "Niconico"],
  ["rutube", "RuTube"],
  ["okru", "OK.ru"],
  ["ok_ru", "OK.ru"],
  ["odnoklassniki", "OK.ru"],
  ["kick", "Kick"],
  ["kick_vod", "Kick"],
  ["kick_clips", "Kick"],
  ["bandcamp", "Bandcamp"],
  ["bandcamp_album", "Bandcamp"],
  ["bandcamp_track", "Bandcamp"],
  ["streamable", "Streamable"],
  ["mixcloud", "Mixcloud"],
  ["rumble", "Rumble"],
  ["odysee", "Odysee"],
  ["lbry", "Odysee"],
  ["peertube", "PeerTube"],
  ["loom", "Loom"],
  ["linkedin", "LinkedIn"],
  ["bluesky", "Bluesky"],
  ["bsky", "Bluesky"],
  ["threads", "Threads"],
  ["snapchat", "Snapchat"],
  ["ximalaya", "喜马拉雅"],
  ["acfun", "AcFun"],
  ["9gag", "9GAG"],
  ["site_9gag", "9GAG"],
  ["bbc", "BBC"],
  ["bbccouk", "BBC"],
  ["cnn", "CNN"],
  ["espn", "ESPN"],
  ["imdb", "IMDb"],
  ["imgur", "Imgur"],
  ["flickr", "Flickr"],
  ["coub", "Coub"],
  ["vidyard", "Vidyard"],
  ["wistia", "Wistia"],
  ["crunchyroll", "Crunchyroll"],
  ["fc2", "FC2"],
  ["patreon", "Patreon"],
  ["substack", "Substack"],
  ["spotify", "Spotify"],
]);

function formatTitleCasePlatformFallback(key: string): string {
  const normalized = /^site_\d/.test(key) ? key.slice(5) : key;
  const words = normalized
    .split(/[_:-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatStatsPlatformLabel(platform: string): string {
  const key = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  if (!key || key === "unknown") return "无效输入 / 未路由";
  if (key === "ytdlp_generic") return "通用长尾 (yt-dlp)";
  if (key === "ytdlp_unmatched") return "未匹配站点 (Tier-2)";
  if (key === "ytdlp_other") return "其他站点 (yt-dlp)";
  const core = CORE_PLATFORM_LABEL_MAP.get(key);
  if (core) return core;
  const tier2 = TIER2_PLATFORM_LABEL_MAP.get(key);
  if (tier2) return tier2;
  return formatTitleCasePlatformFallback(key);
}

export interface CircuitBreakerBadgeView {
  label: string;
  tone: "ok" | "warn" | "danger";
}

export function formatCircuitBreakerBadge(
  item: Pick<CircuitBreakerPlatformSnapshot, "state" | "disabled_by_config">,
): CircuitBreakerBadgeView {
  if (item.disabled_by_config) {
    return { label: "熔断保护中（运维禁用）", tone: "danger" };
  }
  if (item.state === "open") {
    return { label: "熔断保护中", tone: "danger" };
  }
  if (item.state === "half_open") {
    return { label: "半开探活", tone: "warn" };
  }
  return { label: "正常", tone: "ok" };
}

export interface YouTubeHelperBadgeView {
  label: string;
  tone: "ok" | "warn" | "danger" | "muted";
}

export function formatYouTubeHelperBadge(
  helper: Pick<
    YouTubeHelperStatsSnapshot,
    "enabled" | "disabled_by_config" | "active_player_cached" | "in_cooldown"
  >,
): YouTubeHelperBadgeView {
  if (helper.disabled_by_config) {
    return { label: "运维已禁用", tone: "danger" };
  }
  if (!helper.enabled) {
    return { label: "未启用", tone: "muted" };
  }
  if (helper.in_cooldown) {
    return {
      label: "冷却退避中",
      tone: helper.active_player_cached ? "warn" : "danger",
    };
  }
  if (helper.active_player_cached) {
    return { label: "预热就绪", tone: "ok" };
  }
  return { label: "待预热", tone: "warn" };
}

export interface YouTubeHelperVariantView {
  label: string;
  detail: string;
  tone: "ok" | "warn" | "muted";
  isDegraded: boolean;
}

export function formatYouTubeHelperVariant(
  variant: string | null | undefined,
): YouTubeHelperVariantView {
  const trimmed = typeof variant === "string" ? variant.trim() : "";
  if (!trimmed) {
    return { label: "—", detail: "尚未缓存活动变体", tone: "muted", isDegraded: false };
  }
  if (trimmed === "tv") {
    return { label: "tv", detail: "TV 首选变体", tone: "ok", isDegraded: false };
  }
  if (trimmed === "main") {
    return { label: "main（降级回退）", detail: "TV 不可用，已自动回退主站播放器", tone: "warn", isDegraded: true };
  }
  return { label: trimmed, detail: "非默认变体", tone: "warn", isDegraded: true };
}

export function formatShanghaiTimestamp(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const trimmed = raw.trim();
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return trimmed;
  const d = new Date(parsedMs + 8 * 3_600_000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}

const LONG_HEX_SHA_RE = /^([0-9a-f]{12,64})(-dirty)?$/i;

export interface MonitorVersionBadge {
  display: string;
  full: string;
  isShortened: boolean;
}

export function formatMonitorVersionBadge(
  rawVersion: string | null | undefined,
): MonitorVersionBadge {
  const full = typeof rawVersion === "string" ? rawVersion.trim() : "";
  if (!full) {
    return { display: "unknown", full: "unknown", isShortened: false };
  }
  const shaMatch = LONG_HEX_SHA_RE.exec(full);
  if (shaMatch) {
    const suffix = shaMatch[2] ? shaMatch[2].toLowerCase() : "";
    return {
      display: `${shaMatch[1].slice(0, 7)}${suffix}`,
      full,
      isShortened: true,
    };
  }
  return { display: full, full, isShortened: false };
}

export type PlatformHealthRange =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "since_start";

export type ErrorCodeSeverity = "danger" | "warning" | "muted";

export interface PlatformErrorBadge {
  code: string;
  count: number;
  severity: ErrorCodeSeverity;
}

export interface EffectiveSuccessRateSummary {
  excludedCount: number;
  effectiveTotal: number;
  effectiveSuccessRate: number | null;
}

export interface PlatformHealthRow {
  platform: string;
  label: string;
  total: number;
  ok: number;
  failed: number;
  successRate: number | null;
  excludedCount: number;
  effectiveTotal: number;
  effectiveSuccessRate: number | null;
  topErrors: PlatformErrorBadge[];
  p95Ms: number | null;
}

export interface TodayVsYesterdaySummary {
  date: string;
  yesterdayDate: string | null;
  total: number;
  ok: number;
  failed: number;
  successRate: number | null;
  excludedCount: number;
  effectiveTotal: number;
  effectiveSuccessRate: number | null;
  cacheHits: number;
  shanghaiHits: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  yesterdayTotal: number;
  yesterdaySuccessRate: number | null;
  deltaTotal: number;
  deltaRatePct: number | null;
}

export const EXCLUDED_NON_UPSTREAM_CODES: ReadonlySet<string> = new Set([
  "RATE_LIMITED",
  "INVALID_INPUT",
  "UNSUPPORTED_PLATFORM",
  "UNAUTHORIZED",
]);

const DANGER_ERROR_CODES = new Set([
  "UPSTREAM_BLOCKED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_INVALID_RESPONSE",
  "INTERNAL_ERROR",
  "SERVICE_NOT_CONFIGURED",
]);

const WARNING_ERROR_CODES = new Set([
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "CONTENT_UNAVAILABLE",
  "NO_MEDIA",
]);

export function classifyErrorCodeSeverity(code: string): ErrorCodeSeverity {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (DANGER_ERROR_CODES.has(normalized)) return "danger";
  if (WARNING_ERROR_CODES.has(normalized)) return "warning";
  return "muted";
}

function safeRatePct(ok: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = (Math.max(0, ok) / total) * 100;
  return Math.max(0, Math.min(100, pct));
}

export function computeEffectiveSuccessRate(
  ok: number,
  total: number,
  byCode: Record<string, number> | Map<string, number> | null | undefined,
): EffectiveSuccessRateSummary {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const safeOk = Number.isFinite(ok) ? Math.max(0, ok) : 0;

  let excludedCount = 0;
  const entries =
    byCode instanceof Map
      ? byCode.entries()
      : byCode && typeof byCode === "object"
        ? Object.entries(byCode)
        : [];
  for (const [rawCode, count] of entries) {
    if (!Number.isFinite(count) || count <= 0) continue;
    const code = String(rawCode || "").trim().toUpperCase();
    if (EXCLUDED_NON_UPSTREAM_CODES.has(code)) {
      excludedCount += count;
    }
  }

  const effectiveTotal = Math.max(0, safeTotal - excludedCount);
  const effectiveSuccessRate = safeRatePct(safeOk, effectiveTotal);

  return {
    excludedCount,
    effectiveTotal,
    effectiveSuccessRate,
  };
}

export function computeTodayVsYesterday(
  stats: StatsSnapshot,
): TodayVsYesterdaySummary {
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const today = daily.length > 0 ? daily[daily.length - 1] : undefined;
  const yesterday = daily.length > 1 ? daily[daily.length - 2] : undefined;

  const total = today?.total ?? 0;
  const ok = today?.ok ?? 0;
  const failed = today?.failed ?? 0;
  const successRate = safeRatePct(ok, total);

  const todayByCode = new Map<string, number>();
  const todayPlatforms = today?.by_platform;
  if (todayPlatforms && typeof todayPlatforms === "object") {
    for (const pStats of Object.values(todayPlatforms)) {
      if (!pStats?.by_code || typeof pStats.by_code !== "object") continue;
      for (const [rawCode, count] of Object.entries(pStats.by_code)) {
        if (!Number.isFinite(count) || count <= 0) continue;
        const code = rawCode.trim().toUpperCase();
        todayByCode.set(code, (todayByCode.get(code) ?? 0) + count);
      }
    }
  }
  const effective = computeEffectiveSuccessRate(ok, total, todayByCode);

  const yesterdayTotal = yesterday?.total ?? 0;
  const yesterdaySuccessRate = yesterday
    ? safeRatePct(yesterday.ok, yesterday.total)
    : null;

  const deltaTotal = total - yesterdayTotal;
  const deltaRatePct =
    successRate !== null && yesterdaySuccessRate !== null
      ? Number((successRate - yesterdaySuccessRate).toFixed(1))
      : null;

  return {
    date: today?.date ?? "",
    yesterdayDate: yesterday?.date ?? null,
    total,
    ok,
    failed,
    successRate,
    excludedCount: effective.excludedCount,
    effectiveTotal: effective.effectiveTotal,
    effectiveSuccessRate: effective.effectiveSuccessRate,
    cacheHits: today?.cache_hits ?? 0,
    shanghaiHits: today?.shanghai_hits ?? 0,
    p50Ms: today?.latency_ms?.p50_ms ?? 0,
    p95Ms: today?.latency_ms?.p95_ms ?? 0,
    maxMs: today?.latency_ms?.max_ms ?? 0,
    yesterdayTotal,
    yesterdaySuccessRate,
    deltaTotal,
    deltaRatePct,
  };
}

export function aggregatePlatformHealth(
  stats: StatsSnapshot,
  range: PlatformHealthRange,
): PlatformHealthRow[] {
  const acc = new Map<
    string,
    {
      total: number;
      ok: number;
      failed: number;
      byCode: Map<string, number>;
      maxP95Ms: number;
      hasP95: boolean;
    }
  >();

  const ensureEntry = (platform: string) => {
    const key = platform.trim().toLowerCase() || "unknown";
    let entry = acc.get(key);
    if (!entry) {
      entry = {
        total: 0,
        ok: 0,
        failed: 0,
        byCode: new Map<string, number>(),
        maxP95Ms: 0,
        hasP95: false,
      };
      acc.set(key, entry);
    }
    return entry;
  };

  if (range === "since_start") {
    const cells = stats.requests?.by_platform_code_channel ?? [];
    for (const cell of cells) {
      if (!cell || !Number.isFinite(cell.count) || cell.count <= 0) continue;
      const entry = ensureEntry(cell.platform);
      entry.total += cell.count;
      const code = (cell.code || "INTERNAL_ERROR").trim().toUpperCase();
      if (code === "OK") {
        entry.ok += cell.count;
      } else {
        entry.failed += cell.count;
        entry.byCode.set(code, (entry.byCode.get(code) ?? 0) + cell.count);
      }
    }
  } else {
    const daily = Array.isArray(stats.daily) ? stats.daily : [];
    let selected: DailyStatsBucket[] = [];
    if (range === "today") {
      selected = daily.length > 0 ? [daily[daily.length - 1]] : [];
    } else if (range === "yesterday") {
      selected = daily.length > 1 ? [daily[daily.length - 2]] : [];
    } else if (range === "7d") {
      selected = daily.slice(-7);
    } else {
      selected = daily.slice(-30);
    }

    for (const bucket of selected) {
      const byPlat = bucket?.by_platform;
      if (!byPlat || typeof byPlat !== "object") continue;
      for (const [platform, pStats] of Object.entries(byPlat)) {
        if (!pStats || !Number.isFinite(pStats.total) || pStats.total <= 0) {
          continue;
        }
        const entry = ensureEntry(platform);
        entry.total += pStats.total;
        entry.ok += pStats.ok || 0;
        entry.failed += pStats.failed || 0;
        if (Number.isFinite(pStats.p95_ms)) {
          entry.hasP95 = true;
          if (pStats.p95_ms > entry.maxP95Ms) {
            entry.maxP95Ms = pStats.p95_ms;
          }
        }
        if (pStats.by_code && typeof pStats.by_code === "object") {
          for (const [rawCode, count] of Object.entries(pStats.by_code)) {
            if (!Number.isFinite(count) || count <= 0) continue;
            const code = rawCode.trim().toUpperCase();
            if (code === "OK") continue;
            entry.byCode.set(code, (entry.byCode.get(code) ?? 0) + count);
          }
        }
      }
    }
  }

  const rows: PlatformHealthRow[] = [];
  for (const [platform, entry] of acc.entries()) {
    if (entry.total <= 0) continue;
    const topErrors: PlatformErrorBadge[] = Array.from(entry.byCode.entries())
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([code, count]) => ({
        code,
        count,
        severity: classifyErrorCodeSeverity(code),
      }));

    const effective = computeEffectiveSuccessRate(
      entry.ok,
      entry.total,
      entry.byCode,
    );

    rows.push({
      platform,
      label: formatStatsPlatformLabel(platform),
      total: entry.total,
      ok: entry.ok,
      failed: entry.failed,
      successRate: safeRatePct(entry.ok, entry.total),
      excludedCount: effective.excludedCount,
      effectiveTotal: effective.effectiveTotal,
      effectiveSuccessRate: effective.effectiveSuccessRate,
      topErrors,
      p95Ms: entry.hasP95 ? entry.maxP95Ms : null,
    });
  }

  rows.sort(
    (a, b) =>
      b.total - a.total ||
      b.failed - a.failed ||
      a.platform.localeCompare(b.platform),
  );
  return rows;
}

export function formatUptimeDuration(seconds: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "0秒";
  }
  const totalSec = Math.floor(seconds);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const secs = totalSec % 60;

  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return secs > 0 ? `${minutes}分 ${secs}秒` : `${minutes}分`;
  return `${secs}秒`;
}

export function formatPercent(
  numerator: number,
  denominator: number,
  digits = 1,
): string {
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return "—";
  }
  const pct = Math.max(0, Math.min(100, (numerator / denominator) * 100));
  return `${pct.toFixed(digits)}%`;
}

export function formatBytesCompact(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

export function resolveYtdlpQueuedCount(ytdlp?: YTDLPStatsSnapshot | null): number {
  if (!ytdlp) return 0;
  if (typeof ytdlp.waiting === "number" && Number.isFinite(ytdlp.waiting)) {
    return Math.max(0, ytdlp.waiting);
  }
  if (typeof ytdlp.queued === "number" && Number.isFinite(ytdlp.queued)) {
    return Math.max(0, ytdlp.queued);
  }
  return 0;
}
