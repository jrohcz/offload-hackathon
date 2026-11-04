import Database from "better-sqlite3";
import { neon } from "@neondatabase/serverless";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
let local: Database.Database | undefined;
let ready: Promise<void> | undefined;
type Row = Record<string, unknown>;
async function execute(statement: string, values: Array<string | number> = []): Promise<Row[]> {
  if (process.env.DATABASE_URL) {
    let i = 0; const sql = neon(process.env.DATABASE_URL);
    return await sql.query(statement.replace(/\?/g, () => `$${++i}`), values) as Row[];
  }
  if (process.env.VERCEL) throw new Error("Durable storage is not configured");
  if (!local) {
    const file = process.env.OFFLOAD_DB_PATH || path.join(process.cwd(), "data/offload.db");
    mkdirSync(path.dirname(file), { recursive: true }); local = new Database(file);
    local.pragma("busy_timeout = 5000"); local.pragma("journal_mode = WAL");
  }
  const query = local.prepare(statement);
  return query.reader ? query.all(...values) as Row[] : (query.run(...values), []);
}
async function init() {
  if (!ready) ready = execute("CREATE TABLE IF NOT EXISTS offload_state (key TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)").then(() => undefined).catch((e) => { ready = undefined; throw e; });
  return ready;
}
export async function getAppState<T>(key: string): Promise<T | null> {
  await init(); const rows = await execute("SELECT data FROM offload_state WHERE key = ?", [key]);
  return rows[0] ? JSON.parse(String(rows[0].data)) as T : null;
}
/** Compare-and-swap. Pure mutators may run again on conflict. */
export async function mutateState<T, R>(key: string, initial: () => T, mutate: (value: T) => R): Promise<{ value: T; result: R }> {
  await init();
  for (let attempt = 0; attempt < 12; attempt++) {
    const rows = await execute("SELECT version, data FROM offload_state WHERE key = ?", [key]);
    const value: T = rows[0] ? JSON.parse(String(rows[0].data)) : initial();
    const result = mutate(value); const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 4_000_000) throw new Error("Demo storage limit exceeded");
    const written = rows[0]
      ? await execute("UPDATE offload_state SET data = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ? RETURNING version", [serialized, new Date().toISOString(), key, Number(rows[0].version)])
      : await execute("INSERT INTO offload_state (key, version, data, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT (key) DO NOTHING RETURNING version", [key, serialized, new Date().toISOString()]);
    if (written.length) return { value, result };
  }
  throw new Error("Concurrent update; please retry");
}
export async function setAppState<T>(key: string, value: T) {
  await mutateState<{ value: T }, void>(`${key}:value`, () => ({ value }), record => { record.value = value; });
}
export async function readValue<T>(key: string) { return (await getAppState<{ value: T }>(`${key}:value`))?.value ?? null; }
export type CallEntry = { id: string; capability: string; model: string; mode: string; units: number; estimatedUsd: number; createdAt: string };
type Context = { sessionId: string; entries: CallEntry[] };
export const callContext = new AsyncLocalStorage<Context>();
export function recordCall(entry: { capability: string; model: string; mode: "mock" | "real"; units: number; estimatedUsd: number; rawOutput: unknown }) {
  const safe = { id: randomUUID(), capability: entry.capability, model: entry.model, mode: entry.mode, units: entry.units, estimatedUsd: entry.estimatedUsd, createdAt: new Date().toISOString() };
  callContext.getStore()?.entries.push(safe);
}
export async function withCallLedger<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return callContext.run({ sessionId, entries: [] }, async () => {
    try { return await fn(); }
    finally {
      const entries = callContext.getStore()!.entries;
      if (entries.length) await mutateState<{ entries: CallEntry[]; totalUsd: number }, void>(`${sessionId}:ledger`, () => ({ entries: [], totalUsd: 0 }), ledger => {
        ledger.entries.push(...entries); ledger.entries = ledger.entries.slice(-100);
        ledger.totalUsd += entries.reduce((n, e) => n + e.estimatedUsd, 0);
      });
    }
  });
}
export async function listCalls(sessionId: string) { return (await getAppState<{ entries: CallEntry[]; totalUsd: number }>(`${sessionId}:ledger`)) ?? { entries: [], totalUsd: 0 }; }
