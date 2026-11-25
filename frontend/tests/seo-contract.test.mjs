import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const homepage = 'https://snap.dokitool.com/';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const meta = [...html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"\s*\/?>/g)];
const metadata = new Map(meta.map(([, name, content]) => [name, content]));

test('canonical and social metadata identify the same real homepage and image', async () => {
  assert.deepEqual([...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]+)"/g)].map(match => match[1]), [homepage]);
  for (const name of ['og:type', 'og:locale', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) {
    assert.equal(meta.filter(match => match[1] === name).length, 1, `${name} must appear once`);
    assert.ok(metadata.get(name)?.trim(), `${name} must not be empty`);
  }
  assert.equal(metadata.get('og:url'), homepage);
  assert.equal(metadata.get('og:type'), 'website');
  assert.equal(metadata.get('twitter:card'), 'summary_large_image');
  assert.equal(metadata.get('og:title'), html.match(/<title>(.*?)<\/title>/s)[1]);
  assert.equal(metadata.get('twitter:title'), metadata.get('og:title'));
  assert.equal(metadata.get('twitter:image'), metadata.get('og:image'));
  const imageUrl = new URL(metadata.get('og:image'));
  assert.equal(imageUrl.origin, new URL(homepage).origin);
  assert.equal(imageUrl.search + imageUrl.hash, '');
  const image = await sharp(fileURLToPath(new URL(`../public${imageUrl.pathname}`, import.meta.url))).metadata();
  assert.equal(image.format, 'png');
  assert.equal(image.width, Number(metadata.get('og:image:width')));
  assert.equal(image.height, Number(metadata.get('og:image:height')));
  assert.equal(image.width, 1200);
  assert.equal(image.height, 630);
});

test('structured data declares the application without invented reviews or search endpoints', () => {
  const blocks = [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const graph = JSON.parse(blocks[0][1]);
  assert.equal(graph['@context'], 'https://schema.org');
  assert.deepEqual(graph['@graph'].map(item => item['@type']).sort(), ['WebApplication', 'WebSite']);
  const website = graph['@graph'].find(item => item['@type'] === 'WebSite');
  const app = graph['@graph'].find(item => item['@type'] === 'WebApplication');
  for (const item of graph['@graph']) {
    assert.equal(item.url, homepage);
    assert.equal(item.name, 'DokiTool');
    assert.equal(item.inLanguage, 'zh-CN');
    assert.ok(item.description.length > 10);
    for (const inventedField of ['aggregateRating', 'review', 'potentialAction']) assert.equal(item[inventedField], undefined);
  }
  assert.equal(app.isPartOf['@id'], website['@id']);
  assert.equal(app.applicationCategory, 'MultimediaApplication');
  assert.equal(app.isAccessibleForFree, true);
  for (const name of ['抖音', '快手', 'B站', '小红书', '今日头条', '微博', '皮皮虾', '皮皮搞笑', '最右', 'X', 'YouTube', 'Instagram', 'Facebook', 'Tumblr']) {
    assert.ok(metadata.get('description')?.includes(name), `meta description must include ${name}`);
    assert.ok(metadata.get('keywords')?.includes(name), `meta keywords must include ${name}`);
    assert.ok(app.description.includes(name), `WebApplication description must include ${name}`);
  }
  assert.ok(!metadata.get('description')?.includes('Dailymotion'));
  assert.ok(!metadata.get('keywords')?.includes('Dailymotion'));
  assert.ok(!app.description.includes('Dailymotion'));
});

test('crawler files expose only the homepage and keep APIs out of the crawl plan', async () => {
  const robots = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Sitemap: https:\/\/snap\.dokitool\.com\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /^Disallow:\s*\/$/m);
  const sitemap = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.deepEqual([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]), [homepage]);
  assert.doesNotMatch(sitemap, /<lastmod>|<changefreq>|<priority>/);
});

test('Caddy routes crawler, llms.txt, and share files directly before the final static fallback without SPA soft-404 try_files', async () => {
  const caddy = await readFile(new URL('../../ops/examples/snap.caddy', import.meta.url), 'utf8');
  assert.doesNotMatch(
    caddy,
    /try_files\s+\{path\}\s+\/index\.html/,
    'snap.caddy must not contain SPA soft-404 fallback `try_files {path} /index.html`',
  );
  const fallbackMatch = /\n[ \t]*handle\s*\{\s*\n[ \t]*root \* \/srv\/dokitool\/current\/frontend\/dist/.exec(caddy);
  assert.ok(fallbackMatch, 'snap.caddy must contain the final static fallback `handle {` block');
  for (const [path, contentType] of [
    ['/robots.txt', 'text/plain; charset=utf-8'],
    ['/sitemap.xml', 'application/xml; charset=utf-8'],
    ['/llms.txt', 'text/plain; charset=utf-8'],
    ['/social/dokitool-share-v1.png', 'image/png'],
  ]) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blocks = [...caddy.matchAll(new RegExp(`handle ${escaped} \\{([^{}]+)\\}`, 'g'))];
    assert.equal(blocks.length, 1, `${path} needs one exact, non-wildcard handle`);
    assert.match(blocks[0][1], /root \* \/srv\/dokitool\/current\/frontend\/dist/);
    assert.match(blocks[0][1], /\bfile_server\b/);
    assert.ok(blocks[0][1].includes(`header Content-Type "${contentType}"`));
    assert.match(blocks[0][1], /header Cache-Control "no-cache"/);
    assert.doesNotMatch(blocks[0][1], /try_files|rewrite|pass_thru|index\.html/);
    assert.ok(
      blocks[0].index < fallbackMatch.index,
      `${path} must appear before the final static fallback handle {`,
    );
  }
});

test('public/llms.txt exists and accurately documents DokiTool, all 14 core platforms, and no-cookie architecture', async () => {
  const llms = await readFile(new URL('../public/llms.txt', import.meta.url), 'utf8');
  assert.ok(llms.includes('DokiTool'), 'public/llms.txt must mention DokiTool');
  for (const [label, pattern] of [
    ['Douyin', /douyin|抖音/i],
    ['Kuaishou', /kuaishou|快手/i],
    ['Bilibili', /bilibili|b站/i],
    ['Xiaohongshu', /xiaohongshu|小红书/i],
    ['Toutiao', /toutiao|今日头条/i],
    ['Weibo', /weibo|微博/i],
    ['Pipixia', /pipixia|皮皮虾/i],
    ['Pipigx', /pipigx|皮皮搞笑/i],
    ['Zuiyou', /zuiyou|最右/i],
    ['X / Twitter', /\bx\b|twitter/i],
    ['YouTube', /youtube/i],
    ['Instagram', /instagram/i],
    ['Facebook', /facebook/i],
    ['Tumblr', /tumblr/i],
  ]) {
    assert.match(llms, pattern, `public/llms.txt must mention ${label}`);
  }
  assert.match(
    llms,
    /no[- ]?cookie|cookie[- ]?free|zero\s+(?:user\s+)?cookies?|无\s*cookie|不(?:需要|收集|携带).*cookie/i,
    'public/llms.txt must describe the no-cookie architecture',
  );
});

test('public/llms.txt Chrome extension version matches extensionReleaseMeta.json SSOT', async () => {
  const [llms, releaseMetaRaw] = await Promise.all([
    readFile(new URL('../public/llms.txt', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/extensionReleaseMeta.json', import.meta.url), 'utf8'),
  ]);
  const releaseMeta = JSON.parse(releaseMetaRaw);
  assert.equal(
    typeof releaseMeta.version,
    'string',
    'extensionReleaseMeta.json must declare a string version',
  );
  assert.match(
    releaseMeta.version,
    /^\d+\.\d+\.\d+$/,
    `extensionReleaseMeta.json version must be semver: ${releaseMeta.version}`,
  );
  const expectedVersionTag = `v${releaseMeta.version}`;
  assert.ok(
    llms.includes(expectedVersionTag),
    `public/llms.txt must contain exact extension version ${expectedVersionTag} from src/core/extensionReleaseMeta.json`,
  );
  const extLine = llms
    .split('\n')
    .find((line) => /chrome\s+mv3\s+extension/i.test(line));
  assert.ok(extLine, 'public/llms.txt must contain the Chrome MV3 Extension line');
  assert.ok(
    extLine.includes(`\`${expectedVersionTag}\``),
    `public/llms.txt Chrome MV3 Extension line must reference \`${expectedVersionTag}\`, got: ${extLine}`,
  );
});

test('public favicon.ico exists with a valid ICO header and non-empty icon directory', async () => {
  const ico = await readFile(new URL('../public/favicon.ico', import.meta.url));
  assert.ok(ico.byteLength >= 70, 'favicon.ico must contain header, directory entry, and image payload');
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field must be 0');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type field must be 1');
  assert.ok(ico.readUInt16LE(4) >= 1, 'ICO must declare at least one icon image');
});
