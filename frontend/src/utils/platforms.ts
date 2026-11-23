import { shallowRef } from "vue";
import snapshot from "../generated/platform-catalog.json";
import { apiConfig } from "../services/apiConfig";
export interface Platform {
  id: string;
  name: string;
  site_url: string;
  icon?: string;
  capabilities: string[];
}
export function readPlatformCatalog(value: unknown): Platform[] {
  const envelope = value as {
    schema_version?: string;
    code?: string;
    data?: { platforms?: Platform[] };
  };
  if (
    envelope?.schema_version !== "1.0" ||
    envelope.code !== "OK" ||
    !Array.isArray(envelope.data?.platforms)
  )
    throw new Error("平台目录格式无效");
  const platforms = envelope.data.platforms;
  if (
    new Set(platforms.map((platform) => platform.id)).size !==
      platforms.length ||
    platforms.some(
      (platform) =>
        !/^[a-z][a-z0-9_-]*$/.test(platform.id) ||
        !platform.name ||
        !Array.isArray(platform.capabilities) ||
        !/^https?:\/\//.test(platform.site_url),
    )
  )
    throw new Error("平台目录无效");
  return platforms;
}
const initialPlatforms = readPlatformCatalog(snapshot);
export const supportedPlatforms = shallowRef(initialPlatforms);
export async function refreshPlatformCatalog() {
  try {
    const response = await fetch(`${apiConfig.catalogUrl}?schema_version=1.0`, {
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok)
      supportedPlatforms.value = readPlatformCatalog(await response.json());
  } catch {
    /* The backend-generated build snapshot keeps the homepage usable offline. */
  }
}
// Optional presentation assets do not register parsers or affect parsing behavior.
const tabIcons: Record<string, string> = {
  douyin: "fa-music",
  kuaishou: "fa-bolt",
  bilibili: "fa-play-circle",
  xiaohongshu: "fa-bookmark",
  toutiao: "fa-newspaper",
  weibo: "fa-comment",
  pipixia: "fa-face-laugh",
  pipigx: "fa-face-smile",
  zuiyou: "fa-comments",
  x: "fa-x-twitter",
  youtube: "fa-youtube",
  instagram: "fa-instagram",
  facebook: "fa-facebook",
  tumblr: "fa-tumblr",
};
export const POPULAR_PLATFORM_IDS = [
  "douyin",
  "kuaishou",
  "bilibili",
  "xiaohongshu",
  "weibo",
  "x",
  "youtube",
  "instagram",
  "facebook",
] as const;

export const POPULAR_PLATFORMS: ReadonlyArray<{
  id: (typeof POPULAR_PLATFORM_IDS)[number];
  name: string;
  icon: string;
}> = [
  { id: "douyin", name: "抖音", icon: "douyin" },
  { id: "kuaishou", name: "快手", icon: "kuaishou" },
  { id: "bilibili", name: "B站", icon: "bilibili" },
  { id: "xiaohongshu", name: "小红书", icon: "xiaohongshu" },
  { id: "weibo", name: "微博", icon: "weibo" },
  { id: "x", name: "X", icon: "x" },
  { id: "youtube", name: "YouTube", icon: "youtube" },
  { id: "instagram", name: "Instagram", icon: "instagram" },
  { id: "facebook", name: "Facebook", icon: "facebook" },
];

export const platformEnName = (id: string, name = ""): string =>
  /^[a-z0-9 ._-]+$/i.test(name) ? name : id ? id[0].toUpperCase() + id.slice(1) : name;

export interface PlatformPresentation {
  id: string;
  label: string;
  icon: string;
  isBuiltin: boolean;
}

const GENERIC_MEDIA_ICON = "fa-film";
const GENERIC_AUDIO_ICON = "fa-headphones";

const DYNAMIC_PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  vimeo: "Vimeo",
  reddit: "Reddit",
  twitch: "Twitch",
  twitchvod: "Twitch",
  twitchclips: "Twitch",
  twitchstream: "Twitch",
  soundcloud: "SoundCloud",
  niconico: "Niconico",
  pinterest: "Pinterest",
  dailymotion: "Dailymotion",
  vk: "VK",
  vkvideo: "VK",
  streamable: "Streamable",
  bandcamp: "Bandcamp",
  ted: "TED",
  rutube: "RuTube",
  peertube: "PeerTube",
  linkedin: "LinkedIn",
  "9gag": "9GAG",
};

const AUDIO_FIRST_PLATFORMS = new Set([
  "soundcloud",
  "bandcamp",
  "mixcloud",
  "audiomack",
]);

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function formatDynamicPlatformLabel(id: string): string {
  if (hasOwn(DYNAMIC_PLATFORM_LABELS, id)) {
    return DYNAMIC_PLATFORM_LABELS[id];
  }
  const stripped = id.replace(/^site_/, "") || id;
  if (hasOwn(DYNAMIC_PLATFORM_LABELS, stripped)) {
    return DYNAMIC_PLATFORM_LABELS[stripped];
  }
  const words = stripped
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return words.join(" ") || id;
}

export function resolvePlatformPresentation(
  platformId: string | undefined,
  locale?: string,
  mediaType?: string,
): PlatformPresentation {
  const id = String(platformId ?? "")
    .trim()
    .toLowerCase();
  const isEn = locale === "en";
  if (!id) {
    return {
      id: "",
      label: isEn ? "Media" : "通用媒体",
      icon: mediaType === "audio" ? GENERIC_AUDIO_ICON : GENERIC_MEDIA_ICON,
      isBuiltin: false,
    };
  }
  if (hasOwn(tabIcons, id)) {
    const entry =
      supportedPlatforms.value.find((p) => p.id === id) ||
      initialPlatforms.find((p) => p.id === id);
    const zhName =
      entry?.name || POPULAR_PLATFORMS.find((p) => p.id === id)?.name || id;
    const iconKey = entry?.icon && hasOwn(tabIcons, entry.icon) ? entry.icon : id;
    return {
      id,
      label: isEn ? platformEnName(id, zhName) : zhName,
      icon: tabIcons[iconKey],
      isBuiltin: true,
    };
  }
  const catalogEntry = supportedPlatforms.value.find((p) => p.id === id);
  const label = catalogEntry
    ? isEn
      ? platformEnName(id, catalogEntry.name)
      : catalogEntry.name
    : formatDynamicPlatformLabel(id);
  const icon =
    mediaType === "audio" || AUDIO_FIRST_PLATFORMS.has(id)
      ? GENERIC_AUDIO_ICON
      : GENERIC_MEDIA_ICON;
  return {
    id,
    label,
    icon,
    isBuiltin: false,
  };
}

export interface PlatformTabItem {
  key: string;
  label: string;
  icon: string;
  disabled?: boolean;
}

export function platformTabs(locale: string): PlatformTabItem[] {
  const enabledIds = new Set(supportedPlatforms.value.map((p) => p.id));
  return [
    {
      key: "all",
      label: locale === "en" ? "All" : "所有平台",
      icon: "fa-globe",
      disabled: false,
    },
    ...POPULAR_PLATFORMS.map((p) => ({
      key: p.id,
      label: locale === "en" ? platformEnName(p.id, p.name) : p.name,
      icon: tabIcons[p.icon] || "fa-globe",
      disabled: !enabledIds.has(p.id),
    })),
  ];
}
