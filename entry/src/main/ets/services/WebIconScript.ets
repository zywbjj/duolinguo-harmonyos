export function webIconScript(): string {
  return `
    if (!state.iconCache) state.iconCache = new Map();
    const iconAsset = value => {
      try {
        if (typeof value !== 'string' || value.length > 2048) return '';
        const asset = new URL(value, location.href);
        if (asset.username || asset.password || asset.search || asset.hash) return '';
        if (asset.origin === location.origin) return asset.href;
        if (asset.protocol !== 'https:') return '';
        const host = asset.hostname;
        return (host === 'd35aaqx5ub95lt.cloudfront.net' || host === 'duolingo.com' ||
          host.endsWith('.duolingo.com') || host === 'duolingo.cn' || host.endsWith('.duolingo.cn')) &&
          (!asset.port || asset.port === '443') ? asset.href : '';
      } catch { return ''; }
    };
    const iconRemember = (key, entry) => {
      if (state.iconCache.size >= 24) state.iconCache.delete(state.iconCache.keys().next().value);
      state.iconCache.set(key, entry);
      return entry;
    };
    const iconPosition = (value, available) => {
      if (value === 'center') return available / 2;
      if (value === 'left' || value === 'top') return 0;
      if (value === 'right' || value === 'bottom') return available;
      if (/^-?[\\d.]+%$/.test(value)) return available * parseFloat(value) / 100;
      if (/^-?[\\d.]+px$/.test(value) || value === '0') return parseFloat(value);
      return NaN;
    };
    const iconPng = (image, width, height, x, y, drawWidth, drawHeight, filter = 'none', opacity = '1') => {
      const canvas = document.createElement('canvas');
      canvas.width = 96; canvas.height = 96;
      const context = canvas.getContext('2d');
      if (!context || ![width,height,x,y,drawWidth,drawHeight].every(Number.isFinite) || width <= 0 || height <= 0) return '';
      const scale = Math.min(96 / width, 96 / height);
      context.translate((96 - width * scale) / 2, (96 - height * scale) / 2);
      context.scale(scale, scale);
      context.beginPath(); context.rect(0, 0, width, height); context.clip();
      if (filter && filter !== 'none') context.filter = filter;
      context.globalAlpha = Number.isFinite(Number(opacity)) ? Math.max(0, Math.min(1, Number(opacity))) : 1;
      context.drawImage(image, x, y, drawWidth, drawHeight);
      const result = canvas.toDataURL('image/png');
      return result.length <= 49152 ? result : '';
    };
    const iconFromImage = (image, anchor) => {
      const source = image.currentSrc || image.src || '';
      const fallback = iconAsset(source);
      if (!image.complete || image.naturalWidth <= 0) return fallback;
      const rect = image.getBoundingClientRect(), style = getComputedStyle(image);
      let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
      for (let parent = image.parentElement, n = 0; parent && parent !== anchor && n < 4; parent = parent.parentElement, n++) {
        const clipping = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (['hidden','clip'].includes(clipping.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (['hidden','clip'].includes(clipping.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      const width = right - left, height = bottom - top;
      if (!(width > 0 && height > 0 && width <= 160 && height <= 160)) return '';
      const key = ['img',source,rect.width,rect.height,width,height,left-rect.left,top-rect.top,
        style.objectFit,style.objectPosition,style.filter,style.opacity].join('|');
      if (state.iconCache.has(key)) return state.iconCache.get(key).value;
      const entry = iconRemember(key, { value: fallback });
      try {
        let drawWidth = rect.width, drawHeight = rect.height;
        const fit = style.objectFit;
        if (fit === 'contain' || fit === 'cover' || fit === 'scale-down') {
          let scale = (fit === 'cover' ? Math.max : Math.min)(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
          if (fit === 'scale-down') scale = Math.min(1, scale);
          drawWidth = image.naturalWidth * scale; drawHeight = image.naturalHeight * scale;
        } else if (fit === 'none') { drawWidth = image.naturalWidth; drawHeight = image.naturalHeight; }
        const position = (style.objectPosition || '50% 50%').split(/\\s+/);
        const x = iconPosition(position[0], rect.width - drawWidth) + rect.left - left;
        const y = iconPosition(position[1] || '50%', rect.height - drawHeight) + rect.top - top;
        entry.value = iconPng(image, width, height, x, y, drawWidth, drawHeight, style.filter, style.opacity) || fallback;
      } catch {
        // A tainted canvas cannot be read. Only a verified public individual image may be loaded natively.
        if (width !== rect.width || height !== rect.height || style.objectFit === 'none') entry.value = '';
      }
      return entry.value;
    };
    const iconFromSvg = source => {
      const clone = source.cloneNode(true);
      const originals = [source, ...source.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
      if (originals.length > 160) return '';
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i], copy = copies[i];
        if (!copy.style) continue;
        const computed = getComputedStyle(original);
        copy.removeAttribute('style');
        for (const property of ['fill','stroke','stroke-width','color','opacity','fill-rule','stroke-linecap','stroke-linejoin']) {
          const value = computed.getPropertyValue(property);
          if (value && !value.includes('url(')) copy.style.setProperty(property, value);
        }
      }
      clone.querySelectorAll('style').forEach(node => node.remove());
      for (const use of clone.querySelectorAll('use')) {
        const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (!ref.startsWith('#')) return '';
        if (!Array.from(clone.querySelectorAll('[id]')).some(node => node.id === ref.slice(1))) {
          const original = document.getElementById(ref.slice(1));
          if (!original || !['symbol','g','path'].includes(original.tagName.toLowerCase())) return '';
          const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          defs.append(original.cloneNode(true)); clone.append(defs);
        }
      }
      if (clone.querySelector('script,foreignObject,iframe,image,feImage,animate,set')) return '';
      for (const node of [clone, ...clone.querySelectorAll('*')]) {
        for (const attribute of [...node.attributes]) {
          if (/^on/i.test(attribute.name) || (/href$/i.test(attribute.name) && !attribute.value.startsWith('#')) ||
            (/url\\s*\\(/i.test(attribute.value) && !/^url\\(\\s*['"]?#[^)'"]+['"]?\\s*\\)$/i.test(attribute.value))) return '';
        }
      }
      const rect = source.getBoundingClientRect();
      if (!clone.hasAttribute('viewBox')) clone.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width','96'); clone.setAttribute('height','96');
      const xml = new XMLSerializer().serializeToString(clone);
      if (xml.length > 32768) return '';
      const key = 'svg|' + xml;
      if (state.iconCache.has(key)) return state.iconCache.get(key).value;
      const entry = iconRemember(key, { value: '' });
      const image = new Image();
      image.onload = () => { try { entry.value = iconPng(image, 96, 96, 0, 0, 96, 96); } catch {} };
      image.src = 'data:image/svg+xml;base64,' + btoa(Array.from(new TextEncoder().encode(xml), byte => String.fromCharCode(byte)).join(''));
      return entry.value;
    };
    const iconFromBackground = element => {
      const style = getComputedStyle(element);
      const match = (style.backgroundImage || '').match(/^url\\(["']?([^"')]+)["']?\\)$/);
      if (!match) return '';
      const source = iconAsset(match[1]), rect = element.getBoundingClientRect();
      if (!source || rect.width <= 0 || rect.height <= 0 || rect.width > 160 || rect.height > 160) return '';
      const key = ['background',source,rect.width,rect.height,style.backgroundSize,style.backgroundPositionX,style.backgroundPositionY,style.filter].join('|');
      if (state.iconCache.has(key)) return state.iconCache.get(key).value;
      const entry = iconRemember(key, { value: '' }), image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        try {
          let width = image.naturalWidth, height = image.naturalHeight;
          const size = style.backgroundSize;
          if (size === 'contain' || size === 'cover') {
            const scale = (size === 'cover' ? Math.max : Math.min)(rect.width / width, rect.height / height);
            width *= scale; height *= scale;
          } else if (size && size !== 'auto' && size !== 'auto auto') {
            const parts = size.split(/\\s+/);
            const dimension = (value, area) => value.endsWith('%') ? area * parseFloat(value) / 100 : parseFloat(value);
            if (parts[0] !== 'auto') { width = dimension(parts[0], rect.width); height = image.naturalHeight * width / image.naturalWidth; }
            if (parts[1] && parts[1] !== 'auto') { height = dimension(parts[1], rect.height); if (parts[0] === 'auto') width = image.naturalWidth * height / image.naturalHeight; }
          }
          entry.value = iconPng(image, rect.width, rect.height, iconPosition(style.backgroundPositionX, rect.width - width),
            iconPosition(style.backgroundPositionY, rect.height - height), width, height, style.filter, style.opacity);
        } catch {}
      };
      image.src = source;
      return entry.value;
    };
    const captureNavigationIcon = anchor => {
      try {
        const visible = element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          return rect.width >= 12 && rect.height >= 12 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
        };
        const images = typeof anchor.querySelectorAll === 'function' ? Array.from(anchor.querySelectorAll('img')).slice(0, 8) : [];
        for (const image of images) {
          if (visible(image)) { const icon = iconFromImage(image, anchor); if (icon) return icon; }
        }
        const svg = anchor.querySelector('svg');
        if (svg && visible(svg)) return iconFromSvg(svg);
        for (const element of [anchor, ...(typeof anchor.querySelectorAll === 'function' ? Array.from(anchor.querySelectorAll('*')).slice(0, 24) : [])]) {
          const icon = iconFromBackground(element);
          if (icon) return icon;
        }
      } catch {}
      return '';
    };

  `;
}
