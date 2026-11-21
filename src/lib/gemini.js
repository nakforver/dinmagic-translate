// Gemini API — upload វីដេអូ/សំឡេងទៅ Files API ហើយ transcribe + translate ទៅ Khmer
// ប្រើ API key របស់អ្នកប្រើផ្ទាល់ (រក្សាក្នុង localStorage មិនផ្ញើទៅ server ផ្សេង)

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

export class GeminiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

function errMessage(status, data) {
  const detail = data?.error?.message || "";
  if (status === 400) return `Gemini 400 — model/key មិនត្រឹមត្រូវ. ${detail}`;
  if (status === 401 || status === 403)
    return `Gemini ${status} — API key មិនត្រឹមត្រូវ ឬគ្មានសិទ្ធិ. ${detail}`;
  if (status === 404) return `Gemini 404 — model មិនមាន. ${detail}`;
  if (status === 429)
    return `Gemini 429 — quota/rate limit អស់ហើយ សាកម្តងទៀតក្រោយបន្តិច. ${detail}`;
  if (status >= 500) return `Gemini ${status} — server error សាកម្តងទៀត. ${detail}`;
  return `Gemini error ${status}. ${detail}`;
}

async function geminiJson(url, { method = "GET", body = null } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : null,
    });
  } catch (e) {
    throw new GeminiError(`ភ្ជាប់ Gemini អត់បាន (${e.message}) — ពិនិត្យ internet`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new GeminiError(errMessage(res.status, data), res.status);
  return data;
}

// ពិនិត្យ key ថាប្រើបានឬអត់
export async function checkKey(apiKey) {
  const data = await geminiJson(
    `${API_BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=1`
  );
  return { ok: true, models: (data.models || []).length };
}

// Upload file ទៅ Gemini Files API (multipart) រួចរង់ចាំ state ACTIVE
export async function uploadFile(file, apiKey, onStatus) {
  const boundary = "----dinmagic" + Math.random().toString(36).slice(2);
  const meta =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ file: { displayName: file.name } }) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([meta, file, tail], {
    type: `multipart/related; boundary=${boundary}`,
  });

  onStatus?.("uploading");
  let res;
  try {
    res = await fetch(`${UPLOAD_BASE}/files?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "X-Goog-Upload-Protocol": "multipart" },
      body,
    });
  } catch (e) {
    throw new GeminiError(`Upload ទៅ Gemini អត់បាន (${e.message})`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new GeminiError(errMessage(res.status, data), res.status);
  const uploaded = data.file || data;
  if (!uploaded?.name) throw new GeminiError("Gemini upload មិនបានត្រឡប់ file name");

  // រង់ចាំ file ACTIVE (video ត្រូវការ processing)
  onStatus?.("processing");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const cur = await geminiJson(
      `${API_BASE}/${uploaded.name}?key=${encodeURIComponent(apiKey)}`
    );
    const state = cur.state || cur.file?.state;
    if (state === "ACTIVE") return { ...uploaded, ...(cur.file || cur) };
    if (state === "FAILED")
      throw new GeminiError("Gemini ដំណើរការ file បរាជ័យ — សាក file ផ្សេង");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new GeminiError("Gemini processing file យូរពេក — សាកម្តងទៀត");
}

const TRANSCRIBE_PROMPT = `Transcribe every spoken sentence in this video/audio and translate each one into natural conversational Khmer.
Return ONLY a JSON array. Each item must have exactly these fields:
{"s": start seconds (number), "e": end seconds (number), "g": "m" for a male speaker or "f" for a female speaker, "text": the original spoken sentence, "km": the Khmer translation}
Rules:
- Split by sentence and by speaker change. Keep each segment 12 seconds or shorter.
- Detect the speaker gender from the voice for "g".
- Translate to natural spoken Khmer, not word-by-word. Keep names as they sound.
- Do NOT invent lines that were not spoken. Skip silence and non-speech parts completely (no "no speech" lines).
- Use accurate start/end timestamps in seconds.`;

function cleanJsonText(text) {
  let t = (text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return t;
}

export function normalizeSegments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r, i) => {
      const s = Number(r.s ?? r.start ?? 0);
      let e = Number(r.e ?? r.end ?? s + 2);
      if (!isFinite(s) || s < 0) return null;
      if (!isFinite(e) || e <= s) e = s + 2;
      const km = String(r.km ?? r.khmer ?? "").trim();
      const text = String(r.text ?? r.original ?? "").trim();
      if (!km && !text) return null;
      return {
        id: `seg-${Date.now()}-${i}`,
        s,
        e,
        g: r.g === "f" ? "f" : "m",
        text,
        km: km || text,
        tts: null, // AudioBuffer ក្រោយ generate voice
        ttsState: "pending", // pending | loading | ok | error
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.s - b.s);
}

// Transcribe + translate វីដេអូ/សំឡេងមួយ file ទៅជា segments
export async function transcribeFile(file, apiKey, model, onStatus) {
  const uploaded = await uploadFile(file, apiKey, onStatus);
  try {
    onStatus?.("transcribing");
    const mimeType = uploaded.mimeType || file.type || "video/mp4";
    const data = await geminiJson(
      `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        body: {
          contents: [
            {
              role: "user",
              parts: [
                { fileData: { mimeType, fileUri: uploaded.uri } },
                { text: TRANSCRIBE_PROMPT },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
            maxOutputTokens: 8192,
          },
        },
      }
    );
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("");
    if (!text) {
      const reason =
        data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "";
      throw new GeminiError(
        `Gemini មិនបានត្រឡប់ transcript ទេ${reason ? ` (${reason})` : ""} — សាកម្តងទៀត ឬប្តូរ model`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(cleanJsonText(text));
    } catch {
      throw new GeminiError("Gemini ត្រឡប់ JSON មិនត្រឹមត្រូវ — សាកម្តងទៀត");
    }
    const segments = normalizeSegments(parsed);
    if (!segments.length)
      throw new GeminiError("Gemini រកមិនឃើញការនិយាយក្នុង file នេះទេ");
    return segments;
  } finally {
    // លុប file លើ Gemini ក្រោយប្រើរួច (best effort)
    try {
      await geminiJson(
        `${API_BASE}/${uploaded.name}?key=${encodeURIComponent(apiKey)}`,
        { method: "DELETE" }
      );
    } catch {
      /* ignore */
    }
  }
}
