import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpEnv } from './env.ts';
import { toolError } from './errors.ts';
import { DEFAULT_UA, isObj, wpGet, wpPost } from './lib/wp-http.ts';

/*
 * Rank Math guarda el SEO de cada post/página en post meta (rank_math_title, …)
 * que la REST estándar de WordPress no expone. Escribimos con el endpoint que usa
 * el propio editor de Rank Math (POST rankmath/v1/updateMeta) y, como no hay
 * endpoint de lectura del meta bruto, leemos lo que de verdad sirve la página
 * publicada en su <head>: es lo que ven Google y las redes.
 */

type ContentType = 'page' | 'post';

interface SeoHead {
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  og_title?: string;
  og_description?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function metaContent(head: string, attr: 'name' | 'property', key: string): string | undefined {
  const tags = head.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const k = tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i'))?.[1];
    if (k?.toLowerCase() !== key) continue;
    const c = tag.match(/\bcontent=(["'])([\s\S]*?)\1/i)?.[2];
    if (c !== undefined) return decodeEntities(c);
  }
  return undefined;
}

export function parseSeoHead(url: string, htmlDoc: string): SeoHead {
  const head = htmlDoc.split(/<\/head>/i)[0] ?? htmlDoc;
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const canonical = head.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1];
  return {
    url,
    title: title !== undefined ? decodeEntities(title.trim()) : undefined,
    description: metaContent(head, 'name', 'description'),
    canonical,
    robots: metaContent(head, 'name', 'robots'),
    og_title: metaContent(head, 'property', 'og:title'),
    og_description: metaContent(head, 'property', 'og:description'),
  };
}

async function publicLink(env: McpEnv, id: number, type: ContentType): Promise<{ link: string; status: string }> {
  const res = await wpGet(env.auth, `/wp-json/wp/v2/${type === 'page' ? 'pages' : 'posts'}/${id}`, {
    context: 'edit',
    _fields: 'id,link,status',
  });
  const d = isObj(res.data) ? res.data : {};
  return { link: String(d.link ?? ''), status: String(d.status ?? '') };
}

async function readLiveSeo(env: McpEnv, id: number, type: ContentType): Promise<SeoHead> {
  const { link, status } = await publicLink(env, id, type);
  if (status !== 'publish' || !link) {
    throw new Error(
      `El ${type} ${id} no está publicado (status=${status}): su SEO solo se puede leer de la página publicada.`,
    );
  }
  // Cache-buster para no leer una copia vieja de una caché de página.
  const url = `${link}${link.includes('?') ? '&' : '?'}kt_seo_check=${Date.now()}`;
  const res = await fetch(url, { headers: { 'user-agent': env.auth.userAgent ?? DEFAULT_UA } });
  if (!res.ok) throw new Error(`GET ${link} → HTTP ${res.status}`);
  return parseSeoHead(link, await res.text());
}

const typeSchema = z.enum(['page', 'post']).optional().describe("Tipo de contenido: 'page' (default) o 'post'");

export function registerRankMathTools(server: McpServer, env: McpEnv): void {
  // 1. wp_rankmath_get_seo
  server.registerTool(
    'wp_rankmath_get_seo',
    {
      title: 'Leer el SEO efectivo (Rank Math) de una página o post',
      description:
        'Devuelve el SEO que sirve la página publicada en su <head>: title, meta description, canonical, robots y Open Graph. ' +
        'Es el resultado final (título personalizado de Rank Math o la plantilla por defecto), no el meta bruto.',
      inputSchema: {
        id: z.number().int().describe('ID numérico de la página o post'),
        type: typeSchema,
      },
    },
    async (params) => {
      try {
        const seo = await readLiveSeo(env, params.id, params.type ?? 'page');
        return { content: [{ type: 'text', text: JSON.stringify({ id: params.id, ...seo }, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 2. wp_rankmath_update_seo
  server.registerTool(
    'wp_rankmath_update_seo',
    {
      title: 'Actualizar el SEO de Rank Math de una página o post',
      description:
        'Escribe los campos SEO de Rank Math (los del recuadro de Rank Math en el editor) vía rankmath/v1/updateMeta y ' +
        'relee la página publicada para verificar. Cadena vacía = borrar el valor personalizado y volver a la plantilla ' +
        'por defecto de Rank Math (p. ej. "%title% %sep% %sitename%"). Solo se envían los campos indicados.',
      inputSchema: {
        id: z.number().int().describe('ID numérico de la página o post'),
        type: typeSchema,
        title: z.string().optional().describe('SEO title (rank_math_title). Admite variables de Rank Math (%title%, %sep%, %sitename%). "" = por defecto'),
        description: z.string().optional().describe('Meta description (rank_math_description). "" = por defecto'),
        focus_keyword: z.string().optional().describe('Focus keyword(s) separadas por coma (rank_math_focus_keyword)'),
        canonical: z.string().optional().describe('URL canónica (rank_math_canonical_url). "" = por defecto'),
        robots: z
          .array(z.enum(['index', 'noindex', 'follow', 'nofollow', 'noarchive', 'noimageindex', 'nosnippet']))
          .optional()
          .describe('Directivas robots (rank_math_robots). [] = por defecto del sitio'),
        og_title: z.string().optional().describe('Título Open Graph / Facebook (rank_math_facebook_title). "" = por defecto'),
        og_description: z.string().optional().describe('Descripción Open Graph / Facebook (rank_math_facebook_description). "" = por defecto'),
      },
    },
    async (params) => {
      try {
        const type = params.type ?? 'page';
        const meta: Record<string, unknown> = {};
        if (params.title !== undefined) meta.rank_math_title = params.title;
        if (params.description !== undefined) meta.rank_math_description = params.description;
        if (params.focus_keyword !== undefined) meta.rank_math_focus_keyword = params.focus_keyword;
        if (params.canonical !== undefined) meta.rank_math_canonical_url = params.canonical;
        if (params.robots !== undefined) meta.rank_math_robots = params.robots;
        if (params.og_title !== undefined) meta.rank_math_facebook_title = params.og_title;
        if (params.og_description !== undefined) meta.rank_math_facebook_description = params.og_description;

        if (Object.keys(meta).length === 0) {
          return {
            content: [{ type: 'text', text: 'Nada que actualizar: pasa al menos un campo SEO además de id.' }],
            isError: true,
          };
        }

        // Confirma que el ID existe y es del tipo indicado antes de escribir meta.
        await publicLink(env, params.id, type);

        let before: SeoHead | string;
        try {
          before = await readLiveSeo(env, params.id, type);
        } catch (e) {
          before = e instanceof Error ? e.message : String(e);
        }

        // Rank Math usa objectType "post" para cualquier post type (páginas incluidas).
        await wpPost(env.auth, '/wp-json/rankmath/v1/updateMeta', {
          objectType: 'post',
          objectID: params.id,
          meta,
        });

        let after: SeoHead | string;
        try {
          after = await readLiveSeo(env, params.id, type);
        } catch (e) {
          after = e instanceof Error ? e.message : String(e);
        }

        const out = { id: params.id, sent: meta, before, after };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
