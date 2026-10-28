import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const services = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'entry', 'src', 'main', 'ets', 'services');
const urls = new Map();

// Execute the actual policy sources. Only the platform URL parser is replaced by Node's URL.
// Passing these tests does not establish equivalence of the two platform parsers or compile ArkUI.
export async function loadService(name) {
  if (!urls.has(name)) {
    let source = stripTypeScriptTypes(readFileSync(resolve(services, `${name}.ets`), 'utf8'));
    source = source.replace("import { url } from '@kit.ArkTS';",
      'const url = { URL: { parseURL: value => new globalThis.URL(value) } };');
    source = source.replace("import { util } from '@kit.ArkTS';", 'const { util } = globalThis.__duoAccountPlatform;');
    source = source.replace("import { webview } from '@kit.ArkWeb';", 'const { webview } = globalThis.__duoAccountPlatform;');
    source = source.replace("import { http } from '@kit.NetworkKit';", 'const { http } = globalThis.__duoAccountPlatform;');
    for (const match of [...source.matchAll(/from '\.\/([A-Za-z]+)'/g)]) {
      await loadService(match[1]);
      source = source.replace(match[0], `from '${urls.get(match[1])}'`);
    }
    urls.set(name, `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  }
  return import(urls.get(name));
}
