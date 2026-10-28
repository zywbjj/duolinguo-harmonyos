import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from './load-service.mjs';

const protocol = await loadService('AccountProtocol');
const future = Math.floor(Date.now() / 1000) + 86400;
// Synthetic fixtures: no real account, cookie or response is stored in this suite.
const token = (sub = '123', exp = future) => `e30.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.c2ln`;
const body = (extra = {}) => JSON.stringify({ id: 123, username: 'fixture', ...extra });
const calls = [];
let cookieReader;
let responder;

globalThis.__duoAccountPlatform = {
  util: {
    Base64Helper: class { decodeSync(value) { return new Uint8Array(Buffer.from(value, 'base64')); } },
    TextDecoder: { create: (encoding, options) => ({
      decodeToString: bytes => new TextDecoder(encoding, options).decode(bytes)
    }) }
  },
  webview: { WebCookieManager: { fetchCookie: address => cookieReader(address) } },
  http: {
    RequestMethod: { GET: 'GET' }, HttpDataType: { STRING: 'STRING' },
    createHttp: () => {
      const request = { destroyed: 0,
        request: (address, options) => { calls.push({ address, options, request }); return responder(); },
        destroy: () => { request.destroyed++; }
      };
      return request;
    }
  }
};
const { NativeAccountService } = await loadService('NativeAccountService');

function reset() {
  calls.length = 0;
  cookieReader = async () => `other=ignored; jwt_token=${token()}`;
  responder = async () => ({ responseCode: 200, result: body() });
  return new NativeAccountService();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('native account URLs require an exact official HTTPS origin and numeric id', () => {
  for (const address of ['https://www.duolingo.com.evil.test', 'http://www.duolingo.com',
    'https://name@www.duolingo.com', 'https://www.duolingo.com:8443', 'https://accounts.google.com']) {
    assert.equal(protocol.accountOrigin(address), '');
    assert.throws(() => protocol.accountUrl(address, '123'));
  }
  for (const id of ['123/other', '../123', '1?fields=all', 'NaN', '0']) {
    assert.throws(() => protocol.accountUrl('https://www.duolingo.com', id));
  }
  const address = new URL(protocol.accountUrl('https://www.duolingo.com', '123'));
  assert.equal(address.pathname, '/2017-06-30/users/123');
  assert.match(address.searchParams.get('fields'), /currentCourse/);
});

test('session cookie parsing rejects ambiguous, malformed and header-injecting values', () => {
  const jwt = token();
  assert.equal(protocol.sessionToken(`a=b; jwt_token=${jwt}; c=d`), jwt);
  assert.equal(protocol.sessionToken(`not_jwt_token=${jwt}`), '');
  assert.equal(protocol.sessionToken(`jwt_token=${jwt}; jwt_token=${token('456')}`), '');
  assert.equal(protocol.sessionToken(`jwt_token=${jwt}%0D%0AX-Header%3Asecret`), '');
  assert.equal(protocol.sessionToken('jwt_token=%broken'), '');
  assert.equal(protocol.sessionToken('jwt_token=not.a.valid.token'), '');
  assert.equal(protocol.sessionToken('jwt_token=' + 'a'.repeat(17000)), '');
});

test('JWT claims are limited to a valid subject and unexpired timestamp', () => {
  assert.equal(protocol.subjectFromPayload(JSON.stringify({ sub: 123, exp: 200 }), 100), '123');
  for (const claims of [null, [], { sub: '123', exp: 100 }, { sub: '123' },
    { sub: '../123', exp: 200 }, { sub: 9007199254740992, exp: 200 }, { sub: '123', exp: '200' }]) {
    assert.throws(() => protocol.subjectFromPayload(JSON.stringify(claims), 100));
  }
});

test('profile parsing verifies account id and leaves absent metrics unavailable', () => {
  const account = protocol.parseAccount(body({ learningLanguage: 'en', fromLanguage: 'zs' }), '123');
  assert.equal(account.name, 'fixture');
  assert.equal(account.course, '中文 → 英语');
  assert.equal(account.streak, '—');
  assert.equal(account.totalXp, '—');
  assert.equal(account.pathAvailable, false);
  for (const input of ['{}', '[]', 'null', '<html>login</html>', body({ id: 456 })]) {
    assert.throws(() => protocol.parseAccount(input, '123'));
  }
});

test('course path uses returned units and complete session counters only', () => {
  const account = protocol.parseAccount(body({ streak: 0, totalXp: 90, currentCourse: {
    title: 'fixture course', pathSectioned: [{ units: [
      { description: 'Greetings', levels: [{ finishedSessions: 2, totalSessions: 3 },
        { finishedSessions: 0, totalSessions: 2 }] },
      { levels: [{ finishedSessions: 1, totalSessions: 1 }, {}] },
      { levels: [{ finishedSessions: 5, totalSessions: 1 }] }
    ] }]
  } }), '123');
  assert.equal(account.streak, '0');
  assert.equal(account.totalXp, '90');
  assert.equal(account.unitCount, 3);
  assert.equal(account.units[0].progress, '2 / 5 次练习');
  assert.equal(account.units[1].progress, '进度暂不可用');
  assert.equal(account.units[2].progress, '进度暂不可用');
  assert.equal(account.units[0].detail, 'Greetings');
});

test('unrecognized path structures and excessive paths are rejected', () => {
  for (const pathSectioned of [[null], [{}], [{ units: [{}] }], Array(101).fill({ units: [] })]) {
    assert.throws(() => protocol.parseAccount(body({ currentCourse: { pathSectioned } }), '123'));
  }
  const result = protocol.parseAccount(body({ streak: -1, totalXp: '99', displayName: '\u0000Name\n' }), '123');
  assert.equal(result.streak, '—');
  assert.equal(result.totalXp, '—');
  assert.equal(result.name, 'Name');
});

test('native read sends only a GET to the selected origin, without cache or redirects', async () => {
  const service = reset();
  const result = await service.load('https://www.duolingo.com/learn');
  assert.equal(result.state, 'ready');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.header.Authorization, `Bearer ${token()}`);
  assert.equal(calls[0].options.header.Cookie, undefined);
  assert.equal(calls[0].options.maxRedirects, 0);
  assert.equal(calls[0].options.usingCache, false);
  assert.equal(calls[0].options.maxLimit, 4 * 1024 * 1024);
  assert.equal(calls[0].request.destroyed, 1);
  assert.equal(JSON.stringify(result).includes(token()), false);
});

test('no request is made for an external page, absent session or expired session', async () => {
  const service = reset();
  assert.equal((await service.load('https://accounts.google.com')).state, 'finish_login');
  cookieReader = async () => '';
  assert.equal((await service.load('https://www.duolingo.com')).state, 'signed_out');
  cookieReader = async () => `jwt_token=${token('123', 1)}`;
  assert.equal((await service.load('https://www.duolingo.com')).state, 'expired');
  assert.equal(calls.length, 0);
});

test('session replacement during a request discards the old account', async () => {
  const service = reset();
  let reads = 0;
  cookieReader = async () => `jwt_token=${++reads === 1 ? token() : token('456')}`;
  const result = await service.load('https://www.duolingo.com');
  assert.equal(result.state, 'session_changed');
  assert.equal(result.account.name, '');
});

test('the SDK no-cookie error is treated as signed out; other cookie failures remain unavailable', async () => {
  const service = reset();
  cookieReader = async () => { throw { code: 17100002 }; };
  assert.equal((await service.load('https://www.duolingo.com')).state, 'signed_out');
  cookieReader = async () => { throw { code: 401 }; };
  assert.equal((await service.load('https://www.duolingo.com')).state, 'unavailable');
  assert.equal(calls.length, 0);
});

test('cancelling while reading cookies prevents a later HTTP request', async () => {
  const service = reset();
  const cookies = deferred();
  cookieReader = () => cookies.promise;
  const pending = service.load('https://www.duolingo.com');
  service.cancel();
  cookies.resolve(`jwt_token=${token()}`);
  assert.equal((await pending).state, 'cancelled');
  assert.equal(calls.length, 0);
});

test('a newer refresh cancels the old request without destroying the newer one', async () => {
  const service = reset();
  const first = deferred();
  const second = deferred();
  let requests = 0;
  responder = () => (++requests === 1 ? first.promise : second.promise);
  const previous = service.load('https://www.duolingo.com');
  await new Promise(resolve => setImmediate(resolve));
  const current = service.load('https://www.duolingo.com');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].request.destroyed, 1);
  assert.equal(calls[1].request.destroyed, 0);
  first.resolve({ responseCode: 200, result: body({ name: 'old' }) });
  assert.equal((await previous).state, 'cancelled');
  assert.equal(calls[1].request.destroyed, 0);
  second.resolve({ responseCode: 200, result: body({ name: 'current' }) });
  assert.equal((await current).account.name, 'current');
  assert.equal(calls[1].request.destroyed, 1);
});

test('HTTP errors and redirects produce safe states without automatic retries', async () => {
  const service = reset();
  const states = new Map([[401, 'expired'], [403, 'access_denied'], [429, 'rate_limited'],
    [301, 'unavailable'], [500, 'unavailable']]);
  for (const [responseCode, state] of states) {
    responder = async () => ({ responseCode, result: 'PRIVATE RAW RESPONSE' });
    const result = await service.load('https://www.duolingo.com');
    assert.equal(result.state, state);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  assert.equal(calls.length, states.size);
});

test('invalid JSON, login HTML and account mismatch cannot become a native profile', async () => {
  const service = reset();
  for (const result of ['<html>login</html>', body({ id: 456 }), { id: 123 }]) {
    responder = async () => ({ responseCode: 200, result });
    assert.equal((await service.load('https://www.duolingo.com')).state, 'invalid_data');
  }
});

test('network errors release resources and never expose exception details', async () => {
  const service = reset();
  responder = async () => { throw new Error('PRIVATE Authorization: TOKEN'); };
  const result = await service.load('https://www.duolingo.com');
  assert.equal(result.state, 'unavailable');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(calls[0].request.destroyed, 1);
  responder = async () => ({ responseCode: 200, result: body() });
  assert.equal((await service.load('https://www.duolingo.com')).state, 'ready');
});
