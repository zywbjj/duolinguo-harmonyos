// Real matchMedia changes + the production theme query/palette. A synthetic
// website theme provider models the observed public data-duo-theme contract.
// Native HDS rendering and real ArkWeb still require phone verification.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadService} from '../tests/load-service.mjs';

const {themeStatusScript,parseThemeStatus,ThemeColors}=await loadService('AppearanceService');
const output=resolve(process.argv[2]||'.local-browser-check/appearance');mkdirSync(output,{recursive:true});
const query=themeStatusScript().replace(/const allowed = [^;]+;/,'const allowed = [location.origin];');
const html=`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:18px sans-serif;background:rgb(var(--color-snow));color:rgb(var(--color-eel))}
main{padding:24px}.dock{position:fixed;bottom:24px;left:12px;right:12px;border-radius:28px;padding:16px;
display:flex;justify-content:space-around;background:rgb(var(--color-snow));border:1px solid rgb(var(--color-swan))}
</style></head><body><main>Local appearance regression fixture</main><nav class="dock"><span id="normal">学习</span><span id="selected">练习</span></nav><script>
const media=matchMedia('(prefers-color-scheme: dark)');window.preference='system';window.renders=0;
function render(){const mode=preference==='on'?'dark':preference==='off'?'light':media.matches?'dark':'light';
document.documentElement.dataset.duoTheme=mode;renders++;
const root=document.documentElement.style,dark=mode==='dark';
root.setProperty('--color-snow',dark?'19,31,36':'255,255,255');root.setProperty('--color-eel',dark?'241,247,251':'75,75,75');
root.setProperty('--color-swan',dark?'55,70,79':'229,229,229');}
media.addEventListener('change',render);window.choose=value=>{preference=value;render();};render();
Object.defineProperty(document,'cookie',{get(){throw new Error('No cookie access');}});
Object.defineProperty(window,'localStorage',{get(){throw new Error('No settings storage access');}});
window.checkAppearance=()=>{const resolved=(0,eval)(${JSON.stringify(query)});return{
resolved,systemDark:media.matches,webBackground:getComputedStyle(document.body).backgroundColor,renders};};
</script></body></html>`;
const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html;charset=utf-8'});response.end(html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,profile=resolve(output,'edge-profile-'+Date.now());
const edge=process.env.DUO_EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser=spawn(edge,['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
  '--user-data-dir='+profile,'http://127.0.0.1:'+port],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let startupError,ws,send;browser.on('error',error=>{startupError=error;});browser.stderr.on('data',()=>{});
try{
  let debugPort;
  for(let n=0;n<150;n++){if(startupError)throw startupError;const p=resolve(profile,'DevToolsActivePort');
    if(existsSync(p)){debugPort=Number(readFileSync(p,'utf8').split(/\r?\n/)[0]);if(debugPort)break;}
    await new Promise(resolve=>setTimeout(resolve,100));}
  if(!debugPort)throw new Error('Browser startup timed out');
  const targets=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  const target=targets.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'+port));
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  const pending=new Map();let id=0;
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data),entry=pending.get(message.id);if(!entry)return;
    clearTimeout(entry.timer);pending.delete(message.id);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result);});
  send=(method,params={})=>new Promise((resolve,reject)=>{const current=++id,timer=setTimeout(()=>{pending.delete(current);reject(new Error('Browser command timed out'));},5000);
    pending.set(current,{resolve,reject,timer});ws.send(JSON.stringify({id:current,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error('Appearance fixture threw');return r.result.value;};
  for(let n=0;n<50;n++){if(await evaluate('typeof window.checkAppearance === "function"'))break;await new Promise(resolve=>setTimeout(resolve,50));}
  const results=[];
  for(const system of ['light','dark','light','dark'])for(const preference of ['system','on','off','system']){
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:system}]});
    await evaluate('window.choose('+JSON.stringify(preference)+')');
    await new Promise(resolve=>setTimeout(resolve,40));
    const actual=await evaluate('window.checkAppearance()'),expected=preference==='on'?'dark':preference==='off'?'light':system;
    const resolved=parseThemeStatus(actual.resolved),colors=new ThemeColors(resolved==='dark');
    if(resolved!==expected||actual.systemDark!==(system==='dark'))throw new Error('Theme selection mismatch');
    const wanted=expected==='dark'?'rgb(19, 31, 36)':'rgb(255, 255, 255)';
    if(actual.webBackground!==wanted)throw new Error('Web palette mismatch');
    await evaluate('document.getElementById("normal").style.color='+JSON.stringify(colors.navText)+';document.getElementById("selected").style.color='+JSON.stringify(colors.accent));
    results.push({system,preference,resolved,background:colors.background,normal:colors.navText,selected:colors.accent,systemContent:colors.systemContent});
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  for(const preference of ['off','on']){
    await evaluate('window.choose('+JSON.stringify(preference)+')');await new Promise(resolve=>setTimeout(resolve,40));
    const colors=new ThemeColors(preference==='on');await evaluate('document.getElementById("normal").style.color='+JSON.stringify(colors.navText)+';document.getElementById("selected").style.color='+JSON.stringify(colors.accent));
    const screenshot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,preference==='on'?'dark-fixture.png':'light-fixture.png'),Buffer.from(screenshot.data,'base64'));
  }
  const result={done:true,ok:true,cases:results.length,reloads:0,syntheticThemeProvider:true,realMatchMedia:true,nativeHdsRendered:false,results};
  writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:true,cases:results.length,reloads:0}));
}finally{if(send)await send('Browser.close').catch(()=>{});if(ws)ws.close();browser.kill();server.close();}
