/* Download-only service worker. It never caches or intercepts the application/API. */
import { createTaskStore, HISTORY_MS } from "./task-store.js";
import { attachmentFormat, cleanFilename } from "./media-format.js";
import { decodedLength } from "./decoded-length.js";
import { readCandidate, validCandidate, reportTbvideo } from "./tbvideo.js";
const PROTOCOL = 1;
const BUILD = "downloads-20261124.1";
const INSTANCE = crypto.randomUUID();
const store = createTaskStore();
const MAX_ACTIVE = 2;
const IDLE_MS = 45_000;
// Bound attachment-response preparation below browser extended-event limits.
// Legacy clients also queue inside that response; admission-aware clients do not.
const RESPONSE_MS = 120_000;
const STALLED_MS = 15_000;
const SPEED_WINDOW_MS = 2000;
const CLAIM_MS = 60_000;
const RETAIN_MS = HISTORY_MS;
const RANGE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const RANGE_INITIAL_CHUNK_BYTES = 512 * 1024;
const RANGE_CHUNK_SIZE = 1 * 1024 * 1024;
const MAX_RANGE_CONCURRENCY = 4;
const MAX_WINDOW_CHUNKS = 4;
const RANGE_DELIVER_SLICE_BYTES = 256 * 1024;
const MAX_RANGE_CHUNK_RETRIES = 2;
const RANGE_PROBE_WAIT_MS = 1500;
const WORKER_CONTROL_CHANNEL = "dokitool-download-worker-control";
const WORKER_IDLE_PROBE_MS = 80;
const tasks = new Map();
const history = new Map();
const queue = [];
let active = 0;
let historyTimer;
let isActivated = false;
let waitingToActivate = false;
const controlChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(WORKER_CONTROL_CHANNEL) : null;

function isCurrentActiveWorker() {
  if (self.serviceWorker && typeof self.serviceWorker.state === "string") {
    return self.serviceWorker.state === "activated" || self.serviceWorker.state === "activating";
  }
  return isActivated;
}

async function hasControlledDownloadClients() {
  if (typeof self.clients?.matchAll !== "function") return false;
  try {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return list.some(client => {
      try {
        const u = new URL(client.url);
        return u.origin === self.location.origin && u.pathname.startsWith("/downloads/");
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
}

async function canSafelySkipWaiting() {
  if (tasks.size > 0 || queue.length > 0) return false;
  if (await hasControlledDownloadClients()) return false;
  if (!controlChannel) return true;
  // No `/downloads/` bridge document is mounted, but an active worker may still
  // be streaming a background attachment download after the tab closed.
  // Probe live peers over BroadcastChannel for a short window; any awake worker
  // still streaming a task replies immediately with activeTasks > 0.
  const hasBusyPeer = await new Promise(resolve => {
    const probeId = crypto.randomUUID();
    let settled = false;
    const finish = busy => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controlChannel.removeEventListener("message", onReply);
      resolve(busy);
    };
    const onReply = event => {
      const data = event.data;
      if (!data || data.type !== "idle-reply" || data.probeId !== probeId || data.from === INSTANCE) return;
      if (Number(data.activeTasks) > 0) {
        finish(true);
      }
    };
    controlChannel.addEventListener("message", onReply);
    const timer = setTimeout(() => finish(false), WORKER_IDLE_PROBE_MS);
    try {
      controlChannel.postMessage({ type: "idle-probe", probeId, from: INSTANCE });
    } catch {
      finish(true);
    }
  });
  if (hasBusyPeer || tasks.size > 0 || queue.length > 0) return false;
  return !(await hasControlledDownloadClients());
}

function notifyIdleIfEmpty() {
  if (!controlChannel || tasks.size > 0 || queue.length > 0) return;
  try {
    controlChannel.postMessage({ type: "worker-idle", from: INSTANCE });
  } catch {}
}

controlChannel?.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.from === INSTANCE) return;
  if (data.type === "idle-probe" && typeof data.probeId === "string") {
    if (isCurrentActiveWorker() || tasks.size > 0 || queue.length > 0) {
      try {
        controlChannel.postMessage({
          type: "idle-reply",
          probeId: data.probeId,
          from: INSTANCE,
          activeTasks: tasks.size + queue.length,
        });
      } catch {}
    }
    return;
  }
  if (data.type === "worker-idle" && waitingToActivate && !isCurrentActiveWorker() && tasks.size === 0 && queue.length === 0) {
    void (async () => {
      if (!waitingToActivate || isCurrentActiveWorker() || tasks.size > 0 || queue.length > 0) return;
      if (await hasControlledDownloadClients()) return;
      if (typeof self.skipWaiting === "function") {
        await self.skipWaiting();
      }
    })().catch(() => {});
  }
});

self.addEventListener("install", event => {
  waitingToActivate = true;
  event.waitUntil((async () => {
    if (await canSafelySkipWaiting()) {
      if (typeof self.skipWaiting === "function") {
        await self.skipWaiting();
      }
    }
  })());
});

self.addEventListener("activate", event => {
  isActivated = true;
  waitingToActivate = false;
  event.waitUntil((async () => {
    if (typeof self.clients?.claim === "function" && !(await hasControlledDownloadClients())) {
      await self.clients.claim();
    }
  })());
});
const terminal = status => ["completed", "failed", "cancelled", "manual"].includes(status);
const abortError = () => new DOMException("下载已取消", "AbortError");
const validKey = value => typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
const INTERNAL_HOST_SUFFIXES = ["localhost", "local", "internal", "lan", "corp", "home.arpa"];

function extractRawAuthorityHost(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const match = /^(?:https?:)?\/\/([^/?#\\]+)/i.exec(trimmed);
  if (!match) return "";
  let authority = match[1];
  const atIdx = authority.lastIndexOf("@");
  if (atIdx !== -1) authority = authority.slice(atIdx + 1);
  if (authority.startsWith("[")) {
    const closeIdx = authority.indexOf("]");
    return closeIdx !== -1 ? authority.slice(0, closeIdx + 1).toLowerCase() : authority.toLowerCase();
  }
  const colonIdx = authority.indexOf(":");
  return (colonIdx !== -1 ? authority.slice(0, colonIdx) : authority).toLowerCase();
}

function parseCanonicalIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function parseIpv4NumberPart(part) {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^(?:0|[1-9]\d*)$/.test(part)) return Number.parseInt(part, 10);
  return NaN;
}

function isIpv4LikeLiteral(host) {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(part => Number.isFinite(parseIpv4NumberPart(part)));
}

function isDisallowedIpv4(bytes) {
  const [a, b, c] = bytes;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // 224.0.0.0/3 (multicast, reserved, broadcast)
  return false;
}

function parseIpv6Literal(raw) {
  let s = raw;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s || s.includes("%")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parsePart = (segment, allowIpv4) => {
    if (!segment) return [];
    const tokens = segment.split(":");
    const groups = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (allowIpv4 && i === tokens.length - 1 && token.includes(".")) {
        const ipv4 = parseCanonicalIpv4(token);
        if (!ipv4) return null;
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        groups.push(Number.parseInt(token, 16));
      }
    }
    return groups;
  };
  if (halves.length === 1) {
    const groups = parsePart(halves[0], true);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parsePart(halves[0], false);
  const tail = parsePart(halves[1], true);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

function isAllowedPublicIpv6(groups) {
  if (!groups || groups.length !== 8) return false;
  const [g0, g1] = groups;
  // Only global unicast 2000::/3 is eligible.
  if ((g0 & 0xe000) !== 0x2000) return false;
  // Reject IETF special-purpose / documentation / 6to4 ranges inside 2000::/3.
  if (g0 === 0x2001 && (g1 & 0xfe00) === 0x0000) return false; // 2001::/23
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // 2001:db8::/32
  if (g0 === 0x2002) return false; // 2002::/16
  if (g0 === 0x3fff && (g1 & 0xf000) === 0x0000) return false; // 3fff::/20
  return true;
}

const sourceUrl = value => {
  const url = new URL(value, self.location.origin);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
      (url.origin === self.location.origin && url.pathname.startsWith("/downloads/")) || /\.m3u8(?:$|[?#])/i.test(url.href)) {
    throw new Error("资源地址不支持完整文件下载");
  }
  const rawAuthorityHost = extractRawAuthorityHost(value);
  const normalizedHostname = url.hostname.toLowerCase();
  const host = normalizedHostname.replace(/\.+$/, "");
  if (!host) throw new Error("资源地址不支持完整文件下载");

  // Reject deformed IPv4 literals (decimal, hex, octal, shorthand, or trailing dots).
  const canonicalIpv4 = parseCanonicalIpv4(normalizedHostname);
  if (canonicalIpv4 && rawAuthorityHost && rawAuthorityHost !== normalizedHostname) {
    throw new Error("资源地址不支持完整文件下载");
  }
  if (!canonicalIpv4 && isIpv4LikeLiteral(host)) {
    throw new Error("资源地址不支持完整文件下载");
  }

  const selfHost = (self.location.hostname || "").toLowerCase().replace(/\.+$/, "");
  const isLocalTestOrigin = selfHost === "127.0.0.1" || selfHost === "localhost";
  const isLocalTestTarget = isLocalTestOrigin && (host === "127.0.0.1" || host === "localhost");

  if (!isLocalTestTarget && url.host !== self.location.host) {
    if (url.port !== "" && url.port !== "80" && url.port !== "443") {
      throw new Error("资源地址不支持完整文件下载");
    }
  }

  if (!isLocalTestTarget) {
    if (INTERNAL_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
      throw new Error("资源地址不支持完整文件下载");
    }
    if (host.startsWith("[") || host.endsWith("]") || host.includes(":")) {
      if (!isAllowedPublicIpv6(parseIpv6Literal(host))) {
        throw new Error("资源地址不支持完整文件下载");
      }
    } else if (canonicalIpv4 && isDisallowedIpv4(canonicalIpv4)) {
      throw new Error("资源地址不支持完整文件下载");
    }
  }

  return url.href;
};

// Observe the existing pull loop. No timers, media buffers, or per-chunk messages.
function transferTiming(started, firstBlock) {
  let windowStart = firstBlock, mark = firstBlock, phase = "demand";
  let from = 0, readMs = 0, demandMs = 0, span = 2000;
  const windows = [];
  function enter(next, now) {
    if (phase === "read") readMs += now - mark;
    if (phase === "demand") demandMs += now - mark;
    phase = next;
    mark = now;
  }
  function close(to, now) {
    windows.push({ from, to, ms: now - windowStart, readMs, demandMs });
    from = to;
    windowStart = now;
    readMs = demandMs = 0;
    // Keep coverage of the whole file, even during multi-hour transfers.
    if (windows.length === 128) {
      for (let i = 0; i < 64; i++) {
        const a = windows[i * 2], b = windows[i * 2 + 1];
        windows[i] = { from: a.from, to: b.to, ms: a.ms + b.ms,
          readMs: a.readMs + b.readMs, demandMs: a.demandMs + b.demandMs };
      }
      windows.length = 64;
      span *= 2;
    }
  }
  return {
    pull(hasFirst) { enter(hasFirst ? "work" : "read", performance.now()); },
    received() { enter("work", performance.now()); },
    delivered(to) {
      const now = performance.now();
      enter("demand", now);
      if (now - windowStart >= span) close(to, now);
    },
    finish(to) {
      const now = performance.now();
      enter("done", now);
      if (to !== from || now > windowStart || !windows.length) close(to, now);
      return { firstBlockMs: Math.round(firstBlock - started), windows: windows.map(w => ({
        from: w.from, to: w.to, ms: Math.round(w.ms),
        readMs: Math.round(w.readMs), demandMs: Math.round(w.demandMs),
      })) };
    },
  };
}

function snapshot(task) {
  if (task.result) return task.result;
  const now = Date.now(), end = task.finishedAt ?? now;
  const elapsed = Math.max(0, (end - task.startedAt) / 1000);
  const transferElapsed = task.transferStartedAt === undefined ? 0 : Math.max(0, (end - task.transferStartedAt) / 1000);
  // Lack of downstream demand may be a normal browser pause. Report it without
  // cancelling the transfer, starting another route, or releasing its slot.
  const observation = task.state.status === "downloading" && !task.pendingUpstream &&
    now - Math.max(task.lastPullAt ?? task.transferStartedAt, task.lastReceivedAt ?? 0) >= STALLED_MS ? "stalled" : undefined;
  const result = { ...task.state, workerBuild: BUILD, workerInstance: INSTANCE, ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }), revision: ++task.revision, observation, elapsed, transferElapsed,
    speed: now - (task.lastReceivedAt || 0) > 3000 ? 0 : task.state.speed,
    averageSpeed: task.state.loaded / Math.max(0.001, transferElapsed) };
  if (terminal(task.state.status)) task.result = result;
  return result;
}

function persist(task) {
  const { url: _url, ...summary } = snapshot(task);
  const record = { id: task.state.id, token: task.token, createdAt: task.startedAt,
    updatedAt: Date.now(), finishedAt: task.finishedAt, snapshot: summary };
  // Preserve lifecycle ordering even when one transaction is delayed. No chunks
  // are written here; the small queue contains phase transitions and the result.
  task.persistence = (task.persistence || Promise.resolve()).then(() => store.put(record));
  return task.persistence;
}

function publish(task, force = false) {
  const now = Date.now();
  if (!force && now - task.publishedAt < 300) return;
  if (task.state.status === "downloading") {
    const samples = task.speedSamples;
    samples.push({ at: now, loaded: task.state.loaded });
    while (samples.length > 2 && samples[1].at <= now - SPEED_WINDOW_MS) samples.shift();
    task.state.speed = (task.state.loaded - samples[0].loaded) / Math.max(0.001, (now - samples[0].at) / 1000);
  } else task.state.speed = 0;
  task.publishedAt = now;
  const phase = `${task.state.status}:${task.state.delivery || ""}`;
  if (!terminal(task.state.status) && task.persistedPhase !== phase) {
    task.persistedPhase = phase;
    void persist(task);
  }
  const message = { channel: "dokitool-download", protocol: PROTOCOL, snapshot: snapshot(task) };
  for (const clientId of task.subscribers) {
    void self.clients.get(clientId).then(client => {
      if (client) client.postMessage(message);
      else task.subscribers.delete(clientId);
    }).catch(() => { /* A lookup failure does not prove a live page disappeared. */ });
  }
}

function awaitClaim(task) {
  task.claimTimer = setTimeout(() => settle(task, "failed", "浏览器未接收下载，请重试或手动打开源链接"), CLAIM_MS);
}

function drain() {
  while (active < MAX_ACTIVE && queue.length) {
    const task = queue.shift();
    if (terminal(task.state.status)) { task.rejectSlot?.(abortError()); continue; }
    active++;
    task.hasSlot = true;
    if (task.admission) {
      task.state.delivery = "ready";
      awaitClaim(task);
      publish(task, true);
    } else task.resolveSlot();
  }
}

function settle(task, status, error) {
  if (terminal(task.state.status)) return task.settling;
  if (status === "failed" && task.tbvideo) {
    status = "manual";
    error = undefined;
  }
  clearTimeout(task.claimTimer);
  clearTimeout(task.responseTimer);
  task.state.status = status;
  if (task.timing) {
    task.state.timing = task.timing.finish(task.state.loaded);
    task.timing = undefined;
  }
  task.state.error = error;
  task.finishedAt = Date.now();
  task.detachRequestAbort?.();
  task.detachRequestAbort = undefined;
  const queuedIndex = queue.indexOf(task);
  if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
  if (status !== "completed") {
    // A consumer need not pull again after stopping. Error the output now rather
    // than waiting for a future pull to notice the aborted upstream request.
    task.outputController?.error(status === "cancelled" ? abortError() : new Error(error || "下载失败"));
  }
  task.outputController = undefined;
  task.range?.abort();
  task.range = undefined;
  task.controller.abort();
  task.cleanupInitialAttempt?.();
  task.cleanupInitialAttempt = undefined;
  task.initialAttempt?.abort();
  task.initialAttempt = undefined;
  const reader = task.reader;
  task.reader = undefined;
  void reader?.cancel().catch(() => {}).finally(() => { reader.releaseLock(); });
  task.rejectSlot?.(abortError());
  if (task.hasSlot) { task.hasSlot = false; active--; }
  // Close/abort the stream independently of storage. Retain the authoritative
  // result in memory until its bounded write and notification have finished.
  task.settling = persist(task).then(() => {
    publish(task, true);
    history.set(task.state.id, { token: task.token, finishedAt: task.finishedAt, result: task.result });
    tasks.delete(task.state.id);
    prune();
    notifyIdleIfEmpty();
  });
  // A fetch event may already be inactive at EOF. This protects only the short
  // result write where the browser permits it, never the whole transfer.
  const reporting = task.tbvideoEvent ? reportTbvideo(task.tbvideoEvent, snapshot(task)) : undefined;
  try { task.protect?.(reporting ? Promise.all([task.settling, reporting]) : task.settling); } catch { /* Stream/event lifetime is browser-owned. */ }
  drain();
  return task.settling;
}

function prune() {
  clearTimeout(historyTimer);
  historyTimer = undefined;
  const now = Date.now();
  for (const [id, entry] of history) if (now - entry.finishedAt >= RETAIN_MS) history.delete(id);
  while (history.size > 100) history.delete(history.keys().next().value);
  const oldest = history.values().next().value;
  if (oldest) historyTimer = setTimeout(prune, Math.max(1, oldest.finishedAt + RETAIN_MS - now));
}

async function timed(task, operation) {
  if (task.controller.signal.aborted) throw abortError();
  task.pendingUpstream = (task.pendingUpstream || 0) + 1;
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        onAbort = () => reject(abortError());
        task.controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => reject(new Error("来源超过 45 秒没有返回数据，请重新下载")), IDLE_MS);
      }),
    ]);
  } finally {
    task.pendingUpstream--;
    clearTimeout(timer);
    task.controller.signal.removeEventListener("abort", onAbort);
  }
}

function parseContentRange(header) {
  if (typeof header !== "string") return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total) ||
      start < 0 || end < start || total <= 0 || end >= total) return null;
  return { start, end, total };
}

function strongETag(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && !/^w\//i.test(trimmed) ? trimmed : "";
}

function hasNonIdentityEncoding(headers) {
  const enc = headers.get("content-encoding")?.trim().toLowerCase() || "";
  return enc !== "" && enc !== "identity";
}

function parsePositiveIntHeader(headers, name) {
  const raw = headers.get(name)?.trim() || "";
  if (!/^\d+$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function acceptsByteRanges(headers, allowOmitted = false) {
  const raw = headers.get("accept-ranges")?.trim().toLowerCase() || "";
  if (!raw) return allowOmitted;
  const tokens = raw.split(",").map(token => token.trim()).filter(Boolean);
  if (!tokens.length || tokens.includes("none")) return false;
  return tokens.includes("bytes");
}

function createRangeScheduler(task, config) {
  const { url, total, chunk0End } = config;
  const totalRangeChunks = Math.ceil((total - chunk0End) / RANGE_CHUNK_SIZE);
  const rangeController = new AbortController();
  const activeControllers = new Set();
  const activeReaders = new Set();
  const inFlight = new Set();
  const buffered = new Map();
  let state = "idle"; // "idle" | "probing" | "active" | "fallback" | "failed" | "aborted"
  let switched = false;
  let expectedETag = config.initialETag;
  let nextScheduleIdx = 0;
  let nextDeliverIdx = 0;
  let deliverOffset = 0;
  let fatalError = null;
  let waiter = null;
  let probeWaiter = null;

  function resolveProbeWaiter() {
    if (!probeWaiter) return;
    const current = probeWaiter;
    probeWaiter = null;
    current();
  }

  function clearWaiter(err) {
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    if (err) current.reject(err);
    else current.resolve();
  }

  function cancelAllWorkers() {
    rangeController.abort();
    for (const ctrl of [...activeControllers]) ctrl.abort();
    activeControllers.clear();
    for (const reader of [...activeReaders]) void reader.cancel().catch(() => {});
    activeReaders.clear();
    inFlight.clear();
    buffered.clear();
  }

  function fallback() {
    if (state === "fallback" || state === "failed" || state === "aborted") return;
    state = "fallback";
    resolveProbeWaiter();
    cancelAllWorkers();
    clearWaiter();
  }

  function fail(error) {
    if (state === "failed" || state === "aborted") return;
    state = "failed";
    fatalError = error instanceof Error ? error : new Error(String(error || "分片下载失败"));
    resolveProbeWaiter();
    cancelAllWorkers();
    clearWaiter(fatalError);
  }

  function abort() {
    if (state === "aborted") return;
    state = "aborted";
    resolveProbeWaiter();
    cancelAllWorkers();
    clearWaiter(abortError());
  }

  function pump() {
    if (state !== "active" || rangeController.signal.aborted || task.controller.signal.aborted) return;
    while (
      nextScheduleIdx < totalRangeChunks &&
      inFlight.size < MAX_RANGE_CONCURRENCY &&
      (nextScheduleIdx - nextDeliverIdx) < MAX_WINDOW_CHUNKS
    ) {
      const idx = nextScheduleIdx++;
      void fetchChunk(idx, false);
    }
  }

  async function fetchChunk(idx, isProbe) {
    const start = chunk0End + idx * RANGE_CHUNK_SIZE;
    const end = Math.min(total - 1, start + RANGE_CHUNK_SIZE - 1);
    const expectedLen = end - start + 1;
    inFlight.add(idx);

    const nonRetryable = message => Object.assign(new Error(message), { retryable: false });

    try {
      for (let attempt = 0; ; attempt++) {
        if (rangeController.signal.aborted || task.controller.signal.aborted) return;
        const reqCtrl = new AbortController();
        const onAbort = () => reqCtrl.abort();
        activeControllers.add(reqCtrl);
        rangeController.signal.addEventListener("abort", onAbort, { once: true });
        task.controller.signal.addEventListener("abort", onAbort, { once: true });
        let reader;
        try {
          const resp = await fetch(url, {
            signal: reqCtrl.signal,
            mode: "cors",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            headers: { Range: `bytes=${start}-${end}` },
          });
          if (rangeController.signal.aborted || task.controller.signal.aborted) {
            void resp?.body?.cancel?.().catch(() => {});
            return;
          }
          if (resp.status !== 206 || resp.type === "opaque" || !resp.body) {
            void resp?.body?.cancel?.().catch(() => {});
            throw nonRetryable(`分片响应异常（HTTP ${resp.status}）`);
          }
          if (hasNonIdentityEncoding(resp.headers)) {
            void resp.body.cancel().catch(() => {});
            throw nonRetryable("分片响应包含不支持的压缩编码");
          }
          const cr = parseContentRange(resp.headers.get("content-range"));
          if (!cr || cr.start !== start || cr.end !== end || cr.total !== total) {
            void resp.body.cancel().catch(() => {});
            throw nonRetryable("分片范围与来源声明不一致");
          }
          const rawCL = resp.headers.get("content-length")?.trim();
          if (rawCL && (!/^\d+$/.test(rawCL) || Number(rawCL) !== expectedLen)) {
            void resp.body.cancel().catch(() => {});
            throw nonRetryable("分片长度与来源声明不一致");
          }
          const rawETag = resp.headers.get("etag")?.trim() || "";
          const chunkStrong = strongETag(rawETag);
          if (expectedETag) {
            if (rawETag && rawETag !== expectedETag) {
              void resp.body.cancel().catch(() => {});
              throw nonRetryable("资源 ETag 已变化，请重新下载");
            }
          } else if (chunkStrong) {
            expectedETag = chunkStrong;
          }

          if (isProbe && state === "probing") {
            state = "active";
            resolveProbeWaiter();
            pump();
          }

          const buf = new Uint8Array(expectedLen);
          let offset = 0;
          reader = resp.body.getReader();
          activeReaders.add(reader);
          for (;;) {
            if (rangeController.signal.aborted || task.controller.signal.aborted) return;
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.length) continue;
            if (offset + value.length > expectedLen) {
              throw nonRetryable("分片长度超出来源声明");
            }
            buf.set(value, offset);
            offset += value.length;
          }
          if (rangeController.signal.aborted || task.controller.signal.aborted) return;
          if (offset !== expectedLen) {
            throw new Error("分片传输不完整");
          }
          if (state !== "active") return;
          buffered.set(idx, buf);
          inFlight.delete(idx);
          if (idx === nextDeliverIdx) clearWaiter();
          pump();
          return;
        } catch (error) {
          if (rangeController.signal.aborted || task.controller.signal.aborted) return;
          if (!switched) {
            fallback();
            return;
          }
          const canRetry = error?.retryable !== false && attempt < MAX_RANGE_CHUNK_RETRIES;
          if (!canRetry) {
            fail(error);
            return;
          }
        } finally {
          rangeController.signal.removeEventListener("abort", onAbort);
          task.controller.signal.removeEventListener("abort", onAbort);
          activeControllers.delete(reqCtrl);
          if (reader) {
            activeReaders.delete(reader);
            void reader.cancel().catch(() => {}).finally(() => { try { reader.releaseLock(); } catch {} });
          }
        }
      }
    } finally {
      inFlight.delete(idx);
    }
  }

  return {
    chunk0End,
    isProbing: () => state === "probing",
    isActive: () => state === "active",
    hasReadySlice: () => state === "failed" || buffered.has(nextDeliverIdx) || nextDeliverIdx >= totalRangeChunks,
    startProbe() {
      if (state !== "idle") return;
      state = "probing";
      nextScheduleIdx = 1;
      void fetchChunk(0, true);
    },
    commitSwitch() {
      switched = true;
      if (!task.state.total && total > 0) task.state.total = total;
      const reader = task.reader;
      task.reader = undefined;
      void reader?.cancel().catch(() => {}).finally(() => { try { reader.releaseLock(); } catch {} });
      task.cleanupInitialAttempt?.();
      task.cleanupInitialAttempt = undefined;
      task.initialAttempt?.abort();
      task.initialAttempt = undefined;
      pump();
    },
    fallback,
    abort,
    waitProbeSettled() {
      if (state !== "probing") return Promise.resolve();
      if (task.controller.signal.aborted || rangeController.signal.aborted) {
        return Promise.reject(abortError());
      }
      return new Promise((resolve, reject) => {
        let done = false;
        let timer;
        const finish = err => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          task.controller.signal.removeEventListener("abort", onAbort);
          if (probeWaiter === onSettled) probeWaiter = null;
          if (err) reject(err);
          else resolve();
        };
        const onSettled = () => finish();
        const onAbort = () => finish(abortError());
        probeWaiter = onSettled;
        task.controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          if (state === "probing") fallback();
          finish();
        }, RANGE_PROBE_WAIT_MS);
      });
    },
    waitReady() {
      if (task.controller.signal.aborted || state === "aborted") return Promise.reject(abortError());
      if (fatalError) return Promise.reject(fatalError);
      if (buffered.has(nextDeliverIdx) || nextDeliverIdx >= totalRangeChunks) return Promise.resolve();
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    nextSlice() {
      if (task.controller.signal.aborted || state === "aborted") throw abortError();
      if (fatalError) throw fatalError;
      if (nextDeliverIdx >= totalRangeChunks) return { done: true };
      const chunk = buffered.get(nextDeliverIdx);
      if (!chunk) return null;
      const sliceEnd = Math.min(chunk.length, deliverOffset + RANGE_DELIVER_SLICE_BYTES);
      const slice = chunk.subarray(deliverOffset, sliceEnd);
      deliverOffset = sliceEnd;
      if (deliverOffset >= chunk.length) {
        buffered.delete(nextDeliverIdx);
        nextDeliverIdx++;
        deliverOffset = 0;
        pump();
      }
      return { done: false, value: slice };
    },
  };
}

function mediaHeaders(response, filename, formatMime, sourceSize) {
  if (response.status !== 200 || response.headers.has("content-range") || response.type === "opaque" || !response.body) throw new Error(`资源不是完整文件响应（HTTP ${response.status}）`);
  const format = attachmentFormat(filename, response.headers.get("content-type"), formatMime, { allowUnknownMedia: true });
  const total = decodedLength(response, sourceSize);
  return { ...format, total };
}

async function prepare(task) {
  let lastError;
  // Only before returning the attachment response can another route replace this one.
  for (const url of task.routes) {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    task.controller.signal.addEventListener("abort", abortAttempt, { once: true });
    let response;
    try {
      task.state.url = url;
      publish(task, true);
      const credentials = new URL(url).origin === self.location.origin ? "same-origin" : "omit";
      response = await timed(task, () => fetch(url, {
        signal: attempt.signal, mode: "cors", credentials,
        referrerPolicy: "no-referrer", cache: "no-store",
      }));
      const metadata = mediaHeaders(response, task.state.filename, task.formatMime, task.sourceSizes?.[url]);
      task.reader = response.body.getReader();
      const first = await timed(task, () => task.reader.read());
      if (first.done || !first.value?.length) throw new Error("资源为空");
      const prefix = new TextDecoder().decode(first.value.subarray(0, 100)).trimStart();
      if (/^(?:<!doctype|<html|#EXTM3U|\{"|\[\{)/i.test(prefix)) throw new Error("资源返回了页面或播放清单，不能作为完整视频保存");
      if (metadata.total && first.value.length > metadata.total) throw new Error("下载长度与来源声明不一致");
      if (task.controller.signal.aborted) throw abortError();
      Object.assign(task.state, metadata);
      task.initialAttempt = attempt;
      task.cleanupInitialAttempt = () => task.controller.signal.removeEventListener("abort", abortAttempt);
      const rangeAllowedByHeaders =
        credentials === "omit" &&
        !hasNonIdentityEncoding(response.headers) &&
        acceptsByteRanges(response.headers, true);
      const rangeCandidateTotal = metadata.total > 0
        ? metadata.total
        : (rangeAllowedByHeaders ? parsePositiveIntHeader(response.headers, "content-length") : 0);
      const rangeEligible =
        rangeAllowedByHeaders &&
        rangeCandidateTotal >= RANGE_THRESHOLD_BYTES &&
        first.value.length < rangeCandidateTotal;
      const chunk0End = rangeEligible
        ? Math.min(rangeCandidateTotal, Math.max(RANGE_INITIAL_CHUNK_BYTES, first.value.length))
        : 0;
      const rangeConfig = rangeEligible && chunk0End < rangeCandidateTotal ? {
        url,
        total: rangeCandidateTotal,
        chunk0End,
        initialETag: strongETag(response.headers.get("etag")),
      } : null;
      // Keep this attempt alive; cancelling the task aborts its source request as well.
      return { first: first.value, mime: metadata.mime, rangeConfig };
    } catch (error) {
      lastError = error;
      attempt.abort();
      void task.reader?.cancel().catch(() => {});
      if (!task.reader) void response?.body?.cancel().catch(() => {});
      task.reader = undefined;
      task.initialAttempt = undefined;
      task.cleanupInitialAttempt = undefined;
      task.controller.signal.removeEventListener("abort", abortAttempt);
      if (task.controller.signal.aborted) throw abortError();
    }
  }
  throw lastError || new Error("没有可用的下载线路");
}

async function attachment(task) {
  if (task.controller.signal.aborted) throw abortError();
  if (!task.hasSlot) {
    await new Promise((resolve, reject) => {
      task.resolveSlot = resolve; task.rejectSlot = reject;
      queue.push(task); drain();
    });
  }
  if (task.controller.signal.aborted) throw abortError();
  task.state.status = "preparing";
  publish(task, true);
  if (task.tbvideo) return candidateAttachment(task);
  const prepareStarted = performance.now();
  const prepared = await prepare(task);
  if (task.controller.signal.aborted) throw abortError();
  task.timing = transferTiming(prepareStarted, performance.now());
  let first = prepared.first;
  const range = prepared.rangeConfig ? createRangeScheduler(task, prepared.rangeConfig) : null;
  task.range = range;
  let deliveryMode = "initial";
  task.state.status = "downloading";
  task.transferStartedAt = Date.now();
  task.speedSamples = [{ at: task.transferStartedAt, loaded: 0 }];
  publish(task, true);
  const stream = new ReadableStream({
    start(controller) { task.outputController = controller; },
    async pull(controller) {
      try {
        if (task.controller.signal.aborted) throw abortError();
        task.lastPullAt = Date.now();
        if (deliveryMode === "initial" && range && !first && task.state.loaded === range.chunk0End) {
          if (range.isProbing()) {
            await range.waitProbeSettled();
            if (task.controller.signal.aborted) throw abortError();
          }
          if (range.isActive()) {
            range.commitSwitch();
            deliveryMode = "range";
          } else if (range.isProbing()) {
            range.fallback();
          }
        }
        let item;
        if (deliveryMode === "range") {
          const readyNow = range.hasReadySlice();
          task.timing?.pull(readyNow);
          if (!readyNow) await timed(task, () => range.waitReady());
          task.timing?.received();
          item = range.nextSlice();
          if (!item) throw new Error("分片调度状态异常");
        } else {
          if (first && range) range.startProbe();
          task.timing?.pull(!!first);
          item = first ? { value: first, done: false } : await timed(task, () => task.reader.read());
          task.timing?.received();
          first = undefined;
          if (!item.done && range && task.state.loaded + item.value.length >= range.chunk0End) {
            if (range.isProbing() && task.state.loaded + item.value.length > range.chunk0End) {
              await range.waitProbeSettled();
              if (task.controller.signal.aborted) throw abortError();
            }
            if (range.isActive()) {
              const keep = range.chunk0End - task.state.loaded;
              if (keep < item.value.length) item = { value: item.value.subarray(0, keep), done: false };
              range.commitSwitch();
              deliveryMode = "range";
            } else if (range.isProbing() && task.state.loaded + item.value.length > range.chunk0End) {
              range.fallback();
            }
          }
        }
        if (item.done) {
          if (!task.state.loaded || (task.state.total && task.state.loaded !== task.state.total)) throw new Error("下载不完整，请重新下载");
          controller.close();
          task.outputController = undefined;
          settle(task, "completed");
          return;
        }
        if (task.state.total && task.state.loaded + item.value.length > task.state.total) throw new Error("下载长度与来源声明不一致");
        task.state.loaded += item.value.length;
        task.lastReceivedAt = Date.now();
        controller.enqueue(item.value);
        publish(task);
        task.timing?.delivered(task.state.loaded);
      } catch (error) {
        settle(task, task.controller.signal.aborted ? "cancelled" : "failed", error.message);
      }
    },
    cancel() { settle(task, "cancelled", "浏览器停止接收下载数据"); },
  }, { highWaterMark: 0 });
  return fileResponse(task, stream, prepared.mime);
}

async function candidateAttachment(task) {
  task.state.tbvideoAttempted = true;
  task.state.status = "downloading";
  task.transferStartedAt = Date.now();
  task.speedSamples = [{ at: task.transferStartedAt, loaded: 0 }];
  publish(task, true);
  const file = await readCandidate(task.routes[0], task.controller.signal, operation => timed(task, operation),
    (loaded, total) => {
      task.state.loaded = loaded;
      task.state.total = total;
      task.lastReceivedAt = Date.now();
      publish(task);
    });
  if (task.controller.signal.aborted) throw abortError();
  const format = attachmentFormat(task.state.filename, "video/mp4", task.formatMime);
  task.state.filename = format.filename;
  // The browser can only start saving after the entire object is verified.
  const reader = file.stream().getReader();
  task.reader = reader;
  const stream = new ReadableStream({
    start(controller) { task.outputController = controller; },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (task.controller.signal.aborted) return;
        if (done) {
          controller.close();
          task.outputController = undefined;
          settle(task, "completed");
        } else controller.enqueue(value);
      } catch {
        settle(task, "failed", "无法读取已校验的文件");
      }
    },
    cancel() { settle(task, "cancelled", "浏览器停止接收下载数据"); },
  }, { highWaterMark: 0 });
  return fileResponse(task, stream, format.mime);
}

function fileResponse(task, stream, mime) {
  const encoded = encodeURIComponent(task.state.filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = {
    "Content-Type": mime,
    "Content-Disposition": `attachment; filename="download.${task.state.filename.split(".").pop()}"; filename*=UTF-8''${encoded}`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "X-DokiTool-Worker-Build": BUILD,
  };
  if (task.state.total) headers["Content-Length"] = String(task.state.total);
  return new Response(stream, { headers });
}

async function authorizedClient(event) {
  if (!event.source?.id) return null;
  const client = await self.clients.get(event.source.id);
  return client && new URL(client.url).origin === self.location.origin ? client : null;
}

self.addEventListener("message", event => {
  const port = event.ports?.[0];
  if (!port) return;
  event.waitUntil((async () => {
    const client = await authorizedClient(event);
    if (!client || event.data?.protocol !== PROTOCOL) { port.postMessage({ error: "下载通信校验失败" }); return; }
    prune();
    const message = event.data;
    try {
      if (message.action === "ping") { port.postMessage({ protocol: PROTOCOL, workerBuild: BUILD, workerInstance: INSTANCE, capabilities: { admission: true, recovery: true, tbvideo: true } }); return; }
      if (message.action === "start") {
        const request = message.request;
        if (!validKey(request?.id) || !validKey(message.token)) throw new Error("无效下载任务");
        let task = tasks.get(request.id);
        const stored = !task && !history.has(request.id) ? await store.get(request.id) : null;
        // Another START may have admitted this ID while storage was pending.
        task = tasks.get(request.id);
        const previous = history.get(request.id) || (stored && { token: stored.token, result: stored.snapshot });
        if ((task || previous) && (task || previous).token !== message.token) throw new Error("下载任务无访问权限");
        if (previous) {
          if (!terminal(previous.result.status)) throw new Error("原执行实例已结束，不能重新启动同一任务");
          port.postMessage({ snapshot: { url: "", ...previous.result } }); return;
        }
        let created = false;
        if (!task) {
          if (tasks.size >= 100) throw new Error("下载任务过多，请清理后重试");
          const tbvideo = request.tbvideo === true;
          if (tbvideo && (!validCandidate(request.url) || request.routes?.some(url => url !== request.url))) {
            throw new Error("无效下载线路");
          }
          const routes = [...new Set([request.url, ...(request.routes || [])].slice(0, 10).map(sourceUrl))].slice(0, 3);
          if (!routes.length) throw new Error("资源地址为空");
          const now = Date.now();
          const startedAt = Number.isFinite(request.startedAt) && request.startedAt > 0 && request.startedAt <= now ? request.startedAt : now;
          task = {
            token: message.token, routes, tbvideo, tbvideoEvent: tbvideo ? request.tbvideoEvent : undefined, sourceSizes: request.sourceSizes, formatMime: request.formatMime,
            controller: new AbortController(), subscribers: new Set(),
            startedAt, publishedAt: now, revision: 0, admission: message.admission === true,
            state: { id: request.id, transport: "browser_streaming", status: "queued", filename: cleanFilename(request.filename), url: tbvideo ? "" : routes[0], loaded: 0, total: 0, speed: 0, elapsed: 0, averageSpeed: 0,
              ...(tbvideo ? { tbvideoAttempted: false } : {}),
              ...(message.admission === true ? { delivery: "waiting" } : {}) },
          };
          tasks.set(request.id, task);
          created = true;
        }
        task.subscribers.add(client.id);
        if (created) {
          void persist(task);
          if (task.admission) { queue.push(task); drain(); }
          else awaitClaim(task);
        }
        port.postMessage({ snapshot: snapshot(task),
          ...(task.admission ? {} : { downloadUrl: `/downloads/file/${request.id}/${task.token}` }) });
        // Acknowledge setup only. Keeping this event open for the whole download
        // triggers Chromium's extended-event deadline even while bytes flow.
        return;
      }
      if (message.action === "query") {
        const result = [], unavailable = [];
        for (const key of (message.tasks || []).slice(0, 100)) {
          if (!validKey(key.id) || !validKey(key.token)) continue;
          const task = tasks.get(key.id);
          if (task && task.token === key.token) { await task.settling; task.subscribers.add(client.id); result.push(snapshot(task)); }
          else {
            const previous = history.get(key.id);
            if (previous?.token === key.token) result.push(previous.result);
            else {
              const stored = await store.get(key.id);
              if (stored?.token === key.token && terminal(stored.snapshot.status)) result.push({ url: "", ...stored.snapshot });
              else {
                const instance = stored?.token === key.token ? stored.snapshot.workerInstance : key.workerInstance;
                unavailable.push({ id: key.id, ownerGone: !!instance && instance !== INSTANCE });
              }
            }
          }
        }
        port.postMessage({ snapshots: result, unavailable, workerBuild: BUILD, workerInstance: INSTANCE }); return;
      }
      if (!validKey(message.id) || !validKey(message.token)) throw new Error("无效下载任务");
      const task = tasks.get(message.id);
      const stored = !task && !history.has(message.id) ? await store.get(message.id) : null;
      const previous = history.get(message.id) || (stored && terminal(stored.snapshot.status) ? { token: stored.token, result: { url: "", ...stored.snapshot } } : null);
      if (stored && stored.token !== message.token) throw new Error("下载任务无访问权限");
      if ((task || previous) && (task || previous).token !== message.token) throw new Error("下载任务无访问权限");
      if (message.action === "forget") {
        if (task) throw new Error("请先停止下载，再清除任务");
        history.delete(message.id); prune();
        await store.remove(message.id);
        port.postMessage({ forgotten: true }); return;
      }
      if (message.action !== "cancel" || (!task && !previous)) throw new Error("下载任务不存在或已失效");
      if (task) await settle(task, "cancelled", "页面请求取消下载");
      port.postMessage({ snapshot: task ? snapshot(task) : previous.result });
    } catch (error) { port.postMessage({ error: error.message }); }
  })());
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/downloads/file/")) return;
  const [, , , id, token] = url.pathname.split("/");
  const task = tasks.get(id);
  if (event.request.method !== "GET" || !task || task.token !== token || task.claimed || terminal(task.state.status)) {
    event.respondWith(new Response("Download expired", { status: 404, headers: { "Cache-Control": "no-store" } })); return;
  }
  if (task.admission && !task.hasSlot) {
    event.respondWith(new Response("Download not admitted", { status: 409, headers: { "Cache-Control": "no-store" } })); return;
  }
  task.claimed = true;
  task.protect = promise => event.waitUntil(promise);
  if (task.admission) task.state.delivery = "claimed";
  clearTimeout(task.claimTimer);
  task.responseTimer = setTimeout(() => settle(task, "failed", task.state.status === "queued"
    ? "等待下载空位超过 2 分钟，请在其他下载结束后重试"
    : task.admission ? "下载准备超过 2 分钟，请稍后重试" : "下载准备超过 2 分钟（含排队），请稍后重试"), RESPONSE_MS);
  const signal = event.request.signal;
  const abort = () => settle(task, "cancelled", "浏览器中止下载请求");
  task.detachRequestAbort = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Once returned, the response stream owns delivery. Do not bind the complete
  // transfer to waitUntil: long downloads must outlive the setup event.
  event.respondWith(attachment(task).catch(error => {
    settle(task, task.controller.signal.aborted ? "cancelled" : "failed", error.message);
    if (task.state.status === "manual") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    return new Response("Download failed", { status: 502, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  }).finally(() => { clearTimeout(task.responseTimer); }));
});
