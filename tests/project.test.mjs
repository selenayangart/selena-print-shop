import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const context = { window: {} };
vm.runInNewContext(read('data/works.js'), context);
vm.runInNewContext(read('data/translations.js'), context);
const works = context.window.WORKS;

test('only neutral placeholder artwork assets are included', () => {
  assert.deepEqual(fs.readdirSync(path.join(root, 'images/art')).sort(), [
    'placeholder-landscape.svg', 'placeholder-portrait.svg'
  ]);
  for (const work of works) {
    assert.match(work.title, /^Study \d{2}$/);
    assert.match(work.collection, /^Collection [AB]$/);
    assert.doesNotMatch(JSON.stringify(work), /Selena Yang|Organic Utopia|Bouncy Waters|Auxin|Neuron|CRISPR/i);
  }
});

test('catalog has unique, renderable works and no production checkout identifiers', () => {
  assert.ok(works.length > 1);
  assert.equal(new Set(works.map(work => work.slug)).size, works.length);
  for (const work of works) {
    assert.ok(work.title && Number.isFinite(work.year));
    assert.match(work.imagePath, /^images\/art\/placeholder-(portrait|landscape)\.svg$/);
    assert.ok(fs.statSync(path.join(root, work.imagePath)).size > 0);
    assert.equal(work.publicOwnership, undefined);
    assert.equal(work.media, undefined);
    for (const print of work.prints || []) {
      assert.match(print.size, /\d.*[x×].*\d/);
      assert.equal(print.variant, '');
      assert.equal(print.url, undefined);
    }
  }
});

test('browser scripts parse and entry-point assets exist', () => {
  const html = read('index.html');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const file = match[1];
    if (/^https?:/.test(file)) continue;
    assert.ok(fs.existsSync(path.join(root, file)), file);
    if (file.endsWith('.js')) new vm.Script(read(file), { filename: file });
  }
});

test('feature translations include literal translation calls', () => {
  const feature = fs.existsSync(path.join(root, 'src/room.js')) ? 'src/room.js' : 'src/explore.js';
  const keys = [...read(feature).matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1]);
  for (const language of ['en', 'zh', 'ko']) {
    for (const key of keys) assert.ok(context.window.TRANSLATIONS[language][key], language + ': ' + key);
  }
});

test('no tracking, private records, or credential-bearing environment files are shipped', () => {
  for (const forbidden of ['.env', '.env.local', '.vercel', 'private', 'api', 'src/analytics.js']) {
    assert.equal(fs.existsSync(path.join(root, forbidden)), false, forbidden);
  }
  const sources = ['index.html', ...fs.readdirSync(path.join(root, 'src')).map(file => 'src/' + file), 'data/works.js'];
  for (const file of sources) {
    assert.doesNotMatch(read(file), /(?:shp(?:at|ss|ca)_|atkn_)[a-zA-Z0-9]{12,}|-----BEGIN .*PRIVATE KEY-----/, file);
    assert.doesNotMatch(read(file), /googletagmanager\.com|posthog\.com|connect\.facebook\.net/, file);
  }
});

test('print shop checkout starts disabled with no store configured', () => {
  if (!fs.existsSync(path.join(root, 'config.js'))) return;
  const config = { window: {} };
  vm.runInNewContext(read('config.js'), config);
  assert.equal(config.window.SITE.checkoutEnabled, false);
  assert.equal(config.window.SITE.shopify.domain, '');
  assert.equal(config.window.SITE.shopify.storefrontToken, undefined);
  assert.ok(read('src/room.js').includes("buy.setAttribute('aria-disabled', 'true')"));
});
