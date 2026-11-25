// ============================================================================
// Runtime Validation Guards for `/api/stats?schema_version=1.0`
// Self-contained module (zero extension, DOM, or Chrome API dependencies)
// ============================================================================

import type {
  AdmissionPoolSnapshot,
  CircuitBreakerPlatformSnapshot,
  DailyStatsBucket,
  HourlyStatsBucket,
  RuntimeConfigSnapshot,
  RuntimePolicySummary,
  StatsSnapshot,
  YouTubeHelperStatsSnapshot,
  YTDLPCompartmentPoolSnapshot,
  YTDLPPoolsSnapshot,
  YTDLPStatsSnapshot,
} from "./statsTypes.generated";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegFiniteNum(value: unknown): value is number {
  return isFiniteNum(value) && value >= 0;
}

function isValidAdmissionPool(raw: unknown): raw is AdmissionPoolSnapshot {
  if (!isRecord(raw)) return false;
  return (
    isFiniteNum(raw.active) &&
    isFiniteNum(raw.queued) &&
    isFiniteNum(raw.concurrency_limit) &&
    isFiniteNum(raw.queue_limit)
  );
}

function isValidYtdlpSnapshot(raw: unknown): raw is YTDLPStatsSnapshot {
  if (!isRecord(raw)) return false;
  return isFiniteNum(raw.active) && isFiniteNum(raw.concurrency_limit);
}

function isValidYtdlpCompartmentPool(
  raw: unknown,
): raw is YTDLPCompartmentPoolSnapshot {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.enabled === "boolean" &&
    isFiniteNum(raw.active) &&
    isFiniteNum(raw.queued) &&
    isFiniteNum(raw.concurrency_limit) &&
    isFiniteNum(raw.queue_limit) &&
    isFiniteNum(raw.waited) &&
    isFiniteNum(raw.granted) &&
    isFiniteNum(raw.timeout) &&
    isFiniteNum(raw.full) &&
    isFiniteNum(raw.canceled) &&
    isFiniteNum(raw.wait_ms_total) &&
    isFiniteNum(raw.wait_ms_max)
  );
}

function isValidYtdlpPools(raw: unknown): raw is YTDLPPoolsSnapshot {
  if (!isRecord(raw)) return false;
  return (
    isValidYtdlpCompartmentPool(raw.youtube) &&
    isValidYtdlpCompartmentPool(raw.social) &&
    isValidYtdlpCompartmentPool(raw.generic) &&
    isValidYtdlpCompartmentPool(raw.youtube_ejs)
  );
}

export function isValidYouTubeHelperStats(
  raw: unknown,
): raw is YouTubeHelperStatsSnapshot {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.enabled === "boolean" &&
    typeof raw.disabled_by_config === "boolean" &&
    typeof raw.active_player_cached === "boolean" &&
    (raw.active_variant === "" ||
      raw.active_variant === "tv" ||
      raw.active_variant === "main") &&
    isNonNegFiniteNum(raw.refresh_attempts) &&
    isNonNegFiniteNum(raw.refresh_successes) &&
    isNonNegFiniteNum(raw.refresh_failures) &&
    isNonNegFiniteNum(raw.cooldown_skips) &&
    isNonNegFiniteNum(raw.consecutive_failures) &&
    typeof raw.in_cooldown === "boolean" &&
    isNonNegFiniteNum(raw.challenge_lru_entries) &&
    isNonNegFiniteNum(raw.challenge_lru_hits) &&
    isNonNegFiniteNum(raw.challenge_lru_misses)
  );
}

export function isValidCircuitBreakerPlatform(
  raw: unknown,
): raw is CircuitBreakerPlatformSnapshot {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.platform === "string" &&
    (raw.state === "closed" ||
      raw.state === "open" ||
      raw.state === "half_open") &&
    isNonNegFiniteNum(raw.consecutive_failures) &&
    isNonNegFiniteNum(raw.window_failures) &&
    isNonNegFiniteNum(raw.window_total) &&
    typeof raw.open_until === "string" &&
    typeof raw.disabled_by_config === "boolean"
  );
}

export function isValidGenericCircuitBreaker(
  raw: unknown,
): raw is CircuitBreakerPlatformSnapshot {
  return (
    isValidCircuitBreakerPlatform(raw) && raw.platform === "ytdlp_generic"
  );
}

function isValidRuntimePolicySummary(
  raw: unknown,
): raw is RuntimePolicySummary {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.config_file_active === "boolean" &&
    isFiniteNum(raw.reload_count) &&
    typeof raw.last_reloaded_at === "string" &&
    isFiniteNum(raw.youtube_slots) &&
    isFiniteNum(raw.social_slots) &&
    isFiniteNum(raw.generic_slots) &&
    isFiniteNum(raw.youtube_ejs_concurrency) &&
    isFiniteNum(raw.fast_per_platform_max_concurrency) &&
    typeof raw.circuit_breaker_enabled === "boolean" &&
    Array.isArray(raw.disabled_platforms) &&
    raw.disabled_platforms.every((item) => typeof item === "string") &&
    isFiniteNum(raw.youtube_parse_ttl_seconds) &&
    isFiniteNum(raw.stale_if_error_ttl_seconds) &&
    isFiniteNum(raw.upstream_blocked_neg_ttl_seconds)
  );
}

function isValidRuntimeConfig(raw: unknown): raw is RuntimeConfigSnapshot {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.version === "string" &&
    typeof raw.shanghai_mode === "string" &&
    typeof raw.shanghai_bilibili === "boolean" &&
    typeof raw.bilibili_dash === "boolean" &&
    typeof raw.youtube_helper === "boolean" &&
    typeof raw.xhs_transport === "string" &&
    typeof raw.ytdlp_enabled === "boolean" &&
    typeof raw.ytdlp_generic_enabled === "boolean" &&
    typeof raw.tbvideo_pipigx === "boolean" &&
    typeof raw.tbvideo_zuiyou === "boolean" &&
    typeof raw.stats_persistence_enabled === "boolean"
  );
}

function isValidDailyBucket(raw: unknown): raw is DailyStatsBucket {
  if (!isRecord(raw)) return false;
  if (
    typeof raw.date !== "string" ||
    !isFiniteNum(raw.total) ||
    !isFiniteNum(raw.ok) ||
    !isFiniteNum(raw.failed) ||
    !isFiniteNum(raw.cache_hits) ||
    !isFiniteNum(raw.shanghai_hits)
  ) {
    return false;
  }
  if (!isRecord(raw.latency_ms)) return false;
  if (
    !isFiniteNum(raw.latency_ms.p50_ms) ||
    !isFiniteNum(raw.latency_ms.p95_ms) ||
    !isFiniteNum(raw.latency_ms.max_ms)
  ) {
    return false;
  }
  return isRecord(raw.by_platform);
}

function isValidHourlyBucket(raw: unknown): raw is HourlyStatsBucket {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.hour_start === "string" &&
    isFiniteNum(raw.total) &&
    isFiniteNum(raw.ok) &&
    isFiniteNum(raw.failed) &&
    isFiniteNum(raw.cache_hits)
  );
}

export function isValidStatsSnapshot(raw: unknown): raw is StatsSnapshot {
  if (!isRecord(raw)) return false;
  if (
    typeof raw.started_at !== "string" ||
    typeof raw.generated_at !== "string" ||
    !isFiniteNum(raw.uptime_seconds)
  ) {
    return false;
  }

  if (
    !isRecord(raw.requests) ||
    !isFiniteNum(raw.requests.total) ||
    !isRecord(raw.requests.by_channel) ||
    !Array.isArray(raw.requests.by_platform_code_channel)
  ) {
    return false;
  }

  if (
    !isRecord(raw.cache) ||
    typeof raw.cache.enabled !== "boolean" ||
    !isFiniteNum(raw.cache.entries) ||
    !isFiniteNum(raw.cache.bytes) ||
    !isRecord(raw.cache.total)
  ) {
    return false;
  }

  if (
    raw.cache.total.stale_hits !== undefined &&
    !isFiniteNum(raw.cache.total.stale_hits)
  ) {
    return false;
  }

  if (
    !isRecord(raw.admission) ||
    !isRecord(raw.admission.fast) ||
    !isRecord(raw.admission.slow) ||
    !isRecord(raw.admission.owner)
  ) {
    return false;
  }

  if (
    raw.admission.generic_slow !== undefined &&
    !isValidAdmissionPool(raw.admission.generic_slow)
  ) {
    return false;
  }

  if (!Array.isArray(raw.api_keys)) {
    return false;
  }

  if (!isValidYtdlpSnapshot(raw.ytdlp)) {
    return false;
  }

  if (
    raw.ytdlp_generic !== undefined &&
    !isValidYtdlpSnapshot(raw.ytdlp_generic)
  ) {
    return false;
  }

  if (raw.ytdlp_pools !== undefined && !isValidYtdlpPools(raw.ytdlp_pools)) {
    return false;
  }

  if (
    raw.youtube_helper !== undefined &&
    !isValidYouTubeHelperStats(raw.youtube_helper)
  ) {
    return false;
  }

  if (
    raw.circuit_breakers !== undefined &&
    (!Array.isArray(raw.circuit_breakers) ||
      !raw.circuit_breakers.every(isValidCircuitBreakerPlatform))
  ) {
    return false;
  }

  if (
    raw.generic_circuit_breaker !== undefined &&
    !isValidGenericCircuitBreaker(raw.generic_circuit_breaker)
  ) {
    return false;
  }

  if (
    raw.runtime_policy !== undefined &&
    !isValidRuntimePolicySummary(raw.runtime_policy)
  ) {
    return false;
  }

  if (
    !isRecord(raw.shanghai) ||
    typeof raw.shanghai.enabled !== "boolean" ||
    typeof raw.shanghai.mode !== "string" ||
    !isFiniteNum(raw.shanghai.waiting_workers)
  ) {
    return false;
  }

  if (
    !isRecord(raw.parse_latency_ms) ||
    !isRecord(raw.parse_latency_ms.total)
  ) {
    return false;
  }

  if (!isValidRuntimeConfig(raw.runtime)) {
    return false;
  }

  if (!Array.isArray(raw.daily) || !raw.daily.every(isValidDailyBucket)) {
    return false;
  }

  if (!Array.isArray(raw.hourly) || !raw.hourly.every(isValidHourlyBucket)) {
    return false;
  }

  return true;
}
