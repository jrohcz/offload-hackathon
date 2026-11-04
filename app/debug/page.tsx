import { listCalls } from "@/lib/db";
import { sessionFromCookie } from "@/lib/session";
import { cookies } from "next/headers";
import Link from "next/link";
export const dynamic = "force-dynamic";
export default async function DebugPage() {
  const id = sessionFromCookie((await cookies()).get("offload_session")?.value);
  const ledger = id ? await listCalls(id) : { entries: [], totalUsd: 0 };
  return <main className="shell"><header className="topbar"><div className="brand">offload / your usage</div><Link className="nav" href="/">← Back to your items</Link></header><section className="hero"><h1>Your demo usage.</h1><p className="lede">Estimated ${ledger.totalUsd.toFixed(4)} in this browser session. This is an estimate, not a provider billing balance. Only the latest 100 records are shown; the total includes earlier calls.</p></section><div className="card"><table className="debug-table"><thead><tr><th>Capability</th><th>Model</th><th>Mode</th><th>Estimated USD</th></tr></thead><tbody>{ledger.entries.map(call => <tr key={call.id}><td>{call.capability}</td><td>{call.model}</td><td>{call.mode}</td><td>${call.estimatedUsd.toFixed(4)}</td></tr>)}</tbody></table>{!ledger.entries.length && <p>No recorded calls in this session.</p>}</div></main>;
}
