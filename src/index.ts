#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { envConfig } from './env.ts';
import { registerContentTools } from './tools-content.ts';
import { registerScheduleTools } from './tools-schedule.ts';

async function main(): Promise<void> {
  let env;
  try {
    env = envConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[keytrends-wp-mcp] Error de configuración: ${msg}`);
    process.exit(1);
  }

  const server = new McpServer({
    name: 'keytrends-wp',
    version: '1.0.0',
  });

  registerContentTools(server, env);
  registerScheduleTools(server, env);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[keytrends-wp-mcp] Error fatal al iniciar el servidor:', err);
  process.exit(1);
});
