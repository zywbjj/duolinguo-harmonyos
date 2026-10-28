// Geometry-only adaptation for a floating native footer. No text, form values,
// account state, purchase actions or storage are inspected.
export function webContentInsetScript(): string {
  return `
    if (!state.insets) state.insets = { styles: new Map(), pads: new Map(), fixed: new Map(), page: '' };
    const insets = state.insets;
    const owns = (parent, child) => parent === child || (typeof parent?.contains === 'function' && parent.contains(child));
    const writeInsetStyle = (element, property, value) => {
      let props = insets.styles.get(element);
      if (!props) { props = new Map(); insets.styles.set(element, props); }
      let entry = props.get(property);
      const currentValue = element.style.getPropertyValue(property), currentPriority = element.style.getPropertyPriority(property);
      if (!entry || (entry.last !== currentValue || currentPriority !== 'important')) {
        entry = { value: currentValue, priority: currentPriority, last: value }; props.set(property, entry);
      }
      entry.last = value;
      if (currentValue !== value || currentPriority !== 'important') element.style.setProperty(property, value, 'important');
    };
    const restoreInsetElement = element => {
      const props = insets.styles.get(element);
      props?.forEach((entry, property) => {
        if (element.style.getPropertyValue(property) !== entry.last || element.style.getPropertyPriority(property) !== 'important') return;
        if (entry.value) element.style.setProperty(property, entry.value, entry.priority);
        else element.style.removeProperty(property);
      });
      insets.styles.delete(element); insets.pads.delete(element); insets.fixed.delete(element);
    };
    const restoreContentInsets = () => {
      for (const element of [...insets.styles.keys()]) restoreInsetElement(element);
      insets.page = '';
    };
    const navigationCovered = (root, links) => {
      if (typeof document.elementFromPoint !== 'function' || !root?.contains) return false;
      const original = root.style.getPropertyValue('pointer-events'), priority = root.style.getPropertyPriority('pointer-events');
      const owned = state.hidden.has(root);
      let hits = 0, visible = 0;
      try {
        // Opacity stays zero throughout. Hit testing must see our original menu
        // beneath any DOM modal without exposing it for even one painted frame.
        if (owned) root.style.setProperty('pointer-events', 'auto', 'important');
        for (const index of [0, Math.floor(links.length / 2), links.length - 1]) {
          const rect = links[index]?.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;
          const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
          const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
          const hit = document.elementFromPoint(x, y);
          if (hit) { hits++; if (owns(root, hit)) visible++; }
        }
      } finally {
        if (owned) {
          if (original) root.style.setProperty('pointer-events', original, priority);
          else root.style.removeProperty('pointer-events');
        }
      }
      return hits >= 2 && visible === 0;
    };
    const applyContentInsets = root => {
      if (!(state.nativeDockHeight > 0)) return;
      if (insets.page !== location.pathname) { restoreContentInsets(); insets.page = location.pathname; }
      const scale = state.nativeWebHeight > 0 ? innerHeight / state.nativeWebHeight : 1;
      const reserve = Math.min(260, Math.ceil(state.nativeDockHeight * scale + 8));
      const controls = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],a[href]')).slice(0, 120);
      const candidates = new Set([document.scrollingElement]);
      for (const control of controls) {
        if (owns(root, control)) continue;
        const rect = control.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > innerHeight) continue;
        for (let parent = control.parentElement, n = 0; parent && n < 8; parent = parent.parentElement, n++) candidates.add(parent);
      }
      const active = new Set();
      const padNeeds = new Map();
      for (const element of candidates) {
        if (!element || !element.isConnected || owns(root, element)) continue;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        const documentHost = element === document.scrollingElement;
        if (style.display === 'none' || style.visibility === 'hidden' ||
          rect.width < innerWidth * 0.6 || (!documentHost && rect.height < 100)) continue;
        if (!(documentHost ? !['hidden','clip'].includes(style.overflowY) : ['auto','scroll'].includes(style.overflowY))) continue;
        if (!documentHost && ['fixed','sticky'].includes(style.position) && rect.height <= 300) continue;
        let needed = Math.max(0, Math.min(reserve, Math.min(innerHeight, rect.bottom) - (innerHeight - reserve)));
        const rootStyle = getComputedStyle(root);
        // A normal-flow original menu already provides its own trailing space.
        if (owns(element, root) && !['fixed','absolute'].includes(rootStyle.position)) needed = Math.max(0, needed - root.getBoundingClientRect().height);
        if (needed <= 0) continue;
        if (!insets.pads.has(element)) insets.pads.set(element, {padding:parseFloat(style.paddingBottom)||0,scroll:parseFloat(style.scrollPaddingBottom)||0});
        padNeeds.set(element,needed);
        writeInsetStyle(element, 'box-sizing', 'border-box');
        if (needed >= (parseFloat(style.paddingBottom)||0)) writeInsetStyle(element, 'padding-bottom', Math.max(insets.pads.get(element).padding, needed) + 'px');
        if (needed >= (parseFloat(style.scrollPaddingBottom)||0)) writeInsetStyle(element, 'scroll-padding-bottom', Math.max(insets.pads.get(element).scroll,needed) + 'px');
        active.add(element);
      }
      const footers = new Set(insets.fixed.keys());
      let contentReserve = reserve;
      for (const control of controls) {
        if (owns(root, control)) continue;
        const rect = control.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.top >= innerHeight || rect.bottom < innerHeight - reserve) continue;
        for (let parent = control, n = 0; parent && n < 7; parent = parent.parentElement, n++) {
          if (owns(parent, root)) break;
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (['fixed','sticky'].includes(style.position) && style.bottom !== 'auto' &&
            bounds.height > 0 && bounds.height <= Math.min(300, innerHeight * 0.4)) { footers.add(parent); break; }
        }
      }
      for (const footer of footers) {
        if (!footer.isConnected || owns(footer, root)) continue;
        const style = getComputedStyle(footer), bounds = footer.getBoundingClientRect();
        if (!['fixed','sticky'].includes(style.position) || style.bottom === 'auto' || style.display === 'none' || style.visibility === 'hidden') continue;
        let entry = insets.fixed.get(footer);
        if (!entry) { entry = { base: parseFloat(style.bottom) || 0, shift: 0 }; insets.fixed.set(footer, entry); }
        const ownedBottom = insets.styles.get(footer)?.get('bottom');
        if (ownedBottom && footer.style.getPropertyValue('bottom') !== ownedBottom.last) { entry.base = parseFloat(style.bottom)||0; entry.shift=0; }
        const shift = Math.max(0, Math.min(reserve, bounds.bottom + entry.shift - (innerHeight - reserve)));
        if (shift === 0) {
          restoreInsetElement(footer);
          const originalBounds = footer.getBoundingClientRect();
          if (style.position === 'fixed' && originalBounds.width >= innerWidth * 0.65)
            contentReserve = Math.max(contentReserve, innerHeight - originalBounds.top + 8);
          continue;
        }
        entry.shift = shift;
        if (shift > 0) writeInsetStyle(footer, 'bottom', (entry.base + shift) + 'px');
        const finalBounds = footer.getBoundingClientRect();
        if (style.position === 'fixed' && finalBounds.width >= innerWidth * 0.65)
          contentReserve = Math.max(contentReserve, innerHeight - finalBounds.top + 8);
        active.add(footer);
      }
      // Moving a fixed action panel also moves the boundary for scrolling body
      // content. Its last control must clear that panel as well as the native bar.
      for (const element of active) {
        const original = insets.pads.get(element);
        if (!original) continue;
        const rect = element.getBoundingClientRect();
        let needed = contentReserve > reserve ? Math.max(0, Math.min(contentReserve, Math.min(innerHeight,rect.bottom) - (innerHeight-contentReserve))) : padNeeds.get(element);
        if (contentReserve > reserve && owns(element,root) && !['fixed','absolute'].includes(getComputedStyle(root).position))
          needed = Math.max(0,needed-root.getBoundingClientRect().height);
        writeInsetStyle(element,'padding-bottom',Math.max(original.padding,needed)+'px');
        writeInsetStyle(element,'scroll-padding-bottom',Math.max(original.scroll,needed)+'px');
      }
      for (const element of [...insets.styles.keys()]) if (!active.has(element)) restoreInsetElement(element);
    };
  `;
}
