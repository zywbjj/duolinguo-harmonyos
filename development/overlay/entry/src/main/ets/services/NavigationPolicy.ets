import { url } from '@kit.ArkTS';

export const LEARN_URL: string = 'https://www.duolingo.com/learn';

// Add another origin only after observing and verifying the official redirect.
const LEARNING_ORIGINS: string[] = [
  'https://www.duolingo.com',
  'https://duolingo.com',
  'https://www.duolingo.cn',
  'https://duolingo.cn'
];

export function safeOrigin(value: string): string {
  try {
    const parsed = url.URL.parseURL(value);
    if (parsed.username !== '' || parsed.password !== '') {
      return '';
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

export function isLearningOrigin(value: string): boolean {
  return LEARNING_ORIGINS.indexOf(safeOrigin(value)) >= 0;
}

// Return strings rather than runtime enums so this policy can be tested without a device.
export function navigationAction(value: string): string {
  if (isLearningOrigin(value)) {
    return 'internal';
  }
  const origin = safeOrigin(value);
  return origin.startsWith('https://') ? 'external' : 'blocked';
}
