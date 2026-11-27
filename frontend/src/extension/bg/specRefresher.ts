import type { ReadyVariant, Resource, UnifiedMedia } from "../../types/media";
import {
  availableSources,
  deliveryRoutes,
  readyItem,
  readyVariant,
  sourceUrl,
  type TargetContext,
} from "../../utils/mediaContract";
import { selectYouTubeMuxPair } from "../../utils/youtubeHelperCore";
import {
  computeEarliestExpiresAtMs,
  extractDashMuxSpec,
  extractVariantEarliestExpiresAtMs,
} from "../dashMuxSpec";
import { buildEnqueueItemsForMedia } from "../planning/enqueuePlanBuilder";
import {
  isSafeNativeBrowserDownloadUrl,
  isWhitelistedMediaUrl,
  validateApiBaseUrl,
} from "../hostWhitelist";
import type {
  ExtensionDownloadTask,
  ExtensionSettings,
  MatchedPlatformUrl,
  MediaRefreshContext,
  OffscreenDownloadSpec,
} from "../protocol";
import { extractParseUrlFromRefreshUrl } from "../targetSpecBuilder";
import { buildExtensionTargetContext } from "../uiTargetHelpers";
import { matchActiveParseUrl } from "../urlMatcher";

export function isSpecExpiredForDispatch(
  spec: OffscreenDownloadSpec,
  nowFn: () => number,
): boolean {
  const exp = spec.refreshContext?.expiresAtMs;
  return (
    typeof exp === "number" && Number.isFinite(exp) && exp <= nowFn() + 5_000
  );
}

/**
 * Checks whether a streaming / muxing / batch_zip spec contains any route or
 * segment whose host is outside the extension's whitelisted media origins.
 * Returns the first unwhitelisted URL (or `""` if missing), or `undefined` when all pass.
 */
export function findUnwhitelistedStreamRoute(
  spec: OffscreenDownloadSpec,
  isWhitelistedRoute: (rawUrl: string) => boolean,
): string | undefined {
  if (spec.kind === "hls") {
    return spec.routes.some(isWhitelistedRoute) ? undefined : spec.routes[0] || "";
  }
  if (spec.kind === "segments") {
    if (!spec.routes.some(isWhitelistedRoute)) {
      return spec.routes[0] || "";
    }
    for (const seg of spec.segments ?? []) {
      const segRoutes = seg.routes?.length
        ? seg.routes
        : seg.url
          ? [seg.url]
          : [];
      if (!segRoutes.some(isWhitelistedRoute)) {
        return segRoutes[0] || "";
      }
    }
    return undefined;
  }
  if (spec.kind === "dash_mux") {
    const videoRoutes = spec.dashMux?.videoRoutes ?? [];
    const audioRoutes = spec.dashMux?.audioRoutes ?? [];
    if (!videoRoutes.some(isWhitelistedRoute)) {
      return videoRoutes[0] || "";
    }
    if (!audioRoutes.some(isWhitelistedRoute)) {
      return audioRoutes[0] || "";
    }
    return undefined;
  }
  if (spec.kind === "youtube_mux") {
    const videoUrl = spec.youtubeMux?.videoUrl ?? "";
    const audioUrl = spec.youtubeMux?.audioUrl ?? "";
    if (!videoUrl || !isWhitelistedRoute(videoUrl)) {
      return videoUrl;
    }
    if (!audioUrl || !isWhitelistedRoute(audioUrl)) {
      return audioUrl;
    }
    return undefined;
  }
  if (spec.kind === "batch_zip") {
    for (const entry of spec.zipEntries ?? []) {
      if (!entry.routes.some(isWhitelistedRoute)) {
        return entry.routes[0] || "";
      }
      for (const seg of entry.segments ?? []) {
        const segRoutes = seg.routes?.length
          ? seg.routes
          : seg.url
            ? [seg.url]
            : [];
        if (!segRoutes.some(isWhitelistedRoute)) {
          return segRoutes[0] || "";
        }
      }
    }
  }
  return undefined;
}

export type DispatchRouteDecision =
  | { mode: "offscreen" }
  | { mode: "native"; url: string }
  | {
      mode: "blocked";
      message: string;
      unwhitelistedHost?: string;
      fallbackUrl?: string;
    };

/**
 * Zero-`<all_urls>` routing guard executed BEFORE launching `offscreen.html`.
 */
export function classifySpecDispatchRoute(
  spec: OffscreenDownloadSpec,
  effectiveAllowedOrigins: string[],
  existingFallbackUrl?: string,
): DispatchRouteDecision {
  const isWhitelistedRoute = (rawUrl: string): boolean =>
    isWhitelistedMediaUrl(rawUrl, effectiveAllowedOrigins).allowed;

  if (spec.kind === "direct_file") {
    if (spec.routes.some(isWhitelistedRoute)) {
      return { mode: "offscreen" };
    }
    const nativeUrl = spec.routes.find(
      (r) => isSafeNativeBrowserDownloadUrl(r, effectiveAllowedOrigins).safe,
    );
    if (nativeUrl) {
      return { mode: "native", url: nativeUrl };
    }
    const firstRoute = spec.routes[0] || "";
    const check = firstRoute
      ? isSafeNativeBrowserDownloadUrl(firstRoute, effectiveAllowedOrigins)
      : { safe: false, hostname: "", reason: "缺少可用下载线路" };
    return {
      mode: "blocked",
      message: check.reason || "下载链接不符合安全规则，已拦截下载",
      unwhitelistedHost: check.hostname || undefined,
      fallbackUrl: existingFallbackUrl || firstRoute || undefined,
    };
  }

  if (
    spec.kind === "hls" ||
    spec.kind === "segments" ||
    spec.kind === "dash_mux" ||
    spec.kind === "youtube_mux" ||
    spec.kind === "batch_zip"
  ) {
    const badRoute = findUnwhitelistedStreamRoute(spec, isWhitelistedRoute);
    if (badRoute !== undefined) {
      const check = badRoute
        ? isWhitelistedMediaUrl(badRoute, effectiveAllowedOrigins)
        : { allowed: false, hostname: "" };
      return {
        mode: "blocked",
        message:
          spec.kind === "batch_zip"
            ? "该长尾站点媒体域名不在扩展打包白名单内，请使用子文件夹方式原生下载"
            : "该长尾流媒体（HLS/合流）域名不在扩展白名单内，请复制直链或打开原帖下载",
        unwhitelistedHost: check.hostname || undefined,
        fallbackUrl:
          existingFallbackUrl || spec.routes[0] || badRoute || undefined,
      };
    }
  }

  return { mode: "offscreen" };
}

export interface SpecRefresherDeps {
  nowFn: () => number;
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
}

export interface PrepareSpecForDispatchParams {
  taskId: string;
  spec: OffscreenDownloadSpec;
  settings: ExtensionSettings;
  dispatchOpts?: { forceRefresh?: boolean; skipAutoRefresh?: boolean };
  tasks: Map<string, ExtensionDownloadTask>;
  parseAbortControllers: Map<string, AbortController>;
  resolveExtraAllowedMediaOrigins: (
    settings: ExtensionSettings,
  ) => Promise<string[]>;
  updateBadge: (
    terminalOutcome?: "completed" | "failed" | "clear",
    options?: { progressOnly?: boolean },
  ) => void;
  broadcastTasksUpdated: (includeSavedFingerprints?: boolean) => Promise<void>;
  scheduleOffscreenIdleCloseIfIdle: () => void;
  notifyIfCompletelyIdle: () => void;
}

export type PrepareSpecForDispatchResult =
  | {
      ok: true;
      enrichedSpec: OffscreenDownloadSpec;
      effectiveAllowedOrigins: string[];
      latestTask: ExtensionDownloadTask;
    }
  | { ok: false };

export interface SpecRefresher {
  isSpecExpiredForDispatch(spec: OffscreenDownloadSpec): boolean;
  refreshSpecFromContext(
    originalSpec: OffscreenDownloadSpec,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<OffscreenDownloadSpec>;
  prepareSpecForDispatch(
    params: PrepareSpecForDispatchParams,
  ): Promise<PrepareSpecForDispatchResult>;
}

export function createSpecRefresher(deps: SpecRefresherDeps): SpecRefresher {
  const { nowFn, parseSupportedUrlInternal, resolveLazyItemInternal } = deps;

  const checkExpired = (spec: OffscreenDownloadSpec): boolean =>
    isSpecExpiredForDispatch(spec, nowFn);

  const refreshSpecFromContext = async (
    originalSpec: OffscreenDownloadSpec,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<OffscreenDownloadSpec> => {
    const ctx = originalSpec.refreshContext;
    if (!ctx) {
      throw new Error("缺少可重新解析的媒体上下文");
    }

    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    const apiOrigin = validated.ok ? validated.origin : originalSpec.apiOrigin;
    const now = nowFn();
    const targetCtx: TargetContext = buildExtensionTargetContext(apiOrigin, now);

    let freshMedia: UnifiedMedia;
    const parseCandidate =
      ctx.parseUrl?.trim() || extractParseUrlFromRefreshUrl(ctx.refreshUrl);
    if (ctx.resolveUrl && ctx.resolveUrl.startsWith("/api/resolve?")) {
      freshMedia = await resolveLazyItemInternal(ctx.resolveUrl, settings, signal);
    } else if (parseCandidate) {
      const matched = matchActiveParseUrl(parseCandidate);
      if (!matched) {
        throw new Error("刷新链接无效或不受允许");
      }
      freshMedia = await parseSupportedUrlInternal(matched, settings, signal);
      const deferredMatch = freshMedia.items.find(
        (it) =>
          it.id === ctx.itemId &&
          it.state === "deferred" &&
          Boolean(it.resolve_url),
      );
      if (
        deferredMatch &&
        deferredMatch.state === "deferred" &&
        deferredMatch.resolve_url
      ) {
        const resolvedPart = await resolveLazyItemInternal(
          deferredMatch.resolve_url,
          settings,
          signal,
        );
        const resolvedItem = resolvedPart.items.find((it) => it.id === ctx.itemId);
        if (resolvedItem && readyItem(resolvedItem)) {
          freshMedia = {
            ...freshMedia,
            items: freshMedia.items.map((it) =>
              it.id === ctx.itemId
                ? resolvedItem.resolve_url
                  ? resolvedItem
                  : { ...resolvedItem, resolve_url: deferredMatch.resolve_url }
                : it,
            ),
            attachments: [
              ...(freshMedia.attachments ?? []),
              ...(resolvedPart.attachments ?? []),
            ],
          };
        }
      }
    } else {
      throw new Error("缺少可重新解析的媒体链接");
    }

    const targetItem =
      freshMedia.items.find((it) => it.id === ctx.itemId) ??
      (freshMedia.items.length === 1 ? freshMedia.items[0] : undefined);
    if (!targetItem || !readyItem(targetItem)) {
      throw new Error("重新解析后未找到对应的就绪媒体条目");
    }

    const buildNextRefreshContext = (
      expiresAtMs?: number,
    ): MediaRefreshContext => {
      const {
        expiresAtMs: _staleExp,
        refreshUrl: _staleRefreshUrl,
        ...baseCtx
      } = ctx;
      const nextResolveUrl =
        targetItem.resolve_url?.trim() || baseCtx.resolveUrl;
      const freshRefreshUrlRaw = freshMedia.refresh_url?.trim() || "";
      const freshRefreshUrl =
        freshRefreshUrlRaw.startsWith("/api/parse?") &&
        !/[\\\s#]/.test(freshRefreshUrlRaw)
          ? freshRefreshUrlRaw
          : undefined;
      const nextRefreshUrl = !nextResolveUrl
        ? freshRefreshUrl || _staleRefreshUrl
        : undefined;
      const nextParseUrl =
        baseCtx.parseUrl?.trim() ||
        targetItem.source_url?.trim() ||
        freshMedia.source_url?.trim() ||
        extractParseUrlFromRefreshUrl(nextRefreshUrl) ||
        "";
      return {
        ...baseCtx,
        parseUrl: nextParseUrl,
        ...(nextResolveUrl ? { resolveUrl: nextResolveUrl } : {}),
        ...(nextRefreshUrl ? { refreshUrl: nextRefreshUrl } : {}),
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
      };
    };

    const stripTransportFields = (
      base: OffscreenDownloadSpec,
    ): Omit<
      OffscreenDownloadSpec,
      "segments" | "youtubeMux" | "dashMux" | "zipEntries" | "sizeBytes"
    > => {
      const {
        segments: _s,
        youtubeMux: _y,
        dashMux: _d,
        zipEntries: _z,
        sizeBytes: _sz,
        ...rest
      } = base;
      return rest;
    };

    const basePreserved = stripTransportFields(originalSpec);

    // 1) Attachment-targeted refresh (e.g. standalone Bilibili M4A or BGM)
    if (ctx.attachmentId) {
      const expectedBiliId = `bilibili-audio-${targetItem.id}`;
      let audioRes: Resource | undefined = freshMedia.attachments?.find(
        (att) =>
          att &&
          (att.id === ctx.attachmentId ||
            (ctx.attachmentId!.startsWith("bilibili-audio-") &&
              att.id === expectedBiliId)) &&
          att.resource?.delivery?.kind === "file",
      )?.resource;

      if (
        !audioRes &&
        (ctx.attachmentId.startsWith("bilibili-audio-") ||
          ctx.attachmentId.startsWith("mux-audio-"))
      ) {
        for (const v of targetItem.variants) {
          if (!readyVariant(v) || v.delivery.kind !== "mux") continue;
          const leaf = v.delivery.resources.find(
            (r) => r.role === "audio" && r.delivery.kind === "file",
          );
          if (leaf) {
            audioRes = leaf;
            break;
          }
        }
      }

      if (audioRes && audioRes.delivery.kind === "file") {
        const avail = availableSources(audioRes.delivery.sources, now);
        const routes = deliveryRoutes(avail, targetCtx);
        if (routes.length > 0) {
          const expiresAtMs = computeEarliestExpiresAtMs(avail);
          const sizeBytes = avail[0]?.size_bytes ?? originalSpec.sizeBytes;
          return {
            ...basePreserved,
            kind: "direct_file",
            apiOrigin,
            routes,
            ...(sizeBytes ? { sizeBytes } : {}),
            refreshContext: buildNextRefreshContext(expiresAtMs),
          };
        }
      }
    }

    // 2) Variant-targeted refresh
    if (ctx.variantId) {
      const targetVariant = targetItem.variants.find(
        (v): v is ReadyVariant => readyVariant(v) && v.id === ctx.variantId,
      );
      if (targetVariant) {
        if (targetVariant.delivery.kind === "mux") {
          const dashMux = extractDashMuxSpec(targetVariant, targetCtx);
          if (dashMux) {
            const expiresAtMs = extractVariantEarliestExpiresAtMs(
              targetVariant,
              now,
            );
            const sizeBytes =
              (dashMux.videoSize || 0) + (dashMux.audioSize || 0) ||
              originalSpec.sizeBytes;
            return {
              ...basePreserved,
              kind: "dash_mux",
              apiOrigin,
              routes: dashMux.videoRoutes,
              mimeType: originalSpec.mimeType || "video/mp4",
              ...(sizeBytes ? { sizeBytes } : {}),
              dashMux,
              refreshContext: buildNextRefreshContext(expiresAtMs),
            };
          }
        } else if (targetVariant.delivery.kind === "file") {
          const avail = availableSources(targetVariant.delivery.sources, now);
          const routes = deliveryRoutes(avail, targetCtx);
          if (routes.length > 0) {
            if (
              originalSpec.kind === "youtube_mux" &&
              targetVariant.metadata?.has_audio === false
            ) {
              const pair = selectYouTubeMuxPair(
                targetVariant,
                targetItem.variants,
                freshMedia.attachments,
              );
              if (pair.ok) {
                const videoUrl = routes[0];
                const audioUrl = sourceUrl(pair.audioSource, targetCtx);
                const expiresAtMs = computeEarliestExpiresAtMs([
                  avail[0],
                  pair.audioSource,
                ]);
                const sizeBytes =
                  (avail[0]?.size_bytes || 0) +
                    (pair.audioSource.size_bytes || 0) ||
                  originalSpec.sizeBytes;
                return {
                  ...basePreserved,
                  kind: "youtube_mux",
                  apiOrigin,
                  routes: [videoUrl],
                  ...(sizeBytes ? { sizeBytes } : {}),
                  youtubeMux: {
                    videoUrl,
                    audioUrl,
                    ...(avail[0]?.size_bytes
                      ? { videoSize: avail[0].size_bytes }
                      : {}),
                    ...(pair.audioSource.size_bytes
                      ? { audioSize: pair.audioSource.size_bytes }
                      : {}),
                    outputContainer: pair.outputContainer,
                  },
                  refreshContext: buildNextRefreshContext(expiresAtMs),
                };
              }
            }

            const finalRoutes = [...routes];
            if (
              targetItem.type === "video" &&
              (freshMedia.platform === "zuiyou" ||
                freshMedia.platform === "pipigx") &&
              targetItem.tbvideo?.platform === freshMedia.platform
            ) {
              const srcId = avail[0]?.id;
              const tbCand =
                srcId && Object.hasOwn(targetItem.tbvideo.sources, srcId)
                  ? targetItem.tbvideo.sources[srcId]
                  : Object.values(targetItem.tbvideo.sources)[0];
              if (tbCand && !finalRoutes.includes(tbCand)) {
                finalRoutes.push(tbCand);
              }
            }
            const expiresAtMs = computeEarliestExpiresAtMs(avail);
            const sizeBytes = avail[0]?.size_bytes ?? originalSpec.sizeBytes;
            return {
              ...basePreserved,
              kind:
                originalSpec.kind === "youtube_direct"
                  ? "youtube_direct"
                  : "direct_file",
              apiOrigin,
              routes: finalRoutes,
              ...(sizeBytes ? { sizeBytes } : {}),
              refreshContext: buildNextRefreshContext(expiresAtMs),
            };
          }
        } else if (targetVariant.delivery.kind === "hls") {
          const avail = availableSources(targetVariant.delivery.sources, now);
          const routes = deliveryRoutes(avail, targetCtx);
          if (routes.length > 0) {
            const expiresAtMs = computeEarliestExpiresAtMs(avail);
            return {
              ...basePreserved,
              kind: "hls",
              apiOrigin,
              routes,
              refreshContext: buildNextRefreshContext(expiresAtMs),
            };
          }
        } else if (targetVariant.delivery.kind === "segments") {
          const rebuilt = buildEnqueueItemsForMedia(freshMedia, {
            apiOrigin,
            itemIds: [targetItem.id],
            variantSelections: {
              [targetItem.id]: { variant_id: targetVariant.id },
            },
            sourceUrl: parseCandidate || ctx.parseUrl,
            now,
          });
          if (rebuilt.length > 0 && rebuilt[0].spec.segments) {
            return {
              ...basePreserved,
              kind: "segments",
              apiOrigin,
              routes: rebuilt[0].spec.routes,
              segments: rebuilt[0].spec.segments,
              refreshContext: buildNextRefreshContext(
                rebuilt[0].spec.refreshContext?.expiresAtMs,
              ),
            };
          }
        } else if (targetVariant.delivery.kind === "pair") {
          const matchedRes =
            (ctx.resourceRole
              ? targetVariant.delivery.resources.find(
                  (r) => r.role === ctx.resourceRole,
                )
              : undefined) ??
            targetVariant.delivery.resources.find(
              (r) => r.role === "motion" || r.role === "video",
            ) ??
            targetVariant.delivery.resources[0];
          if (matchedRes?.delivery.kind === "file") {
            const avail = availableSources(matchedRes.delivery.sources, now);
            const routes = deliveryRoutes(avail, targetCtx);
            if (routes.length > 0) {
              const expiresAtMs = computeEarliestExpiresAtMs(avail);
              const sizeBytes = avail[0]?.size_bytes ?? originalSpec.sizeBytes;
              return {
                ...basePreserved,
                kind: "direct_file",
                apiOrigin,
                routes,
                ...(sizeBytes ? { sizeBytes } : {}),
                refreshContext: buildNextRefreshContext(expiresAtMs),
              };
            }
          } else if (matchedRes?.delivery.kind === "hls") {
            const avail = availableSources(matchedRes.delivery.sources, now);
            const routes = deliveryRoutes(avail, targetCtx);
            if (routes.length > 0) {
              const expiresAtMs = computeEarliestExpiresAtMs(avail);
              return {
                ...basePreserved,
                kind: "hls",
                apiOrigin,
                routes,
                refreshContext: buildNextRefreshContext(expiresAtMs),
              };
            }
          } else if (matchedRes?.delivery.kind === "segments") {
            const rebuilt = buildEnqueueItemsForMedia(freshMedia, {
              apiOrigin,
              itemIds: [targetItem.id],
              variantSelections: {
                [targetItem.id]: { variant_id: targetVariant.id },
              },
              sourceUrl: parseCandidate || ctx.parseUrl,
              now,
            });
            const matchedEntry =
              (ctx.resourceRole
                ? rebuilt.find(
                    (entry) =>
                      entry.spec.refreshContext?.resourceRole ===
                      ctx.resourceRole,
                  )
                : undefined) ?? rebuilt[0];
            if (matchedEntry?.spec.segments) {
              return {
                ...basePreserved,
                kind: "segments",
                apiOrigin,
                routes: matchedEntry.spec.routes,
                segments: matchedEntry.spec.segments,
                refreshContext: buildNextRefreshContext(
                  matchedEntry.spec.refreshContext?.expiresAtMs,
                ),
              };
            }
          }
        }
      }
    }

    // 3) Fallback by quality preference when exact variant/attachment changed upstream
    const rebuiltItems = buildEnqueueItemsForMedia(freshMedia, {
      apiOrigin,
      qualityPreference: ctx.attachmentId ? "audio" : settings.qualityPreference,
      itemIds: [targetItem.id],
      sourceUrl: parseCandidate || ctx.parseUrl,
      now,
    });
    const rebuiltSpec =
      (ctx.resourceRole
        ? rebuiltItems.find(
            (entry) =>
              entry.spec.refreshContext?.resourceRole === ctx.resourceRole,
          )?.spec
        : undefined) ?? rebuiltItems[0]?.spec;
    if (!rebuiltSpec) {
      throw new Error("重新解析后未找到可用下载源");
    }
    return {
      ...basePreserved,
      kind: rebuiltSpec.kind,
      apiOrigin,
      routes: rebuiltSpec.routes,
      ...(rebuiltSpec.sizeBytes ? { sizeBytes: rebuiltSpec.sizeBytes } : {}),
      ...(rebuiltSpec.segments ? { segments: rebuiltSpec.segments } : {}),
      ...(rebuiltSpec.youtubeMux ? { youtubeMux: rebuiltSpec.youtubeMux } : {}),
      ...(rebuiltSpec.dashMux ? { dashMux: rebuiltSpec.dashMux } : {}),
      refreshContext: buildNextRefreshContext(
        rebuiltSpec.refreshContext?.expiresAtMs,
      ),
    };
  };

  const prepareSpecForDispatch = async (
    params: PrepareSpecForDispatchParams,
  ): Promise<PrepareSpecForDispatchResult> => {
    const {
      taskId,
      spec,
      settings,
      dispatchOpts,
      tasks,
      parseAbortControllers,
      resolveExtraAllowedMediaOrigins,
      updateBadge,
      broadcastTasksUpdated,
      scheduleOffscreenIdleCloseIfIdle,
      notifyIfCompletelyIdle,
    } = params;

    const task = tasks.get(taskId);
    if (!task || task.status === "cancelled") {
      return { ok: false };
    }

    let effectiveSpec = spec;
    const refreshCtx = effectiveSpec.refreshContext;
    const shouldForceRefresh = Boolean(dispatchOpts?.forceRefresh && refreshCtx);
    const shouldAutoPreRefresh = Boolean(
      !dispatchOpts?.skipAutoRefresh &&
        !shouldForceRefresh &&
        refreshCtx &&
        checkExpired(effectiveSpec) &&
        (task.autoRefreshCount ?? 0) < 1,
    );

    if (shouldForceRefresh || shouldAutoPreRefresh) {
      const refreshController = new AbortController();
      parseAbortControllers.set(taskId, refreshController);
      const currentBeforeRefresh = tasks.get(taskId);
      if (!currentBeforeRefresh || currentBeforeRefresh.status === "cancelled") {
        parseAbortControllers.delete(taskId);
        scheduleOffscreenIdleCloseIfIdle();
        return { ok: false };
      }
      const nextRefreshCount = shouldAutoPreRefresh
        ? (currentBeforeRefresh.autoRefreshCount ?? 0) + 1
        : currentBeforeRefresh.autoRefreshCount;
      tasks.set(taskId, {
        ...currentBeforeRefresh,
        status: "parsing",
        statusText: "签名链接已过期，正在自动重新解析...",
        percent: 0,
        loaded: 0,
        speed: 0,
        error: undefined,
        ...(nextRefreshCount !== undefined
          ? { autoRefreshCount: nextRefreshCount }
          : {}),
        updatedAt: nowFn(),
      });
      updateBadge();
      await broadcastTasksUpdated();

      try {
        effectiveSpec = await refreshSpecFromContext(
          effectiveSpec,
          settings,
          refreshController.signal,
        );
      } catch (err) {
        const afterErr = tasks.get(taskId);
        if (!afterErr) return { ok: false };
        const cancelled =
          afterErr.status === "cancelled" ||
          refreshController.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        if (cancelled) {
          tasks.set(taskId, {
            ...afterErr,
            status: "cancelled",
            statusText: "已取消",
            speed: 0,
            error: undefined,
            updatedAt: nowFn(),
          });
          updateBadge();
        } else {
          const msg =
            err instanceof Error && err.message
              ? err.message
              : "重新解析下载链接失败";
          tasks.set(taskId, {
            ...afterErr,
            status: "failed",
            statusText: "刷新链接失败",
            speed: 0,
            error: msg,
            lastErrorCode: "MEDIA_URL_EXPIRED",
            updatedAt: nowFn(),
          });
          updateBadge("failed");
        }
        await broadcastTasksUpdated();
        scheduleOffscreenIdleCloseIfIdle();
        notifyIfCompletelyIdle();
        return { ok: false };
      } finally {
        parseAbortControllers.delete(taskId);
      }
    }

    const extra = effectiveSpec.isolateExtraAllowedOrigins
      ? []
      : await resolveExtraAllowedMediaOrigins(settings);
    const mergedExtra = Array.from(
      new Set([...(effectiveSpec.extraAllowedOrigins ?? []), ...extra]),
    );
    const enrichedSpec: OffscreenDownloadSpec = {
      ...effectiveSpec,
      ...(mergedExtra.length > 0 || !effectiveSpec.isolateExtraAllowedOrigins
        ? { extraAllowedOrigins: mergedExtra }
        : {}),
    };
    const latestTask = tasks.get(taskId);
    if (!latestTask || latestTask.status === "cancelled") {
      scheduleOffscreenIdleCloseIfIdle();
      return { ok: false };
    }

    const validatedSpecApi = validateApiBaseUrl(enrichedSpec.apiOrigin);
    const effectiveAllowedOrigins = Array.from(
      new Set([
        ...(enrichedSpec.extraAllowedOrigins ?? []),
        ...(validatedSpecApi.ok ? [validatedSpecApi.origin] : []),
      ]),
    );
    return { ok: true, enrichedSpec, effectiveAllowedOrigins, latestTask };
  };

  return {
    isSpecExpiredForDispatch: checkExpired,
    refreshSpecFromContext,
    prepareSpecForDispatch,
  };
}
