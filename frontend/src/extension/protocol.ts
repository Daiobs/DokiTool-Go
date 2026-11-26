import type { UnifiedMedia } from "../types/media";
import type {
  YouTubeHelperPlayerPayload,
  YouTubeHelperPlayerResult,
  YouTubeHelperPrefetchPayload,
  YouTubeHelperPrefetchResult,
} from "../utils/youtubeHelperCore";
import type {
  BatchSaveMode,
  ExtensionSettings,
  ExtensionSettingsPatch,
  ExtensionThemeMode,
  PanelIntentMode,
  PendingPanelIntent,
  QualityPreference,
  SavedWorkRecord,
} from "./storage";
import type {
  OwnerStatsResult,
  StatsSnapshot,
} from "../monitor/statsTypes";
import type {
  BatchUrlExtractResult,
  MatchedPlatformUrl,
  PlatformId,
} from "./urlMatcher";

export type {
  BatchSaveMode,
  BatchUrlExtractResult,
  ExtensionSettings,
  ExtensionSettingsPatch,
  ExtensionThemeMode,
  MatchedPlatformUrl,
  OwnerStatsResult,
  PanelIntentMode,
  PendingPanelIntent,
  PlatformId,
  QualityPreference,
  SavedWorkRecord,
  StatsSnapshot,
};

export const SIDEPANEL_PORT_NAME = "dokitool-sidepanel" as const;
export const OFFSCREEN_PORT_NAME = "dokitool-offscreen" as const;
export const EXTENSION_OPFS_TEMP_PREFIX = "dokitool-ext-" as const;
export const DOKITOOL_EXTENSION_ID = "ihamkldlkdibleacagiejklpfofapkpo" as const;

export const OFFSCREEN_HEARTBEAT_INTERVAL_MS = 20_000 as const;
export const OFFSCREEN_IDLE_CLOSE_MS = 60_000 as const;
export const TAB_SYNC_DEBOUNCE_MS = 400 as const;
export const YOUTUBE_TAB_SYNC_DEBOUNCE_MS = 750 as const;

export const CONTEXT_MENU_INSPECT_ID = "dokitool-ext-inspect-link" as const;
export const CONTEXT_MENU_QUICK_DOWNLOAD_ID =
  "dokitool-ext-quick-download" as const;
export const CONTEXT_MENU_PARSE_SELECTION_ID =
  "dokitool-parse-selection" as const;
export const COMMAND_OPEN_SIDEPANEL = "open-dokitool-sidepanel" as const;

export interface TabSyncState {
  tabId: number;
  rawUrl: string;
  matched: MatchedPlatformUrl | null;
  updatedAt: number;
}

export type AuthMode = "anonymous" | "authenticated";

export interface ConnectionCheckResult {
  ok: boolean;
  status: number;
  authMode: AuthMode;
  platformCount?: number;
  role?: string;
  message: string;
  checkedAt: number;
}

export type OffscreenDownloadKind =
  | "direct_file"
  | "youtube_direct"
  | "youtube_mux"
  | "dash_mux"
  | "hls"
  | "segments"
  | "batch_zip";

export interface OffscreenSegmentSpec {
  url: string;
  routes?: string[];
  start?: number;
  length?: number;
}

export interface OffscreenYouTubeMuxSpec {
  videoUrl: string;
  audioUrl: string;
  videoSize?: number;
  audioSize?: number;
  outputContainer: "mp4" | "webm";
}

export interface OffscreenDashMuxSpec {
  videoRoutes: string[];
  audioRoutes: string[];
  videoSize?: number;
  audioSize?: number;
  outputContainer: "mp4";
}

export interface OffscreenZipEntrySpec {
  entryName: string;
  routes: string[];
  mimeType?: string;
  sizeBytes?: number;
  segments?: OffscreenSegmentSpec[];
}

export interface MediaRefreshContext {
  parseUrl: string;
  platform: string;
  itemId: string;
  variantId?: string;
  attachmentId?: string;
  resourceRole?: "motion" | "video" | "image";
  resolveUrl?: string;
  /**
   * Optional top-level `/api/parse?...` fallback returned in `UnifiedMedia.refresh_url`
   * when Tier-2 items omit `item.resolve_url` (Guardrail G4).
   */
  refreshUrl?: string;
  expiresAtMs?: number;
}

export interface OffscreenDownloadSpec {
  kind: OffscreenDownloadKind;
  apiOrigin: string;
  routes: string[];
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  extraAllowedOrigins?: string[];
  segments?: OffscreenSegmentSpec[];
  youtubeMux?: OffscreenYouTubeMuxSpec;
  dashMux?: OffscreenDashMuxSpec;
  zipEntries?: OffscreenZipEntrySpec[];
  refreshContext?: MediaRefreshContext;
}

export type ExtensionTaskStatus =
  | "queued"
  | "parsing"
  | "downloading"
  | "muxing"
  | "saving"
  | "completed"
  | "failed"
  | "cancelled";

export type ExtensionTaskRetryPayload =
  | {
      kind: "spec";
      spec: OffscreenDownloadSpec;
    }
  | {
      kind: "url";
      url: string;
      itemId?: string;
      variantId?: string;
      qualityPreference?: QualityPreference;
      batchSaveMode?: BatchSaveMode;
      subfolderPrefix?: string;
    };

export type PersistedTaskHistoryStatus = "completed" | "failed" | "cancelled";

/**
 * Guardrail G6 sanitized task history record persisted in `chrome.storage.local`.
 * Strictly excludes signed CDN routes, mux specs, headers, and credentials;
 * SW-wake retries re-parse from canonical `sourcePageUrl`.
 */
export interface PersistedTaskHistoryRecord {
  taskId: string;
  title: string;
  platform: string;
  filename: string;
  status: PersistedTaskHistoryStatus;
  statusText: string;
  total?: number;
  error?: string;
  lastErrorCode?: string;
  createdAt: number;
  updatedAt: number;
  chromeDownloadId?: number;
  groupBatchId?: string;
  workFingerprint?: string;
  sourcePageUrl?: string;
  itemId?: string;
  variantId?: string;
  qualityPreference?: QualityPreference;
  batchSaveMode?: BatchSaveMode;
  subfolderPrefix?: string;
}

export interface ExtensionDownloadTask {
  taskId: string;
  groupBatchId?: string;
  title: string;
  filename: string;
  platform: string;
  workFingerprint?: string;
  sourcePageUrl?: string;
  persistedFromHistory?: boolean;
  status: ExtensionTaskStatus;
  statusText: string;
  percent: number;
  loaded: number;
  total: number;
  speed: number;
  error?: string;
  lastErrorCode?: string;
  lastErrorHttpStatus?: number;
  autoRefreshCount?: number;
  unwhitelistedHost?: string;
  fallbackUrl?: string;
  chromeDownloadId?: number;
  filenameWarning?: string;
  createdAt: number;
  updatedAt: number;
  retryPayload?: ExtensionTaskRetryPayload;
}

export interface EnqueueDownloadItem {
  title: string;
  platform: string;
  workFingerprint?: string;
  fallbackUrl?: string;
  refreshContext?: MediaRefreshContext;
  spec: OffscreenDownloadSpec;
}

export interface MultiPartEnqueueMediaMeta {
  platform: string;
  title?: string;
  authorName?: string;
  contentId?: string;
  sourceUrl?: string;
  refreshUrl?: string;
  workFingerprint?: string;
  totalItemCount?: number;
}

export interface MultiPartEnqueueItemInput {
  itemId: string;
  index: number;
  title: string;
  state: "ready" | "deferred";
  resolveUrl?: string;
  sourceUrl?: string;
  spec?: OffscreenDownloadSpec;
  fallbackUrl?: string;
  filenameHint?: string;
}

export interface EnqueueMultiPartItemsRequest {
  type: "ENQUEUE_MULTIPART_ITEMS";
  media: MultiPartEnqueueMediaMeta;
  items: MultiPartEnqueueItemInput[];
  qualityPreference?: QualityPreference;
  subfolderPrefix?: string;
  groupBatchId?: string;
}

export interface ExtensionStateSnapshot {
  settings: ExtensionSettings;
  tabSync: TabSyncState | null;
  tasks: ExtensionDownloadTask[];
  savedWorkFingerprints: string[];
  pendingIntent: PendingPanelIntent | null;
  connection?: ConnectionCheckResult | null;
}

export type ExtensionRpcResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; status?: number };

export function okRpc<T>(data: T): ExtensionRpcResponse<T> {
  return { ok: true, data };
}

export function errRpc(
  error: string,
  extra?: { code?: string; status?: number },
): ExtensionRpcResponse<never> {
  return {
    ok: false,
    error,
    ...(extra?.code ? { code: extra.code } : {}),
    ...(extra?.status !== undefined ? { status: extra.status } : {}),
  };
}

// ============================================================================
// SidePanel <-> Background Message Contracts
// ============================================================================

export type SidePanelToBackgroundRequest =
  | { type: "GET_INITIAL_STATE" }
  | { type: "UPDATE_SETTINGS"; patch: ExtensionSettingsPatch }
  | {
      type: "TEST_CONNECTION";
      apiBaseUrl?: string;
      bearerToken?: string;
    }
  | { type: "FETCH_OWNER_STATS" }
  | {
      type: "PARSE_URL";
      url: string;
      locale?: "zh-CN" | "en";
      forceRefresh?: boolean;
    }
  | {
      type: "RESOLVE_LAZY_ITEM";
      resolveUrl: string;
      platform: string;
      locale?: "zh-CN" | "en";
    }
  | {
      type: "ENQUEUE_DOWNLOADS";
      items: EnqueueDownloadItem[];
      groupBatchId?: string;
    }
  | {
      type: "ENQUEUE_BATCH_URLS";
      urls: string[];
      qualityPreference?: QualityPreference;
      batchSaveMode?: BatchSaveMode;
      subfolderPrefix?: string;
    }
  | EnqueueMultiPartItemsRequest
  | { type: "CANCEL_TASK"; taskId: string }
  | { type: "RETRY_TASK"; taskId: string }
  | { type: "CLEAR_FINISHED_TASKS" }
  | {
      type: "OPEN_DOWNLOAD_FOLDER";
      taskId?: string;
      chromeDownloadId?: number;
    }
  | { type: "CONSUME_INTENT"; intentId?: string };

export interface SidePanelResponseMap {
  GET_INITIAL_STATE: ExtensionStateSnapshot;
  UPDATE_SETTINGS: { settings: ExtensionSettings };
  TEST_CONNECTION: ConnectionCheckResult;
  FETCH_OWNER_STATS: OwnerStatsResult;
  PARSE_URL: {
    media: UnifiedMedia;
    matched: MatchedPlatformUrl;
    workFingerprint: string;
    isSaved: boolean;
  };
  RESOLVE_LAZY_ITEM: { media: UnifiedMedia };
  ENQUEUE_DOWNLOADS: { taskIds: string[]; tasks: ExtensionDownloadTask[] };
  ENQUEUE_BATCH_URLS: {
    groupBatchId: string;
    taskIds: string[];
    tasks: ExtensionDownloadTask[];
  };
  ENQUEUE_MULTIPART_ITEMS: {
    groupBatchId: string;
    taskIds: string[];
    tasks: ExtensionDownloadTask[];
  };
  CANCEL_TASK: { taskId: string; cancelled: boolean };
  RETRY_TASK: { task: ExtensionDownloadTask };
  CLEAR_FINISHED_TASKS: { remainingCount: number };
  OPEN_DOWNLOAD_FOLDER: { opened: boolean };
  CONSUME_INTENT: { intent: PendingPanelIntent | null };
}

export type BackgroundToSidePanelBroadcast =
  | { type: "STATE_SNAPSHOT"; snapshot: ExtensionStateSnapshot }
  | {
      type: "TASKS_UPDATED";
      tasks: ExtensionDownloadTask[];
      savedWorkFingerprints?: string[];
    }
  | { type: "TAB_SYNC_UPDATED"; tabSync: TabSyncState }
  | { type: "PANEL_INTENT"; intent: PendingPanelIntent }
  | { type: "PARSE_PROGRESS"; stage: 1 | 2 | 3; statusText: string };

export type SidePanelChannelMessage =
  | SidePanelToBackgroundRequest
  | BackgroundToSidePanelBroadcast;

// ============================================================================
// Background <-> Offscreen Message Contracts
// ============================================================================

export type BackgroundToOffscreenRequest =
  | { type: "OFFSCREEN_PING" }
  | {
      type: "OFFSCREEN_YOUTUBE_PREFETCH";
      payload: YouTubeHelperPrefetchPayload;
      timeoutMs?: number;
    }
  | {
      type: "OFFSCREEN_YOUTUBE_PLAYER";
      payload: YouTubeHelperPlayerPayload;
      timeoutMs?: number;
    }
  | {
      type: "OFFSCREEN_START_TASK";
      taskId: string;
      spec: OffscreenDownloadSpec;
    }
  | { type: "OFFSCREEN_CANCEL_TASK"; taskId: string }
  | {
      type: "RELEASE_BLOB";
      taskId: string;
      blobUrl: string;
      opfsTempName?: string;
    };

export interface OffscreenResponseMap {
  OFFSCREEN_PING: {
    ready: boolean;
    activeTaskCount: number;
    pendingBlobCount: number;
    helperVersion?: string;
  };
  OFFSCREEN_YOUTUBE_PREFETCH: { prefetch: YouTubeHelperPrefetchResult };
  OFFSCREEN_YOUTUBE_PLAYER: { player: YouTubeHelperPlayerResult };
  OFFSCREEN_START_TASK: { accepted: boolean };
  OFFSCREEN_CANCEL_TASK: { cancelled: boolean };
  RELEASE_BLOB: { released: boolean };
}

export type OffscreenToBackgroundMessage =
  | {
      type: "HANDOFF_BLOB_DOWNLOAD";
      taskId: string;
      blobUrl: string;
      filename: string;
      mimeType?: string;
      sizeBytes?: number;
      opfsTempName?: string;
    }
  | {
      type: "OFFSCREEN_TASK_PROGRESS";
      taskId: string;
      status: "downloading" | "muxing" | "saving";
      statusText: string;
      percent: number;
      loaded: number;
      total: number;
      speed: number;
    }
  | {
      type: "OFFSCREEN_TASK_ERROR";
      taskId: string;
      error: string;
      code?: string;
      httpStatus?: number;
      cancelled?: boolean;
      unwhitelistedHost?: string;
      fallbackUrl?: string;
    }
  | {
      type: "OFFSCREEN_HEARTBEAT";
      activeTaskCount: number;
      pendingBlobCount: number;
      timestamp: number;
    };

export interface HandOffBlobDownloadResult {
  chromeDownloadId: number;
}

export type OffscreenChannelMessage =
  | BackgroundToOffscreenRequest
  | OffscreenToBackgroundMessage;

// ============================================================================
// Web SPA <-> Installed Extension External Bridge Contracts (Zero-Secret)
// ============================================================================

export type WebBridgeCapability =
  | "dash_mux"
  | "direct_download"
  | "youtube_parse"
  | "youtube_mux";

export interface WebExtDashMuxPayload {
  videoRoutes: string[];
  audioRoutes: string[];
  videoSize?: number;
  audioSize?: number;
  outputContainer?: "mp4";
}

export interface WebExtYouTubeMuxPayload {
  videoUrl: string;
  audioUrl: string;
  videoSize?: number;
  audioSize?: number;
  outputContainer: "mp4" | "webm";
}

export type WebExtEnqueuePayload =
  | {
      kind: "dash_mux";
      platform: string;
      title?: string;
      filename: string;
      dashMux: WebExtDashMuxPayload;
      sizeBytes?: number;
      mimeType?: string;
    }
  | {
      kind: "direct_download";
      platform: string;
      title?: string;
      filename: string;
      routes: string[];
      sizeBytes?: number;
      mimeType?: string;
    }
  | {
      kind: "youtube_mux";
      platform: string;
      title?: string;
      filename: string;
      youtubeMux: WebExtYouTubeMuxPayload;
      sizeBytes?: number;
      mimeType?: string;
    }
  | {
      kind: "youtube_direct";
      platform: string;
      title?: string;
      filename: string;
      url: string;
      sizeBytes?: number;
      mimeType?: string;
    };

export type WebToExtensionRequest =
  | { type: "WEB_EXT_PING" }
  | {
      type: "WEB_EXT_PARSE_YOUTUBE";
      videoId: string;
      locale?: "zh-CN" | "en";
    }
  | {
      type: "WEB_EXT_ENQUEUE_MEDIA";
      payload: WebExtEnqueuePayload;
    }
  | {
      type: "WEB_EXT_GET_TASK_STATUS";
      taskId: string;
    }
  | {
      type: "WEB_EXT_CANCEL_TASK";
      taskId: string;
    };

export interface WebExtPingData {
  version: string;
  extensionId: string;
  capabilities: WebBridgeCapability[];
}

export interface WebExtParseYouTubeData {
  media: UnifiedMedia;
}

export interface WebExtEnqueueMediaData {
  taskId: string;
  status: ExtensionTaskStatus;
}

export interface WebExtCancelTaskData {
  taskId: string;
  cancelled: boolean;
}

export type WebExtTaskPhase =
  | "queued"
  | "downloading"
  | "muxing"
  | "saving"
  | "completed"
  | "failed"
  | "cancelled";

export interface WebExtTaskStatusData {
  taskId: string;
  status: ExtensionTaskStatus;
  phase: WebExtTaskPhase;
  statusText?: string;
  progress: number;
  loadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  filename: string;
  filenameWarning?: string;
  error?: string;
}

export interface WebToExtensionResponseMap {
  WEB_EXT_PING: WebExtPingData;
  WEB_EXT_PARSE_YOUTUBE: WebExtParseYouTubeData;
  WEB_EXT_ENQUEUE_MEDIA: WebExtEnqueueMediaData;
  WEB_EXT_GET_TASK_STATUS: WebExtTaskStatusData;
  WEB_EXT_CANCEL_TASK: WebExtCancelTaskData;
}

export type AnyExtensionRuntimeMessage =
  | SidePanelChannelMessage
  | OffscreenChannelMessage;

const WEB_TO_EXTENSION_REQUEST_TYPES = new Set<WebToExtensionRequest["type"]>([
  "WEB_EXT_PING",
  "WEB_EXT_PARSE_YOUTUBE",
  "WEB_EXT_ENQUEUE_MEDIA",
  "WEB_EXT_GET_TASK_STATUS",
  "WEB_EXT_CANCEL_TASK",
]);

const SIDEPANEL_REQUEST_TYPES = new Set<SidePanelToBackgroundRequest["type"]>([
  "GET_INITIAL_STATE",
  "UPDATE_SETTINGS",
  "TEST_CONNECTION",
  "FETCH_OWNER_STATS",
  "PARSE_URL",
  "RESOLVE_LAZY_ITEM",
  "ENQUEUE_DOWNLOADS",
  "ENQUEUE_BATCH_URLS",
  "ENQUEUE_MULTIPART_ITEMS",
  "CANCEL_TASK",
  "RETRY_TASK",
  "CLEAR_FINISHED_TASKS",
  "OPEN_DOWNLOAD_FOLDER",
  "CONSUME_INTENT",
]);

const BACKGROUND_BROADCAST_TYPES = new Set<
  BackgroundToSidePanelBroadcast["type"]
>([
  "STATE_SNAPSHOT",
  "TASKS_UPDATED",
  "TAB_SYNC_UPDATED",
  "PANEL_INTENT",
  "PARSE_PROGRESS",
]);

const BG_TO_OFFSCREEN_TYPES = new Set<BackgroundToOffscreenRequest["type"]>([
  "OFFSCREEN_PING",
  "OFFSCREEN_YOUTUBE_PREFETCH",
  "OFFSCREEN_YOUTUBE_PLAYER",
  "OFFSCREEN_START_TASK",
  "OFFSCREEN_CANCEL_TASK",
  "RELEASE_BLOB",
]);

const OFFSCREEN_TO_BG_TYPES = new Set<OffscreenToBackgroundMessage["type"]>([
  "HANDOFF_BLOB_DOWNLOAD",
  "OFFSCREEN_TASK_PROGRESS",
  "OFFSCREEN_TASK_ERROR",
  "OFFSCREEN_HEARTBEAT",
]);

function hasMessageType(msg: unknown): msg is { type: string } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    typeof (msg as { type?: unknown }).type === "string"
  );
}

export function isSidePanelRequest(
  msg: unknown,
): msg is SidePanelToBackgroundRequest {
  return (
    hasMessageType(msg) &&
    SIDEPANEL_REQUEST_TYPES.has(
      msg.type as SidePanelToBackgroundRequest["type"],
    )
  );
}

export function isEnqueueMultiPartItemsRequest(
  msg: unknown,
): msg is EnqueueMultiPartItemsRequest {
  if (!hasMessageType(msg) || msg.type !== "ENQUEUE_MULTIPART_ITEMS") {
    return false;
  }
  const rec = msg as Record<string, unknown>;
  const media = rec.media as Record<string, unknown> | null | undefined;
  return (
    Boolean(media && typeof media === "object" && typeof media.platform === "string") &&
    Array.isArray(rec.items)
  );
}

export function isBackgroundBroadcast(
  msg: unknown,
): msg is BackgroundToSidePanelBroadcast {
  return (
    hasMessageType(msg) &&
    BACKGROUND_BROADCAST_TYPES.has(
      msg.type as BackgroundToSidePanelBroadcast["type"],
    )
  );
}

export function isBackgroundToOffscreenRequest(
  msg: unknown,
): msg is BackgroundToOffscreenRequest {
  return (
    hasMessageType(msg) &&
    BG_TO_OFFSCREEN_TYPES.has(msg.type as BackgroundToOffscreenRequest["type"])
  );
}

export function isOffscreenToBackgroundMessage(
  msg: unknown,
): msg is OffscreenToBackgroundMessage {
  return (
    hasMessageType(msg) &&
    OFFSCREEN_TO_BG_TYPES.has(msg.type as OffscreenToBackgroundMessage["type"])
  );
}

export function isWebToExtensionRequest(
  msg: unknown,
): msg is WebToExtensionRequest {
  return (
    hasMessageType(msg) &&
    WEB_TO_EXTENSION_REQUEST_TYPES.has(
      msg.type as WebToExtensionRequest["type"],
    )
  );
}
