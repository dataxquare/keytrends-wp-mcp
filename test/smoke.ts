#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const ROOT = join(import.meta.dir, '..');
const BIN_PATH = join(ROOT, 'bin/keytrends-wp-mcp.js');

const env: Record<string, string> = {
  ...process.env,
  WORDPRESS_BASE_URL: process.env.WORDPRESS_BASE_URL ?? 'https://lizarte.com/blog',
  WORDPRESS_USERNAME: process.env.WORDPRESS_USERNAME ?? 'smoke_user',
  WORDPRESS_APPLICATION_PASSWORD: process.env.WORDPRESS_APPLICATION_PASSWORD ?? 'dummy dummy dummy dummy',
};

console.log(`[smoke] Probando binario: ${BIN_PATH}`);

const child = spawn('node', [BIN_PATH], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) console.error(`[mcp stderr] ${s}`);
});

const rl = createInterface({ input: child.stdout });

let nextId = 1;
const pending = new Map<number, (res: JsonRpcResponse) => void>();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const json = JSON.parse(trimmed) as JsonRpcResponse;
    if (json.id !== undefined && pending.has(json.id)) {
      const cb = pending.get(json.id)!;
      pending.delete(json.id);
      cb(json);
    }
  } catch {}
});

function sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  const { promise, resolve, reject } = Promise.withResolvers<JsonRpcResponse>();

  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Timeout en método: ${method}`));
  }, 20000);

  pending.set(id, (res) => {
    clearTimeout(timer);
    resolve(res);
  });

  child.stdin.write(JSON.stringify(payload) + '\n');
  return promise;
}

function sendNotification(method: string, params?: Record<string, unknown>): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
}

async function run(): Promise<void> {
  try {
    // 1. Initialize
    const initRes = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-tester', version: '1.0.0' },
    });
    if (initRes.error) throw new Error(`initialize error: ${JSON.stringify(initRes.error)}`);
    const serverName = (initRes.result?.serverInfo as { name?: string })?.name;
    if (serverName !== 'keytrends-wp') throw new Error(`Nombre inesperado: ${serverName}`);
    console.log(`✓ serverInfo.name === '${serverName}'`);

    // 2. Initialized
    sendNotification('notifications/initialized');

    // 3. Tools list
    const toolsRes = await sendRequest('tools/list');
    if (toolsRes.error) throw new Error(`tools/list error: ${JSON.stringify(toolsRes.error)}`);
    const tools = (toolsRes.result?.tools as Array<{ name: string }>) ?? [];
    const names = tools.map((t) => t.name);
    console.log(`✓ Tools registradas (${names.length}): ${names.join(', ')}`);

    const expected = [
      'wp_diagnose',
      'wp_list_posts',
      'wp_get_post',
      'wp_create_post',
      'wp_update_post',
      'wp_list_users',
      'wp_list_categories',
      'wp_schedule_drafts',
    ];
    for (const exp of expected) {
      if (!names.includes(exp)) throw new Error(`Falta tool: ${exp}`);
    }
    console.log(`✓ Las 8 tools verificadas.`);

    child.kill();
    process.exit(0);
  } catch (err) {
    console.error('Fallo en smoke test:', err);
    child.kill();
    process.exit(1);
  }
}

run();
