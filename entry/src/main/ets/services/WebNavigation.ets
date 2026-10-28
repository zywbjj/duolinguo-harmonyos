import { url } from '@kit.ArkTS';
import { isLearningOrigin, safeOrigin } from './NavigationPolicy';
import { webIconScript } from './WebIconScript';
import { webContentInsetScript } from './WebContentInsets';

export class NavigationItem {
  path: string = '';
  label: string = '';
  kind: string = 'more';
  image: string = '';

  constructor(path: string = '', label: string = '', kind: string = 'more', image: string = '') {
    this.path = path;
    this.label = label;
    this.kind = kind;
    this.image = image;
  }
}

export function safeNavigationIcon(value: string | undefined): string {
  if (typeof value !== 'string' || value.length > 49152) { return ''; }
  if (/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(value)) { return value; }
  if (value.length > 2048) { return ''; }
  try {
    const asset = url.URL.parseURL(value);
    if (asset.protocol !== 'https:' || asset.username !== '' || asset.password !== '' ||
      asset.search !== '' || asset.hash !== '' || (asset.port !== '' && asset.port !== '443')) { return ''; }
    const host = asset.hostname;
    return host === 'd35aaqx5ub95lt.cloudfront.net' || host === 'duolingo.com' || host.endsWith('.duolingo.com') ||
      host === 'duolingo.cn' || host.endsWith('.duolingo.cn') ? value : '';
  } catch { return ''; }
}

export class NavigationReport {
  origin: string = '';
  page: string = '';
  items: NavigationItem[] = [];
  selected: number = 0;
  attached: boolean = false;
  pending: boolean = false;
  height: number = 80;
}

export function navigationIndex(items: NavigationItem[], address: string): number {
  try {
    const path = url.URL.parseURL(address).pathname;
    let selected = -1;
    let length = 0;
    items.forEach((item: NavigationItem, index: number) => {
      if ((path === item.path || path.startsWith(item.path + '/')) && item.path.length > length) {
        selected = index;
        length = item.path.length;
      }
    });
    return selected;
  } catch { return -1; }
}

// Keep the mounted native bar when a same-document transition stays within its observed menu.
export function carryNavigation(report: NavigationReport, address: string, exact: boolean = false): NavigationReport {
  const empty = new NavigationReport();
  try {
  if (!report.attached || !isLearningOrigin(address) || safeOrigin(address) !== report.origin) { return empty; }
  const selected = navigationIndex(report.items, address);
  if (selected < 0 || (exact && report.items[selected].path !== url.URL.parseURL(address).pathname)) { return empty; }
  const result = new NavigationReport();
  result.origin = report.origin;
  result.page = url.URL.parseURL(address).pathname;
  result.items = report.items;
  result.selected = selected;
  result.attached = true;
  result.pending = true;
  result.height = report.height;
  return result;
  } catch { return empty; }
}

// The bridge exports navigation labels and paths only; it never reads account data or storage.
export function parseNavigationReport(raw: string, address: string): NavigationReport {
  if (!isLearningOrigin(address) || raw.length > 400000) { return new NavigationReport(); }
  try {
    let value = JSON.parse(raw) as NavigationReport | string;
    if (typeof value === 'string') { value = JSON.parse(value) as NavigationReport; }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.origin !== safeOrigin(address) || !Array.isArray(value.items) ||
      value.items.length < 3 || value.items.length > 8 ||
      !Number.isInteger(value.selected) || value.selected < 0 || value.selected >= value.items.length ||
      value.page !== url.URL.parseURL(address).pathname ||
      !value.items.some((item: NavigationItem) => item?.path === '/learn')) {
      return new NavigationReport();
    }
    const result = new NavigationReport();
    for (const item of value.items) {
      if (!item || typeof item.path !== 'string' || !item.path.startsWith('/') ||
        item.path.startsWith('//') || /[?#\\\u0000-\u0020]/.test(item.path) ||
        safeOrigin(value.origin + item.path) !== value.origin ||
        typeof item.label !== 'string' || item.label.length === 0 || item.label.length > 18 ||
        /[\u0000-\u001f]/.test(item.label) || result.items.some((other: NavigationItem) => other.path === item.path)) {
        return new NavigationReport();
      }
      const kind = ['learn', 'sounds', 'practice', 'quests', 'shop', 'profile'].includes(item.kind) ? item.kind : 'more';
      result.items.push(new NavigationItem(item.path, item.label, kind, safeNavigationIcon(item.image)));
    }
    result.origin = value.origin;
    result.page = value.page;
    result.selected = value.selected;
    result.attached = value.attached === true;
    result.pending = value.pending === true;
    result.height = typeof value.height === 'number' && Number.isFinite(value.height) ?
      Math.max(76, Math.min(120, value.height)) : 80;
    return result;
  } catch { return new NavigationReport(); }
}

export function navigationScript(command: string, selection: number = -1, expectedPage: string = '', expectedPath: string = '',
  nativeDockHeight: number = 0, nativeWebHeight: number = 0): string {
  if (!['scan', 'attach', 'detach', 'activate', 'pause'].includes(command) || !Number.isInteger(selection) ||
    selection < -1 || selection > 7) { throw new Error('invalid_navigation_command'); }
  if (!Number.isFinite(nativeDockHeight) || nativeDockHeight < 0 || nativeDockHeight > 300 ||
    !Number.isFinite(nativeWebHeight) || nativeWebHeight < 0 || nativeWebHeight > 5000) { throw new Error('invalid_navigation_geometry'); }
  return `(() => {
    const command = ${JSON.stringify(command)};
    const selection = ${selection};
    const expectedPage = ${JSON.stringify(expectedPage)};
    const expectedPath = ${JSON.stringify(expectedPath)};

    'use strict';
    const allowed = ['https://www.duolingo.com','https://duolingo.com','https://www.duolingo.cn','https://duolingo.cn'];
    const empty = () => JSON.stringify({ items: [] });
    const current = new URL(location.href);
    if (!allowed.includes(current.origin) || current.username || current.password) return empty();
    const key = '__duoNativeNavigationV2';
    const state = window[key] || { root: null, enabled: false, armed: false, hidden: new Map(), timer: null,
      observer: null, onPop: null, onVisibility: null, paused: false,
      page: '', paths: '', items: [], height: 80, transitionUntil: 0,
      handoffUntil: 0, expires: 0 };
    window[key] = state;
    if (${nativeDockHeight} > 0) { state.nativeDockHeight = ${nativeDockHeight}; state.nativeWebHeight = ${nativeWebHeight}; }
    ${webIconScript()}
    ${webContentInsetScript()}

    const restoreElement = (root, original) => {
      if (original.opacity) root.style.setProperty('opacity', original.opacity, original.opacityPriority);
      else root.style.removeProperty('opacity');
      if (original.pointer) root.style.setProperty('pointer-events', original.pointer, original.pointerPriority);
      else root.style.removeProperty('pointer-events');
    };
    const restoreHidden = () => {
      state.hidden.forEach((original, root) => restoreElement(root, original));
      state.hidden.clear();
    };
    const release = () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (state.observer) state.observer.disconnect();
      state.observer = null;
      if (state.onPop) window.removeEventListener('popstate', state.onPop);
      state.onPop = null;
      if (state.onVisibility) document.removeEventListener('visibilitychange', state.onVisibility);
      state.onVisibility = null;
      restoreHidden();
      restoreContentInsets();
      state.occluded = false;
      state.iconCache.clear();
      state.enabled = false;
      state.armed = false;
      state.paused = false;
      state.root = null;
      state.transitionUntil = 0;
      state.handoffUntil = 0;
    };
    // A secondary page has no native dock, but the acknowledged menu can be
    // watched in this same document so its return is caught before browser paint.
    const suspend = () => {
      restoreContentInsets();
      // Do not expose the old footer through a translucent modal/backdrop.
      if (!state.occluded) restoreHidden();
      state.enabled = false; state.root = null;
      state.page = location.pathname; state.transitionUntil = 0; state.handoffUntil = 0;
    };
    if (command === 'detach') { release(); return empty(); }

    const indexFor = (items, path) => {
      let selected = -1, length = 0;
      items.forEach((item, index) => {
        if ((path === item.path || path.startsWith(item.path + '/')) && item.path.length > length) {
          selected = index; length = item.path.length;
        }
      });
      return selected;
    };
    const hide = root => {
      if (!state.hidden.has(root)) {
        state.hidden.set(root, { opacity: root.style.getPropertyValue('opacity'),
          opacityPriority: root.style.getPropertyPriority('opacity'),
          pointer: root.style.getPropertyValue('pointer-events'),
          pointerPriority: root.style.getPropertyPriority('pointer-events') });
      }
      // Opacity preserves geometry and inherited visibility: scans need not unhide the original.
      if (root.style.getPropertyValue('opacity') !== '0' || root.style.getPropertyPriority('opacity') !== 'important')
        root.style.setProperty('opacity', '0', 'important');
      if (root.style.getPropertyValue('pointer-events') !== 'none' || root.style.getPropertyPriority('pointer-events') !== 'important')
        root.style.setProperty('pointer-events', 'none', 'important');
      state.hidden.forEach((original, previous) => {
        if (previous !== root && !previous.isConnected) {
          restoreElement(previous, original); state.hidden.delete(previous);
        }
      });
    };
    const rectFits = element => {
      if (!element || !element.isConnected) return false;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.height >= 40 && rect.height <= 128 && rect.width >= innerWidth * 0.65 &&
        rect.top >= innerHeight * 0.55 && rect.bottom >= innerHeight - 36 &&
        rect.bottom <= innerHeight + 4 && style.display !== 'none' && style.visibility !== 'hidden' &&
        (Number(style.opacity) !== 0 || state.hidden.has(element));
    };
    const linksOf = root => Array.from(root.querySelectorAll('a[href]')).filter(a => {
      const r = a.getBoundingClientRect(), style = getComputedStyle(a);
      return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const classify = path => {
      if (path === '/learn') return ['learn', '学习'];
      if (/^\\/(sounds|characters)(\\/|$)/.test(path)) return ['sounds', '发音'];
      if (/^\\/(practice|practice-hub)(\\/|$)/.test(path)) return ['practice', '练习'];
      if (/^\\/(quests|challenges)(\\/|$)/.test(path)) return ['quests', '任务'];
      if (/^\\/shop(\\/|$)/.test(path)) return ['shop', '商店'];
      if (/^\\/profile(\\/|$)/.test(path)) return ['profile', '我的'];
      if (/^\\/leaderboard(\\/|$)/.test(path)) return ['quests', '排行'];
      return ['more', '更多'];
    };
    const inspect = () => {
      let covered = false;
      const candidates = [];
      if (state.root) candidates.push(state.root);
      document.querySelectorAll('nav,[role="navigation"],[data-test="bottom-nav"],[data-test="bottom-navigation"]').forEach(e => candidates.push(e));
      Array.from(document.querySelectorAll('a[href]')).slice(0, 500).forEach(a => {
        try {
          if (new URL(a.href, location.href).pathname !== '/learn') return;
          let parent = a.parentElement;
          for (let n = 0; parent && n < 4; n++, parent = parent.parentElement) candidates.push(parent);
        } catch {}
      });
      for (const root of candidates) {
        if (!rectFits(root)) continue;
        const links = linksOf(root);
        if (links.length < 3 || links.length > 8) continue;
        const items = [];
        let valid = true;
        for (const a of links) {
          const target = new URL(a.href, location.href);
          if (target.origin !== location.origin || target.username || target.password || a.target === '_blank' ||
            a.hasAttribute('download') || target.search || target.hash || items.some(i => i.path === target.pathname)) {
            valid = false; break;
          }
          const known = classify(target.pathname);
          const label = known[0] === 'more' ? (a.getAttribute('aria-label') || a.getAttribute('title') ||
            a.querySelector('img[alt]')?.alt || a.textContent || '更多').trim().slice(0, 18) : known[1];
          if (!label) { valid = false; break; }
          items.push({ path: target.pathname, label, kind: known[0], image: captureNavigationIcon(a) });
        }
        if (!valid || !items.some(i => i.path === '/learn')) continue;
        const selected = indexFor(items, location.pathname);
        if (selected < 0) continue;
        if (navigationCovered(root, links)) { covered = true; continue; }
        state.occluded = false;
        return { root, links, items, selected, height: Math.max(76, root.getBoundingClientRect().height),
          paths: items.map(item => item.path).join('|') };
      }
      state.occluded = covered;
      return null;
    };
    const renew = () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.expires = Date.now() + 2400;
      // A locked/hidden document has no usable web footer. Preserve ownership
      // until visibility resumes, then reinstate the bounded foreground lease.
      if (document.hidden || state.paused) { return; }
      const remaining = state.handoffUntil ? Math.max(0, state.handoffUntil - Date.now()) : 2400;
      state.timer = setTimeout(() => {
        state.timer = null;
        if (document.hidden) { state.paused = true; return; }
        release();
      }, Math.min(2400, remaining));
    };
    const pause = () => {
      state.paused = true; state.handoffUntil = 0;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    };
    const conceal = info => {
      if (!state.enabled) {
        if (!state.handoffUntil) state.handoffUntil = Date.now() + 1500;
        if (Date.now() >= state.handoffUntil) { release(); return false; }
      }
      state.root = info.root; state.height = info.height; hide(info.root); applyContentInsets(info.root); renew();
      return true;
    };
    const watch = () => {
      if (!state.armed || state.observer) return;
      const synchronize = records => {
        if (!state.armed) return;
        const inactive = state.paused || document.hidden;
        if (!inactive && (Date.now() >= state.expires || (state.handoffUntil && Date.now() >= state.handoffUntil))) { release(); return; }
        // Hit testing temporarily changes pointer-events on an owned hidden
        // menu. Its own queued records must not trigger another hit test when
        // a modal has suspended state.root, or observers would retrigger until
        // the foreground lease expired.
        const ownedStyleOnly = records.length > 0 && records.every(record => record.type === 'attributes' &&
          (!record.attributeName || record.attributeName === 'style') && state.hidden.has(record.target) && rectFits(record.target));
        if (ownedStyleOnly) {
          for (const target of new Set(records.map(record => record.target))) hide(target);
          return;
        }
        if (indexFor(state.items, location.pathname) < 0) {
          if (state.root || state.page !== location.pathname) suspend();
          return;
        }
        if (state.page !== location.pathname) {
          state.page = location.pathname;
          state.transitionUntil = state.items.some(item => item.path === location.pathname) ? Date.now() + 1500 : 0;
        }
        if (state.root && state.root.isConnected && rectFits(state.root)) {
          const ownStyleOnly = records.length > 0 && records.every(record => record.target === state.root && record.type === 'attributes' &&
            (!record.attributeName || record.attributeName === 'style'));
          if (!ownStyleOnly && navigationCovered(state.root, linksOf(state.root))) {
            state.occluded = true; suspend(); return;
          }
          // Ignore unrelated mutations. Reassert only our owned root if its style was replaced.
          if (records.some(record => record.target === state.root && record.type === 'attributes')) hide(state.root);
          if (!ownStyleOnly && !inactive) applyContentInsets(state.root);
          return;
        }
        const next = inspect();
        if (next && next.paths === state.paths) {
          if (inactive) { state.root = next.root; state.height = next.height; hide(next.root); }
          else { conceal(next); }
        } else if (next) { release(); }
      };
      state.observer = new MutationObserver(synchronize);
      state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['style', 'class', 'hidden'] });
      state.onPop = () => synchronize([]);
      window.addEventListener('popstate', state.onPop);
      state.onVisibility = () => {
        if (!state.armed) return;
        if (document.hidden) { pause(); return; }
        state.paused = false; state.handoffUntil = 0; renew(); synchronize([]);
      };
      document.addEventListener('visibilitychange', state.onVisibility);
    };
    const report = (info, pending = false) => JSON.stringify({
      origin: location.origin, page: location.pathname, items: info ? info.items : state.items,
      selected: info ? info.selected : indexFor(state.items, location.pathname),
      attached: state.enabled, pending, height: info ? info.height : state.height
    });
    const scan = () => {
      if (state.armed && state.paused) { state.paused = false; state.handoffUntil = 0; renew(); }
      if (state.armed && state.page !== location.pathname) {
        state.transitionUntil = state.items.some(item => item.path === location.pathname) ? Date.now() + 1500 : 0;
        state.page = location.pathname;
      }
      const info = inspect();
      if (!info) {
        if (state.armed && indexFor(state.items, location.pathname) >= 0 && Date.now() < state.transitionUntil) {
          renew(); return report(null, true);
        }
        if (state.armed) { suspend(); renew(); watch(); } else { release(); }
        return empty();
      }
      if (state.armed && state.paths !== info.paths) release();
      state.root = info.root;
      if (state.armed) {
        state.items = info.items; state.page = location.pathname; state.height = info.height;
        conceal(info); watch();
      }
      return report(info);
    };
    if (command === 'pause') {
      if (state.armed) { pause(); }
      return empty();
    }
    if ((command === 'activate' || command === 'attach') && expectedPage !== location.pathname) {
      return scan();
    }
    if (command === 'activate') {
      const info = inspect();
      if (!state.enabled || !info || state.paths !== info.paths || selection < 0 ||
        selection >= info.links.length || info.items[selection].path !== expectedPath) return scan();
      state.transitionUntil = Date.now() + 1500;
      hide(info.root); renew();
      info.links[selection].click();
      return scan();
    }
    if (command === 'attach') {
      const info = inspect();
      if (!info) { return scan(); }
      state.enabled = true; state.armed = true; state.paused = false; state.handoffUntil = 0;
      state.root = info.root; state.items = info.items;
      state.paths = info.paths; state.page = location.pathname; state.height = info.height;
      hide(info.root); applyContentInsets(info.root); renew(); watch();
      return report(info);
    }
    return scan();

  })()`;
}
