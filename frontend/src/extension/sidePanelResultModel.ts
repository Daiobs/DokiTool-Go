// Pure View-Model & Decision Logic for SidePanelResult (zero Vue/DOM/Chrome side effects).

import type { MediaGroup, MediaItem, ReadyItem, ReadyVariant, Source, UnifiedMedia } from "../types/media";
import {
  getDownloadTarget, readyItem, readyVariant, resourceSource, sourceRoutes, sourceUrl,
  type DownloadTarget, type TargetContext,
} from "../utils/mediaContract";
import {
  buildCanonicalArchiveStem, buildCanonicalVariantDescriptor, compareCanonicalVariantDesc,
  isPlaceholderPartTitle, nonAlbumGroupsOf, sortVariantsCanonical,
} from "../core/media";
import { buildSafeDownloadPath } from "./filenameSanitizer";
import type { BatchSaveMode, QualityPreference } from "./protocol";

export type SidePanelLayoutKind = "single" | "album" | "multi_video" | "mixed";
export type SidePanelLivePhotoFilter = "both" | "motion" | "video" | "image";

export const LIVE_PHOTO_FILTER_OPTIONS: ReadonlyArray<{ value: "both" | "motion" | "image"; label: string }> = [
  { value: "both", label: "实况视频+封面全下" },
  { value: "motion", label: "仅实况视频" },
  { value: "image", label: "仅静态图" },
];

export interface ResultQualityOptionLike {
  key: string; kind: "variant" | "attachment"; variant: ReadyVariant;
  downloadTarget: DownloadTarget; downloadable: boolean;
  deliveryMode: "opfs" | "native_direct" | "external_only";
  isAudioOnly: boolean; effectiveHasAudio: boolean; shortEdge: number;
  bitrateBps: number; sizeBytes: number; muxPair: unknown | null; isDashMux: boolean;
  resolvedExt: string; directUrl: string; copyUrl: string; routes: string[];
}

export interface ChecklistSelectionEntry<TOption extends ResultQualityOptionLike = ResultQualityOptionLike> {
  item: MediaItem; ordinalIndex: number; explicitOption?: TOption | null;
}

export interface SidePanelCollectionsState {
  collections: MediaGroup[]; allVideoOrAudioItems: MediaItem[];
  visibleEpisodes: MediaItem[]; albumItems: MediaItem[]; hasLivePhotos: boolean;
}

export interface ChecklistSelectionSummary {
  checkedCount: number; checkableTotalCount: number; allChecked: boolean;
}

export interface MixedItemTypeBadge {
  text: string; tone: "video" | "image" | "live" | "audio";
}

export interface BatchNamingPolicyDecision {
  effectiveSaveMode: BatchSaveMode; useMultiPartQueue: boolean;
  workSubfolder: string; archiveFilename: string; subfolderItemPath: string; episodeStem?: string;
}

// ============================================================================
// 1. Multi-P / Gallery Collection & Checklist Set Operations
// ============================================================================

export const isChecklistItemCheckable = (item: MediaItem): boolean => item.state !== "unavailable";

export const buildMediaWorkWatchKey = (
  media: Pick<UnifiedMedia, "platform" | "content_id" | "source_url" | "generated_at">,
): string => `${media.platform}:${media.content_id || ""}:${media.source_url || ""}:${media.generated_at || ""}`;

export function deriveSidePanelCollections(
  media: Pick<UnifiedMedia, "items" | "groups">,
  activeCollectionIdx: number,
): SidePanelCollectionsState {
  const collections = nonAlbumGroupsOf(media);
  const allVideoOrAudioItems = media.items.filter((it) => it.type === "video" || it.type === "audio");
  const group = collections[activeCollectionIdx];
  const byId = group ? new Map(allVideoOrAudioItems.map((it) => [it.id, it])) : null;
  const visibleEpisodes =
    group && byId
      ? group.item_ids.map((id) => byId.get(id)).filter((it): it is MediaItem => Boolean(it))
      : allVideoOrAudioItems;
  const albumItems = media.items.filter((it) => it.type === "image" || it.type === "live_photo");
  return {
    collections, allVideoOrAudioItems, visibleEpisodes, albumItems,
    hasLivePhotos: albumItems.some((it) => it.type === "live_photo"),
  };
}

export function resolveChecklistPool(
  layoutKind: SidePanelLayoutKind, mediaItems: readonly MediaItem[],
  albumItems: readonly MediaItem[], visibleEpisodes: readonly MediaItem[],
): MediaItem[] {
  if (layoutKind === "mixed") return [...mediaItems];
  if (layoutKind === "album") return [...albumItems];
  return layoutKind === "multi_video" ? [...visibleEpisodes] : [];
}

export function resolveInitialActiveSelection(
  media: Pick<UnifiedMedia, "default_item_id" | "items">,
  collections: readonly MediaGroup[],
): { activeCollectionIdx: number; activeItemId: string } {
  const activeItemId = media.default_item_id || media.items[0]?.id || "";
  const idx = collections.length > 0 && activeItemId
    ? collections.findIndex((g) => g.item_ids.includes(activeItemId))
    : -1;
  return { activeCollectionIdx: idx >= 0 ? idx : 0, activeItemId };
}

export const resolveActiveMediaItem = (items: readonly MediaItem[], activeItemId: string): MediaItem | null =>
  items.find((it) => it.id === activeItemId) ?? items[0] ?? null;

export const buildAllCheckedIdSet = (pool: readonly MediaItem[]): Set<string> =>
  new Set(pool.filter(isChecklistItemCheckable).map((it) => it.id));

export function toggleChecklistItemId(checkedIds: ReadonlySet<string>, item: MediaItem): Set<string> {
  const next = new Set(checkedIds);
  if (!isChecklistItemCheckable(item)) return next;
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  return next;
}

export const invertChecklistIdSet = (pool: readonly MediaItem[], checkedIds: ReadonlySet<string>): Set<string> =>
  new Set(pool.filter((it) => isChecklistItemCheckable(it) && !checkedIds.has(it.id)).map((it) => it.id));

export function summarizeChecklistSelection(pool: readonly MediaItem[], checkedIds: ReadonlySet<string>): ChecklistSelectionSummary {
  let checkedCount = 0;
  let checkableTotalCount = 0;
  for (const item of pool) {
    if (isChecklistItemCheckable(item)) checkableTotalCount += 1;
    if (checkedIds.has(item.id)) checkedCount += 1;
  }
  return { checkedCount, checkableTotalCount, allChecked: checkableTotalCount > 0 && checkedCount >= checkableTotalCount };
}

export function resolveMixedItemTypeBadge(item: Pick<MediaItem, "type">): MixedItemTypeBadge {
  if (item.type === "live_photo") return { text: "LIVE", tone: "live" };
  if (item.type === "image") return { text: "图片", tone: "image" };
  return item.type === "audio" ? { text: "音频", tone: "audio" } : { text: "视频", tone: "video" };
}

export function resolveMixedItemDisplayTitle(item: Pick<MediaItem, "type" | "title">, idx: number, mediaTitle?: string): string {
  const rawTitle = item.title?.trim();
  if (rawTitle && rawTitle !== mediaTitle?.trim()) return rawTitle;
  if (item.type === "live_photo") return `实况照片 #${idx + 1}`;
  if (item.type === "image") return `高清图片 #${idx + 1}`;
  return item.type === "audio" ? `独立音频 #${idx + 1}` : `视频片段 #${idx + 1}`;
}

export function buildSelectedChecklistEntries<TOption extends ResultQualityOptionLike>(
  pool: readonly MediaItem[], checkedIds: ReadonlySet<string>,
  selectedOptionKeyByItem: Readonly<Record<string, string>>,
  resolveOptionsForItem: (item: MediaItem) => readonly TOption[],
): ChecklistSelectionEntry<TOption>[] {
  const out: ChecklistSelectionEntry<TOption>[] = [];
  for (let i = 0; i < pool.length; i++) {
    const item = pool[i];
    if (!checkedIds.has(item.id)) continue;
    const savedKey = selectedOptionKeyByItem[item.id];
    const explicitOption =
      readyItem(item) && savedKey ? resolveOptionsForItem(item).find((o) => o.key === savedKey) ?? null : null;
    out.push({ item, ordinalIndex: i + 1, explicitOption });
  }
  return out;
}

export const filterDeferredResolvableEntries = <T extends { item: MediaItem }>(entries: readonly T[]): T[] =>
  entries.filter((e) => e.item.state === "deferred" && Boolean(e.item.resolve_url));

export function preserveOriginalResolveUrl(deferredItem: MediaItem, resolved: ReadyItem): ReadyItem {
  const original = deferredItem.state !== "unavailable" ? deferredItem.resolve_url : undefined;
  return !resolved.resolve_url && original ? { ...resolved, resolve_url: original } : resolved;
}

export function mergeResolvedChecklistEntries<T extends { item: MediaItem }>(
  rawEntries: readonly T[],
  resolvedById: ReadonlyMap<string, MediaItem>,
): T[] {
  return rawEntries
    .map((entry) => ({ ...entry, item: resolvedById.get(entry.item.id) ?? entry.item }))
    .filter((entry) => readyItem(entry.item));
}

// ============================================================================
// 2. Quality / Audio-Video Candidate Sorting & Default Selection Decisions
// ============================================================================

const toDescriptor = <TOption extends ResultQualityOptionLike>(opt: TOption, originalIndex: number) =>
  buildCanonicalVariantDescriptor({
    variant: opt.variant,
    downloadable: opt.downloadable && opt.deliveryMode !== "external_only",
    isAudioOnly: opt.isAudioOnly,
    effectiveHasAudio: opt.effectiveHasAudio,
    sizeBytes: opt.sizeBytes,
    originalIndex,
  });

export const sortResultQualityCandidates = <TOption extends ResultQualityOptionLike>(options: readonly TOption[]): TOption[] =>
  sortVariantsCanonical([...options], (opt, idx) => toDescriptor(opt, idx));

export function compareVideoQualityCandidatesDesc<TOption extends ResultQualityOptionLike>(
  a: TOption, b: TOption, defaultVariantId?: string,
): number {
  const cmp = compareCanonicalVariantDesc(toDescriptor(a, 0), toDescriptor(b, 0));
  if (cmp !== 0) return cmp;
  const mp4Diff = (b.resolvedExt === "mp4" ? 1 : 0) - (a.resolvedExt === "mp4" ? 1 : 0);
  if (mp4Diff !== 0) return mp4Diff;
  return defaultVariantId ? (b.variant.id === defaultVariantId ? 1 : 0) - (a.variant.id === defaultVariantId ? 1 : 0) : 0;
}

export function selectDefaultQualityCandidate<TOption extends ResultQualityOptionLike>(
  options: readonly TOption[], item: MediaItem | null | undefined, preference: QualityPreference,
): TOption | null {
  const downloadable = options.filter((opt) => opt.downloadable && opt.deliveryMode !== "external_only");
  if (!downloadable.length) return options[0] ?? null;
  const defaultVariantId = item && readyItem(item) ? item.default?.variant_id : undefined;
  const defaultOption =
    (defaultVariantId ? downloadable.find((o) => o.kind === "variant" && o.variant.id === defaultVariantId) : undefined) ?? null;

  if (preference === "audio") {
    const rank = (ext: string) => (ext === "m4a" ? 3 : ext === "mp3" ? 2 : ext === "webm" ? 1 : 0);
    const audio = downloadable
      .filter((o) => o.isAudioOnly)
      .sort((a, b) => rank(b.resolvedExt) - rank(a.resolvedExt) || b.bitrateBps - a.bitrateBps || b.sizeBytes - a.sizeBytes);
    return audio[0] ?? defaultOption ?? downloadable[0];
  }

  const nonAudio = downloadable.filter((o) => !o.isAudioOnly);
  const pool = nonAudio.length > 0 ? nonAudio : downloadable;
  if (preference === "1080p") {
    const within1080 = pool
      .filter((o) => o.shortEdge > 0 && o.shortEdge <= 1088)
      .sort((a, b) => compareVideoQualityCandidatesDesc(a, b, defaultVariantId));
    if (within1080.length > 0) return within1080[0];
    if (defaultOption && !defaultOption.isAudioOnly) return defaultOption;
    return pool.filter((o) => o.shortEdge > 1088).sort((a, b) => a.shortEdge - b.shortEdge)[0] ?? pool[0];
  }
  return [...pool].sort((a, b) => compareVideoQualityCandidatesDesc(a, b, defaultVariantId))[0] ?? defaultOption ?? downloadable[0];
}

export function resolveActiveQualitySelection<TOption extends ResultQualityOptionLike>(params: {
  options: readonly TOption[]; item: MediaItem | null | undefined;
  selectedOptionKeyByItem: Readonly<Record<string, string>>; preference: QualityPreference;
  fallbackSelect?: (options: TOption[], item: MediaItem | null | undefined, preference: QualityPreference) => TOption | null;
}): TOption | null {
  const { options, item, selectedOptionKeyByItem, preference, fallbackSelect } = params;
  if (!options.length) return null;
  const savedKey = item ? selectedOptionKeyByItem[item.id] : undefined;
  const matched = savedKey ? options.find((o) => o.key === savedKey) : undefined;
  if (matched) return matched;
  return fallbackSelect ? fallbackSelect([...options], item, preference) : selectDefaultQualityCandidate(options, item, preference);
}

export function buildPreferredOptionKeyMap<TOption extends Pick<ResultQualityOptionLike, "key">>(params: {
  items: readonly MediaItem[]; resolveOptions: (item: MediaItem) => TOption[];
  selectPreferred: (options: TOption[], item: MediaItem) => TOption | null;
  baseMap?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const nextMap: Record<string, string> = params.baseMap ? { ...params.baseMap } : {};
  for (const item of params.items) {
    if (!readyItem(item)) continue;
    const preferred = params.selectPreferred(params.resolveOptions(item), item);
    if (preferred) nextMap[item.id] = preferred.key;
  }
  return nextMap;
}

export const formatQualityPreferenceLabel = (preference: QualityPreference): string =>
  preference === "best" ? "最高画质" : preference === "1080p" ? "1080p 优先" : "仅音频 M4A";

// ============================================================================
// 3. Preview Source URL Picking & Failover Decisions
// ============================================================================

export const pickSafeAssetUrl = (raw: string, brokenUrls: Readonly<Record<string, boolean>>): string =>
  raw && !brokenUrls[raw] ? raw : "";

const firstSafeUrl = (urls: readonly string[], brokenUrls: Readonly<Record<string, boolean>>): string =>
  urls.find((candidate) => Boolean(candidate) && !brokenUrls[candidate]) ?? "";

const collectUniqueUrls = (urls: readonly string[]): string[] =>
  Array.from(new Set(urls.filter((u): u is string => Boolean(u))));

export const markPreviewUrlBroken = (brokenUrls: Readonly<Record<string, boolean>>, url: string): Record<string, boolean> =>
  !url || brokenUrls[url] ? (brokenUrls as Record<string, boolean>) : { ...brokenUrls, [url]: true };

export function pickSafeSourceUrl(src: Source | null | undefined, ctx: TargetContext, brokenUrls: Readonly<Record<string, boolean>>): string {
  if (!src) return "";
  try {
    return firstSafeUrl(sourceRoutes(src, ctx), brokenUrls) || pickSafeAssetUrl(sourceUrl(src, ctx), brokenUrls);
  } catch {
    return "";
  }
}

export function resolveLivePhotoResourceRoutes(item: MediaItem, role: "image" | "motion", ctx: TargetContext): string[] {
  if (!readyItem(item)) return [];
  const pairVar = item.variants.find((v): v is ReadyVariant => readyVariant(v) && v.delivery.kind === "pair");
  if (!pairVar || pairVar.delivery.kind !== "pair") return [];
  const res = pairVar.delivery.resources.find((r) => (role === "motion" ? r.role === "motion" || r.role === "video" : r.role === "image"));
  const src = res ? resourceSource(res, ctx) : undefined;
  if (!src) return [];
  try {
    return sourceRoutes(src, ctx);
  } catch {
    return [];
  }
}

export const resolveLivePhotoResourceUrl = (item: MediaItem, role: "image" | "motion", ctx: TargetContext): string =>
  resolveLivePhotoResourceRoutes(item, role, ctx)[0] ?? "";

export const resolveSafeLivePhotoResourceUrl = (
  item: MediaItem, role: "image" | "motion", ctx: TargetContext, brokenUrls: Readonly<Record<string, boolean>>,
): string => firstSafeUrl(resolveLivePhotoResourceRoutes(item, role, ctx), brokenUrls);

export function resolvePreviewCoverUrl(params: {
  media: Pick<UnifiedMedia, "cover">; activeItem: MediaItem | null;
  activeOption: Pick<ResultQualityOptionLike, "routes" | "directUrl"> | null;
  ctx: TargetContext; brokenUrls: Readonly<Record<string, boolean>>;
}): string {
  const { media, activeItem, activeOption, ctx, brokenUrls } = params;
  const itemCover = pickSafeSourceUrl(activeItem?.cover, ctx, brokenUrls);
  if (itemCover) return itemCover;
  if (activeItem?.type === "image") {
    const img = firstSafeUrl(activeOption?.routes ?? [], brokenUrls) || pickSafeAssetUrl(activeOption?.directUrl || "", brokenUrls);
    if (img) return img;
  }
  if (activeItem?.type === "live_photo") {
    const liveImg = resolveSafeLivePhotoResourceUrl(activeItem, "image", ctx, brokenUrls);
    if (liveImg) return liveImg;
  }
  return pickSafeSourceUrl(media.cover, ctx, brokenUrls);
}

export function resolvePreviewVideoCandidates<
  TOption extends Pick<
    ResultQualityOptionLike,
    "isAudioOnly" | "muxPair" | "isDashMux" | "variant" | "downloadTarget" | "routes" | "directUrl"
  >,
>(params: {
  platform: string; activeItem: MediaItem | null; activeOption: TOption | null;
  allOptions: readonly TOption[]; ctx: TargetContext;
}): string[] {
  const { platform, activeItem, activeOption, allOptions, ctx } = params;
  if (!activeItem) return [];
  if (activeItem.type === "live_photo") return collectUniqueUrls(resolveLivePhotoResourceRoutes(activeItem, "motion", ctx));
  if ((activeItem.type !== "video" && activeItem.type !== "audio") || !activeOption) return [];
  const optionUrls = (opt: TOption) => collectUniqueUrls(opt.routes.length > 0 ? opt.routes : opt.directUrl ? [opt.directUrl] : []);

  if ((platform === "youtube" && activeOption.muxPair) || activeOption.isDashMux) {
    const defaultVarId = readyItem(activeItem) ? activeItem.default?.variant_id : undefined;
    const playable = allOptions.filter(
      (o) =>
        !o.isAudioOnly && !o.muxPair && !o.isDashMux &&
        (platform === "youtube" ? o.variant.metadata?.has_audio === true : o.variant.metadata?.has_audio !== false) &&
        o.downloadTarget.kind === "file" && (o.routes.length > 0 || Boolean(o.directUrl)),
    );
    const chosen = (defaultVarId ? playable.find((o) => o.variant.id === defaultVarId) : undefined) ?? playable[0];
    return chosen ? optionUrls(chosen) : [];
  }
  return activeOption.downloadTarget.kind === "file" ? optionUrls(activeOption) : [];
}

export const pickActivePreviewVideoUrl = (
  candidates: readonly string[], routeIndex: number, brokenUrls: Readonly<Record<string, boolean>>,
): string => firstSafeUrl(candidates.slice(Math.max(0, Math.floor(routeIndex))), brokenUrls);

export function advancePreviewVideoRouteOnError(params: {
  failedUrl: string; currentPreviewUrl: string; candidates: readonly string[];
  routeIndex: number; brokenUrls: Readonly<Record<string, boolean>>;
}): { brokenUrls: Record<string, boolean>; nextRouteIndex: number } {
  const { failedUrl, currentPreviewUrl, candidates, routeIndex, brokenUrls } = params;
  if (!failedUrl) return { brokenUrls: brokenUrls as Record<string, boolean>, nextRouteIndex: routeIndex };
  const idx = candidates.indexOf(failedUrl);
  const nextRouteIndex =
    idx >= 0 ? Math.max(routeIndex, idx + 1) : failedUrl === currentPreviewUrl ? routeIndex + 1 : routeIndex;
  return { brokenUrls: markPreviewUrlBroken(brokenUrls, failedUrl), nextRouteIndex };
}

export function resolveAlbumThumbnailUrl(
  item: MediaItem, ctx: TargetContext, brokenUrls: Readonly<Record<string, boolean>>,
): string {
  const cover = pickSafeSourceUrl(item.cover, ctx, brokenUrls);
  if (cover) return cover;
  if (item.type === "live_photo") return resolveSafeLivePhotoResourceUrl(item, "image", ctx, brokenUrls);
  if (readyItem(item)) {
    const target = getDownloadTarget(item, null, ctx);
    if (target.kind === "file") return firstSafeUrl(target.routes, brokenUrls) || pickSafeAssetUrl(target.url, brokenUrls);
  }
  return "";
}

export function resolveDirectCopyCandidateUrl(params: {
  media: Pick<UnifiedMedia, "source_url">; activeItem: MediaItem | null;
  activeOption: Pick<ResultQualityOptionLike, "isDashMux" | "copyUrl" | "directUrl"> | null; copyCtx: TargetContext;
}): string {
  const { media, activeItem, activeOption, copyCtx } = params;
  if (activeOption?.isDashMux) return "";
  if (activeOption?.copyUrl) return activeOption.copyUrl;
  if (activeOption?.directUrl) return activeOption.directUrl;
  if (activeItem?.type === "live_photo") {
    return resolveLivePhotoResourceUrl(activeItem, "motion", copyCtx) || resolveLivePhotoResourceUrl(activeItem, "image", copyCtx);
  }
  return media.source_url || "";
}

export const resolveDirectCopyButtonTitle = (isDashMux: boolean): string =>
  isDashMux ? "音视频分离流需经扩展无损合流" : "复制当前选中画质直链到剪贴板";

// ============================================================================
// 4. Batch Download ZIP / Subdirectory Policy & Naming Decisions
// ============================================================================

export const resolveEffectiveBatchSaveMode = (
  requestedMode: BatchSaveMode | undefined, zipDecision: { ok: boolean },
): BatchSaveMode => (requestedMode === "zip" && zipDecision.ok ? "zip" : "subfolder");

export function resolveZipModeTooltip(layoutKind: SidePanelLayoutKind, zipDecision: { ok: boolean; reason: string }): string {
  if (!zipDecision.ok) return zipDecision.reason;
  if (layoutKind === "multi_video") return "将已选分P打包为单个 ZIP 文件（500 MB 以内）";
  return layoutKind === "mixed" ? "将已选混排条目无压缩打包为单个 ZIP 文件保存" : "将已选条目无压缩打包为单个 ZIP 文件保存";
}

export const shouldStreamBatchViaMultiPart = (layoutKind: SidePanelLayoutKind, entries: readonly { item: MediaItem }[]): boolean =>
  layoutKind === "multi_video" || entries.some((e) => e.item.state === "deferred");

export const resolveBatchWorkSubfolderName = (
  media: Pick<UnifiedMedia, "title" | "author" | "platform" | "content_id">,
): string => media.title?.trim() || media.author?.name?.trim() || `${media.platform}_${media.content_id || "media"}`;

export function resolveChecklistItemEpisodeStem(item: Pick<MediaItem, "type" | "title">, workSubfolder: string): string | undefined {
  if (item.type === "image") return undefined;
  const trimmed = item.title?.trim();
  return trimmed && !isPlaceholderPartTitle(trimmed) && trimmed !== workSubfolder ? trimmed : undefined;
}

export function decideBatchNamingPolicy(params: {
  media: Pick<UnifiedMedia, "title" | "author" | "platform" | "content_id">;
  layoutKind: SidePanelLayoutKind; requestedSaveMode: BatchSaveMode;
  zipDecision: { ok: boolean; reason: string }; subfolderPrefix?: string; totalCount: number;
  item?: Pick<MediaItem, "type" | "title">; ordinalIndex?: number; ext?: string;
  livePhotoFilter?: SidePanelLivePhotoFilter; hasDeferredEntries?: boolean;
}): BatchNamingPolicyDecision {
  const effectiveSaveMode = resolveEffectiveBatchSaveMode(params.requestedSaveMode, params.zipDecision);
  const useMultiPartQueue =
    effectiveSaveMode === "subfolder" && (params.layoutKind === "multi_video" || Boolean(params.hasDeferredEntries));
  const workSubfolder = resolveBatchWorkSubfolderName(params.media);
  const safeTotal = Math.max(1, Math.trunc(params.totalCount || 1));
  const archiveFilename = buildSafeDownloadPath({
    prefix: params.subfolderPrefix, stem: buildCanonicalArchiveStem(workSubfolder, safeTotal), ext: "zip",
  });
  const episodeStem =
    params.item?.type === "live_photo"
      ? params.livePhotoFilter === "both" ? "live" : undefined
      : params.item ? resolveChecklistItemEpisodeStem(params.item, workSubfolder) : undefined;
  const subfolderItemPath = buildSafeDownloadPath({
    prefix: params.subfolderPrefix, subfolder: workSubfolder,
    index: params.ordinalIndex ?? 1, totalCount: safeTotal, stem: episodeStem,
    ext: params.ext || (params.item?.type === "image" ? "jpg" : "mp4"),
  });
  return {
    effectiveSaveMode, useMultiPartQueue, workSubfolder, archiveFilename, subfolderItemPath,
    ...(episodeStem ? { episodeStem } : {}),
  };
}
