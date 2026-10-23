import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpEnv } from './env.ts';
import { toolError } from './errors.ts';
import { isObj, wpDelete, wpGet, wpGetAll, wpPost } from './lib/wp-http.ts';

/*
 * Menús de navegación (wp/v2/menus, wp/v2/menu-items, wp/v2/menu-locations).
 * Requieren un usuario con edit_theme_options (Administrador).
 *
 * Deliberadamente NO hay tool para asignar menús a ubicaciones del tema: eso
 * cambia la cabecera pública del sitio y se hace a mano desde wp-admin.
 */

const rawOrRendered = (x: unknown): unknown => {
  const o = isObj(x) ? x : {};
  return typeof o.raw === 'string' ? o.raw : o.rendered;
};

function menuItemRow(item: unknown) {
  const m = isObj(item) ? item : {};
  return {
    id: m.id,
    title: rawOrRendered(m.title),
    url: m.url,
    parent: m.parent,
    menu_order: m.menu_order,
    type: m.type,
    object: m.object,
    object_id: m.object_id,
    classes: Array.isArray(m.classes) ? m.classes.filter((c) => c !== '') : [],
    description: m.description,
    attr_title: m.attr_title,
    target: m.target,
    status: m.status,
  };
}

type MenuItemRow = ReturnType<typeof menuItemRow>;
type MenuItemNode = MenuItemRow & { children: MenuItemNode[] };

/** Árbol padre→hijos ordenado por menu_order (la REST lo devuelve plano). */
function buildTree(rows: MenuItemRow[]): MenuItemNode[] {
  const nodes = new Map<unknown, MenuItemNode>();
  for (const r of rows) nodes.set(r.id, { ...r, children: [] });
  const roots: MenuItemNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent ? nodes.get(n.parent) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const byOrder = (a: MenuItemNode, b: MenuItemNode) => Number(a.menu_order) - Number(b.menu_order);
  const sortDeep = (list: MenuItemNode[]) => {
    list.sort(byOrder);
    for (const n of list) sortDeep(n.children);
  };
  sortDeep(roots);
  return roots;
}

const itemFields = {
  title: z.string().describe('Texto visible del enlace'),
  url: z.string().optional().describe('URL (solo para type=custom; usa "#" para cabeceras de columna sin enlace)'),
  type: z.enum(['custom', 'post_type', 'taxonomy']).optional().describe('Tipo de item (default: custom)'),
  object: z.string().optional().describe('Para post_type/taxonomy: page, post, category…'),
  object_id: z.number().int().optional().describe('Para post_type/taxonomy: ID del objeto enlazado'),
  menu_order: z.number().int().min(1).optional().describe('Posición dentro del menú (1 = primero)'),
  classes: z.array(z.string()).optional().describe('Clases CSS del item (p. ej. kt-new, kt-promo)'),
  description: z.string().optional().describe('Descripción del item'),
  attr_title: z.string().optional().describe('Atributo title del enlace'),
  target: z.enum(['', '_blank']).optional().describe('"_blank" para abrir en pestaña nueva'),
};

type ItemInput = {
  title: string;
  url?: string;
  type?: 'custom' | 'post_type' | 'taxonomy';
  object?: string;
  object_id?: number;
  menu_order?: number;
  classes?: string[];
  description?: string;
  attr_title?: string;
  target?: '' | '_blank';
};

function itemBody(menu: number, parent: number, i: ItemInput): Record<string, unknown> {
  const type = i.type ?? 'custom';
  const body: Record<string, unknown> = { menus: menu, parent, title: i.title, type, status: 'publish' };
  // Las cabeceras de columna suelen venir con url vacía: WP la exige en items custom
  if (type === 'custom') body.url = i.url || '#';
  if (i.object !== undefined) body.object = i.object;
  if (i.object_id !== undefined) body.object_id = i.object_id;
  if (i.menu_order !== undefined) body.menu_order = i.menu_order;
  if (i.classes !== undefined) body.classes = i.classes;
  if (i.description !== undefined) body.description = i.description;
  if (i.attr_title !== undefined) body.attr_title = i.attr_title;
  if (i.target !== undefined) body.target = i.target;
  return body;
}

export function registerMenuTools(server: McpServer, env: McpEnv): void {
  // 1. wp_list_menus
  server.registerTool(
    'wp_list_menus',
    {
      title: 'Listar menús de navegación',
      description: 'Lista los menús de WordPress con sus ubicaciones del tema asignadas, y las ubicaciones disponibles.',
      inputSchema: {},
    },
    async () => {
      try {
        const [menus, locations] = await Promise.all([
          wpGetAll(env.auth, '/wp-json/wp/v2/menus', { context: 'edit' }),
          wpGet(env.auth, '/wp-json/wp/v2/menu-locations', { context: 'edit' }),
        ]);
        const rows = menus.map((item) => {
          const m = isObj(item) ? item : {};
          return { id: m.id, name: m.name, slug: m.slug, description: m.description, locations: m.locations, auto_add: m.auto_add };
        });
        const locs = isObj(locations.data)
          ? Object.values(locations.data).map((l) => {
              const o = isObj(l) ? l : {};
              return { name: o.name, description: o.description, menu: o.menu };
            })
          : [];
        return { content: [{ type: 'text', text: JSON.stringify({ menus: rows, locations: locs }, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 2. wp_get_menu
  server.registerTool(
    'wp_get_menu',
    {
      title: 'Obtener un menú con sus items',
      description: 'Devuelve un menú y todos sus items como árbol (padre → hijos, ordenados por menu_order).',
      inputSchema: {
        id: z.number().int().describe('ID del menú'),
        flat: z.boolean().optional().describe('true = lista plana en vez de árbol (default: false)'),
      },
    },
    async ({ id, flat }) => {
      try {
        const [menu, items] = await Promise.all([
          wpGet(env.auth, `/wp-json/wp/v2/menus/${id}`, { context: 'edit' }),
          wpGetAll(env.auth, '/wp-json/wp/v2/menu-items', { menus: id, context: 'edit', orderby: 'menu_order', order: 'asc' }),
        ]);
        const m = isObj(menu.data) ? menu.data : {};
        const rows = items.map(menuItemRow);
        const out = {
          id: m.id,
          name: m.name,
          slug: m.slug,
          locations: m.locations,
          count: rows.length,
          items: flat ? rows : buildTree(rows),
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 3. wp_create_menu
  server.registerTool(
    'wp_create_menu',
    {
      title: 'Crear un menú de navegación',
      description: 'Crea un menú vacío SIN asignarlo a ninguna ubicación del tema (no aparece en el sitio hasta asignarlo en wp-admin).',
      inputSchema: {
        name: z.string().describe('Nombre del menú (único)'),
        description: z.string().optional().describe('Descripción del menú'),
      },
    },
    async ({ name, description }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (description !== undefined) body.description = description;
        const created = await wpPost(env.auth, '/wp-json/wp/v2/menus', body);
        const m = isObj(created) ? created : {};
        return { content: [{ type: 'text', text: JSON.stringify({ id: m.id, name: m.name, slug: m.slug, locations: m.locations }, null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 4. wp_add_menu_items
  server.registerTool(
    'wp_add_menu_items',
    {
      title: 'Añadir items a un menú (en lote, con jerarquía)',
      description:
        'Crea varios items en orden. Cada item puede llevar `ref` y colgar de otro con `parent_ref` (creado antes en el mismo lote) ' +
        'o de un item existente con `parent` (ID). Si un item falla se detiene y devuelve lo creado hasta ese momento.',
      inputSchema: {
        menu: z.number().int().describe('ID del menú'),
        items: z
          .array(
            z.object({
              ...itemFields,
              ref: z.string().optional().describe('Alias local para referenciar este item como padre de otros del lote'),
              parent_ref: z.string().optional().describe('ref de un item anterior del lote que será el padre'),
              parent: z.number().int().optional().describe('ID de un item ya existente que será el padre (default: 0 = raíz)'),
            }),
          )
          .min(1)
          .describe('Items a crear, padres antes que hijos'),
      },
    },
    async ({ menu, items }) => {
      const created: { ref?: string; id: unknown; title: string; parent: number }[] = [];
      const refs = new Map<string, number>();
      try {
        for (const [i, item] of items.entries()) {
          let parent = item.parent ?? 0;
          if (item.parent_ref !== undefined) {
            const resolved = refs.get(item.parent_ref);
            if (resolved === undefined) {
              return {
                content: [
                  { type: 'text', text: `Item #${i + 1} (${item.title}): parent_ref "${item.parent_ref}" no existe en el lote.\ncreados: ${JSON.stringify(created, null, 2)}` },
                ],
                isError: true,
              };
            }
            parent = resolved;
          }
          const res = await wpPost(env.auth, '/wp-json/wp/v2/menu-items', itemBody(menu, parent, item));
          const r = isObj(res) ? res : {};
          if (item.ref !== undefined && typeof r.id === 'number') refs.set(item.ref, r.id);
          created.push({ ref: item.ref, id: r.id, title: item.title, parent });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ menu, created }, null, 2) }] };
      } catch (e) {
        const err = toolError(e);
        err.content[0].text += `\n\nCreados antes del fallo (${created.length}): ${JSON.stringify(created, null, 2)}`;
        return err;
      }
    },
  );

  // 5. wp_update_menu_item
  server.registerTool(
    'wp_update_menu_item',
    {
      title: 'Actualizar un item de menú',
      description: 'Modifica un item existente (texto, URL, padre, orden, clases, descripción…) y lo relee para verificar.',
      inputSchema: {
        id: z.number().int().describe('ID del item'),
        title: z.string().optional(),
        url: itemFields.url,
        parent: z.number().int().optional().describe('Nuevo ID del item padre (0 = raíz)'),
        menu_order: itemFields.menu_order,
        classes: itemFields.classes,
        description: itemFields.description,
        attr_title: itemFields.attr_title,
        target: itemFields.target,
      },
    },
    async ({ id, ...fields }) => {
      try {
        const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (Object.keys(body).length === 0) {
          return { content: [{ type: 'text', text: 'Nada que actualizar: pasa al menos un campo además de id.' }], isError: true };
        }
        await wpPost(env.auth, `/wp-json/wp/v2/menu-items/${id}`, body);
        const reread = await wpGet(env.auth, `/wp-json/wp/v2/menu-items/${id}`, { context: 'edit' });
        return { content: [{ type: 'text', text: JSON.stringify(menuItemRow(reread.data), null, 2) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // 6. wp_delete_menu_items
  server.registerTool(
    'wp_delete_menu_items',
    {
      title: 'Borrar items de menú',
      description: 'Borra definitivamente los items indicados (los items de menú no tienen papelera). Sus hijos suben un nivel.',
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe('IDs de los items a borrar'),
      },
    },
    async ({ ids }) => {
      const deleted: number[] = [];
      try {
        for (const id of ids) {
          await wpDelete(env.auth, `/wp-json/wp/v2/menu-items/${id}`, { force: 'true' });
          deleted.push(id);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ deleted }, null, 2) }] };
      } catch (e) {
        const err = toolError(e);
        err.content[0].text += `\n\nBorrados antes del fallo: ${JSON.stringify(deleted)}`;
        return err;
      }
    },
  );
}
