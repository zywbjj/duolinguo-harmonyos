import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from './load-service.mjs';

const nav = await loadService('NavigationPolicy');
const { PermissionGate, AUDIO_RESOURCE } = await loadService('PermissionGate');
const { DiagnosticsService } = await loadService('DiagnosticsService');
const origin = 'https://www.duolingo.com';

test('official HTTPS origins work with paths, case normalization and default port', () => {
  for (const address of [origin, `${origin}/learn?from=test#lesson`, 'https://WWW.DUOLINGO.COM:443/learn',
    'https://duolingo.com', 'https://duolingo.cn/learn', 'https://www.duolingo.cn']) {
    assert.equal(nav.navigationAction(address), 'internal', address);
  }
});

test('lookalikes, suffix hosts, credentials, ports and arbitrary subdomains cannot gain microphone trust', () => {
  for (const address of ['https://www.duolingo.com.evil.test', 'https://evilduolingo.com',
    'https://duolingo.com@evil.test', 'https://user@www.duolingo.com', 'https://www.duolingo.com:8443',
    'https://unverified.duolingo.com', 'https://www.duolingo.com.', 'http://www.duolingo.com',
    'https://www.duolıngo.com']) {
    assert.equal(nav.isLearningOrigin(address), false, address);
  }
});

test('external HTTPS can be offered to the browser; active content and unsupported schemes are blocked', () => {
  assert.equal(nav.navigationAction('https://accounts.google.com/login'), 'external');
  for (const address of ['javascript:alert(1)', 'data:text/html,hi', 'file:///secret', 'intent://test',
    'http://example.com', 'not a url', 'https://user:password@example.com']) {
    assert.equal(nav.navigationAction(address), 'blocked', address);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('mixed resource requests only receive audio, never camera access', async () => {
  const gate = new PermissionGate();
  const results = [];
  await gate.request(origin, [AUDIO_RESOURCE, 'TYPE_VIDEO_CAPTURE'], async () => true,
    () => true, resources => results.push(resources));
  assert.deepEqual(results, [[AUDIO_RESOURCE]]);
});

test('invalid origins, background windows and non-audio requests never invoke a system prompt', async () => {
  let prompts = 0;
  for (const [address, resources, current] of [['https://duolingo.com.evil.test', [AUDIO_RESOURCE], true],
    [origin, ['TYPE_VIDEO_CAPTURE'], true], [origin, [AUDIO_RESOURCE], false]]) {
    const results = [];
    await new PermissionGate().request(address, resources, async () => { prompts++; return true; },
      () => current, resources => results.push(resources));
    assert.deepEqual(results, [[]]);
  }
  assert.equal(prompts, 0);
});

test('navigation invalidates pending requests exactly once; a late system grant cannot leak to a new page', async () => {
  const gate = new PermissionGate();
  const system = deferred();
  const results = [];
  const pending = gate.request(origin, [AUDIO_RESOURCE], () => system.promise, () => true,
    resources => results.push(resources));
  gate.invalidate();
  gate.invalidate();
  assert.deepEqual(results, [[]]);
  system.resolve(true);
  await pending;
  assert.deepEqual(results, [[]]);
  await gate.request(origin, [AUDIO_RESOURCE], async () => true, () => true,
    resources => results.push(resources));
  assert.deepEqual(results, [[], [AUDIO_RESOURCE]]);
});

test('concurrent audio consumers share the same permission decision without rejecting each other', async () => {
  const gate = new PermissionGate();
  const system = deferred();
  let prompts = 0;
  const results = [];
  const first = gate.request(origin, [AUDIO_RESOURCE], () => { prompts++; return system.promise; },
    () => true, resources => results.push(resources));
  await gate.request(origin, [AUDIO_RESOURCE], async () => { prompts++; return true; },
    () => true, resources => results.push(resources));
  assert.deepEqual(results, []);
  assert.equal(prompts, 1);
  system.resolve(true);
  await first;
  assert.deepEqual(results, [[AUDIO_RESOURCE], [AUDIO_RESOURCE]]);
});

test('an old document cannot cancel the permission batch of its replacement', async () => {
  const gate = new PermissionGate(), first = deferred(), second = deferred(), results = [];
  const old = gate.request(origin, [AUDIO_RESOURCE], () => first.promise, () => true, value => results.push(['old', value]));
  gate.invalidate();
  const next = gate.request(origin, [AUDIO_RESOURCE], () => second.promise, () => true, value => results.push(['next', value]));
  first.resolve(true); await old;
  assert.deepEqual(results, [['old', []]]);
  second.resolve(true); await next;
  assert.deepEqual(results, [['old', []], ['next', [AUDIO_RESOURCE]]]);
});

test('a background transition detected after a system grant still denies the webpage', async () => {
  const gate = new PermissionGate();
  const system = deferred();
  let foreground = true;
  const results = [];
  const pending = gate.request(origin, [AUDIO_RESOURCE], () => system.promise, () => foreground,
    resources => results.push(resources));
  foreground = false;
  system.resolve(true);
  await pending;
  assert.deepEqual(results, [[]]);
});

test('denied permissions do not prompt in a loop; a new navigation permits another attempt', async () => {
  const gate = new PermissionGate();
  let prompts = 0;
  let authorized = false;
  const ask = async allowPrompt => { if (allowPrompt) prompts++; return authorized; };
  await gate.request(origin, [AUDIO_RESOURCE], ask, () => true, () => {});
  await gate.request(origin, [AUDIO_RESOURCE], ask, () => true, () => {});
  assert.equal(prompts, 1);
  authorized = true;
  const results = [];
  await gate.request(origin, [AUDIO_RESOURCE], ask, () => true, value => results.push(value));
  assert.deepEqual(results, [[AUDIO_RESOURCE]]);
  assert.equal(prompts, 1);
  gate.invalidate();
  await gate.request(origin, [AUDIO_RESOURCE], ask, () => true, () => {});
  assert.equal(prompts, 2);
});

test('system permission errors deny exactly once', async () => {
  const results = [];
  await new PermissionGate().request(origin, [AUDIO_RESOURCE], async () => { throw new Error('failure'); },
    () => true, resources => results.push(resources));
  assert.deepEqual(results, [[]]);
});

test('diagnostics redact credential-bearing URLs and all paths, queries and fragments', () => {
  DiagnosticsService.record('load_error', `${origin}/users/private?token=SECRET#PASSWORD`, -1);
  DiagnosticsService.record('blocked_link', 'https://user:SECRET@example.com/path');
  const report = DiagnosticsService.snapshot();
  assert.match(report, /https:\/\/www\.duolingo\.com/);
  assert.doesNotMatch(report, /private|token|SECRET|PASSWORD|user:/);
});

test('diagnostics remain bounded', () => {
  for (let index = 0; index < 80; index++) DiagnosticsService.record('page_begin', origin, index);
  assert.equal(DiagnosticsService.snapshot().split('\n').length, 41);
});
