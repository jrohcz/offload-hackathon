# Architecture

This document describes the Offload prototype implementation. For setup, demo
and current product boundaries, see the [README](../README.md).

## Stack and source map

Next.js App Router, React and TypeScript; the OpenAI-compatible SDK directed
to Meta; `@meta-sam/parser`; server-side `sharp`; Neon Postgres in hosted
mode, with SQLite for local development. Native modules use Node.js routes.

| Source | Responsibility |
|---|---|
| `app/page.tsx` | Listing review, voice input, simulated conversations and Find |
| `app/api/session/route.ts` | Signed browser-session initialization and CSRF token |
| `app/api/sell/route.ts` | Build/read a saved draft; save owner edits and approval |
| `app/api/simulation/route.ts` | Run against the session's approved saved listing |
| `app/api/inbox/route.ts` | Read and decide only this session's Sell cards |
| `app/api/find/route.ts` | Need creation, manual seller-offer evaluation and decisions |
| `lib/session.ts` | Session verification, CSRF, per-session lease, quotas/budget reservations |
| `lib/workspace.ts`, `lib/db.ts` | Workspace persistence, versioned atomic updates and usage ledger |
| `lib/pipeline.ts` | Raster validation, normalization, cutout, wear map and bounded display output |
| `lib/meta/*` | Meta capability clients; explicit mode selection and call accounting |
| `lib/agent.ts`, `lib/evidence.ts` | Validated tool dispatch and conservative monetary/condition/pickup evidence |
| `lib/find-evaluation.ts` | Typed semantic qualification with grounded quotes and deterministic vetoes |
| `lib/inbox.ts`, `lib/find.ts` | State transitions and owner-only card decisions |
| `lib/types.ts`, `lib/validation.ts`, `lib/api-schema.ts` | Types and runtime input/output schemas |
| `app/debug/page.tsx` | Session-scoped call metadata and estimated spend; no raw outputs |

## Sell pipeline

1. Decode actual raster bytes before calling a model. Reject empty, invalid,
   animated/vector or oversized inputs. Pipeline limits are 10 MiB, 40 MP and
   16,384 pixels per edge; HTTP upload limits are lower (currently 3.5 MB per
   photo). Apply EXIF orientation, preserve aspect ratio and limit the working
   image to 1600 pixels on its longest side. No retouching or cropping occurs.
2. Spark returns a runtime-validated listing with a concrete SAM concept.
   Only visible facts are photo evidence; unknown functionality remains a
   question for the owner.
3. SAM produces an object mask. Decode one-bit pixels to 0/255, scale from
   the provider frame and union returned regions. Missing masks fail visibly.
   `makeCutout` retains lossless PNG output for mask processing/regressions.
4. Spark's defect boxes are mapped into working-image coordinates and filtered
   against the item mask. The overlay is an approximate inspection aid, not
   a pixel-accurate trace or a complete defect guarantee.
5. Muse Image receives the cutout with a preservation prompt. Original and
   hero are shown together; generated output remains subject to review.
6. Price research runs concurrently with image work. Its rejection is handled
   immediately. Failed/unusable research returns a nullable estimate without
   discarding an otherwise usable listing. Structured prices require actual
   search/citation URLs and one currency; no source evidence means no estimate.
7. Original, cutout, hero and overlay receive high-quality bounded WebP display
   encodings, including alpha for the cutout. Each encoding is capped at
   700 KiB. These are display copies, not full-resolution archival originals.
   Raw provider responses are removed from the public saved Sell result.

Optional WAV input uses Muse Voice Transcribe and structured owner-policy
extraction. Owner statements retain their question/provenance; an untested
photo is not promoted into a confirmed working item by a substring match.
The owner reviews and approves the saved draft before simulation can begin.

## Conversation tools and owner authority

The conversation engine uses confirmed facts and owner policy, with typed
model tool arguments and local validation of every effect. Free model wording
cannot itself authorize a transaction. Owner decisions are not exposed as a
model tool. Unknown tools and unsupported factual claims are rejected or
escalated; eligible offers produce pending cards.

Five counterpart personas are simulated. There is no external marketplace
account, messaging transport or payment. The inbox decision route checks the
browser session, CSRF and pending state. An accepted Sell card reserves the
item within the demo and closes sibling pending offers atomically. An accepted
Find card fulfills that need and closes sibling offers. Repeated/conflicting
decisions return a conflict rather than overwriting the accepted state.

Approvals are **non-binding demo state**, not an external seller commitment.
The current workspace has one active Sell draft; creating a new one replaces
that active draft/inbox. Rerunning an unreserved simulation replaces its
simulated inbox. Find retains a bounded collection of needs and offers.

## Find qualification

Find takes a saved need plus a manually supplied seller message and optional
photo. It does not discover listings or contact sellers.

Real mode uses strict structured Spark output for identity, requested
attributes, working condition and pickup. Evidence quotes must occur in the
seller text or photo observations, not merely in the buyer's request.
Functionality and collection commitments require seller-text evidence; a
photo cannot confirm either. Deterministic money, negation and conflict checks
can veto a model's positive output.

A qualified offer needs a matching item and supported requested attributes,
an explicit price/currency compatible with the budget, confirmed functionality
when requested, and affirmative pickup timing. Missing/ambiguous facts yield
`needs-info`; clear incompatibilities yield `rejected`. A currency mismatch
asks for clarification: there is no silent renaming or FX conversion.
Explicit mock mode uses a deliberately limited conservative classifier.

## Persistent workspace and browser boundary

`DATABASE_URL` selects Neon Postgres. Vercel without it fails instead of
falling back to instance-local `/tmp`. Local development can use SQLite at
`OFFLOAD_DB_PATH` or `data/offload.db`. `offload_state` holds versioned JSON
records; compare-and-swap updates retry concurrent conflicts. A workspace
record has a 4,000,000-byte cap.

A signed anonymous `offload_session` cookie scopes saved listings, inbox,
Find data and usage. The cookie is HttpOnly, SameSite Strict and Secure in
production, with a seven-day age refreshed at session initialization. Writes
also verify origin when present and a session-bound CSRF token. Browser
responses use private/no-store caching. Production requires a signing secret.

This is isolation by browser session, **not account authentication**. There
is no cross-device sync, password recovery or retrieval after cookie loss.
Cookie expiration is not a promise that the database record was deleted;
a retention/deletion service is outside this prototype.

## Request and cost controls

Each session has a six-minute operation lease. Input schemas and payload
limits reject malformed work instead of silently launching a paid scenario.
Default daily expensive-operation limits are 35 per session, 35 per hashed IP
and 250 globally; the global count is configurable. Find also caps saved
needs (25) and offers (80) per workspace.

A global estimated daily budget defaults to USD 120. Each expensive operation
reserves USD 3 before starting, then accounts for recorded usage; failed
operations conservatively retain the reservation as estimated spend. These
are application controls, not a provider-enforced hard billing guarantee or
a measured remaining credit balance. Model timeouts and output/tool limits
bound individual calls; the provider's billing is authoritative.

The session ledger records capability/model/mode/estimated cost metadata,
keeps the latest 100 entries and maintains a cumulative session estimate.
Raw model output, image base64 and credentials are not stored in that ledger.

## Modes and verification

Only `OFFLOAD_MOCK=1` explicitly selects fixture behavior. Live mode requires
`MODEL_API_KEY` and uses Meta Standard models; no Contributor or alternate
provider fallback. SAM's temporary input upload is deleted in a `finally`
block and also has a provider expiry.

Fixtures, scripted model-response tests and spatial-mask regressions establish
specific local properties. They do not prove arbitrary model behavior,
hosted durability, a successful deployment or a real transaction. Release
acceptance separately checks live Sell/Find, owner decisions after reload,
two isolated browser sessions and negative cases on the deployed revision.
