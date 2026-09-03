/**
 * Núcleo de programación de borradores de WordPress.
 */
import { isObj, wpGet, wpGetAll, wpPost, WpHttpError } from './wp-http.ts';
import type { WpAuth } from './wp-http.ts';

export interface WpUser {
  id: number;
  name: string;
  slug: string;
  roles: string[];
}

export interface WpCategory {
  id: number;
  slug: string;
  name: string;
}

export interface WpPost {
  id: number;
  status: string;
  date: string;
  date_gmt: string;
  title: { rendered: string };
  author: number;
  categories: number[];
  lang?: string;
}

export function asUser(x: unknown): WpUser {
  const o = isObj(x) ? x : {};
  return {
    id: typeof o.id === 'number' ? o.id : -1,
    name: typeof o.name === 'string' ? o.name : '',
    slug: typeof o.slug === 'string' ? o.slug : '',
    roles: Array.isArray(o.roles) ? (o.roles as string[]) : [],
  };
}

export function asCategory(x: unknown): WpCategory {
  const o = isObj(x) ? x : {};
  return {
    id: typeof o.id === 'number' ? o.id : -1,
    slug: typeof o.slug === 'string' ? o.slug : '',
    name: typeof o.name === 'string' ? o.name : '',
  };
}

export function asPost(x: unknown): WpPost {
  const o = isObj(x) ? x : {};
  const title = isObj(o.title) && typeof o.title.rendered === 'string' ? o.title.rendered : '';
  return {
    id: typeof o.id === 'number' ? o.id : -1,
    status: typeof o.status === 'string' ? o.status : '',
    date: typeof o.date === 'string' ? o.date : '',
    date_gmt: typeof o.date_gmt === 'string' ? o.date_gmt : '',
    title: { rendered: title },
    author: typeof o.author === 'number' ? o.author : -1,
    categories: Array.isArray(o.categories) ? (o.categories as number[]) : [],
    lang: typeof o.lang === 'string' ? o.lang : undefined,
  };
}

export function tzOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour24 = Number(map.hour) === 24 ? 0 : Number(map.hour);
  const asUtcIfLocalWereUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour24,
    Number(map.minute),
    Number(map.second),
  );
  return (asUtcIfLocalWereUtc - instant.getTime()) / 60000;
}

export function wallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset1 = tzOffsetMinutes(new Date(naiveUtc), tz);
  let candidate = new Date(naiveUtc - offset1 * 60000);
  const offset2 = tzOffsetMinutes(candidate, tz);
  if (offset2 !== offset1) {
    candidate = new Date(naiveUtc - offset2 * 60000);
  }
  return candidate;
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toDateGmtString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function matchUsers(token: string, users: WpUser[]): WpUser[] {
  const tokenNum = Number(token);
  const isNumeric = token.trim() !== '' && Number.isFinite(tokenNum);
  const lowerToken = token.toLowerCase();
  return users.filter((u) => {
    if (isNumeric && u.id === tokenNum) return true;
    if (u.slug === token) return true;
    if (u.name.toLowerCase().includes(lowerToken)) return true;
    return false;
  });
}

export function fmtCandidates(users: WpUser[]): string {
  return users.map((u) => `${u.id} ${u.name} ${u.slug} ${JSON.stringify(u.roles)}`).join('\n  ');
}

export function resolveAuthors(tokens: string[], users: WpUser[]): WpUser[] {
  if (tokens.length !== 2) {
    throw new Error(`[schedule] --authors exige exactamente 2 autores, se recibieron ${tokens.length}: ${tokens.join(',')}`);
  }
  return tokens.map((token) => {
    const candidates = matchUsers(token, users);
    if (candidates.length !== 1) {
      const shown = candidates.length === 0 ? users : candidates;
      throw new Error(
        `[schedule] token de autor "${token}" no casa con exactamente un usuario (${candidates.length} coincidencias). Candidatos:\n  ${fmtCandidates(shown)}`,
      );
    }
    return candidates[0];
  });
}

export async function resolveAuthorsWithFallback(
  auth: WpAuth,
  tokens: string[],
  warn: (msg: string) => void = () => {},
): Promise<WpUser[]> {
  if (tokens.length !== 2) {
    throw new Error(`[schedule] --authors exige exactamente 2 autores, se recibieron ${tokens.length}: ${tokens.join(',')}`);
  }
  try {
    const usersRaw = await wpGetAll(auth, '/wp-json/wp/v2/users', { context: 'edit' });
    return resolveAuthors(tokens, usersRaw.map(asUser));
  } catch (e) {
    if (!(e instanceof WpHttpError)) throw e;
    const allNumeric = tokens.every((t) => t.trim() !== '' && Number.isFinite(Number(t)));
    if (!allNumeric) {
      throw new Error(
        `[schedule] /wp/v2/users está bloqueado en este sitio (${e.status} ${e.code}: ${e.detail}), así que no se puede casar "${tokens.join(',')}" por nombre/slug. ` +
          'Pasá los autores como ID numérico de WordPress (wp-admin → Usuarios → pasar el mouse sobre el nombre → user_id= en el enlace, o abrir su perfil).',
      );
    }
    warn(
      `[schedule] aviso: /wp/v2/users bloqueado (${e.status} ${e.code}) — usando los IDs numéricos de --authors sin validar contra la API.`,
    );
    return tokens.map((t) => ({ id: Number(t), name: `user-${t}`, slug: `user-${t}`, roles: [] }));
  }
}

export async function resolveDefaultCategoryId(auth: WpAuth, categories: WpCategory[]): Promise<number> {
  try {
    const r = await wpGet(auth, '/wp-json/wp/v2/settings');
    const body = isObj(r.data) ? r.data : {};
    if (typeof body.default_category === 'number') return body.default_category;
  } catch {}
  const bySlug = categories.find((c) => c.slug === 'sin-categorizar' || c.slug === 'uncategorized' || c.slug === 'uncategorised');
  if (bySlug) return bySlug.id;
  return 1;
}

export interface ScheduleRow {
  post: WpPost;
  author: WpUser;
  categoryIds: number[];
  dateGmt: string;
  action: 'programar' | 'omitido';
  reason?: string;
}

export interface PlanOptions {
  from: string;
  slots: string[];
  tz: string;
  authors: WpUser[];
  categoryMap: Map<number, number>;
  defaultCategoryId: number;
}

export function planRows(posts: WpPost[], opts: PlanOptions): ScheduleRow[] {
  const slotCount = opts.slots.length > 0 ? opts.slots.length : 1;
  const [fy, fm, fd] = opts.from.split('-').map(Number);

  return posts.map((post, i) => {
    const dayOffset = Math.floor(i / slotCount);
    const slot = opts.slots[i % slotCount] ?? opts.slots[0] ?? '09:00';
    const [h, mi] = slot.split(':').map(Number);
    const dayDate = new Date(Date.UTC(fy, fm - 1, fd + dayOffset));
    const utc = wallTimeToUtc(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, dayDate.getUTCDate(), h, mi, opts.tz);
    const dateGmt = toDateGmtString(utc);
    const author = opts.authors[i % 2];

    let categoryIds: number[];
    const mapped = opts.categoryMap.get(post.id);
    if (mapped !== undefined) {
      categoryIds = [mapped];
    } else if (post.categories.filter((c) => c !== opts.defaultCategoryId).length > 0) {
      categoryIds = post.categories.filter((c) => c !== opts.defaultCategoryId);
    } else {
      return { post, author, categoryIds: [], dateGmt, action: 'omitido', reason: 'sin categoría y sin entrada en category_map' };
    }

    if (post.status !== 'draft' && post.status !== 'future') {
      return { post, author, categoryIds, dateGmt, action: 'omitido', reason: `estado ${post.status}: no se toca` };
    }

    if (post.status === 'future') {
      const sameDate = post.date_gmt.slice(0, 19) === dateGmt;
      const sameAuthor = post.author === author.id;
      const sameCats = categoryIds.length === post.categories.length && categoryIds.every((c) => post.categories.includes(c));
      if (sameDate && sameAuthor && sameCats) {
        return { post, author, categoryIds, dateGmt, action: 'omitido', reason: 'ya programado' };
      }
      return { post, author, categoryIds, dateGmt, action: 'omitido', reason: 'estado future: no coincide con el objetivo, no se toca' };
    }

    return { post, author, categoryIds, dateGmt, action: 'programar' };
  });
}

export function formatRows(rows: ScheduleRow[]): string {
  const lines: string[] = [
    '#\tid\ttítulo\t\tlang\tautor→\tcategorías→\tdate_gmt→\tacción',
  ];
  rows.forEach((r, i) => {
    const title = r.post.title.rendered.slice(0, 60);
    const lang = r.post.lang ?? '-';
    const action = r.action === 'programar' ? 'programar' : `omitido: ${r.reason}`;
    lines.push(`${i}\t${r.post.id}\t${title}\t${lang}\t${r.author.slug}\t[${r.categoryIds.join(',')}]\t${r.dateGmt}\t${action}`);
  });
  return lines.join('\n');
}

export async function applyRows(
  auth: WpAuth,
  rows: ScheduleRow[],
  log: (msg: string) => void = () => {},
): Promise<{ ok: number; attempted: number; failures: string[] }> {
  let ok = 0;
  let attempted = 0;
  const failures: string[] = [];

  for (const r of rows) {
    if (r.action !== 'programar') continue;
    attempted++;
    try {
      await wpPost(auth, `/wp-json/wp/v2/posts/${r.post.id}`, {
        author: r.author.id,
        categories: r.categoryIds,
        date_gmt: r.dateGmt,
        status: 'future',
      });
      const reread = await wpGet(auth, `/wp-json/wp/v2/posts/${r.post.id}`, { context: 'edit' });
      const fresh = asPost(reread.data);
      const matches =
        fresh.status === 'future' &&
        fresh.date_gmt.slice(0, 19) === r.dateGmt &&
        fresh.author === r.author.id &&
        r.categoryIds.every((c) => fresh.categories.includes(c));
      if (!matches) {
        throw new Error(
          `releído no coincide: status=${fresh.status} date_gmt=${fresh.date_gmt} author=${fresh.author} categories=${JSON.stringify(fresh.categories)}`,
        );
      }
      log(`ok ${fresh.id} → ${fresh.status} ${fresh.date_gmt} autor=${fresh.author} cats=[${fresh.categories.join(',')}]`);
      ok++;
    } catch (e) {
      const msg = e instanceof WpHttpError ? `${e.status} ${e.code} ${e.detail}` : e instanceof Error ? e.message : String(e);
      log(`fallo ${r.post.id}: ${msg}`);
      failures.push(`post ${r.post.id}: ${msg}`);
    }
  }

  return { ok, attempted, failures };
}
