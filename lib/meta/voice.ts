import voiceFixture from "@/fixtures/voice-transcribe.json";
import { getClient, getMode, logCall, VOICE_MODEL } from "@/lib/meta/client";

export async function transcribeVoice(audio: Buffer, fileName = "voice.wav") {
  const mode = getMode();
  if (mode === "mock") {
    logCall({ capability: "voice-transcribe", model: VOICE_MODEL, mode, raw: voiceFixture, units: 10 });
    return { result: voiceFixture, raw: voiceFixture };
  }
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({
    mode: "ENDPOINTING",
    model: VOICE_MODEL,
    audioEncoding: "WAV",
    languageBias: ["English"],
    keywords: ["Brno", "turntable", "record player", "dust cover", "lid", "pickup", "Saturday", "cracked"],
  })], { type: "application/json" }));
  form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), fileName);
  const response = await fetch("https://api.meta.ai/v1/asr/transcribe", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Voice Transcribe failed: ${response.status}`);
  const result = await response.json();
  logCall({ capability: "voice-transcribe", model: VOICE_MODEL, mode, raw: result, units: Number(result.audioDurationMs ?? 0) / 3_600_000, estimatedUsd: Number(result.audioDurationMs ?? 0) / 3_600_000 * 0.18 });
  return { result, raw: result };
}
