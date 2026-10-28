import { safeOrigin, isLearningOrigin } from './NavigationPolicy';

// Read-only web API adapter. These fields are provisional until tested with the user's course.
const ACCOUNT_FIELDS: string = 'id,username,name,displayName,fromLanguage,learningLanguage,streak,totalXp,currentCourse';

interface TokenClaims {
  sub?: string | number;
  exp?: number;
}

interface LevelWire {
  finishedSessions?: number;
  totalSessions?: number;
}

interface UnitWire {
  unitIndex?: number;
  description?: string;
  levels?: LevelWire[];
}

interface SectionWire {
  units?: UnitWire[];
}

interface CourseWire {
  title?: string;
  fromLanguage?: string;
  learningLanguage?: string;
  pathSectioned?: SectionWire[];
}

interface UserWire {
  id?: string | number;
  username?: string;
  name?: string;
  displayName?: string;
  fromLanguage?: string;
  learningLanguage?: string;
  streak?: number;
  totalXp?: number;
  currentCourse?: CourseWire;
}

export class CourseUnit {
  key: string = '';
  title: string = '';
  detail: string = '';
  progress: string = '进度暂不可用';
}

export class AccountSnapshot {
  name: string = '';
  username: string = '';
  course: string = '';
  streak: string = '—';
  totalXp: string = '—';
  pathAvailable: boolean = false;
  sectionCount: number = 0;
  unitCount: number = 0;
  units: CourseUnit[] = [];
  checkedAt: string = '';
}

export function accountOrigin(address: string): string {
  return isLearningOrigin(address) ? safeOrigin(address) : '';
}

export function accountUrl(origin: string, userId: string): string {
  if (accountOrigin(origin) !== origin || !/^[1-9][0-9]{0,19}$/.test(userId)) {
    throw new Error('invalid_account_request');
  }
  return `${origin}/2017-06-30/users/${userId}?fields=${encodeURIComponent(ACCOUNT_FIELDS)}`;
}

export function sessionToken(cookies: string): string {
  let token: string = '';
  for (const entry of cookies.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.substring(0, separator).trim() !== 'jwt_token') {
      continue;
    }
    let value: string;
    try {
      value = decodeURIComponent(entry.substring(separator + 1).trim());
    } catch {
      return '';
    }
    if (token !== '' && token !== value) {
      return '';
    }
    if (value.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
      return '';
    }
    token = value;
  }
  return token;
}

// Reading sub/exp is routing and expiry checking, NOT signature verification.
// The server must accept the bearer token and return the matching account id.
export function subjectFromPayload(payload: string, nowSeconds: number): string {
  const claims = JSON.parse(payload) as TokenClaims;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) ||
    typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) {
    throw new Error('expired_session');
  }
  const id = normalizedId(claims.sub);
  if (id === '') {
    throw new Error('invalid_session');
  }
  return id;
}

function normalizedId(value: string | number | undefined): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value.toString();
  }
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : '';
}

function cleanText(value: string | undefined, maximum: number = 120): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().substring(0, maximum) : '';
}

function validCount(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function languageName(value: string | undefined): string {
  const code = cleanText(value, 16);
  if (code === 'en') { return '英语'; }
  if (code === 'zh' || code === 'zs') { return '中文'; }
  return code;
}

function unitProgress(levels: LevelWire[]): string {
  if (levels.length === 0) { return '进度暂不可用'; }
  let finished = 0;
  let total = 0;
  for (const level of levels) {
    if (!level || typeof level !== 'object' || !validCount(level.finishedSessions) ||
      !validCount(level.totalSessions) || level.finishedSessions! > level.totalSessions!) {
      return '进度暂不可用';
    }
    finished += level.finishedSessions!;
    total += level.totalSessions!;
  }
  return total > 0 && Number.isSafeInteger(total) && Number.isSafeInteger(finished) ?
    `${finished} / ${total} 次练习` : '进度暂不可用';
}

export function parseAccount(body: string, expectedId: string): AccountSnapshot {
  const user = JSON.parse(body) as UserWire;
  if (!user || typeof user !== 'object' || Array.isArray(user) ||
    normalizedId(user.id) !== expectedId || expectedId === '') {
    throw new Error('invalid_account_response');
  }
  const result = new AccountSnapshot();
  result.username = cleanText(user.username);
  result.name = cleanText(user.displayName) || cleanText(user.name) || result.username || '我的账号';
  if (validCount(user.streak)) { result.streak = user.streak!.toString(); }
  if (validCount(user.totalXp)) { result.totalXp = user.totalXp!.toString(); }
  const course = user.currentCourse;
  const hasCourse = course !== null && typeof course === 'object' && !Array.isArray(course);
  const from = languageName(hasCourse ? course?.fromLanguage || user.fromLanguage : user.fromLanguage);
  const learning = languageName(hasCourse ? course?.learningLanguage || user.learningLanguage : user.learningLanguage);
  result.course = (hasCourse ? cleanText(course?.title) : '') ||
    (from && learning ? `${from} → ${learning}` : learning || '当前课程暂不可用');
  const sections = hasCourse ? course?.pathSectioned : undefined;
  if (Array.isArray(sections)) {
    result.pathAvailable = true;
    result.sectionCount = sections.length;
    // Bound UI work independently of the network response size.
    if (sections.length > 100) { throw new Error('unsupported_path'); }
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const section = sections[sectionIndex];
      if (!section || !Array.isArray(section.units)) {
        throw new Error('unsupported_path');
      }
      result.unitCount += section.units.length;
      if (result.unitCount > 2000) { throw new Error('unsupported_path'); }
      for (let unitIndex = 0; unitIndex < section.units.length; unitIndex++) {
        const unit = section.units[unitIndex];
        if (!unit || typeof unit !== 'object' || !Array.isArray(unit.levels) || unit.levels.length > 100) {
          throw new Error('unsupported_path');
        }
        const item = new CourseUnit();
        item.key = `${sectionIndex}:${unitIndex}`;
        item.title = `第 ${sectionIndex + 1} 阶段 · 单元 ${unitIndex + 1}`;
        item.detail = cleanText(unit.description) || `${unit.levels.length} 个学习节点`;
        item.progress = unitProgress(unit.levels);
        result.units.push(item);
      }
    }
  }
  result.checkedAt = new Date().toLocaleTimeString();
  return result;
}
