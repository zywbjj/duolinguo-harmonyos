import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { LEARN_URL, navigationAction, safeOrigin, isLearningOrigin } from '../services/NavigationPolicy';
import { PermissionGate } from '../services/PermissionGate';
import { WebPermissionService } from '../services/WebPermissionService';
import { DiagnosticsService } from '../services/DiagnosticsService';
import { SessionLifecycle } from '../services/SessionLifecycle';
import { webAudioScript, audioStatusScript, parseAudioStatus } from '../services/WebAudioScript';
import { OfflineVoiceResources } from '../services/OfflineVoiceResources';
import { AppearanceService, ThemeColors, themeStatusScript, parsePageChromeStatus } from '../services/AppearanceService';
import { NavigationDock } from './NavigationDock';
import { NavigationReport, navigationScript, parseNavigationReport, carryNavigation } from '../services/WebNavigation';

export class BrowserTab {
  private static sequence: number = 0;
  id: number;
  controller: webview.WebviewController = new webview.WebviewController();
  handler: ControllerHandler | undefined;
  attached: boolean = false;

  constructor(handler?: ControllerHandler) {
    this.id = BrowserTab.sequence++;
    this.handler = handler;
  }
}

@Component
export struct BrowserPane {
  tab: BrowserTab = new BrowserTab();
  @Prop @Watch('onActivityChanged') active: boolean = true;
  @StorageProp('duoForeground') @Watch('onActivityChanged') foreground: boolean = true;
  @StorageProp('duoKeyboardVisible') @Watch('onActivityChanged') keyboardVisible: boolean = false;
  @StorageProp('duoSafeBottom') safeBottom: number = 0;
  @StorageProp('duoDark') dark: boolean = false;
  onPopup: (tab: BrowserTab) => void = () => {};
  onClose: () => void = () => {};
  @State private progress: number = 0;
  @State private loading: boolean = true;
  @State private showProgress: boolean = true;
  @State private failure: string = '';
  @State private notice: string = '';
  @State private audioNotice: string = '';
  @State private navigation: NavigationReport = new NavigationReport();
  private navigationCache: NavigationReport = new NavigationReport();
  private navigationTimer: number = -1;
  private navigationPeriod: number = 0;
  private navigationWarmUntil: number = 0;
  private navigationEpoch: number = 0;
  private navigationBusy: boolean = false;
  private navigationRefreshQueued: boolean = false;
  private navigationPaused: boolean = false;
  private dockReady: boolean = false;
  private mounted: boolean = false;
  private permissionGate: PermissionGate = new PermissionGate();
  private externalDialog: boolean = false;
  private pageAddress: string = '';
  private audioSequence: number = -1;
  private themeTimer: number = -1;
  private themeEpoch: number = 0;
  private themeBusy: boolean = false;
  private pageOccluded: boolean = false;
  private webHeight: number = 0;

  private beginLoading(address: string): void {
    this.stopThemePolling();
    if (!this.tab.handler) { AppearanceService.resetPage(); }
    this.pageAddress = address;
    this.loading = true;
    this.showProgress = true;
    this.progress = 0;
    this.failure = '';
    this.notice = '';
    this.audioNotice = '';
    this.audioSequence = -1;
    this.navigationCache = new NavigationReport();
    this.pageOccluded = false;
  }

  private pageVisible(address: string): void {
    // Visibility is independent of slow images/analytics delaying the final load event.
    try {
      if (address === this.pageAddress && this.tab.attached && this.tab.controller.getUrl() === address) {
        this.showProgress = false;
      }
    } catch { DiagnosticsService.record('controller_error'); }
  }

  private updateProgress(value: number): void {
    this.progress = Math.max(0, Math.min(100, value));
    if (this.progress >= 100) { this.showProgress = false; }
  }

  private finishLoading(): void {
    this.loading = false;
    this.showProgress = false;
  }

  aboutToAppear(): void {
    this.mounted = true;
  }

  aboutToDisappear(): void {
    this.stopThemePolling();
    this.stopNavigation();
    this.mounted = false;
    this.permissionGate.invalidate();
    if (this.tab.attached) {
      SessionLifecycle.setActive(this.tab.controller, false);
    }
    this.tab.attached = false;
    SessionLifecycle.saveCookies();
  }

  private onActivityChanged(): void {
    if (!this.active || !this.foreground) {
      // Queue preservation before onInactive can suspend the Web renderer.
      if (this.mounted && this.tab.attached && !this.tab.handler) { this.pauseNavigation(); }
      this.permissionGate.invalidate();
      SessionLifecycle.saveCookies();
    }
    if (this.tab.attached) {
      SessionLifecycle.setActive(this.tab.controller, this.active && this.foreground);
    }
    if (this.mounted && this.active && this.foreground && !this.keyboardVisible &&
      this.tab.attached && !this.tab.handler) {
      const stopped = this.navigationTimer < 0;
      if (this.navigationPaused) { this.resumeNavigation(); }
      this.scheduleNavigation();
      if (stopped) { this.probeNavigation(this.navigationEpoch); }
    } else if (this.mounted && this.tab.attached && !this.tab.handler && (!this.active || !this.foreground)) {
      this.pauseNavigation();
    } else { this.stopNavigation(); }
    if (this.mounted && this.active && this.foreground && this.tab.attached && !this.tab.handler) {
      this.startThemePolling();
    } else { this.stopThemePolling(); }
  }

  private startThemePolling(): void {
    if (this.themeTimer >= 0) { return; }
    const epoch = this.themeEpoch;
    // Read one fixed DOM enum; no page scan, account storage or console bridge.
    this.themeTimer = setInterval(() => this.probeTheme(epoch), 200);
    this.probeTheme(epoch);
  }

  private stopThemePolling(): void {
    this.themeEpoch++;
    if (this.themeTimer >= 0) { clearInterval(this.themeTimer); this.themeTimer = -1; }
    this.themeBusy = false;
  }

  private async probeTheme(epoch: number): Promise<void> {
    if (epoch !== this.themeEpoch || this.themeBusy || !this.mounted || !this.active ||
      !this.foreground || !this.tab.attached || this.tab.handler) { return; }
    this.themeBusy = true;
    try {
      const address = this.tab.controller.getUrl();
      if (!isLearningOrigin(address)) { return; }
      const raw = await this.tab.controller.runJavaScript(themeStatusScript());
      if (epoch !== this.themeEpoch || !this.isCurrent(address) || this.tab.controller.getUrl() !== address) { return; }
      const chrome = parsePageChromeStatus(raw);
      AppearanceService.setPageTheme(chrome.theme);
      if (chrome.available && chrome.occluded !== this.pageOccluded) {
        this.pageOccluded = chrome.occluded;
        this.probeNavigation(this.navigationEpoch);
      }
    } catch {} finally { if (epoch === this.themeEpoch) { this.themeBusy = false; } }
  }

  private scheduleNavigation(): void {
    if (this.navigationWarmUntil === 0) { this.navigationWarmUntil = Date.now() + 6000; }
    const period = (this.navigation.items.length === 0 || this.navigation.pending) &&
      Date.now() < this.navigationWarmUntil ? 150 : 900;
    if (this.navigationTimer >= 0 && this.navigationPeriod === period) { return; }
    if (this.navigationTimer >= 0) { clearInterval(this.navigationTimer); }
    const epoch = this.navigationEpoch;
    this.navigationPeriod = period;
    this.navigationTimer = setInterval(() => this.probeNavigation(epoch), period);
  }

  private stopNavigation(restore: boolean = true): void {
    this.navigationPaused = false;
    this.navigationEpoch++;
    if (this.navigationTimer >= 0) { clearInterval(this.navigationTimer); this.navigationTimer = -1; }
    this.navigationPeriod = 0;
    this.navigationWarmUntil = 0;
    this.navigationBusy = false;
    this.navigationRefreshQueued = false;
    this.dockReady = false;
    this.navigation = new NavigationReport();
    if (restore && this.tab.attached) {
      try {
        if (isLearningOrigin(this.tab.controller.getUrl())) {
          this.tab.controller.runJavaScript(navigationScript('detach')).catch(() => {});
        }
      } catch {}
    }
  }

  private pauseNavigation(): void {
    if (this.navigationPaused) { return; }
    this.navigationPaused = true;
    this.navigationEpoch++;
    if (this.navigationTimer >= 0) { clearInterval(this.navigationTimer); this.navigationTimer = -1; }
    this.navigationPeriod = 0;
    this.navigationBusy = false;
    this.navigationRefreshQueued = false;
    // Keep the acknowledged native component and web hiding in this document.
    // Microphone/media are still stopped independently by SessionLifecycle.
    try {
      if (isLearningOrigin(this.tab.controller.getUrl())) {
        this.tab.controller.runJavaScript(navigationScript('pause')).catch(() => {});
      }
    } catch {}
  }

  private resumeNavigation(): void {
    this.navigationPaused = false;
    try {
      const retained = this.navigation;
      const carried = carryNavigation(retained.attached ? retained : this.navigationCache,
        this.tab.controller.getUrl(), true);
      // A retained, laid-out bar can appear on the first foreground frame.
      carried.attached = retained.attached && this.dockReady && carried.items.length > 0;
      this.navigation = carried;
      if (carried.items.length === 0) { this.dockReady = false; }
    } catch { this.navigation = new NavigationReport(); this.dockReady = false; }
    this.navigationWarmUntil = Date.now() + 1500;
  }

  private async probeNavigation(epoch: number, command: string = 'scan', selection: number = -1,
    expectedPath: string = ''): Promise<void> {
    if (epoch !== this.navigationEpoch || !this.mounted || !this.active ||
      !this.foreground || this.keyboardVisible || !this.tab.attached) { return; }
    if (this.navigationBusy) {
      if (command === 'scan') { this.navigationRefreshQueued = true; }
      return;
    }
    this.navigationBusy = true;
    let documentUnavailable: boolean = false;
    if (command === 'scan') { this.navigationRefreshQueued = false; }
    try {
      const address = this.tab.controller.getUrl();
      if (!isLearningOrigin(address)) {
        if (this.loading && (address === '' || address === 'about:blank')) { return; }
        this.stopNavigation(false); return;
      }
      if (command === 'scan') {
        const audio = await this.tab.controller.runJavaScript(audioStatusScript());
        if (epoch !== this.navigationEpoch || !this.isCurrent(address)) { return; }
        this.audioMessage(audio);
      }
      const raw = await this.tab.controller.runJavaScript(
        navigationScript(command, selection, this.navigation.page, expectedPath, 62 + this.safeBottom, this.webHeight));
      if (epoch !== this.navigationEpoch || !this.isCurrent(address) || this.keyboardVisible) { return; }
      if (this.tab.controller.getUrl() !== address) { this.navigationRefreshQueued = true; return; }
      const report = parseNavigationReport(raw, address);
      if (report.items.length === 0) { this.dockReady = false; }
      if (report.attached && !report.pending) { this.navigationCache = report; }
      if (JSON.stringify(report) !== JSON.stringify(this.navigation)) { this.navigation = report; }
    } catch {
      if (epoch === this.navigationEpoch) {
        if (this.loading) { documentUnavailable = true; } else { this.stopNavigation(); }
      }
    } finally {
      if (epoch === this.navigationEpoch) {
        this.navigationBusy = false;
        if (this.navigationTimer >= 0) { this.scheduleNavigation(); }
        if (!documentUnavailable && this.navigationRefreshQueued) {
          this.navigationRefreshQueued = false;
          this.probeNavigation(epoch);
        } else if (!documentUnavailable && this.dockReady && this.navigation.items.length > 0 &&
          !this.navigation.attached && !this.navigation.pending) {
          this.probeNavigation(epoch, 'attach');
        }
      }
    }
  }

  private navigationReady(): void {
    this.dockReady = true;
    if (!this.navigation.attached) {
      this.probeNavigation(this.navigationEpoch, this.navigation.pending ? 'scan' : 'attach');
    }
  }

  private navigationCommitted(address: string): void {
    if (!isLearningOrigin(address)) {
      this.navigationCache = new NavigationReport(); this.stopNavigation(); return;
    }
    const hadDock = this.navigation.items.length > 0;
    const carried = carryNavigation(this.navigation.attached ? this.navigation : this.navigationCache, address, true);
    // Reuse only this document's acknowledged menu. A remounted dock must confirm
    // its layout and the current DOM before it can accept a tap.
    if (carried.items.length > 0 && !hadDock) { carried.attached = false; }
    this.navigation = carried;
    if (!hadDock || carried.items.length === 0) { this.dockReady = false; }
    this.navigationWarmUntil = Date.now() + 1500;
    this.onActivityChanged();
    this.probeNavigation(this.navigationEpoch);
  }

  private selectNavigation(index: number): void {
    if (this.navigation.attached && !this.navigation.pending && index >= 0 && index < this.navigation.items.length) {
      this.probeNavigation(this.navigationEpoch, 'activate', index, this.navigation.items[index].path);
    }
  }

  private hostContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private isCurrent(origin: string): boolean {
    if (!this.mounted || !this.active || !this.foreground || !this.tab.attached) {
      return false;
    }
    try {
      return safeOrigin(this.tab.controller.getUrl()) === safeOrigin(origin);
    } catch {
      return false;
    }
  }

  private async requestMicrophone(request: PermissionRequest): Promise<void> {
    try {
      const origin = request.getOrigin();
      await this.permissionGate.request(origin, request.getAccessibleResource(),
        (allowPrompt: boolean) => WebPermissionService.requestMicrophone(this.hostContext(), allowPrompt),
        () => this.isCurrent(origin), (resources: string[]) => {
        try {
          if (resources.length > 0) {
            request.grant(resources);
            this.notice = '';
            DiagnosticsService.record('permission_granted', origin);
          } else {
            request.deny();
            DiagnosticsService.record('permission_denied', origin);
            if (this.mounted && this.active && this.foreground) {
              this.notice = '麦克风请求未获准。请在系统设置中允许麦克风，再关闭网页提示并重试。';
            }
          }
        } catch {
          DiagnosticsService.record('controller_error');
        }
      });
    } catch {
      try {
        request.deny();
      } catch {
        DiagnosticsService.record('controller_error');
      }
    }
  }

  private audioMessage(message: string): void {
    const status = parseAudioStatus(message);
    const stage = status.stage;
    if (status.sequence < 0 || status.sequence === this.audioSequence ||
      !this.mounted || !this.active || !this.foreground || !this.tab.attached) { return; }
    try {
      const address = this.tab.controller.getUrl();
      if (!isLearningOrigin(address)) { return; }
      this.audioSequence = status.sequence;
      if (stage === 'idle' || stage === 'model-ready' || stage === 'capture-starting' || stage === 'capture-started' || stage === 'capture-stopped') {
        this.audioNotice = ''; return;
      }
      if (stage === 'model-loading') { this.audioNotice = '正在准备离线语音识别，首次使用请稍等…'; return; }
      const codes: string[] = ['capture-interrupted', 'capture-denied', 'capture-error', 'model-error',
        'engine-error', 'engine-unsupported', 'engine-overloaded', 'language-unsupported', 'no-speech'];
      DiagnosticsService.record('audio_error', address, codes.indexOf(stage) + 1);
      if (stage === 'no-speech') { return; }
      if (stage === 'capture-interrupted') {
        this.audioNotice = '录音已中断，请关闭页面提示后重新开始。';
      } else if (stage === 'capture-denied') {
        this.audioNotice = '麦克风请求未获准，请检查应用权限后重试。';
      } else if (stage === 'language-unsupported') {
        this.audioNotice = '当前离线口语识别支持英语。';
      } else {
        this.audioNotice = `离线语音识别暂未就绪，请关闭页面提示后重试（V0${codes.indexOf(stage) + 1}）。`;
      }
    } catch { DiagnosticsService.record('controller_error'); }
  }

  private confirmNavigation(action: () => void): void {
    this.getUIContext().showAlertDialog({
      title: '离开当前页面？',
      message: '当前未提交的答题可能丢失。',
      primaryButton: { value: '取消', action: () => {} },
      secondaryButton: { value: '继续', action: () => {
        if (this.mounted && this.active && this.foreground && this.tab.attached) {
          this.permissionGate.invalidate();
          try {
            action();
          } catch {
            this.failure = '页面操作失败，请重试。';
          }
        }
      } }
    });
  }

  private intercept(address: string): boolean {
    if (this.tab.handler && address === 'about:blank') {
      return false;
    }
    const action = navigationAction(address);
    if (action === 'internal') {
      return false;
    }
    if (action === 'blocked') {
      this.notice = '此链接类型暂不支持，请从官方学习页面继续。';
      DiagnosticsService.record('blocked_link');
      return true;
    }
    if (!this.mounted || !this.active || !this.foreground || this.externalDialog) {
      return true;
    }
    this.externalDialog = true;
    this.getUIContext().showAlertDialog({
      title: '在浏览器中打开链接',
      message: `${safeOrigin(address)}\n浏览器与应用的登录会话可能独立。第三方登录是否能回到应用需单独验证。`,
      cancel: () => { this.externalDialog = false; },
      primaryButton: { value: '取消', action: () => { this.externalDialog = false; } },
      secondaryButton: { value: '打开', action: () => {
        this.externalDialog = false;
        if (!this.mounted || !this.active || !this.foreground) {
          return;
        }
        this.hostContext().startAbility({
          action: 'ohos.want.action.viewData',
          entities: ['entity.system.browsable'],
          uri: address
        }).catch(() => {
          this.notice = '无法打开浏览器，请稍后重试。';
        });
        DiagnosticsService.record('external_link', address);
      } }
    });
    return true;
  }

  build() {
    Column() {
      Stack() {
        Text($r('app.string.duo_ability_name')).fontSize(18).fontWeight(FontWeight.Medium)
          .fontColor(new ThemeColors(this.dark).text).width('100%').textAlign(TextAlign.Center)
        if (this.tab.handler) {
          Row() {
            Button('关闭').height(30).fontSize(13).backgroundColor(new ThemeColors(this.dark).surface)
              .fontColor(new ThemeColors(this.dark).accent)
              .onClick(() => this.confirmNavigation(this.onClose))
            Blank()
          }.width('100%').padding({ left: 16 })
        }
      }
      .height(44).width('100%')

      if (this.showProgress) {
        Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
          .width('100%').height(3).color('#58A700')
      }
      if (this.failure !== '') {
        Row({ space: 8 }) {
          Text(this.failure).fontSize(13).layoutWeight(1).fontColor(new ThemeColors(this.dark).text)
          Button('重试').backgroundColor(new ThemeColors(this.dark).surface).fontColor(new ThemeColors(this.dark).accent)
            .onClick(() => this.confirmNavigation(() => this.tab.controller.refresh()))
        }.padding(10).width('100%').backgroundColor(new ThemeColors(this.dark).warning)
      }
      if (this.notice !== '') {
        Row({ space: 8 }) {
          Text(this.notice).fontSize(12).layoutWeight(1).fontColor(new ThemeColors(this.dark).text)
          Button('收起').backgroundColor(new ThemeColors(this.dark).surface).fontColor(new ThemeColors(this.dark).accent)
            .onClick(() => { this.notice = ''; })
        }.padding(10).width('100%').backgroundColor(new ThemeColors(this.dark).notice)
      }
      if (this.audioNotice !== '') {
        Row({ space: 8 }) {
          Text(this.audioNotice).fontSize(12).layoutWeight(1).fontColor(new ThemeColors(this.dark).text)
          Button('收起').backgroundColor(new ThemeColors(this.dark).surface).fontColor(new ThemeColors(this.dark).accent)
            .onClick(() => { this.audioNotice = ''; })
        }.padding(10).width('100%').backgroundColor(new ThemeColors(this.dark).notice)
      }

      Stack({ alignContent: Alignment.Bottom }) {
        Web({ src: this.tab.handler ? '' : LEARN_URL, controller: this.tab.controller })
        .javaScriptAccess(true)
        .javaScriptOnDocumentStart([{ script: webAudioScript(), scriptRules: [
          'https://www.duolingo.com', 'https://duolingo.com', 'https://www.duolingo.cn', 'https://duolingo.cn'
        ] }])
        .domStorageAccess(true)
        .darkMode(WebDarkMode.Auto)
        .forceDarkAccess(false)
        .fileAccess(false)
        .onInterceptRequest((event) => {
          if (!event) { return null; }
          return OfflineVoiceResources.response(event.request.getRequestUrl(), event.request.getRequestMethod()) || null;
        })
        .mixedMode(MixedMode.None)
        .mediaPlayGestureAccess(true)
        .multiWindowAccess(true)
        .allowWindowOpenMethod(true)
        .width('100%').height('100%')
        .onAreaChange((_oldValue, area) => {
          const height = Number(area.height);
          if (Number.isFinite(height) && height > 0) { this.webHeight = height; }
        })
        .backgroundColor(new ThemeColors(this.dark).background)
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
        // Extend behind the gesture indicator on tab pages. Lesson controls still avoid it.
        .padding({ bottom: this.navigation.items.length > 0 && !this.keyboardVisible ? 0 : this.safeBottom })
        .onControllerAttached(() => {
          this.tab.attached = true;
          // Bind the new window to its own Web, preserving the opener document and session.
          if (this.tab.handler) {
            this.tab.handler.setWebController(this.tab.controller);
          }
          this.onActivityChanged();
        })
        .onPageBegin((event) => {
          this.stopNavigation(false);
          this.permissionGate.invalidate();
          this.beginLoading(event ? event.url : '');
          if (event) {
            DiagnosticsService.record('page_begin', event.url);
            if (!isLearningOrigin(event.url) && event.url !== 'about:blank') {
              this.tab.controller.stop();
              this.intercept(event.url);
              this.finishLoading();
            }
            if (isLearningOrigin(event.url)) { this.onActivityChanged(); }
          }
        })
        .onPageVisible((event) => {
          if (event) { this.pageVisible(event.url); }
          this.onActivityChanged();
          this.probeNavigation(this.navigationEpoch);
        })
        .onProgressChange((event) => { if (event) { this.updateProgress(event.newProgress); } })
        .onNavigationEntryCommitted((event) => {
          if (event.isMainFrame && event.isSameDocument) {
            // pushState/replaceState keeps the same document and permission request.
            this.navigationCommitted(event.url);
          }
        })
        .onPageEnd((event) => {
          this.finishLoading();
          if (event) { DiagnosticsService.record('page_end', event.url); }
          // Page end does not clear a loading error or prove login/course completion.
          SessionLifecycle.saveCookies();
          this.onActivityChanged();
        })
        .onOverrideUrlLoading((request) => {
          return request.isMainFrame() ? this.intercept(request.getRequestUrl()) : false;
        })
        .onErrorReceive((event) => {
          if (event && event.request.isMainFrame()) {
            this.finishLoading();
            this.failure = `页面加载失败（${event.error.getErrorCode()}），请检查网络后重试。`;
            DiagnosticsService.record('load_error', event.request.getRequestUrl(), event.error.getErrorCode());
          }
        })
        .onHttpErrorReceive((event) => {
          if (event && event.request.isMainFrame()) {
            this.finishLoading();
            this.failure = `网站返回 HTTP ${event.response.getResponseCode()}，可查看页面提示或稍后重试。`;
            DiagnosticsService.record('http_error', event.request.getRequestUrl(), event.response.getResponseCode());
          }
        })
        .onRenderExited(() => {
          this.stopNavigation(false);
          this.permissionGate.invalidate();
          this.finishLoading();
          this.failure = '网页进程已退出，请刷新；未提交的答题可能丢失。';
          DiagnosticsService.record('render_exit');
        })
        .onPermissionRequest((event) => { if (event) { this.requestMicrophone(event.request); } })
        .onWindowNew((event) => {
          if (event) {
            DiagnosticsService.record('window_open');
            this.onPopup(new BrowserTab(event.handler));
          }
        })
        .onWindowExit(() => { this.onClose(); })
        if (this.navigation.items.length > 0) {
          NavigationDock({ items: this.navigation.items, selected: this.navigation.selected,
            interactive: this.active && this.foreground && !this.keyboardVisible &&
              this.navigation.attached && !this.navigation.pending, bottomInset: this.safeBottom,
            onReady: () => this.navigationReady(), onSelect: (index: number) => this.selectNavigation(index) })
            .visibility(this.active && this.foreground && !this.keyboardVisible ? Visibility.Visible : Visibility.Hidden)
        }
      }.width('100%').layoutWeight(1).expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
    }.width('100%').height('100%').backgroundColor(new ThemeColors(this.dark).background)
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
