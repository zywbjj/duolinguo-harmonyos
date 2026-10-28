import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadService } from './load-service.mjs';

const storage = new Map();
const colorModes = [];
const webDebugModes = [];
globalThis.AppStorage = { get: key => storage.get(key), setOrCreate: (key, value) => storage.set(key, value) };
const appearance = await loadService('AppearanceService');
globalThis.__duoLayoutPlatform = {
  ...appearance,
  UIAbility: class {
    context = { config: {colorMode:1}, applicationInfo: { debug: true }, getApplicationContext: () => ({ setColorMode: mode => colorModes.push(mode) }) };
  },
  ConfigurationConstant: { ColorMode: { COLOR_MODE_LIGHT: 1, COLOR_MODE_DARK:0, COLOR_MODE_NOT_SET:-1 } },
  window: { AvoidAreaType: { TYPE_SYSTEM: 0, TYPE_CUTOUT: 1, TYPE_NAVIGATION_INDICATOR: 4 } },
  webview: { WebCookieManager: { putAcceptCookieEnabled() {} },
    WebviewController: { setWebDebuggingAccess: mode => webDebugModes.push(mode) } },
  DiagnosticsService: { record() {} }, SessionLifecycle: { saveCookies() {} }
};
let source = stripTypeScriptTypes(readFileSync(fileURLToPath(new URL(
  '../overlay/entry/src/main/ets/entryability/EntryAbility.ets', import.meta.url)), 'utf8'));
source = source.replace(/^import .*;$/gm, '');
source = 'const { UIAbility, ConfigurationConstant, window, webview, DiagnosticsService, SessionLifecycle, AppearanceService, ThemeColors } = globalThis.__duoLayoutPlatform;\n' + source;
const { default: EntryAbility } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture() {
  storage.clear();
  appearance.AppearanceService.unbind();
  colorModes.length = 0;
  const events = new Map();
  const layouts = [];
  const backgrounds = [], bars = [];
  const rect = (width = 0, height = 0) => ({ width, height });
  const area = (top, bottom, left = 0, right = 0) => ({ topRect: rect(0, top), bottomRect: rect(0, bottom),
    leftRect: rect(left, 0), rightRect: rect(right, 0) });
  const areas = [area(80, 0), area(60, 0, 40), null, null, area(0, 64)];
  let loaded = 0;
  const main = {
    setWindowLayoutFullScreen: async value => { layouts.push(value); },
    getWindowAvoidArea: type => areas[type], getUIContext: () => ({ px2vp: value => value / 4 }),
    setWindowBackgroundColor: color => backgrounds.push(color),
    setWindowSystemBarProperties: async properties => { bars.push(properties); },
    on: (event, callback) => events.set(event, callback), off: event => events.delete(event)
  };
  const stage = { getMainWindowSync: () => main, loadContent: (_page, callback) => { loaded++; callback({ code: 0 }); } };
  const ability = new EntryAbility();
  ability.onCreate();
  return { ability, stage, main, events, areas, layouts, backgrounds, bars, loaded: () => loaded };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the app follows the system and both system-bar backgrounds remain transparent', async () => {
  const f = fixture();
  assert.deepEqual(colorModes, [-1]);
  f.ability.onWindowStageCreate(f.stage);
  await tick();
  assert.deepEqual(f.bars.at(-1), {
    statusBarColor: '#00000000', navigationBarColor: '#00000000',
    statusBarContentColor: '#1A1A1A', navigationBarContentColor: '#1A1A1A'
  });
  const applied = f.bars.length;
  f.ability.onBackground();
  f.ability.onForeground();
  assert.equal(f.bars.length, applied + 1);
  assert.equal(f.bars.at(-1).navigationBarColor, '#00000000');
  assert.ok(f.bars.every(properties => properties.statusBarColor === '#00000000'));
});

test('system and website theme changes update window colors without setting a forced app color mode',async()=>{
  const f=fixture();f.ability.onWindowStageCreate(f.stage);await tick();
  f.ability.onConfigurationUpdate({colorMode:0});
  assert.equal(storage.get('duoDark'),true);assert.equal(f.bars.at(-1).statusBarContentColor,'#FFFFFF');
  assert.equal(f.bars.at(-1).navigationBarContentColor,'#FFFFFF');
  appearance.AppearanceService.setPageTheme('light');
  assert.equal(f.bars.at(-1).statusBarContentColor,'#1A1A1A');
  f.ability.onConfigurationUpdate({colorMode:1});appearance.AppearanceService.setPageTheme('dark');
  assert.equal(f.bars.at(-1).statusBarContentColor,'#FFFFFF');
  assert.deepEqual(colorModes,[-1]);assert.ok(f.bars.every(p=>p.navigationBarColor==='#00000000'));
  f.ability.onWindowStageDestroy();const n=f.bars.length;appearance.AppearanceService.setPageTheme('light');assert.equal(f.bars.length,n);
});

test('web debugging follows the installed app debug flag and is off for release', () => {
  const f = fixture();
  assert.equal(webDebugModes.at(-1), true);
  f.ability.context.applicationInfo.debug = false;
  f.ability.onCreate();
  assert.equal(webDebugModes.at(-1), false);
});

test('window avoidance uses system/cutout maxima and converts px into vp', async () => {
  const f = fixture();
  f.ability.onWindowStageCreate(f.stage);
  await tick();
  assert.equal(f.loaded(), 1);
  assert.equal(storage.get('duoSafeTop'), 20);
  assert.equal(storage.get('duoSafeBottom'), 16);
  assert.equal(storage.get('duoSafeLeft'), 10);
  f.areas[0].topRect.height = 120;
  f.events.get('avoidAreaChange')({ type: 0 });
  assert.equal(storage.get('duoSafeTop'), 30);
  f.ability.onWindowStageDestroy();
  assert.equal(f.events.size, 0);
});

test('keyboard state is cleared on hide and window destruction', async () => {
  const f = fixture();
  f.ability.onWindowStageCreate(f.stage);
  await tick();
  f.events.get('keyboardHeightChange')(900);
  assert.equal(storage.get('duoKeyboardVisible'), true);
  f.events.get('keyboardHeightChange')(0);
  assert.equal(storage.get('duoKeyboardVisible'), false);
  f.ability.onWindowStageDestroy();
  assert.equal(storage.get('duoKeyboardVisible'), false);
});

test('unavailable metrics fall back to system-managed safe layout without preventing content load', async () => {
  const f = fixture();
  f.main.getWindowAvoidArea = () => { throw new Error('metrics unavailable'); };
  f.ability.onWindowStageCreate(f.stage);
  await tick();
  assert.deepEqual(f.layouts, [true, false]);
  assert.equal(f.loaded(), 1);
  assert.equal(storage.get('duoSafeTop'), 0);
  assert.equal(storage.get('duoSafeBottom'), 0);
});

test('a destroyed window cannot load content after asynchronous setup finishes', async () => {
  const f = fixture();
  let finish;
  f.main.setWindowLayoutFullScreen = () => new Promise(resolve => { finish = resolve; });
  f.ability.onWindowStageCreate(f.stage);
  f.ability.onWindowStageDestroy();
  finish();
  await tick();
  assert.equal(f.loaded(), 0);
  assert.equal(f.events.size, 0);
});

test('UIContext is read after loadContent so early initialization cannot disable immersive layout', async () => {
  const f = fixture();
  let reads = 0;
  f.main.getUIContext = () => {
    reads++;
    if (f.loaded() === 0) throw new Error('UIContext is not initialized before content load.');
    return { px2vp: value => value / 4 };
  };
  f.ability.onWindowStageCreate(f.stage);
  await tick();
  assert.equal(f.loaded(), 1);
  assert.equal(reads, 1);
  assert.deepEqual(f.layouts, [true]);
  assert.equal(storage.get('duoSafeBottom'), 16);
});

test('a late loadContent callback cannot read a destroyed window or register stale listeners', async () => {
  const f = fixture();
  let complete;
  let reads = 0;
  f.stage.loadContent = (_page, callback) => { complete = callback; };
  f.main.getUIContext = () => { reads++; throw new Error('Context not ready.'); };
  f.ability.onWindowStageCreate(f.stage);
  await tick();
  f.ability.onForeground();
  assert.equal(reads, 0);
  assert.equal(f.events.size, 0);
  assert.deepEqual(f.layouts, [true]);
  f.ability.onWindowStageDestroy();
  complete({ code: 0 });
  assert.equal(reads, 0);
  assert.equal(f.events.size, 0);
});
