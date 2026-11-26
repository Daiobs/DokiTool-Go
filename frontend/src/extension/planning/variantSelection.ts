import { confirmedFormatMime, extensionsFor } from "../../downloads/file";
import type {
  Attachment,
  Chunk,
  MediaItem,
  ReadyVariant,
  Source,
} from "../../types/media";
import {
  availableSources,
  deliveryRoutes,
  getDefaultDownloadTarget,
  getDownloadTarget,
  readyItem,
  readyVariant,
  sourceUrl,
  type DownloadTarget,
  type TargetContext,
} from "../../utils/mediaContract";
import { mediaExtension } from "../../utils/mediaDelivery";
import {
  isValidGooglevideoPlaybackUrl,
  selectYouTubeMuxPair,
} from "../../utils/youtubeHelperCore";
import {
  buildCanonicalVariantDescriptor,
  compareCanonicalVariantDesc,
  inferDirectVideoExtension,
  videoCodecCompatibilityRank,
  type CanonicalVariantDescriptor,
} from "../../core/media";
import { extractDashMuxSpec } from "../dashMuxSpec";
import { isSafeDownloadExtension } from "../filenameSanitizer";
import {
  isSafeNativeBrowserDownloadUrl,
  isWhitelistedMediaUrl,
  validateApiBaseUrl,
} from "../hostWhitelist";
import type { OffscreenDashMuxSpec, QualityPreference } from "../protocol";
import { buildExtensionTargetContext } from "../uiTargetHelpers";

export type LivePhotoSaveMode = "both" | "video" | "motion" | "image";

export interface SelectedVariantPlan {
  variant: ReadyVariant;
  target: DownloadTarget;
  isAudioOnly: boolean;
  attachmentId?: string;
  youtubeMux?: {
    videoUrl: string;
    audioUrl: string;
    videoSize?: number;
    audioSize?: number;
    videoSource?: Source;
    audioSource?: Source;
    outputContainer: "mp4" | "webm";
  };
  dashMux?: OffscreenDashMuxSpec;
}

export function buildEffectiveExtraOrigins(
  apiOrigin: string,
  extraAllowedOrigins?: string[],
): string[] {
  const set = new Set<string>();
  const validated = validateApiBaseUrl(apiOrigin);
  if (validated.ok) {
    set.add(validated.origin);
  }
  for (const extra of extraAllowedOrigins ?? []) {
    if (typeof extra === "string" && extra.trim()) {
      set.add(extra.trim());
    }
  }
  return Array.from(set);
}

export function videoCodecPreferenceRank(rawCodec: unknown): number {
  return videoCodecCompatibilityRank(rawCodec);
}

function inferShortEdgeFromLabel(label?: string): number {
  if (typeof label !== "string" || !label.trim()) return 0;
  const lower = label.trim().toLowerCase();
  if (lower.includes("8k") || lower.includes("4320")) return 4320;
  if (lower.includes("4k") || lower.includes("2160")) return 2160;
  if (lower.includes("2k") || lower.includes("1440")) return 1440;
  const pMatch = /(\d{3,4})p\b/i.exec(lower);
  if (pMatch) return Number(pMatch[1]) || 0;
  if (lower.includes("hd") || lower.includes("高清")) return 720;
  if (lower.includes("sd") || lower.includes("标清")) return 480;
  if (lower.includes("ld") || lower.includes("流畅")) return 360;
  return 0;
}

export function isStandaloneAudioVariant(variant: ReadyVariant): boolean {
  const meta = variant.metadata;
  if (!meta) return false;
  const mime = (meta.mime_type || "").trim().toLowerCase();
  const ext = (meta.extension || meta.container || "").trim().toLowerCase();
  return (
    meta.has_audio === true &&
    !meta.video_codec &&
    !meta.width &&
    !meta.height &&
    (mime.startsWith("audio/") ||
      ext === "m4a" ||
      ext === "mp3" ||
      ext === "aac" ||
      ext === "opus" ||
      ext === "ogg" ||
      ext === "wav" ||
      ext === "flac" ||
      ext === "webm")
  );
}

function isDubbedAudioVariant(variant: ReadyVariant): boolean {
  const role = (variant.metadata?.audio_language_role || "").toLowerCase();
  const label = variant.label || "";
  return (
    role === "alternate" ||
    /dubbed|auto-dubbed|配音|descriptive|description/i.test(label)
  );
}

interface ScoredCandidate {
  plan: SelectedVariantPlan;
  isDownloadable: boolean;
  shortEdge: number;
  descriptor: CanonicalVariantDescriptor;
  isDirectFile: boolean;
  isDefault: boolean;
}

function isPlanDirectlyDownloadable(
  plan: SelectedVariantPlan,
  context: TargetContext,
  allowedOrigins: string[],
): boolean {
  const isWhitelisted = (url: string) =>
    isWhitelistedMediaUrl(url, allowedOrigins).allowed;

  if (plan.youtubeMux) {
    return (
      isWhitelisted(plan.youtubeMux.videoUrl) &&
      isWhitelisted(plan.youtubeMux.audioUrl)
    );
  }
  if (plan.dashMux) {
    return (
      plan.dashMux.videoRoutes.some(isWhitelisted) &&
      plan.dashMux.audioRoutes.some(isWhitelisted)
    );
  }
  if (plan.target.kind === "file") {
    return (
      plan.target.routes.some(isWhitelisted) ||
      plan.target.routes.some(
        (r) => isSafeNativeBrowserDownloadUrl(r, allowedOrigins).safe,
      )
    );
  }
  if (plan.target.kind === "hls" && plan.variant.delivery.kind === "hls") {
    return deliveryRoutes(plan.variant.delivery.sources, context).some(
      isWhitelisted,
    );
  }
  if (
    plan.target.kind === "segments" &&
    plan.variant.delivery.kind === "segments"
  ) {
    const chunks: Chunk[] = [
      ...(plan.variant.delivery.init ? [plan.variant.delivery.init] : []),
      ...plan.variant.delivery.pieces,
    ];
    return (
      chunks.length > 0 &&
      chunks.every((chunk) =>
        deliveryRoutes(chunk.sources, context).some(isWhitelisted),
      )
    );
  }
  if (plan.target.kind === "pair" && plan.variant.delivery.kind === "pair") {
    return (
      plan.variant.delivery.resources.length > 0 &&
      plan.variant.delivery.resources.every((res) => {
        const del = res.delivery;
        if (del.kind === "segments") {
          const chunks: Chunk[] = [
            ...(del.init ? [del.init] : []),
            ...del.pieces,
          ];
          return (
            chunks.length > 0 &&
            chunks.every((chunk) =>
              deliveryRoutes(chunk.sources, context).some(isWhitelisted),
            )
          );
        }
        return deliveryRoutes(del.sources, context).some(isWhitelisted);
      })
    );
  }
  return false;
}

function compareScoredCandidatesDesc(
  a: ScoredCandidate,
  b: ScoredCandidate,
): number {
  const cmp = compareCanonicalVariantDesc(a.descriptor, b.descriptor);
  if (cmp !== 0) return cmp;
  if (a.isDirectFile !== b.isDirectFile) {
    return a.isDirectFile ? -1 : 1;
  }
  if (a.isDefault !== b.isDefault) {
    return a.isDefault ? -1 : 1;
  }
  return 0;
}

/**
 * Selects the optimal playable/downloadable variant for a `MediaItem` according
 * to the user's `QualityPreference` (`"best" | "1080p" | "audio"`), including
 * YouTube 4K60 video+audio mux pair resolution and attachment audio fallback.
 */
export function selectVariantByPreference(
  item: MediaItem,
  attachments: Attachment[] | undefined,
  qualityPreference: QualityPreference,
  apiOrigin: string,
  now?: number,
  extraAllowedOrigins?: string[],
): SelectedVariantPlan | null {
  if (!readyItem(item)) {
    return null;
  }
  const context: TargetContext = buildExtensionTargetContext(apiOrigin, now);
  const allowedOrigins = buildEffectiveExtraOrigins(
    apiOrigin,
    extraAllowedOrigins,
  );
  const readyVariants = item.variants.filter(readyVariant);

  // 1. Image / LivePhoto items always resolve as visual items even when qualityPreference === "audio"
  if (item.type === "live_photo") {
    for (const variant of readyVariants) {
      if (variant.delivery.kind === "pair") {
        const target = getDownloadTarget(
          item,
          { variant_id: variant.id },
          context,
        );
        if ("variant" in target) {
          return { variant, target, isAudioOnly: false };
        }
      }
    }
  }

  if (item.type === "image" || item.type === "live_photo") {
    const defTarget = getDefaultDownloadTarget(item, context);
    if ("variant" in defTarget) {
      return {
        variant: defTarget.variant,
        target: defTarget,
        isAudioOnly: false,
      };
    }
    for (const variant of readyVariants) {
      const target = getDownloadTarget(
        item,
        { variant_id: variant.id },
        context,
      );
      if ("variant" in target) {
        return { variant, target, isAudioOnly: false };
      }
    }
    return null;
  }

  // 2. Standalone audio preference ("audio")
  if (qualityPreference === "audio") {
    const audioPlans: Array<{
      plan: SelectedVariantPlan;
      isDownloadable: boolean;
      prefersM4a: boolean;
      notDubbed: boolean;
      bitrate: number;
    }> = [];

    for (const variant of readyVariants) {
      if (item.type !== "audio" && !isStandaloneAudioVariant(variant)) {
        continue;
      }
      const target = getDownloadTarget(
        item,
        { variant_id: variant.id },
        context,
      );
      if (!("variant" in target)) continue;
      const ext = (
        variant.metadata?.extension ||
        variant.metadata?.container ||
        ""
      ).toLowerCase();
      const mime = (variant.metadata?.mime_type || "").toLowerCase();
      const candidatePlan: SelectedVariantPlan = {
        variant,
        target,
        isAudioOnly: true,
      };
      audioPlans.push({
        plan: candidatePlan,
        isDownloadable: isPlanDirectlyDownloadable(
          candidatePlan,
          context,
          allowedOrigins,
        ),
        prefersM4a:
          ext === "m4a" ||
          mime === "audio/mp4" ||
          (variant.metadata?.audio_codec || "").toLowerCase().startsWith("mp4a") ||
          (variant.metadata?.audio_codec || "").toLowerCase() === "aac",
        notDubbed: !isDubbedAudioVariant(variant),
        bitrate:
          variant.metadata?.audio_bitrate_bps ||
          variant.metadata?.bitrate_bps ||
          0,
      });
    }

    const seenAttachmentAudioUrls = new Set<string>();
    const appendAttachmentAudioPlan = (att: Attachment) => {
      if (
        (att?.role === "background_audio" || att?.resource?.role === "audio") &&
        att.resource?.delivery?.kind === "file"
      ) {
        const avail = availableSources(att.resource.delivery.sources, context.now);
        if (!avail.length) return;
        const syntheticVariant: ReadyVariant = {
          id: att.id || `att-${att.resource.id || "audio"}`,
          state: "ready",
          label: att.title || "原声轨",
          metadata: att.resource.metadata,
          delivery: att.resource.delivery,
        };
        const syntheticItem: MediaItem = {
          id: item.id,
          type: "audio",
          title: att.title || item.title,
          variants: [syntheticVariant],
          default: null,
          default_unavailable_reason: "processing_required",
        };
        const target = getDownloadTarget(
          syntheticItem,
          { variant_id: syntheticVariant.id },
          context,
        );
        if (!("variant" in target)) return;
        if (target.kind === "file" && target.url) {
          if (seenAttachmentAudioUrls.has(target.url)) return;
          seenAttachmentAudioUrls.add(target.url);
        }
        const ext = (
          syntheticVariant.metadata?.extension ||
          syntheticVariant.metadata?.container ||
          ""
        ).toLowerCase();
        const mime = (syntheticVariant.metadata?.mime_type || "").toLowerCase();
        const attPlan: SelectedVariantPlan = {
          variant: syntheticVariant,
          target,
          isAudioOnly: true,
          ...(att.id ? { attachmentId: att.id } : {}),
        };
        audioPlans.push({
          plan: attPlan,
          isDownloadable: isPlanDirectlyDownloadable(
            attPlan,
            context,
            allowedOrigins,
          ),
          prefersM4a: ext === "m4a" || mime === "audio/mp4" || ext === "mp3",
          notDubbed: true,
          bitrate:
            syntheticVariant.metadata?.audio_bitrate_bps ||
            syntheticVariant.metadata?.bitrate_bps ||
            0,
        });
      }
    };

    for (const att of attachments ?? []) {
      const attId = typeof att?.id === "string" ? att.id.trim() : "";
      // Part-scoped Bilibili DASH audio attachments must strictly match this episode's item.id
      if (
        attId.startsWith("bilibili-audio-") &&
        attId !== `bilibili-audio-${item.id}`
      ) {
        continue;
      }
      appendAttachmentAudioPlan(att);
    }

    // Authoritative fallback: also inspect this episode's own ready mux variants'
    // audio leaf so multi-P Bilibili (or any DASH mux episode) always picks its own
    // part-specific audio stream even if media.attachments only holds another part.
    for (const variant of readyVariants) {
      if (variant.delivery.kind !== "mux") continue;
      for (const res of variant.delivery.resources) {
        if (res.role !== "audio" || res.delivery.kind !== "file") continue;
        appendAttachmentAudioPlan({
          id: `mux-audio-${item.id}`,
          role: "background_audio",
          title: "原声音频 (M4A)",
          resource: res,
        });
      }
    }

    if (audioPlans.length > 0) {
      audioPlans.sort((a, b) => {
        if (a.isDownloadable !== b.isDownloadable) {
          return a.isDownloadable ? -1 : 1;
        }
        if (a.notDubbed !== b.notDubbed) return a.notDubbed ? -1 : 1;
        if (a.prefersM4a !== b.prefersM4a) return a.prefersM4a ? -1 : 1;
        return b.bitrate - a.bitrate;
      });
      return audioPlans[0].plan;
    }
    // Fall through to default/best when the work has no standalone audio stream
  }

  // 3. Video (and fallback audio) ranking for "best" and "1080p"
  const candidates: ScoredCandidate[] = [];
  for (let variantIndex = 0; variantIndex < readyVariants.length; variantIndex++) {
    const variant = readyVariants[variantIndex];
    if (item.type !== "audio" && isStandaloneAudioVariant(variant)) {
      continue;
    }
    const dashMux = extractDashMuxSpec(variant, context);
    const target = getDownloadTarget(item, { variant_id: variant.id }, context);
    if (!("variant" in target) && !dashMux) {
      continue;
    }

    const meta = variant.metadata;
    let hasPlayableAudio = dashMux ? true : meta?.has_audio !== false;
    let youtubeMux: SelectedVariantPlan["youtubeMux"];

    if (
      !dashMux &&
      meta?.has_audio === false &&
      target.kind === "file" &&
      isValidGooglevideoPlaybackUrl(target.url)
    ) {
      const pair = selectYouTubeMuxPair(variant, item.variants, attachments);
      if (pair.ok) {
        hasPlayableAudio = true;
        youtubeMux = {
          videoUrl: target.url,
          audioUrl: sourceUrl(pair.audioSource, context),
          videoSize: target.source.size_bytes,
          audioSize: pair.audioSource.size_bytes,
          videoSource: target.source,
          audioSource: pair.audioSource,
          outputContainer: pair.outputContainer,
        };
      }
    }

    const candidatePlan: SelectedVariantPlan = {
      variant,
      target,
      isAudioOnly: item.type === "audio",
      ...(youtubeMux ? { youtubeMux } : {}),
      ...(dashMux ? { dashMux } : {}),
    };
    const isDownloadable = isPlanDirectlyDownloadable(
      candidatePlan,
      context,
      allowedOrigins,
    );
    const descriptor = buildCanonicalVariantDescriptor({
      variant,
      downloadable: isDownloadable,
      isAudioOnly: candidatePlan.isAudioOnly,
      effectiveHasAudio: hasPlayableAudio,
      originalIndex: variantIndex,
    });
    candidates.push({
      plan: candidatePlan,
      isDownloadable,
      shortEdge:
        descriptor.shortEdge || inferShortEdgeFromLabel(variant.label),
      descriptor,
      isDirectFile: variant.delivery.kind === "file",
      isDefault: item.default?.variant_id === variant.id,
    });
  }

  if (candidates.length === 0) {
    const defTarget = getDefaultDownloadTarget(item, context);
    if ("variant" in defTarget) {
      return {
        variant: defTarget.variant,
        target: defTarget,
        isAudioOnly: item.type === "audio",
      };
    }
    return null;
  }

  const preferredPool = candidates.some((c) => c.isDownloadable)
    ? candidates.filter((c) => c.isDownloadable)
    : candidates;

  if (qualityPreference === "1080p") {
    const within1080 = preferredPool.filter(
      (c) => c.shortEdge > 0 && c.shortEdge <= 1080,
    );
    if (within1080.length > 0) {
      within1080.sort(compareScoredCandidatesDesc);
      return within1080[0].plan;
    }
    const unknownRes = preferredPool.filter((c) => c.shortEdge === 0);
    if (unknownRes.length > 0) {
      unknownRes.sort(compareScoredCandidatesDesc);
      return unknownRes[0].plan;
    }
    // All variants are > 1080p: pick the closest one above 1080p with playable audio
    const above = [...preferredPool].sort((a, b) => {
      if (a.descriptor.effectiveHasAudio !== b.descriptor.effectiveHasAudio) {
        return a.descriptor.effectiveHasAudio ? -1 : 1;
      }
      if (a.shortEdge !== b.shortEdge) {
        return a.shortEdge - b.shortEdge;
      }
      return compareScoredCandidatesDesc(a, b);
    });
    return above[0].plan;
  }

  preferredPool.sort(compareScoredCandidatesDesc);
  return preferredPool[0].plan;
}

export function resolveExtensionForTarget(
  target: Extract<DownloadTarget, { variant: ReadyVariant }>,
  item: MediaItem,
  _platform: string,
  isAudioOnly: boolean,
): { ext: string; mimeType?: string } {
  const delivery = target.variant.delivery;
  const baseExt = mediaExtension(
    target.variant.metadata,
    delivery.kind === "mux" || delivery.kind === "pair" ? undefined : delivery,
  );
  const formatMime =
    target.kind === "file"
      ? confirmedFormatMime(target.variant.metadata)
      : undefined;
  const suffixes = extensionsFor(formatMime || "");
  let resolvedExt =
    suffixes.length && !suffixes.includes(baseExt) ? suffixes[0] : baseExt;
  if (!isSafeDownloadExtension(resolvedExt)) {
    resolvedExt = "bin";
  }

  if (resolvedExt === "bin") {
    if (isAudioOnly || item.type === "audio") {
      resolvedExt = "m4a";
    } else if (item.type === "image") {
      resolvedExt = "jpg";
    } else if (target.kind === "file") {
      resolvedExt =
        inferDirectVideoExtension(target.url, Boolean(item.tbvideo?.vid)) ||
        "mp4";
    } else {
      resolvedExt = "mp4";
    }
  }

  const mimeType =
    formatMime ||
    target.variant.metadata?.mime_type ||
    (delivery.kind !== "file" &&
    delivery.kind !== "pair" &&
    "output" in delivery
      ? delivery.output?.mime_type
      : undefined);

  return { ext: resolvedExt, mimeType };
}
