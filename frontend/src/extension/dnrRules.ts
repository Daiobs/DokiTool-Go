import { CDN_REQUEST_DOMAINS, validateApiBaseUrl } from "./hostWhitelist";

/**
 * Smart-TV Tizen User-Agent matching `frontend/src/utils/youtubeHelperCore.js:1469`.
 */
export const YOUTUBE_TVHTML5_USER_AGENT =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1" as const;

export const EXTENSION_DNR_RULE_IDS = [
  1001,
  1002,
  1003,
  1004,
  1005,
  1006,
  1007,
  1008,
  1009,
] as const;

export type DnrResourceType = "xmlhttprequest" | "media" | "image";

export type DnrModifyHeaderInfo =
  | {
      header: string;
      operation: "set";
      value: string;
    }
  | {
      header: string;
      operation: "remove";
    };

export interface ExtensionDnrRule {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: DnrModifyHeaderInfo[];
  };
  condition: {
    initiatorDomains: [string];
    urlFilter?: string;
    requestDomains?: string[];
    resourceTypes: DnrResourceType[];
  };
}

const SAFE_EXTENSION_ID_PATTERN = /^[a-z0-9_-]+$/;

const RULE_1002_YOUTUBE_DOMAINS = [
  "googlevideo.com",
  "youtube.com",
  "ytimg.com",
  "ggpht.com",
  "googleusercontent.com",
] as const;

const RULE_1003_WEIBO_DOMAINS = ["weibocdn.com", "sinaimg.cn"] as const;

const RULE_1004_BILIBILI_DOMAINS = [
  "bilivideo.com",
  "bilivideo.cn",
  "hdslb.com",
] as const;

const RULE_1009_TIKTOK_DOMAINS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokv.com",
] as const;

/**
 * Narrow Bilibili overseas Akamai UPOS matchers (Guardrail G1).
 * Kept strictly isomorphic with `isBilibiliAkamaiMediaUrl` in
 * `frontend/src/core/media/cdnTransportHints.ts` and
 * `backend/internal/platform/bilibili/adapter.go` so public Akamai CDNs
 * (e.g. Vimeo `vod-progressive.akamaized.net`, Facebook, Tumblr) fall through
 * to Rule 1005 (Origin/Cookie stripped, zero Bilibili Referer injected).
 */
const RULE_1006_1008_BILIBILI_AKAMAI_RULES = [
  { id: 1006, urlFilter: "||upos-*.akamaized.net/" },
  { id: 1007, urlFilter: "://*bili*.akamaized.net/" },
  { id: 1008, urlFilter: "/upgcxcode/" },
] as const;

const BILIBILI_REQUEST_HEADERS: DnrModifyHeaderInfo[] = [
  {
    header: "Referer",
    operation: "set",
    value: "https://www.bilibili.com/",
  },
  { header: "Origin", operation: "remove" },
  { header: "Cookie", operation: "remove" },
];

const SPECIALIZED_RULE_DOMAINS = new Set<string>([
  ...RULE_1002_YOUTUBE_DOMAINS,
  ...RULE_1003_WEIBO_DOMAINS,
  ...RULE_1004_BILIBILI_DOMAINS,
  ...RULE_1009_TIKTOK_DOMAINS,
]);

export interface BuildExtensionDnrRulesOptions {
  extraApiOrigins?: string[];
}

/**
 * Pure builder for Chrome MV3 `declarativeNetRequest.updateDynamicRules`.
 * Every rule strictly pins `condition.initiatorDomains: [extensionId]` so normal
 * browser tab traffic is never touched.
 */
export function buildExtensionDnrRules(
  extensionId: string,
  options?: BuildExtensionDnrRulesOptions,
): ExtensionDnrRule[] {
  if (
    typeof extensionId !== "string" ||
    !extensionId ||
    !SAFE_EXTENSION_ID_PATTERN.test(extensionId)
  ) {
    throw new Error("Invalid extensionId for DNR rules");
  }

  const remainingDomains: string[] = [];
  const seenRemaining = new Set<string>();
  const addRemainingDomain = (domain: string) => {
    const normalized = domain.trim().toLowerCase();
    if (
      !normalized ||
      SPECIALIZED_RULE_DOMAINS.has(normalized) ||
      seenRemaining.has(normalized)
    ) {
      return;
    }
    seenRemaining.add(normalized);
    remainingDomains.push(normalized);
  };

  for (const domain of CDN_REQUEST_DOMAINS) {
    addRemainingDomain(domain);
  }
  addRemainingDomain("snap.dokitool.com");
  addRemainingDomain("127.0.0.1");
  addRemainingDomain("localhost");

  for (const rawOrigin of options?.extraApiOrigins ?? []) {
    if (typeof rawOrigin !== "string") continue;
    const check = validateApiBaseUrl(rawOrigin);
    if (check.ok && !check.isLoopback) {
      const host = new URL(check.origin).hostname.toLowerCase();
      addRemainingDomain(host);
    }
  }

  return [
    {
      id: 1001,
      priority: 3,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "User-Agent",
            operation: "set",
            value: YOUTUBE_TVHTML5_USER_AGENT,
          },
          {
            header: "Origin",
            operation: "set",
            value: "https://www.youtube.com",
          },
          {
            header: "Referer",
            operation: "set",
            value: "https://www.youtube.com/tv",
          },
          {
            header: "Cookie",
            operation: "remove",
          },
        ],
      },
      condition: {
        initiatorDomains: [extensionId],
        urlFilter: "||www.youtube.com/youtubei/v1/player",
        resourceTypes: ["xmlhttprequest"],
      },
    },
    {
      id: 1002,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "remove" },
          { header: "Cookie", operation: "remove" },
        ],
      },
      condition: {
        initiatorDomains: [extensionId],
        requestDomains: [...RULE_1002_YOUTUBE_DOMAINS],
        resourceTypes: ["xmlhttprequest", "media", "image"],
      },
    },
    {
      id: 1003,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Referer",
            operation: "set",
            value: "https://weibo.com/",
          },
          { header: "Origin", operation: "remove" },
          { header: "Cookie", operation: "remove" },
        ],
      },
      condition: {
        initiatorDomains: [extensionId],
        requestDomains: [...RULE_1003_WEIBO_DOMAINS],
        resourceTypes: ["xmlhttprequest", "media", "image"],
      },
    },
    {
      id: 1004,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: BILIBILI_REQUEST_HEADERS.map((item) => ({ ...item })),
      },
      condition: {
        initiatorDomains: [extensionId],
        requestDomains: [...RULE_1004_BILIBILI_DOMAINS],
        resourceTypes: ["xmlhttprequest", "media", "image"],
      },
    },
    {
      id: 1005,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "remove" },
          { header: "Cookie", operation: "remove" },
        ],
      },
      condition: {
        initiatorDomains: [extensionId],
        requestDomains: remainingDomains,
        resourceTypes: ["xmlhttprequest", "media", "image"],
      },
    },
    ...RULE_1006_1008_BILIBILI_AKAMAI_RULES.map(
      ({ id, urlFilter }): ExtensionDnrRule => ({
        id,
        priority: 3,
        action: {
          type: "modifyHeaders",
          requestHeaders: BILIBILI_REQUEST_HEADERS.map((item) => ({ ...item })),
        },
        condition: {
          initiatorDomains: [extensionId],
          requestDomains: ["akamaized.net"],
          urlFilter,
          resourceTypes: ["xmlhttprequest", "media", "image"],
        },
      }),
    ),
    {
      id: 1009,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Referer",
            operation: "set",
            value: "https://www.tiktok.com/",
          },
          { header: "Origin", operation: "remove" },
          { header: "Cookie", operation: "remove" },
        ],
      },
      condition: {
        initiatorDomains: [extensionId],
        requestDomains: [...RULE_1009_TIKTOK_DOMAINS],
        resourceTypes: ["xmlhttprequest", "media", "image"],
      },
    },
  ];
}
