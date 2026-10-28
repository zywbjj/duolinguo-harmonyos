import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { loadService } from './load-service.mjs';
const { webAudioScript, audioStatusScript, parseAudioStatus } = await loadService('WebAudioScript');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function fixture(t,{origin='https://www.duolingo.com',child=false}={}){
  const calls=[],captures=[],instances=[],decoders=[],scripts=[],host=new EventTarget();
  const document=new EventTarget();document.hidden=false;document.createElement=()=>({remove(){}});document.head={append:s=>scripts.push(s)};
  const platform={modelCount:0,processor:undefined};
  class Decoder{
    constructor(){this.handlers=new Map();decoders.push(this);}on(e,fn){this.handlers.set(e,fn);}setWords(){}
    acceptWaveform(){calls.push('decode');}retrieveFinalResult(){queueMicrotask(()=>this.emit('result',{text:''}));}
    remove(){calls.push('remove-decoder');}emit(event,result){this.handlers.get(event)?.({event,result});}
  }
  class Model{
    constructor(){platform.modelCount++;this.ready=false;this.handlers=new Map();this.worker=new EventTarget();this.worker.terminate=()=>calls.push('terminate-worker');queueMicrotask(()=>{this.ready=true;this.handlers.get('load')?.({result:true});});}
    on(e,fn){this.handlers.set(e,fn);}get KaldiRecognizer(){return Decoder;}terminate(){calls.push('terminate-model');}
  }
  class Context{
    sampleRate=16000;destination={};resume(){return Promise.resolve();}close(){calls.push('close-context');return Promise.resolve();}
    createMediaStreamSource(){return{connect(){},disconnect(){}};}
    createScriptProcessor(){return platform.processor={connect(){},disconnect(){},onaudioprocess:null};}
    createGain(){return{gain:{value:1},connect(){},disconnect(){}};}
  }
  const original=class extends EventTarget{},query=async()=>({state:'prompt'});
  const sandbox={location:{origin},document,Event,EventTarget,DOMException,queueMicrotask,setTimeout,clearTimeout,
    AudioContext:Context,Worker:class{},WebAssembly:{},Vosk:{Model},webkitSpeechRecognition:original,SpeechRecognition:original,
    navigator:{permissions:{query},mediaDevices:{getUserMedia:constraints=>{calls.push(['capture',constraints]);const d=deferred();captures.push(d);return d.promise;}}},addEventListener:host.addEventListener.bind(host)};
  sandbox.window=sandbox;sandbox.top=child?{}:sandbox;const context=vm.createContext(sandbox);vm.runInContext(webAudioScript(),context);
  t.after(()=>{for(const r of instances)r.abort?.();host.dispatchEvent(new Event('pagehide'));});
  return{sandbox,document,host,calls,captures,decoders,scripts,platform,Model,original,context,query,
    create(){const r=new sandbox.webkitSpeechRecognition();instances.push(r);return r;},
    grant(i=0){captures[i].resolve({getTracks:()=>[{stop:()=>calls.push('stop-track')}]});},
    feed(){platform.processor.onaudioprocess({inputBuffer:{}});}};
}
test('generated injection equals the reviewed rawfile source',()=>{
  assert.equal(webAudioScript(),readFileSync(new URL('../overlay/entry/src/main/resources/rawfile/voice/duo-offline-speech.js',import.meta.url),'utf8'));
});
test('capture starts on demand and only actual decoder text is forwarded',async t=>{
  const f=fixture(t),r=f.create(),events=[];r.interimResults=true;r.continuous=true;r.onresult=e=>events.push(e);
  assert.equal(f.captures.length,0);r.start();await tick();assert.equal(f.captures.length,1);f.grant();await tick();
  f.feed();f.decoders[0].emit('partialresult',{partial:'actual decoded words'});
  assert.equal(events[0].results[0][0].transcript,'actual decoded words');assert.equal(events[0].results[0].isFinal,false);
  assert.equal(events[0].results.item(0),events[0].results[0]);assert.equal(events[0].results[0][0].confidence,0);
  f.feed();f.decoders[0].emit('result',{text:'actual decoded words',result:[{conf:0.6},{conf:0.8}]});
  assert.equal(events[1].results[0].isFinal,true);assert.equal(events[1].results[0][0].confidence,0.7);
  assert.equal(f.sandbox.navigator.permissions.query,f.query);assert.ok(!f.calls.includes('stop-track'));
  r.abort();assert.ok(f.calls.includes('stop-track'));
});
test('stop closes the microphone before waiting for final decoding',async t=>{
  const f=fixture(t),r=f.create(),events=[];r.continuous=true;r.onend=()=>events.push('end');r.start();await tick();f.grant();await tick();
  r.stop();assert.ok(f.calls.includes('stop-track'));assert.deepEqual(events,[]);await tick();assert.deepEqual(events,['end']);assert.ok(f.calls.includes('remove-decoder'));
});
test('a cancelled request closes a late stream and cannot start decoding',async t=>{
  const f=fixture(t),r=f.create();r.start();await tick();r.abort();f.grant();await tick();assert.ok(f.calls.includes('stop-track'));assert.equal(f.decoders.length,0);
});
test('cancelled library initialization cannot spawn a model or microphone later',async t=>{
  const f=fixture(t);f.sandbox.Vosk=undefined;const r=f.create();r.start();await tick();assert.equal(f.scripts.length,1);
  r.abort();f.sandbox.Vosk={Model:f.Model};f.scripts[0].onload();await tick();assert.equal(f.platform.modelCount,0);assert.equal(f.captures.length,0);
});
test('denial and engine failure never use the site network-pass error path',async t=>{
  const f=fixture(t),r=f.create(),errors=[];r.onerror=e=>{errors.push(e.error);r.abort();};r.start();await tick();
  f.captures[0].reject(new DOMException('private message','NotAllowedError'));await tick();assert.deepEqual(errors,['not-allowed']);assert.equal(f.sandbox.__duoAudioV2.stage,'capture-denied');
  r.start();await tick();f.grant(1);await tick();f.decoders[0].handlers.get('error')({event:'error',error:'engine failure'});
  assert.deepEqual(errors,['not-allowed','audio-capture']);assert.equal(f.sandbox.__duoAudioV2.stage,'engine-error');
});
test('background releases capture, audio nodes and model without grading',async t=>{
  const f=fixture(t),r=f.create(),errors=[];r.onerror=e=>errors.push(e.error);r.start();await tick();f.grant();await tick();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));await tick();
  for(const call of ['stop-track','close-context','terminate-worker'])assert.ok(f.calls.includes(call));
  assert.deepEqual(errors,['audio-capture']);assert.equal(f.sandbox.__duoAudioV2.stage,'capture-interrupted');
});
test('hidden pages never capture, and a repeated start rejects',async t=>{
  const f=fixture(t),r=f.create();f.document.hidden=true;r.start();await tick();assert.equal(f.captures.length,0);
  f.document.hidden=false;r.start();assert.throws(()=>r.start(),{name:'InvalidStateError'});await tick();r.abort();f.grant();await tick();
});
test('non-English requests fail without microphone access or a grading shortcut',async t=>{
  const f=fixture(t),r=f.create(),errors=[];r.lang='de-DE';r.onerror=e=>errors.push(e.error);r.start();await tick();assert.deepEqual(errors,['audio-capture']);assert.equal(f.captures.length,0);
});
test('status remains observable when the website replaces console methods',async t=>{
  const f=fixture(t),r=f.create();f.sandbox.console={info(){throw new Error('disabled console');}};r.start();await tick();
  assert.equal(parseAudioStatus(JSON.stringify(vm.runInContext(audioStatusScript(),f.context))).stage,'model-ready');
  assert.equal(parseAudioStatus('{"sequence":12,"stage":"engine-error"}').sequence,12);
  for(const raw of ['private log','{"sequence":0,"stage":"SECRET"}','{"sequence":-1,"stage":"idle"}','{"sequence":1.5,"stage":"idle"}'])assert.equal(parseAudioStatus(raw).sequence,-1);
  r.abort();f.grant();await tick();
});
test('only trusted top-level documents are changed and repeated injection is harmless',t=>{
  for(const options of [{origin:'https://www.duolingo.com.evil.test'},{origin:'http://www.duolingo.com'},{child:true}]){const f=fixture(t,options);assert.equal(f.sandbox.webkitSpeechRecognition,f.original);}
  const f=fixture(t),original=f.sandbox.webkitSpeechRecognition;vm.runInContext(webAudioScript(),f.context);assert.equal(f.sandbox.webkitSpeechRecognition,original);
});
