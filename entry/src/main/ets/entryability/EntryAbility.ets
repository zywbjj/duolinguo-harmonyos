import { UIAbility, ConfigurationConstant, Configuration } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { DiagnosticsService } from '../services/DiagnosticsService';
import { SessionLifecycle } from '../services/SessionLifecycle';
import { AppearanceService, ThemeColors } from '../services/AppearanceService';

export default class EntryAbility extends UIAbility {
  private mainWindow: window.Window | undefined;
  private fullScreen: boolean = false;
  private uiReady: boolean = false;
  private onAvoidArea: (options: window.AvoidAreaOptions) => void = () => this.updateInsets();
  private onKeyboard: (height: number) => void = (height: number) => {
    AppStorage.setOrCreate('duoKeyboardVisible', height > 0);
  };

  onCreate(): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch { DiagnosticsService.record('controller_error'); }
    AppearanceService.initialize(this.context.config.colorMode);
    AppStorage.setOrCreate('duoForeground', true);
    AppStorage.setOrCreate('duoKeyboardVisible', false);
    for (const key of ['duoSafeTop', 'duoSafeBottom', 'duoSafeLeft', 'duoSafeRight']) {
      AppStorage.setOrCreate(key, 0);
    }
    webview.WebCookieManager.putAcceptCookieEnabled(true);
    try {
      // USB DevTools is available only for a debuggable app, never for release builds.
      webview.WebviewController.setWebDebuggingAccess(this.context.applicationInfo.debug);
    } catch { DiagnosticsService.record('controller_error'); }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.configureWindow(windowStage);
  }

  private applyImmersiveWindow(): void {
    if (!this.mainWindow) { return; }
    try {
      const colors = new ThemeColors(AppearanceService.isDark());
      this.mainWindow.setWindowSystemBarProperties({
        statusBarColor: '#00000000', navigationBarColor: '#00000000',
        statusBarContentColor: colors.systemContent, navigationBarContentColor: colors.systemContent
      }).catch(() => { DiagnosticsService.record('controller_error'); });
    } catch { DiagnosticsService.record('controller_error'); }
  }

  private updateInsets(): void {
    if (!this.mainWindow || !this.fullScreen || !this.uiReady) { return; }
    const main = this.mainWindow;
    try {
      const system = main.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const cutout = main.getWindowAvoidArea(window.AvoidAreaType.TYPE_CUTOUT);
      const gesture = main.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      const context = main.getUIContext();
      AppStorage.setOrCreate('duoSafeTop', context.px2vp(Math.max(system.topRect.height, cutout.topRect.height)));
      AppStorage.setOrCreate('duoSafeBottom', context.px2vp(Math.max(system.bottomRect.height, gesture.bottomRect.height)));
      AppStorage.setOrCreate('duoSafeLeft', context.px2vp(Math.max(system.leftRect.width, cutout.leftRect.width, gesture.leftRect.width)));
      AppStorage.setOrCreate('duoSafeRight', context.px2vp(Math.max(system.rightRect.width, cutout.rightRect.width, gesture.rightRect.width)));
    } catch {
      // If avoidance metrics are unavailable, return to system-managed safe-area layout.
      this.fullScreen = false;
      for (const key of ['duoSafeTop', 'duoSafeBottom', 'duoSafeLeft', 'duoSafeRight']) { AppStorage.setOrCreate(key, 0); }
      main.setWindowLayoutFullScreen(false).catch(() => {});
      DiagnosticsService.record('controller_error');
    }
  }

  private async configureWindow(windowStage: window.WindowStage): Promise<void> {
    try {
      const main = windowStage.getMainWindowSync();
      this.mainWindow = main;
      AppearanceService.bind(() => this.applyImmersiveWindow());
      this.uiReady = false;
      try {
        await main.setWindowLayoutFullScreen(true);
        if (this.mainWindow !== main) { return; }
        this.fullScreen = true;
      } catch { this.fullScreen = false; DiagnosticsService.record('controller_error'); }
      if (this.mainWindow !== main) { return; }
      this.applyImmersiveWindow();
      windowStage.loadContent('pages/Index', (error) => {
        if (this.mainWindow !== main) { return; }
        if (error.code) { DiagnosticsService.record('controller_error', '', error.code); return; }
        // UIContext belongs to the loaded UI content. Do not request it before this callback.
        this.uiReady = true;
        this.updateInsets();
        try { main.on('avoidAreaChange', this.onAvoidArea); } catch { DiagnosticsService.record('controller_error'); }
        try { main.on('keyboardHeightChange', this.onKeyboard); } catch {}
      });
    } catch { DiagnosticsService.record('controller_error'); }
  }

  onWindowStageDestroy(): void {
    AppearanceService.unbind();
    if (this.mainWindow) {
      try { this.mainWindow.off('avoidAreaChange', this.onAvoidArea); } catch {}
      try { this.mainWindow.off('keyboardHeightChange', this.onKeyboard); } catch {}
    }
    this.mainWindow = undefined;
    this.fullScreen = false;
    this.uiReady = false;
    for (const key of ['duoSafeTop', 'duoSafeBottom', 'duoSafeLeft', 'duoSafeRight']) { AppStorage.setOrCreate(key, 0); }
    AppStorage.setOrCreate('duoKeyboardVisible', false);
  }

  onForeground(): void {
    AppearanceService.setSystemMode(this.context.config.colorMode);
    this.applyImmersiveWindow();
    this.updateInsets();
    AppStorage.setOrCreate('duoForeground', true);
    DiagnosticsService.record('foreground');
  }

  onBackground(): void {
    AppStorage.setOrCreate('duoForeground', false);
    DiagnosticsService.record('background');
    SessionLifecycle.saveCookies();
  }

  onConfigurationUpdate(config: Configuration): void {
    AppearanceService.setSystemMode(config.colorMode);
    this.applyImmersiveWindow();
  }

  onDestroy(): void {
    this.onWindowStageDestroy();
    AppStorage.setOrCreate('duoForeground', false);
    SessionLifecycle.saveCookies();
  }
}
