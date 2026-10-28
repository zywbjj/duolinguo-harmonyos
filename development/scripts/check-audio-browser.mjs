// Real Vosk + Web Audio adapter integration using only the pinned public Vosk sample.
// No physical microphone, browser account or cloud speech service.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadService } from '../tests/load-service.mjs';

const { webAudioScript } = await loadService('WebAudioScript');
const edge = process.env.DUO_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output = resolve(process.argv[2] || '.local-browser-check/audio');
mkdirSync(output, { recursive: true });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const voice = resolve(root, 'overlay/entry/src/main/resources/rawfile/voice');
const sample = resolve(process.argv[3] || 'missing-public-sample.wav');
if (!existsSync(sample) || createHash('sha256').update(readFileSync(sample)).digest('hex') !== 'dcfea5712c43a43ba7ae8083afb39d36993e5a69c46e88b68aaa72b65cb615bb')
  throw new Error('Supply the unmodified public vosk-api python/example/test.wav as the second argument.');
const html = readFileSync(resolve(root, 'tests/fixtures/offline-audio.html'), 'utf8');
const server = createServer((request, response) => {
  if(request.url==='/bridge.js'){
    const body=webAudioScript().replace(/const allowed = [^;]+;/,'const allowed = [location.origin];');
    response.writeHead(200,{'content-type':'text/javascript'});response.end(body);return;
  }
  const paths={
    '/__duolinguo_voice_v1__/vosk-0.0.8.js':resolve(voice,'vosk-0.0.8.js'),
    '/__duolinguo_voice_v1__/en-us-0.15.tar.gz':resolve(voice,'en-us-0.15.tar.gz'),
    '/test.wav':sample
  };
  if(paths[request.url]){const body=readFileSync(paths[request.url]);response.writeHead(200,{'content-type':request.url.endsWith('.js')?'text/javascript':'application/octet-stream','content-length':body.length});response.end(body);return;}
  if(request.url!=='/'){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const profile = resolve(output, 'edge-profile-' + Date.now());
const browser = spawn(edge, ['--headless=new', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'http://127.0.0.1:' + port],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let startupError, ws, send;
browser.on('error', error => { startupError = error; }); browser.stderr.on('data', () => {});
try {
  let debugPort;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (startupError) throw startupError;
    const portFile = resolve(profile, 'DevToolsActivePort');
    if (existsSync(portFile)) {
      debugPort = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (debugPort > 0) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!debugPort) throw new Error('Browser startup timed out');
  const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
  const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:' + port));
  if (!target) throw new Error('Local fixture target not found');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true });
  });
  const pending = new Map(); let id = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser closed')); }
    pending.clear();
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const currentId = ++id;
    const timer = setTimeout(() => { pending.delete(currentId); reject(new Error('Browser command timed out')); }, 90000);
    pending.set(currentId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: currentId, method, params }));
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await send('Runtime.evaluate', { expression: 'typeof window.runAudioCheck === "function"', returnByValue: true });
    if (state.result?.value) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Fixture initialization timed out');
  await send('Runtime.evaluate', { expression: 'window.runAudioCheck()', userGesture: true, awaitPromise: true });
  const evaluated = await send('Runtime.evaluate', { expression: 'window.__duoBrowserCheck', returnByValue: true });
  const result = evaluated.result?.value;
  if (!result?.done) throw new Error('Missing browser check result');
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
} finally {
  if (send) await send('Browser.close').catch(() => {});
  if (ws) ws.close(); browser.kill(); server.close();
}
