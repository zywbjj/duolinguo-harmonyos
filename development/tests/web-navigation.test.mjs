import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadService } from './load-service.mjs';

const { navigationScript, parseNavigationReport, carryNavigation, safeNavigationIcon } = await loadService('WebNavigation');

// Synthetic mobile navigation. No real Duolingo HTML or account data is stored.
function fixture() {
  const timers = new Map(), observers = new Set(), clicks = [];
  let sequence = 0, now = 10000;
  const location = new URL('https://www.duolingo.com/learn');
  const events = new EventTarget();
  const documentEvents = new EventTarget();
  function style() {
    const properties = new Map(), changes = [];
    return {
      changes,
      getPropertyValue: name => properties.get(name)?.value ?? '',
      getPropertyPriority: name => properties.get(name)?.priority ?? '',
      setProperty: (name, value, priority = '') => { changes.push({ name, value }); properties.set(name, { value, priority }); },
      removeProperty: name => { changes.push({ name, value: '' }); properties.delete(name); }
    };
  }
  let root, links;
  function makeRoot() {
    const node = { isConnected: true, style: style(), rect: { top: 700, bottom: 776, width: 390, height: 76 },
      getBoundingClientRect: () => node.rect, querySelectorAll: () => links };
    return node;
  }
  function makeLinks() {
    return ['/learn', '/sounds', '/practice-hub', '/quests', '/shop', '/profile/fixture'].map(path => ({
      href: location.origin + path, target: '', parentElement: root, textContent: 'fixture', style: style(),
      getBoundingClientRect: () => ({ width: 50, height: 56 }), getAttribute: () => null,
      querySelector: () => null, hasAttribute: () => false,
      click: () => { clicks.push(path); location.pathname = path; }
    }));
  }
  root = makeRoot(); links = makeLinks();
  const document = { documentElement: {}, querySelectorAll: selector =>
    root.isConnected ? (selector === 'a[href]' ? links : [root]) : [] };
  document.hidden=false;
  document.addEventListener=documentEvents.addEventListener.bind(documentEvents);
  document.removeEventListener=documentEvents.removeEventListener.bind(documentEvents);
  Object.defineProperty(document, 'cookie', { get() { throw new Error('Must not read cookies'); } });
  const context = vm.createContext({ window: {addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)}, document, location, URL, Date: { now: () => now },
    innerWidth: 390, innerHeight: 776,
    getComputedStyle: element => ({ display: 'flex',
      opacity: element.style.getPropertyValue('opacity') || '1',
      visibility: element.style.getPropertyValue('visibility') || 'visible' }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback:()=>{timers.delete(id);callback();}, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  return {
    get root() { return root; }, get links() { return links; }, location, clicks, timers, observers, events,
    visibility(hidden){document.hidden=hidden;documentEvents.dispatchEvent(new Event('visibilitychange'));},
    replaceRoot() { root.isConnected = false; root = makeRoot(); links = makeLinks(); },
    flush(records = [{ type: 'childList', target: document.documentElement }]) {
      [...observers].forEach(observer => observer.callback(records));
    },
    advance(ms) { now += ms; },
    run: (command = 'scan', index = -1, expectedPage = location.pathname, expectedPath = '') =>
      JSON.parse(vm.runInContext(navigationScript(command, index, expectedPage, expectedPath), context))
  };
}

test('scanning discovers actual menu paths without hiding the original before acknowledgement', () => {
  const f = fixture(), report = f.run();
  assert.equal(report.items.length, 6);
  assert.equal(report.items[0].label, '学习');
  assert.equal(report.selected, 0);
  assert.equal(report.attached, false);
  assert.equal(f.root.style.getPropertyValue('opacity'), '');
  assert.equal(f.timers.size, 0);
});

test('attach and detach preserve the exact original opacity and pointer styles', () => {
  const f = fixture();
  f.root.style.setProperty('pointer-events', 'auto', 'important');
  f.root.style.setProperty('opacity', '0.8', 'important');
  assert.equal(f.run('attach').attached, true);
  assert.equal(f.root.style.getPropertyValue('opacity'), '0');
  assert.equal(f.root.style.getPropertyValue('pointer-events'), 'none');
  f.run('detach');
  assert.equal(f.root.style.getPropertyValue('opacity'), '0.8');
  assert.equal(f.root.style.getPropertyPriority('opacity'), 'important');
  assert.equal(f.root.style.getPropertyValue('pointer-events'), 'auto');
  assert.equal(f.timers.size, 0);
  assert.equal(f.observers.size, 0);
});

test('polling never restores the original and does not accumulate observers or timers', () => {
  const f = fixture();
  f.run('attach');
  const changes = f.root.style.changes.length;
  for (let i = 0; i < 5; i++) assert.equal(f.run().attached, true);
  assert.equal(f.root.style.changes.length, changes);
  assert.equal(f.timers.size, 1);
  assert.equal(f.observers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 2400);
});

test('watchdog restores the original and removes the observer when the native side stops renewing', () => {
  const f = fixture();
  f.run('attach');
  [...f.timers.values()][0].callback();
  assert.equal(f.root.style.getPropertyValue('opacity'), '');
  assert.equal(f.root.style.getPropertyValue('pointer-events'), '');
  assert.equal(f.observers.size, 0);
});

test('native activation keeps both ownership and a nonempty native report throughout the click', () => {
  const f = fixture();
  f.run('attach');
  const changes = f.root.style.changes.length;
  const report = f.run('activate', 2, '/learn', '/practice-hub');
  assert.deepEqual(f.clicks, ['/practice-hub']);
  assert.equal(f.root.style.getPropertyValue('opacity'), '0');
  assert.equal(f.root.style.changes.length, changes);
  assert.equal(report.items.length, 6);
  assert.equal(report.attached, true);
  assert.equal(report.selected, 2);
});

test('a stale page or mismatched target cannot click a wrong feature or expose the original', () => {
  const f = fixture();
  f.run('attach');
  f.run('activate', 2, '/shop', '/practice-hub');
  f.run('activate', 2, '/learn', '/shop');
  assert.deepEqual(f.clicks, []);
  assert.equal(f.root.style.getPropertyValue('opacity'), '0');
});

test('known same-document destinations keep ownership; a changed menu requires acknowledgement', () => {
  const f = fixture();
  f.run('attach');
  f.location.pathname = '/shop';
  const report = f.run();
  assert.equal(report.attached, true);
  assert.equal(report.selected, 4);
  assert.equal(f.root.style.getPropertyValue('opacity'), '0');
  f.links.reverse();
  assert.equal(f.run().attached, false);
  assert.equal(f.root.style.getPropertyValue('opacity'), '');
  assert.equal(f.run('attach').attached, true);
});

test('a replacement navigation node is hidden in the mutation callback without waiting for polling', () => {
  const f = fixture();
  f.run('attach');
  f.location.pathname = '/shop';
  f.replaceRoot();
  assert.equal(f.root.style.getPropertyValue('opacity'), '');
  f.flush();
  assert.equal(f.root.style.getPropertyValue('opacity'), '0');
  assert.equal(f.run().attached, true);
});

test('a short DOM gap retains a pending native report and recovers on the replacement node', () => {
  const f = fixture();
  f.run('attach');
  f.links[2].click = () => { f.location.pathname = '/practice-hub'; f.root.isConnected = false; };
  const pending = f.run('activate', 2, '/learn', '/practice-hub');
  assert.equal(pending.pending, true);
  assert.equal(pending.attached, true);
  assert.equal(pending.items.length, 6);
  f.replaceRoot();
  f.flush();
  assert.equal(f.root.style.getPropertyValue('opacity'), '0');
  assert.equal(f.run().pending, false);
});

test('a DOM gap is bounded rather than keeping an unusable native bar forever', () => {
  const f = fixture();
  f.run('attach');
  f.links[2].click = () => { f.location.pathname = '/practice-hub'; f.root.isConnected = false; };
  f.run('activate', 2, '/learn', '/practice-hub');
  f.advance(1600);
  assert.equal(f.run().items.length, 0);
  assert.equal(f.observers.size, 1);
  [...f.timers.values()][0].callback();assert.equal(f.observers.size,0);
});

test('external style replacement is re-hidden without an observer loop', () => {
  const f = fixture();
  f.run('attach');
  f.root.style.setProperty('opacity', '1');
  const records = [{ type: 'attributes', target: f.root }];
  f.flush(records);
  assert.equal(f.root.style.getPropertyValue('opacity'), '0');
  const changes = f.root.style.changes.length;
  f.flush(records);
  assert.equal(f.root.style.changes.length, changes);
});

test('secondary pages and removed menus suspend the dock but keep a bounded same-document return watcher', () => {
  for (const change of [f => { f.location.pathname = '/lesson/fixture'; },
    f => { f.root.isConnected = false; }, f => { f.root.rect.top = 0; f.root.rect.bottom = 76; }]) {
    const f = fixture();
    f.run('attach');
    change(f);
    assert.equal(f.run().items.length, 0);
    assert.equal(f.root.style.getPropertyValue('opacity'), '');
    assert.equal(f.observers.size, 1);
    f.run('detach'); assert.equal(f.observers.size, 0);
  }
});

test('all observed primary menus are concealed before the next native poll after secondary pages', () => {
  const secondaries=['/lesson/fixture','/settings/account','/profile/fixture/achievements','/practice-hub/words'];
  const primaries=['/learn','/sounds','/practice-hub','/quests','/shop','/profile/fixture'];
  for(const secondary of secondaries) for(const primary of primaries) {
    const f=fixture();f.run('attach');f.location.pathname=secondary;f.root.isConnected=false;f.flush();f.run();
    // Long secondary-page dwell: native liveness checks must not disarm the watcher.
    f.advance(1800);assert.equal(f.run().items.length,0);
    f.advance(1800);f.run();f.location.pathname=primary;f.replaceRoot();f.flush();
    assert.equal(f.root.style.getPropertyValue('opacity'),'0',secondary+' -> '+primary);
    const pending=f.run();assert.equal(pending.items.length,6);assert.equal(pending.attached,false);
    assert.equal(f.run('attach').attached,true);f.run('detach');
  }
});

test('return concealment expires even if the native host polls but never acknowledges dock layout', () => {
  const f=fixture();f.run('attach');f.location.pathname='/settings/account';f.root.isConnected=false;f.run();
  f.location.pathname='/learn';f.replaceRoot();f.flush();assert.equal(f.root.style.getPropertyValue('opacity'),'0');
  f.advance(900);f.run();f.advance(700);f.flush();
  assert.equal(f.root.style.getPropertyValue('opacity'),'');assert.equal(f.observers.size,0);
});

test('return guard ignores changed menu paths and explicit detach prevents any later concealment', () => {
  const f=fixture();f.run('attach');f.location.pathname='/settings/account';f.root.isConnected=false;f.run();
  f.location.pathname='/learn';f.replaceRoot();f.links.reverse();f.flush();
  assert.equal(f.root.style.getPropertyValue('opacity'),'');assert.equal(f.observers.size,0);
  f.run('attach');f.run('detach');f.replaceRoot();f.flush();assert.equal(f.root.style.getPropertyValue('opacity'),'');
});

test('external links, credentials and query-bearing links are never adopted', () => {
  for (const address of ['https://evil.test/shop', 'https://user:pass@www.duolingo.com/shop',
    'https://www.duolingo.com/shop?token=PRIVATE', 'https://www.duolingo.com/shop#fragment']) {
    const f = fixture();
    f.links[4].href = address;
    assert.equal(f.run('attach').items.length, 0);
    assert.equal(f.root.style.getPropertyValue('opacity'), '');
  }
});

test('the script refuses external documents and arbitrary commands', () => {
  const f = fixture();
  f.location.hostname = 'evil.test';
  assert.equal(f.run('attach').items.length, 0);
  assert.throws(() => navigationScript('anything'));
  assert.throws(() => navigationScript('activate', 1.5));
  assert.throws(() => navigationScript('activate', 99));
  assert.throws(() => navigationScript('scan',-1,'','',NaN,800));
  assert.throws(() => navigationScript('scan',-1,'','',301,800));
});

test('reports support both ArkWeb string encodings and bounded dock heights', () => {
  const report = fixture().run('attach');
  report.height = 999;
  for (const raw of [JSON.stringify(report), JSON.stringify(JSON.stringify(report))]) {
    const result = parseNavigationReport(raw, 'https://www.duolingo.com/learn');
    assert.equal(result.items.length, 6);
    assert.equal(result.height, 120);
    assert.equal(result.attached, true);
  }
});

test('native report validation rejects stale pages, malformed paths, indexes and labels', () => {
  const report = fixture().run();
  for (const change of [r => { r.origin = 'https://www.duolingo.com.evil.test'; },
    r => { r.page = '/shop'; }, r => { r.selected = -1; }, r => { r.items[1].path = '//evil.test/path'; },
    r => { r.items[1].path = '/shop?token=PRIVATE'; }, r => { r.items[1].label = '\nunsafe'; },
    r => { r.items[1].path = '/learn'; }, r => { r.items[0] = null; }]) {
    const modified = structuredClone(report);
    change(modified);
    assert.equal(parseNavigationReport(JSON.stringify(modified), 'https://www.duolingo.com/learn').items.length, 0);
  }
  assert.equal(parseNavigationReport(JSON.stringify(report), 'https://evil.test/learn').items.length, 0);
});

test('the native bar can remain mounted for known routes but is removed for a lesson or other origin', () => {
  const original = parseNavigationReport(JSON.stringify(fixture().run('attach')), 'https://www.duolingo.com/learn');
  const next = carryNavigation(original, 'https://www.duolingo.com/practice-hub/words');
  assert.equal(next.items.length, 6);
  assert.equal(next.selected, 2);
  assert.equal(next.attached, true);
  assert.equal(next.pending, true);
  assert.equal(carryNavigation(original, 'https://www.duolingo.com/lesson/fixture').items.length, 0);
  assert.equal(carryNavigation(original, 'https://evil.test/shop').items.length, 0);
  assert.equal(carryNavigation(original, 'https://www.duolingo.com/practice-hub/words', true).items.length, 0);
  assert.equal(carryNavigation(original, 'https://www.duolingo.com/practice-hub', true).items.length, 6);
});

test('factory icon sources accept bounded PNG data and verified public image origins only', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
  assert.equal(safeNavigationIcon(png), png);
  const asset = 'https://d35aaqx5ub95lt.cloudfront.net/images/fixture.svg';
  assert.equal(safeNavigationIcon(asset), asset);
  assert.equal(safeNavigationIcon('https://simg-ssl.duolingo.com/fixture.png'), 'https://simg-ssl.duolingo.com/fixture.png');
  for (const source of ['https://www.duolingo.com.evil.test/fixture.png', 'https://other.cloudfront.net/fixture.png',
    'http://www.duolingo.com/fixture.png', 'https://user:password@www.duolingo.com/fixture.png',
    'https://www.duolingo.com:8443/fixture.png', 'https://www.duolingo.com/fixture.png?token=PRIVATE',
    'data:image/svg+xml;base64,PHN2Zz4=', 'file:///private.png', 'data:image/png;base64,HTML',
    'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(50000), undefined]) {
    assert.equal(safeNavigationIcon(source), '');
  }
});

test('invalid icon fields cannot break navigation and valid original images survive native route carry', () => {
  const report = fixture().run('attach');
  report.items[0].image = 'https://www.duolingo.com/images/fixture.svg';
  report.items[1].image = 'https://evil.test/private.png';
  report.items[2].image = { unsafe: true };
  const parsed = parseNavigationReport(JSON.stringify(report), 'https://www.duolingo.com/learn');
  assert.equal(parsed.items.length, 6);
  assert.equal(parsed.items[0].image, report.items[0].image);
  assert.equal(parsed.items[1].image, '');
  assert.equal(parsed.items[2].image, '');
  assert.equal(carryNavigation(parsed, 'https://www.duolingo.com/shop').items[0].image, report.items[0].image);
});

test('native pause retains the hidden original beyond the foreground watchdog and resumes without reattach',()=>{
  const f=fixture();f.run('attach');f.run('pause');assert.equal(f.timers.size,0);
  f.advance(60000);f.flush();assert.equal(f.root.style.getPropertyValue('opacity'),'0');
  assert.equal(f.run().attached,true);assert.equal(f.timers.size,1);
  [...f.timers.values()][0].callback();assert.equal(f.root.style.getPropertyValue('opacity'),'');
});

test('visibility restoration conceals a rebuilt footer before host polling and restarts the fail-safe lease',()=>{
  const f=fixture();f.run('attach');f.visibility(true);assert.equal(f.timers.size,0);
  f.advance(60000);f.replaceRoot();f.flush();assert.equal(f.root.style.getPropertyValue('opacity'),'0');
  f.visibility(false);assert.equal(f.root.style.getPropertyValue('opacity'),'0');
  assert.equal(f.run().attached,true);
  [...f.timers.values()][0].callback();assert.equal(f.root.style.getPropertyValue('opacity'),'');
  assert.equal(f.observers.size,0);
});

test('late watchdog execution while hidden cannot expose the web footer and detach remains final',()=>{
  const f=fixture();f.run('attach');const expiry=[...f.timers.values()][0];
  f.visibility(true);expiry.callback();assert.equal(f.root.style.getPropertyValue('opacity'),'0');
  f.run('detach');f.visibility(false);f.replaceRoot();f.flush();
  assert.equal(f.root.style.getPropertyValue('opacity'),'');assert.equal(f.observers.size,0);assert.equal(f.timers.size,0);
});
