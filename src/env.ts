import type { WpAuth } from './lib/wp-http.ts';

export interface McpEnv {
  auth: WpAuth;
  defaultLang?: string;
  tz: string;
}

export function envConfig(): McpEnv {
  const baseUrlRaw = process.env.WORDPRESS_BASE_URL;
  const username = process.env.WORDPRESS_USERNAME;
  const appPassword = process.env.WORDPRESS_APPLICATION_PASSWORD;

  const missing: string[] = [];
  if (!baseUrlRaw) missing.push('WORDPRESS_BASE_URL');
  if (!username) missing.push('WORDPRESS_USERNAME');
  if (!appPassword) missing.push('WORDPRESS_APPLICATION_PASSWORD');

  if (missing.length > 0) {
    throw new Error(`[keytrends-wp-mcp] Faltan variables de entorno obligatorias: ${missing.join(', ')}`);
  }

  const baseUrl = baseUrlRaw!.replace(/\/+$/, '').replace(/\/wp-json\/?$/, '');

  const auth: WpAuth = {
    baseUrl,
    user: username!,
    appPassword: appPassword!,
    userAgent: process.env.WP_USER_AGENT,
  };

  return {
    auth,
    defaultLang: process.env.WP_DEFAULT_LANG,
    tz: process.env.WP_TIMEZONE ?? 'Europe/Madrid',
  };
}
