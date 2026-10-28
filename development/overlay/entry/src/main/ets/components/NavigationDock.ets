import { HdsTabs, HdsTabsController, DividerMode, hdsMaterial } from '@kit.UIDesignKit';
import { NavigationItem } from '../services/WebNavigation';
import { ThemeColors } from '../services/AppearanceService';

const NAV_BAR_HEIGHT: number = 54;

@Component
export struct NavigationDock {
  @Prop items: NavigationItem[] = [];
  @Prop selected: number = 0;
  @Prop interactive: boolean = true;
  @Prop bottomInset: number = 0;
  @StorageProp('duoDark') dark: boolean = false;
  onReady: () => void = () => {};
  onSelect: (index: number) => void = () => {};
  @State private immersive: boolean = false;
  private controller: HdsTabsController = new HdsTabsController();

  aboutToAppear(): void {
    try {
      this.immersive = hdsMaterial.getSystemMaterialTypes().includes(hdsMaterial.MaterialType.IMMERSIVE);
    } catch { this.immersive = false; }
  }

  private icon(kind: string): Resource {
    if (kind === 'learn') { return this.dark ? $r('app.media.nav_learn_dark') : $r('app.media.nav_learn'); }
    if (kind === 'sounds') { return this.dark ? $r('app.media.nav_sounds_dark') : $r('app.media.nav_sounds'); }
    if (kind === 'practice') { return this.dark ? $r('app.media.nav_practice_dark') : $r('app.media.nav_practice'); }
    if (kind === 'quests') { return this.dark ? $r('app.media.nav_quests_dark') : $r('app.media.nav_quests'); }
    if (kind === 'shop') { return this.dark ? $r('app.media.nav_shop_dark') : $r('app.media.nav_shop'); }
    if (kind === 'profile') { return this.dark ? $r('app.media.nav_profile_dark') : $r('app.media.nav_profile'); }
    return this.dark ? $r('app.media.nav_more_dark') : $r('app.media.nav_more');
  }

  @Builder
  private tab(index: number) {
    // Keep the 54vp tap target; move only the icon/label drawing up by 2vp.
    Column({ space: 1 }) {
      if (this.items[index].image !== '') {
        Image(this.items[index].image).width(26).height(26).objectFit(ImageFit.Contain)
          .alt(this.icon(this.items[index].kind)).syncLoad(this.items[index].image.startsWith('data:'))
          .translate({ y: -2 })
      } else {
        Image(this.icon(this.items[index].kind)).width(26).height(26)
          .fillColor(this.selected === index ? new ThemeColors(this.dark).accent : new ThemeColors(this.dark).navText)
          .translate({ y: -2 })
      }
      Text(this.items[index].label).fontSize(10).lineHeight(14).maxLines(1)
        .fontWeight(this.selected === index ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.selected === index ? new ThemeColors(this.dark).accent : new ThemeColors(this.dark).navText)
        .translate({ y: -2 })
    }.width('100%').height(NAV_BAR_HEIGHT).justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
      .accessibilityText(this.items[index].label).accessibilitySelected(this.selected === index)
  }

  build() {
    WithTheme({ colorMode: this.dark ? ThemeColorMode.DARK : ThemeColorMode.LIGHT }) {
    HdsTabs({ index: this.selected, controller: this.controller }) {
      ForEach(this.items, (item: NavigationItem, index: number) => {
        TabContent() {}.tabBar(this.tab(index))
      }, (item: NavigationItem, index: number) => item.path + ':' + index.toString())
    }
    .barPosition(BarPosition.End).barMode(BarMode.Fixed)
    .barHeight(NAV_BAR_HEIGHT).barOverlap(true).scrollable(false).animationDuration(0)
    .divider({ mode: DividerMode.NONE })
    .barFloatingStyle({
      barSideMargin: 12,
      barBottomMargin: this.bottomInset + 4,
      lightColor: new ThemeColors(this.dark).accent,
      gradientMask: { maskColor: Color.Transparent },
      systemMaterialEffect: {
        materialType: this.immersive ? hdsMaterial.MaterialType.IMMERSIVE : hdsMaterial.MaterialType.ADAPTIVE,
        materialLevel: hdsMaterial.MaterialLevel.ADAPTIVE
      },
      thermoCtrl: true
    })
    .width('100%').height(62 + this.bottomInset).backgroundColor(Color.Transparent)
    .onChange((index: number) => {
      if (index !== this.selected && index >= 0 && index < this.items.length) {
        if (this.interactive) { this.onSelect(index); }
        // Selection follows the observed page rather than an optimistic tab flip.
        this.controller.changeIndex(this.selected);
      }
    })
    .onAreaChange((_oldValue, area) => { if (Number(area.width) > 0) { this.onReady(); } })
    }
  }
}
