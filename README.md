# Offload

**Turn an unwanted object into a reviewable listing. Let an agent sort the messages. Keep the decisions.**

Offload is a prototype for reducing the attention cost of second-hand transactions. It separates what a photo or seller message supports from what remains unknown, then asks the owner to make the decision.

## Demo

- Live application: <https://offload-eta.vercel.app>
- Current 2:59 narrated submission demo: [`demo/v2/Offload-demo-v2.mp4`](demo/v2/Offload-demo-v2.mp4).
- It shows the latest live application, including original seller messages and pickup terms beside Find decisions, with the product vision, Meta model roles and demo-run API estimate.
- The sample is synthetic; buyer personas are simulated; Find intake is manual. Accelerated waits and typing are labeled. Native Facebook Marketplace integration is the ambition, not an existing feature. See [`demo/v2/README.md`](demo/v2/README.md) for scope and [`demo/v2/VERIFICATION.json`](demo/v2/VERIFICATION.json) for measured export properties.
- Older walkthrough files in `demo/` remain historical evidence, not the current submission video.

## What works

- **Sell:** A photo becomes a reviewable listing draft. Spark proposes structured facts and questions; SAM 3.1 makes an object cutout; Muse Image creates a comparison hero; approximate visible wear is shown alongside the original. The owner reviews unknowns and approves before five simulated buyer personas exercise the conversation agent. Qualified offers become owner-only Yes/No cards.
- **Find:** The owner describes a need and manually enters a seller message and optional photo. The app checks item identity, requested attributes, price/currency, condition evidence and pickup details. Missing evidence prompts a question; incompatibilities are rejected.
- **Decision authority:** Models cannot accept offers. Decisions are atomic and persist within an anonymous signed browser session.

Find does not search a marketplace or contact sellers. The app does not publish listings, send external messages, transfer payment or complete a binding transaction. Simulated counterparts and in-app approvals are not real deals. The prototype has not established real-world time savings.

## Run locally

Requires Node.js 24+ and npm. SQLite and image processing use native dependencies.

```sh
npm ci
OFFLOAD_MOCK=1 npm run dev -- --hostname 127.0.0.1
```

Open <http://127.0.0.1:3000>. Explicit mock mode uses fixtures. Live API mode requires a server-side `MODEL_API_KEY`; hosted deployments also require `DATABASE_URL` and `OFFLOAD_SESSION_SECRET`. Never place secrets in `NEXT_PUBLIC_*` variables or commit local environment files. Optional configuration: `OFFLOAD_MOCK=1` only for the labeled fixture mode, `OFFLOAD_DAILY_OPERATIONS`, `OFFLOAD_DAILY_BUDGET_USD`, and local-only `OFFLOAD_DB_PATH`.

To run the unit suite:

```sh
OFFLOAD_MOCK=1 npm test
```

For architecture and boundaries, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The checked-in demo assets include the captioned master and its edit metadata; the unmodified private browser recording state is not part of this repository.

## Meta models

The application calls Meta Standard models through the Meta Model API: Muse Spark 1.3, SAM 3.1, Muse Image 1.0 and Muse Voice Transcribe. See [Meta Model API documentation](https://dev.meta.ai/docs/overview) and [SAM documentation](https://dev.meta.ai/docs/overview#sam-3). No alternate provider fallback is used.

## License

Project code is MIT-licensed; third-party dependencies and media retain their respective licenses. See [`LICENSE`](LICENSE).
