import { webview } from '@kit.ArkWeb';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { AccountSnapshot, accountOrigin, accountUrl, parseAccount, sessionToken,
  subjectFromPayload } from './AccountProtocol';

interface CookieFailure {
  code?: number;
}

export class AccountResult {
  state: string;
  account: AccountSnapshot = new AccountSnapshot();

  constructor(state: string, account?: AccountSnapshot) {
    this.state = state;
    if (account) { this.account = account; }
  }
}

export class NativeAccountService {
  private generation: number = 0;
  private pending: http.HttpRequest | undefined;

  private async readToken(address: string): Promise<string> {
    try {
      return sessionToken(await webview.WebCookieManager.fetchCookie(address));
    } catch (error) {
      // The SDK also reports the absence of cookies as 17100002 for a valid URL.
      if ((error as CookieFailure)?.code === 17100002) { return ''; }
      throw new Error('cookie_unavailable');
    }
  }

  cancel(): void {
    this.generation++;
    if (this.pending) {
      try { this.pending.destroy(); } catch {}
      this.pending = undefined;
    }
  }

  async load(pageAddress: string): Promise<AccountResult> {
    this.cancel();
    const ticket = this.generation;
    const origin = accountOrigin(pageAddress);
    if (origin === '') { return new AccountResult('finish_login'); }
    let request: http.HttpRequest | undefined;
    try {
      // Only the official site's session token is used; other cookies are never forwarded.
      const cookieAddress = `${origin}/learn`;
      const token = await this.readToken(cookieAddress);
      if (ticket !== this.generation) { return new AccountResult('cancelled'); }
      if (token === '') { return new AccountResult('signed_out'); }
      let userId: string;
      try {
        let encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        encoded = encoded.padEnd(encoded.length + (4 - encoded.length % 4) % 4, '=');
        const bytes = new util.Base64Helper().decodeSync(encoded);
        const payload = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes);
        userId = subjectFromPayload(payload, Math.floor(Date.now() / 1000));
      } catch {
        return new AccountResult('expired');
      }
      request = http.createHttp();
      this.pending = request;
      const response = await request.request(accountUrl(origin, userId), {
        method: http.RequestMethod.GET,
        header: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
        expectDataType: http.HttpDataType.STRING,
        usingCache: false,
        connectTimeout: 10000,
        readTimeout: 15000,
        maxLimit: 4 * 1024 * 1024,
        maxRedirects: 0
      });
      if (ticket !== this.generation) { return new AccountResult('cancelled'); }
      // Discard responses from a session that was logged out or replaced during the request.
      const currentToken = await this.readToken(cookieAddress);
      if (ticket !== this.generation) { return new AccountResult('cancelled'); }
      if (currentToken !== token) { return new AccountResult('session_changed'); }
      if (response.responseCode === 401) { return new AccountResult('expired'); }
      if (response.responseCode === 403) { return new AccountResult('access_denied'); }
      if (response.responseCode === 429) { return new AccountResult('rate_limited'); }
      if (response.responseCode !== 200) { return new AccountResult('unavailable'); }
      if (typeof response.result !== 'string') { return new AccountResult('invalid_data'); }
      try {
        return new AccountResult('ready', parseAccount(response.result, userId));
      } catch {
        return new AccountResult('invalid_data');
      }
    } catch {
      // Never surface request errors, headers, cookie values or raw API responses.
      return new AccountResult(ticket === this.generation ? 'unavailable' : 'cancelled');
    } finally {
      if (request && this.pending === request) {
        try { request.destroy(); } catch {}
        this.pending = undefined;
      }
    }
  }
}
