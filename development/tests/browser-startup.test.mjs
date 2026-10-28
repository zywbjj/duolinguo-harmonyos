import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { loadService } from './load-service.mjs';

const policy = await loadService('NavigationPolicy');
const navigation = await loadService('WebNavigation');
const audio = await loadService('WebAudioScript');
const appearance = await loadService('AppearanceService');
const storage = new Map();
globalThis.AppStorage={get:key=>storage.get(key),setOrCreate:(key,value)=>storage.set(key,value)};
let current;
globalThis.__duoStartupPlatform = {
  ...policy, ...navigation, ...audio, ...appearance,
  navigationScript: command => command,
  audioStatusScript: () => 'audio-status',
  themeStatusScript: () => 'theme-status',
  webview: { WebviewController: class {
    getUrl() { return current.address; }
    async runJavaScript(command) {
      if(command==='theme-status'){current.themeReads++;return current.theme;}
      if (command === 'audio-status') { current.audioReads++; return JSON.stringify(current.audioStatus); }
      current.commands.push(command);
      if (current.failures > 0) { current.failures--; throw new Error('Document is initializing.'); }
      if (command === 'attach') current.report.attached = true;
      return JSON.stringify(current.report);
    }
  } },
  PermissionGate: class { invalidate() {} }, WebPermissionService: {},
  DiagnosticsService: { record() {} }, SessionLifecycle: { setActive() {}, saveCookies() {} }
};

// Execute the actual controller/lifecycle part of BrowserPane; ArkUI's build DSL is
// compiled separately with the SDK and is not emulated in this Node test.
let source = readFileSync(new URL('../overlay/entry/src/main/ets/components/BrowserPane.ets', import.meta.url), 'utf8');
source = source.slice(0, source.indexOf('  build() {')) + '}\n';
source = source.replace(/^import .*;\r?\n/gm, '').replace(/^@Component\s*/gm, '')
  .replace(/export struct BrowserPane/, 'export class BrowserPane')
  .replace(/@(Prop|State|StorageProp|Watch)(\([^)]*\))?\s*/g, '');
source = stripTypeScriptTypes(source);
source = 'const { LEARN_URL, navigationAction, safeOrigin, isLearningOrigin, NavigationReport, navigationScript, ' +
  'parseNavigationReport, carryNavigation, webAudioScript, audioStatusScript, parseAudioStatus, AppearanceService, ThemeColors, themeStatusScript, parsePageChromeStatus, webview, PermissionGate, WebPermissionService, DiagnosticsService, SessionLifecycle } ' +
  '= globalThis.__duoStartupPlatform;\n' + source;
const { BrowserPane } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const intervals = new Map(); let id = 0, now = 10000;
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval, originalNow = Date.now;
  globalThis.setInterval = (callback, period) => { intervals.set(++id, { callback, period }); return id; };
  globalThis.clearInterval = handle => intervals.delete(handle);
  Date.now = () => now;
  t.after(() => { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; Date.now = originalNow; });
  appearance.AppearanceService.initialize(1);
  current = { address: policy.LEARN_URL, commands: [], failures: 0, report: new navigation.NavigationReport(), audioReads: 0, audioStatus: {sequence: 0, stage: 'idle'},theme:'light',themeReads:0 };
  const pane = new BrowserPane();
  pane.aboutToAppear(); pane.tab.attached = true;
  t.after(()=>pane.stopThemePolling());
  const navigationTimers=()=>new Map([...intervals].filter(([,value])=>value.period!==200));
  return { pane, state: current, get intervals(){return navigationTimers();},allTimers:intervals,advance(ms) { now += ms; },
    showMenu() {
      current.report = new navigation.NavigationReport();
      current.report.origin = 'https://www.duolingo.com'; current.report.page = '/learn';
      current.report.items = ['/learn', '/practice-hub', '/shop'].map(path => new navigation.NavigationItem(path, '测试'));
    },
    async poll() { [...navigationTimers().values()][0].callback(); await tick(); }
  };
}

test('navigation is discovered while the page is still loading and switches to idle polling after discovery', async t => {
  const f = fixture(t);
  assert.equal(f.pane.loading, true);
  f.pane.onActivityChanged(); await tick();
  assert.equal([...f.intervals.values()][0].period, 150);
  f.showMenu(); await f.poll();
  assert.equal(f.pane.loading, true);
  assert.equal(f.pane.navigation.items.length, 3);
  assert.equal([...f.intervals.values()][0].period, 900);
  assert.equal(f.pane.navigation.attached, false);
  f.pane.navigationReady(); await tick();
  assert.equal(f.pane.navigation.attached, true);
});

test('a temporarily blank initial controller does not stop discovery before its first document', async t => {
  const f = fixture(t);
  f.state.address = 'about:blank';
  f.pane.onActivityChanged(); await tick();
  assert.equal(f.intervals.size, 1);
  assert.equal(f.state.commands.length, 0);
  f.state.address = policy.LEARN_URL; f.showMenu(); await f.poll();
  assert.equal(f.pane.navigation.items.length, 3);
});

test('document-initialization errors retry on the timer without a tight attach loop', async t => {
  const f = fixture(t);
  f.state.failures = 2;
  f.pane.onActivityChanged(); await tick();
  assert.equal(f.state.commands.length, 1);
  assert.equal(f.intervals.size, 1);
  await f.poll();
  assert.equal(f.state.commands.length, 2);
  f.showMenu(); await f.poll();
  assert.equal(f.pane.navigation.items.length, 3);
});

test('fast startup polling is bounded when a page has no supported menu', async t => {
  const f = fixture(t);
  f.pane.onActivityChanged(); await tick();
  assert.equal([...f.intervals.values()][0].period, 150);
  f.advance(6100); await f.poll();
  assert.equal([...f.intervals.values()][0].period, 900);
});

test('background and login-popup windows cannot continue the early discovery loop', async t => {
  const f = fixture(t);
  f.pane.onActivityChanged(); await tick();
  f.pane.foreground = false; f.pane.onActivityChanged();
  assert.equal(f.intervals.size, 0);
  f.pane.foreground = true; f.pane.tab.handler = {}; f.pane.onActivityChanged();
  assert.equal(f.intervals.size, 0);
});

test('a persistent script failure after loading stops polling and restores the web menu', async t => {
  const f = fixture(t);
  f.pane.loading = false; f.state.failures = 1;
  f.pane.onActivityChanged(); await tick();
  assert.equal(f.intervals.size, 0);
  assert.ok(f.state.commands.includes('detach'));
});

test('visible current page hides progress while slow resources are still loading', t => {
  const { pane, state } = fixture(t);
  pane.beginLoading(state.address); pane.updateProgress(67);
  pane.pageVisible(state.address);
  assert.equal(pane.loading, true);
  assert.equal(pane.showProgress, false);
  pane.updateProgress(89);
  assert.equal(pane.showProgress, false);
  pane.failure = 'A main-document error'; pane.finishLoading();
  assert.equal(pane.failure, 'A main-document error');
});

test('a late visibility event cannot hide progress for a new navigation', t => {
  const { pane, state } = fixture(t), old = state.address;
  state.address = 'https://www.duolingo.com/shop'; pane.beginLoading(state.address);
  pane.pageVisible(old);
  assert.equal(pane.showProgress, true);
  pane.pageVisible(state.address);
  assert.equal(pane.showProgress, false);
});

test('progress completion hides the bar even without a page-end callback and resets for navigation', t => {
  const { pane, state } = fixture(t);
  pane.beginLoading(state.address); pane.updateProgress(100);
  assert.equal(pane.showProgress, false);
  pane.beginLoading(state.address);
  assert.equal(pane.showProgress, true);
  assert.equal(pane.progress, 0);
  pane.finishLoading(); assert.equal(pane.showProgress, false);
});

test('a temporarily unavailable controller in the visibility callback is contained', t => {
  const { pane, state } = fixture(t);
  pane.beginLoading(state.address);
  pane.tab.controller.getUrl = () => { throw new Error('Controller detached'); };
  assert.doesNotThrow(() => pane.pageVisible(state.address));
  assert.equal(pane.showProgress, true);
  pane.finishLoading(); assert.equal(pane.showProgress, false);
});

test('offline voice feedback is polled independently of website console output', async t => {
  const f = fixture(t);
  f.state.audioStatus = {sequence: 1, stage: 'model-loading'};
  f.pane.onActivityChanged(); await tick();
  assert.match(f.pane.audioNotice, /正在准备/);
  f.state.audioStatus = {sequence: 2, stage: 'model-error'}; await f.poll();
  assert.match(f.pane.audioNotice, /V04/);
  f.state.audioStatus = {sequence: 3, stage: 'capture-started'}; await f.poll();
  assert.equal(f.pane.audioNotice, ''); assert.ok(f.state.audioReads >= 3);
});

test('secondary-page return immediately remounts the acknowledged menu without detaching the document watcher', async t => {
  const f=fixture(t);f.showMenu();f.pane.onActivityChanged();await tick();f.pane.navigationReady();await tick();
  const menu=structuredClone(f.state.report);
  f.state.address='https://www.duolingo.com/lesson/fixture';f.state.report=new navigation.NavigationReport();
  f.pane.navigationCommitted(f.state.address);await tick();assert.equal(f.pane.navigation.items.length,0);
  f.advance(5000);await f.poll();
  f.state.address=policy.LEARN_URL;f.state.report={...menu,attached:false};
  f.pane.navigationCommitted(f.state.address);
  assert.equal(f.pane.navigation.items.length,3);assert.equal(f.pane.navigation.attached,false);
  assert.equal(f.pane.navigation.pending,true);assert.equal([...f.intervals.values()][0].period,150);
  await tick();f.pane.navigationReady();await tick();assert.equal(f.pane.navigation.attached,true);
  assert.ok(!f.state.commands.includes('detach'));
});

test('a remounted dock waits for a delayed primary-page DOM without an unbounded attach loop', async t => {
  const f=fixture(t);f.showMenu();f.pane.onActivityChanged();await tick();f.pane.navigationReady();await tick();
  const menu=structuredClone(f.state.report);
  f.state.address='https://www.duolingo.com/settings';f.state.report=new navigation.NavigationReport();
  f.pane.navigationCommitted(f.state.address);await tick();
  f.state.address=policy.LEARN_URL;f.state.report={...menu,attached:false,pending:true};
  f.pane.navigationCommitted(f.state.address);await tick();const before=f.state.commands.length;
  f.pane.navigationReady();await tick();assert.equal(f.state.commands.length,before+1);
  f.state.report.pending=false;await f.poll();assert.equal(f.pane.navigation.attached,true);
});

test('a new document or untrusted origin cannot reuse a cached native menu', async t => {
  const f=fixture(t);f.showMenu();f.pane.onActivityChanged();await tick();f.pane.navigationReady();await tick();
  f.pane.beginLoading(policy.LEARN_URL);assert.equal(f.pane.navigationCache.items.length,0);
  f.pane.navigationCommitted('https://evil.test/learn');assert.equal(f.pane.navigation.items.length,0);
});

test('website theme updates while the keyboard is open without refreshing the page or changing navigation',async t=>{
  const f=fixture(t);f.pane.keyboardVisible=true;f.state.theme='"dark"';
  f.pane.onActivityChanged();await tick();
  assert.equal(storage.get('duoDark'),true);assert.equal(f.intervals.size,0);
  f.state.theme='light';[...f.allTimers.values()].find(v=>v.period===200).callback();await tick();
  assert.equal(storage.get('duoDark'),false);assert.equal(f.state.themeReads,2);
  assert.ok(f.state.commands.every(command=>command==='detach'));
  f.pane.foreground=false;f.pane.onActivityChanged();assert.equal(f.allTimers.size,0);
});

test('lock and unlock retain the laid-out native dock and pause instead of restoring the web footer',async t=>{
  const f=fixture(t);f.showMenu();f.pane.onActivityChanged();await tick();f.pane.navigationReady();await tick();
  const attachCount=f.state.commands.filter(c=>c==='attach').length;
  for(let n=0;n<3;n++){
    f.pane.foreground=false;f.pane.onActivityChanged();await tick();
    assert.equal(f.allTimers.size,0);assert.equal(f.pane.navigation.items.length,3);assert.equal(f.pane.dockReady,true);
    assert.equal(f.state.commands.at(-1),'pause');f.advance(60000);
    f.pane.foreground=true;f.pane.onActivityChanged();
    assert.equal(f.pane.navigation.items.length,3);assert.equal(f.pane.navigation.attached,true);
    assert.equal(f.pane.navigation.pending,true);await tick();assert.equal(f.pane.navigation.pending,false);
  }
  assert.equal(f.state.commands.filter(c=>c==='attach').length,attachCount);
  assert.ok(!f.state.commands.includes('detach'));
});

test('a changed route on unlock cannot resurrect the previous primary-page dock',async t=>{
  const f=fixture(t);f.showMenu();f.pane.onActivityChanged();await tick();f.pane.navigationReady();await tick();
  f.pane.foreground=false;f.pane.onActivityChanged();await tick();
  f.state.address='https://www.duolingo.com/lesson/fixture';f.state.report=new navigation.NavigationReport();
  f.pane.foreground=true;f.pane.onActivityChanged();assert.equal(f.pane.navigation.items.length,0);await tick();
  assert.equal(f.pane.navigation.items.length,0);
});

test('modal occlusion triggers immediate navigation revalidation through the foreground chrome probe',async t=>{
  const f=fixture(t);f.showMenu();f.pane.onActivityChanged();await tick();f.pane.navigationReady();await tick();
  const menu=structuredClone(f.state.report);
  f.state.theme='{"theme":"dark","occluded":true}';f.state.report=new navigation.NavigationReport();
  [...f.allTimers.values()].find(v=>v.period===200).callback();await tick();
  assert.equal(f.pane.navigation.items.length,0);assert.equal(storage.get('duoDark'),true);
  f.state.theme='{"theme":"dark","occluded":false}';f.state.report={...menu,attached:false};
  [...f.allTimers.values()].find(v=>v.period===200).callback();await tick();
  assert.equal(f.pane.navigation.items.length,3);f.pane.navigationReady();await tick();assert.equal(f.pane.navigation.attached,true);
  assert.ok(!f.state.commands.includes('detach'));
});
