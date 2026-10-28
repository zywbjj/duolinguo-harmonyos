import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {loadService} from './load-service.mjs';
const {AppearanceService,ThemeColors,parseThemeStatus,parsePageChromeStatus,themeStatusScript}=await loadService('AppearanceService');
const storage=new Map();globalThis.AppStorage={get:key=>storage.get(key),setOrCreate:(key,value)=>storage.set(key,value)};

test('native appearance follows system until the website supplies its resolved theme',()=>{
  AppearanceService.unbind();AppearanceService.initialize(0);assert.equal(storage.get('duoDark'),true);
  AppearanceService.setPageTheme('light');assert.equal(storage.get('duoDark'),false);
  AppearanceService.setSystemMode(0);assert.equal(storage.get('duoDark'),false);
  AppearanceService.setPageTheme('dark');AppearanceService.setSystemMode(1);assert.equal(storage.get('duoDark'),true);
  AppearanceService.resetPage();assert.equal(storage.get('duoDark'),false);
});

test('only fixed theme enums can affect the native chrome and duplicate values do not update the window',()=>{
  AppearanceService.unbind();AppearanceService.initialize(1);const seen=[];AppearanceService.bind(dark=>seen.push(dark));
  AppearanceService.setPageTheme('dark');AppearanceService.setPageTheme('dark');
  AppearanceService.setPageTheme('private settings');AppearanceService.setSystemMode(-1);
  assert.deepEqual(seen,[false,true]);AppearanceService.unbind();
  for(const value of ['dark','"dark"','light','"light"'])assert.ok(['dark','light'].includes(parseThemeStatus(value)));
  for(const value of ['null','{}','"system"','private data','x'.repeat(33)])assert.equal(parseThemeStatus(value),'');
});

test('the theme query reads only the official top-level HTML theme marker',()=>{
  for(const origin of ['https://www.duolingo.com','https://duolingo.cn','https://www.duolingo.com.evil.test','http://www.duolingo.com']){
    const sandbox={location:{origin},document:{documentElement:{getAttribute:key=>{assert.equal(key,'data-duo-theme');return'dark';}}}};
    sandbox.window=sandbox;sandbox.top=sandbox;
    Object.defineProperty(sandbox,'localStorage',{get(){throw new Error('No storage access');}});
    assert.equal(parseThemeStatus(vm.runInNewContext(themeStatusScript(),sandbox)),origin==='https://www.duolingo.com'||origin==='https://duolingo.cn'?'dark':'');
    sandbox.top={};assert.equal(vm.runInNewContext(themeStatusScript(),sandbox),'');
  }
});

test('navigation uses black/white labels and the official blue accent for each appearance',()=>{
  const light=new ThemeColors(false),dark=new ThemeColors(true);
  assert.equal(light.navText,'#000000');assert.equal(dark.navText,'#FFFFFF');
  assert.equal(light.accent,'#1CB0F6');assert.equal(dark.accent,'#49C0F8');
  assert.equal(dark.background,'#131F24');assert.equal(dark.systemContent,'#FFFFFF');
});

test('page chrome accepts a theme plus one boolean occlusion flag in either ArkWeb encoding',()=>{
  for(const raw of ['{"theme":"dark","occluded":true}',JSON.stringify('{"theme":"dark","occluded":true}')]){
    const state=parsePageChromeStatus(raw);assert.equal(state.available,true);assert.equal(state.theme,'dark');assert.equal(state.occluded,true);
  }
  for(const raw of ['{"theme":"dark","occluded":"true"}','{"theme":"private","occluded":true}','x'.repeat(193)])
    assert.equal(parsePageChromeStatus(raw).available,false);
});
