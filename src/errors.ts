import { WpHttpError } from './lib/wp-http.ts';

export function toolError(e: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  if (e instanceof WpHttpError) {
    let hint = '';

    const bodyStr = typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? '');
    const isHtmlOrNonJson = bodyStr.includes('<!DOCTYPE') || bodyStr.includes('<html');

    if (e.status === 401 && e.code === 'rest_not_logged_in') {
      hint = 'La petición no llegó autenticada: revisa WORDPRESS_USERNAME y WORDPRESS_APPLICATION_PASSWORD en la config del servidor MCP.';
    } else if (e.status === 401 && (e.code === 'incorrect_password' || e.code === 'invalid_username')) {
      hint = 'Credencial inválida: genera una Application Password nueva en wp-admin → Usuarios → Perfil.';
    } else if (e.status === 401 && e.code === 'rest_user_cannot_view') {
      hint = 'Este sitio bloquea /wp/v2/users; pasa los autores como ID numérico de WordPress.';
    } else if (e.status === 400 && e.code === 'rest_invalid_param' && e.detail === 'rest_forbidden_status') {
      hint = 'Tu usuario no puede ver ni editar borradores: hace falta rol Editor o Administrador.';
    } else if (e.status === 403) {
      hint = '403 desde fuera: WAF de Cloudflare o IP no dada de alta (Recambio Fácil exige alta de IP en el canal del equipo).';
    } else if (e.status === 404 && isHtmlOrNonJson) {
      hint = 'Respuesta no-JSON: comprueba que WORDPRESS_BASE_URL apunta al WordPress correcto (Lizarte vive en lizarte.com/blog, sin www).';
    }

    const baseMsg = `HTTP ${e.status} ${e.code}${e.detail ? ` — ${e.detail}` : ''}`;
    const text = hint ? `${baseMsg}\n\nPista: ${hint}` : baseMsg;

    return {
      content: [{ type: 'text', text }],
      isError: true,
    };
  }

  const text = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}
