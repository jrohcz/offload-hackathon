import { NextRequest } from "next/server";
import { initializeSession, csrfFor, setSessionCookie, json, apiError } from "@/lib/session";
import { getMode } from "@/lib/meta/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try { const session = initializeSession(request); const response = json({ csrfToken: csrfFor(session.id), mode: getMode() }); setSessionCookie(response, session.cookie); return response; }
  catch (error) { return apiError(error); }
}
