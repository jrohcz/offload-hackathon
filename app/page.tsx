"use client";

import { useEffect, useRef, useState } from "react";
import type { DealCard, Mode, OwnerPolicy, SellPipelineResult, SimulationResult } from "@/lib/types";
import type { FindState } from "@/lib/find";

function resampleMono(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const length = Math.round(input.length * toRate / fromRate);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const source = index * fromRate / toRate;
    const left = Math.floor(source);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = source - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function encodeWav(input: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + input.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + input.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, input.length * 2, true);
  for (let index = 0; index < input.length; index += 1) view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, input[index])) * 0x7fff, true);
  return buffer;
}


async function downscalePhoto(file: File): Promise<File> {
  // Phone photos routinely exceed the serverless request limit. Re-encode
  // large files even when their dimensions are already below the long edge.
  if (!file.type.startsWith("image/") || file.size < 1_500_000) return file;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  } finally { bitmap?.close(); }
}

type SavedSell = Omit<SellPipelineResult, "raw"> & {
  ownerPolicy?: OwnerPolicy;
  voice?: { transcript?: string } | null;
  approved: boolean;
  samplePhoto?: boolean;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

/** Decode error responses safely: hosting errors may be HTML, not JSON. */
async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error
      : `The server could not finish this request (${response.status}). Please try again.`);
  }
  if (body === null) throw new Error("The server returned an unreadable response. Please try again.");
  return body as T;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [result, setResult] = useState<SavedSell | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [cards, setCards] = useState<DealCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [findBusy, setFindBusy] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [mode, setMode] = useState<Mode | null>(null);
  const [recording, setRecording] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [findError, setFindError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [find, setFind] = useState<FindState | null>(null);
  const [need, setNeed] = useState("");
  const [budget, setBudget] = useState("");
  const [mustWork, setMustWork] = useState(true);
  const [sellerMessage, setSellerMessage] = useState("");
  const [sellerFile, setSellerFile] = useState<File | null>(null);
  const [activeRequestId, setActiveRequestId] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const csrfToken = useRef("");
  // Refs close the small gap between a click and React's disabled render.
  const restoreLock = useRef(false);
  const sellLock = useRef(false);
  const findLock = useRef(false);
  const sellerPhotoInput = useRef<HTMLInputElement | null>(null);
  const recordingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function api<T>(url: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (init?.method && init.method !== "GET") {
      if (!csrfToken.current) throw new Error("Your session is not ready. Reload your session and try again.");
      headers.set("X-Offload-CSRF", csrfToken.current);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    try {
      return await readResponse<T>(await fetch(url, { ...init, headers, signal: controller.signal, credentials: "same-origin", cache: "no-store" }));
    } catch (failure) {
      if (failure instanceof TypeError) throw new Error("Connection lost. Your input is still here. Reconnect and try again.");
      if (failure instanceof DOMException && failure.name === "AbortError") throw new Error("The request took too long. Reload to check whether it completed before trying again.");
      throw failure;
    } finally { clearTimeout(timeout); }
  }

  function restoreSession() {
    if (restoreLock.current) return;
    restoreLock.current = true;
    // State updates are response callbacks, not synchronous effect work.
    void api<{ csrfToken: string; mode: Mode }>("/api/session")
      .then(async (session) => {
        csrfToken.current = session.csrfToken; setMode(session.mode);
        return Promise.all([
          api<{ sell: SavedSell | null }>("/api/sell"),
          api<{ cards: DealCard[]; simulation: SimulationResult | null }>("/api/inbox"),
          api<FindState>("/api/find"),
        ]);
      })
      .then(([saved, inbox, found]) => {
        setResult(saved.sell); setApproved(saved.sell?.approved ?? false);
        setCards(inbox.cards); setSimulation(inbox.simulation);
        setFind(found); setActiveRequestId(found.requests[0]?.id ?? "");
        setSessionReady(true);
      })
      .catch((failure: unknown) => { setError(errorMessage(failure)); })
      .finally(() => { restoreLock.current = false; setInitializing(false); });
  }

  function retrySession() {
    if (restoreLock.current) return;
    setInitializing(true); setError(""); setSessionReady(false);
    void restoreSession();
  }

  useEffect(() => {
    void restoreSession();
    return () => {
      if (recordingTimeout.current) clearTimeout(recordingTimeout.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
    };
    // The session is initialized once; its token lives in a ref for mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sellAction(action: () => Promise<void>) {
    if (sellLock.current || !sessionReady) return;
    sellLock.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { sellLock.current = false; setBusy(false); }
  }

  async function findAction(action: () => Promise<void>) {
    if (findLock.current || !sessionReady) return;
    findLock.current = true; setFindBusy(true); setFindError("");
    try { await action(); }
    catch (failure) { setFindError(errorMessage(failure)); }
    finally { findLock.current = false; setFindBusy(false); }
  }

  async function run(useDemo = false) {
    await sellAction(async () => {
      const form = new FormData();
      if (!useDemo && file) form.append("photo", await downscalePhoto(file));
      if (voiceFile) form.append("voice", voiceFile, voiceFile.name || "voice.wav");
      const body = await api<SavedSell>("/api/sell", { method: "POST", body: form });
      // Do not destroy the last useful draft when a replacement request fails.
      setResult(body); setMode(body.mode); setSimulation(null); setCards([]);
      setApproved(false); setAnswers({});
    });
  }

  async function startRecording() {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.current = [];
      const next = new MediaRecorder(stream);
      next.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      next.onstop = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        const recorded = new Blob(chunks.current, { type: next.mimeType || "audio/webm" });
        let context: AudioContext | null = null;
        try {
          context = new AudioContext();
          const decoded = await context.decodeAudioData(await recorded.arrayBuffer());
          const samples = resampleMono(decoded.getChannelData(0), decoded.sampleRate, 24_000);
          setVoiceFile(new File([encodeWav(samples, 24_000)], "voice-note.wav", { type: "audio/wav" }));
        } catch {
          // Keep the recording available for mock mode; real mode will return
          // the API's explicit unsupported-container error for this rare case.
          setVoiceFile(new File([recorded], "voice-note.webm", { type: recorded.type }));
        } finally { await context?.close().catch(() => undefined); }
      };
      recorder.current = next; next.start(); setRecording(true);
      recordingTimeout.current = setTimeout(() => { if (next.state === "recording") next.stop(); setRecording(false); }, 10_000);
    } catch { stream?.getTracks().forEach((track) => track.stop()); setError("Microphone unavailable. You can upload a short WAV voice note instead."); }
  }

  async function saveListing(next: SavedSell, nextApproved: boolean) {
    const saved = await api<{ sell: SavedSell }>("/api/sell", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listing: next.listing, ownerPolicy: next.ownerPolicy, approved: nextApproved }),
    });
    setResult(saved.sell); setApproved(saved.sell.approved);
    if (!nextApproved) { setSimulation(null); setCards([]); }
  }

  async function applyAnswers() {
    if (!result) return;
    const answered = result.listing.questions_for_owner.filter((question) => answers[question]?.trim());
    if (!answered.length) return;
    await sellAction(async () => {
      const newFacts = answered.map((question) => `Owner answer — ${question}: ${answers[question].trim()}`);
      const functionalQuestion = /^(does (it|the item) work|is (it|the item) (working|functional|in working order))\??$/i;
      const functionalAnswer = answered.find((question) => functionalQuestion.test(question.trim()) && /^(yes|no)[.!]?$/i.test(answers[question].trim()));
      if (functionalAnswer) newFacts.push(/^yes/i.test(answers[functionalAnswer].trim()) ? "Owner confirms: item works." : "Owner confirms: item does not work.");
      const functionalUnknown = /^(working (status|condition)|functionality|whether (it|the item) works|is (it|the item) (working|functional)|does (it|the item) work)[?.]?$/i;
      const initialDescription = result.listing.description.startsWith("Initial photo draft:")
        ? result.listing.description : `Initial photo draft: ${result.listing.description}`;
      const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const answeredKeys = new Set(answered.map(normalize));
      const next = {
        ...result,
        listing: {
          ...result.listing,
          description: `${initialDescription}\n\nOwner update: ${answered.map((question) => `${question} ${answers[question].trim()}`).join(" ")}`,
          facts_confirmed: [...result.listing.facts_confirmed, ...newFacts],
          // Only exact matches and the tightly scoped functional Q/A above
          // resolve unknowns; never infer that another detail was answered.
          facts_unknown: result.listing.facts_unknown.filter((fact) => !answeredKeys.has(normalize(fact)) && !(functionalAnswer && functionalUnknown.test(fact.trim())) ),
          questions_for_owner: result.listing.questions_for_owner.filter((question) => !answered.includes(question)),
        },
        ownerPolicy: result.ownerPolicy
          ? { ...result.ownerPolicy, facts: [...result.ownerPolicy.facts, ...newFacts] }
          : result.ownerPolicy,
      };
      await saveListing(next, false); setAnswers({});
    });
  }

  async function approveListing() {
    if (!result) return;
    await sellAction(() => saveListing(result, true));
  }

  async function createNeed() {
    await findAction(async () => {
      const form = new FormData();
      form.append("action", "request"); form.append("need", need); form.append("budget", budget);
      form.append("currency", "EUR"); form.append("mustWork", String(mustWork));
      const body = await api<{ find: FindState; request: { id: string } }>("/api/find", { method: "POST", body: form });
      setFind(body.find); setActiveRequestId(body.request.id); setNeed(""); setBudget("");
    });
  }

  async function submitOffer() {
    if (!activeRequestId) { setFindError("First save what you are looking for."); return; }
    await findAction(async () => {
      const form = new FormData();
      form.append("action", "offer"); form.append("requestId", activeRequestId); form.append("sellerMessage", sellerMessage);
      if (sellerFile) form.append("photo", await downscalePhoto(sellerFile));
      const body = await api<{ find: FindState }>("/api/find", { method: "POST", body: form });
      setFind(body.find); setSellerMessage(""); setSellerFile(null);
      if (sellerPhotoInput.current) sellerPhotoInput.current.value = "";
    });
  }

  async function decideOffer(cardId: string, decision: "yes" | "no") {
    await findAction(async () => {
      const form = new FormData();
      form.append("action", "decide"); form.append("cardId", cardId); form.append("decision", decision);
      const body = await api<{ find: FindState }>("/api/find", { method: "POST", body: form });
      setFind(body.find);
    });
  }

  async function runSimulation() {
    if (!result || !approved) return;
    await sellAction(async () => {
      const body = await api<SimulationResult>("/api/simulation", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      setSimulation(body); setCards(body.dealCards);
    });
  }

  async function decide(cardId: string, decision: "yes" | "no") {
    await sellAction(async () => {
      const body = await api<{ inbox: { cards: DealCard[]; simulation: SimulationResult | null } }>("/api/inbox", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decide", cardId, decision }),
      });
      setCards(body.inbox.cards); setSimulation(body.inbox.simulation);
    });
  }

  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="mark">O</span> offload</div><div className="header-right"><span className="metric">{simulation ? `${simulation.metrics.handledByAgent} handled · ${cards.length} decision cards` : "No decision cards yet"}</span><span className="mode-label">{mode === "real" ? "Live Meta API" : mode === "mock" ? "Mock mode · sample responses" : "Connecting…"}</span></div></header>
    <section className="hero"><div className="eyebrow">Sell, without the form and the chatter</div><h1>One photo.<br />One honest listing.</h1><p className="lede">Offload turns the thing you want gone into a listing you can approve in one tap. Visible wear stays visible. Unknowns become questions, never guesses.</p><div className="stamp" aria-hidden="true">Sold as seen</div></section>
    <section className="upload" aria-label="Upload an item photo">
      <div className="upload-copy"><label htmlFor="photo"><strong>{file ? file.name : "Choose a photo of the item"}</strong><span>Messy room photos welcome · JPG, PNG, WEBP</span><input disabled={busy} id="photo" type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><label htmlFor="voice"><strong>{voiceFile ? `Voice note: ${voiceFile.name}` : "Add a voice note (optional)"}</strong><span>Say what the photo cannot: works, minimum price, pickup windows</span><input disabled={busy || recording} id="voice" type="file" accept="audio/*,.wav" onChange={(event) => setVoiceFile(event.target.files?.[0] ?? null)} /></label></div>
      <div className="actions"><button className="button secondary" onClick={() => void run(true)} disabled={busy || !sessionReady || recording}>{busy ? "Working…" : "Try the demo item"}</button><button className="button secondary" onClick={() => recording ? (recorder.current?.stop(), setRecording(false)) : void startRecording()} disabled={busy || !sessionReady}>{recording ? "Stop recording" : "Record 10s note"}</button><button className="button" onClick={() => void run()} disabled={busy || !sessionReady || !file || recording}>{busy ? "Building listing…" : "Build my listing"}</button></div>
    </section>
    <div className="status" role="status" aria-live="polite">{error ? `Could not continue: ${error}` : initializing ? "Restoring your session…" : busy ? "Offload is working · checking facts · preparing an honest draft…" : result ? "Draft ready for your review." : ""}{!sessionReady && !initializing && <button className="button secondary" onClick={retrySession}>Reload session</button>}</div>
    {result && <section className="pipeline">
      <p className="mode-label">{result.mode === "mock" ? "This draft uses mock sample responses." : "This draft was generated with the live Meta API."}</p>
      <div className="card"><div className="eyebrow">three views, one truth</div><h2>The original stays in the room.</h2><div className="media-grid"><figure><img src={result.originalDataUrl} alt="Original item photo" /><figcaption>{result.samplePhoto ? "Synthetic sample photo · not a real seller item" : "Original photo"}</figcaption></figure><figure><img src={result.cutoutDataUrl} alt="SAM transparent cutout" /><figcaption>SAM 3.1 cutout</figcaption></figure><figure><img src={result.heroDataUrl} alt="Muse Image hero shot" /><figcaption>Muse Image hero shot</figcaption></figure></div></div>
      <div className="card condition"><div><div className="eyebrow">condition map</div><h2>Buyers see the wear.</h2><p className="lede">Spark grounded visible defects on the item mask. The visible map stays box-based because SAM is too coarse for thin cracks and scratches. No defect is removed from the original.</p>{result.condition.defects.map((defect, index) => <div className="fact-group" key={`${defect.label}-${index}`}><span className="pill">{index + 1} · {defect.label}</span></div>)}</div><img src={result.condition.overlayDataUrl} alt="Condition map with visible defect labels" /></div>
      <div className="card listing-grid"><div><div className="eyebrow">listing draft</div><h2>{result.listing.title}</h2><p className="lede">{result.listing.description}</p><span className="pill">{result.listing.category} · {result.listing.condition}</span>{result.voice?.transcript && <div className="voice-result"><strong>Owner voice note</strong><p>{result.voice.transcript}</p></div>}<button className="button approve" onClick={() => void approveListing()} disabled={busy || approved || !sessionReady}>{approved ? "Approved — ready for buyers" : "Approve listing in one tap"}</button></div><div className="facts"><div className="fact-group"><h3>Suggested price</h3>{result.listing.priceSuggestion && <><strong>{result.listing.priceSuggestion.range ? `${result.listing.priceSuggestion.currency} ${result.listing.priceSuggestion.range[0]}–${result.listing.priceSuggestion.range[1]}` : "Price estimate unavailable"}</strong><span className="muted">{result.listing.priceSuggestion.quick_sale !== null ? `Quick sale: ${result.listing.priceSuggestion.currency} ${result.listing.priceSuggestion.quick_sale}` : "No supported quick-sale estimate"}</span><ul>{result.listing.priceSuggestion.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul></>}</div><div className="fact-group"><h3>Recorded facts · photo and owner</h3><ul>{result.listing.facts_confirmed.map((fact) => <li key={fact}>{fact}</li>)}</ul></div><div className="fact-group"><h3>Still unknown</h3><ul>{result.listing.facts_unknown.map((fact) => <li key={fact}>{fact}</li>)}</ul></div><div className="fact-group"><h3>Owner questions</h3>{result.listing.questions_for_owner.length === 0 ? <span className="muted">All answered.</span> : result.listing.questions_for_owner.map((question) => <label className="owner-answer" key={question}><span>{question}</span><input value={answers[question] ?? ""} onChange={(event) => setAnswers({ ...answers, [question]: event.target.value })} placeholder="Your answer" maxLength={1000} disabled={busy} /></label>)}<button className="button secondary" onClick={() => void applyAnswers()} disabled={busy || !sessionReady || !Object.values(answers).some((value) => value.trim())}>Add answers to the listing</button></div></div></div>
      <div className="card agent-card"><div><div className="eyebrow">agent inbox</div><h2>Your decisions, in one place.</h2><p className="lede">Approve the draft, then let simulated counterparts test the conversation agent.</p></div><button className="button" onClick={() => void runSimulation()} disabled={!approved || busy || !sessionReady}>{busy ? "Running market…" : approved ? "Run simulation" : "Simulation locked"}</button>{simulation && <div className="simulation"><div className="metric-large">{simulation.metrics.handledByAgent} messages handled by the agent · {cards.length} decision cards</div>{simulation.personas.map((persona) => <div className="persona" key={persona.id}><strong>{persona.label}</strong><span>{persona.messages[0]?.text}</span><span className="agent-reply">{persona.messages[1]?.text}</span></div>)}</div>}</div>
      {cards.length > 0 && <div className="card inbox"><div className="eyebrow">yes / no inbox</div><h2>One tap when it matters.</h2>{cards.map((card) => <div className="deal-card" key={card.id}><div><strong>{card.summary}</strong><span>{card.question}</span><small className={`status-${card.status}`}>{card.status}</small></div><div className="actions"><button className="button approve" onClick={() => void decide(card.id, "yes")} disabled={busy || !sessionReady || card.status !== "pending"}>Yes</button><button className="button secondary" onClick={() => void decide(card.id, "no")} disabled={busy || !sessionReady || card.status !== "pending"}>No</button></div></div>)}</div>}
    </section>}
    <section className="card find-card"><div className="eyebrow">find · reverse listing</div><h2>Looking for something?</h2><p className="lede">Describe the need once. Test a seller offer below; only matching offers become a yes/no card. This demo does not search marketplaces or contact sellers.</p><div className="find-form"><label className="field-label"><span>What are you looking for?</span><input value={need} onChange={(event) => setNeed(event.target.value)} placeholder="Working turntable" aria-label="What are you looking for" maxLength={500} disabled={findBusy} /></label><label className="field-label"><span>Maximum price (EUR, optional)</span><input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" placeholder="Max EUR" aria-label="Maximum price in EUR" type="number" min="0" step="0.01" disabled={findBusy} /></label><label className="check"><input disabled={findBusy} type="checkbox" checked={mustWork} onChange={(event) => setMustWork(event.target.checked)} /> Must work</label><button className="button" onClick={() => void createNeed()} disabled={findBusy || !sessionReady || !need.trim()}>{findBusy ? "Working…" : "Save need"}</button></div><div className="status" role="status" aria-live="polite">{findError ? `Could not continue: ${findError}` : findBusy ? "Checking your request…" : ""}</div>{find && find.requests.length > 0 && <div className="find-offers"><h3>Test a seller offer</h3><label className="field-label"><span>Active need</span><select disabled={findBusy} value={activeRequestId} onChange={(event) => setActiveRequestId(event.target.value)} aria-label="Active need">{find.requests.map((request) => <option key={request.id} value={request.id}>{request.need}{request.budget !== null ? ` — up to ${request.currency} ${request.budget}` : ""}</option>)}</select></label><label className="field-label"><span>Seller message</span><textarea disabled={findBusy} value={sellerMessage} onChange={(event) => setSellerMessage(event.target.value)} placeholder="Seller message, e.g. Works well, EUR 120, pickup Saturday" aria-label="Seller message" maxLength={4000} /></label><label className="field-label"><span>Seller photo (optional)</span><input ref={sellerPhotoInput} disabled={findBusy} type="file" accept="image/*" onChange={(event) => setSellerFile(event.target.files?.[0] ?? null)} aria-label="Seller photo (optional)" /></label><button className="button secondary" onClick={() => void submitOffer()} disabled={findBusy || !sessionReady || !sellerMessage.trim()}>{findBusy ? "Evaluating…" : "Evaluate offer"}</button>{find.offers.filter((offer) => offer.requestId === activeRequestId).map((offer) => <div className="deal-card" key={offer.id}><div style={{ minWidth: 0 }}><strong>{offer.itemTitle ?? "Seller offer"}</strong><span>{offer.status === "qualified" ? offer.card?.summary : offer.status === "needs-info" ? `Needs: ${offer.questions.join(" ")}` : offer.reasons.join(" ")}</span>{offer.card && <><span><strong>Pickup:</strong> {offer.card.pickupSlot}</span><span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong>Seller message:</strong> {offer.sellerMessage}</span></>}<small className={`status-${offer.card?.status ?? offer.status}`}>{offer.card?.status ?? offer.status}</small></div>{offer.card && <div className="actions"><button className="button approve" onClick={() => void decideOffer(offer.card!.id, "yes")} disabled={findBusy || !sessionReady || offer.card.status !== "pending"}>Yes</button><button className="button secondary" onClick={() => void decideOffer(offer.card!.id, "no")} disabled={findBusy || !sessionReady || offer.card.status !== "pending"}>No</button></div>}</div>)}</div>}</section>
  </main>;
}
