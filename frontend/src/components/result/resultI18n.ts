const content: Record<string, Record<string, string>> = {
  "zh-CN": {
    resultTitle: "解析结果",
    sourceHint: "当前使用源链接直连播放与下载",
    relaySourceHint: "当前通过本站媒体服务播放与下载",
    playbackFailed: "该视频源无法在本站直接播放，可尝试其他画质或打开原作品。",
    openOriginal: "打开原作品",
    downloadSingle: "下载视频",
    downloadWithAudio: "下载有声视频",
    downloadTierWithAudio: "下载 {tier} 有声视频",
    downloadAudio: "下载音频",
    downloadAudioFormat: "下载音频 ({format})",
    downloadLive: "下载实况",
    downloadAll: "下载全部",
    downloadSelected: "下载选中",
    downloadAllVideos: "下载全部",
    downloadSelectedZip: "选中打包ZIP",
    downloadAllZip: "全部打包ZIP",
    resolving: "解析中…",
    episodes: "分集",
    collections: "合集",
    copyVideo: "复制链接",
    backupTitle: "备用画质",
    unknown: "未知",
    allImages: "下载全部图片",
    downloadAllLive: "下载全部实况",
    downloadAllCovers: "下载全部封面",
    musicTitle: "背景音乐",
    unknownMusic: "未知音乐",
    unknownAuthor: "未知作者",
    liveVideo: "实况",
    infoTitle: "作品标题",
    unknownTitle: "未知标题",
    publishTime: "发布时间",
    unknownTime: "未知时间",
    type: "作品类型",
    video: "视频",
    images: "图片集",
    live: "实况",
    collection: "合集",
    unknownType: "未知",
    quality: "画质",
    duration: "时长",
    unknownQuality: "未知",
    overlayVideo: "下载视频",
    overlayCover: "下载封面",
    infoLikes: "获赞 {count}",
    copied: "已复制",
    copiedHint: "链接已复制到剪贴板",
    statPlay: "播放",
    statLike: "点赞",
    statComment: "评论",
    statCollect: "收藏",
    statShare: "分享",
    tabInfo: "详情",
    tabStats: "数据",
    tabTags: "标签",
    tabMusic: "音乐",
    tabBackup: "画质选项",
    imagesTitle: "图片集",
    imagesCount: "{count} 张",
    liveCount: "{count} 组",
    bitRate: "码率",
    codec: "编码",
    resolution: "分辨率",
    currentPlaying: "当前已选",
    preview: "预览",
    close: "关闭",
    page: "页",
    videoSource: "视频源",
    imageSource: "图片来源",
    liveSource: "实况来源",
    noBackups: "暂无备用画质",
    selectQuality: "选择画质",
    selectQualityFirst: "请先选择画质",
    biliDashTitle: "检测到更高画质 B 站 DASH（共 {count} 档）",
    biliDashTitleOne: "检测到更高画质 B 站 DASH（共 1 档）",
    biliDashUpTo: "最高 {res}",
    biliDashHint:
      "网页版继续保留直连 MP4 即时预览与下载；安装 DokiTool Chrome 扩展即可零 Cookie 本地无损合流下载高码率 DASH。",
    biliDashCta: "安装 Chrome 扩展无损下载",
    biliDashBadge: "高码率 · 需 Chrome 扩展",
    biliDashSummaryAll: "高码率 DASH 档位 · 需 Chrome 扩展 ({count})",
    biliDashSummaryMixed: "其他版本 · 含高码率 DASH ({count})",
    biliDashMuxExplain:
      "该高码率 DASH 档位需附带 B 站来源头并本地无损合流，安装 DokiTool Chrome 扩展即可一键保存",
    biliDashOpenGuide: "打开扩展安装指引",
    biliDashMuxCap: "DASH 无损合流",
  },
  en: {
    resultTitle: "Result",
    sourceHint: "Using direct source link",
    relaySourceHint: "Playback and downloads use this site’s media service",
    playbackFailed:
      "This source cannot play directly here. Try another quality or open the original post.",
    openOriginal: "Open original post",
    downloadSingle: "Download Video",
    downloadWithAudio: "Download Video with Audio",
    downloadTierWithAudio: "Download {tier} Video with Audio",
    downloadAudio: "Download Audio",
    downloadAudioFormat: "Download Audio ({format})",
    downloadLive: "Download Live",
    downloadAll: "Download All",
    downloadSelected: "Download Selected",
    downloadAllVideos: "Download All",
    downloadSelectedZip: "Selected as ZIP",
    downloadAllZip: "All as ZIP",
    resolving: "Resolving…",
    episodes: "Episodes",
    collections: "Collections",
    copyVideo: "Copy URL",
    backupTitle: "Backup Quality",
    unknown: "Unknown",
    allImages: "Download Images",
    downloadAllLive: "Download All Live",
    downloadAllCovers: "Download All Covers",
    musicTitle: "Background Music",
    unknownMusic: "Unknown Music",
    unknownAuthor: "Unknown Artist",
    liveVideo: "Live",
    infoTitle: "Title",
    unknownTitle: "Unknown Title",
    publishTime: "Published",
    unknownTime: "Unknown",
    type: "Type",
    video: "Video",
    images: "Album",
    live: "Live",
    collection: "Collection",
    unknownType: "Unknown",
    quality: "Quality",
    duration: "Duration",
    unknownQuality: "Unknown",
    overlayVideo: "Download Video",
    overlayCover: "Download Cover",
    infoLikes: "{count} likes",
    copied: "Copied",
    copiedHint: "URL copied to clipboard",
    statPlay: "Plays",
    statLike: "Likes",
    statComment: "Comments",
    statCollect: "Favorites",
    statShare: "Shares",
    tabInfo: "Details",
    tabStats: "Stats",
    tabTags: "Tags",
    tabMusic: "Music",
    tabBackup: "Quality",
    imagesTitle: "Album",
    imagesCount: "{count} images",
    liveCount: "{count} groups",
    bitRate: "Bitrate",
    codec: "Codec",
    resolution: "Resolution",
    currentPlaying: "Selected",
    preview: "Preview",
    close: "Close",
    page: "page",
    videoSource: "Video Source",
    imageSource: "Image Source",
    liveSource: "Live Source",
    noBackups: "No backup qualities",
    selectQuality: "Select Quality",
    selectQualityFirst: "Select Quality First",
    biliDashTitle: "Higher-Bitrate Bilibili DASH Available ({count} tiers)",
    biliDashTitleOne: "Higher-Bitrate Bilibili DASH Available (1 tier)",
    biliDashUpTo: "Up to {res}",
    biliDashHint:
      "Direct MP4 preview and download stay ready here. Install the DokiTool Chrome Extension for cookie-free local lossless DASH muxing.",
    biliDashCta: "Get Chrome Extension for Lossless DASH",
    biliDashBadge: "High-Bitrate · Chrome Ext",
    biliDashSummaryAll: "High-Bitrate DASH · Chrome Extension ({count})",
    biliDashSummaryMixed: "Other versions · incl. DASH ({count})",
    biliDashMuxExplain:
      "This high-bitrate DASH tier requires Bilibili referer headers and local lossless muxing. Install the DokiTool Chrome Extension to save it in one click.",
    biliDashOpenGuide: "Open Extension Guide",
    biliDashMuxCap: "DASH Lossless Mux",
  },
};

export const t = (locale: string | undefined, key: string): string =>
  (locale && content[locale]?.[key]) || content["zh-CN"][key] || key;

export const formatDate = (timestamp: unknown): string => {
  if (!timestamp) return "";
  const numeric =
    typeof timestamp === "number" || /^\d+(\.\d+)?$/.test(String(timestamp));
  const value = numeric
    ? Number(timestamp) * (Number(timestamp) < 1e12 ? 1000 : 1)
    : String(timestamp).replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  const date = new Date(value);
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
  return `${y}-${m}-${d} ${time}`;
};

const SILENT_ONLY_PART_RE =
  /^(?:仅视频(?:无声)?|无声视频|无音频|无声|video[\s-]*only(?:\s*,?\s*no\s+audio|\s+silent)?|silent(?:\s+video)?(?:\s+only)?|without\s+audio|no\s+audio|no\s+sound|muted)$/i;

export const stripSilentOnlyNotice = (label: unknown): string => {
  if (typeof label !== "string" || !label) return "";
  const cleanedParens = label.replace(
    /\s*([（(])([^()（）]*)([)）])/g,
    (_match, open, inner, close) => {
      const parts = String(inner)
        .split(/\s*[·•,，]\s*/)
        .map((p) => p.trim())
        .filter((p) => p && !SILENT_ONLY_PART_RE.test(p));
      if (!parts.length) return "";
      return open === "（" && close === "）"
        ? `（${parts.join(" · ")}）`
        : ` (${parts.join(" · ")})`;
    },
  );
  return cleanedParens
    .replace(
      /\s*[·•]\s*(?:仅视频(?:无声)?|无声视频|无音频|无声|video[\s-]*only(?:\s*,?\s*no\s+audio|\s+silent)?|silent(?:\s+video)?(?:\s+only)?|without\s+audio|no\s+audio|no\s+sound|muted)\s*$/i,
      "",
    )
    .trim();
};

export const parsePositiveSafeBytes = (raw: unknown): number => {
  const n =
    typeof raw === "number" || (typeof raw === "string" && raw.trim())
      ? Number(raw)
      : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export const resolveVariantDimensions = (variant: any) => {
  const meta = variant?.state === "deferred" ? undefined : variant?.metadata;
  const w = Number(meta?.width) || 0;
  const h = Number(meta?.height) || 0;
  const shortEdge = w > 0 && h > 0 ? Math.min(w, h) : h || w;
  const longEdge = Math.max(w, h);
  return { w, h, shortEdge, longEdge };
};

export const resolveYouTubeHighResTier = (variant: any): string => {
  const { shortEdge, longEdge } = resolveVariantDimensions(variant);
  if (shortEdge >= 4320 || longEdge >= 7680) return "8K";
  if (shortEdge >= 2160 || longEdge >= 3840) return "4K";
  if (shortEdge >= 1440 || longEdge >= 2560) return "2K";
  return "";
};

export const resolveYouTubeDownloadTier = (variant: any): string => {
  if (!variant) return "";
  const rawLabel = typeof variant.label === "string" ? variant.label.trim() : "";
  const { shortEdge, longEdge } = resolveVariantDimensions(variant);
  if (/\b8k\b/i.test(rawLabel) || shortEdge >= 4320 || longEdge >= 7680) {
    return "8K";
  }
  if (/\b4k\b/i.test(rawLabel) || shortEdge >= 2160 || longEdge >= 3840) {
    return "4K";
  }
  if (/\b2k\b/i.test(rawLabel) || shortEdge >= 1440 || longEdge >= 2560) {
    return "2K";
  }
  if (shortEdge === 1080 || longEdge === 1920) return "1080p";
  if (shortEdge === 720 || longEdge === 1280) return "720p";
  if (shortEdge === 480 || longEdge === 854) return "480p";
  if (shortEdge === 360 || longEdge === 640) return "360p";
  if (shortEdge === 240 || longEdge === 426) return "240p";
  if (shortEdge === 144 || longEdge === 256) return "144p";
  const pMatch = /\b(\d{3,4})p(?:\d{2,3})?\b/i.exec(rawLabel);
  if (pMatch) {
    const hVal = Number(pMatch[1]);
    if (hVal >= 4320) return "8K";
    if (hVal >= 2160) return "4K";
    if (hVal >= 1440) return "2K";
    if (hVal > 0) return `${hVal}p`;
  }
  if (shortEdge > 0) return `${shortEdge}p`;
  return "";
};

export const resolveYouTubeAudioFormatLabel = (variant: any): string => {
  const meta = variant?.state === "deferred" ? undefined : variant?.metadata;
  const ext = String(meta?.extension || meta?.container || "")
    .trim()
    .toLowerCase();
  const rawLabel = String(variant?.label || "");
  if (ext === "m4a" || ext === "mp4" || /\bm4a\b/i.test(rawLabel)) {
    return "M4A";
  }
  if (ext === "webm" || /\bwebm\b/i.test(rawLabel)) {
    return "WEBM";
  }
  return "";
};

export const qualityBitrates = (
  metadata: Record<string, any> = {},
  locale?: string,
) =>
  [
    { key: "bitrate_bps", label: locale === "en" ? "Total" : "总码率" },
    {
      key: "video_bitrate_bps",
      label: locale === "en" ? "Video" : "视频码率",
    },
    {
      key: "audio_bitrate_bps",
      label: locale === "en" ? "Audio" : "音频码率",
    },
  ]
    .filter((rate) => metadata[rate.key] > 0)
    .map((rate) => ({ ...rate, value: metadata[rate.key] }));

export const formatBitrate = (val: unknown): string => {
  const n = Number(val || 0);
  if (n <= 0) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + " Mbps";
  if (n >= 1000) return (n / 1000).toFixed(0) + " Kbps";
  return n + " bps";
};
