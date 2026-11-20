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
