import { webview } from '@kit.ArkWeb';
import { DiagnosticsService } from './DiagnosticsService';

export class SessionLifecycle {
  private static saving: boolean = false;

  static async saveCookies(): Promise<void> {
    if (SessionLifecycle.saving) {
      return;
    }
    SessionLifecycle.saving = true;
    try {
      await webview.WebCookieManager.saveCookieAsync();
      DiagnosticsService.record('cookie_saved');
    } catch {
      DiagnosticsService.record('cookie_error');
    } finally {
      SessionLifecycle.saving = false;
    }
  }

  static setActive(controller: webview.WebviewController, active: boolean): void {
    if (active) {
      SessionLifecycle.perform(() => controller.onActive());
      SessionLifecycle.perform(() => controller.setAudioMuted(false));
      // Let the user restart playback; do not resume all course audio automatically.
    } else {
      // API 23+: stop capture itself, independently of media playback and page visibility.
      SessionLifecycle.perform(() => controller.stopMicrophone());
      SessionLifecycle.perform(() => controller.pauseAllMedia());
      SessionLifecycle.perform(() => controller.setAudioMuted(true));
      SessionLifecycle.perform(() => controller.onInactive());
    }
  }

  private static perform(operation: () => void): void {
    try {
      operation();
    } catch {
      DiagnosticsService.record('controller_error');
    }
  }
}
