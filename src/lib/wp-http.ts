/**
 * Capa HTTP pura para la REST API de WordPress.
 * Sin dependencias de clientes: client-agnostic vía WpAuth.
 */

export interface WpAuth {
  baseUrl: string;
  user: string;
  appPassword: string;
  userAgent?: string;
}

export class WpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly body: unknown,
  ) {
    super(`[wp] HTTP ${status} ${code}${detail ? ` — ${detail}` : ''}`);
    this.name = 'WpHttpError';
  }
}

export const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;

export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function authHeader(auth: WpAuth): string {
  return 'Basic ' + Buffer.from(`${auth.user}:${auth.appPassword}`).toString('base64');
}

export function buildUrl(base: string, path: string, params?: Record<string, string | number>): string {
  const url = new URL(base.replace(/\/$/, '') + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function throwWpError(res: Response): Promise<never> {
  const body = await parseJsonSafe(res);
  const b = isObj(body) ? body : {};
  const code = typeof b.code === 'string' ? b.code : 'sin_code';
  const data = isObj(b.data) ? b.data : undefined;
  const details = data && isObj(data.details) ? data.details : undefined;
  const statusDetail = details && isObj(details.status) ? details.status : undefined;
  const detail =
    (statusDetail && typeof statusDetail.code === 'string' ? statusDetail.code : undefined) ??
    (typeof b.message === 'string' ? b.message : '');
  throw new WpHttpError(res.status, code, detail, body);
}

export async function wpGet(
  auth: WpAuth,
  path: string,
  params?: Record<string, string | number>,
): Promise<{ data: unknown; total?: number; totalPages?: number }> {
  const ua = auth.userAgent ?? DEFAULT_UA;
  const res = await fetch(buildUrl(auth.baseUrl, path, params), {
    headers: {
      authorization: authHeader(auth),
      'user-agent': ua,
    },
  });
  if (!res.ok) return throwWpError(res);
  const data = await res.json();
  const total = res.headers.get('x-wp-total');
  const totalPages = res.headers.get('x-wp-totalpages');
  return {
    data,
    total: total !== null ? Number(total) : undefined,
    totalPages: totalPages !== null ? Number(totalPages) : undefined,
  };
}

export async function wpGetAll(
  auth: WpAuth,
  path: string,
  params?: Record<string, string | number>,
): Promise<unknown[]> {
  const perPage = 100;
  const all: unknown[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data, totalPages: tp } = await wpGet(auth, path, { ...params, per_page: perPage, page });
    if (Array.isArray(data)) all.push(...data);
    totalPages = tp ?? 1;
    page += 1;
  } while (page <= totalPages);
  return all;
}

export async function wpPost(auth: WpAuth, path: string, body: object): Promise<unknown> {
  const ua = auth.userAgent ?? DEFAULT_UA;
  const res = await fetch(buildUrl(auth.baseUrl, path), {
    method: 'POST',
    headers: {
      authorization: authHeader(auth),
      'content-type': 'application/json',
      'user-agent': ua,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwWpError(res);
  return res.json();
}

export async function wpAnon(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number>,
  userAgent: string = DEFAULT_UA,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(buildUrl(baseUrl, path, params), {
    headers: {
      'user-agent': userAgent,
    },
  });
  const body = await parseJsonSafe(res);
  return { status: res.status, body };
}
