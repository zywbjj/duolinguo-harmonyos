import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from './load-service.mjs';
const { voiceAssetPath, OfflineVoiceResources } = await loadService('OfflineVoiceResources');
const root = 'https://www.duolingo.com/__duolinguo_voice_v1__/';
test('offline voice assets use exact trusted origins and two fixed paths', () => {
  for (const file of ['vosk-0.0.8.js', 'en-us-0.15.tar.gz']) assert.equal(voiceAssetPath(root + file), file);
  for (const prefix of ['http://www.duolingo.com', 'https://www.duolingo.com.evil.test', 'https://www.duolingo.com:444'])
    assert.equal(voiceAssetPath(prefix + '/__duolinguo_voice_v1__/vosk-0.0.8.js'), '');
  for (const file of ['unknown', 'vosk-0.0.8.js?q=1', 'en-us-0.15.tar.gz#x']) assert.equal(voiceAssetPath(root + file), 'invalid');
  assert.equal(voiceAssetPath('https://www.duolingo.com/learn'), '');
});
test('intercepted assets are local resources and unsupported methods return a local 404', () => {
  globalThis.$rawfile = value => ({ resource: value });
  globalThis.WebResourceResponse = class {
    setResponseEncoding(v){this.encoding=v;} setResponseCode(v){this.code=v;} setReasonMessage(v){}
    setResponseMimeType(v){this.mime=v;} setResponseData(v){this.data=v;} setResponseHeader(v){this.headers=v;}
  };
  try {
    const r=OfflineVoiceResources.response(root+'en-us-0.15.tar.gz','GET');
    assert.equal(r.code,200); assert.deepEqual(r.data,{resource:'voice/en-us-0.15.tar.gz'});
    assert.equal(OfflineVoiceResources.response(root+'vosk-0.0.8.js','POST').code,404);
    assert.equal(OfflineVoiceResources.response(root+'unknown','GET').code,404);
    assert.equal(OfflineVoiceResources.response('https://www.duolingo.com/learn','GET'),undefined);
  } finally {delete globalThis.$rawfile;delete globalThis.WebResourceResponse;}
});
