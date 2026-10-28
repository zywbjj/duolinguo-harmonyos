import { BrowserPane, BrowserTab } from '../components/BrowserPane';
import { DiagnosticsService } from '../services/DiagnosticsService';
import { SessionLifecycle } from '../services/SessionLifecycle';
import { ThemeColors } from '../services/AppearanceService';

@Entry
@Component
struct Index {
  @StorageProp('duoDark') dark: boolean = false;
  @StorageProp('duoSafeTop') safeTop: number = 0;
  @StorageProp('duoSafeLeft') safeLeft: number = 0;
  @StorageProp('duoSafeRight') safeRight: number = 0;
  @State private tabs: BrowserTab[] = [new BrowserTab()];

  private closeWindow(id: number): void {
    const index = this.tabs.findIndex((tab: BrowserTab) => tab.id === id);
    if (index > 0) {
      // Closing an opener also removes its child windows, while the root Web stays mounted.
      this.tabs = this.tabs.slice(0, index);
      DiagnosticsService.record('window_close');
      SessionLifecycle.saveCookies();
    }
  }

  onBackPress(): boolean {
    const current = this.tabs[this.tabs.length - 1];
    try {
      if (current.attached && current.controller.accessBackward()) {
        current.controller.backward();
        return true;
      }
    } catch {
      DiagnosticsService.record('controller_error');
    }
    if (this.tabs.length > 1) {
      this.closeWindow(current.id);
      return true;
    }
    return false;
  }

  build() {
    Stack() {
      ForEach(this.tabs, (tab: BrowserTab, index: number) => {
        BrowserPane({
          tab: tab,
          active: index === this.tabs.length - 1,
          onPopup: (child: BrowserTab) => { this.tabs = this.tabs.concat([child]); },
          onClose: () => this.closeWindow(tab.id)
        })
          .visibility(index === this.tabs.length - 1 ? Visibility.Visible : Visibility.Hidden)
      }, (tab: BrowserTab) => tab.id.toString())
    }.height('100%').width('100%')
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
      .padding({ top: this.safeTop, left: this.safeLeft, right: this.safeRight })
      .backgroundColor(new ThemeColors(this.dark).background)
  }
}
