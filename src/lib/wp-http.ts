/**
 * Capa HTTP pura para la REST API de WordPress.
 * Sin dependencias de clientes: client-agnostic vía WpAuth.
 */

export type WpAuthMode = 'auto' | 'basic' | 'jwt';

export interface WpAuth {
  baseUrl: string;
  user: string;
  appPassword: string;
  userAgent?: string;
  /** Modo de autenticación contra la REST API; por defecto 'auto' (Basic con fallback Bearer). */
  authMode?: WpAuthMode;
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

const jwtTokenCache = new Map<string, string>();

/** Sitios (baseUrl|user) donde Basic ya falló y se usa Bearer directamente. */
const basicBrokenSites = new Set<string>();

/** Fallos del oráculo (sitio sin jwt-auth/v1 o credencial mala) con TTL corto. */
const jwtNegCache = new Map<string, number>();
const JWT_NEG_TTL_MS = 5 * 60 * 1000;

function authCacheKey(auth: WpAuth): string {
  return `${auth.baseUrl}|${auth.user}`;
}

/**
 * Pide (o reutiliza de la caché del proceso) un token JWT al endpoint
 * jwt-auth/v1/token del sitio. Devuelve null si el sitio no expone el
 * endpoint o la credencial no es válida.
 */
async function fetchJwtToken(auth: WpAuth): Promise<string | null> {
  const key = authCacheKey(auth);
  const cached = jwtTokenCache.get(key);
  if (cached) return cached;
  if (Date.now() < (jwtNegCache.get(key) ?? 0)) return null;
  try {
    const res = await fetch(buildUrl(auth.baseUrl, '/wp-json/jwt-auth/v1/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': auth.userAgent ?? DEFAULT_UA },
      body: JSON.stringify({ username: auth.user, password: auth.appPassword }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await parseJsonSafe(res);
    const b = isObj(body) ? body : {};
    const data = isObj(b.data) ? b.data : {};
    const token = typeof b.token === 'string' ? b.token : typeof data.token === 'string' ? data.token : '';
    if (res.ok && token) {
      jwtTokenCache.set(key, token);
      jwtNegCache.delete(key);
      return token;
    }
  } catch {
    // Sin oráculo JWT o red caída: el modo auto devolverá el error original de Basic.
  }
  // Fallo (sin endpoint, credencial mala o red): se recuerda un rato para no
  // repetir el POST del token en cada check contra sitios lentos.
  jwtNegCache.set(key, Date.now() + JWT_NEG_TTL_MS);
  return null;
}

/**
 * ¿Tiene esta respuesta la forma de "petición anónima"? WordPress responde
 * 401 rest_not_logged_in, pero también 400 rest_invalid_param con detalle
 * rest_forbidden_status cuando la query pide algo (p.ej. status=draft) que
 * un usuario sin autenticar no puede pedir.
 */
async function looksAnonymous(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 400) return false;
  const body = await parseJsonSafe(res.clone());
  if (!isObj(body) || body.code !== 'rest_invalid_param') return false;
  const data = isObj(body.data) ? body.data : {};
  const details = isObj(data.details) ? data.details : {};
  const status = isObj(details.status) ? details.status : {};
  return status.code === 'rest_forbidden_status';
}

/**
 * fetch autenticado según auth.authMode:
 * - 'basic': siempre Application Passwords Basic, sin fallback.
 * - 'jwt': siempre Bearer con token del oráculo (falla si no está disponible).
 * - 'auto' (por defecto): Basic primero; si la respuesta tiene forma de
 *   petición anónima (401 o el 400 rest_forbidden_status) y el sitio expone
 *   jwt-auth/v1, reintenta con Bearer (token cacheado en memoria del
 *   proceso). Los sitios donde Basic falla se marcan y pasan a ir directos
 *   a Bearer para no pagar el doble de peticiones en cada llamada.
 */
async function wpFetch(
  auth: WpAuth,
  url: string,
  init: { method?: string; body?: string; json?: boolean } = {},
): Promise<Response> {
  const mode: WpAuthMode = auth.authMode ?? 'auto';
  const key = authCacheKey(auth);
  const doFetch = (token: string | null): Promise<Response> =>
    fetch(url, {
      method: init.method,
      body: init.body,
      headers: {
        authorization: token === null ? authHeader(auth) : `Bearer ${token}`,
        'user-agent': auth.userAgent ?? DEFAULT_UA,
        ...(init.json ? { 'content-type': 'application/json' } : {}),
      },
    });
  const bearerWithRefresh = async (): Promise<Response | null> => {
    const token = await fetchJwtToken(auth);
    if (token === null) return null;
    const res = await doFetch(token);
    if (res.status === 401) {
      // Token caducado: se descarta y se reintenta una sola vez con uno fresco.
      jwtTokenCache.delete(key);
      const fresh = await fetchJwtToken(auth);
      if (fresh !== null && fresh !== token) return doFetch(fresh);
    }
    return res;
  };

  if (mode === 'jwt') {
    const res = await bearerWithRefresh();
    if (res === null) {
      throw new Error('[wp] WP_AUTH_MODE=jwt pero el sitio no expone jwt-auth/v1 o rechazó la credencial');
    }
    return res;
  }

  if (mode === 'auto' && basicBrokenSites.has(key)) {
    // Sitio ya marcado: Bearer directo; si el oráculo desapareció, volver a Basic.
    const res = await bearerWithRefresh();
    if (res !== null) return res;
    basicBrokenSites.delete(key);
    return doFetch(null);
  }

  let res = await doFetch(null);
  if (mode === 'auto' && (await looksAnonymous(res))) {
    const retry = await bearerWithRefresh();
    if (retry !== null) {
      if (retry.ok) basicBrokenSites.add(key);
      return retry;
    }
  }
  return res;
}

export async function wpGet(
  auth: WpAuth,
  path: string,
  params?: Record<string, string | number>,
): Promise<{ data: unknown; total?: number; totalPages?: number }> {
  const res = await wpFetch(auth, buildUrl(auth.baseUrl, path, params));
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
  const res = await wpFetch(auth, buildUrl(auth.baseUrl, path), {
    method: 'POST',
    json: true,
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

export interface AuthProbe {
  /** true = demostrado que la cabecera Authorization llega a PHP; null = no demostrable en este sitio. */
  headerReachesPhp: boolean | null;
  oracle: 'ok' | 'bad_password' | 'unknown_user' | 'unavailable';
  detail: string;
}

const PROBE_TIMEOUT_MS = 8000;

/**
 * Discrimina por qué falla la autenticación cuando WordPress responde 401 rest_not_logged_in.
 *
 * 1. Sonda Bearer: si algún plugin JWT contesta con un código que contiene "jwt_auth",
 *    queda demostrado que el servidor web SÍ reenvía la cabecera Authorization a PHP.
 * 2. Oráculo: si el sitio expone jwt-auth/v1, su endpoint de token valida usuario y
 *    Application Password recibiéndolos en el CUERPO, así que distingue credencial
 *    revocada de usuario inexistente sin depender de la cabecera.
 */
export async function probeAuthTransport(auth: WpAuth, namespaces: string[]): Promise<AuthProbe> {
  const ua = auth.userAgent ?? DEFAULT_UA;
  let headerReachesPhp: boolean | null = null;

  try {
    const res = await fetch(buildUrl(auth.baseUrl, '/wp-json/wp/v2/users/me', { context: 'edit' }), {
      headers: { authorization: 'Bearer probe.probe.probe', 'user-agent': ua },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await parseJsonSafe(res);
    const code = isObj(body) && typeof body.code === 'string' ? body.code : '';
    if (code.includes('jwt_auth')) headerReachesPhp = true;
  } catch {
    // Sonda best-effort: la indeterminación es un resultado válido, nunca un fallo de la tool.
  }

  if (!namespaces.includes('jwt-auth/v1')) {
    return { headerReachesPhp, oracle: 'unavailable', detail: 'el sitio no expone jwt-auth/v1' };
  }

  let detail = '';
  try {
    const res = await fetch(buildUrl(auth.baseUrl, '/wp-json/jwt-auth/v1/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': ua },
      body: JSON.stringify({ username: auth.user, password: auth.appPassword }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await parseJsonSafe(res);
    const b = isObj(body) ? body : {};
    const data = isObj(b.data) ? b.data : {};
    // Tmeister devuelve el token en la raíz; la variante de Useful Team lo devuelve en data.token.
    const token = typeof b.token === 'string' ? b.token : typeof data.token === 'string' ? data.token : '';
    const code = typeof b.code === 'string' ? b.code : '';
    if (res.ok && token) {
      jwtTokenCache.set(authCacheKey(auth), token);
      return { headerReachesPhp, oracle: 'ok', detail: 'credencial aceptada por el validador del sitio' };
    }
    if (code.includes('invalid_username')) return { headerReachesPhp, oracle: 'unknown_user', detail: code };
    if (code.includes('incorrect_password')) return { headerReachesPhp, oracle: 'bad_password', detail: code };
    detail = code || `HTTP ${res.status}`;
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }

  return { headerReachesPhp, oracle: 'unavailable', detail };
}
