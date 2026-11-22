import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transformWithEsbuild } from 'vite';
import { createRenderer, h, markRaw, nextTick, ref } from 'vue';
import * as youtubeHelperCore from '../src/utils/youtubeHelperCore.js';
import { loadSfc } from './helpers/loadSfc.mjs';

const require = createRequire(import.meta.url);
const originalGlobals = { window: globalThis.window, document: globalThis.document };
let ResultSection, useVideoSelection, validateMediaEnvelope;
before(async () => {
  const modules = {
    '../services/apiConfig': { apiConfig: { baseUrl: '' } },
    '../utils/youtubeHelperCore': youtubeHelperCore,
  };
  for (const id of ['../utils/mediaSources', '../utils/mediaContract', '../composables/useVideoSelection']) {
    const utilities = await readFile(new URL(`../src/${id.slice(3)}.ts`, import.meta.url), 'utf8');
    const module = { exports: {} };
    const compiled = await transformWithEsbuild(utilities, `${id}.ts`, { loader: 'ts', format: 'cjs' });
    new Function('require', 'module', 'exports', compiled.code)(id => modules[id] || require(id), module, module.exports);
    modules[id] = module.exports;
  }
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
      return hasClass(node, 'rs-info-col') ? { rowGap: '16px' }
        : { borderTopWidth: '1px', borderBottomWidth: '1px' };
    },
    ResizeObserver: class {
      nodes = new Set();
      disconnects = 0;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(node) { this.nodes.add(node); }
      disconnect() { this.nodes.clear(); this.disconnects++; }
    },
  };
  globalThis.document = { body: { style: {} } };
  const element = (type, text = '') => markRaw({ type, text, props: {}, children: [], parent: null, style: {},
    removeAttribute() {}, getAttribute(name) { return this.props[name]; },
    getBoundingClientRect() {
      reads++;
      const height = hasClass(this, 'rs-tab-panel--details') ? dimensions.details
        : hasClass(this, 'rs-tabs') ? dimensions.tabs : hasClass(this, 'rs-card--author') ? dimensions.author : 0;
      return { width: dimensions.width, height };
    },
  });
  const detach = node => {
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
      [{ groups: [{ id: 'collection', kind: 'collection', item_ids: [videoItem.id] }] }, 'test-playlist'],
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

test('Bilibili DASH mux variants preserve durl default, surface Chrome extension guidance with specs, emit open-extension, and stay hidden on non-Bilibili platforms', async () => {
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
    title: 'P1 高清测试',
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
    author: { name: 'UP主', id: '42' },
  };
  const forbiddenBitrateWording = new RegExp(
    ['\u9ad8\u7801\u7387', 'high(?:er)?' + '-bitrate'].join('|'),
    'i',
  );

  const view = await mount(biliData);
  const textOf = node => [node.text || '', ...(node.children || []).map(textOf)].join('');
  let openExtensionCalls = 0;
  let downloadMainCalls = 0;
  view.state.value = {
    ...view.state.value,
    onOpenExtension() { openExtensionCalls++; },
    onDownloadMain() { downloadMainCalls++; },
  };
  await view.flush();

  try {
    // 1. durl remains active playable & downloadable default (zero regression)
    assert.equal(view.state.value.selection.currentTarget.value.kind, 'file');
    assert.equal(view.state.value.selection.currentTarget.value.url, durlUrl);
    assert.equal(view.elements('rs-video')[0].props.src, durlUrl);
    const primaryBtn = () => view.elements('rs-btn--primary')[0];
    assert.equal(Boolean(primaryBtn().props.disabled), false);
    assert.equal(textOf(primaryBtn()), '下载视频');
    primaryBtn().props.onClick();
    await view.flush();
    assert.equal(downloadMainCalls, 1);

    // 2. Bilibili DASH Chrome extension guidance card renders immediately with 1080P（免登录）, 1080p, H.264, HEVC, AV1, AAC
    const callouts = view.elements('rs-bili-dash-callout');
    assert.equal(callouts.length, 1);
    const calloutText = textOf(callouts[0]);
    for (const expected of [
      '检测到 B 站 1080P（免登录）DASH（共 3 档）',
      '最高 1080p',
      'H.264',
      'HEVC',
      'AV1',
      'AAC',
      '免登录 DASH',
      '安装 Chrome 扩展无损下载',
    ]) {
      assert.ok(calloutText.includes(expected), `expected callout to include ${expected}, got: ${calloutText}`);
    }
    assert.doesNotMatch(calloutText, forbiddenBitrateWording);
    const calloutCta = view.elements('rs-bili-dash-cta')[0];
    assert.equal(calloutCta.props['data-bilibili-dash-extension-cta'], '');
    calloutCta.props.onClick();
    await view.flush();
    assert.equal(openExtensionCalls, 1);
    assert.equal(view.state.value.selection.currentTarget.value.url, durlUrl, 'extension CTA must never replace active durl default');

    // 3. Quality tab shows guidance card, keeps durl active, and turns otherQualityOptions mux entries into friendly extension guidance
    await view.tab('画质选项');
    assert.equal(view.elements('rs-higher-quality-note').length, 0, 'Bilibili DASH card replaces generic unsupported notice');
    const qualityCard = view.elements('rs-bili-dash-quality-card')[0];
    assert.ok(qualityCard);
    const qualityCardText = textOf(qualityCard);
    for (const expected of ['1080P（免登录）', '1080p', 'H.264', 'HEVC', 'AV1', 'AAC']) {
      assert.ok(qualityCardText.includes(expected), `expected quality card to include ${expected}, got: ${qualityCardText}`);
    }
    assert.doesNotMatch(qualityCardText, forbiddenBitrateWording);
    view.elements('rs-bili-dash-quality-cta')[0].props.onClick();
    await view.flush();
    assert.equal(openExtensionCalls, 2);

    assert.equal(view.elements('rs-backup-item').length, 1);
    assert.ok(textOf(view.elements('rs-backup-item')[0]).includes('720p'));
    const otherVersionsText = textOf(view.elements('rs-other-versions')[0]);
    assert.ok(otherVersionsText.includes('1080P（免登录）DASH 档位 · 需 Chrome 扩展 (3)'));
    assert.doesNotMatch(otherVersionsText, forbiddenBitrateWording);
    const muxTriggers = view.elements('rs-bili-mux-trigger');
    assert.equal(muxTriggers.length, 3);
    assert.ok(textOf(muxTriggers[0]).includes('免登录 DASH · 需 Chrome 扩展'));
    assert.equal(view.elements('rs-bili-mux-guide').length, 1);
    assert.ok(
      textOf(view.elements('rs-bili-mux-guide')[0]).includes(
        '该免登录 DASH 档位需附带 B 站来源头并本地无损合流，安装 DokiTool Chrome 扩展即可一键保存',
      ),
    );
    assert.ok(!otherVersionsText.includes('当前暂不支持'));

    // Clicking a specific DASH mux tier opens inline guidance without altering active durl download target
    muxTriggers[1].props.onClick();
    await view.flush();
    assert.equal(muxTriggers[1].props['aria-expanded'], true);
    assert.equal(view.elements('rs-bili-mux-guide').length, 1);
    assert.equal(view.state.value.selection.currentTarget.value.url, durlUrl);
    assert.equal(Boolean(primaryBtn().props.disabled), false);
    const guideBtn = view.elements('rs-bili-mux-guide-btn')[0];
    assert.equal(textOf(guideBtn), '打开扩展安装指引');
    guideBtn.props.onClick();
    await view.flush();
    assert.equal(openExtensionCalls, 3);

    // 4. English locale renders objective 1080P (No Login) copy & specs cleanly without misleading bitrate labels
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    const enCalloutText = textOf(view.elements('rs-bili-dash-callout')[0]);
    for (const expected of [
      '1080P (No Login) Bilibili DASH Available (3 tiers)',
      'Up to 1080p',
      'H.264 / HEVC / AV1',
      '+ AAC',
      'Get Chrome Extension for Lossless DASH',
    ]) {
      assert.ok(enCalloutText.includes(expected), `expected English callout to include ${expected}, got: ${enCalloutText}`);
    }
    assert.doesNotMatch(enCalloutText, forbiddenBitrateWording);
    const enQualityCardText = textOf(view.elements('rs-bili-dash-quality-card')[0]);
    assert.ok(enQualityCardText.includes('1080P (No Login) Bilibili DASH Available (3 tiers)'));
    assert.doesNotMatch(enQualityCardText, forbiddenBitrateWording);
    const enOtherVersionsText = textOf(view.elements('rs-other-versions')[0]);
    assert.ok(enOtherVersionsText.includes('1080P (No Login) DASH · Chrome Extension (3)'));
    assert.ok(enOtherVersionsText.includes('No-Login DASH · Chrome Ext'));
    assert.ok(enOtherVersionsText.includes('This no-login DASH tier requires Bilibili referer headers and local lossless muxing.'));
    assert.doesNotMatch(enOtherVersionsText, forbiddenBitrateWording);
    assert.equal(textOf(view.elements('rs-bili-mux-guide-btn')[0]), 'Open Extension Guide');

    // 4b. Sub-1080p Bilibili DASH (max 480p) adapts cleanly to 480P（免登录） / 480P (No Login) without falsely claiming 1080P
    const bili480pItem = {
      ...biliItem,
      id: 'BV1GJ411x7h7-480p',
      variants: [
        {
          ...biliItem.variants[0],
          id: 'durl-360p',
          label: '360p',
          metadata: { ...biliItem.variants[0].metadata, width: 640, height: 360 },
        },
        makeBiliMuxVariant('mux-480p-avc', 'avc1.64001E', 650000, { width: 854, height: 480, label: '480p' }),
      ],
      default: { variant_id: 'durl-360p', source_id: 's-durl', url: durlUrl },
      higher_quality_variants: [{ variant_id: 'mux-480p-avc', requires: ['mux'] }],
    };
    const bili480pData = {
      ...biliData,
      title: 'B站 480P（免登录）DASH 测试作品',
      items: [bili480pItem],
      default_item_id: bili480pItem.id,
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: bili480pData });
    view.state.value = { ...view.state.value, resultVersion: 2, locale: 'zh-CN', resultData: bili480pData };
    view.state.value.selection.syncResult();
    await view.flush();
    const zh480Callout = textOf(view.elements('rs-bili-dash-callout')[0]);
    assert.ok(zh480Callout.includes('检测到 B 站 480P（免登录）DASH（共 1 档）'), `got: ${zh480Callout}`);
    assert.ok(zh480Callout.includes('最高 480p'));
    assert.doesNotMatch(zh480Callout, /1080p/i);
    assert.doesNotMatch(zh480Callout, forbiddenBitrateWording);
    await view.tab('画质选项');
    const zh480QualityCard = textOf(view.elements('rs-bili-dash-quality-card')[0]);
    assert.ok(zh480QualityCard.includes('检测到 B 站 480P（免登录）DASH（共 1 档）'));
    assert.doesNotMatch(zh480QualityCard, /1080p/i);
    assert.doesNotMatch(zh480QualityCard, forbiddenBitrateWording);
    const zh480OtherVersions = textOf(view.elements('rs-other-versions')[0]);
    assert.ok(zh480OtherVersions.includes('480P（免登录）DASH 档位 · 需 Chrome 扩展 (1)'));
    assert.ok(zh480OtherVersions.includes('免登录 DASH · 需 Chrome 扩展'));
    assert.doesNotMatch(zh480OtherVersions, /1080p/i);
    assert.doesNotMatch(zh480OtherVersions, forbiddenBitrateWording);

    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    const en480Callout = textOf(view.elements('rs-bili-dash-callout')[0]);
    assert.ok(en480Callout.includes('480P (No Login) Bilibili DASH Available (1 tier)'), `got: ${en480Callout}`);
    assert.ok(en480Callout.includes('Up to 480p'));
    assert.doesNotMatch(en480Callout, /1080p/i);
    assert.doesNotMatch(en480Callout, forbiddenBitrateWording);
    const en480OtherVersions = textOf(view.elements('rs-other-versions')[0]);
    assert.ok(en480OtherVersions.includes('480P (No Login) DASH · Chrome Extension (1)'));
    assert.ok(en480OtherVersions.includes('No-Login DASH · Chrome Ext'));
    assert.doesNotMatch(en480OtherVersions, /1080p/i);
    assert.doesNotMatch(en480OtherVersions, forbiddenBitrateWording);

    // 4c. Unknown-resolution DASH tier falls back gracefully to 免登录 / No-Login without fabricating 1080P
    const biliUnknownResItem = {
      ...bili480pItem,
      id: 'BV1GJ411x7h7-unknown-res',
      variants: [
        bili480pItem.variants[0],
        makeBiliMuxVariant('mux-unknown-avc', 'avc1.64001E', 650000, { width: 0, height: 0, label: 'DASH' }),
      ],
      higher_quality_variants: [{ variant_id: 'mux-unknown-avc', requires: ['mux'] }],
    };
    const biliUnknownResData = {
      ...biliData,
      items: [biliUnknownResItem],
      default_item_id: biliUnknownResItem.id,
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: biliUnknownResData });
    view.state.value = { ...view.state.value, resultVersion: 3, locale: 'zh-CN', resultData: biliUnknownResData };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.ok(textOf(view.elements('rs-bili-dash-callout')[0]).includes('检测到 B 站免登录 DASH（共 1 档）'));
    assert.doesNotMatch(textOf(view.elements('rs-bili-dash-callout')[0]), /1080p/i);
    await view.tab('画质选项');
    assert.ok(textOf(view.elements('rs-other-versions')[0]).includes('免登录 DASH 档位 · 需 Chrome 扩展 (1)'));
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.ok(textOf(view.elements('rs-bili-dash-callout')[0]).includes('No-Login Bilibili DASH Available (1 tier)'));
    assert.ok(textOf(view.elements('rs-other-versions')[0]).includes('No-Login DASH · Chrome Extension (1)'));

    // 5. Non-Bilibili platforms with mux variants must NOT show the Bilibili DASH banner or Bilibili mux guidance
    const nonBiliData = { ...biliData, platform: 'douyin' };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: nonBiliData });
    view.state.value = { ...view.state.value, resultVersion: 4, locale: 'zh-CN', resultData: nonBiliData };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(view.elements('rs-bili-dash-callout').length, 0);
    await view.tab('画质选项');
    assert.equal(view.elements('rs-bili-dash-quality-card').length, 0);
    assert.equal(view.elements('rs-bili-mux-trigger').length, 0);
    assert.equal(view.elements('rs-bili-mux-guide').length, 0);
    assert.equal(view.elements('rs-higher-quality-note').length, 1);

    // 6. Bilibili payload with only durl (no mux variants) does NOT show the Bilibili DASH banner
    const durlOnlyBili = {
      ...biliData,
      items: [{ ...biliItem, variants: [biliItem.variants[0]], higher_quality_variants: undefined }],
    };
    validateMediaEnvelope({ schema_version: '1.0', code: 'OK', data: durlOnlyBili });
    view.state.value = { ...view.state.value, resultVersion: 5, resultData: durlOnlyBili };
    view.state.value.selection.syncResult();
    await view.flush();
    assert.equal(view.elements('rs-bili-dash-callout').length, 0);
    await view.tab('画质选项');
    assert.equal(view.elements('rs-bili-dash-quality-card').length, 0);

    // 7. App.vue wires ResultSection @open-extension directly to lazy ExtensionDownloadModal state
    const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
    const resultTag = appSource.match(/<ResultSection[\s\S]*?\/>/)?.[0] || '';
    assert.match(resultTag, /@open-extension="showExtensionModal\s*=\s*true"/);
  } finally {
    view.app.unmount();
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
