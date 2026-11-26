// Stateless YouTube same-container video+audio mux pair selector and
// googlevideo content-length (`clen`) query parser.

import { isValidGooglevideoPlaybackUrl } from "./helperValidation.js";
import { extractXtagsAudioContent } from "./playerPayload.js";

export function extractUrlClen(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return 0;
  try {
    const u = new URL(rawUrl.trim());
    const raw = u.searchParams.get("clen");
    if (!raw || !/^[0-9]+$/.test(raw.trim())) return 0;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function pickUsableVariantSource(variant) {
  const sources = variant && variant.delivery && variant.delivery.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const hasUrl = (s) => s && typeof s.url === "string" && s.url.trim();
  return (
    sources.find((s) => hasUrl(s) && s.availability !== "unavailable") ||
    sources.find(hasUrl) ||
    null
  );
}

export function selectYouTubeMuxPair(
  videoVariant,
  allVariants,
  attachments = [],
) {
  if (
    !videoVariant ||
    typeof videoVariant !== "object" ||
    videoVariant.state === "deferred" ||
    !videoVariant.delivery ||
    videoVariant.delivery.kind !== "file"
  ) {
    return { ok: false, reason: "当前画质不支持浏览器内合流" };
  }
  const vMeta = videoVariant.metadata || {};
  if (vMeta.has_audio !== false) {
    return { ok: false, reason: "当前画质已包含音轨，无需合流" };
  }
  const videoSource = pickUsableVariantSource(videoVariant);
  if (!videoSource || !isValidGooglevideoPlaybackUrl(videoSource.url)) {
    return { ok: false, reason: "视频轨地址无效或不可用" };
  }

  const norm = (v) => String(v || "").trim().toLowerCase();
  const vcodec = norm(vMeta.video_codec);
  const vContainer = norm(vMeta.container || vMeta.extension);

  const isH264OrAV1 =
    vcodec === "h264" ||
    vcodec.startsWith("avc1") ||
    vcodec === "av1" ||
    vcodec.startsWith("av01");
  const isVP9 =
    vcodec === "vp9" || vcodec.startsWith("vp9.") || vcodec.startsWith("vp09");

  const isMp4Video = isH264OrAV1 && (!vContainer || vContainer === "mp4");
  const isWebmVideo = isVP9 && (!vContainer || vContainer === "webm");

  if (!isMp4Video && !isWebmVideo) {
    return {
      ok: false,
      reason: `不支持的视频编码或容器组合（${vcodec || "未知"} / ${vContainer || "未知"}）`,
    };
  }

  const candidates = [
    ...(Array.isArray(allVariants) ? allVariants : []),
    ...(Array.isArray(attachments)
      ? attachments
          .filter(
            (att) =>
              att &&
              typeof att === "object" &&
              att.resource &&
              att.resource.role === "audio" &&
              att.resource.delivery &&
              att.resource.delivery.kind === "file",
          )
          .map((att) => ({
            id: att.id || `att-${att.resource.id || "audio"}`,
            state: "ready",
            label: att.title || "原声轨",
            metadata: att.resource.metadata,
            delivery: att.resource.delivery,
          }))
      : []),
  ];
  const matched = [];
  for (const cand of candidates) {
    if (
      !cand ||
      typeof cand !== "object" ||
      cand.state === "deferred" ||
      cand.id === videoVariant.id ||
      !cand.delivery ||
      cand.delivery.kind !== "file"
    ) {
      continue;
    }
    const aMeta = cand.metadata || {};
    const aMime = norm(aMeta.mime_type);
    const aExt = norm(aMeta.extension);
    const aContainer = norm(aMeta.container);
    const acodec = norm(aMeta.audio_codec);

    const isStandaloneAudio =
      aMeta.has_audio === true &&
      !aMeta.video_codec &&
      (aMime.startsWith("audio/") || aExt === "m4a" || aExt === "webm");
    if (!isStandaloneAudio) continue;

    const outFmt = isMp4Video
      ? (acodec === "aac" || acodec.startsWith("mp4a")) &&
        (aContainer === "mp4" || aContainer === "m4a" || aExt === "m4a")
        ? "mp4"
        : ""
      : (acodec === "opus" || acodec.startsWith("opus")) &&
          (aContainer === "webm" || aExt === "webm")
        ? "webm"
        : "";
    if (!outFmt) continue;
    const audioSource = pickUsableVariantSource(cand);
    if (!audioSource || !isValidGooglevideoPlaybackUrl(audioSource.url)) {
      continue;
    }
    matched.push({ cand, audioSource, outFmt });
  }

  if (matched.length > 0) {
    const isDubbedOrDescriptive = ({ cand, audioSource }) => {
      const role = norm(cand.metadata?.audio_language_role);
      const label = String(cand.label || "");
      const acont = extractXtagsAudioContent({ url: audioSource?.url });
      return (
        role === "alternate" ||
        acont === "descriptive" ||
        acont === "dubbed" ||
        acont === "dubbed-auto" ||
        acont === "secondary" ||
        /dubbed|auto-dubbed|配音|descriptive|description/i.test(label)
      );
    };
    const isExplicitOriginal = ({ cand, audioSource }) => {
      const role = norm(cand.metadata?.audio_language_role);
      const label = String(cand.label || "");
      const acont = extractXtagsAudioContent({ url: audioSource?.url });
      return (
        !isDubbedOrDescriptive({ cand, audioSource }) &&
        (role === "main" ||
          acont === "original" ||
          /original|原声|原音/i.test(label))
      );
    };
    const chosen =
      matched.find(isExplicitOriginal) ||
      matched.find((m) => !isDubbedOrDescriptive(m)) ||
      matched[0];
    return {
      ok: true,
      outputContainer: chosen.outFmt,
      outputExtension: chosen.outFmt,
      outputMimeType: `video/${chosen.outFmt}`,
      videoVariant,
      audioVariant: chosen.cand,
      videoSource,
      audioSource: chosen.audioSource,
    };
  }

  return {
    ok: false,
    reason: isMp4Video
      ? "未找到同容器 AAC (M4A) 音轨，不做跨容器合流"
      : "未找到同容器 Opus (WebM) 音轨，不做跨容器合流",
  };
}
