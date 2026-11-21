// Local 14-platform URL matcher & batch text extractor (privacy firewall).
//
// Parity contract:
// Matches ONLY the exact 14 platforms registered in `backend/internal/catalog/catalog.go`
// (`backend/config/platforms.json` + `zuiyou` exact `share.xiaochuankeji.cn` + `x` +
// `youtube` + `instagram`) and `backend/internal/platform/ytgeneric/sites.go`
// (`facebook` exact hosts + `tumblr`).
//
// Any non-supported website, browser internal scheme (`chrome://`, `file://`, `about:`),
// IP literal, userinfo URL, non-standard port, or `snap.dokitool.com` strictly returns `null`
// so browsing history never leaves the browser.

export const SUPPORTED_PLATFORM_IDS = [
  "douyin",
  "kuaishou",
  "bilibili",
  "xiaohongshu",
  "toutiao",
  "weibo",
  "pipixia",
  "pipigx",
  "zuiyou",
  "x",
  "youtube",
  "instagram",
  "facebook",
  "tumblr",
] as const;

export type PlatformId = (typeof SUPPORTED_PLATFORM_IDS)[number];

export interface PlatformDomainSpec {
  readonly id: PlatformId;
  readonly label: string;
  readonly domains?: readonly string[];
  readonly exactDomains?: readonly string[];
}

export const PLATFORM_DOMAIN_SPECS: readonly PlatformDomainSpec[] = [
  {
    id: "douyin",
    label: "抖音",
    domains: ["douyin.com", "iesdouyin.com"],
  },
  {
    id: "kuaishou",
    label: "快手",
    domains: ["kuaishou.com"],
  },
  {
    id: "bilibili",
    label: "B站",
    domains: ["bilibili.com", "b23.tv"],
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    domains: ["xiaohongshu.com", "xhslink.com", "rednote.com"],
  },
  {
    id: "toutiao",
    label: "今日头条",
    domains: ["toutiao.com", "toutiaoimg.com"],
  },
  {
    id: "weibo",
    label: "微博",
    domains: ["weibo.com", "weibo.cn"],
  },
  {
    id: "pipixia",
    label: "皮皮虾",
    domains: ["pipix.com"],
  },
  {
    id: "pipigx",
    label: "皮皮搞笑",
    domains: ["pipigx.com", "ippzone.com"],
  },
  {
    id: "zuiyou",
    label: "最右",
    domains: ["izuiyou.com"],
    exactDomains: ["share.xiaochuankeji.cn"],
  },
  {
    id: "x",
    label: "X",
    domains: ["x.com", "twitter.com", "t.co"],
  },
  {
    id: "youtube",
    label: "YouTube",
    domains: ["youtube.com", "youtu.be"],
  },
  {
    id: "instagram",
    label: "Instagram",
    domains: ["instagram.com", "instagr.am"],
  },
  {
    id: "facebook",
    label: "Facebook",
    exactDomains: [
      "www.facebook.com",
      "facebook.com",
      "m.facebook.com",
      "fb.watch",
    ],
  },
  {
    id: "tumblr",
    label: "Tumblr",
    domains: ["tumblr.com"],
  },
] as const;

export interface MatchedPlatformUrl {
  platform: PlatformId;
  platformLabel: string;
  url: string;
  dedupeKey: string;
  youtubeVideoId?: string;
  isLikelyFeedOrHome: boolean;
}

export interface BatchUrlExtractResult {
  items: MatchedPlatformUrl[];
  ignoredLineCount: number;
  duplicateCount: number;
}

const HOSTNAME_SYNTAX = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const TRACKING_QUERY_PARAMS = new Set([
  "spm",
  "spm_id_from",
  "vd_source",
  "from_spmid",
  "from",
  "seid",
  "share_source",
  "share_medium",
  "share_plat",
  "share_from",
  "share_session_id",
  "share_tag",
  "share_Copy_Link",
  "uniquekey",
  "timestamp",
  "fbclid",
  "gclid",
  "igshid",
  "igsh",
  "si",
  "pp",
  "feature",
  "s",
  "t",
  "ref_src",
  "ref_url",
  "app",
  "is_from_webapp",
  "sender_device",
  "web_id",
  "ug_source",
  "ug_btm",
  "enter_from",
  "xsec_source",
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lower);
}

function isIpLiteralOrInvalidHost(host: string): boolean {
  if (!host || host.length > 253) return true;
  if (host.startsWith("[") || host.includes(":") || host.includes("..")) {
    return true;
  }
  if (!HOSTNAME_SYNTAX.test(host)) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || /^(?:0x[0-9a-f]+|\d+)$/i.test(host)) {
    return true;
  }
  return false;
}

function validateAndParseHttpUrl(raw: string): URL | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return null;

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c /* '\\' */) {
      return null;
    }
  }

  const schemeIdx = trimmed.indexOf("://");
  if (schemeIdx <= 0) return null;
  const rawScheme = trimmed.slice(0, schemeIdx).toLowerCase();
  if (rawScheme !== "http" && rawScheme !== "https") {
    return null;
  }

  const afterScheme = trimmed.slice(schemeIdx + 3);
  const pathStart = afterScheme.search(/[/?#]/);
  const authority = pathStart >= 0 ? afterScheme.slice(0, pathStart) : afterScheme;
  if (!authority || authority.includes("@") || authority.endsWith(":")) {
    return null;
  }

  // Enforce standard port if explicitly written in raw authority
  const colonIdx = authority.lastIndexOf(":");
  if (colonIdx >= 0) {
    const portStr = authority.slice(colonIdx + 1);
    if (!/^\d+$/.test(portStr)) return null;
    const portNum = Number(portStr);
    if (
      (rawScheme === "https" && portNum !== 443) ||
      (rawScheme === "http" && portNum !== 80)
    ) {
      return null;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.port !== "") {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (isIpLiteralOrInvalidHost(host) || host === "snap.dokitool.com") {
    return null;
  }

  // Strip fragment so normalized URLs never trip backend fragment checks
  parsed.hash = "";
  return parsed;
}

function lookupPlatformSpec(host: string): PlatformDomainSpec | null {
  for (const spec of PLATFORM_DOMAIN_SPECS) {
    if (spec.exactDomains?.includes(host)) {
      return spec;
    }
    if (
      spec.domains?.some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      )
    ) {
      return spec;
    }
  }
  return null;
}

function splitPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractYouTubeId(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const segments = splitPathSegments(url.pathname);
  let candidate = "";

  if (host === "youtu.be" || host === "www.youtu.be") {
    if (segments.length >= 1) {
      candidate = segments[0];
    }
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (segments.length === 1 && segments[0].toLowerCase() === "watch") {
      candidate = url.searchParams.get("v") ?? "";
    } else if (
      segments.length >= 2 &&
      ["shorts", "embed", "live", "v"].includes(segments[0].toLowerCase())
    ) {
      candidate = segments[1];
    }
  }

  return YOUTUBE_VIDEO_ID_RE.test(candidate) ? candidate : undefined;
}

function fallbackDedupeKey(platform: PlatformId, url: URL): string {
  const host = url.hostname.toLowerCase();
  const cleanPath =
    url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";
  const keptParams: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    // Strip tracking noise and volatile tokens like xsec_token ONLY in dedupeKey
    // (the full `matched.url` retains `xsec_token` intact for backend parsing).
    if (!isTrackingParam(key) && key !== "xsec_token") {
      keptParams.push([key, value]);
    }
  });
  keptParams.sort((a, b) =>
    a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
  );
  const queryPart = keptParams.length
    ? `?${keptParams
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")}`
    : "";
  return `${platform}:url:${host}${cleanPath}${queryPart}`;
}

function analyzePlatformDetails(
  platform: PlatformId,
  url: URL,
): {
  dedupeKey: string;
  youtubeVideoId?: string;
  isLikelyFeedOrHome: boolean;
} {
  const host = url.hostname.toLowerCase();
  const segments = splitPathSegments(url.pathname);

  switch (platform) {
    case "youtube": {
      const youtubeVideoId = extractYouTubeId(url);
      if (youtubeVideoId) {
        return {
          dedupeKey: `youtube:video:${youtubeVideoId}`,
          youtubeVideoId,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "douyin": {
      const modalId = url.searchParams.get("modal_id")?.trim() ?? "";
      if (/^\d{1,25}$/.test(modalId)) {
        return {
          dedupeKey: `douyin:item:${modalId}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length >= 2 &&
        ["video", "note", "slides"].includes(segments[0].toLowerCase()) &&
        /^\d{1,25}$/.test(segments[1])
      ) {
        return {
          dedupeKey: `douyin:item:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length >= 3 &&
        segments[0].toLowerCase() === "share" &&
        ["video", "note", "slides"].includes(segments[1].toLowerCase()) &&
        /^\d{1,25}$/.test(segments[2])
      ) {
        return {
          dedupeKey: `douyin:item:${segments[2]}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (host === "v.douyin.com" && segments.length >= 1) {
        return {
          dedupeKey: `douyin:short:${segments[0]}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "bilibili": {
      if (host === "b23.tv" || host.endsWith(".b23.tv")) {
        if (segments.length >= 1) {
          return {
            dedupeKey: `bilibili:short:${segments[0]}`,
            isLikelyFeedOrHome: false,
          };
        }
        return {
          dedupeKey: fallbackDedupeKey(platform, url),
          isLikelyFeedOrHome: true,
        };
      }
      if (
        segments.length >= 2 &&
        segments[0].toLowerCase() === "video" &&
        /^(?:BV[A-Za-z0-9]{10}|av\d+)$/i.test(segments[1])
      ) {
        const rawId = segments[1].toLowerCase().startsWith("bv")
          ? `BV${segments[1].slice(2)}`
          : segments[1].toLowerCase();
        const rawPage = url.searchParams.get("p")?.trim() ?? "";
        const page = /^[1-9]\d*$/.test(rawPage) ? rawPage : "1";
        return {
          dedupeKey: `bilibili:video:${rawId}:p=${page}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "xiaohongshu": {
      if (host === "xhslink.com" || host.endsWith(".xhslink.com")) {
        if (segments.length >= 1) {
          return {
            dedupeKey: `xiaohongshu:short:${segments.join("/")}`,
            isLikelyFeedOrHome: false,
          };
        }
        return {
          dedupeKey: fallbackDedupeKey(platform, url),
          isLikelyFeedOrHome: true,
        };
      }
      // /explore/<noteId> or /discovery/item/<noteId> or /user/profile/<uid>/<noteId>
      let noteId = "";
      if (segments.length >= 2 && segments[0] === "explore") {
        noteId = segments[1];
      } else if (
        segments.length >= 3 &&
        segments[0] === "discovery" &&
        segments[1] === "item"
      ) {
        noteId = segments[2];
      } else if (
        segments.length >= 4 &&
        segments[0] === "user" &&
        segments[1] === "profile"
      ) {
        noteId = segments[3];
      }
      if (/^[A-Za-z0-9_-]{4,40}$/.test(noteId)) {
        return {
          dedupeKey: `xiaohongshu:note:${noteId}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "weibo": {
      const fidParam = url.searchParams.get("fid")?.trim() ?? "";
      if (/^\d{1,8}:(?:\d{16,24}|[a-fA-F0-9]{32})$/.test(fidParam)) {
        return {
          dedupeKey: `weibo:video:${fidParam}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length >= 3 &&
        segments[0] === "tv" &&
        (segments[1] === "show" || segments[1] === "v")
      ) {
        return {
          dedupeKey: `weibo:video:${segments[2]}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length === 2 &&
        (segments[0] === "status" ||
          segments[0] === "detail" ||
          /^\d+$/.test(segments[0])) &&
        /^[A-Za-z0-9]{1,32}$/.test(segments[1])
      ) {
        return {
          dedupeKey: `weibo:status:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "x": {
      if (host === "t.co" || host.endsWith(".t.co")) {
        if (segments.length >= 1) {
          return {
            dedupeKey: `x:short:${segments[0]}`,
            isLikelyFeedOrHome: false,
          };
        }
        return {
          dedupeKey: fallbackDedupeKey(platform, url),
          isLikelyFeedOrHome: true,
        };
      }
      const statusIdx = segments.findIndex(
        (seg) => seg.toLowerCase() === "status",
      );
      if (
        statusIdx >= 1 &&
        segments[statusIdx + 1] &&
        /^\d{1,25}$/.test(segments[statusIdx + 1])
      ) {
        return {
          dedupeKey: `x:status:${segments[statusIdx + 1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "instagram": {
      const kinds = new Set(["p", "reel", "reels", "tv"]);
      let shortcode = "";
      if (segments.length >= 2 && kinds.has(segments[0].toLowerCase())) {
        shortcode = segments[1];
      } else if (
        segments.length >= 3 &&
        kinds.has(segments[1].toLowerCase())
      ) {
        shortcode = segments[2];
      }
      if (/^[A-Za-z0-9_-]{3,40}$/.test(shortcode)) {
        return {
          dedupeKey: `instagram:post:${shortcode}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "kuaishou": {
      if (
        segments.length >= 2 &&
        segments[0] === "short-video" &&
        /^[A-Za-z0-9_-]+$/.test(segments[1])
      ) {
        return {
          dedupeKey: `kuaishou:item:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length >= 3 &&
        segments[0] === "fw" &&
        segments[1] === "photo" &&
        /^[A-Za-z0-9_-]+$/.test(segments[2])
      ) {
        return {
          dedupeKey: `kuaishou:item:${segments[2]}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length >= 2 &&
        (segments[0] === "f" || segments[0] === "s") &&
        /^[A-Za-z0-9_-]+$/.test(segments[1])
      ) {
        return {
          dedupeKey: `kuaishou:share:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: true,
      };
    }

    case "toutiao": {
      if (
        segments.length >= 2 &&
        ["video", "article", "w", "item", "group"].includes(
          segments[0].toLowerCase(),
        ) &&
        /^\d{1,25}$/.test(segments[1])
      ) {
        return {
          dedupeKey: `toutiao:item:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (segments.length >= 1 && /^[ai]\d{1,25}$/i.test(segments[0])) {
        return {
          dedupeKey: `toutiao:item:${segments[0].slice(1)}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (host.endsWith("toutiaoimg.com") && segments.length >= 1) {
        return {
          dedupeKey: fallbackDedupeKey(platform, url),
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: segments.length === 0 || segments[0] === "ch",
      };
    }

    case "pipixia": {
      if (
        segments.length >= 2 &&
        (segments[0] === "item" ||
          (segments[0] === "ppx" && segments[1] === "item"))
      ) {
        const id = segments[0] === "ppx" ? segments[2] : segments[1];
        if (id && /^\d{1,25}$/.test(id)) {
          return {
            dedupeKey: `pipixia:item:${id}`,
            isLikelyFeedOrHome: false,
          };
        }
      }
      if (segments.length >= 2 && segments[0] === "s") {
        return {
          dedupeKey: `pipixia:short:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: segments.length === 0,
      };
    }

    case "pipigx": {
      const pid = url.searchParams.get("pid")?.trim() ?? "";
      if (/^\d{1,25}$/.test(pid)) {
        return {
          dedupeKey: `pipigx:post:${pid}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length >= 3 &&
        segments[0] === "pp" &&
        segments[1] === "post" &&
        /^\d{1,25}$/.test(segments[2])
      ) {
        return {
          dedupeKey: `pipigx:post:${segments[2]}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: segments.length === 0,
      };
    }

    case "zuiyou": {
      const pid = url.searchParams.get("pid")?.trim() ?? "";
      if (/^\d{1,25}$/.test(pid)) {
        return {
          dedupeKey: `zuiyou:post:${pid}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (
        segments.length >= 2 &&
        ["post", "detail"].includes(segments[0].toLowerCase()) &&
        /^\d{1,25}$/.test(segments[1])
      ) {
        return {
          dedupeKey: `zuiyou:post:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: segments.length === 0,
      };
    }

    case "facebook": {
      if (host === "fb.watch") {
        return {
          dedupeKey:
            segments.length >= 1
              ? `facebook:short:${segments[0]}`
              : fallbackDedupeKey(platform, url),
          isLikelyFeedOrHome: segments.length === 0,
        };
      }
      const watchV = url.searchParams.get("v")?.trim() ?? "";
      if (
        segments.length >= 1 &&
        segments[0].toLowerCase() === "watch" &&
        /^\d{1,25}$/.test(watchV)
      ) {
        return {
          dedupeKey: `facebook:video:${watchV}`,
          isLikelyFeedOrHome: false,
        };
      }
      const reelIdx = segments.findIndex((s) =>
        ["reel", "videos"].includes(s.toLowerCase()),
      );
      if (reelIdx >= 0 && segments[reelIdx + 1]) {
        return {
          dedupeKey: `facebook:video:${segments[reelIdx + 1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      const isFeed =
        segments.length === 0 ||
        segments[0].toLowerCase() === "home.php" ||
        (segments.length === 1 && segments[0].toLowerCase() === "watch" && !watchV);
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: isFeed,
      };
    }

    case "tumblr": {
      const postIdx = segments.findIndex((s) => s.toLowerCase() === "post");
      if (postIdx >= 0 && segments[postIdx + 1] && /^\d+$/.test(segments[postIdx + 1])) {
        return {
          dedupeKey: `tumblr:post:${segments[postIdx + 1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      if (segments.length >= 2 && /^\d{1,25}$/.test(segments[1])) {
        return {
          dedupeKey: `tumblr:post:${segments[1]}`,
          isLikelyFeedOrHome: false,
        };
      }
      const isFeed =
        segments.length === 0 ||
        ["dashboard", "explore", "following", "likes", "tagged", "search"].includes(
          segments[0].toLowerCase(),
        );
      return {
        dedupeKey: fallbackDedupeKey(platform, url),
        isLikelyFeedOrHome: isFeed,
      };
    }
  }
}

/**
 * Matches a candidate URL against the 14 supported platforms locally.
 * Returns `null` for any non-supported domain, internal browser URL, IP literal,
 * userinfo URL, non-standard port, or `snap.dokitool.com`.
 */
export function matchSupportedPlatformUrl(
  rawUrl: string,
): MatchedPlatformUrl | null {
  const parsed = validateAndParseHttpUrl(rawUrl);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  const spec = lookupPlatformSpec(host);
  if (!spec) return null;

  const details = analyzePlatformDetails(spec.id, parsed);
  return {
    platform: spec.id,
    platformLabel: spec.label,
    url: parsed.toString(),
    dedupeKey: details.dedupeKey,
    ...(details.youtubeVideoId ? { youtubeVideoId: details.youtubeVideoId } : {}),
    isLikelyFeedOrHome: details.isLikelyFeedOrHome,
  };
}

// Strict RFC 3986 ASCII URL token finder so trailing Chinese share text
// (e.g. `http://xhslink.com/o/ATlAvhS71F8，快来看`) cleanly stops at the URL boundary.
const EMBEDDED_URL_TOKEN_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)'"\]]+$/;

function cleanCandidateToken(token: string): string {
  return token.replace(TRAILING_PUNCTUATION_RE, "");
}

/**
 * Extracts and deduplicates all supported 14-platform URLs from multi-line text
 * or mixed Chinese/English share copy for the SidePanel batch queue.
 */
export function extractSupportedUrlsFromText(
  text: string,
): BatchUrlExtractResult {
  if (typeof text !== "string" || !text.trim()) {
    return { items: [], ignoredLineCount: 0, duplicateCount: 0 };
  }

  const items: MatchedPlatformUrl[] = [];
  const seenKeys = new Set<string>();
  let ignoredLineCount = 0;
  let duplicateCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const tokens = line.match(EMBEDDED_URL_TOKEN_RE);
    if (!tokens || tokens.length === 0) {
      ignoredLineCount++;
      continue;
    }

    let matchedAnyInLine = false;
    for (const rawToken of tokens) {
      const candidate = cleanCandidateToken(rawToken);
      const matched = matchSupportedPlatformUrl(candidate);
      if (!matched) continue;

      matchedAnyInLine = true;
      if (seenKeys.has(matched.dedupeKey)) {
        duplicateCount++;
      } else {
        seenKeys.add(matched.dedupeKey);
        items.push(matched);
      }
    }

    if (!matchedAnyInLine) {
      ignoredLineCount++;
    }
  }

  return { items, ignoredLineCount, duplicateCount };
}
