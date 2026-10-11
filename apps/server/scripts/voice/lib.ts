import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://api.elevenlabs.io/v1/convai';
const ENV_PATH = fileURLToPath(new URL('../../../../.env', import.meta.url));

export function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env`);
  return value;
}

export async function elevenlabs(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'xi-api-key': env('ELEVENLABS_API_KEY'), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as unknown) : {};
}

/** Writes a non-secret value (an ID) back into the root .env so later scripts pick it up. */
export function setEnv(key: string, value: string): void {
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, lines.join('\n'));
}
