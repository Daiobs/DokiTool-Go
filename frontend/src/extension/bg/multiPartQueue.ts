import { isPlaceholderPartTitle } from "../../core/media";
import type { MediaItem, UnifiedMedia } from "../../types/media";
import { readyItem } from "../../utils/mediaContract";
import { buildEnqueueItemsForMedia } from "../planning/enqueuePlanBuilder";
import { buildSafeDownloadPath } from "../filenameSanitizer";
import type {
  EnqueueDownloadItem,
  EnqueueMultiPartItemsRequest,
  ExtensionDownloadTask,
  ExtensionSettings,
  MatchedPlatformUrl,
  MultiPartEnqueueItemInput,
  MultiPartEnqueueMediaMeta,
  OffscreenDownloadSpec,
  QualityPreference,
} from "../protocol";
import { buildWorkFingerprint, type ExtensionStorageController } from "../storage";
import {
  buildSingleDownloadEnqueueItem,
  extractParseUrlFromRefreshUrl,
} from "../targetSpecBuilder";
import {
  buildSidePanelQualityOptions,
  resolveSafeApiOrigin,
  selectPreferredQualityOption,
} from "../uiTargetHelpers";
import { matchActiveParseUrl } from "../urlMatcher";

export const DEFAULT_MULTIPART_RESOLVE_CONCURRENCY = 2 as const;

export interface MultiPartQueueDeps {
  storage: ExtensionStorageController;
  nowFn: () => number;
  maxBatchDownloadConcurrency: number;
  maxResolveConcurrency?: number;
  isDisposed: () => boolean;
  nextId: (prefix: string) => string;
  tasks: Map<string, ExtensionDownloadTask>;
  parseAbortControllers: Map<string, AbortController>;
  insertOrUpdateTask: (task: ExtensionDownloadTask) => void;
  waitTaskSettled: (taskId: string) => Promise<void>;
  trackBackgroundJob: <T>(promise: Promise<T>) => Promise<T>;
  broadcastTasksUpdated: (includeSavedFingerprints?: boolean) => Promise<void>;
  onTaskHistoryChange?: (options?: { immediate?: boolean }) => Promise<void> | void;
  updateBadge: (
    terminalOutcome?: "completed" | "failed" | "clear",
    options?: { progressOnly?: boolean },
  ) => void;
  scheduleOffscreenIdleCloseIfIdle: () => void;
  resolveExtraAllowedMediaOrigins: (settings: ExtensionSettings) => Promise<string[]>;
  parseSupportedUrlInternal: (
    matched: MatchedPlatformUrl,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ) => Promise<UnifiedMedia>;
  resolveLazyItemInternal: (
    rawResolveUrl: string,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ) => Promise<UnifiedMedia>;
  enrichSpecAllowedOrigins: (
    spec: OffscreenDownloadSpec,
    settings: ExtensionSettings,
  ) => Promise<OffscreenDownloadSpec>;
  dispatchSpecTaskToOffscreen: (
    taskId: string,
    spec: OffscreenDownloadSpec,
    dispatchOpts?: { forceRefresh?: boolean; skipAutoRefresh?: boolean },
  ) => Promise<void>;
}

export interface MultiPartQueue {
  enqueueMultiPartItems(req: Omit<EnqueueMultiPartItemsRequest, "type">): Promise<{
    groupBatchId: string;
    taskIds: string[];
    tasks: ExtensionDownloadTask[];
  }>;
}

function createAsyncSemaphore(limit: number) {
  const capacity = Math.max(1, Math.floor(limit));
  let inUse = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (inUse < capacity) inUse += 1;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next) next();
        else inUse = Math.max(0, inUse - 1);
      };
    },
  };
}

const resolveWorkFolderTitle = (media: MultiPartEnqueueMediaMeta): string =>
  media.title?.trim() ||
  media.authorName?.trim() ||
  (media.contentId?.trim() ? `${media.platform}_${media.contentId.trim()}` : "") ||
  media.platform ||
  "download";

const stripWorkTitlePrefix = (rawTitle: string | undefined, workTitle: string): string | undefined => {
  let t = rawTitle?.trim() || "";
  if (!t) return undefined;
  const wt = workTitle.trim();
  if (wt && t.startsWith(wt)) {
    const rest = t.slice(wt.length).trim();
    if (!rest || /^#\d+$/.test(rest)) return undefined;
    if (rest.startsWith("-") && rest.slice(1).trim()) {
      t = rest.slice(1).trim();
    }
  }
  return t || undefined;
};

const resolveCleanEpisodeStem = (itemTitle: string | undefined, workTitle: string): string | undefined => {
  const t = stripWorkTitlePrefix(itemTitle, workTitle);
  return t && !isPlaceholderPartTitle(t) && t !== workTitle ? t : undefined;
};

const resolveCanonicalPageUrl = (
  item: MultiPartEnqueueItemInput,
  media: MultiPartEnqueueMediaMeta,
): string =>
  item.sourceUrl?.trim() ||
  media.sourceUrl?.trim() ||
  extractParseUrlFromRefreshUrl(media.refreshUrl) ||
  "";

function buildResolvedPartEnqueueItem(p: {
  mediaMeta: MultiPartEnqueueMediaMeta;
  resolvedMedia: UnifiedMedia;
  targetItem: MediaItem;
  inputItem: MultiPartEnqueueItemInput;
  settings: ExtensionSettings;
  qualityPreference: QualityPreference;
  subfolderPrefix: string;
  workTitle: string;
  totalCount: number;
  workFingerprint?: string;
  canonicalPageUrl: string;
  extraAllowedOrigins: string[];
  now: number;
}): EnqueueDownloadItem {
  const effectiveItem: MediaItem =
    p.targetItem.state !== "unavailable" && !p.targetItem.resolve_url && p.inputItem.resolveUrl
      ? { ...p.targetItem, resolve_url: p.inputItem.resolveUrl }
      : p.targetItem;
  const effectiveMedia: UnifiedMedia = {
    ...p.resolvedMedia,
    platform: p.resolvedMedia.platform || p.mediaMeta.platform,
    title: p.mediaMeta.title?.trim() || p.resolvedMedia.title,
    source_url: p.resolvedMedia.source_url || p.mediaMeta.sourceUrl,
    refresh_url: p.resolvedMedia.refresh_url || p.mediaMeta.refreshUrl,
    ...(p.mediaMeta.authorName && !p.resolvedMedia.author?.name
      ? { author: { ...p.resolvedMedia.author, name: p.mediaMeta.authorName } }
      : {}),
    items: p.resolvedMedia.items.map((it) => (it.id === effectiveItem.id ? effectiveItem : it)),
  };
  const apiOrigin = resolveSafeApiOrigin(p.settings.apiBaseUrl);
  const chosen = selectPreferredQualityOption(
    buildSidePanelQualityOptions(effectiveMedia, effectiveItem, apiOrigin),
    effectiveItem, p.qualityPreference, effectiveMedia, apiOrigin,
  );
  if (chosen?.downloadable) {
    let built = buildSingleDownloadEnqueueItem({
      media: effectiveMedia, item: effectiveItem, option: chosen,
      settings: { ...p.settings, qualityPreference: p.qualityPreference, subfolderPrefix: p.subfolderPrefix },
      workFingerprint: p.workFingerprint,
    });
    if (p.totalCount > 1) {
      const stem = resolveCleanEpisodeStem(effectiveItem.title || p.inputItem.title, p.workTitle);
      built = {
        ...built,
        title: stem ? `${p.workTitle} - ${stem}` : `${p.workTitle} #${p.inputItem.index}`,
        spec: {
          ...built.spec,
          filename: buildSafeDownloadPath({
            prefix: p.subfolderPrefix, subfolder: p.workTitle,
            index: p.inputItem.index, totalCount: p.totalCount, stem, ext: chosen.resolvedExt,
          }),
        },
      };
    }
    return built;
  }
  return buildEnqueueItemsForMedia(effectiveMedia, {
    apiOrigin, qualityPreference: p.qualityPreference, batchSaveMode: "subfolder",
    subfolderPrefix: p.subfolderPrefix, itemIds: [effectiveItem.id],
    forceSubfolder: p.totalCount > 1, extraAllowedOrigins: p.extraAllowedOrigins,
    sourceUrl: p.canonicalPageUrl || undefined, now: p.now,
  })[0];
}

/**
 * Background streaming multi-P resolution & download queue with bounded lazy
 * resolve concurrency (`<= 2`) and per-task cancellation support.
 */
export function createMultiPartQueue(deps: MultiPartQueueDeps): MultiPartQueue {
  const resolveSemaphore = createAsyncSemaphore(
    Math.min(
      DEFAULT_MULTIPART_RESOLVE_CONCURRENCY,
      Math.max(1, deps.maxResolveConcurrency ?? DEFAULT_MULTIPART_RESOLVE_CONCURRENCY),
    ),
  );

  const resolveItemMedia = async (
    item: MultiPartEnqueueItemInput,
    canonicalPageUrl: string,
    latestSettings: ExtensionSettings,
    signal: AbortSignal,
  ): Promise<UnifiedMedia> => {
    if (item.resolveUrl && item.resolveUrl.startsWith("/api/resolve?")) {
      return deps.resolveLazyItemInternal(item.resolveUrl, latestSettings, signal);
    }
    const matched = canonicalPageUrl ? matchActiveParseUrl(canonicalPageUrl) : null;
    if (!matched) throw new Error("缺少可解析的分集来源链接");
    const parsed = await deps.parseSupportedUrlInternal(matched, latestSettings, signal);
    const def = parsed.items.find(
      (it) => it.id === item.itemId && it.state === "deferred" && Boolean(it.resolve_url),
    );
    if (def && def.state === "deferred" && def.resolve_url) {
      const sub = await deps.resolveLazyItemInternal(def.resolve_url, latestSettings, signal);
      const ready = sub.items.find((it) => it.id === item.itemId);
      if (ready && readyItem(ready)) {
        return {
          ...parsed,
          items: parsed.items.map((it) => (it.id === item.itemId ? ready : it)),
          attachments: [...(parsed.attachments ?? []), ...(sub.attachments ?? [])],
        };
      }
    }
    return parsed;
  };

  const enqueueMultiPartItems: MultiPartQueue["enqueueMultiPartItems"] = async (req) => {
    if (!Array.isArray(req.items) || req.items.length === 0) {
      throw new Error("请至少选择一个要下载的分集或条目");
    }
    const settings = await deps.storage.getSettings();
    const qualityPreference = req.qualityPreference ?? settings.qualityPreference;
    const subfolderPrefix =
      req.subfolderPrefix !== undefined ? req.subfolderPrefix : settings.subfolderPrefix;
    const groupBatchId = req.groupBatchId?.trim() || deps.nextId("multipart");
    const workTitle = resolveWorkFolderTitle(req.media);
    const totalCount = Math.max(req.media.totalItemCount ?? 0, req.items.length);
    const workFingerprint =
      req.media.workFingerprint?.trim() ||
      buildWorkFingerprint({
        platform: req.media.platform,
        content_id: req.media.contentId,
        source_url: req.media.sourceUrl,
      }) ||
      undefined;

    const createdTasks: ExtensionDownloadTask[] = [];
    const createdIds: string[] = [];

    for (let i = req.items.length - 1; i >= 0; i--) {
      const item = req.items[i];
      const taskId = deps.nextId("task");
      const ts = deps.nowFn();
      const canonicalPageUrl = resolveCanonicalPageUrl(item, req.media);
      const stem = resolveCleanEpisodeStem(item.title, workTitle);
      const task: ExtensionDownloadTask = {
        taskId, groupBatchId,
        title: item.title?.trim() || (stem ? `${workTitle} - ${stem}` : `${workTitle} #${item.index}`),
        filename:
          item.spec?.filename ||
          item.filenameHint?.trim() ||
          buildSafeDownloadPath({
            prefix: subfolderPrefix, subfolder: totalCount > 1 ? workTitle : undefined,
            index: totalCount > 1 ? item.index : undefined, totalCount,
            stem: stem || (totalCount > 1 ? undefined : workTitle), ext: "mp4",
          }),
        platform: req.media.platform,
        ...(workFingerprint ? { workFingerprint } : {}),
        ...(canonicalPageUrl ? { sourcePageUrl: canonicalPageUrl } : {}),
        status: "queued",
        statusText: item.state === "deferred" && !item.spec ? "排队等待后台解析..." : "排队等待下载...",
        percent: 0, loaded: 0, total: item.spec?.sizeBytes ?? 0, speed: 0,
        ...(item.fallbackUrl || canonicalPageUrl ? { fallbackUrl: item.fallbackUrl || canonicalPageUrl } : {}),
        createdAt: ts, updatedAt: ts,
        ...(item.spec
          ? { retryPayload: { kind: "spec", spec: item.spec } }
          : canonicalPageUrl
            ? {
                retryPayload: {
                  kind: "url", url: canonicalPageUrl, itemId: item.itemId,
                  qualityPreference, batchSaveMode: "subfolder", subfolderPrefix,
                },
              }
            : {}),
      };
      deps.insertOrUpdateTask(task);
      createdTasks.unshift(task);
      createdIds.unshift(taskId);
    }

    deps.updateBadge();
    await deps.onTaskHistoryChange?.({ immediate: true });
    await deps.broadcastTasksUpdated();

    const jobs = createdIds.map((taskId, idx) => ({ taskId, item: req.items[idx] }));
    const processOneJob = async (taskId: string, item: MultiPartEnqueueItemInput) => {
      if (deps.isDisposed() || !deps.tasks.get(taskId) || deps.tasks.get(taskId)?.status === "cancelled") return;
      const latestSettings = await deps.storage.getSettings();
      const canonicalPageUrl = resolveCanonicalPageUrl(item, req.media);

      if (item.spec) {
        const enrichedSpec = await deps.enrichSpecAllowedOrigins(item.spec, latestSettings);
        if (deps.isDisposed() || deps.tasks.get(taskId)?.status === "cancelled") return;
        await deps.dispatchSpecTaskToOffscreen(taskId, enrichedSpec);
        await deps.waitTaskSettled(taskId);
        return;
      }

      const releaseResolve = await resolveSemaphore.acquire();
      let abortCtrl: AbortController | null = null;
      let resolvedSpec: OffscreenDownloadSpec | null = null;
      try {
        const before = deps.tasks.get(taskId);
        if (deps.isDisposed() || !before || before.status === "cancelled") return;
        abortCtrl = new AbortController();
        deps.parseAbortControllers.set(taskId, abortCtrl);
        deps.tasks.set(taskId, {
          ...before, status: "parsing", statusText: "正在后台解析分集地址...",
          error: undefined, updatedAt: deps.nowFn(),
        });
        deps.updateBadge();
        await deps.broadcastTasksUpdated();

        const resolvedMedia = await resolveItemMedia(item, canonicalPageUrl, latestSettings, abortCtrl.signal);
        if (deps.isDisposed() || abortCtrl.signal.aborted || deps.tasks.get(taskId)?.status === "cancelled") return;
        const targetItem =
          resolvedMedia.items.find((it) => it.id === item.itemId) ??
          (resolvedMedia.items.length === 1 ? resolvedMedia.items[0] : undefined);
        if (!targetItem || !readyItem(targetItem)) throw new Error("分集解析完成但暂无可用下载源");

        const extraAllowedOrigins = await deps.resolveExtraAllowedMediaOrigins(latestSettings);
        const builtItem = buildResolvedPartEnqueueItem({
          mediaMeta: req.media, resolvedMedia, targetItem, inputItem: item,
          settings: latestSettings, qualityPreference, subfolderPrefix, workTitle,
          totalCount, workFingerprint, canonicalPageUrl, extraAllowedOrigins, now: deps.nowFn(),
        });
        const enrichedSpec = await deps.enrichSpecAllowedOrigins(builtItem.spec, latestSettings);
        const latest = deps.tasks.get(taskId);
        if (deps.isDisposed() || abortCtrl.signal.aborted || !latest || latest.status === "cancelled") return;
        deps.tasks.set(taskId, {
          ...latest, title: builtItem.title, filename: enrichedSpec.filename,
          platform: builtItem.platform || latest.platform,
          ...(builtItem.workFingerprint ? { workFingerprint: builtItem.workFingerprint } : {}),
          fallbackUrl: builtItem.fallbackUrl || canonicalPageUrl || latest.fallbackUrl,
          status: "queued", statusText: "解析完成，排队下载...",
          total: enrichedSpec.sizeBytes ?? latest.total, error: undefined,
          updatedAt: deps.nowFn(), retryPayload: { kind: "spec", spec: enrichedSpec },
        });
        deps.updateBadge();
        await deps.broadcastTasksUpdated();
        resolvedSpec = enrichedSpec;
      } catch (err) {
        const cur = deps.tasks.get(taskId);
        if (cur) {
          const cancelled =
            cur.status === "cancelled" ||
            abortCtrl?.signal.aborted === true ||
            (err instanceof Error && err.name === "AbortError");
          deps.tasks.set(taskId, {
            ...cur, status: cancelled ? "cancelled" : "failed",
            statusText: cancelled ? "已取消" : "分集解析失败", speed: 0,
            error: cancelled ? undefined : err instanceof Error && err.message ? err.message : "分集解析失败",
            updatedAt: deps.nowFn(),
            ...(!cancelled && canonicalPageUrl
              ? {
                  retryPayload: {
                    kind: "url", url: canonicalPageUrl, itemId: item.itemId,
                    qualityPreference, batchSaveMode: "subfolder", subfolderPrefix,
                  },
                }
              : {}),
          });
          deps.updateBadge(cancelled ? undefined : "failed");
          await deps.onTaskHistoryChange?.({ immediate: true });
          await deps.broadcastTasksUpdated();
          deps.scheduleOffscreenIdleCloseIfIdle();
        }
        return;
      } finally {
        deps.parseAbortControllers.delete(taskId);
        releaseResolve();
      }

      if (resolvedSpec && !deps.isDisposed() && deps.tasks.get(taskId)?.status !== "cancelled") {
        await deps.dispatchSpecTaskToOffscreen(taskId, resolvedSpec);
        await deps.waitTaskSettled(taskId);
      }
    };

    void deps.trackBackgroundJob(
      (async () => {
        let cursor = 0;
        const workerCount = Math.min(Math.max(1, deps.maxBatchDownloadConcurrency), jobs.length);
        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (!deps.isDisposed()) {
              const idx = cursor++;
              if (idx >= jobs.length) break;
              await processOneJob(jobs[idx].taskId, jobs[idx].item);
            }
          }),
        );
      })(),
    );

    return { groupBatchId, taskIds: createdIds, tasks: createdTasks };
  };

  return { enqueueMultiPartItems };
}
