import { url } from '@kit.ArkTS';
import { isLearningOrigin } from './NavigationPolicy';

const PREFIX: string = '/__duolinguo_voice_v1__/';

export function voiceAssetPath(address: string): string {
  if (!isLearningOrigin(address)) { return ''; }
  try {
    const parsed = url.URL.parseURL(address);
    if (!parsed.pathname.startsWith(PREFIX)) { return ''; }
    if (parsed.search !== '' || parsed.hash !== '') { return 'invalid'; }
    const path = parsed.pathname.substring(PREFIX.length);
    return path === 'vosk-0.0.8.js' || path === 'en-us-0.15.tar.gz' ? path : 'invalid';
  } catch { return ''; }
}

export class OfflineVoiceResources {
  static response(address: string, method: string): WebResourceResponse | undefined {
    const path = voiceAssetPath(address);
    if (path === '') { return undefined; }
    const response = new WebResourceResponse();
    response.setResponseEncoding('utf-8');
    if (method !== 'GET' || path === 'invalid') {
      response.setResponseCode(404); response.setReasonMessage('Not Found');
      response.setResponseMimeType('text/plain'); response.setResponseData('');
    } else {
      response.setResponseCode(200); response.setReasonMessage('OK');
      response.setResponseMimeType(path.endsWith('.js') ? 'text/javascript' : 'application/gzip');
      response.setResponseHeader([{ headerKey: 'Cache-Control', headerValue: 'private, max-age=31536000, immutable' }]);
      if (path === 'vosk-0.0.8.js') { response.setResponseData($rawfile('voice/vosk-0.0.8.js')); }
      else { response.setResponseData($rawfile('voice/en-us-0.15.tar.gz')); }
    }
    return response;
  }
}
