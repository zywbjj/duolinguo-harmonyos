import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync,
  copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import JSON5 from 'json5';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'overlay');

function readJson(file) {
  try {
    return JSON5.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`无法按 JSON5 读取 ${file}。请检查配置语法，或按 README 手工接入。`);
  }
}

function assertInside(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== candidate) {
    throw new Error(`目标越出工程目录：${candidate}`);
  }
  let ancestor = candidate;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const realRel = relative(root, realpathSync(ancestor));
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || resolve(root, realRel) !== realpathSync(ancestor)) {
    throw new Error(`目标包含指向工程外的链接：${candidate}`);
  }
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(join(dir, entry.name), rel) : [rel];
  });
}

function planInstallation(project) {
  const root = realpathSync(resolve(project));
  const manifest = join(root, 'entry', 'src', 'main', 'module.json5');
  for (const required of ['build-profile.json5', join('AppScope', 'app.json5'),
    join('entry', 'src', 'main', 'ets', 'entryability', 'EntryAbility.ets'),
    join('entry', 'src', 'main', 'ets', 'pages', 'Index.ets')]) {
    const file = join(root, required);
    assertInside(root, file);
    if (!existsSync(file)) throw new Error(`缺少 ${required}；请先创建并运行 Stage / ArkTS Empty Ability 模板。`);
  }
  assertInside(root, manifest);
  const config = readJson(manifest);
  const module = config.module;
  if (module?.name !== 'entry' || module.type !== 'entry' || module.mainElement !== 'EntryAbility' ||
    module.abilities?.length !== 1 || module.abilities[0].name !== 'EntryAbility' ||
    module.abilities[0].srcEntry !== './ets/entryability/EntryAbility.ets' || module.pages !== '$profile:main_pages') {
    throw new Error('仅支持单 entry 模块、单 EntryAbility 的标准空工程；其他结构请手工接入。');
  }
  const pagesFile = join(root, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json');
  assertInside(root, pagesFile);
  if (!readJson(pagesFile).src?.includes('pages/Index')) {
    throw new Error('main_pages.json 未包含 pages/Index，请先修正模板入口。');
  }
  if (module.requestPermissions !== undefined && !Array.isArray(module.requestPermissions)) {
    throw new Error('module.requestPermissions 必须是数组。');
  }
  const permissions = module.requestPermissions ?? [];
  if (!permissions.some(permission => permission.name === 'ohos.permission.INTERNET')) {
    permissions.push({ name: 'ohos.permission.INTERNET' });
  }
  const microphone = {
    name: 'ohos.permission.MICROPHONE', reason: '$string:duo_microphone_reason',
    usedScene: { abilities: ['EntryAbility'], when: 'inuse' }
  };
  const micIndex = permissions.findIndex(permission => permission.name === microphone.name);
  if (micIndex < 0) permissions.push(microphone);
  else permissions[micIndex] = microphone;
  module.requestPermissions = permissions;
  module.abilities[0].label = '$string:duo_ability_name';
  module.abilities[0].description = '$string:duo_ability_description';
  module.abilities[0].icon = '$media:duo_icon';
  module.abilities[0].startWindowIcon = '$media:duo_start_icon';
  module.abilities[0].startWindowBackground = '$color:duo_launch_background';
  if (module.metadata !== undefined && !Array.isArray(module.metadata)) {
    throw new Error('module.metadata 必须是数组。');
  }
  module.metadata = (module.metadata ?? []).filter(item => item.name !== 'ohos.arkui.UIMaterial.state');
  module.metadata.push({ name: 'ohos.arkui.UIMaterial.state', value: 'enable' });

  const appManifest = join(root, 'AppScope', 'app.json5');
  assertInside(root, appManifest);
  const appConfig = readJson(appManifest);
  appConfig.app.label = '$string:duo_app_name';
  appConfig.app.icon = '$media:duo_icon';

  const files = listFiles(sourceRoot).map(rel => ({
    rel, content: readFileSync(join(sourceRoot, rel)), target: join(root, rel)
  }));
  files.push({ rel: relative(root, manifest), target: manifest,
    content: Buffer.from(JSON.stringify(config, null, 2) + '\n') });
  files.push({ rel: relative(root, appManifest), target: appManifest,
    content: Buffer.from(JSON.stringify(appConfig, null, 2) + '\n') });
  for (const file of files) assertInside(root, file.target);
  return { root, files };
}

function install(plan) {
  const backup = join(plan.root, '.duolingo-backups', `${Date.now()}-${randomUUID()}`);
  assertInside(plan.root, backup);
  // Back up everything before writing the first source file.
  mkdirSync(backup, { recursive: true });
  const originals = new Map();
  for (const file of plan.files) {
    if (existsSync(file.target)) {
      originals.set(file.target, readFileSync(file.target));
      const saved = join(backup, file.rel);
      mkdirSync(dirname(saved), { recursive: true });
      copyFileSync(file.target, saved);
    }
  }
  const written = [];
  try {
    for (const file of plan.files) {
      mkdirSync(dirname(file.target), { recursive: true });
      written.push(file.target);
      writeFileSync(file.target, file.content);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      if (originals.has(file)) writeFileSync(file, originals.get(file));
      else if (existsSync(file)) unlinkSync(file);
    }
    throw error;
  }
  return backup;
}

try {
  const args = process.argv.slice(2);
  const project = args.find(arg => !arg.startsWith('--'));
  if (!project || args.some(arg => arg.startsWith('--') && arg !== '--apply')) {
    throw new Error('用法：node scripts/install-into-project.mjs <DevEco空工程路径> [--apply]。默认只预览。');
  }
  const plan = planInstallation(project);
  console.log(`工程：${plan.root}\n将更新 ${plan.files.length} 个文件：`);
  for (const file of plan.files) console.log(`  ${file.rel}`);
  if (args.includes('--apply')) {
    const backup = install(plan);
    console.log(`接入完成，原文件备份：${backup}\n请在 DevEco 中同步、编译并配置真机调试签名。`);
  } else {
    console.log('预览完成，未写入任何文件。使用 --apply 应用上述变更。');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
