// Optional real-DOM regression check with a fresh, headless Edge profile.
// Only the script's origin allowlist is adapted to the local synthetic fixture.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadService } from '../tests/load-service.mjs';

const { navigationScript } = await loadService('WebNavigation');
const { webIconScript } = await loadService('WebIconScript');
const { webContentInsetScript } = await loadService('WebContentInsets');
const edge = process.env.DUO_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(edge)) throw new Error('Set DUO_EDGE_PATH to an installed Edge browser.');
const output = resolve(process.argv[2] || '.local-browser-check');
mkdirSync(output, { recursive: true });
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f8ef;font:16px sans-serif}main{padding:32px}nav{position:fixed;bottom:0;
left:0;width:100%;height:76px;display:flex;background:white}a{flex:1;display:flex;align-items:center;justify-content:center}
a img,a svg,a span{display:block;width:24px;height:24px;flex-shrink:0}
</style></head><body><main>Synthetic navigation regression fixture</main>
<img src="/slow-resource.svg" width="1" height="1" style="position:absolute;opacity:0" alt=""><script>
const webIconScript = ${webIconScript.toString()};
const webContentInsetScript = ${webContentInsetScript.toString()};
const makeScript = ${navigationScript.toString()};
const paths = ['/learn','/sounds','/practice-hub','/quests','/shop','/profile/fixture'];
const palette = ['#ff0000','#00aa00','#0064ff','#ff8800','#9900cc','#eebb00'];
let flashes = [], frames = 0, recording = false, gap = false;
let pageLoaded = false;
addEventListener('load', () => { pageLoaded = true; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const run = (command, index = -1, page = location.pathname, path = '') => {
  const source = makeScript(command, index, page, path)
    .replace(/const allowed = [^;]+;/, 'const allowed = ' + JSON.stringify([location.origin]) + ';');
  return JSON.parse((0, eval)(source));
};
function makeNav() {
  const nav = document.createElement('nav'); nav.id = 'fixture-nav';
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index], link = document.createElement('a'); link.href = path;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="' + palette[index] + '"/></svg>';
    if (index % 3 === 0) {
      const image = document.createElement('img'); image.src = 'data:image/svg+xml;base64,' + btoa(svg); link.append(image);
    } else if (index % 3 === 1) {
      link.innerHTML = svg;
    } else {
      const icon = document.createElement('span');
      icon.style.backgroundImage = 'url(/fixture-icon-' + index + '.svg)';
      icon.style.backgroundSize = '48px 24px'; icon.style.backgroundPosition = '-24px 0px'; link.append(icon);
    }
    nav.append(link);
  }
  return nav;
}
document.body.append(makeNav());
document.addEventListener('click', event => {
  const link = event.target.closest('a'); if (!link) return;
  event.preventDefault(); history.pushState({}, '', link.pathname);
  const old = document.getElementById('fixture-nav');
  if (gap) { old.remove(); setTimeout(() => document.body.append(makeNav()), 24); }
  else old.replaceWith(makeNav());
});
function sample() {
  if (recording) {
    frames++;
    const nav = document.getElementById('fixture-nav');
    if (nav && getComputedStyle(nav).opacity !== '0') flashes.push({ frame: frames, page: location.pathname });
  }
  requestAnimationFrame(sample);
}
requestAnimationFrame(sample);
window.startLockChecks=()=>{if(!run('attach').attached)throw new Error('Lock setup attach failed');recording=true;};
window.pauseForLock=rebuild=>{
  run('pause');if(rebuild)document.getElementById('fixture-nav').replaceWith(makeNav());
};
window.resumeFromLock=()=>{
  const report=run('scan');
  return {attached:report.attached,items:report.items.length,hidden:getComputedStyle(document.getElementById('fixture-nav')).opacity==='0'};
};
window.finishLockChecks=()=>{
  recording=false;run('detach');
  return {frames,exposedFrames:flashes.length,restored:getComputedStyle(document.getElementById('fixture-nav')).opacity==='1'};
};
(async () => {
  try {
    if (!run('attach').attached) throw new Error('Initial attach failed.');
    const initialTakeoverBeforeLoad = !pageLoaded;
    let icons;
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(20); icons = run('scan').items;
      if (icons.every(item => item.image.startsWith('data:image/png;base64,'))) break;
    }
    const originalIconCount = icons.filter(item => item.image.startsWith('data:image/png;base64,')).length;
    if (originalIconCount !== 6) throw new Error('Not all IMG/SVG/sprite icons were exported.');
    let originalColorsPreserved = true;
    for (let index = 0; index < icons.length; index++) {
      const image = new Image(); image.src = icons[index].image; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
      const context = canvas.getContext('2d'); context.drawImage(image,0,0);
      const actual = context.getImageData(48,48,1,1).data;
      const expected = palette[index].slice(1).match(/../g).map(value => parseInt(value,16));
      if (!expected.every((value, channel) => Math.abs(value - actual[channel]) <= 2)) originalColorsPreserved = false;
    }
    if (!originalColorsPreserved) throw new Error('Original image colors were changed.');
    recording = true;
    for (let n = 0; n < 24; n++) {
      gap = n % 2 === 1;
      const index = (n + 1) % paths.length;
      const report = run('activate', index, location.pathname, paths[index]);
      if (!report.attached || report.items.length !== paths.length) throw new Error('Native report was cleared during activation.');
      await delay(55); await frame();
      const settled = run('scan');
      if (!settled.attached || settled.pending || settled.selected !== index) throw new Error('Navigation did not settle.');
      await frame();
    }
    // Secondary pages remove their menu and can remain open far longer than a
    // tab transition. Return both via history and an in-page close action.
    const secondaryPaths=['/lesson/fixture','/settings/account','/profile/fixture/achievements','/practice-hub/words'];
    const returned=[];
    for(const secondary of secondaryPaths) for(const primary of paths) for(const mode of ['back','close']) {
      history.replaceState({},'',primary);run('scan');
      history.pushState({},'',secondary);document.getElementById('fixture-nav').remove();run('scan');
      await delay(35);await frame();
      // Also cover a secondary page that outlives the old 2.4s ownership lease.
      if(returned.length===0){for(let n=0;n<4;n++){await delay(800);run('scan');}}
      if(mode==='back')await new Promise(resolve=>{addEventListener('popstate',resolve,{once:true});history.back();});
      else history.replaceState({},'',primary);
      await delay(24);document.body.append(makeNav());
      // Intentionally delay the native scan/ready acknowledgement. The original
      // must stay hidden from its first painted frame, not only after that scan.
      await delay(returned.length===0?900:120);await frame();
      const discovered=run('scan');
      if(discovered.items.length!==paths.length || discovered.attached)throw new Error('Invalid return handoff report');
      await delay(40);if(!run('attach').attached)throw new Error('Return attach failed');
      returned.push({secondary,primary,mode});await frame();
    }
    // Same-route overlays have no history/URL event but still rebuild the menu.
    document.getElementById('fixture-nav').remove();run('scan');await delay(40);
    document.body.append(makeNav());await delay(120);await frame();run('attach');
    recording = false;
    run('detach'); await frame();
    const restored = getComputedStyle(document.getElementById('fixture-nav')).opacity === '1';
    window.__duoBrowserCheck = { done: true, ok: flashes.length === 0 && restored && initialTakeoverBeforeLoad,
      initialTakeoverBeforeLoad, transitions: 24, secondaryReturns: returned.length, sameRouteReturns: 1,
      frames, exposedFrames: flashes.length,
      originalIconCount, originalColorsPreserved, restored, flashes };
  } catch (error) {
    recording = false;
    window.__duoBrowserCheck = { done: true, ok: false, message: String(error), frames, flashes };
  }
})();
</script></body></html>`;

const server = createServer((request, response) => {
  if (request.url === '/slow-resource.svg') {
    const pending = setTimeout(() => {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    }, 5000);
    response.on('close', () => clearTimeout(pending));
    return;
  }
  const icon = request.url.match(/^\/fixture-icon-([25])\.svg$/);
  if (icon) {
    const color = icon[1] === '2' ? '#0064ff' : '#eebb00';
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#000"/><rect x="24" width="24" height="24" fill="' + color + '"/></svg>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const profile = resolve(output, 'edge-profile-' + Date.now());
const browser = spawn(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--user-data-dir=' + profile,
  'http://127.0.0.1:' + port + '/learn'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let startupError;
browser.on('error', error => { startupError = error; });
browser.stderr.on('data', () => {});
let ws;
let send;
try {
  let debugPort;
  for (let attempt = 0; attempt < 600; attempt++) {
    if (startupError) throw startupError;
    const portFile = resolve(profile, 'DevToolsActivePort');
    if (existsSync(portFile)) {
      debugPort = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (debugPort > 0) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!debugPort) throw new Error('Edge debugging startup timed out.');
  const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
  const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:' + port));
  if (!target) throw new Error('Synthetic fixture target not found.');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let id = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id); if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser closed.')); }
    pending.clear();
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const currentId = ++id;
    const timer = setTimeout(() => { pending.delete(currentId); reject(new Error('Browser command timed out.')); }, 5000);
    pending.set(currentId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: currentId, method, params }));
  });
  let result;
  for (let attempt = 0; attempt < 600; attempt++) {
    const evaluated = await send('Runtime.evaluate', { expression: 'window.__duoBrowserCheck', returnByValue: true });
    result = evaluated.result?.value;
    if (result?.done) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!result?.done) throw new Error('Browser regression did not finish.');
  if (result.ok) {
    await send('Runtime.evaluate',{expression:'window.startLockChecks()'});
    const lockResults=[];
    for(const rebuild of [false,true,false,true]){
      await send('Runtime.evaluate',{expression:'window.pauseForLock('+JSON.stringify(rebuild)+')'});
      await send('Page.setWebLifecycleState',{state:'frozen'});
      await new Promise(resolve=>setTimeout(resolve,2800));
      await send('Page.setWebLifecycleState',{state:'active'});
      // Let compositor frames run before the native-side simulated resume scan.
      await new Promise(resolve=>setTimeout(resolve,120));
      const resumed=await send('Runtime.evaluate',{expression:'window.resumeFromLock()',returnByValue:true});
      lockResults.push(resumed.result.value);
      await new Promise(resolve=>setTimeout(resolve,60));
    }
    const final=await send('Runtime.evaluate',{expression:'window.finishLockChecks()',returnByValue:true});
    result={...result,lockCycles:lockResults.length,lifecycleFrozen:true,frames:final.result.value.frames,
      exposedFrames:final.result.value.exposedFrames,restored:final.result.value.restored,
      ok:final.result.value.exposedFrames===0&&final.result.value.restored&&
        lockResults.every(r=>r.attached&&r.hidden&&r.items===6)};
  }
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  if (send) await send('Browser.close').catch(() => {});
  if (ws) ws.close();
  browser.kill(); server.close();
}
