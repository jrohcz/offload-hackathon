import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { mutateState, withCallLedger, listCalls } from "@/lib/db";
const COOKIE = "offload_session";
const MAX_AGE = 7 * 86400;
function secret() {
  if (process.env.OFFLOAD_SESSION_SECRET) return process.env.OFFLOAD_SESSION_SECRET;
  if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("Session signing is not configured");
  return "local-development-only-offload-secret";
}
function mac(text: string) { return createHmac("sha256", secret()).update(text).digest("hex"); }
function equal(a: string, b: string) { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export function sessionFromCookie(cookie?: string): string | null {
  if (!cookie) return null;
  const [id, issued, signature] = cookie.split(".");
  if (!/^[a-f0-9]{48}$/.test(id || "") || !/^\d+$/.test(issued || "") || !signature) return null;
  if (Date.now() - Number(issued) > MAX_AGE * 1000 || Number(issued) > Date.now() + 60000) return null;
  return equal(signature, mac(`${id}.${issued}`)) ? id : null;
}
export function csrfFor(id: string) { return mac(`csrf:${id}`); }
export function initializeSession(request: NextRequest) {
  const existing = sessionFromCookie(request.cookies.get(COOKIE)?.value);
  const id = existing ?? randomBytes(24).toString("hex"); const issued = String(Date.now());
  return { id, existing: Boolean(existing), cookie: `${id}.${issued}.${mac(`${id}.${issued}`)}` };
}
export function setSessionCookie(response: NextResponse, cookie: string) {
  response.cookies.set(COOKIE, cookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: MAX_AGE });
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function requireSession(request: NextRequest, write = false) {
  const id = sessionFromCookie(request.cookies.get(COOKIE)?.value);
  if (!id) throw new HttpError(401, "Your demo session expired. Reload the page to start again.");
  if (write) {
    const origin = request.headers.get("origin");
    if (origin && origin !== request.nextUrl.origin) throw new HttpError(403, "Cross-site request rejected");
    if (!equal(request.headers.get("x-offload-csrf") ?? "", csrfFor(id))) throw new HttpError(403, "Session verification failed. Reload and retry.");
  }
  return id;
}
export function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } }); }
export function apiError(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof Error && error.name === "ZodError") return json({ error: "Please check the supplied fields." }, 400);
  // Host-only diagnostics: never send provider errors, prompts or credentials
  // back to the visitor. Bound and redact the message before private logging.
  let detail = error instanceof Error ? error.message : "Unknown error";
  for (const value of [process.env.MODEL_API_KEY, process.env.DATABASE_URL, process.env.OFFLOAD_SESSION_SECRET]) {
    if (value) detail = detail.split(value).join("[redacted]");
  }
  detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/data:[^\s]+/g, "[image data]").slice(0, 300);
  console.error("Offload operation failed", { name: error instanceof Error ? error.name : "UnknownError", detail });
  return json({ error: "We could not confirm the operation. Reload to check your saved state before trying again." }, 503);
}
export async function limitedJson(request: Request) {
  const text = await request.text(); if (text.length > 100_000) throw new HttpError(413, "Request is too large");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Expected a JSON request"); }
}
export async function paidOperation<T>(request: NextRequest, sessionId: string, run: () => Promise<T>, paid = true): Promise<T> {
  const date = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limits: [string, number][] = [[`quota:${date}:global`, Number(process.env.OFFLOAD_DAILY_OPERATIONS || 250)], [`quota:${date}:ip:${mac(ip)}`, 35], [`quota:${date}:session:${sessionId}`, 35]];
  const lease = randomBytes(16).toString("hex");
  await mutateState(`${sessionId}:lease`, () => ({ until: 0, token: "" }), v => { if (v.until > Date.now()) throw new HttpError(409, "Another operation is still running in this session."); v.until = Date.now() + 360000; v.token = lease; });
  try {
    if (paid) for (const [key, max] of limits) await mutateState(key, () => ({ count: 0 }), v => { if (v.count >= max) throw new HttpError(429, "Today's live demo allowance is used. Please try again tomorrow."); v.count++; });
    if (!paid) return await run();
    const budgetKey = `budget:${date}`;
    const reserve = 3;
    await mutateState(budgetKey, () => ({ used: 0, reserved: 0 }), v => {
      if (v.used + v.reserved + reserve > Number(process.env.OFFLOAD_DAILY_BUDGET_USD || 120)) throw new HttpError(429, "The live demo's daily model budget has been reached.");
      v.reserved += reserve;
    });
    const before = (await listCalls(sessionId)).totalUsd;
    let completed = false;
    try { const value = await withCallLedger(sessionId, run); completed = true; return value; }
    finally {
      const after = (await listCalls(sessionId)).totalUsd;
      await mutateState(budgetKey, () => ({ used: 0, reserved: 0 }), v => { v.reserved = Math.max(0, v.reserved - reserve); v.used += completed ? Math.max(0, after - before) : reserve; });
    }
  } finally { await mutateState(`${sessionId}:lease`, () => ({ until: 0, token: "" }), v => { if (v.token === lease) v.until = 0; }); }
}
