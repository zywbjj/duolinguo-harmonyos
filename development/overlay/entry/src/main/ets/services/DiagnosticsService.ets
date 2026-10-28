import { safeOrigin } from './NavigationPolicy';

export type DiagnosticEvent = 'page_begin' | 'page_end' | 'load_error' | 'http_error' |
  'render_exit' | 'cookie_saved' | 'cookie_error' | 'permission_granted' |
  'permission_denied' | 'controller_error' | 'external_link' | 'blocked_link' |
  'background' | 'foreground' | 'window_open' | 'window_close' | 'audio_error';

export class DiagnosticsService {
  private static entries: string[] = [];

  static record(event: DiagnosticEvent, address: string = '', code: number = 0): void {
    // Retain an origin and numeric code only. Never record paths, queries, fragments or exceptions.
    const line = `${new Date().toISOString()} ${event} ${safeOrigin(address)} ${code}`;
    DiagnosticsService.entries.push(line);
    if (DiagnosticsService.entries.length > 40) {
      DiagnosticsService.entries.shift();
    }
  }

  static snapshot(): string {
    return 'Duolinguo 0.7.0 / 1.0.5；麦克风及网页语音识别待真机验证。\n' +
      DiagnosticsService.entries.join('\n');
  }
}
