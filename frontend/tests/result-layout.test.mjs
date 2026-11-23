import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transformWithEsbuild } from 'vite';
import { createRenderer, h, markRaw, nextTick, ref } from 'vue';
import * as youtubeHelperCore from '../src/utils/youtubeHelperCore.js';
import { loadSfc } from './helpers/loadSfc.mjs';

const require = createRequire(import.meta.url);
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};
let ResultSection, ExtensionDownloadModal, useVideoSelection, validateMediaEnvelope;
before(async () => {
  const modules = {
    '../services/apiConfig': { apiConfig: { baseUrl: '' } },
    '../utils/youtubeHelperCore': youtubeHelperCore,
  };
  for (const id of [
    '../utils/mediaSources',
    '../utils/mediaContract',
    '../core/media/cdnTransportHints',
    '../core/media/variantSort',
    '../core/media/layoutAndFilename',
    '../extension/hostWhitelist',
    '../extension/dashMuxSpec',
    '../core/media/muxSpec',
    '../core/media/index',
    '../composables/useVideoSelection',
  ]) {
    const utilities = await readFile(new URL(`../src/${id.slice(3)}.ts`, import.meta.url), 'utf8');
    const module = { exports: {} };
    const compiled = await transformWithEsbuild(utilities, `${id}.ts`, { loader: 'ts', format: 'cjs' });
    new Function('require', 'module', 'exports', compiled.code)(
      (reqId) => {
        if (modules[reqId]) return modules[reqId];
        if (reqId === '../core/media' && modules['../core/media/index']) return modules['../core/media/index'];
        if (reqId === './cdnTransportHints') return modules['../core/media/cdnTransportHints'];
        if (reqId === './variantSort') return modules['../core/media/variantSort'];
        if (reqId === './layoutAndFilename') return modules['../core/media/layoutAndFilename'];
        if (reqId === './muxSpec') return modules['../core/media/muxSpec'];
        if (reqId === '../../utils/mediaContract') return modules['../utils/mediaContract'];
        if (reqId === '../../utils/mediaSources') return modules['../utils/mediaSources'];
        if (reqId === '../../extension/hostWhitelist') return modules['../extension/hostWhitelist'];
        if (reqId === '../../extension/dashMuxSpec') return modules['../extension/dashMuxSpec'];
        return require(reqId);
      },
      module,
      module.exports,
    );
    modules[id] = module.exports;
  }
  modules['../core/media'] = modules['../core/media/index'];
  ({ useVideoSelection } = modules['../composables/useVideoSelection']);
  ({ validateMediaEnvelope } = modules['../utils/mediaContract']);
  ResultSection = await loadSfc(
    new URL('../src/components/ResultSection.vue', import.meta.url),
    {
      modules: {
        ...modules,
        './AppIcon.vue': { default: { render: (_, { attrs }) => h('i', attrs) } },
        './VideoPlaylist.vue': { default: { render: () => h('div', { class: 'test-playlist' }) } },
      },
    },
  );
  ExtensionDownloadModal = await loadSfc(
    new URL('../src/components/ExtensionDownloadModal.vue', import.meta.url),
  );
});
after(() => Object.assign(globalThis, originalGlobals));

const fileVariant = (id, url, metadata = {}) => ({
  id, metadata, delivery: { kind: 'file', sources: [{ url, size_bytes: 3000000 }] },
});
const fileItem = (id, type, url) => ({
  id, type, variants: [fileVariant('main', url)], default: { variant_id: 'main', url },
});
const videoItem = {
  ...fileItem('video-1', 'video', 'https://media.test/main.mp4'),
  variants: [
    fileVariant('main', 'https://media.test/main.mp4', { width: 1080, height: 1920, video_codec: 'h264', bitrate_bps: 1000000, duration_ms: 24000 }),
    fileVariant('small', 'https://media.test/small.mp4', { width: 720, height: 1280 }),
  ],
};
const imageItem = fileItem('image-1', 'image', 'https://media.test/photo.jpg');
const liveItem = {
  id: 'live-1', type: 'live_photo', default: null, default_unavailable_reason: 'processing_required',
  variants: [{ id: 'live-pair', delivery: { kind: 'pair', resources: [
    { id: 'cover', role: 'image', delivery: { kind: 'file', sources: [{ url: 'https://media.test/photo.jpg' }] } },
    { id: 'motion', role: 'motion', delivery: { kind: 'file', sources: [{ url: 'https://media.test/live.mp4' }] } },
  ] } }],
};
const video = {
  platform: 'douyin', title: '作品标题', source_url: 'https://www.douyin.com/video/123',
  items: [videoItem], default_item_id: videoItem.id, author: { name: '作者', id: '123' },
  attachments: [{ id: 'music', role: 'background_audio', title: '配乐', resource: {
    id: 'audio', role: 'audio', delivery: { kind: 'file', sources: [{ url: 'https://media.test/music.mp3' }] },
  } }],
  statistics: { likes: { value: 123, state: 'known' } }, tags: ['标签'],
};
const hasClass = (node, name) => String(node.props.class || '').split(' ').includes(name);

// This renderer supplies measured dimensions rather than a CSS engine. It tests
// which panel controls the baseline, reactive updates, and lifecycle cleanup;
// actual flex sizing/scrollbars remain browser acceptance checks.
async function mount(data = video, desktop = true) {
  const dimensions = { details: 440, tabs: 44, author: 100, width: 380 };
  const listeners = new Map();
  const mediaListeners = new Set();
  const frames = new Map();
  const observers = [];
  let nextFrame = 0;
  let reads = 0;
  const mediaQuery = {
    matches: desktop,
    addEventListener: (_, callback) => mediaListeners.add(callback),
    removeEventListener: (_, callback) => mediaListeners.delete(callback),
  };
  globalThis.window = {
    innerWidth: desktop ? 1280 : 390,
    matchMedia: () => mediaQuery,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle(node) {
      return {
        transitionDelay: '0s',
        transitionDuration: '0s',
        animationDelay: '0s',
        animationDuration: '0s',
        ...(hasClass(node, 'rs-info-col')
          ? { rowGap: '16px' }
          : { borderTopWidth: '1px', borderBottomWidth: '1px' }),
      };
    },
    ResizeObserver: class {
      nodes = new Set();
      disconnects = 0;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(node) { this.nodes.add(node); }
      disconnect() { this.nodes.clear(); this.disconnects++; }
    },
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.document = { body: { style: {}, offsetHeight: 0 } };
  const element = (type, text = '') => markRaw({ type, text, props: {}, children: [], parent: null, style: {},
    ownerDocument: globalThis.document,
    classList: { add() {}, remove() {} },
    addEventListener() {}, removeEventListener() {},
    removeAttribute() {}, getAttribute(name) { return this.props[name]; },
    getBoundingClientRect() {
      reads++;
      const height = hasClass(this, 'rs-tab-panel--details') ? dimensions.details
        : hasClass(this, 'rs-tabs') ? dimensions.tabs : hasClass(this, 'rs-card--author') ? dimensions.author : 0;
      return { width: dimensions.width, height };
    },
  });
  const detach = node => {
    if (!node) return;
    if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node);
    node.parent = null;
  };
  const portal = element('portal');
  const renderer = createRenderer({
    querySelector: () => portal,
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) { detach(node); node.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); },
    remove: detach,
    patchProp(node, key, _, value) { node.props[key] = value; if (key === 'src') node.src = value; },
  });
  validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data });
  const state = ref({ resultData: data, resultVersion: 1,
    locale: 'zh-CN', formatNumber: String, formatDuration: String,
    onSwitchVideo(choice) { selection.choose(choice); },
  });
  const selection = markRaw(useVideoSelection({ videoStore: { get resultData() { return state.value.resultData; } } }));
  selection.syncResult();
  state.value.selection = selection;
  const root = element('root');
  const app = renderer.createApp({ render: () => h(ResultSection, state.value) });
  const findAll = (node, match) => [...(match(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, match))];
  const elements = className => findAll(root, node => hasClass(node, className));
  const text = node => [node.text, ...node.children.map(text)].join('');
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await nextTick();
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback());
    }
    await nextTick();
    assert.equal(frames.size, 0, 'measurements must settle instead of scheduling an update loop');
  };
  app.mount(root);
  await flush();
  return {
    app, state, dimensions, observers, frames, mediaListeners, listeners, elements, flush,
    root, portal,
    findAll: (pred, scope = root) => findAll(scope, pred),
    portalFindAll: (pred) => findAll(portal, pred),
    reads: () => reads,
    main: () => elements('rs-main')[0],
    details: () => elements('rs-tab-panel--details')[0],
    baseline: () => ({ ...elements('rs-main')[0].props.style }),
    async tab(label) {
      const tab = elements('rs-tab').find(node => text(node) === label);
      assert.ok(tab, `expected tab ${label}`); tab.props.onClick(); await flush();
    },
    async viewport(nextDesktop) {
      mediaQuery.matches = nextDesktop;
      window.innerWidth = nextDesktop ? 1280 : 390;
      for (const listener of mediaListeners) listener({ matches: nextDesktop });
      for (const listener of listeners.get('resize') || []) listener();
      await flush();
    },
    async resize() { observers.forEach(observer => observer.callback()); await flush(); },
  };
}

test('desktop single-video tabs use the natural details and author height, never the selected panel', async () => {
  const view = await mount();
  try {
    const baseline = { '--rs-details-card-height': '486px', '--rs-details-column-height': '602px' };
    assert.deepEqual(view.baseline(), baseline);
    const details = view.details();
    for (const tab of ['数据', '画质选项', '标签', '音乐']) {
      await view.tab(tab);
      assert.deepEqual(view.baseline(), baseline);
      assert.ok(hasClass(view.main(), 'rs-main--align-details'));
      assert.equal(view.details(), details, 'one stable details panel is used rather than duplicate interactive content');
      assert.ok(hasClass(details, 'rs-tab-panel--measure'));
      assert.equal(details.props['aria-hidden'], 'true');
      assert.equal(details.props.inert, '');
    }
    await view.tab('详情');
    assert.deepEqual(view.baseline(), baseline);
    assert.equal(view.details().props['aria-hidden'], undefined);
    assert.equal(view.details().props.inert, undefined);
    assert.ok(!hasClass(view.details(), 'rs-tab-panel--measure'));
  } finally { view.app.unmount(); }
});

test('hidden details remeasure on language, selected quality, title wrapping and author changes', async () => {
  const view = await mount();
  try {
    await view.tab('画质选项');
    view.dimensions.details = 510;
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '672px');
    view.dimensions.details = 390;
    view.elements('rs-backup-item')[1].props.onClick();
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '552px');
    assert.equal(view.elements('rs-backup-playing')[0].parent, view.elements('rs-backup-hd')[1], 'selection status stays in the heading row');
    view.dimensions.details = 650;
    view.state.value = { ...view.state.value, resultData: { ...video, title: '长标题 '.repeat(40) } };
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '812px');
    view.dimensions.width = 320;
    view.dimensions.details = 700;
    await view.resize();
    assert.equal(view.baseline()['--rs-details-column-height'], '862px');
    view.dimensions.author = 140;
    await view.resize();
    assert.equal(view.baseline()['--rs-details-column-height'], '902px');
    view.state.value = { ...view.state.value, resultData: { ...video, author: undefined } };
    await view.flush();
    assert.equal(view.elements('rs-card--author').length, 0);
    assert.deepEqual(view.baseline(), { '--rs-details-card-height': '746px', '--rs-details-column-height': '746px' });
    view.dimensions.details = 400;
    view.dimensions.author = 100;
    view.state.value = { ...view.state.value, resultVersion: 2,
      resultData: { ...video, source_url: 'https://www.douyin.com/video/456' } };
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '562px', 'a new result replaces the previous baseline');
    assert.ok(!hasClass(view.details(), 'rs-tab-panel--measure'), 'a new result opens its visible details');
  } finally { view.app.unmount(); }
});

test('mobile stays in natural flow and entering desktop while another tab is open measures fresh details', async () => {
  const view = await mount(video, false);
  try {
    assert.deepEqual(view.baseline(), {});
    assert.ok(!hasClass(view.main(), 'rs-main--align-details'));
    await view.tab('音乐');
    assert.equal(view.details(), undefined, 'mobile does not retain a hidden measurement panel');
    await view.viewport(true);
    assert.equal(view.baseline()['--rs-details-column-height'], '602px');
    assert.ok(hasClass(view.details(), 'rs-tab-panel--measure'));
    await view.viewport(false);
    assert.deepEqual(view.baseline(), {});
    assert.equal(view.details(), undefined);
    assert.equal(view.observers[0].nodes.size, 0);
  } finally { view.app.unmount(); }
});

test('mixed media, live photos and multi-episode results retain their existing natural layout', async () => {
  const view = await mount();
  try {
    const cases = [
      [{ items: [videoItem, imageItem] }, 'rs-card--gallery'],
      [{ items: [liveItem], default_item_id: liveItem.id }, 'rs-live-carousel'],
      [{ items: [videoItem, liveItem] }, 'rs-live-carousel'],
      [{ items: [videoItem, fileItem('video-2', 'video', 'https://media.test/part2.mp4')] }, 'test-playlist'],
      [{ groups: [{ id: 'collection', kind: 'collection', total_count: 2, item_ids: [videoItem.id] }] }, 'test-playlist'],
    ];
    for (const [changes, mediaClass] of cases) {
      view.state.value = { ...view.state.value, resultData: { ...video, ...changes } };
      validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: view.state.value.resultData });
      view.state.value.selection.syncResult();
      await view.flush();
      assert.deepEqual(view.baseline(), {});
      assert.ok(!hasClass(view.main(), 'rs-main--align-details'));
      assert.equal(view.observers[0].nodes.size, 0);
      assert.ok(view.elements(mediaClass).length, `existing ${mediaClass} branch still renders`);
      await view.tab('数据');
      assert.equal(view.details(), undefined);
    }
    view.state.value = { ...view.state.value, resultData: video };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '602px');
  } finally { view.app.unmount(); }
});

test('unmount cancels queued work and detaches layout observers and listeners', async () => {
  const view = await mount();
  view.observers[0].callback();
  await nextTick();
  assert.equal(view.frames.size, 1);
  const reads = view.reads();
  view.app.unmount();
  assert.equal(view.frames.size, 0);
  assert.equal(view.mediaListeners.size, 0);
  assert.equal(view.listeners.get('resize').size, 0);
  assert.equal(view.observers[0].nodes.size, 0);
  view.observers[0].callback();
  await view.flush();
  assert.equal(view.reads(), reads, 'late observer callbacks cannot measure a removed result');
});

test('no-default item with selectable variants enables 请先选择画质 CTA to open quality picker without auto-selecting, then switches to 下载视频 once chosen', async () => {
  const hlsOnlyItem = {
    id: 'video-hls-1',
    type: 'video',
    default: null,
    default_unavailable_reason: 'processing_required',
    variants: [
      {
        id: 'hls-720p',
        label: '720p',
        metadata: { width: 1280, height: 720, video_codec: 'h264', evidence: 'upstream' },
        delivery: { kind: 'hls', scope: 'single', output: { container: 'mp4', extension: 'mp4' }, sources: [{ id: 's0', url: 'https://media.test/720p.m3u8' }] },
      },
      {
        id: 'hls-480p',
        label: '480p',
        metadata: { width: 854, height: 480, video_codec: 'h264', evidence: 'upstream' },
        delivery: { kind: 'hls', scope: 'single', output: { container: 'mp4', extension: 'mp4' }, sources: [{ id: 's1', url: 'https://media.test/480p.m3u8' }] },
      },
    ],
  };
  const hlsData = { ...video, items: [hlsOnlyItem], default_item_id: hlsOnlyItem.id };
  const view = await mount(hlsData);
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  let downloadCalls = 0;
  let promptCalls = 0;
  view.state.value = {
    ...view.state.value,
    onDownloadMain() { downloadCalls++; },
    onPromptSelectQuality() { promptCalls++; },
  };
  await view.flush();
  try {
    // 1. Unified-v1 rule: useVideoSelection must NOT silently auto-select a non-default variant
    assert.equal(view.state.value.selection.currentSelection.value, null);
    assert.equal(view.state.value.selection.currentTarget.value.kind, 'unsupported');

    // 2. Primary CTA is enabled and labeled 请先选择画质 instead of a silent disabled 下载视频
    const primaryBtn = () => view.elements('rs-btn--primary')[0];
    assert.equal(Boolean(primaryBtn().props.disabled), false);
    assert.equal(primaryBtn().props['data-select-quality-first'], true);
    assert.equal(textOf(primaryBtn()), '请先选择画质');
    assert.equal(view.elements('rs-backup-item').length, 0, 'starts on details tab');

    // 3. Clicking 请先选择画质 opens the quality tab and emits prompt-select-quality WITHOUT starting an unchosen download
    primaryBtn().props.onClick();
    await view.flush();
    assert.equal(downloadCalls, 0, 'must never start an unchosen download');
    assert.equal(promptCalls, 1, 'emits prompt-select-quality guidance');
    assert.equal(view.state.value.selection.currentSelection.value, null, 'still no implicit selection');
    assert.equal(view.elements('rs-backup-item').length, 2, 'switches activeTab to quality picker');

    // 4. Once user explicitly picks 480p, primary CTA immediately turns into 下载视频 and triggers download-main on click
    view.elements('rs-backup-item')[1].props.onClick();
    await view.flush();
    assert.deepEqual(view.state.value.selection.currentSelection.value, { variant_id: 'hls-480p' });
    assert.equal(Boolean(primaryBtn().props.disabled), false);
    assert.equal(primaryBtn().props['data-select-quality-first'], undefined);
    assert.equal(textOf(primaryBtn()), '下载视频');

    primaryBtn().props.onClick();
    await view.flush();
    assert.equal(downloadCalls, 1);

    // 5. Conversely, if no variant is downloadable (e.g. only unsupported adaptive dash), primary CTA stays disabled
    const noDownloadableItem = {
      id: 'video-dash-only',
      type: 'video',
      default: null,
      default_unavailable_reason: 'processing_required',
      variants: [
        {
          id: 'dash-1080p',
          label: '1080p',
          delivery: { kind: 'dash', scope: 'adaptive', sources: [{ id: 's0', url: 'https://media.test/manifest.mpd' }] },
        },
      ],
    };
    view.state.value = {
      ...view.state.value,
      resultVersion: 2,
      resultData: { ...video, items: [noDownloadableItem], default_item_id: noDownloadableItem.id },
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: view.state.value.resultData });
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(Boolean(primaryBtn().props.disabled), true);
    assert.equal(textOf(primaryBtn()), '下载视频');
  } finally {
    view.app.unmount();
  }
});

test('quality selection badge shows 当前已选 / Selected across platforms and YouTube ready layout slims top banner while keeping pure Scheme A quality cards', async () => {
  const ytVideo4kUrl = 'https://rr1---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&itag=401&id=o-test4k';
  const ytVideo1080Url = 'https://rr1---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&itag=299&id=o-test1080';
  const ytVideo360Url = 'https://rr1---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&itag=18&id=o-test360&title=Sample_360p';
  const ytAudioM4aUrl = 'https://rr1---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&itag=140&id=o-testm4a';
  const ytItem = {
    id: 'video-yt-layout',
    type: 'video',
    default: { variant_id: 'v-360', source_id: 's-360', url: ytVideo360Url },
    variants: [
      {
        id: 'v-4k',
        label: '2026p60 (4K · 仅视频无声)',
        metadata: { width: 3840, height: 2026, fps: 60, has_audio: false, video_codec: 'av01.0.13M.08', container: 'mp4', extension: 'mp4', mime_type: 'video/mp4', evidence: 'upstream' },
        delivery: { kind: 'file', sources: [{ id: 's-4k', url: ytVideo4kUrl, size_bytes: 90000000 }] },
      },
      {
        id: 'v-4k-tier-only',
        label: '4K (仅视频无声)',
        metadata: { width: 3840, height: 2160, fps: 30, has_audio: false, video_codec: 'avc1.640033', container: 'mp4', extension: 'mp4', mime_type: 'video/mp4', evidence: 'upstream' },
        delivery: { kind: 'file', sources: [{ id: 's-4k-tier', url: ytVideo1080Url, size_bytes: 80000000 }] },
      },
      {
        id: 'v-360',
        label: '360p (含音频)',
        metadata: { width: 640, height: 360, has_audio: true, video_codec: 'avc1.42001E', container: 'mp4', extension: 'mp4', mime_type: 'video/mp4', evidence: 'upstream' },
        delivery: { kind: 'file', sources: [{ id: 's-360', url: ytVideo360Url, size_bytes: 12000000 }] },
      },
      {
        id: 'v-audio-m4a',
        label: '仅音频 M4A (128 kbps)',
        metadata: { has_audio: true, audio_codec: 'mp4a.40.2', container: 'm4a', extension: 'm4a', mime_type: 'audio/mp4', evidence: 'upstream' },
        delivery: { kind: 'file', sources: [{ id: 's-audio-m4a', url: ytAudioM4aUrl, size_bytes: 7000000 }] },
      },
    ],
  };
  const ytData = {
    platform: 'youtube',
    title: 'YouTube UI Polish Test',
    source_url: 'https://www.youtube.com/watch?v=I9JvDaciaFk',
    items: [ytItem],
    default_item_id: ytItem.id,
    author: { name: 'Creator', id: 'creator' },
    extra: { youtube_helper: { status: 'ready', version: '1.3.2', script_url: '/helper/dokitool-youtube.user.js' } },
  };

  const view = await mount(ytData);
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  try {
    // Slimmed top status pill: no full-row .rs-yt-helper-notice banner
    assert.equal(view.elements('rs-yt-helper-notice').length, 0);
    const hint = view.elements('rs-header-hint')[0];
    assert.ok(hasClass(hint, 'rs-header-hint--ready'));
    assert.equal(textOf(hint), '助手 v1.3.2 已就绪 · 自动合成原声');
    assert.match(hint.props.title, /YouTube 助手 \(v1\.3\.2\)已就绪/);

    // Switch to Quality tab -> pure Scheme A cards (no .rs-backup-split-actions) and 当前已选 badge
    await view.tab('画质选项');
    assert.equal(view.elements('rs-backup-split-actions').length, 0);
    assert.equal(textOf(view.elements('rs-backup-playing')[0]), '当前已选');
    assert.deepEqual(view.elements('rs-backup-name').map(textOf), [
      '约 97.0 MB · 2026p60 (4K)',
      '约 87.0 MB · 4K',
      '12.0 MB · 360p (含音频)',
      '7.0 MB · 仅音频 M4A (128 kbps)',
    ]);

    // Select 2026p60 (4K) -> .rs-quality-tag shows silent-preview/audio-download hint and primary button shows 下载 4K 有声视频
    view.elements('rs-backup-item')[0].props.onClick();
    await view.flush();
    assert.equal(textOf(view.elements('rs-quality-tag')[0]), '2026p60 · 4K（预览无声 · 下载含音频）');
    assert.equal(textOf(view.elements('rs-btn--primary')[0]), '下载 4K 有声视频');
    assert.equal(view.elements('rs-btn--primary')[0].props['data-youtube-mux-save'], true);

    // Select 4K tier-only label -> no duplicate "4K · 4K" in .rs-quality-tag
    view.elements('rs-backup-item')[1].props.onClick();
    await view.flush();
    assert.equal(textOf(view.elements('rs-quality-tag')[0]), '4K（预览无声 · 下载含音频）');

    // Switch locale to English -> Selected badge, ~97.0 MB, English header pill, English .rs-quality-tag & primary CTA
    view.elements('rs-backup-item')[0].props.onClick();
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(textOf(view.elements('rs-header-hint')[0]), 'Helper v1.3.2 Ready · Auto Audio Mux');
    assert.match(view.elements('rs-header-hint')[0].props.title, /YouTube Helper \(v1\.3\.2\) is ready/);
    assert.equal(textOf(view.elements('rs-backup-playing')[0]), 'Selected');
    assert.equal(textOf(view.elements('rs-backup-name')[0]), '~97.0 MB · 2026p60 (4K)');
    assert.equal(textOf(view.elements('rs-quality-tag')[0]), '2026p60 · 4K (Silent preview · Audio included on download)');
    assert.equal(textOf(view.elements('rs-btn--primary')[0]), 'Download 4K Video with Audio');
  } finally {
    view.app.unmount();
  }
});

test('single-P Bilibili video with 1-item parts group stays pure single-video mode and ignores raw mmexport item title in details', async () => {
  const singlePartBili = {
    platform: 'bilibili',
    content_id: 'BV1SingleP01',
    title: '【教程】本地无损工作流搭建指南',
    source_url: 'https://www.bilibili.com/video/BV1SingleP01',
    items: [
      {
        ...videoItem,
        id: 'BV1SingleP01-p1',
        title: 'mmexport1794208831102.mp4',
      },
    ],
    default_item_id: 'BV1SingleP01-p1',
    groups: [
      {
        id: 'parts',
        kind: 'multipart',
        title: '分P',
        total_count: 1,
        item_ids: ['BV1SingleP01-p1'],
      },
    ],
    author: { name: '教程UP主', id: '101' },
  };
  const view = await mount(singlePartBili);
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  try {
    assert.equal(view.state.value.selection.hasCollections.value, false, 'single-item parts group must not set hasCollections');
    assert.equal(view.state.value.selection.isMulti.value, false, 'single-P Bilibili video must not trigger isMulti');
    assert.equal(view.elements('test-playlist').length, 0, 'single-P video must not render playlist card');
    assert.equal(view.elements('rs-btn--accent').length, 0, 'single-P video must not render 下载全部 button');
    assert.equal(textOf(view.elements('rs-header-badge--video')[0]), '视频');
    assert.equal(view.baseline()['--rs-details-column-height'], '602px', 'single-P video retains desktop details alignment');
    const infoVals = view.elements('rs-info-val').map(textOf);
    assert.equal(infoVals[0], '【教程】本地无损工作流搭建指南', 'single-video details title prioritizes media.title over mmexport item.title');
    assert.equal(infoVals.some(v => v.includes('mmexport')), false);
  } finally {
    view.app.unmount();
  }
});

test('Bilibili DASH mux variants: uncluttered uninstalled state (no purple banner, no greyed 1080p placeholders, single-line bottom hint) and connected extension state (unlocks 1080p, hides install prompts, shows 扩展已连接)', async () => {
  const durlUrl = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/durl-720p.mp4';
  const biliAudioResource = {
    id: 'audio',
    role: 'audio',
    metadata: { audio_codec: 'mp4a.40.2', audio_bitrate_bps: 203000, evidence: 'upstream' },
    delivery: {
      kind: 'file',
      sources: [{ id: 'a-30280', url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/audio-30280.m4s' }],
    },
  };
  const makeBiliMuxVariant = (id, codec, bitrate, opts = {}) => {
    const { width = 1920, height = 1080, label = '1080p' } = opts;
    const videoMeta = {
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      fps: 30,
      video_codec: codec,
      video_bitrate_bps: bitrate,
      evidence: 'upstream',
    };
    return {
      id,
      label,
      metadata: {
        ...videoMeta,
        audio_codec: 'mp4a.40.2',
        audio_bitrate_bps: 203000,
        has_audio: true,
        container: 'mp4',
        extension: 'mp4',
        mime_type: 'video/mp4',
      },
      delivery: {
        kind: 'mux',
        output: { container: 'mp4', extension: 'mp4', mime_type: 'video/mp4' },
        resources: [
          {
            id: 'video',
            role: 'video',
            metadata: videoMeta,
            delivery: {
              kind: 'file',
              sources: [{ id: `v-${id}`, url: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/${id}.m4s` }],
            },
          },
          structuredClone(biliAudioResource),
        ],
      },
    };
  };
  const biliItem = {
    id: 'BV1GJ411x7h7-p1',
    type: 'video',
    title: 'mmexport1794208831102.mp4',
    duration_ms: 212000,
    default: { variant_id: 'durl-720p', source_id: 's-durl', url: durlUrl },
    variants: [
      {
        id: 'durl-720p',
        label: '720p',
        metadata: {
          width: 1280,
          height: 720,
          video_codec: 'avc1.64001F',
          audio_codec: 'mp4a.40.2',
          has_audio: true,
          container: 'mp4',
          extension: 'mp4',
          mime_type: 'video/mp4',
          evidence: 'upstream',
        },
        delivery: { kind: 'file', sources: [{ id: 's-durl', url: durlUrl, size_bytes: 51900000 }] },
      },
      makeBiliMuxVariant('mux-1080p-avc', 'avc1.640032', 2630000),
      makeBiliMuxVariant('mux-1080p-hevc', 'hev1.1.6.L120.90', 1850000),
      makeBiliMuxVariant('mux-1080p-av1', 'av01.0.08M.08', 1520000),
    ],
    higher_quality_variants: [
      { variant_id: 'mux-1080p-avc', requires: ['mux'] },
      { variant_id: 'mux-1080p-hevc', requires: ['mux'] },
      { variant_id: 'mux-1080p-av1', requires: ['mux'] },
    ],
  };
  const biliData = {
    platform: 'bilibili',
    content_id: 'BV1GJ411x7h7',
    title: 'B站 1080P（免登录）DASH 测试作品',
    source_url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    items: [biliItem],
    default_item_id: biliItem.id,
    groups: [{ id: 'parts', kind: 'multipart', total_count: 1, item_ids: [biliItem.id] }],
    author: { name: 'UP主', id: '42' },
  };

  // --- PART A: Extension NOT installed ---
  const prevChrome = globalThis.chrome;
  delete globalThis.chrome;

  const view = await mount(biliData);
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  let openExtensionCalls = 0;
  let downloadMainCalls = 0;
  let downloadMusicCalls = 0;
  view.state.value = {
    ...view.state.value,
    onOpenExtension() { openExtensionCalls++; },
    onDownloadMain() { downloadMainCalls++; },
    onDownloadMusic() { downloadMusicCalls++; },
  };
  await view.flush();

  try {
    // 1. Single-P Bilibili video stays single-video mode, durl 720p stays active default
    assert.equal(view.state.value.selection.isMulti.value, false);
    assert.equal(view.state.value.selection.currentTarget.value.kind, 'file');
    assert.equal(view.state.value.selection.currentTarget.value.url, durlUrl);
    assert.equal(view.elements('rs-video')[0].props.src, durlUrl);
    const primaryBtn = () => view.elements('rs-btn--primary')[0];
    assert.equal(Boolean(primaryBtn().props.disabled), false);
    assert.equal(textOf(primaryBtn()), '下载视频');
    primaryBtn().props.onClick();
    await view.flush();
    assert.equal(downloadMainCalls, 1);

    // 2. Redundant large purple banner below video player is GONE; bottom retains ONLY single-line lightweight hint
    assert.equal(view.elements('rs-bili-dash-callout').length, 0, 'large purple banner below player must be removed');
    assert.equal(view.elements('rs-header-hint--ext').length, 0, 'no connected badge when uninstalled');
    const bottomHints = view.elements('rs-ext-hint');
    assert.equal(bottomHints.length, 1, 'bottom shows single-line lightweight install hint');
    const hintText = textOf(bottomHints[0]);
    assert.ok(hintText.includes('1080p'), `expected 1080p in hint, got: ${hintText}`);
    assert.ok(hintText.includes('安装 Chrome 扩展'), `expected install CTA in hint, got: ${hintText}`);
    const hintCta = view.elements('rs-ext-hint-link')[0];
    hintCta.props.onClick();
    await view.flush();
    assert.equal(openExtensionCalls, 1);
    assert.equal(view.state.value.selection.currentTarget.value.url, durlUrl);

    // 3. Quality tab shows ONLY directly downloadable 720p — zero purple box, zero 3 greyed-out 1080p placeholders!
    await view.tab('画质选项');
    assert.equal(view.elements('rs-bili-dash-quality-card').length, 0, 'purple guidance card in quality tab must be removed');
    assert.equal(view.elements('rs-bili-mux-trigger').length, 0, 'unclickable 1080p placeholders must be removed');
    assert.equal(view.elements('rs-other-versions').length, 0, 'no redundant other-versions dropdown for hidden DASH tiers');
    assert.equal(view.elements('rs-higher-quality-note').length, 0);
    assert.equal(view.elements('rs-backup-item').length, 1, 'only directly downloadable 720p shown when uninstalled');
    assert.ok(textOf(view.elements('rs-backup-item')[0]).includes('720p'));

    // 4. English locale renders clean single-line hint
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    const enHintText = textOf(view.elements('rs-ext-hint')[0]);
    assert.ok(enHintText.includes('1080p'));
    assert.ok(enHintText.includes('Install Chrome Extension'));

    // 5. Capability-driven mux detection: ANY platform with delivery.kind === "mux" shows .rs-ext-hint,
    // while a payload with higher_quality_variants but NO mux variants shows .rs-higher-quality-note instead.
    const nonBiliMuxData = { ...biliData, platform: 'vimeo', groups: undefined };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: nonBiliMuxData });
    view.state.value = { ...view.state.value, resultVersion: 2, locale: 'zh-CN', resultData: nonBiliMuxData };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(view.elements('rs-ext-hint').length, 1, 'non-Bilibili platform with mux variants still offers extension lossless mux');

    const nonMuxHigherQualityData = {
      ...biliData,
      platform: 'douyin',
      groups: undefined,
      items: [{
        ...biliItem,
        variants: [
          biliItem.variants[0],
          {
            id: 'adaptive-4k-dash',
            label: '4K',
            metadata: { width: 3840, height: 2160, evidence: 'upstream' },
            delivery: {
              kind: 'dash',
              scope: 'adaptive',
              sources: [{ id: 's-mpd', url: 'https://media.test/master.mpd' }],
            },
          },
        ],
        higher_quality_variants: [{ variant_id: 'adaptive-4k-dash', requires: ['dash'] }],
      }],
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: nonMuxHigherQualityData });
    view.state.value = { ...view.state.value, resultVersion: 21, locale: 'zh-CN', resultData: nonMuxHigherQualityData };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(view.elements('rs-ext-hint').length, 0);
    await view.tab('画质选项');
    assert.equal(view.elements('rs-higher-quality-note').length, 1);

    // 6. Bilibili payload with only durl (no mux variants) shows NO extension install hint
    const durlOnlyBili = {
      ...biliData,
      items: [{ ...biliItem, variants: [biliItem.variants[0]], higher_quality_variants: undefined }],
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: durlOnlyBili });
    view.state.value = { ...view.state.value, resultVersion: 3, resultData: durlOnlyBili };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(view.elements('rs-ext-hint').length, 0);

    // 7. App.vue wires ResultSection @open-extension directly to lazy ExtensionDownloadModal state
    const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
    const resultTag = appSource.match(/<ResultSection[\s\S]*?\/>/)?.[0] || '';
    assert.match(resultTag, /@open-extension="showExtensionModal\s*=\s*true"/);
  } finally {
    view.app.unmount();
  }

  // --- PART B: Extension IS connected ---
  const pingCalls = [];
  globalThis.chrome = {
    runtime: {
      sendMessage(extId, msg, cb) {
        pingCalls.push({ extId, msg });
        if (msg?.type === 'WEB_EXT_PING') {
          cb({
            ok: true,
            data: {
              version: '4.1.0',
              extensionId: 'ihamkldlkdibleacagiejklpfofapkpo',
              capabilities: ['dash_mux', 'direct_download'],
            },
          });
        }
      },
    },
  };

  const connView = await mount(biliData);
  let connDownloadMainCalls = 0;
  let connDownloadMusicCalls = 0;
  connView.state.value = {
    ...connView.state.value,
    onDownloadMain() { connDownloadMainCalls++; },
    onDownloadMusic() { connDownloadMusicCalls++; },
  };
  await connView.flush();
  await new Promise(r => setTimeout(r, 15));
  await connView.flush();

  try {
    // 1. Handshake hit deterministic DOKITOOL_EXTENSION_ID
    assert.ok(pingCalls.length >= 1);
    assert.equal(pingCalls[0].extId, 'ihamkldlkdibleacagiejklpfofapkpo');
    assert.deepEqual(pingCalls[0].msg, { type: 'WEB_EXT_PING' });

    // 2. Subtle 扩展已连接 status indicator shown, ALL install prompts hidden!
    const connBadge = connView.elements('rs-header-hint--ext')[0];
    assert.ok(connBadge, 'expected subtle 扩展已连接 badge');
    assert.equal(connBadge.props['data-testid'], 'extension-connected-badge');
    assert.equal(textOf(connBadge), '扩展已连接');
    assert.equal(connView.elements('rs-ext-hint').length, 0, 'bottom install hint must be hidden when extension is connected');
    assert.equal(connView.elements('rs-bili-dash-callout').length, 0);

    // 3. Quality tab unlocks all 3 1080p DASH variants canonically sorted ABOVE 720p (H.264 > HEVC > AV1 > 720p)
    // AND automatically upgrades active selection to 1080p H.264 upon extension connect!
    await connView.tab('画质选项');
    const items = connView.elements('rs-backup-item');
    assert.equal(items.length, 4, '720p + 3 unlocked 1080p DASH variants should all be selectable');
    assert.equal(items[0].props['data-extension-mux'], true);
    assert.ok(textOf(items[0]).includes('1080p'));
    assert.ok(textOf(items[0]).includes('扩展无损合流'));
    assert.ok(textOf(items[0]).includes('当前已选'), 'top-ranked 1080p H.264 must be auto-selected on extension connect');
    assert.deepEqual(connView.state.value.selection.currentSelection.value, { variant_id: 'mux-1080p-avc' });
    assert.ok(textOf(items[3]).includes('720p'), '720p durl sorts after unlocked 1080p DASH options');

    // 4. Manual switch to 720p is respected; switching back to 1080p DASH keeps playable 720p <video> preview, enables primary 下载视频 CTA, and emits download-main!
    items[3].props.onClick();
    await connView.flush();
    assert.deepEqual(connView.state.value.selection.currentSelection.value, { variant_id: 'durl-720p' });
    assert.equal(connView.state.value.selection.hasManualChoice(biliItem.id), true);

    items[0].props.onClick();
    await connView.flush();
    assert.deepEqual(connView.state.value.selection.currentSelection.value, { variant_id: 'mux-1080p-avc' });
    assert.equal(connView.elements('rs-video')[0].props.src, durlUrl, 'video stage keeps playable durl fallback while 1080p DASH is selected');
    const mainBtn = connView.elements('rs-btn--primary')[0];
    assert.equal(Boolean(mainBtn.props.disabled), false, 'primary download button must stay enabled for unlocked 1080p DASH');
    assert.equal(mainBtn.props['data-extension-dash-mux-save'], true);
    assert.equal(textOf(mainBtn), '下载视频');
    const copyBtn = connView.elements('rs-btn--ghost-light')[0];
    assert.equal(Boolean(copyBtn.props.disabled), true, 'copy URL disabled for split DASH mux variant');
    mainBtn.props.onClick();
    await connView.flush();
    assert.equal(connDownloadMainCalls, 1);

    // 5. Music tab replaces install guide with direct extension audio save button
    await connView.tab('音乐');
    assert.equal(connView.elements('rs-bili-audio-guide').length, 0, 'install guide hidden in music tab when connected');
    const extAudioBox = connView.elements('rs-bili-audio-connected')[0];
    assert.ok(extAudioBox);
    const extAudioBtn = connView.elements('rs-btn--primary').find(b => b.props['data-bilibili-dash-audio-ext-download'] !== undefined);
    assert.ok(extAudioBtn);
    assert.ok(textOf(extAudioBtn).includes('通过扩展保存原声 M4A'));
    extAudioBtn.props.onClick();
    await connView.flush();
    assert.equal(connDownloadMusicCalls, 1);
  } finally {
    connView.app.unmount();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('Bilibili DASH audio attachment suppresses broken web <audio>/direct download in Music tab and guides to Chrome extension', async () => {
  const durlP1 = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p1_720p.mp4';
  const durlP2 = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p2_720p.mp4';
  const m4sAudioP1 = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p1_30280.m4s';
  const biliAudioAttachment = {
    id: 'bilibili-audio-BV1GJ411x7h7-p1',
    role: 'background_audio',
    title: '原声音频 (M4A)',
    resource: {
      id: 'audio-30280',
      role: 'audio',
      metadata: {
        audio_codec: 'mp4a.40.2',
        audio_bitrate_bps: 315000,
        container: 'm4a',
        extension: 'm4a',
        mime_type: 'audio/mp4',
        has_audio: true,
        evidence: 'upstream',
      },
      delivery: { kind: 'file', sources: [{ id: 'a1', url: m4sAudioP1 }] },
    },
  };
  const biliMultiData = {
    platform: 'bilibili',
    content_id: 'BV1GJ411x7h7',
    title: 'B站分P音频测试',
    source_url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    items: [
      {
        id: 'BV1GJ411x7h7-p1',
        type: 'video',
        title: 'P1',
        default: { variant_id: 'durl-p1', url: durlP1 },
        variants: [fileVariant('durl-p1', durlP1, { width: 1280, height: 720, has_audio: true })],
      },
      {
        id: 'BV1GJ411x7h7-p2',
        type: 'video',
        title: 'P2 无DASH',
        default: { variant_id: 'durl-p2', url: durlP2 },
        variants: [fileVariant('durl-p2', durlP2, { width: 1280, height: 720, has_audio: true })],
      },
    ],
    default_item_id: 'BV1GJ411x7h7-p1',
    attachments: [biliAudioAttachment],
    author: { name: 'UP主', id: '42' },
  };
  validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: biliMultiData });

  const view = await mount(biliMultiData);
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  let openExtensionCalls = 0;
  let downloadMusicCalls = 0;
  view.state.value = {
    ...view.state.value,
    onOpenExtension() { openExtensionCalls++; },
    onDownloadMusic() { downloadMusicCalls++; },
  };
  await view.flush();

  try {
    // 1. P1 Music tab shows Chrome extension CTA instead of raw <audio> or HTTP-403 direct download
    await view.tab('音乐');
    assert.equal(view.elements('rs-music-player').length, 0, 'must NOT render broken <audio> for Referer-protected Bilibili .m4s');
    const guides = view.elements('rs-bili-audio-guide');
    assert.equal(guides.length, 1);
    assert.ok(textOf(guides[0]).includes('来源头'));
    const cta = view.elements('rs-bili-audio-cta')[0];
    assert.ok(cta);
    assert.equal(cta.props['data-bilibili-dash-audio-cta'], '');
    assert.ok(textOf(cta).includes('安装 Chrome 扩展保存原声 M4A'));
    cta.props.onClick();
    await view.flush();
    assert.equal(openExtensionCalls, 1);
    assert.equal(downloadMusicCalls, 0, 'must NEVER trigger direct download-music on Bilibili DASH audio');

    // 2. English locale renders English copy
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.ok(textOf(view.elements('rs-bili-audio-cta')[0]).includes('Get Chrome Extension for M4A Audio'));

    // 3. Switching to P2 (durl-only) hides P1's part-scoped bilibili-audio attachment & falls back from Music tab
    view.state.value = { ...view.state.value, locale: 'zh-CN' };
    view.state.value.selection.selectIndex(1);
    await view.flush();
    assert.equal(
      view.elements('rs-tab').some(node => textOf(node) === '音乐'),
      false,
      'P2 without DASH must not inherit P1 bilibili-audio-* tab',
    );
    assert.equal(view.elements('rs-bili-audio-guide').length, 0);

    // 4. Non-Bilibili background_audio attachment (e.g. Douyin BGM) still renders native <audio> & Download button
    view.state.value = { ...view.state.value, resultVersion: 2, resultData: video };
    view.state.value.selection.syncResult();
    await view.flush();
    await view.tab('音乐');
    assert.equal(view.elements('rs-bili-audio-guide').length, 0);
    assert.equal(view.elements('rs-music-player').length, 1);
    assert.equal(view.elements('rs-music-player')[0].props.src, 'https://media.test/music.mp3');
    const musicDownloadBtn = view.elements('rs-music')[0].children.find(c => hasClass(c, 'rs-btn--primary'));
    assert.ok(musicDownloadBtn);
    musicDownloadBtn.props.onClick();
    await view.flush();
    assert.equal(downloadMusicCalls, 1);
  } finally {
    view.app.unmount();
  }
});

test('PR-C: ResultSection renders platform badge for built-in and long-tail platforms, supports multi-quality switching, and renders audio-only items accurately', async () => {
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  const findFirst = (nodes, pred) => {
    for (const node of nodes) {
      if (pred(node)) return node;
      const found = findFirst(node.children || [], pred);
      if (found) return found;
    }
    return null;
  };
  const classText = node => {
    const cls = node?.props?.class;
    if (Array.isArray(cls)) return cls.flat().join(' ');
    return String(cls || '');
  };

  // 1. Built-in platform badge (Douyin) in zh-CN & en
  const view = await mount(video);
  let downloadMainCalls = 0;
  view.state.value = {
    ...view.state.value,
    onDownloadMain() { downloadMainCalls++; },
  };
  await view.flush();
  try {
    const badge = () => view.elements('rs-header-badge--platform')[0];
    assert.ok(badge(), 'platform badge should render');
    assert.equal(badge().props['data-testid'], 'result-platform-badge');
    assert.equal(badge().props['data-platform'], 'douyin');
    assert.equal(badge().props['data-platform-builtin'], 'true');
    assert.equal(textOf(badge()), '抖音');
    assert.match(classText(findFirst([badge()], n => n.type === 'i')), /\bfa-music\b/);

    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(textOf(badge()), 'Douyin');

    // 2. Long-tail video platform (Vimeo) with multi-quality switching & direct download
    const vimeo1080 = 'https://vod.vimeo.test/123456/1080p.mp4';
    const vimeo720 = 'https://vod.vimeo.test/123456/720p.mp4';
    const vimeoData = {
      platform: 'vimeo',
      title: 'Vimeo Scenic Demo',
      source_url: 'https://vimeo.com/123456',
      items: [{
        id: 'vimeo-1',
        type: 'video',
        default: { variant_id: 'v-1080', url: vimeo1080 },
        variants: [
          fileVariant('v-1080', vimeo1080, { width: 1920, height: 1080, video_codec: 'h264', has_audio: true, container: 'mp4', extension: 'mp4', mime_type: 'video/mp4', evidence: 'upstream' }),
          fileVariant('v-720', vimeo720, { width: 1280, height: 720, video_codec: 'h264', has_audio: true, container: 'mp4', extension: 'mp4', mime_type: 'video/mp4', evidence: 'upstream' }),
        ],
      }],
      default_item_id: 'vimeo-1',
      author: { name: 'Filmmaker', id: 'filmmaker' },
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: vimeoData });
    view.state.value = { ...view.state.value, resultVersion: 2, locale: 'zh-CN', resultData: vimeoData };
    view.state.value.selection.syncResult();
    await view.flush();

    assert.equal(badge().props['data-testid'], 'result-platform-badge');
    assert.equal(badge().props['data-platform'], 'vimeo');
    assert.equal(badge().props['data-platform-builtin'], 'false');
    assert.equal(textOf(badge()), 'Vimeo');
    assert.ok(hasClass(badge(), 'rs-header-badge--platform-generic'));
    assert.match(classText(findFirst([badge()], n => n.type === 'i')), /\bfa-film\b/);
    assert.equal(view.elements('rs-video')[0].props.src, vimeo1080);
    assert.equal(view.baseline()['--rs-details-column-height'], '602px', 'desktop alignment baseline stays intact for long-tail video');

    await view.tab('画质选项');
    assert.equal(view.elements('rs-backup-item').length, 2);
    view.elements('rs-backup-item')[1].props.onClick();
    await view.flush();
    assert.equal(view.elements('rs-video')[0].props.src, vimeo720);
    view.elements('rs-btn--primary')[0].props.onClick();
    await view.flush();
    assert.equal(downloadMainCalls, 1);

    // 3. Unknown long-tail platform identifiers (site_9gag, custom_site)
    for (const [dynamicId, wantLabel] of [['site_9gag', '9GAG'], ['custom_site', 'Custom Site']]) {
      const dynamicData = { ...vimeoData, platform: dynamicId };
      validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: dynamicData });
      view.state.value = { ...view.state.value, resultVersion: view.state.value.resultVersion + 1, resultData: dynamicData };
      view.state.value.selection.syncResult();
      await view.flush();
      assert.equal(badge().props['data-platform'], dynamicId);
      assert.equal(badge().props['data-platform-builtin'], 'false');
      assert.equal(textOf(badge()), wantLabel);
      assert.match(classText(findFirst([badge()], n => n.type === 'i')), /\bfa-film\b/);
    }

    // 4. Audio-only long-tail platform (SoundCloud): renders <audio>, Audio mediaTypeBadge, Download Audio CTA, and SoundCloud badge
    const scAudioUrl = 'https://cdn.soundcloud.test/tracks/demo-320.mp3';
    const scData = {
      platform: 'soundcloud',
      title: 'Ambient Track',
      source_url: 'https://soundcloud.com/artist/track',
      items: [{
        id: 'audio-sc-1',
        type: 'audio',
        default: { variant_id: 'mp3-320', url: scAudioUrl },
        variants: [
          fileVariant('mp3-320', scAudioUrl, { has_audio: true, audio_codec: 'mp3', audio_bitrate_bps: 320000, container: 'mp3', extension: 'mp3', mime_type: 'audio/mpeg', evidence: 'upstream' }),
        ],
      }],
      default_item_id: 'audio-sc-1',
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: scData });
    view.state.value = { ...view.state.value, resultVersion: view.state.value.resultVersion + 1, locale: 'zh-CN', resultData: scData };
    view.state.value.selection.syncResult();
    await view.flush();

    assert.equal(badge().props['data-platform'], 'soundcloud');
    assert.equal(badge().props['data-platform-builtin'], 'false');
    assert.equal(textOf(badge()), 'SoundCloud');
    assert.match(classText(findFirst([badge()], n => n.type === 'i')), /\bfa-headphones\b/);

    const audioTypeBadge = view.elements('rs-header-badge--audio')[0];
    assert.ok(audioTypeBadge, 'audio items should render rs-header-badge--audio instead of video');
    assert.equal(textOf(audioTypeBadge), '音频');
    assert.equal(view.elements('rs-header-badge--video').length, 0);
    assert.equal(view.elements('rs-video').length, 0);
    assert.equal(view.elements('rs-music-player').length, 1);
    assert.equal(view.elements('rs-music-player')[0].props.src, scAudioUrl);
    assert.equal(textOf(view.elements('rs-btn--primary')[0]), '下载音频');

    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(textOf(view.elements('rs-header-badge--audio')[0]), 'Audio');
    assert.equal(textOf(view.elements('rs-btn--primary')[0]), 'Download Audio');
    view.elements('rs-btn--primary')[0].props.onClick();
    await view.flush();
    assert.equal(downloadMainCalls, 2);
  } finally {
    view.app.unmount();
  }
});

test('PR #34 Round 2: unwhitelisted Tier-2 mux NEVER renders extension M4A card/guide in Music tab (both uninstalled & connected) and protected audio copy is platform-neutral', async () => {
  const unwhitelistedTier2Data = {
    platform: 'vimeo',
    content_id: 'vimeo-unwhitelisted-1',
    title: 'Unwhitelisted Tier-2 Mux Demo',
    source_url: 'https://vimeo.com/999999',
    default_item_id: 't2-item-1',
    author: { name: 'Indie Creator', id: 'indie' },
    items: [
      {
        id: 't2-item-1',
        type: 'video',
        default: { variant_id: 'mp4-720', url: 'https://cdn-unwhitelisted.example.org/720p.mp4' },
        variants: [
          fileVariant('mp4-720', 'https://cdn-unwhitelisted.example.org/720p.mp4', {
            width: 1280,
            height: 720,
            video_codec: 'h264',
            has_audio: true,
            container: 'mp4',
            extension: 'mp4',
            mime_type: 'video/mp4',
            evidence: 'upstream',
          }),
          {
            id: 'mux-1080-unwhitelisted',
            label: '1080p',
            metadata: {
              width: 1920,
              height: 1080,
              video_codec: 'avc1.640028',
              audio_codec: 'mp4a.40.2',
              container: 'mp4',
              extension: 'mp4',
              mime_type: 'video/mp4',
              evidence: 'upstream',
            },
            delivery: {
              kind: 'mux',
              output: { container: 'mp4', extension: 'mp4', mime_type: 'video/mp4' },
              resources: [
                {
                  id: 'v-u',
                  role: 'video',
                  metadata: { width: 1920, height: 1080, evidence: 'upstream' },
                  delivery: {
                    kind: 'file',
                    sources: [{ id: 'sv-u', url: 'https://cdn-unwhitelisted.example.org/1080p.m4s' }],
                  },
                },
                {
                  id: 'a-u',
                  role: 'audio',
                  metadata: { audio_codec: 'mp4a.40.2', audio_bitrate_bps: 128000, evidence: 'upstream' },
                  delivery: {
                    kind: 'file',
                    sources: [
                      {
                        id: 'sa-u',
                        url: 'https://cdn-unwhitelisted.example.org/audio.m4s',
                        browser_fetch: 'blocked',
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: unwhitelistedTier2Data });
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');

  // 1) Uninstalled state: zero Music tab, zero extension guide, zero .rs-ext-hint
  const prevChrome = globalThis.chrome;
  delete globalThis.chrome;
  const uninstalledView = await mount(unwhitelistedTier2Data);
  try {
    assert.equal(uninstalledView.elements('rs-ext-hint').length, 0);
    assert.equal(
      uninstalledView.elements('rs-tab').some((n) => textOf(n).includes('音乐')),
      false,
      'unwhitelisted Tier-2 mux must NOT synthesize Music tab',
    );
    assert.equal(uninstalledView.elements('rs-bili-audio-guide').length, 0);
    assert.equal(uninstalledView.elements('rs-bili-audio-connected').length, 0);
  } finally {
    uninstalledView.app.unmount();
  }

  // 2) Connected extension state: STILL zero Music tab and zero false extension M4A card!
  globalThis.chrome = {
    runtime: {
      sendMessage(_extId, msg, cb) {
        if (msg?.type === 'WEB_EXT_PING') {
          cb({
            ok: true,
            data: {
              version: '4.1.0',
              extensionId: 'ihamkldlkdibleacagiejklpfofapkpo',
              capabilities: ['dash_mux', 'direct_download'],
            },
          });
        }
      },
    },
  };
  const connectedView = await mount(unwhitelistedTier2Data);
  await connectedView.flush();
  await new Promise((r) => setTimeout(r, 15));
  await connectedView.flush();
  try {
    assert.equal(
      connectedView.elements('rs-tab').some((n) => textOf(n).includes('音乐')),
      false,
      'connected extension must NOT synthesize unusable unwhitelisted Tier-2 mux audio in Music tab',
    );
    assert.equal(connectedView.elements('rs-bili-audio-connected').length, 0);
    assert.equal(connectedView.elements('rs-bili-audio-guide').length, 0);
  } finally {
    connectedView.app.unmount();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }

  // 3) Whitelisted protected mux audio (non-Bilibili platform) renders platform-neutral copy (no "B 站" hardcode)
  const genericProtectedAudioData = {
    platform: 'vimeo',
    content_id: 'vimeo-akamai-1',
    title: 'Akamai Protected Mux',
    source_url: 'https://vimeo.com/888888',
    default_item_id: 'ak-1',
    items: [
      {
        id: 'ak-1',
        type: 'video',
        default: { variant_id: 'mp4-720', url: 'https://vod-progressive.akamaized.net/720p.mp4' },
        variants: [
          fileVariant('mp4-720', 'https://vod-progressive.akamaized.net/720p.mp4', { width: 1280, height: 720, has_audio: true, evidence: 'upstream' }),
          {
            id: 'mux-1080-ak',
            label: '1080p',
            metadata: { width: 1920, height: 1080, evidence: 'upstream' },
            delivery: {
              kind: 'mux',
              output: { container: 'mp4', extension: 'mp4' },
              resources: [
                {
                  id: 'v-ak',
                  role: 'video',
                  delivery: { kind: 'file', sources: [{ id: 'sv-ak', url: 'https://vod-progressive.akamaized.net/1080.m4s' }] },
                },
                {
                  id: 'a-ak',
                  role: 'audio',
                  delivery: {
                    kind: 'file',
                    sources: [{ id: 'sa-ak', url: 'https://vod-progressive.akamaized.net/audio.m4s', browser_fetch: 'blocked' }],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: genericProtectedAudioData });
  delete globalThis.chrome;
  const protectedView = await mount(genericProtectedAudioData);
  try {
    await protectedView.tab('音乐');
    const guides = protectedView.elements('rs-bili-audio-guide');
    assert.equal(guides.length, 1);
    const guideText = textOf(guides[0]);
    assert.ok(guideText.includes('源站来源头'), `expected platform-neutral copy, got: ${guideText}`);
    assert.equal(guideText.includes('B 站'), false, 'protected audio guide must not hardcode B 站');
  } finally {
    protectedView.app.unmount();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('P1 PR-2: CapabilityUpgradeNotice renders non-blocking corner card (zero body scroll lock, extension-first CTA, collapsed legacy userscript, dismiss/reopen)', async () => {
  const prevChrome = globalThis.chrome;
  delete globalThis.chrome;

  const ytMissingData = {
    platform: 'youtube',
    content_id: 'I9JvDaciaFk',
    title: 'YouTube Corner Notice Test',
    source_url: 'https://www.youtube.com/watch?v=I9JvDaciaFk',
    default_item_id: 'yt-1',
    items: [
      {
        id: 'yt-1',
        type: 'video',
        state: 'unavailable',
        default: null,
        default_unavailable_reason: 'unavailable',
        error: { code: 'YOUTUBE_HELPER_REQUIRED', message: '需要本地解析能力' },
      },
    ],
    extra: {
      youtube_helper: {
        status: 'missing',
        min_version: '1.3.1',
        script_url: '/helper/dokitool-youtube.user.js',
        message: '需要本地解析能力',
      },
    },
  };
  validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: ytMissingData });

  const view = await mount(ytMissingData);
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  let openExtensionCalls = 0;
  let installHelperCalls = 0;
  let refreshPageCalls = 0;
  view.state.value = {
    ...view.state.value,
    needsManualHelperRefresh: false,
    onOpenExtension() { openExtensionCalls++; },
    onInstallYoutubeHelper() { installHelperCalls++; },
    onRefreshYoutubeHelperPage() { refreshPageCalls++; },
  };
  await view.flush();

  try {
    // 1. Non-blocking corner notice in portal with ZERO body scroll lock and ZERO modal dialog attrs
    assert.equal(globalThis.document.body.style.overflow || '', '', 'non-blocking corner notice must NOT lock body scroll');
    const notice = () => view.portalFindAll(n => 'data-capability-upgrade-notice' in n.props)[0];
    assert.ok(notice(), 'CapabilityUpgradeNotice should render in portal');
    assert.equal(notice().props['data-notice-mode'], 'client_session');
    assert.equal(notice().props.role, 'region');
    assert.equal(notice().props['aria-modal'], undefined);
    assert.equal(view.portalFindAll(n => 'data-yt-helper-modal' in n.props).length, 0);

    // 2. Primary CTA opens extension modal
    const primaryCta = view.portalFindAll(n => 'data-upgrade-open-extension' in n.props)[0];
    assert.ok(primaryCta);
    assert.equal(textOf(primaryCta), '安装 DokiTool 扩展（免油猴解锁 YouTube 4K60 & B 站 1080P）');
    primaryCta.props.onClick();
    await view.flush();
    assert.equal(openExtensionCalls, 1);

    // 3. Legacy userscript fallback starts collapsed with install link and no manual refresh button
    const legacyDetails = () => view.portalFindAll(n => 'data-legacy-userscript-fallback' in n.props)[0];
    assert.ok(legacyDetails());
    assert.equal(legacyDetails().props.open, undefined);
    assert.ok(textOf(legacyDetails()).includes('使用 Firefox 或旧版油猴脚本？'));
    const installLink = view.portalFindAll(n => 'data-yt-helper-install-link' in n.props)[0];
    assert.ok(installLink);
    assert.equal(installLink.props.href, '/helper/dokitool-youtube.user.js');
    installLink.props.onClick();
    await view.flush();
    assert.equal(installHelperCalls, 1);
    assert.equal(view.portalFindAll(n => 'data-yt-helper-manual-refresh' in n.props).length, 0);

    // 4. needsManualHelperRefresh opens <details> and exposes manual refresh button
    view.state.value = { ...view.state.value, needsManualHelperRefresh: true };
    await view.flush();
    assert.equal(legacyDetails().props.open, true);
    const refreshBtn = view.portalFindAll(n => 'data-yt-helper-manual-refresh' in n.props)[0];
    assert.ok(refreshBtn);
    assert.equal(textOf(refreshBtn), '刷新页面');
    refreshBtn.props.onClick();
    await view.flush();
    assert.equal(refreshPageCalls, 1);

    // 5. English locale copy
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(
      textOf(view.portalFindAll(n => 'data-upgrade-open-extension' in n.props)[0]),
      'Install DokiTool Extension (YouTube 4K60 & Bilibili 1080P)',
    );
    assert.ok(textOf(legacyDetails()).includes('Using Firefox or legacy userscript?'));
    assert.equal(
      textOf(view.portalFindAll(n => 'data-yt-helper-manual-refresh' in n.props)[0]),
      'Refresh Page',
    );

    // 6. Dismiss corner notice -> stage card shows updated reopen CTA (Install Extension / 安装扩展解锁) -> click reopens notice
    view.state.value = { ...view.state.value, locale: 'zh-CN' };
    await view.flush();
    const closeBtn = view.portalFindAll(n => 'data-capability-upgrade-close' in n.props)[0];
    assert.ok(closeBtn);
    closeBtn.props.onClick();
    await view.flush();
    assert.equal(notice(), undefined);

    const reopenBtn = () => view.findAll(n => 'data-yt-helper-reopen' in n.props)[0];
    assert.ok(reopenBtn(), 'reopen button should appear after dismissing corner notice');
    assert.equal(textOf(reopenBtn()), '安装扩展解锁');

    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(textOf(reopenBtn()), 'Install Extension');

    reopenBtn().props.onClick();
    await view.flush();
    assert.ok(notice(), 'clicking reopen button restores CapabilityUpgradeNotice');
  } finally {
    view.app.unmount();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('P1 PR-2: extension-update-badge pill renders when connected version 4.1.0 < 4.2.0, opens extension modal on click, and hides on 4.2.0', async () => {
  const prevChrome = globalThis.chrome;
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');

  const mockChromeVersion = (version) => {
    globalThis.chrome = {
      runtime: {
        sendMessage(_extId, msg, cb) {
          if (msg?.type === 'WEB_EXT_PING') {
            cb({
              ok: true,
              data: {
                version,
                extensionId: 'ihamkldlkdibleacagiejklpfofapkpo',
                capabilities: ['dash_mux', 'direct_download', 'youtube_parse', 'youtube_mux'],
              },
            });
          }
        },
      },
    };
  };

  // Case 1: Outdated installed extension (4.1.0 < 4.2.0) -> shows clickable extension-update-badge
  mockChromeVersion('4.1.0');
  const outdatedView = await mount(video);
  let openExtensionCalls = 0;
  outdatedView.state.value = {
    ...outdatedView.state.value,
    onOpenExtension() { openExtensionCalls++; },
  };
  await outdatedView.flush();
  await new Promise(r => setTimeout(r, 15));
  await outdatedView.flush();

  try {
    assert.equal(
      outdatedView.findAll(n => n.props['data-testid'] === 'extension-connected-badge').length,
      1,
    );
    const updateBadge = () =>
      outdatedView.findAll(n => n.props['data-testid'] === 'extension-update-badge')[0];
    assert.ok(updateBadge(), 'expected extension-update-badge when installed 4.1.0 < 4.2.0');
    assert.equal(textOf(updateBadge()), '有新版 v4.2.0');

    updateBadge().props.onClick();
    await outdatedView.flush();
    assert.equal(openExtensionCalls, 1);

    outdatedView.state.value = { ...outdatedView.state.value, locale: 'en' };
    await outdatedView.flush();
    assert.equal(textOf(updateBadge()), 'Update v4.2.0');
  } finally {
    outdatedView.app.unmount();
  }

  // Case 2: Up-to-date installed extension (4.2.0) -> hides extension-update-badge
  mockChromeVersion('4.2.0');
  const currentView = await mount(video);
  await currentView.flush();
  await new Promise(r => setTimeout(r, 15));
  await currentView.flush();

  try {
    assert.equal(
      currentView.findAll(n => n.props['data-testid'] === 'extension-connected-badge').length,
      1,
    );
    assert.equal(
      currentView.findAll(n => n.props['data-testid'] === 'extension-update-badge').length,
      0,
      'extension-update-badge must be hidden when installed extension is already 4.2.0',
    );
  } finally {
    currentView.app.unmount();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('P1 PR-2: extension-powered YouTube header ready status shows 免油猴无损合流 / No Userscript while preserving legacy userscript wording', async () => {
  const prevChrome = globalThis.chrome;
  delete globalThis.chrome;
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');

  const ytExtReadyData = {
    platform: 'youtube',
    title: 'YouTube Extension Bridge Ready',
    source_url: 'https://www.youtube.com/watch?v=I9JvDaciaFk',
    default_item_id: 'yt-ext-1',
    items: [fileItem('yt-ext-1', 'video', 'https://rr1---sn-ajoguc-5t.googlevideo.com/videoplayback?itag=18')],
    extra: {
      youtube_helper: {
        status: 'ready',
        provider: 'extension',
        extensionVersion: '4.2.0',
        version: '4.2.0',
      },
    },
  };
  validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: ytExtReadyData });

  const view = await mount(ytExtReadyData);
  try {
    const hint = () => view.elements('rs-header-hint')[0];
    assert.ok(hasClass(hint(), 'rs-header-hint--ready'));
    assert.equal(textOf(hint()), '扩展 v4.2.0 已就绪 · 免油猴无损合流');
    assert.match(hint().props.title, /DokiTool 扩展 \(v4\.2\.0\)已就绪/);

    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(textOf(hint()), 'Extension v4.2.0 Ready · No Userscript');
    assert.match(hint().props.title, /DokiTool Extension \(v4\.2\.0\) is ready/);

    // Versionless extension ready fallback
    const versionlessData = {
      ...ytExtReadyData,
      extra: { youtube_helper: { status: 'ready', provider: 'extension' } },
    };
    view.state.value = { ...view.state.value, resultVersion: 2, locale: 'zh-CN', resultData: versionlessData };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(textOf(hint()), '扩展已就绪 · 免油猴无损合流');

    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(textOf(hint()), 'Extension Ready · No Userscript');
  } finally {
    view.app.unmount();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('P1 PR-2: ExtensionDownloadModal displays v4.2.0 badge, 14+1000+ & Bilibili/YouTube mux copy, and legacy random-ID upgrade note in zh-CN & en', async () => {
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    getComputedStyle: () => ({
      transitionDelay: '0s',
      transitionDuration: '0s',
      animationDelay: '0s',
      animationDuration: '0s',
    }),
  };
  globalThis.requestAnimationFrame = (cb) => {
    cb();
    return 1;
  };
  const element = (type, text = '') =>
    markRaw({
      type,
      text,
      props: {},
      children: [],
      parent: null,
      style: {},
      classList: { add() {}, remove() {} },
      addEventListener() {},
      removeEventListener() {},
    });
  const detach = node => {
    if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node);
    node.parent = null;
  };
  const portal = element('portal');
  const renderer = createRenderer({
    querySelector: () => portal,
    createElement: element,
    createText: text => element('#text', text),
    createComment: text => element('#comment', text),
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) {
      detach(node);
      node.parent = parent;
      const idx = parent.children.indexOf(anchor);
      parent.children.splice(idx < 0 ? parent.children.length : idx, 0, node);
    },
    remove: detach,
    patchProp(node, key, _, value) { node.props[key] = value; },
  });
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  const locale = ref('zh-CN');
  const root = element('root');
  const app = renderer.createApp({
    render: () => h(ExtensionDownloadModal, { locale: locale.value }),
  });

  app.mount(root);
  await nextTick();
  try {
    const zhText = textOf(portal);
    assert.ok(zhText.includes('v4.2.0'), `expected v4.2.0 badge in zh-CN modal, got: ${zhText}`);
    assert.ok(zhText.includes('14 核心平台 + 1000+ 长尾站点'));
    assert.ok(zhText.includes('B 站 1080P & YouTube 4K60 免油猴本地无损合流'));
    assert.ok(zhText.includes('网页端自动联动'));
    assert.ok(zhText.includes('如之前安装过早期随机 ID 测试版，请先在 chrome://extensions 移除旧卡片再拖入一次；此后均可直接覆盖刷新升级。'));
    assert.ok(zhText.includes('零 Cookie、零网页脚本注入'));

    locale.value = 'en';
    await nextTick();
    const enText = textOf(portal);
    assert.ok(enText.includes('v4.2.0'), `expected v4.2.0 badge in en modal, got: ${enText}`);
    assert.ok(enText.includes('14 core platforms + 1,000+ long-tail sites'));
    assert.ok(enText.includes('Bilibili 1080P & YouTube 4K60 lossless local muxing without Tampermonkey'));
    assert.ok(enText.includes('automatic Web page handshake'));
    assert.ok(enText.includes('If you previously installed an early random-ID test build, remove the old card in chrome://extensions once before dragging the new folder; future updates only require overwriting and refreshing.'));
    assert.ok(enText.includes('Zero cookies, zero page script injection'));
  } finally {
    app.unmount();
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
  }
});
