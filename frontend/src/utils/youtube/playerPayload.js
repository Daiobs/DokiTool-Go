// Stateless TVHTML5 player request payload builder, audio-track classification
// helpers, and YouTube player API response sanitizers.

import {
  MAX_HELPER_TITLE_CHARS,
  isValidSignatureTimestamp,
  isValidTVHTML5Client,
  isValidYouTubeThumbnailUrl,
  isValidYouTubeVideoId,
  sanitizeHelperText,
} from "./helperValidation.js";

const ALLOWED_FORMAT_KEYS = [
  "itag",
  "url",
  "signatureCipher",
  "mimeType",
  "width",
  "height",
  "fps",
  "bitrate",
  "contentLength",
  "audioQuality",
  "audioSampleRate",
  "audioChannels",
];

const AUDIO_TRACK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_AUDIO_TRACK_DISPLAY_NAME_CHARS = 80;

export function extractXtagsAudioContent(entry) {
  let rawUrl = "";
  if (typeof entry?.url === "string" && entry.url.trim()) {
    rawUrl = entry.url.trim();
  } else if (
    typeof entry?.signatureCipher === "string" &&
    entry.signatureCipher.trim()
  ) {
    try {
      const cipherParams = new URLSearchParams(entry.signatureCipher);
      rawUrl = (cipherParams.get("url") || "").trim();
    } catch {
      rawUrl = "";
    }
  }
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    const xtags = (parsed.searchParams.get("xtags") || "").trim();
    if (!xtags) return "";
    let acont = "";
    for (const part of xtags.split(":")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx <= 0) continue;
      const k = part.slice(0, eqIdx).trim().toLowerCase();
      if (k === "acont") {
        acont = part.slice(eqIdx + 1).trim().toLowerCase();
      }
    }
    return acont;
  } catch {
    return "";
  }
}

export function sanitizeVideoDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== "object") return null;
  const out = {};
  const title = sanitizeHelperText(rawDetails.title, MAX_HELPER_TITLE_CHARS);
  if (title) {
    out.title = title;
  }
  const author = sanitizeHelperText(rawDetails.author, MAX_HELPER_TITLE_CHARS);
  if (author) {
    out.author = author;
  }
  const rawLen = rawDetails.lengthSeconds;
  if (typeof rawLen === "number" || typeof rawLen === "string") {
    const parsedLen = Number.parseInt(String(rawLen).trim(), 10);
    if (
      Number.isInteger(parsedLen) &&
      parsedLen > 0 &&
      parsedLen <= 86400 * 365
    ) {
      out.lengthSeconds = parsedLen;
    }
  }
  const thumbs = rawDetails.thumbnail?.thumbnails;
  if (Array.isArray(thumbs)) {
    let bestUrl = "";
    let bestScore = -1;
    for (const item of thumbs) {
      if (!item || typeof item !== "object") continue;
      const candidateUrl =
        typeof item.url === "string" ? item.url.trim() : "";
      if (!isValidYouTubeThumbnailUrl(candidateUrl)) continue;
      const w = Number(item.width) > 0 ? Number(item.width) : 0;
      const h = Number(item.height) > 0 ? Number(item.height) : 0;
      const score = w * h;
      if (score >= bestScore) {
        bestScore = score;
        bestUrl = candidateUrl;
      }
    }
    if (bestUrl) {
      out.thumbnail = bestUrl;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function buildTVHTML5PlayerPayload(params) {
  if (!params || typeof params !== "object") {
    throw new Error("无效的播放器请求参数");
  }
  const { video_id, signature_timestamp, client, visitorData } = params;
  if (!isValidYouTubeVideoId(video_id)) {
    throw new Error("无效的 YouTube video_id");
  }
  if (!isValidSignatureTimestamp(signature_timestamp)) {
    throw new Error("无效的 signature_timestamp");
  }
  if (!isValidTVHTML5Client(client)) {
    throw new Error("仅支持 TVHTML5 客户端及合法版本号");
  }
  const TVHTML5_USER_AGENT =
    "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1";
  const clientObj = {
    clientName: "TVHTML5",
    clientVersion: client.version,
    deviceMake: "Samsung",
    deviceModel: "UKS9800",
    userAgent: TVHTML5_USER_AGENT,
    osName: "Tizen",
    osVersion: "2.4.0",
    hl: "en",
    gl: "US",
    timeZone: "UTC",
    utcOffsetMinutes: 0,
  };
  if (typeof visitorData === "string" && visitorData.trim()) {
    clientObj.visitorData = visitorData.trim();
  }
  return {
    videoId: video_id,
    context: {
      client: clientObj,
    },
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
        signatureTimestamp: signature_timestamp,
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

function sanitizeAudioTrack(rawTrack) {
  if (!rawTrack || typeof rawTrack !== "object" || Array.isArray(rawTrack)) {
    return null;
  }
  const out = {};
  if (typeof rawTrack.id === "string") {
    const trimmedId = rawTrack.id.trim();
    if (AUDIO_TRACK_ID_RE.test(trimmedId)) {
      out.id = trimmedId;
    }
  }
  const displayName = sanitizeHelperText(
    rawTrack.displayName,
    MAX_AUDIO_TRACK_DISPLAY_NAME_CHARS,
  );
  if (displayName) {
    out.displayName = displayName;
  }
  if (typeof rawTrack.audioIsDefault === "boolean") {
    out.audioIsDefault = rawTrack.audioIsDefault;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function isDescriptiveAudio(at) {
  return Boolean(
    at && /descriptive|description/i.test(`${at.id || ""} ${at.displayName || ""}`),
  );
}

function isDubbedAudio(at) {
  return Boolean(
    at && /dubbed|auto-dubbed|配音/i.test(`${at.id || ""} ${at.displayName || ""}`),
  );
}

function isOriginalAudio(at) {
  return Boolean(
    at && /original|原声|原音/i.test(`${at.id || ""} ${at.displayName || ""}`),
  );
}

export function classifyAudioFormatEntry(entry) {
  const at = entry?.audioTrack || null;
  const acont = extractXtagsAudioContent(entry);
  const isDescriptive = acont === "descriptive" || isDescriptiveAudio(at);
  const isDubbed =
    acont === "dubbed" ||
    acont === "dubbed-auto" ||
    acont === "secondary" ||
    isDubbedAudio(at);
  const isOriginal = acont === "original" || isOriginalAudio(at);
  const isDefault = at?.audioIsDefault === true;
  const hasHint = Boolean(at) || isDescriptive || isDubbed || isOriginal;
  return { entry, hasHint, isOriginal, isDescriptive, isDubbed, isDefault };
}

export function sanitizeFormatArray(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const clean = {};
    for (const key of ALLOWED_FORMAT_KEYS) {
      if (item[key] !== undefined && item[key] !== null) {
        clean[key] = item[key];
      }
    }
    const cleanAudioTrack = sanitizeAudioTrack(item.audioTrack);
    if (cleanAudioTrack) {
      clean.audioTrack = cleanAudioTrack;
    }
    if (
      typeof clean.itag === "number" &&
      clean.itag > 0 &&
      (typeof clean.url === "string" || typeof clean.signatureCipher === "string")
    ) {
      out.push(clean);
    }
  }

  const isAudioOnly = (entry) =>
    typeof entry.mimeType === "string" &&
    entry.mimeType.trim().toLowerCase().startsWith("audio/");
  const nonAudioEntries = out.filter((entry) => !isAudioOnly(entry));
  const audioEntries = out.filter(isAudioOnly);

  const classifiedAudio = audioEntries.map(classifyAudioFormatEntry);
  if (classifiedAudio.some((c) => c.hasHint)) {
    const tiers = [
      (c) => c.isOriginal && !c.isDescriptive && !c.isDubbed,
      (c) => c.isDefault && !c.isDescriptive && !c.isDubbed,
      (c) => c.isDefault && !c.isDescriptive,
      (c) => c.isDefault,
    ];
    let keptAudio = audioEntries;
    for (const pred of tiers) {
      const matched = classifiedAudio.filter(pred);
      if (matched.length > 0) {
        keptAudio = matched.map((c) => c.entry);
        break;
      }
    }
    return [...nonAudioEntries, ...keptAudio];
  }

  return out;
}

export function sanitizePlayerCaptions(rawCaptions) {
  if (!rawCaptions || typeof rawCaptions !== "object" || Array.isArray(rawCaptions)) {
    return null;
  }
  const renderer = rawCaptions.playerCaptionsTracklistRenderer;
  const rawTracks = Array.isArray(renderer?.captionTracks)
    ? renderer.captionTracks
    : Array.isArray(rawCaptions.captionTracks)
      ? rawCaptions.captionTracks
      : null;
  if (!rawTracks || rawTracks.length === 0) return null;

  const captionTracks = [];
  for (const track of rawTracks) {
    if (captionTracks.length >= 64) break;
    if (!track || typeof track !== "object" || Array.isArray(track)) continue;
    const baseUrl = typeof track.baseUrl === "string" ? track.baseUrl.trim() : "";
    if (!baseUrl) continue;
    const clean = { baseUrl };
    if (typeof track.name === "string" && track.name.trim()) {
      clean.name = track.name.trim();
    } else if (track.name && typeof track.name === "object" && !Array.isArray(track.name)) {
      const nameObj = {};
      if (typeof track.name.simpleText === "string" && track.name.simpleText.trim()) {
        nameObj.simpleText = track.name.simpleText.trim();
      }
      if (Array.isArray(track.name.runs)) {
        const runs = track.name.runs
          .filter((r) => r && typeof r === "object" && typeof r.text === "string")
          .map((r) => ({ text: r.text }));
        if (runs.length > 0) nameObj.runs = runs;
      }
      if (Object.keys(nameObj).length > 0) clean.name = nameObj;
    }
    if (typeof track.vssId === "string" && track.vssId.trim()) clean.vssId = track.vssId.trim();
    if (typeof track.languageCode === "string" && track.languageCode.trim()) clean.languageCode = track.languageCode.trim();
    if (typeof track.kind === "string" && track.kind.trim()) clean.kind = track.kind.trim();
    if (typeof track.isTranslatable === "boolean") clean.isTranslatable = track.isTranslatable;
    captionTracks.push(clean);
  }
  return captionTracks.length > 0
    ? { playerCaptionsTracklistRenderer: { captionTracks } }
    : null;
}

export function sanitizePlayerApiResponse(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("YouTube 播放器响应无效");
  }
  const ps = raw.playabilityStatus;
  const playabilityStatus =
    ps && typeof ps === "object"
      ? {
          status: typeof ps.status === "string" ? ps.status : "ERROR",
          ...(typeof ps.reason === "string" ? { reason: ps.reason } : {}),
        }
      : { status: "ERROR" };

  const sd = raw.streamingData;
  const streamingData =
    sd && typeof sd === "object"
      ? {
          formats: sanitizeFormatArray(sd.formats),
          adaptiveFormats: sanitizeFormatArray(sd.adaptiveFormats),
        }
      : null;

  const videoDetails = sanitizeVideoDetails(raw.videoDetails);
  const captions = sanitizePlayerCaptions(raw.captions);

  return {
    playabilityStatus,
    streamingData,
    ...(videoDetails ? { videoDetails } : {}),
    ...(captions ? { captions } : {}),
  };
}
