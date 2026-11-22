import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuildBuild, stop as esbuildStop } from 'esbuild';
import { transformWithEsbuild } from 'vite';
import { createRenderer, h, markRaw, nextTick, reactive, ref } from 'vue';
import * as youtubeHelperCore from '../src/utils/youtubeHelperCore.js';
import { loadSfc } from './helpers/loadSfc.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, '..');
let tmpExtBundleDir = '';
let labels, contract, useVideoSelection, ResultSection, uiTargetHelpers, parseHelpers, SidePanelResult;
const originals = { window: globalThis.window, document: globalThis.document };
before(async () => {
  const modules = {};
  async function load(relative, aliases = {}) {
    const content = await readFile(new URL(relative, import.meta.url), 'utf8');
    const compiled = await transformWithEsbuild(content, relative, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', compiled.code)(id => aliases[id] || modules[id] || require(id), module, module.exports);
    return module.exports;
  }
  contract = modules['../utils/mediaContract'] = await load('../src/utils/mediaContract.ts');
  labels = modules['../utils/mediaSources'] = await load('../src/utils/mediaSources.ts');
  modules['../utils/youtubeHelperCore'] = youtubeHelperCore;
  modules['../services/apiConfig'] = { apiConfig: { baseUrl: '' } };
  ({ useVideoSelection } = await load('../src/composables/useVideoSelection.ts'));
  ResultSection = await loadSfc(
    new URL('../src/components/ResultSection.vue', import.meta.url),
    {
      modules: {
        ...modules,
        './AppIcon.vue': { default: { render: (_, { attrs }) => h('i', attrs) } },
      },
    },
  );
  tmpExtBundleDir = mkdtempSync(join(tmpdir(), 'dokitool-media-sources-'));
  const extOutfile = join(tmpExtBundleDir, 'ext-helpers.mjs');
  await esbuildBuild({
    stdin: {
      contents: `
        export * as uiTargetHelpers from "./src/extension/uiTargetHelpers.ts";
        export * as parseHelpers from "./src/utils/parseHelpers.ts";
        export * as mediaContract from "./src/utils/mediaContract.ts";
      `,
      resolveDir: FRONTEND_DIR,
      loader: 'ts',
    },
    bundle: true,
    outfile: extOutfile,
    platform: 'browser',
    format: 'esm',
    define: { 'import.meta.env': '{}' },
  });
  const extSuite = await import(pathToFileURL(extOutfile).href);
  uiTargetHelpers = extSuite.uiTargetHelpers;
  parseHelpers = extSuite.parseHelpers;
  SidePanelResult = await loadSfc(
    new URL('../src/extension/components/SidePanelResult.vue', import.meta.url),
    {
      modules: {
        '../../utils/mediaContract': extSuite.mediaContract,
        '../uiTargetHelpers': uiTargetHelpers,
      },
    },
  );
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { body: { style: {} } };
});
after(() => {
  esbuildStop();
  if (tmpExtBundleDir) {
    rmSync(tmpExtBundleDir, { recursive: true, force: true });
  }
  Object.assign(globalThis, originals);
});

const url = route => `https://media.example.test/${route}.mp4`;
const variant = (id, routes = [id], metadata = {}) => ({ id,
  ...(Object.keys(metadata).length ? { metadata: { ...metadata, evidence: 'probe' } } : {}),
  delivery: { kind: 'file', sources: routes.map(route => ({ id: route, url: url(route) })) } });
const item = (variants = [variant('hd', ['a', 'b', 'c', 'd'])], chosen = variants[0].id, sourceId) => {
  const selected = variants.find(v => v.id === chosen), source = selected.delivery.sources.find(s => s.id === sourceId) || selected.delivery.sources[0];
  return { id: 'video-1', type: 'video', title: '测试作品', variants,
    default: { variant_id: selected.id, source_id: source.id, url: source.url, ...(source.access ? { access: source.access } : {}), ...(source.expires_at ? { expires_at: source.expires_at } : {}) } };
};
const data = (mediaItem, extra = {}) => ({ platform: 'future_platform', items: [mediaItem], ...extra });

test('all design examples are readable without platform-specific normalization', async () => {
  const directory = new URL('../../docs/schema/unified-v1/examples/', import.meta.url);
  for (const file of await readdir(directory)) {
    const envelope = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
    if (envelope.code !== 'OK') continue;
    const snapshot = JSON.stringify(envelope);
    assert.deepEqual(contract.validateMediaEnvelope(envelope), envelope.data, file);
    assert.equal(JSON.stringify(envelope), snapshot, file);
  }
});

test('default follows the exact server reference regardless of array order or client quality guesses', () => {
  const low = variant('720', ['low'], { width: 720, height: 1280 }), high = variant('4k', ['a', 'b'], { width: 2160, height: 3840 });
  const value = item([low, high], '4k', 'b'), snapshot = structuredClone(value);
  assert.equal(contract.getDefaultFileUrl(value), url('b'));
  value.variants.reverse(); high.delivery.sources.reverse();
  assert.equal(contract.getDefaultFileUrl(value), url('b'));
  // This client is deliberately not a second policy engine. Backend semantics
  // tests reject a low default; this reader must never silently replace it.
  const serverLow = item([high, low], '720');
  assert.equal(contract.getDefaultFileUrl(serverLow), url('low'));
  assert.deepEqual(snapshot.default, value.default);
});

test('invalid default projections fail closed instead of borrowing the first file', () => {
  for (const patch of [{ variant_id: 'missing' }, { source_id: 'missing' }, { url: url('other') }, { access: 'relay' }, { expires_at: '2099-01-01T00:00:00Z' }]) {
    const value = item(); Object.assign(value.default, patch);
    assert.equal(contract.getDefaultDownloadTarget(value).kind, 'invalid');
  }
  const missingSource = item(); delete missingSource.default.source_id;
  assert.equal(contract.getDefaultDownloadTarget(missingSource).kind, 'invalid');
});

test('expired and unavailable sources never silently choose another variant', () => {
  const value = item(); value.variants[0].delivery.sources[0].expires_at = '2020-01-01T00:00:00Z'; value.default.expires_at = '2020-01-01T00:00:00Z';
  assert.equal(contract.getDefaultDownloadTarget(value).kind, 'needs_refresh');
  delete value.variants[0].delivery.sources[0].expires_at; delete value.default.expires_at;
  value.variants[0].delivery.sources[0].availability = 'unavailable';
  assert.equal(contract.getDefaultDownloadTarget(value).kind, 'unavailable');
  assert.equal(contract.getDownloadTarget(value, { variant_id: 'hd', source_id: 'b' }).url, url('b'));
});

test('source signatures survive relay expansion and unsafe origins or paths are rejected', () => {
  const signed = '/api/media?ticket=abc%2Bdef%2Fghi%3D&x=one+two';
  assert.equal(contract.sourceUrl({ url: signed, access: 'relay' }, { apiOrigin: 'https://api.example.test' }), 'https://api.example.test' + signed);
  assert.equal(contract.sourceUrl({ url: url('a') + '?sig=a%2Bb+Z' }), url('a') + '?sig=a%2Bb+Z');
  for (const path of ['/api/../private', '/api/%252e%252e/private', '//evil.test/api/a', '/api/a#secret', '/api/%5cprivate']) assert.throws(() => contract.sourceUrl({ url: path, access: 'relay' }));
  for (const origin of ['https://user:pass@api.example.test', 'https://api.example.test/path', 'https://api.example.test?x=1', 'https://api.example.test/prefix/..', 'https://api.example.test/%2e%2e', 'https://api.example.test:99999']) assert.throws(() => contract.sourceUrl({ url: signed, access: 'relay' }, { apiOrigin: origin }));
});

test('DASH, mux and remux cannot masquerade as a complete downloadable video', () => {
  const dash = { id: 'dash', delivery: { kind: 'dash', scope: 'adaptive', sources: [{ url: 'https://media.example.test/manifest.mpd' }] } };
  const video = { id: 'v', role: 'video', delivery: variant('track').delivery }, audio = { id: 'a', role: 'audio', delivery: variant('audio').delivery };
  const mux = { id: 'mux', delivery: { kind: 'mux', resources: [video, audio], output: { container: 'mp4', extension: 'mp4' } } };
  const remux = { id: 'remux', delivery: { kind: 'segments', join: 'remux', pieces: [{ index: 1, sources: [{ url: url('segment') }] }] } };
  for (const processing of [dash, mux, remux]) {
    const value = { id: 'one', type: 'video', variants: [processing], default: null, default_unavailable_reason: 'processing_required' };
    assert.equal(contract.getDefaultFileUrl(value), null);
    const selected = contract.getDownloadTarget(value, { variant_id: processing.id });
    assert.equal(selected.kind, 'unsupported'); assert.match(selected.message, /暂不支持/);
    assert.deepEqual(selected.requires, contract.requiredCapabilities(processing.delivery));
  }
});

test('explicit choice survives refreshed server defaults and never falls back if its identity disappears', () => {
  const first = item([variant('large'), variant('small')]);
  const store = reactive({ resultData: data(first) }), selection = useVideoSelection({ videoStore: store }); selection.syncResult();
  selection.choose({ variant_id: 'small', source_id: 'small' });
  assert.equal(selection.currentVideoUrl.value, url('small'));
  store.resultData = data(item([variant('new'), variant('small')], 'new'));
  assert.equal(selection.currentVideoUrl.value, url('small'));
  store.resultData = data(item([variant('new')]));
  assert.equal(selection.currentTarget.value.kind, 'invalid'); assert.equal(selection.currentVideoUrl.value, '');
  selection.resetDefault(); assert.equal(selection.currentVideoUrl.value, url('new'));
});

test('display labels preserve server intent without promoting original endpoint provenance', () => {
  assert.equal(labels.variantLabel({ ...variant('raw'), provenance: 'original_endpoint' }), '画质未知');
  assert.equal(labels.variantLabel({ ...variant('raw'), provenance: 'original_endpoint', metadata: { width: 720, height: 1280 } }), '720p');
  assert.equal(labels.variantLabel({ ...variant('raw'), label: '原画' }), '原画');
  assert.equal(labels.formatMediaSize(60342212), '60.3 MB'); assert.equal(labels.formatMediaSize(0), '大小未知');
});

async function mount(mediaData) {
  const element = (type, text = '') => markRaw({ type, text, props: {}, children: [], parent: null, style: {}, dataset: {}, removeAttribute() {}, getAttribute(name) { return this.props[name]; } });
  const detach = node => { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = null; };
  const portal = element('portal');
  const renderer = createRenderer({
    querySelector: () => portal, createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) { detach(node); node.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); }, remove: detach,
    patchProp(node, key, _, value) { node.props[key] = value; if (key === 'src') node.src = value; if (key === 'data-playback-key') node.dataset.playbackKey = value; },
  });
  const store = reactive({ resultData: mediaData }), selection = useVideoSelection({ videoStore: store }); selection.syncResult();
  const switched = [], copied = [], downloaded = [];
  const state = ref({ resultVersion: 1, locale: 'zh-CN', formatNumber: String, formatDuration: String,
    onSwitchVideo(choice) { switched.push(choice); selection.choose(choice); }, onCopyUrl(value) { copied.push(value); },
    onDownloadMain() { downloaded.push(selection.currentTarget.value); },
  });
  const root = element('root'), app = renderer.createApp({ render: () => h(ResultSection, { ...state.value, resultData: store.resultData, selection: markRaw(selection) }) });
  app.mount(root); await nextTick();
  const findAll = (node, match) => [...(match(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, match))];
  const text = node => [node.text, ...node.children.map(text)].join('');
  const buttons = () => findAll(root, node => node.type === 'button');
  const button = label => buttons().find(node => text(node).includes(label));
  return { app, store, selection, state, switched, copied, downloaded,
    player: () => findAll(root, node => node.type === 'video')[0], alert: () => findAll(root, node => node.props.role === 'alert')[0],
    choices: () => buttons().filter(node => String(node.props.class).split(' ').includes('rs-backup-item')),
    elements: className => findAll(root, node => String(node.props.class).split(' ').includes(className)), textOf: text,
    async click(label) { await button(label).props.onClick(); await nextTick(); },
    async fail(player = this.player()) { player.currentSrc = player.src; player.props.onError({ currentTarget: player }); await nextTick(); },
    text: () => text(root),
  };
}

const muxVariant = (id = 'mux') => ({ id, delivery: { kind: 'mux', output: { container: 'mp4', extension: 'mp4' }, resources: [
  { id: 'video', role: 'video', metadata: { width: 3840, height: 2160, evidence: 'upstream' }, delivery: variant('video-track').delivery },
  { id: 'audio', role: 'audio', delivery: variant('audio-track').delivery },
] } });

test('candidate policy UI: unsupported versions start collapsed and cannot replace a downloadable selection', async () => {
  const file = variant('file', ['primary', 'backup'], { width: 1920, height: 1080 });
  const mux = muxVariant(), dash = { id: 'dash', delivery: { kind: 'dash', scope: 'adaptive', sources: [{ url: 'https://media.example.test/a.mpd' }] } };
  const pending = { id: 'pending', state: 'deferred', reason: { code: 'PENDING', message: '等待后端验证' } };
  const value = item([file, mux, dash, pending], 'file', 'backup'), before = structuredClone(value), view = await mount(data(value));
  try {
    await view.click('画质选项');
    assert.equal(view.choices().length, 1, 'only currently downloadable options belong in the main list');
    const folded = view.elements('rs-other-versions');
    assert.equal(folded.length, 1); assert.equal(folded[0].type, 'details'); assert.ok(!folded[0].props.open);
    assert.equal(view.elements('rs-other-version').length, 3);
    assert.ok(view.elements('rs-other-version').every(row => row.type !== 'button' && !row.props.onClick));
    assert.equal(view.selection.currentSelection.value, null);
    assert.equal(view.selection.currentTarget.value.url, url('backup'));
    assert.deepEqual(value, before, 'ready mux resources and every other variant remain unchanged');
  } finally { view.app.unmount(); }
});

test('candidate policy UI: no complete file has a visible reason outside the collapsed versions', async () => {
  const value = { id: 'video-1', type: 'video', variants: [muxVariant()], default: null, default_unavailable_reason: 'processing_required' };
  const view = await mount(data(value));
  try {
    await view.click('画质选项');
    const notice = view.elements('rs-quality-unavailable');
    assert.equal(notice.length, 1); assert.match(view.textOf(notice[0]), /完整文件|暂不支持/);
    assert.notEqual(notice[0].parent.type, 'details');
    assert.equal(view.choices().length, 0); assert.equal(view.selection.currentTarget.value.kind, 'unsupported');
  } finally { view.app.unmount(); }
});

test('candidate policy UI: higher quality notice reads backend references once without inferring from dimensions', async () => {
  const value = item([variant('file'), muxVariant('higher-a'), muxVariant('higher-b')]);
  const view = await mount(data(value));
  try {
    await view.click('画质选项'); assert.equal(view.elements('rs-higher-quality-note').length, 0);
    value.higher_quality_variants = [{ variant_id: 'higher-a', requires: ['mux'] }, { variant_id: 'higher-b', requires: ['mux'] }];
    view.store.resultData = data({ ...value }); await nextTick();
    assert.equal(view.elements('rs-higher-quality-note').length, 1);
    assert.match(view.textOf(view.elements('rs-higher-quality-note')[0]), /更高画质.*暂不支持/);
    assert.equal(view.selection.currentTarget.value.url, url('file'));
  } finally { view.app.unmount(); }
});

test('candidate policy contract: HDR and alternate language facts require valid enums and evidence', () => {
  const envelope = metadata => ({ schema_version: '1.0', code: 'OK', data: data(item([variant('file', ['file'], metadata)])) });
  for (const metadata of [{ hdr_type: 'hevc' }, { audio_language_role: 'other', audio_language: 'en' }, { audio_language_role: 'alternate' }]) {
    assert.throws(() => contract.validateMediaEnvelope(envelope(metadata)), /媒体合同无效/);
  }
  const missingEvidence = envelope({ hdr_type: 'hdr10' }); delete missingEvidence.data.items[0].variants[0].metadata.evidence;
  assert.throws(() => contract.validateMediaEnvelope(missingEvidence), /证据/);
});

test('candidate policy contract: capability facts validate every metadata layer without rejecting evidenced mux conflicts', () => {
  const mux = muxVariant(), file = variant('file', ['file'], { hdr_type: 'sdr' });
  mux.metadata = { width: 1920, height: 1080, hdr_type: 'hdr10', evidence: 'upstream' };
  mux.delivery.resources[0].metadata.hdr_type = 'hlg';
  mux.delivery.resources[1].metadata = { audio_language: 'en', audio_language_role: 'alternate', audio_channels: 6, evidence: 'upstream' };
  const envelope = { schema_version: '1.0', code: 'OK', data: data(item([file, mux])) }, before = structuredClone(envelope);
  assert.equal(contract.validateMediaEnvelope(envelope), envelope.data);
  assert.deepEqual(envelope, before, 'conflicting facts are retained, not merged into a new default');
  for (const hdr of ['sdr', 'hdr10', 'hdr10_plus', 'hlg', 'dolby_vision', 'hdr_unknown']) {
    file.metadata.hdr_type = hdr; assert.doesNotThrow(() => contract.validateMediaEnvelope(envelope));
  }
  file.metadata = { hdr_type: 'hdr10', fps: 60, evidence: 'mixed', field_evidence: { hdr_type: 'probe' } };
  assert.throws(() => contract.validateMediaEnvelope(envelope), /证据/);
  file.metadata.field_evidence.fps = 'upstream'; assert.doesNotThrow(() => contract.validateMediaEnvelope(envelope));
  mux.delivery.resources[1].metadata.hdr_type = 'hdr10';
  assert.throws(() => contract.validateMediaEnvelope(envelope), /音频资源不能声明 HDR/);
  delete mux.delivery.resources[1].metadata.hdr_type;
  mux.delivery.resources[0].metadata.audio_language = 'en';
  assert.throws(() => contract.validateMediaEnvelope(envelope), /无音频资源/);
});

test('candidate policy UI: failed explicit source stays failed until a user selects an available option', async () => {
  const selected = variant('file', ['old', 'backup']), value = item([selected]), view = await mount(data(value));
  try {
    view.selection.choose({ variant_id: 'file', source_id: 'old' });
    selected.delivery.sources.shift();
    view.store.resultData = data(item([selected])); await nextTick();
    await view.click('画质选项');
    assert.equal(view.selection.currentTarget.value.kind, 'invalid');
    assert.deepEqual(view.selection.currentSelection.value, { variant_id: 'file', source_id: 'old' });
    assert.equal(view.choices().length, 1); assert.ok(!String(view.choices()[0].props.class).includes('rs-backup-item--cur'));
    view.choices()[0].props.onClick(); await nextTick();
    assert.equal(view.selection.currentTarget.value.url, url('backup'));
  } finally { view.app.unmount(); }
});

test('merged identity conflicts retain evidence without changing server or explicit selection', () => {
  const observations = (...values) => values.map(value => ({ value, evidence: 'upstream' }));
  const file = variant('file', ['file']), mux = muxVariant();
  mux.metadata = { field_conflicts: { fps: observations(30, 60), hdr_type: observations('sdr', 'hdr10') } };
  mux.delivery.resources[0].metadata = structuredClone(mux.metadata);
  mux.delivery.resources[1].metadata = { audio_language_role: 'main', evidence: 'upstream', field_conflicts: { audio_language: observations('en', 'fr') } };
  const envelope = { schema_version: '1.0', code: 'OK', data: data(item([file, mux])) }, before = structuredClone(envelope);
  assert.equal(contract.validateMediaEnvelope(envelope), envelope.data);
  assert.deepEqual(envelope, before);
  for (const bad of [
    { fps: observations(60, 60) }, { fps: observations('30', '60') }, { fps: observations(30) },
    { fps: [{ value: 30, evidence: 'unknown' }, { value: 60, evidence: 'upstream' }] },
    { hdr_type: observations('sdr', 'HEVC') }, { private_url: observations('a', 'b') },
    { audio_language: observations('   ', 'en') },
    { fps: [{ value: 30, evidence: 'upstream' }, { value: 30.0, evidence: 'probe' }] },
  ]) {
    const changed = structuredClone(before); changed.data.items[0].variants[1].metadata.field_conflicts = bad;
    assert.throws(() => contract.validateMediaEnvelope(changed), /媒体合同无效/);
  }
  let changed = structuredClone(before); changed.data.items[0].variants[1].metadata.fps = 60;
  assert.throws(() => contract.validateMediaEnvelope(changed), /确定值/);
  changed = structuredClone(before); changed.data.items[0].variants[1].delivery.resources[1].metadata.field_conflicts.fps = observations(30, 60);
  assert.throws(() => contract.validateMediaEnvelope(changed), /音频资源/);
  changed = structuredClone(before); changed.data.items[0].variants[1].delivery.resources[0].metadata.field_conflicts.has_audio = observations(false, true);
  assert.throws(() => contract.validateMediaEnvelope(changed), /无音频资源/);
});

test('candidate policy capabilities: adaptive HLS remains unsupported even inside a live pair', () => {
  const adaptive = { kind: 'hls', scope: 'adaptive', sources: [{ url: 'https://media.example.test/adaptive.m3u8' }] };
  const pair = { id: 'pair', delivery: { kind: 'pair', resources: [
    { id: 'still', role: 'image', delivery: variant('still').delivery }, { id: 'motion', role: 'motion', delivery: adaptive },
  ] } };
  for (const unsupported of [{ id: 'hls', delivery: adaptive }, pair]) {
    const value = { id: 'one', type: 'video', variants: [unsupported], default: null, default_unavailable_reason: 'processing_required' };
    assert.equal(contract.getDownloadTarget(value, { variant_id: unsupported.id }).kind, 'unsupported');
  }
});

test('quality UI retains complete variants and truthful sizes while processing entries remain read-only', async () => {
  const original = variant('original', ['raw'], { width: 2160, height: 3840, bitrate_bps: 52619915, video_bitrate_bps: 52000000, audio_bitrate_bps: 128000 }); original.label = '原画'; original.provenance = 'original_endpoint'; original.delivery.sources[0].size_bytes = 60342212;
  const small = variant('compressed', ['small'], { width: 2160, height: 3840 }); small.delivery.sources[0].size_bytes = 2051199;
  const dash = { id: 'dash', label: '更高画质', delivery: { kind: 'dash', scope: 'adaptive', sources: [{ url: 'https://media.example.test/manifest.mpd' }] } };
  const value = item([original, small, dash], 'original'), snapshot = structuredClone(value), view = await mount(data(value));
  try {
    await view.click('画质选项'); assert.equal(view.choices().length, 2);
    assert.deepEqual(view.elements('rs-backup-name').slice(0, 2).map(view.textOf), ['60.3 MB · 原画', '2.1 MB · 2160p']);
    assert.match(view.text(),/总码率\s+52\.6 Mbps/);assert.match(view.text(),/视频码率\s+52\.0 Mbps/);assert.match(view.text(),/音频码率\s+128 Kbps/);
    assert.equal(view.elements('rs-other-version').length, 1);
    assert.equal(view.selection.currentTarget.value.url, url('raw'));
    assert.equal(view.player().src, url('raw')); assert.match(view.text(), /暂不支持/); assert.deepEqual(value, snapshot);
  } finally { view.app.unmount(); }
});

test('compact quality cards preserve the server source, explicit versions and access to every variant', async () => {
  const raw = variant('raw', ['raw-source'], { width: 2160, height: 3840 });
  raw.provenance = 'original_endpoint'; raw.delivery.sources[0].size_bytes = 60342212;
  const compressed = variant('4k', ['compressed'], { width: 2160, height: 3840 });
  const h264 = variant('1080-h264', ['h264-a', 'h264-b'], { width: 1080, height: 1920, video_codec: 'h264' });
  const hevc = variant('1080-hevc', ['hevc-a', 'hevc-b'], { width: 1080, height: 1920, video_codec: 'hevc' });
  const low = variant('720', ['low'], { width: 720, height: 1280 });
  const dash = { id: 'dash', metadata: { width: 1080, height: 1920 }, delivery: { kind: 'dash', scope: 'adaptive', sources: [{ url: 'https://media.example.test/manifest.mpd' }] } };
  const pending = { id: 'pending', state: 'deferred', reason: { code: 'PENDING_CAPABILITY', message: '原始资源待解析' } };
  const value = item([raw, compressed, h264, hevc, low, dash, pending], '1080-hevc', 'hevc-b');
  const snapshot = structuredClone(value), view = await mount(data(value));
  try {
    await view.click('画质选项');
    assert.equal(view.choices().length, 4, 'only downloadable files participate in compact display cards');
    assert.equal(view.selection.currentSelection.value, null);
    assert.equal(view.selection.currentTarget.value.url, url('hevc-b'));
    assert.match(view.text(), /原画/);
    assert.doesNotMatch(view.text(), /原始入口/);
    assert.doesNotMatch(view.text(), /条线路/);
    assert.match(view.text(), /原始资源待解析/); assert.match(view.text(), /暂不支持/);
    view.state.value = { ...view.state.value, locale: 'en' }; await nextTick();
    assert.match(view.text(), /Original/);
    assert.doesNotMatch(view.text(), /条线路/);
    view.state.value = { ...view.state.value, locale: 'zh-CN' }; await nextTick();
    assert.equal(view.elements('rs-other-version').length, 2);
    await view.click('全部可下载版本 (5)');
    assert.equal(view.choices().length, 5);
    assert.equal(view.selection.currentTarget.value.url, url('hevc-b'), 'expansion never selects a different source');
    view.choices()[2].props.onClick(); await nextTick();
    assert.deepEqual(view.selection.currentSelection.value, { variant_id: '1080-h264' });
    assert.equal(view.selection.currentTarget.value.url, url('h264-a'));
    view.selection.choose({ variant_id: '1080-h264', source_id: 'h264-b' }); await nextTick();
    await view.click('精简展示');
    assert.equal(view.choices().length, 4);
    assert.equal(view.selection.currentTarget.value.url, url('h264-b'), 'collapsing keeps the exact explicit route');
    assert.match(view.textOf(view.choices()[2]), /H\.264/);
    assert.deepEqual(value, snapshot, 'display grouping never mutates or removes domain variants');
  } finally { view.app.unmount(); }
});

test('player fallback stays in the selected variant, stops at three routes and ignores stale DOM events', async () => {
  const view = await mount(data(item([variant('hd', ['a', 'b', 'c', 'd']), variant('lower', ['low'])])));
  try {
    const old = view.player(); await view.fail(old); assert.equal(view.player().src, url('b'));
    await view.fail(old); assert.equal(view.player().src, url('b')); assert.equal(view.switched.length, 1);
    await view.fail(); assert.equal(view.player().src, url('c')); await view.fail(); assert.ok(view.alert());
    assert.equal(view.switched.length, 2); assert.equal(view.player().src, url('c'));
    await view.click('复制链接'); await view.click('下载视频'); assert.equal(view.copied.at(-1), url('c')); assert.equal(view.downloaded.at(-1).url, url('c'));
    await view.click('画质选项'); view.choices()[1].props.onClick(); await nextTick(); assert.equal(view.player().src, url('low'));
    await view.fail(); assert.ok(view.alert()); assert.equal(view.player().src, url('low'));
    view.choices()[0].props.onClick(); await nextTick(); await view.fail(); assert.equal(view.player().src, url('b'), 'manual selection resets only this player retry budget');
  } finally { view.app.unmount(); }
});

test('new result resets playback failures while stale events cannot alter the new item', async () => {
  const view = await mount(data(item([variant('single')])));
  try {
    await view.fail(); assert.ok(view.alert()); const stale = view.player();
    view.store.resultData = data(item([variant('new', ['next', 'next-backup'])])); view.selection.syncResult(); view.state.value = { ...view.state.value, resultVersion: 2 }; await nextTick();
    assert.equal(view.alert(), undefined); await view.fail(stale); assert.equal(view.player().src, url('next'));
    await view.fail(); assert.equal(view.player().src, url('next-backup'));
  } finally { view.app.unmount(); }
});

test('statistics distinguish a verified zero from an unverified count without platform checks', async () => {
  const view = await mount(data(item(), { statistics: { plays: { state: 'unverified' }, likes: { state: 'known', value: 0 } } }));
  try { await view.click('数据'); assert.deepEqual(view.elements('rs-stat-num').map(view.textOf), ['—', '0']); assert.match(view.text(), /未将缺失值当作 0/); }
  finally { view.app.unmount(); }
});

test('credential alternatives stay within the chosen source and precede mirror routes', () => {
  const value = item();
  value.variants[0].delivery.sources[1].fallback_urls = [url('b-renewed'), url('b-other')];
  const target = contract.getDownloadTarget(value, {variant_id:'hd',source_id:'b'});
  assert.equal(target.url, url('b'));
  assert.equal(target.source.id, 'b');
  assert.deepEqual(target.routes.slice(0,3), [url('b'),url('b-renewed'),url('b-other')]);
  for (const fallback of [[], [url('b')], [url('b-renewed'),url('b-renewed')], [url('1'),url('2'),url('3')], ['https://other.test/b.mp4'], ['http://media.example.test/b.mp4'], ['https://user:pass@media.example.test/b.mp4']]) {
    value.variants[0].delivery.sources[1].fallback_urls = fallback;
    assert.equal(contract.getDownloadTarget(value, {variant_id:'hd',source_id:'b'}).kind, 'invalid');
  }
});

test('Weibo internal quality keys map to readable labels and Instagram width-only image shows 1080w', async () => {
  assert.equal(labels.variantLabel({ ...variant('wb-hd'), label: 'mp4_hd' }, 'zh-CN'), '高清');
  assert.equal(labels.variantLabel({ ...variant('wb-hd'), label: 'mp4_hd' }, 'en'), 'HD');
  assert.equal(labels.variantLabel({ ...variant('wb-hd-url'), label: 'mp4_hd_url' }, 'zh-CN'), '高清');
  assert.equal(labels.variantLabel({ ...variant('wb-stream-hd'), label: 'stream_url_hd' }, 'zh-CN'), '高清');
  assert.equal(labels.variantLabel({ ...variant('wb-hevc-hd'), label: 'hevc_mp4_hd' }, 'zh-CN'), '高清');
  assert.equal(labels.variantLabel({ ...variant('wb-sd'), label: 'mp4_sd_url' }, 'zh-CN'), '标清');
  assert.equal(labels.variantLabel({ ...variant('wb-sd'), label: 'mp4_sd_url' }, 'en'), 'SD');
  assert.equal(labels.variantLabel({ ...variant('wb-stream'), label: 'stream_url' }, 'zh-CN'), '标清');
  assert.equal(labels.variantLabel({ ...variant('wb-ld'), label: 'mp4_ld' }, 'zh-CN'), '流畅');
  assert.equal(labels.variantLabel({ ...variant('wb-ld'), label: 'mp4_ld' }, 'en'), 'LD');
  assert.equal(labels.variantLabel({ ...variant('wb-720'), label: 'mp4_720p_mp4' }, 'zh-CN'), '720p');
  assert.equal(labels.variantLabel({ ...variant('wb-1080'), label: 'mp4_1080p_mp4' }, 'zh-CN'), '1080p');
  assert.equal(labels.variantLabel({ ...variant('wb-2k'), label: 'mp4_2k_mp4' }, 'zh-CN'), '2K');
  assert.equal(labels.variantLabel({ ...variant('wb-4k'), label: 'mp4_4k_mp4' }, 'zh-CN'), '4K');

  const igVariant = variant('image-1080w', ['ig-img'], { width: 1080 });
  assert.equal(labels.variantLabel(igVariant, 'zh-CN'), '1080w');
  assert.equal(labels.variantLabel(igVariant, 'en'), '1080w');
  assert.equal(labels.variantLabel({ ...igVariant, metadata: { width: 1080, height: 0, evidence: 'upstream' } }, 'zh-CN'), '1080w');

  const igItem = {
    id: 'image-1',
    type: 'image',
    variants: [igVariant],
    default: { variant_id: 'image-1080w', source_id: 'ig-img', url: url('ig-img') },
  };
  const view = await mount({ platform: 'instagram', items: [igItem] });
  try {
    assert.match(view.text(), /1080w/);
    assert.doesNotMatch(view.text(), /画质未知/);
  } finally {
    view.app.unmount();
  }
});

test('failed cover, video poster, avatar, and gallery images hide broken visuals without server relay', async () => {
  const brokenCover = 'https://wx1.sinaimg.cn/large/broken-cover.jpg';
  const brokenAvatar = 'https://wx3.sinaimg.cn/large/broken-avatar.jpg';
  const brokenGallery = 'https://wx2.sinaimg.cn/large/broken-gallery.jpg';
  const vidItem = {
    ...item([variant('hd', ['v1'])]),
    cover: { url: brokenCover },
  };
  const imgItem = {
    id: 'img-1',
    type: 'image',
    variants: [{ id: 'v-img', delivery: { kind: 'file', sources: [{ id: 's-img', url: brokenGallery }] } }],
    default: { variant_id: 'v-img', source_id: 's-img', url: brokenGallery },
  };
  const view = await mount({
    platform: 'weibo',
    author: { name: '测试博主', avatar: { url: brokenAvatar } },
    default_item_id: vidItem.id,
    items: [vidItem, imgItem],
  });
  try {
    assert.equal(view.player().props.poster, brokenCover);
    assert.equal(view.elements('rs-author-avatar').length, 1);
    assert.equal(view.elements('rs-gallery-img').length, 1);

    const probes = view.elements('rs-poster-probe');
    assert.ok(probes.length >= 1, 'poster probe img should watch cover load errors');
    probes[0].props.onError();
    view.elements('rs-author-avatar')[0].props.onError();
    view.elements('rs-gallery-img')[0].props.onError();
    await nextTick();

    assert.equal(view.player().props.poster, undefined);
    assert.equal(view.elements('rs-author-avatar').length, 0);
    assert.equal(view.elements('rs-author-avatar-fb').length, 1);
    assert.equal(view.elements('rs-gallery-img').length, 0);
  } finally {
    view.app.unmount();
  }
});

test('formatCodecLabel maps technical codec strings to human-readable labels while preserving raw codec in title attribute', async () => {
  for (const [raw, expected] of [
    ['av01.0.13M.08', 'AV1'],
    ['av1', 'AV1'],
    ['avc1.64002A', 'H.264'],
    ['h264', 'H.264'],
    ['vp09.00.51.08', 'VP9'],
    ['vp9', 'VP9'],
    ['vp9.2', 'VP9'],
    ['hev1.1.6.L93.B0', 'HEVC'],
    ['hvc1.1.6.L120.90', 'HEVC'],
    ['hevc', 'HEVC'],
    ['h265', 'HEVC'],
    ['mp4a.40.2', 'AAC'],
    ['opus', 'Opus'],
    ['vp8', 'vp8'],
    ['prores_422', 'prores_422'],
    ['', ''],
    [undefined, ''],
  ]) {
    assert.equal(labels.formatCodecLabel(raw), expected, `codec ${String(raw)} -> ${expected}`);
  }

  const av1Var = variant('v-av1', ['av1'], { width: 3840, height: 2160, video_codec: 'av01.0.13M.08' });
  const h264Var = variant('v-h264', ['h264'], { width: 1920, height: 1080, video_codec: 'avc1.64002A' });
  const aacVar = {
    id: 'v-aac',
    label: '仅音频 M4A (128 kbps)',
    metadata: { has_audio: true, audio_codec: 'mp4a.40.2', container: 'm4a', extension: 'm4a', mime_type: 'audio/mp4', evidence: 'upstream' },
    delivery: { kind: 'file', sources: [{ id: 's-aac', url: 'https://media.example.test/audio.m4a' }] },
  };
  const view = await mount(data(item([av1Var, h264Var, aacVar], 'v-av1')));
  try {
    await view.click('画质选项');
    const tags = view.elements('rs-backup-meta-tag');
    const codecTags = tags.filter(node => node.props.title);
    assert.deepEqual(
      codecTags.map(node => ({ label: view.textOf(node), title: node.props.title })),
      [
        { label: 'AV1', title: 'av01.0.13M.08' },
        { label: 'H.264', title: 'avc1.64002A' },
        { label: 'AAC', title: 'mp4a.40.2' },
      ],
    );
  } finally {
    view.app.unmount();
  }
});

const WEIBO_DIRECT = 'https://f.video.weibocdn.com/o0/direct-hd.mp4?Expires=1999999999&ssig=abc%2B123';
const WEIBO_RELAY_PATH = '/api/media/weibo?ticket=signed%2Bticket%2F1';
const WEIBO_API_ORIGIN = 'https://snap.dokitool.com';
const WEIBO_RELAY_FULL = WEIBO_API_ORIGIN + WEIBO_RELAY_PATH;

function makeWeiboRelayEnvelope(sourceOverrides = {}, extraVariants = []) {
  const primarySource = {
    id: 'wb-src-hd',
    url: WEIBO_RELAY_PATH,
    access: 'relay',
    direct_url: WEIBO_DIRECT,
    size_bytes: 12_345_678,
    ...sourceOverrides,
  };
  const primaryVariant = {
    id: 'wb-hd',
    label: 'mp4_1080p_mp4',
    metadata: {
      width: 1920,
      height: 1080,
      container: 'mp4',
      extension: 'mp4',
      mime_type: 'video/mp4',
      has_audio: true,
      evidence: 'upstream',
    },
    delivery: {
      kind: 'file',
      sources: [primarySource],
    },
  };
  const wbItem = {
    id: 'wb-video-1',
    type: 'video',
    title: '微博实测视频',
    variants: [primaryVariant, ...extraVariants],
    default: {
      variant_id: primaryVariant.id,
      source_id: primarySource.id,
      url: primarySource.url,
      ...(primarySource.access ? { access: primarySource.access } : {}),
    },
  };
  return {
    schema_version: '1.0',
    code: 'OK',
    data: {
      platform: 'weibo',
      content_id: '500123456',
      source_url: 'https://weibo.com/12345/AbCdEf',
      title: '微博实测视频',
      generated_at: '2026-11-22T00:00:00Z',
      items: [wbItem],
    },
  };
}

test('Web SPA default TargetContext completely ignores source.direct_url and stays on /api/media/weibo', async () => {
  const envelope = makeWeiboRelayEnvelope();
  const validated = contract.validateMediaEnvelope(envelope, { apiOrigin: WEIBO_API_ORIGIN });
  const wbItem = validated.items[0];
  const wbSource = wbItem.variants[0].delivery.sources[0];

  assert.equal(contract.sourceUrl(wbSource, { apiOrigin: WEIBO_API_ORIGIN }), WEIBO_RELAY_FULL);
  assert.deepEqual(contract.sourceRoutes(wbSource, { apiOrigin: WEIBO_API_ORIGIN }), [WEIBO_RELAY_FULL]);
  assert.deepEqual(contract.deliveryRoutes([wbSource], { apiOrigin: WEIBO_API_ORIGIN }), [WEIBO_RELAY_FULL]);
  assert.equal(contract.getDefaultFileUrl(wbItem, { apiOrigin: WEIBO_API_ORIGIN }), WEIBO_RELAY_FULL);

  const defTarget = contract.getDefaultDownloadTarget(wbItem, { apiOrigin: WEIBO_API_ORIGIN });
  assert.equal(defTarget.kind, 'file');
  assert.equal(defTarget.url, WEIBO_RELAY_FULL);
  assert.deepEqual(defTarget.routes, [WEIBO_RELAY_FULL]);

  const selTarget = contract.getDownloadTarget(
    wbItem,
    { variant_id: 'wb-hd', source_id: 'wb-src-hd' },
    { apiOrigin: WEIBO_API_ORIGIN },
  );
  assert.equal(selTarget.kind, 'file');
  assert.equal(selTarget.url, WEIBO_RELAY_FULL);
  assert.deepEqual(selTarget.routes, [WEIBO_RELAY_FULL]);

  // Verify Web SPA ResultSection renders ONLY the relay URL and never weibocdn.com
  const view = await mount(validated);
  try {
    assert.ok(view.player().src.endsWith(WEIBO_RELAY_PATH), 'Web SPA <video> must use relay URL');
    assert.ok(!view.player().src.includes('weibocdn.com'), 'Web SPA must never target direct_url');
    assert.deepEqual(view.selection.currentTarget.value.routes.every(r => !r.includes('weibocdn.com')), true);
  } finally {
    view.app.unmount();
  }
});

test('validateMediaEnvelope accepts valid relay direct_url and rejects non-relay or malformed direct_url', () => {
  const validEnvelope = makeWeiboRelayEnvelope();
  assert.deepEqual(
    contract.validateMediaEnvelope(validEnvelope, { apiOrigin: WEIBO_API_ORIGIN }),
    validEnvelope.data,
  );
  // validateMediaEnvelope MUST force preferRelayDirect: false so canonical item.default.url validation succeeds
  assert.deepEqual(
    contract.validateMediaEnvelope(validEnvelope, {
      apiOrigin: WEIBO_API_ORIGIN,
      preferRelayDirect: true,
    }),
    validEnvelope.data,
  );
  assert.deepEqual(
    contract.validateMediaEnvelope(
      validEnvelope,
      uiTargetHelpers.buildExtensionTargetContext(WEIBO_API_ORIGIN),
    ),
    validEnvelope.data,
  );

  // Reject direct_url on non-relay sources (access: "direct" or omitted)
  for (const nonRelay of [
    { access: 'direct', url: 'https://media.example.test/v.mp4' },
    { access: undefined, url: 'https://media.example.test/v.mp4' },
  ]) {
    const bad = makeWeiboRelayEnvelope(nonRelay);
    assert.throws(
      () => contract.validateMediaEnvelope(bad, { apiOrigin: WEIBO_API_ORIGIN }),
      /媒体合同无效/,
      `non-relay source (${String(nonRelay.access)}) with direct_url must fail`,
    );
  }

  // Reject non-HTTPS, missing path, userinfo, fragment, whitespace, control chars, backslash, non-string
  const invalidDirectUrls = [
    '',
    '   ',
    null,
    123,
    'http://f.video.weibocdn.com/o0/v.mp4',
    'HTTPS://f.video.weibocdn.com/o0/v.mp4',
    'https://f.video.weibocdn.com',
    'https://f.video.weibocdn.com?a=1',
    'https://f.video.weibocdn.com/o0/v.mp4#frag',
    'https://user:pass@f.video.weibocdn.com/o0/v.mp4',
    'https://@f.video.weibocdn.com/o0/v.mp4',
    'https://f.video.weibocdn.com:/o0/v.mp4',
    'https://f.video.weibocdn.com/o0/a b.mp4',
    'https://f.video.weibocdn.com/o0/a\nb.mp4',
    'https://f.video.weibocdn.com/o0/a\\b.mp4',
    '/api/media/weibo?ticket=nested',
  ];
  for (const badDirect of invalidDirectUrls) {
    const bad = makeWeiboRelayEnvelope({ direct_url: badDirect });
    assert.throws(
      () => contract.validateMediaEnvelope(bad, { apiOrigin: WEIBO_API_ORIGIN }),
      /媒体合同无效/,
      `invalid direct_url (${JSON.stringify(badDirect)}) must fail`,
    );
  }
});

test('preferRelayDirect boolean and predicate place accepted direct_url FIRST and keep signed relay as fallback', () => {
  const envelope = makeWeiboRelayEnvelope();
  const wbItem = envelope.data.items[0];
  const wbSource = wbItem.variants[0].delivery.sources[0];

  // preferRelayDirect: true
  const ctxTrue = { apiOrigin: WEIBO_API_ORIGIN, preferRelayDirect: true };
  assert.equal(contract.sourceUrl(wbSource, ctxTrue), WEIBO_DIRECT);
  assert.deepEqual(contract.sourceRoutes(wbSource, ctxTrue), [WEIBO_DIRECT, WEIBO_RELAY_FULL]);
  assert.deepEqual(contract.deliveryRoutes([wbSource], ctxTrue), [WEIBO_DIRECT, WEIBO_RELAY_FULL]);

  const targetTrue = contract.getDefaultDownloadTarget(wbItem, ctxTrue);
  assert.equal(targetTrue.kind, 'file');
  assert.equal(targetTrue.url, WEIBO_DIRECT);
  assert.deepEqual(targetTrue.routes, [WEIBO_DIRECT, WEIBO_RELAY_FULL]);

  // preferRelayDirect predicate returning true
  const seenUrls = [];
  const ctxPredAllow = {
    apiOrigin: WEIBO_API_ORIGIN,
    preferRelayDirect: (u) => {
      seenUrls.push(u);
      return u.startsWith('https://f.video.weibocdn.com/');
    },
  };
  assert.equal(contract.sourceUrl(wbSource, ctxPredAllow), WEIBO_DIRECT);
  assert.deepEqual(contract.sourceRoutes(wbSource, ctxPredAllow), [WEIBO_DIRECT, WEIBO_RELAY_FULL]);
  assert.deepEqual(contract.deliveryRoutes([wbSource], ctxPredAllow), [WEIBO_DIRECT, WEIBO_RELAY_FULL]);
  const selAllow = contract.getDownloadTarget(wbItem, { variant_id: 'wb-hd', source_id: 'wb-src-hd' }, ctxPredAllow);
  assert.equal(selAllow.kind, 'file');
  assert.equal(selAllow.url, WEIBO_DIRECT);
  assert.deepEqual(selAllow.routes, [WEIBO_DIRECT, WEIBO_RELAY_FULL]);
  assert.ok(seenUrls.every(u => u === WEIBO_DIRECT));

  // preferRelayDirect predicate returning false omits direct_url
  const ctxPredDeny = {
    apiOrigin: WEIBO_API_ORIGIN,
    preferRelayDirect: () => false,
  };
  assert.equal(contract.sourceUrl(wbSource, ctxPredDeny), WEIBO_RELAY_FULL);
  assert.deepEqual(contract.sourceRoutes(wbSource, ctxPredDeny), [WEIBO_RELAY_FULL]);
  assert.deepEqual(contract.deliveryRoutes([wbSource], ctxPredDeny), [WEIBO_RELAY_FULL]);
  const selDeny = contract.getDefaultDownloadTarget(wbItem, ctxPredDeny);
  assert.equal(selDeny.kind, 'file');
  assert.equal(selDeny.url, WEIBO_RELAY_FULL);
  assert.deepEqual(selDeny.routes, [WEIBO_RELAY_FULL]);

  // Throwing predicate fails closed to relay-only
  const ctxPredThrow = {
    apiOrigin: WEIBO_API_ORIGIN,
    preferRelayDirect: () => {
      throw new Error('predicate boom');
    },
  };
  assert.deepEqual(contract.sourceRoutes(wbSource, ctxPredThrow), [WEIBO_RELAY_FULL]);
});

test('buildExtensionTargetContext accepts built-in whitelisted media hosts and rejects unwhitelisted/API hosts', () => {
  const customApi = 'https://custom-api.example.com';
  const extCtx = uiTargetHelpers.buildExtensionTargetContext(`${customApi}/`, 1_700_000_000_000);
  assert.equal(extCtx.apiOrigin, customApi);
  assert.equal(extCtx.now, 1_700_000_000_000);
  assert.equal(typeof extCtx.preferRelayDirect, 'function');

  // Default origin when omitted/null/invalid
  assert.equal(uiTargetHelpers.buildExtensionTargetContext().apiOrigin, 'https://snap.dokitool.com');
  assert.equal(uiTargetHelpers.buildExtensionTargetContext(null).apiOrigin, 'https://snap.dokitool.com');
  assert.equal(uiTargetHelpers.buildExtensionTargetContext('not-a-url').apiOrigin, 'https://snap.dokitool.com');

  // Built-in whitelisted Weibo CDN hosts accepted
  assert.equal(extCtx.preferRelayDirect(WEIBO_DIRECT), true);
  assert.equal(extCtx.preferRelayDirect('https://wx1.sinaimg.cn/large/abc.jpg'), true);

  // Unwhitelisted, custom API origin, PROD API origin, non-HTTPS, non-standard port rejected
  assert.equal(extCtx.preferRelayDirect('https://evil.example.com/video.mp4'), false);
  assert.equal(extCtx.preferRelayDirect(`${customApi}/hijack.mp4`), false);
  assert.equal(extCtx.preferRelayDirect('https://snap.dokitool.com/api/media/weibo?ticket=1'), false);
  assert.equal(extCtx.preferRelayDirect('http://f.video.weibocdn.com/o0/v.mp4'), false);
  assert.equal(extCtx.preferRelayDirect('https://f.video.weibocdn.com:8443/o0/v.mp4'), false);

  // End-to-end with buildSidePanelQualityOptions & buildSingleDownloadEnqueueItem
  const goodEnv = makeWeiboRelayEnvelope();
  const goodOpts = uiTargetHelpers.buildSidePanelQualityOptions(goodEnv.data, goodEnv.data.items[0], customApi);
  assert.equal(goodOpts.length, 1);
  assert.equal(goodOpts[0].directUrl, WEIBO_DIRECT);
  assert.deepEqual(goodOpts[0].routes, [WEIBO_DIRECT, customApi + WEIBO_RELAY_PATH]);

  const goodEnq = uiTargetHelpers.buildSingleDownloadEnqueueItem({
    media: goodEnv.data,
    item: goodEnv.data.items[0],
    option: goodOpts[0],
    settings: {
      apiBaseUrl: customApi,
      bearerToken: '',
      qualityPreference: 'best',
      batchSaveMode: 'subfolder',
      subfolderPrefix: '',
      themeMode: 'system',
    },
  });
  assert.deepEqual(goodEnq.spec.routes, [WEIBO_DIRECT, customApi + WEIBO_RELAY_PATH]);

  // Unwhitelisted direct_url is omitted by buildSidePanelQualityOptions -> falls back cleanly to relay only
  const evilEnv = makeWeiboRelayEnvelope({ direct_url: 'https://evil.example.com/v.mp4' });
  const evilOpts = uiTargetHelpers.buildSidePanelQualityOptions(evilEnv.data, evilEnv.data.items[0], customApi);
  assert.equal(evilOpts.length, 1);
  assert.equal(evilOpts[0].directUrl, customApi + WEIBO_RELAY_PATH);
  assert.deepEqual(evilOpts[0].routes, [customApi + WEIBO_RELAY_PATH]);
});

test('redactServerBoundYouTubeMedia strips direct_url alongside fallback_urls', () => {
  const media = {
    platform: 'youtube',
    content_id: 'dQw4w9WgXcQ',
    items: [
      {
        id: 'yt-1',
        type: 'video',
        variants: [
          {
            id: 'v1',
            delivery: {
              kind: 'file',
              sources: [
                {
                  id: 's1',
                  url: 'https://rr1---sn.googlevideo.com/videoplayback?id=1',
                  fallback_urls: ['https://rr1---sn.googlevideo.com/videoplayback?id=2'],
                  direct_url: 'https://rr1---sn.googlevideo.com/direct.mp4',
                },
              ],
            },
          },
        ],
        default: {
          variant_id: 'v1',
          source_id: 's1',
          url: 'https://rr1---sn.googlevideo.com/videoplayback?id=1',
        },
      },
    ],
    attachments: [
      {
        id: 'att-1',
        role: 'background_audio',
        resource: {
          id: 'res-a1',
          role: 'audio',
          delivery: {
            kind: 'file',
            sources: [
              {
                id: 'as1',
                url: 'https://rr2---sn.googlevideo.com/audioplayback?id=1',
                fallback_urls: ['https://rr2---sn.googlevideo.com/audioplayback?id=2'],
                direct_url: 'https://rr2---sn.googlevideo.com/direct.m4a',
              },
            ],
          },
        },
      },
    ],
  };

  const redacted = parseHelpers.redactServerBoundYouTubeMedia(
    media,
    { status: 'missing' },
    'dQw4w9WgXcQ',
  );
  const vSrc = redacted.items[0].variants[0].delivery.sources[0];
  const aSrc = redacted.attachments[0].resource.delivery.sources[0];
  assert.equal('fallback_urls' in vSrc, false);
  assert.equal('direct_url' in vSrc, false);
  assert.equal('fallback_urls' in aSrc, false);
  assert.equal('direct_url' in aSrc, false);
});

test('SidePanelResult video preview prefers Weibo direct_url and falls back to relay on @error', async () => {
  const sdDirect = 'https://f.video.weibocdn.com/o0/direct-sd.mp4?Expires=1999999999&ssig=sd';
  const sdRelayPath = '/api/media/weibo?ticket=signed%2Bsd';
  const sdVariant = {
    id: 'wb-sd',
    label: 'mp4_sd_url',
    metadata: {
      width: 854,
      height: 480,
      container: 'mp4',
      extension: 'mp4',
      mime_type: 'video/mp4',
      has_audio: true,
      evidence: 'upstream',
    },
    delivery: {
      kind: 'file',
      sources: [
        {
          id: 'wb-src-sd',
          url: sdRelayPath,
          access: 'relay',
          direct_url: sdDirect,
        },
      ],
    },
  };
  const envelope = makeWeiboRelayEnvelope({}, [sdVariant]);

  const element = (type, text = '') =>
    markRaw({
      type,
      text,
      props: {},
      children: [],
      parent: null,
      style: {},
      dataset: {},
      removeAttribute() {},
      getAttribute(name) {
        return this.props[name] ?? null;
      },
    });
  const detach = (node) => {
    if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node);
    node.parent = null;
  };
  const renderer = createRenderer({
    querySelector: () => null,
    createElement: element,
    createText: (text) => element('#text', text),
    createComment: (text) => element('#comment', text),
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) {
      detach(node);
      node.parent = parent;
      const idx = parent.children.indexOf(anchor);
      parent.children.splice(idx < 0 ? parent.children.length : idx, 0, node);
    },
    remove: detach,
    patchProp(node, key, _, value) {
      node.props[key] = value;
      if (key === 'src') node.src = value;
    },
  });

  const findAll = (node, match) => [
    ...(match(node) ? [node] : []),
    ...node.children.flatMap((child) => findAll(child, match)),
  ];

  const state = reactive({
    media: envelope.data,
    workFingerprint: 'weibo:500123456',
    isSaved: false,
    settings: {
      apiBaseUrl: WEIBO_API_ORIGIN,
      bearerToken: '',
      qualityPreference: 'best',
      batchSaveMode: 'subfolder',
      subfolderPrefix: '',
      themeMode: 'system',
    },
    resolvingItemIds: new Set(),
  });
  const root = element('root');
  const app = renderer.createApp({
    render: () => h(SidePanelResult, { ...state }),
  });
  app.mount(root);
  await nextTick();

  try {
    const getVideo = () => findAll(root, (n) => n.type === 'video')[0];
    const variantButtons = () =>
      findAll(root, (n) => n.type === 'button' && String(n.props.class || '').includes('sp-variant-card'));

    // Starts on Weibo direct_url
    const firstVideo = getVideo();
    assert.ok(firstVideo, 'SidePanelResult should render <video>');
    assert.equal(firstVideo.src, WEIBO_DIRECT);

    // Trigger @error on direct_url -> cycles previewVideoRouteIndex to relay URL
    firstVideo.props.onError({ currentTarget: firstVideo });
    await nextTick();
    const fallbackVideo = getVideo();
    assert.ok(fallbackVideo, 'SidePanelResult should fall back to relay <video>');
    assert.equal(fallbackVideo.src, WEIBO_RELAY_FULL);

    // Late stale @error from firstVideo must NOT skip past relay URL
    fallbackVideo.props.onError({ currentTarget: firstVideo });
    await nextTick();
    assert.equal(getVideo().src, WEIBO_RELAY_FULL);

    // Switching variant resets previewVideoRouteIndex to 0 -> tries sdDirect first
    const cards = variantButtons();
    assert.equal(cards.length, 2);
    cards[1].props.onClick();
    await nextTick();
    assert.equal(getVideo().src, sdDirect);

    // Failing sdDirect falls back cleanly to sdRelayPath
    const sdVideo = getVideo();
    sdVideo.props.onError({ currentTarget: sdVideo });
    await nextTick();
    assert.equal(getVideo().src, WEIBO_API_ORIGIN + sdRelayPath);
  } finally {
    app.unmount();
  }
});

test('PR-A R2 M1: SidePanel copy direct link preserves signed relay URL for anonymous Weibo while keeping extension preview/download on direct_url', async () => {
  const { buildSidePanelQualityOptions, buildSingleDownloadEnqueueItem } = uiTargetHelpers;
  const { createRenderer, h, markRaw, nextTick, reactive } = await import('vue');

  // 1) Anonymous relay Weibo: preview/download stay direct_url first, copyUrl & fallbackUrl use signed relay URL
  const anonEnvelope = makeWeiboRelayEnvelope();
  const anonItem = anonEnvelope.data.items[0];
  const anonOptions = buildSidePanelQualityOptions(anonEnvelope.data, anonItem, WEIBO_API_ORIGIN);
  assert.equal(anonOptions.length, 1);
  assert.equal(anonOptions[0].directUrl, WEIBO_DIRECT, 'extension internal directUrl stays on direct_url');
  assert.deepEqual(anonOptions[0].routes, [WEIBO_DIRECT, WEIBO_RELAY_FULL]);
  assert.equal(anonOptions[0].copyUrl, WEIBO_RELAY_FULL, 'external copyUrl must stay on signed relay URL');

  const enqueueItem = buildSingleDownloadEnqueueItem({
    media: anonEnvelope.data,
    item: anonItem,
    option: anonOptions[0],
    settings: {
      apiBaseUrl: WEIBO_API_ORIGIN,
      bearerToken: '',
      qualityPreference: 'best',
      batchSaveMode: 'subfolder',
      subfolderPrefix: '',
      themeMode: 'system',
    },
  });
  assert.equal(enqueueItem.spec.kind, 'direct_file');
  assert.deepEqual(enqueueItem.spec.routes, [WEIBO_DIRECT, WEIBO_RELAY_FULL]);
  assert.equal(enqueueItem.fallbackUrl, WEIBO_RELAY_FULL, 'external fallbackUrl must use signed relay URL');

  // 2) Owner direct Weibo (access === "direct", no direct_url): copyUrl === directUrl
  const ownerEnvelope = structuredClone(anonEnvelope);
  ownerEnvelope.data.items[0].default = {
    variant_id: 'wb-1080p',
    source_id: 'wb-src-1080p',
    url: WEIBO_DIRECT,
    access: 'direct',
  };
  ownerEnvelope.data.items[0].variants[0].delivery.sources = [
    {
      id: 'wb-src-1080p',
      url: WEIBO_DIRECT,
      access: 'direct',
    },
  ];
  const ownerOptions = buildSidePanelQualityOptions(
    ownerEnvelope.data,
    ownerEnvelope.data.items[0],
    WEIBO_API_ORIGIN,
  );
  assert.equal(ownerOptions[0].directUrl, WEIBO_DIRECT);
  assert.equal(ownerOptions[0].copyUrl, WEIBO_DIRECT, 'owner direct source keeps direct CDN copyUrl');

  // 3) SidePanelResult.vue copy button actually copies signed relay URL (NOT Referer-locked weibocdn.com)
  const copiedTexts = [];
  const origNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) {
          copiedTexts.push(text);
        },
      },
    },
  });

  const element = (type, text = '') =>
    markRaw({
      type,
      text,
      props: {},
      children: [],
      parent: null,
      style: {},
      dataset: {},
      removeAttribute() {},
      getAttribute(name) {
        return this.props[name] ?? null;
      },
    });
  const detach = (node) => {
    if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node);
    node.parent = null;
  };
  const renderer = createRenderer({
    querySelector: () => null,
    createElement: element,
    createText: (text) => element('#text', text),
    createComment: (text) => element('#comment', text),
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) {
      detach(node);
      node.parent = parent;
      const idx = parent.children.indexOf(anchor);
      parent.children.splice(idx < 0 ? parent.children.length : idx, 0, node);
    },
    remove: detach,
    patchProp(node, key, _, value) {
      node.props[key] = value;
      if (key === 'src') node.src = value;
    },
  });
  const findAll = (node, match) => [
    ...(match(node) ? [node] : []),
    ...node.children.flatMap((child) => findAll(child, match)),
  ];
  const textOf = (node) => (node.text || '') + node.children.map(textOf).join('');

  const state = reactive({
    media: anonEnvelope.data,
    workFingerprint: 'weibo:500123456',
    isSaved: false,
    settings: {
      apiBaseUrl: WEIBO_API_ORIGIN,
      bearerToken: '',
      qualityPreference: 'best',
      batchSaveMode: 'subfolder',
      subfolderPrefix: '',
      themeMode: 'system',
    },
    resolvingItemIds: new Set(),
  });
  const root = element('root');
  const app = renderer.createApp({
    render: () => h(SidePanelResult, { ...state }),
  });
  app.mount(root);
  await nextTick();

  try {
    // Video preview stays on Weibo direct_url
    const videoEl = findAll(root, (n) => n.type === 'video')[0];
    assert.equal(videoEl?.src, WEIBO_DIRECT);

    // Clicking "复制直链" copies signed relay URL
    const copyBtn = findAll(
      root,
      (n) => n.type === 'button' && textOf(n).includes('复制直链'),
    )[0];
    assert.ok(copyBtn, 'expected 复制直链 button in SidePanelResult');
    await copyBtn.props.onClick();
    assert.deepEqual(copiedTexts, [WEIBO_RELAY_FULL]);
  } finally {
    app.unmount();
    if (origNavDescriptor) {
      Object.defineProperty(globalThis, 'navigator', origNavDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});
