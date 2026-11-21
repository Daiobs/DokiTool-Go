// Explicit API & 14-platform media CDN host whitelist for the Chrome MV3 extension.
//
// Security invariants:
// - NEVER emit `<all_urls>`, `*://*/*`, `http://*/*`, or `https://*/*`.
// - Loopback origins (`http://127.0.0.1/*`, `http://localhost/*`) live ONLY in
//   `optional_host_permissions` by default and are merged into `host_permissions`
//   exclusively when `devLoopback: true` is passed for isolated headless testing.

export const PROD_API_ORIGIN = "https://snap.dokitool.com" as const;
export const PROD_API_HOST_PERMISSION = "https://snap.dokitool.com/*" as const;

export const FORBIDDEN_HOST_WILDCARDS = [
  "<all_urls>",
  "*://*/*",
  "http://*/*",
  "https://*/*",
] as const;

export const LOOPBACK_HOST_PERMISSIONS = [
  "http://127.0.0.1/*",
  "http://localhost/*",
] as const;

interface PlatformCdnGroup {
  readonly group: string;
  readonly httpsHosts: readonly string[];
  readonly httpHosts?: readonly string[];
}

// Audited across `backend/internal/platform/**`, `backend/internal/media/**`,
// `backend/testdata/**`, `scripts/prod-smoke/samples.json`, and
// `frontend/src/services/tbvideo.ts`.
const PLATFORM_CDN_GROUPS: readonly PlatformCdnGroup[] = [
  {
    group: "youtube",
    httpsHosts: [
      "youtube.com",
      "www.youtube.com",
      "*.youtube.com",
      "*.googlevideo.com",
      "*.ytimg.com",
      "*.ggpht.com",
      "*.googleusercontent.com",
    ],
  },
  {
    group: "bilibili",
    httpsHosts: [
      "*.bilivideo.com",
      "*.bilivideo.cn",
      "*.hdslb.com",
      "*.akamaized.net",
    ],
    httpHosts: [
      "*.bilivideo.com",
      "*.bilivideo.cn",
      "*.hdslb.com",
      "*.akamaized.net",
    ],
  },
  {
    group: "bytedance-douyin-toutiao-pipixia",
    httpsHosts: [
      "*.douyinvod.com",
      "*.douyinstatic.com",
      "*.zjcdn.com",
      "*.douyinpic.com",
      "*.byteimg.com",
      "*.toutiaovod.com",
      "*.toutiaoimg.com",
      "*.ixigua.com",
      "*.pstatp.com",
      "*.ppxvod.com",
      "*.pipix.com",
      "*.snssdk.com",
      "*.amemv.com",
      "*.ibytedtos.com",
      "*.bytedgame.com",
      "*.iesdouyin.com",
      "*.douyin.com",
      "*.toutiao.com",
    ],
    httpHosts: [
      "*.douyinvod.com",
      "*.douyinstatic.com",
      "*.zjcdn.com",
      "*.douyinpic.com",
      "*.byteimg.com",
      "*.toutiaovod.com",
      "*.toutiaoimg.com",
      "*.ixigua.com",
      "*.pstatp.com",
      "*.ppxvod.com",
      "*.pipix.com",
      "*.snssdk.com",
      "*.amemv.com",
      "*.ibytedtos.com",
      "*.bytedgame.com",
      "*.iesdouyin.com",
      "*.douyin.com",
      "*.toutiao.com",
    ],
  },
  {
    group: "weibo",
    httpsHosts: ["*.weibocdn.com", "*.sinaimg.cn"],
    httpHosts: ["*.weibocdn.com", "*.sinaimg.cn"],
  },
  {
    group: "xiaohongshu",
    httpsHosts: ["*.xhscdn.com", "*.rednotecdn.com", "ci.xiaohongshu.com"],
    httpHosts: ["*.xhscdn.com", "*.rednotecdn.com", "ci.xiaohongshu.com"],
  },
  {
    group: "kuaishou",
    httpsHosts: [
      "*.kwimgs.com",
      "*.yximgs.com",
      "*.kwaicdn.com",
      "*.kuaishou.com",
      "*.chenzhongtech.com",
    ],
    httpHosts: [
      "*.kwimgs.com",
      "*.yximgs.com",
      "*.kwaicdn.com",
      "*.kuaishou.com",
      "*.chenzhongtech.com",
    ],
  },
  {
    group: "zuiyou-pipigx",
    httpsHosts: [
      "*.izuiyou.com",
      "*.ixiaochuankeji.cn",
      "*.xiaochuankeji.cn",
      "*.ixiaochuan.cn",
      "*.ippzone.com",
      "*.pipigx.com",
      "*.szsttkj.com",
    ],
    httpHosts: [
      "*.izuiyou.com",
      "*.ixiaochuankeji.cn",
      "*.xiaochuankeji.cn",
      "*.ixiaochuan.cn",
      "*.ippzone.com",
      "*.pipigx.com",
      "*.szsttkj.com",
    ],
  },
  {
    group: "x",
    httpsHosts: ["*.twimg.com"],
    httpHosts: ["*.twimg.com"],
  },
  {
    group: "instagram-facebook",
    httpsHosts: ["*.cdninstagram.com", "*.fbcdn.net", "*.instagram.com"],
    httpHosts: ["*.cdninstagram.com", "*.fbcdn.net"],
  },
  {
    group: "tumblr",
    httpsHosts: ["*.media.tumblr.com", "*.tumblr.com"],
    httpHosts: ["*.media.tumblr.com"],
  },
] as const;

function buildProductionHostPermissions(): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (pattern: string) => {
    if ((FORBIDDEN_HOST_WILDCARDS as readonly string[]).includes(pattern)) {
      throw new Error(`Forbidden wildcard host permission: ${pattern}`);
    }
    if (!seen.has(pattern)) {
      seen.add(pattern);
      out.push(pattern);
    }
  };

  push(PROD_API_HOST_PERMISSION);
  for (const group of PLATFORM_CDN_GROUPS) {
    for (const host of group.httpsHosts) {
      push(`https://${host}/*`);
    }
    for (const host of group.httpHosts ?? []) {
      push(`http://${host}/*`);
    }
  }
  return Object.freeze(out);
}

export const PRODUCTION_HOST_PERMISSIONS: readonly string[] =
  buildProductionHostPermissions();

function buildCdnRequestDomains(): readonly string[] {
  const rawDomains: string[] = [];
  for (const group of PLATFORM_CDN_GROUPS) {
    for (const host of [...group.httpsHosts, ...(group.httpHosts ?? [])]) {
      const stripped = host.startsWith("*.") ? host.slice(2) : host;
      rawDomains.push(stripped.toLowerCase());
    }
  }
  // Deduplicate and collapse strict subdomains when their parent apex domain is already listed
  // (e.g., `www.youtube.com` -> `youtube.com`, `media.tumblr.com` -> `tumblr.com`).
  const unique = Array.from(new Set(rawDomains));
  const uniqueSet = new Set(unique);
  const deduped = unique.filter((domain) => {
    const parts = domain.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join(".");
      if (uniqueSet.has(parent)) {
        return false;
      }
    }
    return true;
  });
  return Object.freeze(deduped);
}

/** Deduplicated CDN domains suitable for Chrome DNR `condition.requestDomains`. */
export const CDN_REQUEST_DOMAINS: readonly string[] = buildCdnRequestDomains();

export interface ManifestHostPermissions {
  host_permissions: string[];
  optional_host_permissions: string[];
}

export function buildManifestHostPermissions(options?: {
  devLoopback?: boolean;
}): ManifestHostPermissions {
  const devLoopback = options?.devLoopback === true;
  if (devLoopback) {
    return {
      host_permissions: [
        ...PRODUCTION_HOST_PERMISSIONS,
        ...LOOPBACK_HOST_PERMISSIONS,
      ],
      optional_host_permissions: [],
    };
  }
  return {
    host_permissions: [...PRODUCTION_HOST_PERMISSIONS],
    optional_host_permissions: [...LOOPBACK_HOST_PERMISSIONS],
  };
}

interface ParsedMatchRule {
  scheme: "http:" | "https:";
  host: string;
  allowSubdomains: boolean;
}

const PARSED_PRODUCTION_RULES: readonly ParsedMatchRule[] =
  PRODUCTION_HOST_PERMISSIONS.map((pattern) => {
    const match = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)\/\*$/.exec(pattern);
    if (!match) {
      throw new Error(`Invalid host permission pattern: ${pattern}`);
    }
    return {
      scheme: `${match[1]}:` as "http:" | "https:",
      host: match[3].toLowerCase(),
      allowSubdomains: Boolean(match[2]),
    };
  });

const VALID_DNS_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const PUBLIC_DOMAIN_WITH_ALPHA_TLD =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

function hasUnsafeUrlChars(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c /* '\\' */) {
      return true;
    }
  }
  return false;
}

function isIpv4Literal(host: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return true;
  }
  // Catch integer/hex/octal single-label or dotted numeric IPv4 forms normalized by WHATWG URL
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) {
    return true;
  }
  return false;
}

function isPrivateOrReservedHost(host: string): boolean {
  if (!host) return true;
  if (host.startsWith("[") || host.includes(":")) {
    return true; // Reject all IPv6 literals
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (isIpv4Literal(host)) {
    return true;
  }
  return false;
}

function hasRawEmptyPort(raw: string): boolean {
  const schemeIdx = raw.indexOf("://");
  if (schemeIdx < 0) return false;
  const rest = raw.slice(schemeIdx + 3);
  const slashIdx = rest.search(/[/?#]/);
  const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  return authority.endsWith(":");
}

export interface ApiBaseUrlValidationResult {
  ok: boolean;
  origin: string;
  isLoopback: boolean;
  error?: string;
}

/**
 * Validates user-configured backend API base URL.
 * Accepts ONLY:
 * - `https://<public-domain>[:port]`
 * - `http://127.0.0.1[:port]` or `http://localhost[:port]`
 * Strips a single trailing `/`; rejects paths, queries, fragments, userinfo, and private LAN IPs.
 */
export function validateApiBaseUrl(rawUrl: string): ApiBaseUrlValidationResult {
  if (typeof rawUrl !== "string") {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址不能为空",
    };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址不能为空",
    };
  }
  if (trimmed.length > 512 || hasUnsafeUrlChars(trimmed) || hasRawEmptyPort(trimmed)) {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址包含非法字符或端口格式无效",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址格式无效",
    };
  }

  if (parsed.username || parsed.password || trimmed.includes("@")) {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址不允许包含账号密码信息",
    };
  }

  if (parsed.search || parsed.hash || trimmed.includes("?") || trimmed.includes("#")) {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址不允许包含查询参数或锚点",
    };
  }

  // Reject any path other than empty or single trailing `/` (also reject `//` path)
  const schemeEnd = trimmed.indexOf("://") + 3;
  const slashPos = trimmed.indexOf("/", schemeEnd);
  if (slashPos >= 0 && trimmed.slice(slashPos) !== "/") {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址仅填写域名与端口，请勿包含子路径",
    };
  }

  if (parsed.port !== "") {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return {
        ok: false,
        origin: "",
        isLoopback: false,
        error: "后端地址端口超出合法范围（1–65535）",
      };
    }
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopbackHost = hostname === "127.0.0.1" || hostname === "localhost";

  if (parsed.protocol === "http:") {
    if (!isLoopbackHost) {
      return {
        ok: false,
        origin: "",
        isLoopback: false,
        error: "非本机回环地址必须使用 https:// 协议",
      };
    }
    return {
      ok: true,
      origin: parsed.origin,
      isLoopback: true,
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "仅支持 https:// 域名或本机 http://127.0.0.1 / http://localhost",
    };
  }

  if (isLoopbackHost || isPrivateOrReservedHost(hostname)) {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址不支持内网 IP 或非公开域名，回环调试请使用 http://127.0.0.1 或 http://localhost",
    };
  }

  if (!PUBLIC_DOMAIN_WITH_ALPHA_TLD.test(hostname)) {
    return {
      ok: false,
      origin: "",
      isLoopback: false,
      error: "后端地址必须是合法的公开域名",
    };
  }

  return {
    ok: true,
    origin: parsed.origin,
    isLoopback: false,
  };
}

export interface MediaWhitelistCheckResult {
  allowed: boolean;
  hostname: string;
  reason?: string;
}

function matchesExtraOrigin(url: URL, rawExtra: string): boolean {
  const trimmed = rawExtra.trim();
  if (!trimmed) return false;
  if (trimmed === "http://127.0.0.1/*") {
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  }
  if (trimmed === "http://localhost/*") {
    return url.protocol === "http:" && url.hostname.toLowerCase() === "localhost";
  }
  const validated = validateApiBaseUrl(trimmed);
  if (!validated.ok) return false;
  return url.origin.toLowerCase() === validated.origin.toLowerCase();
}

/**
 * Checks whether a media/cover/relay URL is permitted to be fetched by the extension
 * under `PRODUCTION_HOST_PERMISSIONS` (or an explicitly supplied `extraAllowedOrigins`
 * entry such as a user-configured custom API origin or authorized loopback test origin).
 */
export function isWhitelistedMediaUrl(
  rawUrl: string,
  extraAllowedOrigins?: string[],
): MediaWhitelistCheckResult {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { allowed: false, hostname: "", reason: "媒体链接为空" };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 8192 || hasUnsafeUrlChars(trimmed) || hasRawEmptyPort(trimmed)) {
    return { allowed: false, hostname: "", reason: "媒体链接包含非法字符" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, hostname: "", reason: "媒体链接格式无效" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { allowed: false, hostname: "", reason: "媒体链接缺少主机名" };
  }

  if (parsed.username || parsed.password || trimmed.includes("@")) {
    return { allowed: false, hostname, reason: "媒体链接不允许包含凭据信息" };
  }

  if (parsed.hash || trimmed.includes("#")) {
    return { allowed: false, hostname, reason: "媒体链接不允许包含片段锚点" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { allowed: false, hostname, reason: "仅允许 HTTP/HTTPS 媒体链接" };
  }

  if (Array.isArray(extraAllowedOrigins)) {
    for (const extra of extraAllowedOrigins) {
      if (typeof extra === "string" && matchesExtraOrigin(parsed, extra)) {
        return { allowed: true, hostname };
      }
    }
  }

  if (parsed.port !== "") {
    return {
      allowed: false,
      hostname,
      reason: `媒体链接不允许非标准端口（:${parsed.port}）`,
    };
  }

  if (!VALID_DNS_HOSTNAME.test(hostname) || isIpv4Literal(hostname)) {
    return {
      allowed: false,
      hostname,
      reason: `域名 ${hostname} 不在扩展安全白名单内`,
    };
  }

  for (const rule of PARSED_PRODUCTION_RULES) {
    if (parsed.protocol !== rule.scheme) continue;
    if (hostname === rule.host) {
      return { allowed: true, hostname };
    }
    if (rule.allowSubdomains && hostname.endsWith(`.${rule.host}`)) {
      return { allowed: true, hostname };
    }
  }

  return {
    allowed: false,
    hostname,
    reason: `媒体域名 ${hostname} 未收录于扩展白名单`,
  };
}
