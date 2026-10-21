import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpEnv } from './env.ts';
import { toolError } from './errors.ts';
import { isObj, wpGet, wpPost } from './lib/wp-http.ts';

export function registerPageTools(server: McpServer, env: McpEnv): void {
  // 1. wp_list_pages
  server.registerTool(
    'wp_list_pages',
    {
      title: 'Listar páginas de WordPress',
      description: 'Lista páginas (no posts) con context=edit (acceso a borradores, programadas y publicadas).',
      inputSchema: {
        status: z.string().optional().describe('Estado(s) separados por coma, ej: draft, future, publish (default: draft)'),
        search: z.string().optional().describe('Término de búsqueda'),
        include: z.array(z.number().int()).optional().describe('Limita el resultado a estos IDs de página'),
        parent: z.number().int().optional().describe('ID de la página padre'),
        per_page: z.number().int().min(1).max(100).optional().describe('Resultados por página (default: 20)'),
        page: z.number().int().min(1).optional().describe('Número de página (default: 1)'),
        lang: z.string().optional().describe('Código de idioma WPML (ej: es, en, fr)'),
        orderby: z.string().optional().describe('Campo de ordenación (default: date)'),
        order: z.enum(['asc', 'desc']).optional().describe('Dirección de orden (default: asc)'),
      },
    },
    async (params) => {
      try {
        const queryParams: Record<string, string | number> = {
          context: 'edit',
          status: params.status ?? 'draft',
          per_page: params.per_page ?? 20,
          page: params.page ?? 1,
          orderby: params.orderby ?? 'date',
          order: params.order ?? 'asc',
        };
        if (params.search) queryParams.search = params.search;
        if (params.include?.length) queryParams.include = params.include.join(',');
        if (params.parent !== undefined) queryParams.parent = params.parent;
        const effectiveLang = params.lang ?? env.defaultLang;
        if (effectiveLang) queryParams.wpml_language = effectiveLang;

        const res = await wpGet(env.auth, '/wp-json/wp/v2/pages', queryParams);
        const list = Array.isArray(res.data) ? res.data : [];
        const rows = list.map((item) => {
          const p = isObj(item) ? item : {};
          const titleObj = isObj(p.title) ? p.title : {};
          const title = typeof titleObj.raw === 'string' ? titleObj.raw : typeof titleObj.rendered === 'string' ? titleObj.rendered : '';
          return {
            id: p.id,
            title,
            status: p.status,
            date_gmt: p.date_gmt,
            author: p.author,
            parent: p.parent,
            slug: p.slug,
            lang: p.lang,
            link: p.link,
          };
        });

        const totalStr = res.total !== undefined ? `\ntotal: ${res.total}` : '';
        return {
          content: [{ type: 'text', text: `${JSON.stringify(rows, null, 2)}${totalStr}` }],
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 2. wp_get_page
  server.registerTool(
    'wp_get_page',
    {
      title: 'Obtener una página de WordPress por ID',
      description: 'Obtiene los detalles completos de una página (no post) incluyendo contenido en texto bruto/bloques y plantilla.',
      inputSchema: {
        id: z.number().int().describe('ID numérico de la página'),
      },
    },
    async ({ id }) => {
      try {
        const res = await wpGet(env.auth, `/wp-json/wp/v2/pages/${id}`, { context: 'edit' });
        const p = isObj(res.data) ? res.data : {};
        const titleObj = isObj(p.title) ? p.title : {};
        const contentObj = isObj(p.content) ? p.content : {};
        const excerptObj = isObj(p.excerpt) ? p.excerpt : {};

        const data = {
          id: p.id,
          title: typeof titleObj.raw === 'string' ? titleObj.raw : titleObj.rendered,
          content: typeof contentObj.raw === 'string' ? contentObj.raw : contentObj.rendered,
          excerpt: typeof excerptObj.raw === 'string' ? excerptObj.raw : excerptObj.rendered,
          status: p.status,
          date: p.date,
          date_gmt: p.date_gmt,
          modified_gmt: p.modified_gmt,
          author: p.author,
          parent: p.parent,
          menu_order: p.menu_order,
          template: p.template,
          featured_media: p.featured_media,
          meta: p.meta,
          slug: p.slug,
          lang: p.lang,
          link: p.link,
        };

        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 3. wp_update_page
  server.registerTool(
    'wp_update_page',
    {
      title: 'Actualizar página en WordPress',
      description: 'Actualiza campos de una página existente por ID (título, contenido, estado, slug, padre, plantilla). Con status=publish la publica.',
      inputSchema: {
        id: z.number().int().describe('ID numérico de la página a actualizar'),
        title: z.string().optional().describe('Nuevo título'),
        content: z.string().optional().describe('Nuevo contenido HTML o bloques'),
        excerpt: z.string().optional().describe('Nuevo extracto'),
        status: z.string().optional().describe('Nuevo estado (draft, future, publish, pending, private)'),
        author: z.number().int().optional().describe('Nuevo ID numérico de autor'),
        parent: z.number().int().optional().describe('Nuevo ID de página padre (0 = sin padre)'),
        template: z.string().optional().describe('Nueva plantilla de página (ej: elementor_canvas, "" = por defecto)'),
        date_gmt: z.string().optional().describe('Nueva fecha UTC YYYY-MM-DDTHH:MM:SS'),
        slug: z.string().optional().describe('Nuevo slug'),
        lang: z.string().optional().describe('Código de idioma WPML'),
      },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.content !== undefined) body.content = params.content;
        if (params.excerpt !== undefined) body.excerpt = params.excerpt;
        if (params.status !== undefined) body.status = params.status;
        if (params.author !== undefined) body.author = params.author;
        if (params.parent !== undefined) body.parent = params.parent;
        if (params.template !== undefined) body.template = params.template;
        if (params.date_gmt !== undefined) body.date_gmt = params.date_gmt;
        if (params.slug !== undefined) body.slug = params.slug;

        if (Object.keys(body).length === 0) {
          return {
            content: [{ type: 'text', text: 'Nada que actualizar: pasa al menos un campo además de id.' }],
            isError: true,
          };
        }

        // Solo se envía el idioma si se pide explícitamente: aplicar WP_DEFAULT_LANG en una edición podría reasignar el idioma de la página
        if (params.lang) body.wpml_language = params.lang;

        await wpPost(env.auth, `/wp-json/wp/v2/pages/${params.id}`, body);

        // Relectura de verificación
        const reread = await wpGet(env.auth, `/wp-json/wp/v2/pages/${params.id}`, { context: 'edit' });
        const p = isObj(reread.data) ? reread.data : {};
        const titleObj = isObj(p.title) ? p.title : {};
        const out = {
          id: p.id,
          title: typeof titleObj.raw === 'string' ? titleObj.raw : titleObj.rendered,
          status: p.status,
          date_gmt: p.date_gmt,
          author: p.author,
          parent: p.parent,
          template: p.template,
          slug: p.slug,
          link: p.link,
        };

        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 4. wp_replace_in_page
  server.registerTool(
    'wp_replace_in_page',
    {
      title: 'Reemplazar texto en el contenido de una página',
      description:
        'Aplica reemplazos exactos (find/replace) sobre el contenido bruto de una página sin tener que reenviarlo entero. ' +
        'Todo o nada: si algún texto no aparece el número de veces esperado, no se guarda nada.',
      inputSchema: {
        id: z.number().int().describe('ID numérico de la página'),
        replacements: z
          .array(
            z.object({
              find: z.string().min(1).describe('Texto exacto a buscar en el contenido bruto'),
              replace: z.string().describe('Texto de sustitución (vacío = borrar)'),
              count: z.number().int().min(1).optional().describe('Número exacto de apariciones esperadas (default: 1). Se reemplazan todas.'),
            }),
          )
          .min(1)
          .describe('Reemplazos a aplicar en orden'),
      },
    },
    async ({ id, replacements }) => {
      try {
        const res = await wpGet(env.auth, `/wp-json/wp/v2/pages/${id}`, { context: 'edit' });
        const p = isObj(res.data) ? res.data : {};
        const contentObj = isObj(p.content) ? p.content : {};
        if (typeof contentObj.raw !== 'string') {
          return { content: [{ type: 'text', text: 'No se pudo leer el contenido bruto de la página (content.raw).' }], isError: true };
        }

        let content = contentObj.raw;
        const applied: string[] = [];
        for (const [i, r] of replacements.entries()) {
          const expected = r.count ?? 1;
          const found = content.split(r.find).length - 1;
          if (found !== expected) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Reemplazo #${i + 1} abortado: se esperaban ${expected} apariciones y hay ${found}. No se ha guardado nada.\nfind: ${r.find.slice(0, 200)}`,
                },
              ],
              isError: true,
            };
          }
          content = content.split(r.find).join(r.replace);
          applied.push(`#${i + 1}: ${found}x`);
        }

        await wpPost(env.auth, `/wp-json/wp/v2/pages/${id}`, { content });

        // Relectura de verificación
        const reread = await wpGet(env.auth, `/wp-json/wp/v2/pages/${id}`, { context: 'edit' });
        const p2 = isObj(reread.data) ? reread.data : {};
        const content2 = isObj(p2.content) ? p2.content : {};
        const saved = content2.raw === content;
        const out = {
          id: p2.id,
          status: p2.status,
          applied,
          verified: saved,
          length_before: contentObj.raw.length,
          length_after: typeof content2.raw === 'string' ? content2.raw.length : undefined,
        };

        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: !saved };
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
