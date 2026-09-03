import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpEnv } from './env.ts';
import { toolError } from './errors.ts';
import { isObj, wpGet, wpGetAll } from './lib/wp-http.ts';
import {
  asCategory,
  asPost,
  resolveAuthorsWithFallback,
  resolveDefaultCategoryId,
  planRows,
  formatRows,
  applyRows,
} from './lib/schedule-core.ts';
import type { WpCategory } from './lib/schedule-core.ts';

export function registerScheduleTools(server: McpServer, env: McpEnv): void {
  server.registerTool(
    'wp_schedule_drafts',
    {
      title: 'Programar tanda editorial de borradores',
      description:
        'Toma los borradores pendientes de WordPress y los programa (status=future) distribuidos en N posts por día con autor alternante, categoría y fecha. Por defecto es dry-run (apply=false): no muta nada y muestra la tabla planificada.',
      inputSchema: {
        from: z.string().describe('Primer día de publicación, formato YYYY-MM-DD (debe ser hoy o fecha futura)'),
        authors: z.array(z.string()).length(2).describe('Exactamente dos autores alternantes: pasar ID numérico (recomendado), slug o nombre'),
        slots: z.array(z.string()).optional().describe("Horas de publicación por día en HH:MM (default: ['09:00','17:00'] = 2 posts/día)"),
        tz: z.string().optional().describe('Zona horaria para las horas de los slots (default: Europe/Madrid)'),
        lang: z.string().optional().describe('Código de idioma WPML opcional (ej: es, en, fr)'),
        only: z.array(z.number().int()).optional().describe('Filtrar solo estos IDs específicos de post'),
        limit: z.number().int().min(1).optional().describe('Máximo número de posts a procesar'),
        category_map: z.record(z.string(), z.string()).optional().describe('Mapa explícito de categoría por post: clave = ID del post, valor = ID numérico o slug de la categoría'),
        apply: z.boolean().optional().describe('false (default) = solo simulación (dry-run); true = muta los posts en WordPress a status=future'),
      },
    },
    async (params) => {
      try {
        const fromArg = params.from;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) {
          return {
            content: [{ type: 'text', text: 'Error: `from` debe tener formato YYYY-MM-DD.' }],
            isError: true,
          };
        }

        const todayIso = new Date().toISOString().slice(0, 10);
        if (fromArg < todayIso) {
          return {
            content: [{ type: 'text', text: `Error: \`from\` (${fromArg}) está en el pasado. WordPress publicaría de inmediato en vez de programar.` }],
            isError: true,
          };
        }

        const tz = params.tz ?? env.tz;
        const slots = params.slots && params.slots.length > 0 ? params.slots : ['09:00', '17:00'];
        const warnings: string[] = [];

        // 1. Comprobar permisos del usuario
        const me = await wpGet(env.auth, '/wp-json/wp/v2/users/me', { context: 'edit' });
        const meBody = isObj(me.data) ? me.data : {};
        const caps = isObj(meBody.capabilities) ? (meBody.capabilities as Record<string, unknown>) : {};
        if (caps.edit_others_posts !== true) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: El usuario autenticado no tiene la capability `edit_others_posts` (hace falta rol Editor o Administrador para asignar posts a otros autores).',
              },
            ],
            isError: true,
          };
        }

        // 2. Resolver autores
        const authors = await resolveAuthorsWithFallback(env.auth, params.authors, (msg) => warnings.push(msg));

        // 3. Resolver categorías
        const categoriesRaw = await wpGetAll(env.auth, '/wp-json/wp/v2/categories', { context: 'edit' });
        const categories = categoriesRaw.map(asCategory);
        const defaultCategoryId = await resolveDefaultCategoryId(env.auth, categories);

        // 4. Resolver mapa de categorías opcional
        const categoryMap = new Map<number, number>();
        if (params.category_map) {
          for (const [postIdStr, value] of Object.entries(params.category_map)) {
            const postId = Number(postIdStr);
            const asId = Number(value);
            let match: WpCategory | undefined;
            if (Number.isFinite(asId) && String(asId) === value) {
              match = categories.find((c) => c.id === asId);
            } else {
              match = categories.find((c) => c.slug === value);
            }
            if (!match) {
              const valid = categories.map((c) => `${c.id} (${c.slug})`).join(', ');
              return {
                content: [
                  {
                    type: 'text',
                    text: `Error en category_map: "${value}" (post ${postId}) no es una categoría válida en este WordPress. Categorías disponibles: ${valid}`,
                  },
                ],
                isError: true,
              };
            }
            categoryMap.set(postId, match.id);
          }
        }

        // 5. Obtener posts (draft y future para idempotencia)
        const effectiveLang = params.lang ?? env.defaultLang;
        const statusParam = effectiveLang
          ? { status: 'draft,future', wpml_language: effectiveLang }
          : { status: 'draft,future' };

        const postsRaw = await wpGetAll(env.auth, '/wp-json/wp/v2/posts', {
          ...statusParam,
          context: 'edit',
          orderby: 'date',
          order: 'asc',
        });
        let posts = postsRaw.map(asPost);
        posts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

        if (params.only && params.only.length > 0) {
          const onlySet = new Set(params.only);
          posts = posts.filter((p) => onlySet.has(p.id));
        }
        if (params.limit !== undefined) {
          posts = posts.slice(0, params.limit);
        }

        if (posts.length === 0) {
          return {
            content: [{ type: 'text', text: 'No hay posts que procesar (0 borradores tras aplicar filtros).' }],
          };
        }

        // 6. Planificar
        const rows = planRows(posts, {
          from: fromArg,
          slots,
          tz,
          authors,
          categoryMap,
          defaultCategoryId,
        });

        const tableText = formatRows(rows);
        const toSchedule = rows.filter((r) => r.action === 'programar').length;

        const outLines: string[] = [tableText, ''];

        if (warnings.length > 0) {
          outLines.push('Avisos:');
          warnings.forEach((w) => outLines.push(`- ${w}`));
          outLines.push('');
        }

        if (params.apply !== true) {
          outLines.push(`[SIMULACIÓN (dry-run)] ${toSchedule}/${rows.length} posts se programarían si pasas apply=true.`);
          outLines.push('No se ha modificado ningún post en WordPress.');
          return { content: [{ type: 'text', text: outLines.join('\n') }] };
        }

        // 7. Aplicar mutaciones
        const logs: string[] = [];
        const result = await applyRows(env.auth, rows, (msg) => logs.push(msg));

        outLines.push('Resultado de aplicación:');
        logs.forEach((l) => outLines.push(l));
        outLines.push('');
        outLines.push(`[APLICADO] ${result.ok}/${result.attempted} posts programados con éxito.`);

        if (result.failures.length > 0) {
          outLines.push('');
          outLines.push('Fallos:');
          result.failures.forEach((f) => outLines.push(`- ${f}`));
        }

        return {
          content: [{ type: 'text', text: outLines.join('\n') }],
          isError: result.failures.length > 0 && result.ok === 0,
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
