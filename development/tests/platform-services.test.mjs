import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { loadService } from './load-service.mjs';

const services = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'entry', 'src', 'main', 'ets', 'services');
const diagnostics = await loadService('DiagnosticsService');
const calls = [];
let systemResult;
let cookieResult;
let permissionStatus = -1;
let checks = [];
globalThis.__duoTestPlatform = {
  abilityAccessCtrl: { GrantStatus: { PERMISSION_GRANTED: 0 }, createAtManager: () => ({
    checkAccessTokenSync: (token, permission) => { checks.push({ token, permission }); return permissionStatus; },
    requestPermissionsFromUser: (context, permissions) => {
      calls.push({ context, permissions });
      return systemResult;
    }
  }) },
  webview: { WebCookieManager: { saveCookieAsync: () => { calls.push('save'); return cookieResult; } } },
  ...diagnostics
};

async function loadPlatformService(name) {
  let source = stripTypeScriptTypes(readFileSync(resolve(services, `${name}.ets`), 'utf8'));
  source = source.replace(/import \{[^}]+\} from '@kit.AbilityKit';/, 'const { abilityAccessCtrl } = globalThis.__duoTestPlatform;');
  source = source.replace(/import \{ webview \} from '@kit.ArkWeb';/, 'const { webview } = globalThis.__duoTestPlatform;');
  source = source.replace(/import \{ DiagnosticsService \} from '\.\/DiagnosticsService';/,
    'const { DiagnosticsService } = globalThis.__duoTestPlatform;');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const { WebPermissionService } = await loadPlatformService('WebPermissionService');
const { SessionLifecycle } = await loadPlatformService('SessionLifecycle');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('permission requests from multiple windows share one OS request and only request microphone', async () => {
  calls.length = 0;
  const system = deferred();
  systemResult = system.promise;
  const first = WebPermissionService.requestMicrophone({ window: 'first' });
  const second = WebPermissionService.requestMicrophone({ window: 'second' });
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].permissions, ['ohos.permission.MICROPHONE']);
  system.resolve({ authResults: [0] });
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test('system denial and errors settle as denied and release the shared OS request', async () => {
  systemResult = Promise.resolve({ authResults: [-1] });
  assert.equal(await WebPermissionService.requestMicrophone({}), false);
  const system = deferred();
  systemResult = system.promise;
  const pending = WebPermissionService.requestMicrophone({});
  system.reject(new Error('platform unavailable'));
  assert.equal(await pending, false);
  systemResult = Promise.resolve({ authResults: [0] });
  assert.equal(await WebPermissionService.requestMicrophone({}), true);
});

test('already-granted system permission is rechecked without opening another OS dialog', async () => {
  calls.length = 0; checks = []; permissionStatus = 0;
  const context = { applicationInfo: { accessTokenId: 123 } };
  assert.equal(await WebPermissionService.requestMicrophone(context), true);
  assert.deepEqual(checks, [{ token: 123, permission: 'ohos.permission.MICROPHONE' }]);
  assert.equal(calls.length, 0);
  permissionStatus = -1;
  assert.equal(await WebPermissionService.requestMicrophone(context, false), false);
  assert.equal(calls.length, 0);
  permissionStatus = 0; // User enables access in Settings without navigating the document.
  assert.equal(await WebPermissionService.requestMicrophone(context, false), true);
  permissionStatus = -1;
});

test('cookie persistence coalesces simultaneous lifecycle events', async () => {
  calls.length = 0;
  const cookies = deferred();
  cookieResult = cookies.promise;
  const first = SessionLifecycle.saveCookies();
  const second = SessionLifecycle.saveCookies();
  assert.deepEqual(calls, ['save']);
  cookies.resolve();
  await Promise.all([first, second]);
  cookieResult = Promise.resolve();
  await SessionLifecycle.saveCookies();
  assert.deepEqual(calls, ['save', 'save']);
});

test('cookie persistence failure is recorded and does not prevent another save', async () => {
  const cookies = deferred();
  cookieResult = cookies.promise;
  const pending = SessionLifecycle.saveCookies();
  cookies.reject(new Error('PRIVATE error with cookie=SECRET'));
  await pending;
  assert.match(diagnostics.DiagnosticsService.snapshot(), /cookie_error/);
  assert.doesNotMatch(diagnostics.DiagnosticsService.snapshot(), /PRIVATE|SECRET/);
  cookieResult = Promise.resolve();
  await SessionLifecycle.saveCookies();
  assert.match(diagnostics.DiagnosticsService.snapshot(), /cookie_saved/);
});

test('background pauses and mutes; foreground does not refresh or automatically resume audio', () => {
  const media = [];
  const controller = {
    stopMicrophone: () => media.push('stop-microphone'),
    pauseAllMedia: () => media.push('pause'),
    setAudioMuted: value => media.push(['mute', value]),
    onInactive: () => media.push('inactive'),
    onActive: () => media.push('active'),
    refresh: () => assert.fail('foreground must not refresh an in-progress lesson'),
    resumeAllMedia: () => assert.fail('foreground must not restart all audio')
  };
  SessionLifecycle.setActive(controller, false);
  SessionLifecycle.setActive(controller, true);
  assert.deepEqual(media, ['stop-microphone', 'pause', ['mute', true], 'inactive', 'active', ['mute', false]]);
});

test('a media pause failure does not prevent muting and deactivating the background Web', () => {
  const media = [];
  const controller = {
    stopMicrophone: () => media.push('stop-microphone'),
    pauseAllMedia: () => { throw new Error('media failure'); },
    setAudioMuted: value => media.push(['mute', value]),
    onInactive: () => media.push('inactive')
  };
  SessionLifecycle.setActive(controller, false);
  assert.deepEqual(media, ['stop-microphone', ['mute', true], 'inactive']);
});
