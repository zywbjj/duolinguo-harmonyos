// Production navigation + content insets on synthetic document/nested/fixed/sticky/modal layouts.
// No account or purchase actions are accessed. Native HDS still needs phone verification.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadService} from '../tests/load-service.mjs';

const {navigationScript}=await loadService('WebNavigation');
const {webIconScript}=await loadService('WebIconScript');
const {webContentInsetScript}=await loadService('WebContentInsets');
const output=resolve(process.argv[2]||'.local-browser-check/appearance');mkdirSync(output,{recursive:true});
const html=readFileSync(fileURLToPath(new URL('../tests/fixtures/content-insets.html',import.meta.url)),'utf8')
.replace('__ICON_FUNCTION__',()=>webIconScript.toString()).replace('__INSET_FUNCTION__',()=>webContentInsetScript.toString()).replace('__NAVIGATION_FUNCTION__',()=>navigationScript.toString());
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
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  for(let n=0;n<50;n++){if(await evaluate('typeof window.runContentChecks === "function"'))break;await new Promise(resolve=>setTimeout(resolve,50));}
  const result=await evaluate('window.runContentChecks()');
  writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  if(!result.ok)process.exitCode=1;
}finally{if(send)await send('Browser.close').catch(()=>{});if(ws)ws.close();browser.kill();server.close();}
