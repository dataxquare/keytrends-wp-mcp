# Keytrends WordPress MCP Server (`keytrends-wp-mcp`)

Servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) oficial de Keytrends para WordPress REST API.

Diseñado para resolver las limitaciones de los conectores genéricos de WordPress: permite **gestión completa de borradores, asignación de autor, taxonomías (categorías/etiquetas) y programación determinista de posts en tandas editoriales**.

---

## Características principales

- **Cero plugins en el WordPress del cliente:** Conecta directamente con la REST API estándar de WordPress (`wp/v2`).
- **Autenticación estándar:** Utiliza Application Passwords nativas de WordPress (HTTP Basic Auth).
- **Gestión editorial completa:**
  - `wp_diagnose`: Diagnóstico determinista de conectividad, permisos y estado de la API.
  - `wp_list_posts`: Lista posts (con soporte para borradores y estados privados vía `context=edit`).
  - `wp_get_post`: Obtiene contenido íntegro y bloques Gutenberg.
  - `wp_create_post`: Crea posts especificando autor, categorías, etiquetas, slug y fecha.
  - `wp_update_post`: Modifica posts existentes con verificación automática tras edición.
  - `wp_list_users`: Lista usuarios y roles para resolver IDs de autores.
  - `wp_list_categories`: Lista categorías disponibles con sus slugs e IDs.
  - `wp_schedule_drafts`: **Programación masiva determinista** de posts por día, slots horarios, rotación de autores y asignación de categorías con modo simulación (`apply=false` por defecto).

---

## Instalación y Uso

No requiere instalación manual previa. Puedes ejecutarlo directamente con `npx`:

### 1. Claude Desktop

Añade lo siguiente a tu archivo `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "keytrends-wp": {
      "command": "npx",
      "args": ["-y", "github:iDankest/keytrends-wp-mcp"],
      "env": {
        "WORDPRESS_BASE_URL": "https://tu-sitio.com",
        "WORDPRESS_USERNAME": "tu_usuario_wp",
        "WORDPRESS_APPLICATION_PASSWORD": "xxxx xxxx xxxx xxxx",
        "WP_DEFAULT_LANG": "es",
        "WP_TIMEZONE": "Europe/Madrid"
      }
    }
  }
}
```

### 2. Claude Code (CLI)

```bash
claude mcp add keytrends-wp \
  --env WORDPRESS_BASE_URL=https://tu-sitio.com \
  --env WORDPRESS_USERNAME=tu_usuario_wp \
  --env WORDPRESS_APPLICATION_PASSWORD="xxxx xxxx xxxx xxxx" \
  -- npx -y github:iDankest/keytrends-wp-mcp
```

### 3. Cursor

En `~/.cursor/mcp.json` o `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "keytrends-wp": {
      "command": "npx",
      "args": ["-y", "github:iDankest/keytrends-wp-mcp"],
      "env": {
        "WORDPRESS_BASE_URL": "https://tu-sitio.com",
        "WORDPRESS_USERNAME": "tu_usuario_wp",
        "WORDPRESS_APPLICATION_PASSWORD": "xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

### 4. Grok CLI (`~/.grok/config.toml`)

```toml
[mcp_servers.keytrends-wp]
command = "npx"
args = ["-y", "github:iDankest/keytrends-wp-mcp"]

[mcp_servers.keytrends-wp.env]
WORDPRESS_BASE_URL = "https://tu-sitio.com"
WORDPRESS_USERNAME = "tu_usuario_wp"
WORDPRESS_APPLICATION_PASSWORD = "xxxx xxxx xxxx xxxx"
```

---

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `WORDPRESS_BASE_URL` | **Sí** | URL base de la instalación de WordPress (ej: `https://lizarte.com/blog` o `https://vdenergy.es`). Sin `/wp-json`. |
| `WORDPRESS_USERNAME` | **Sí** | Nombre de usuario de WordPress. |
| `WORDPRESS_APPLICATION_PASSWORD` | **Sí** | Contraseña de aplicación generada desde WordPress (**Usuarios → Perfil → Contraseñas de aplicación**). |
| `WP_DEFAULT_LANG` | No | Código de idioma WPML por defecto (ej: `es`, `en`, `fr`). |
| `WP_TIMEZONE` | No | Zona horaria para cálculo de horas locales (por defecto `Europe/Madrid`). |
| `WP_USER_AGENT` | No | User-Agent personalizado para evitar bloqueos WAF. |

---

## Licencia

MIT © Keytrends
