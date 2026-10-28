export class ThemeColors {
  background: string;
  text: string;
  navText: string;
  accent: string;
  surface: string;
  notice: string;
  warning: string;
  systemContent: string;

  constructor(dark: boolean) {
    this.background = dark ? '#131F24' : '#FFFFFF';
    this.text = dark ? '#F1F7FB' : '#1A1A1A';
    this.navText = dark ? '#FFFFFF' : '#000000';
    this.accent = dark ? '#49C0F8' : '#1CB0F6';
    this.surface = dark ? '#202F36' : '#F7F7F7';
    this.notice = dark ? '#202F36' : '#F1F8E9';
    this.warning = dark ? '#3A2B20' : '#FFF1E6';
    this.systemContent = dark ? '#FFFFFF' : '#1A1A1A';
  }
}

// Native colors follow the website's resolved theme. The application itself
// keeps following the system so the Web media query never feeds back on itself.
export class AppearanceService {
  private static systemDark: boolean = false;
  private static pageTheme: string = '';
  private static listener: ((dark: boolean) => void) | undefined;

  static initialize(colorMode: number | undefined): void {
    AppearanceService.pageTheme = '';
    AppearanceService.systemDark = colorMode === 0;
    AppearanceService.publish();
  }

  static setSystemMode(colorMode: number | undefined): void {
    if (colorMode !== 0 && colorMode !== 1) { return; }
    AppearanceService.systemDark = colorMode === 0;
    AppearanceService.publish();
  }

  static setPageTheme(theme: string): void {
    if (theme !== 'light' && theme !== 'dark') { return; }
    AppearanceService.pageTheme = theme;
    AppearanceService.publish();
  }

  static resetPage(): void {
    AppearanceService.pageTheme = '';
    AppearanceService.publish();
  }

  static isDark(): boolean {
    return AppearanceService.pageTheme === '' ? AppearanceService.systemDark : AppearanceService.pageTheme === 'dark';
  }

  static bind(listener: (dark: boolean) => void): void {
    AppearanceService.listener = listener;
    listener(AppearanceService.isDark());
  }

  static unbind(): void { AppearanceService.listener = undefined; }

  private static publish(): void {
    const dark = AppearanceService.isDark();
    const previous = AppStorage.get<boolean>('duoDark');
    AppStorage.setOrCreate('duoDark', dark);
    if (previous !== dark && AppearanceService.listener) { AppearanceService.listener(dark); }
  }
}

export function themeStatusScript(): string {
  // Official public bundles set data-duo-theme on HTML in their theme provider.
  // Return only a fixed enum, without reading account settings or storage.
  return `(() => {
    const allowed = ['https://www.duolingo.com','https://duolingo.com','https://www.duolingo.cn','https://duolingo.cn'];
    if (!allowed.includes(location.origin) || window !== window.top) return '';
    const value = document.documentElement.getAttribute('data-duo-theme');
    return JSON.stringify({theme: value === 'dark' || value === 'light' ? value : '',
      occluded: window.__duoNativeNavigationV2?.occluded === true});
  })()`;
}

export class PageChromeStatus {
  theme: string = '';
  occluded: boolean = false;
  available: boolean = false;
}

export function parsePageChromeStatus(raw: string): PageChromeStatus {
  const result = new PageChromeStatus();
  if (raw.length > 192) { return result; }
  if (raw === 'dark' || raw === 'light' || raw === '"dark"' || raw === '"light"') {
    result.theme = raw.replace(/"/g, ''); result.available = true; return result;
  }
  try {
    let value: PageChromeStatus | string = JSON.parse(raw) as PageChromeStatus | string;
    if (typeof value === 'string') { value = JSON.parse(value) as PageChromeStatus; }
    if (value && typeof value === 'object' && (value.theme === '' || value.theme === 'dark' || value.theme === 'light') &&
      typeof value.occluded === 'boolean') {
      result.theme = value.theme; result.occluded = value.occluded; result.available = true;
    }
  } catch {}
  return result;
}

export function parseThemeStatus(raw: string): string {
  return parsePageChromeStatus(raw).theme;
}
