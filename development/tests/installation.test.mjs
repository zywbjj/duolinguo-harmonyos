import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(projectRoot, 'scripts', 'install-into-project.mjs');
const moduleRel = join('entry', 'src', 'main', 'module.json5');

function fixture(t) {
  const tempParent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(tempParent, 'duolingo-adapter-test-')));
  t.after(() => {
    const rel = relative(tempParent, root);
    assert.ok(rel.startsWith('duolingo-adapter-test-') && !rel.includes(sep) && !rel.includes('..'));
    rmSync(root, { recursive: true, force: true });
  });
  function write(rel, value) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof value === 'string' ? value : JSON.stringify(value));
  }
  write('build-profile.json5', { app: { products: [{ targetSdkVersion: 'IDE-generated' }] } });
  write(join('AppScope', 'app.json5'), { app: { bundleName: 'com.example.keepthisname',
    versionName: '9.8.7', versionCode: 12345 } });
  write(join('entry', 'src', 'main', 'ets', 'entryability', 'EntryAbility.ets'), 'original ability');
  write(join('entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), 'original page');
  write(join('entry', 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'), { src: ['pages/Index'] });
  write(moduleRel, { module: { name: 'entry', type: 'entry', mainElement: 'EntryAbility',
    pages: '$profile:main_pages', abilities: [{ name: 'EntryAbility',
      srcEntry: './ets/entryability/EntryAbility.ets', exported: true }],
    requestPermissions: [{ name: 'ohos.permission.INTERNET' }],
    metadata: [{ name: 'custom.metadata', value: 'keep' }] } });
  return { root, write };
}

function run(root, apply = false) {
  const result = spawnSync(process.execPath, [script, root, ...(apply ? ['--apply'] : [])], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('installation preview performs no writes', t => {
  const { root } = fixture(t);
  const before = readFileSync(join(root, moduleRel), 'utf8');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, moduleRel), 'utf8'), before);
  assert.equal(existsSync(join(root, '.duolingo-backups')), false);
  assert.equal(existsSync(join(root, 'entry', 'src', 'main', 'ets', 'components')), false);
});

test('installation preserves SDK, bundle name and ability config; permissions are deduplicated on reapply', t => {
  const { root } = fixture(t);
  const build = readFileSync(join(root, 'build-profile.json5'), 'utf8');
  const app = readFileSync(join(root, 'AppScope', 'app.json5'), 'utf8');
  const result = run(root, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run(root, true).status, 0);
  assert.equal(readFileSync(join(root, 'build-profile.json5'), 'utf8'), build);
  const installedApp = JSON.parse(readFileSync(join(root, 'AppScope', 'app.json5'), 'utf8')).app;
  assert.equal(installedApp.bundleName, JSON.parse(app).app.bundleName);
  assert.equal(installedApp.versionName, '9.8.7');
  assert.equal(installedApp.versionCode, 12345);
  assert.equal(installedApp.label, '$string:duo_app_name');
  assert.equal(installedApp.icon, '$media:duo_icon');
  const config = JSON.parse(readFileSync(join(root, moduleRel), 'utf8')).module;
  assert.equal(config.abilities[0].exported, true);
  assert.equal(config.abilities[0].label, '$string:duo_ability_name');
  assert.equal(config.abilities[0].icon, '$media:duo_icon');
  assert.equal(config.abilities[0].startWindowIcon, '$media:duo_start_icon');
  assert.equal(config.abilities[0].startWindowBackground, '$color:duo_launch_background');
  assert.equal(config.metadata.filter(item => item.name === 'ohos.arkui.UIMaterial.state').length, 1);
  assert.deepEqual(config.metadata.find(item => item.name === 'custom.metadata'), { name: 'custom.metadata', value: 'keep' });
  assert.equal(config.requestPermissions.length, 2);
  assert.deepEqual(config.requestPermissions.find(p => p.name === 'ohos.permission.MICROPHONE').usedScene,
    { abilities: ['EntryAbility'], when: 'inuse' });
  const backups = readdirSync(join(root, '.duolingo-backups')).sort();
  assert.equal(backups.length, 2);
  const firstBackup = join(root, '.duolingo-backups', backups[0], 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
  assert.equal(readFileSync(firstBackup, 'utf8'), 'original page');
  assert.match(readFileSync(join(root, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), 'utf8'), /@Entry/);
});

test('non-template modules fail before creating backups or modifying files', t => {
  const { root, write } = fixture(t);
  write(moduleRel, { module: { name: 'custom' } });
  const before = readFileSync(join(root, moduleRel), 'utf8');
  const result = run(root, true);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(root, moduleRel), 'utf8'), before);
  assert.equal(existsSync(join(root, '.duolingo-backups')), false);
});

test('real IDE JSON5 supports comments, single quotes and trailing commas while preserving backup settings', t => {
  const { root, write } = fixture(t);
  const original = `{
    // DevEco templates use JSON5, including trailing commas.
    module: {
      name: 'entry', type: 'entry', mainElement: 'EntryAbility', pages: '$profile:main_pages',
      abilities: [{ name: 'EntryAbility', srcEntry: './ets/entryability/EntryAbility.ets', exported: true, },],
      extensionAbilities: [{ name: 'EntryBackupAbility', type: 'backup', exported: false, },],
    },
  }`;
  write(moduleRel, original);
  const result = run(root, true);
  assert.equal(result.status, 0, result.stderr);
  const module = JSON.parse(readFileSync(join(root, moduleRel), 'utf8')).module;
  assert.equal(module.extensionAbilities[0].name, 'EntryBackupAbility');
  assert.equal(module.requestPermissions.length, 2);
  const backup = readdirSync(join(root, '.duolingo-backups'))[0];
  assert.equal(readFileSync(join(root, '.duolingo-backups', backup, moduleRel), 'utf8'), original);
});

test('executable expressions are rejected without side effects or file writes', t => {
  const { root, write } = fixture(t);
  write(moduleRel, '{module: (() => { throw new Error("EXECUTED"); })()}');
  const result = run(root, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README/);
  assert.doesNotMatch(result.stderr, /EXECUTED/);
  assert.equal(existsSync(join(root, '.duolingo-backups')), false);
});
