// Edge TTS (unofficial) — Khmer voice Piseth / Sreymom តាម helper
// https://khmer-voice-1.onrender.com (Render free tier — call ដំបូងអាចយឺត ~60s ពេល server sleep)

export const EDGE_BASE = "https://khmer-voice-1.onrender.com";

export const VOICES = {
  m: "km-KH-PisethNeural", // Piseth — បុរស
  f: "km-KH-SreymomNeural", // Sreymom — ស្ត្រី
};

export function voiceFor(gender, mode) {
  if (mode === "piseth") return VOICES.m;
  if (mode === "sreymom") return VOICES.f;
  return gender === "f" ? VOICES.f : VOICES.m; // auto
}

export class TtsError extends Error {
  constructor(message) {
    super(message);
    this.name = "TtsError";
  }
}

function fetchTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() =>
    clearTimeout(t)
  );
}

// ពិនិត្យ helper ថា online ឬអត់
export async function pingEdge(timeoutMs = 15000) {
  try {
    const res = await fetchTimeout(`${EDGE_BASE}/ping`, {}, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}

async function ttsOnce(text, voice, timeoutMs = 60000) {
  let res;
  try {
    res = await fetchTimeout(
      `${EDGE_BASE}/tts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      },
      timeoutMs
    );
  } catch (e) {
    throw new TtsError(
      e.name === "AbortError"
        ? "Edge TTS timeout (server កំពុង wake up — សាកម្តងទៀត)"
        : `ភ្ជាប់ Edge TTS អត់បាន (${e.message})`
    );
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new TtsError(`Edge TTS ${res.status} ${msg.slice(0, 120)}`);
  }
  const blob = await res.blob();
  if (!blob || blob.size < 200)
    throw new TtsError("Edge TTS ត្រឡប់ audio មិនគ្រប់គ្រាន់");
  return blob;
}

// បំបែក text វែងជា chunks (split តាម space/សញ្ញាវណ្ណយុត្ត)
export function splitText(text, maxLen) {
  const t = (text || "").trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  const parts = t.split(/(?<=[។៕\.\!\?])\s+|\s+/);
  const chunks = [];
  let cur = "";
  for (const p of parts) {
    if (!p) continue;
    if ((cur + " " + p).trim().length > maxLen && cur) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur = (cur + " " + p).trim();
    }
  }
  if (cur) chunks.push(cur.trim());
  // បើនៅតែមាន chunk វែងជាង maxLen (ពាក្យតែមួយវែង) កាត់តាមតួអក្សរ
  const out = [];
  for (const c of chunks) {
    if (c.length <= maxLen) out.push(c);
    else for (let i = 0; i < c.length; i += maxLen) out.push(c.slice(i, i + maxLen));
  }
  return out;
}

async function decodeBlob(ctx, blob) {
  const buf = await blob.arrayBuffer();
  return ctx.decodeAudioData(buf);
}

function concatBuffers(ctx, buffers, gapSec = 0.12) {
  if (!buffers.length) return null;
  const rate = ctx.sampleRate;
  const gap = Math.floor(gapSec * rate);
  let total = 0;
  for (const b of buffers) total += b.length + gap;
  const out = ctx.createBuffer(1, total, rate);
  const ch = out.getChannelData(0);
  let off = 0;
  for (const b of buffers) {
    const src = b.numberOfChannels > 1 ? b.getChannelData(0) : b.getChannelData(0);
    // mix down stereo ទៅ mono បើចាំបាច់
    if (b.numberOfChannels > 1) {
      const r = b.getChannelData(1);
      for (let i = 0; i < b.length; i++) ch[off + i] = (src[i] + r[i]) / 2;
    } else {
      ch.set(src, off);
    }
    off += b.length + gap;
  }
  return out;
}

// Generate voice សម្រាប់ Khmer text មួយ line — ត្រឡប់ AudioBuffer (mono)
export async function ttsLine(text, voice, ctx, onStatus) {
  const clean = (text || "").trim();
  if (!clean) throw new TtsError("អត់មាន text សម្រាប់ TTS");
  // chunk 140 → 60 → 28 តាម docs
  let chunks = splitText(clean, 140);
  const buffers = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    onStatus?.(ci + 1, chunks.length);
    let lastErr = null;
    let done = false;
    // ព្យាយាម 3 ដង បើ chunk វែង ព្យាយាមបំបែកតូចជាង
    let sizes = [140, 60, 28];
    let attemptChunks = [chunk];
    for (const size of sizes) {
      if (done) break;
      if (size < 140) attemptChunks = splitText(chunk, size);
      for (const sub of attemptChunks) {
        for (let attempt = 0; attempt < 2 && !done; attempt++) {
          try {
            const blob = await ttsOnce(sub, voice, 60000);
            buffers.push(await decodeBlob(ctx, blob));
            done = true;
          } catch (e) {
            lastErr = e;
          }
        }
        if (done) break;
      }
    }
    if (!done) throw lastErr || new TtsError("Edge TTS បរាជ័យ");
  }
  const merged = concatBuffers(ctx, buffers);
  if (!merged) throw new TtsError("Edge TTS មិនបាន audio");
  return merged;
}
