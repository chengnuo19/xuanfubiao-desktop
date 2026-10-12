const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('./floatbar-model.js');

const {
  createApp,
  faviconUrlFor,
  moveApp,
  normalizeHttpUrl,
  sanitizeApps,
} = globalThis.__xfbFloatBarModel;

describe('FloatBar model', () => {
  it('normalizes a bare host to a secure URL', () => {
    assert.equal(normalizeHttpUrl('  example.com/path  '), 'https://example.com/path');
  });

  it('rejects non-http URLs', () => {
    assert.throws(() => normalizeHttpUrl('javascript:alert(1)'), /仅支持 HTTP\/HTTPS/);
    assert.throws(() => normalizeHttpUrl('file:///C:/secret.txt'), /仅支持 HTTP\/HTTPS/);
  });

  it('creates a trimmed app with a stable id supplied by the caller', () => {
    assert.deepEqual(
      createApp({ id: 'app-1', name: '  Docs  ', url: 'docs.example.com', icon: '  ' }),
      { id: 'app-1', name: 'Docs', url: 'https://docs.example.com/', icon: '' },
    );
  });

  it('derives a same-origin favicon URL without contacting a third party', () => {
    assert.equal(faviconUrlFor('https://example.com/path?q=1'), 'https://example.com/favicon.ico');
  });

  it('drops malformed saved entries and deduplicates ids', () => {
    const apps = sanitizeApps([
      { id: 'same', name: 'One', url: 'https://one.example/', icon: '' },
      { id: 'same', name: 'Duplicate', url: 'https://two.example/', icon: '' },
      { id: 'bad', name: '', url: 'https://bad.example/', icon: '' },
      { id: 'script', name: 'Unsafe', url: 'javascript:alert(1)', icon: '' },
    ]);

    assert.deepEqual(apps.map((app) => app.id), ['same']);
  });

  it('moves an app before or after the target without mutating the input', () => {
    const input = [
      { id: 'a', name: 'A', url: 'https://a.example/', icon: '' },
      { id: 'b', name: 'B', url: 'https://b.example/', icon: '' },
      { id: 'c', name: 'C', url: 'https://c.example/', icon: '' },
    ];

    assert.deepEqual(moveApp(input, 'a', 'c', 'after').map((app) => app.id), ['b', 'c', 'a']);
    assert.deepEqual(moveApp(input, 'c', 'a', 'before').map((app) => app.id), ['c', 'a', 'b']);
    assert.deepEqual(input.map((app) => app.id), ['a', 'b', 'c']);
  });
});
