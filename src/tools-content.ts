import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpEnv } from './env.ts';
import { toolError } from './errors.ts';
import { isObj, wpAnon, wpGet, wpGetAll, wpPost, WpHttpError, probeAuthTransport, type AuthProbe } from './lib/wp-http.ts';

export function registerContentTools(server: McpServer, env: McpEnv): void {
  // 1. wp_diagnose
  server.registerTool(
    'wp_diagnose',
    {
      title: 'Diagnóstico de acceso a WordPress',
      description: 'Ejecuta comprobaciones deterministas contra el WordPress (anónimas y autenticadas) y devuelve un veredicto con su remedio.',
      inputSchema: {},
    },
    async () => {
      try {
        const out: string[] = [];
        out.push(`[wp_diagnose] base=${env.auth.baseUrl} user=${env.auth.user}`);

        // Check 1: índice anónimo
        const c1 = await wpAnon(env.auth.baseUrl, '/wp-json/', undefined, env.auth.userAgent);
        const c1ok = c1.status === 200;
        const c1body = isObj(c1.body) ? c1.body : {};
        const authBlock = isObj(c1body.authentication) ? c1body.authentication : {};
        const hasAppPasswords = 'application-passwords' in authBlock;
        const namespaces = Array.isArray(c1body.namespaces) ? c1body.namespaces : [];
        out.push(`[1] GET /wp-json/ (índice, anónimo): ${c1ok ? 'PASS' : 'FAIL'}`);
        out.push(`    status=${c1.status}, app-passwords=${hasAppPasswords ? 'sí' : 'no'}, namespaces=${namespaces.length}`);

        // Check 2: posts públicos anónimos
        const c2 = await wpAnon(env.auth.baseUrl, '/wp-json/wp/v2/posts', { per_page: 1 }, env.auth.userAgent);
        const c2ok = c2.status === 200;
        out.push(`[2] GET /wp/v2/posts?per_page=1 (público, anónimo): ${c2ok ? 'PASS' : 'FAIL'} (status=${c2.status})`);

        // Check 3: users/me autenticado
        let c3ok = false;
        let c3err: WpHttpError | undefined;
        let c3body: Record<string, unknown> = {};
        try {
          const r = await wpGet(env.auth, '/wp-json/wp/v2/users/me', { context: 'edit' });
          c3body = isObj(r.data) ? r.data : {};
          c3ok = typeof c3body.id === 'number';
        } catch (e) {
          if (e instanceof WpHttpError) c3err = e;
        }
        const caps = isObj(c3body.capabilities) ? (c3body.capabilities as Record<string, unknown>) : {};
        out.push(`[3] GET /wp/v2/users/me?context=edit (autenticado): ${c3ok ? 'PASS' : 'FAIL'}`);
        if (c3ok) {
          out.push(`    user_id=${c3body.id}, name=${c3body.name}, roles=${JSON.stringify(c3body.roles ?? [])}, edit_posts=${caps.edit_posts === true}, edit_others=${caps.edit_others_posts === true}`);
        } else {
          out.push(`    status=${c3err?.status}, code=${c3err?.code}, detail=${c3err?.detail}`);
        }

        // Check 4: borradores autenticado
        let c4ok = false;
        let c4err: WpHttpError | undefined;
        let c4total: number | undefined;
        try {
          const r = await wpGet(env.auth, '/wp-json/wp/v2/posts', { status: 'draft', context: 'edit', per_page: 1 });
          c4total = r.total;
          c4ok = true;
        } catch (e) {
          if (e instanceof WpHttpError) c4err = e;
        }
        out.push(`[4] GET /wp/v2/posts?status=draft&context=edit (autenticado): ${c4ok ? 'PASS' : 'FAIL'}`);
        out.push(`    ${c4ok ? `total_drafts=${c4total ?? '?'}` : `status=${c4err?.status}, code=${c4err?.code}, detail=${c4err?.detail}`}`);

        // Check 5: users list autenticado
        let c5ok = false;
        let c5err: WpHttpError | undefined;
        try {
          await wpGet(env.auth, '/wp-json/wp/v2/users', { context: 'edit', per_page: 1 });
          c5ok = true;
        } catch (e) {
          if (e instanceof WpHttpError) c5err = e;
        }
        out.push(`[5] GET /wp/v2/users?context=edit (autenticado): ${c5ok ? 'PASS' : 'FAIL'}`);
        out.push(`    ${c5ok ? 'status=200' : `status=${c5err?.status}, code=${c5err?.code}, detail=${c5err?.detail}`}`);

        // Checks 6 y 7: sólo cuando la autenticación falló con 401, para no añadir latencia en sitios sanos.
        let probe: AuthProbe | undefined;
        if (!c3ok && c3err?.status === 401) {
          probe = await probeAuthTransport(env.auth, namespaces as string[]);
          out.push(
            `[6] Sonda Bearer (¿llega la cabecera Authorization a PHP?): ${probe.headerReachesPhp === true ? 'SÍ' : 'INDETERMINABLE'}`,
          );
          out.push(`[7] Oráculo jwt-auth/v1: ${probe.oracle}${probe.detail ? ` — ${probe.detail}` : ''}`);
        }

        type Verdict =
          | 'AUTH_OK'
          | 'AUTH_OK_USERS_BLOQUEADO'
          | 'AUTH_HEADER_O_CREDENCIAL'
          | 'CREDENCIAL_INVALIDA'
          | 'USUARIO_DESCONOCIDO'
          | 'BASIC_BLOQUEADO_JWT_OK'
          | 'WAF_O_IP_BLOQUEADA'
          | 'ROL_INSUFICIENTE'
          | 'INDETERMINADO';

        const remedios: Record<Verdict, string> = {
          AUTH_OK: 'Todo funciona correctamente: autenticación, borradores y acceso a usuarios listos para editar y programar.',
          AUTH_OK_USERS_BLOQUEADO:
            'La autenticación funciona (users/me y borradores responden bien), pero /wp/v2/users está bloqueado en este WordPress (rest_user_cannot_view). ' +
            'Pasa los autores como ID numérico de WordPress en vez de nombre/slug (ej: "4" o "12").',
          AUTH_HEADER_O_CREDENCIAL:
            '1. Regenera la Application Password en wp-admin → Usuarios → Perfil → Contraseñas de aplicación, cópiala tal cual (los espacios no importan) y pégala en WORDPRESS_APPLICATION_PASSWORD.\n' +
            '2. Si con una contraseña recién generada sigue fallando, el servidor web está descartando la cabecera Authorization antes de llegar a PHP. Lo tiene que aplicar quien administra el hosting: en IIS, una regla de URL Rewrite que fije HTTP_AUTHORIZATION y esa variable permitida en allowedServerVariables; en Apache/LiteSpeed, la regla equivalente en .htaccess.',
          CREDENCIAL_INVALIDA:
            'El usuario existe pero esa Application Password ya no es válida (revocada, regenerada o mal copiada): crea una nueva en wp-admin → Usuarios → Perfil → Contraseñas de aplicación y actualiza WORDPRESS_APPLICATION_PASSWORD.',
          USUARIO_DESCONOCIDO:
            'Este WordPress no reconoce ese nombre de usuario (verificado contra el validador del propio sitio). Usa el login exacto que aparece en wp-admin → Usuarios, no el nombre visible ni el email, en WORDPRESS_USERNAME.',
          BASIC_BLOQUEADO_JWT_OK:
            'Tu usuario y tu Application Password SON válidos: el validador del sitio los acepta. Lo que no se aplica es la autenticación Basic de la REST API, así que el problema está en el servidor o en los plugins del sitio, no en tu configuración. El hosting debe reenviar la cabecera Authorization a PHP (IIS: regla de URL Rewrite que fije HTTP_AUTHORIZATION más allowedServerVariables; Apache/LiteSpeed: la regla equivalente en .htaccess) o hay un plugin JWT interceptando Basic que debe desactivarse.',
          WAF_O_IP_BLOQUEADA:
            'El sitio devuelve 403 antes de llegar a WordPress: WAF/Cloudflare o IP no autorizada. Consulta tu IP actual en https://api.ipify.org y pide su alta en el canal del equipo del cliente.',
          ROL_INSUFICIENTE: 'El usuario autentica pero no tiene permisos de edición (edit_posts): sube su rol a Editor o Administrador en wp-admin.',
          INDETERMINADO: 'Ninguna combinación de comprobaciones coincide con un veredicto conocido: revisa la evidencia arriba.',
        };

        const waf =
          c1.status === 403 ||
          c2.status === 403 ||
          c3err?.status === 403 ||
          c4err?.status === 403 ||
          c5err?.status === 403;

        let verdict: Verdict;
        if (c3ok && c4ok && c5ok) {
          verdict = 'AUTH_OK';
        } else if (c3ok && c4ok && !c5ok && c5err?.status === 401 && c5err.code === 'rest_user_cannot_view') {
          verdict = 'AUTH_OK_USERS_BLOQUEADO';
        } else if (waf) {
          verdict = 'WAF_O_IP_BLOQUEADA';
        } else if (probe?.oracle === 'unknown_user') {
          verdict = 'USUARIO_DESCONOCIDO';
        } else if (probe?.oracle === 'bad_password') {
          verdict = 'CREDENCIAL_INVALIDA';
        } else if (probe?.oracle === 'ok') {
          verdict = 'BASIC_BLOQUEADO_JWT_OK';
        } else if (!c3ok && c3err?.status === 401 && (c3err.code === 'incorrect_password' || c3err.code === 'invalid_username')) {
          verdict = 'CREDENCIAL_INVALIDA';
        } else if (!c3ok && c3err?.status === 401 && c3err.code === 'rest_not_logged_in') {
          verdict = 'AUTH_HEADER_O_CREDENCIAL';
        } else if (
          (c3ok && !c4ok && c4err?.code === 'rest_invalid_param' && c4err.detail === 'rest_forbidden_status') ||
          (c3ok && caps.edit_posts !== true)
        ) {
          verdict = 'ROL_INSUFICIENTE';
        } else {
          verdict = 'INDETERMINADO';
        }

        out.push('');
        out.push(`VEREDICTO: ${verdict}`);
        if (remedios[verdict]) {
          out.push(`\nRemedio:\n${remedios[verdict]}`);
        }

        return { content: [{ type: 'text', text: out.join('\n') }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 2. wp_list_posts
  server.registerTool(
    'wp_list_posts',
    {
      title: 'Listar posts de WordPress',
      description: 'Lista posts con context=edit (acceso a borradores, programados y publicados).',
      inputSchema: {
        status: z.string().optional().describe('Estado(s) separados por coma, ej: draft, future, publish (default: draft)'),
        search: z.string().optional().describe('Término de búsqueda'),
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
        const effectiveLang = params.lang ?? env.defaultLang;
        if (effectiveLang) queryParams.wpml_language = effectiveLang;

        const res = await wpGet(env.auth, '/wp-json/wp/v2/posts', queryParams);
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
            categories: p.categories,
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

  // 3. wp_get_post
  server.registerTool(
    'wp_get_post',
    {
      title: 'Obtener un post de WordPress por ID',
      description: 'Obtiene los detalles completos de un post incluyendo contenido en texto bruto/bloques.',
      inputSchema: {
        id: z.number().int().describe('ID numérico del post'),
      },
    },
    async ({ id }) => {
      try {
        const res = await wpGet(env.auth, `/wp-json/wp/v2/posts/${id}`, { context: 'edit' });
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
          author: p.author,
          categories: p.categories,
          tags: p.tags,
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

  // 4. wp_create_post
  server.registerTool(
    'wp_create_post',
    {
      title: 'Crear post en WordPress',
      description: 'Crea un post nuevo en WordPress (por defecto como borrador, o programado/publicado si se indica).',
      inputSchema: {
        title: z.string().describe('Título del post'),
        content: z.string().describe('Contenido HTML o bloques Gutenberg del post'),
        excerpt: z.string().optional().describe('Extracto o resumen del post'),
        status: z.string().optional().describe('Estado: draft (default), future, publish, pending, private'),
        author: z.number().int().optional().describe('ID numérico del autor en WordPress'),
        categories: z.array(z.number().int()).optional().describe('IDs numéricos de categorías'),
        tags: z.array(z.number().int()).optional().describe('IDs numéricos de etiquetas'),
        date_gmt: z.string().optional().describe('Fecha y hora de publicación en UTC, formato YYYY-MM-DDTHH:MM:SS'),
        slug: z.string().optional().describe('Slug de la URL del post'),
        lang: z.string().optional().describe('Código de idioma WPML (ej: es, en, fr)'),
      },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {
          title: params.title,
          content: params.content,
          status: params.status ?? 'draft',
        };
        if (params.excerpt !== undefined) body.excerpt = params.excerpt;
        if (params.author !== undefined) body.author = params.author;
        if (params.categories !== undefined) body.categories = params.categories;
        if (params.tags !== undefined) body.tags = params.tags;
        if (params.date_gmt !== undefined) body.date_gmt = params.date_gmt;
        if (params.slug !== undefined) body.slug = params.slug;
        const effectiveLang = params.lang ?? env.defaultLang;
        if (effectiveLang) body.wpml_language = effectiveLang;

        const res = await wpPost(env.auth, '/wp-json/wp/v2/posts', body);
        const p = isObj(res) ? res : {};
        const out = {
          id: p.id,
          status: p.status,
          link: p.link,
          date_gmt: p.date_gmt,
          author: p.author,
          categories: p.categories,
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 5. wp_update_post
  server.registerTool(
    'wp_update_post',
    {
      title: 'Actualizar post en WordPress',
      description: 'Actualiza campos de un post existente por ID (título, contenido, autor, categorías, fecha, estado).',
      inputSchema: {
        id: z.number().int().describe('ID numérico del post a actualizar'),
        title: z.string().optional().describe('Nuevo título'),
        content: z.string().optional().describe('Nuevo contenido HTML o bloques'),
        excerpt: z.string().optional().describe('Nuevo extracto'),
        status: z.string().optional().describe('Nuevo estado (draft, future, publish, etc)'),
        author: z.number().int().optional().describe('Nuevo ID numérico de autor'),
        categories: z.array(z.number().int()).optional().describe('Nuevos IDs de categorías'),
        tags: z.array(z.number().int()).optional().describe('Nuevos IDs de etiquetas'),
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
        if (params.categories !== undefined) body.categories = params.categories;
        if (params.tags !== undefined) body.tags = params.tags;
        if (params.date_gmt !== undefined) body.date_gmt = params.date_gmt;
        if (params.slug !== undefined) body.slug = params.slug;
        const effectiveLang = params.lang ?? env.defaultLang;
        if (effectiveLang) body.wpml_language = effectiveLang;

        if (Object.keys(body).length === 0) {
          return {
            content: [{ type: 'text', text: 'Nada que actualizar: pasa al menos un campo además de id.' }],
            isError: true,
          };
        }

        await wpPost(env.auth, `/wp-json/wp/v2/posts/${params.id}`, body);

        // Relectura de verificación
        const reread = await wpGet(env.auth, `/wp-json/wp/v2/posts/${params.id}`, { context: 'edit' });
        const p = isObj(reread.data) ? reread.data : {};
        const titleObj = isObj(p.title) ? p.title : {};
        const out = {
          id: p.id,
          title: typeof titleObj.raw === 'string' ? titleObj.raw : titleObj.rendered,
          status: p.status,
          date_gmt: p.date_gmt,
          author: p.author,
          categories: p.categories,
          link: p.link,
        };

        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 6. wp_list_users
  server.registerTool(
    'wp_list_users',
    {
      title: 'Listar usuarios de WordPress',
      description: 'Lista los usuarios disponibles con su ID, nombre, slug y roles.',
      inputSchema: {},
    },
    async () => {
      try {
        const raw = await wpGetAll(env.auth, '/wp-json/wp/v2/users', { context: 'edit' });
        const rows = raw.map((item) => {
          const u = isObj(item) ? item : {};
          return {
            id: u.id,
            name: u.name,
            slug: u.slug,
            roles: Array.isArray(u.roles) ? u.roles : [],
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 7. wp_list_categories
  server.registerTool(
    'wp_list_categories',
    {
      title: 'Listar categorías de WordPress',
      description: 'Lista las categorías del sitio con su ID, slug, nombre y conteo de posts.',
      inputSchema: {},
    },
    async () => {
      try {
        const raw = await wpGetAll(env.auth, '/wp-json/wp/v2/categories', { context: 'edit' });
        const rows = raw.map((item) => {
          const c = isObj(item) ? item : {};
          return {
            id: c.id,
            slug: c.slug,
            name: c.name,
            count: c.count,
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
