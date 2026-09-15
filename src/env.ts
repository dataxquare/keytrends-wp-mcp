import type { WpAuth, WpAuthMode } from './lib/wp-http.ts';

export interface McpEnv {
  auth: WpAuth;
  defaultLang?: string;
  tz: string;
}

function parseAuthMode(v: string | undefined): WpAuthMode | undefined {
  return v === 'auto' || v === 'basic' || v === 'jwt' ? v : undefined;
}

export function envConfig(): McpEnv {
  // Soporta nombres canónicos (WORDPRESS_*) y alias comunes de plataformas como Cognitiv (BASE_URL, USERNAME, APPLICATION_PASSWORD)
  const baseUrlRaw =
    process.env.WORDPRESS_BASE_URL ||
    process.env.BASE_URL ||
    process.env.WP_BASE_URL ||
    process.env.WP_API_URL;

  const username =
    process.env.WORDPRESS_USERNAME ||
    process.env.USERNAME ||
    process.env.WP_USERNAME ||
    process.env.WP_USER ||
    process.env.WP_API_USERNAME;

  const appPassword =
    process.env.WORDPRESS_APPLICATION_PASSWORD ||
    process.env.APPLICATION_PASSWORD ||
    process.env.WP_APPLICATION_PASSWORD ||
    process.env.WP_APP_PASSWORD ||
    process.env.WP_API_PASSWORD;

  const missing: string[] = [];
  if (!baseUrlRaw) missing.push('WORDPRESS_BASE_URL (o BASE_URL)');
  if (!username) missing.push('WORDPRESS_USERNAME (o USERNAME)');
  if (!appPassword) missing.push('WORDPRESS_APPLICATION_PASSWORD (o APPLICATION_PASSWORD)');

  if (missing.length > 0) {
    throw new Error(`[keytrends-wp-mcp] Faltan variables de entorno obligatorias: ${missing.join(', ')}`);
  }

  const baseUrl = baseUrlRaw!.replace(/\/+$/, '').replace(/\/wp-json\/?$/, '');

  const auth: WpAuth = {
    baseUrl,
    user: username!,
    appPassword: appPassword!,
    userAgent: process.env.WP_USER_AGENT,
    authMode: parseAuthMode(process.env.WP_AUTH_MODE),
  };

  return {
    auth,
    defaultLang: process.env.WP_DEFAULT_LANG,
    tz: process.env.WP_TIMEZONE ?? 'Europe/Madrid',
  };
}
