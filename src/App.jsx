import { useState, useEffect, useRef, useCallback } from "react";
import "./app.css";
import { transcribeFile, checkKey, GeminiError } from "./lib/gemini";
import {
  pingEdge,
  ttsLine,
  voiceFor,
  TtsError,
} from "./lib/edgeTts";
import { segmentsToSrt, parseSrt, downloadText, fmtClock } from "./lib/srt";
import {
  audioBufferToWav,
  downloadBlob,
  getVideoGraph,
  DubPlayer,
  renderDubbedTrack,
} from "./lib/audio";
import { exportDubbedVideo, pickMimeType } from "./lib/exportVideo";

const STEPS = [
  "Start",
  "Upload",
  "ភាសា",
  "Processing",
  "Preview",
  "Export",
  "Exporting",
  "Done",
];

const MODEL_PRESETS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro", "gemini-2.5-flash"];
const LS_KEY = "dmt_gemini_key";
const LS_MODEL = "dmt_model";

const loadLS = (k, d) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};

export default function App() {
  const [step, setStep] = useState(0);
  const [apiKey, setApiKey] = useState(() => loadLS(LS_KEY, ""));
  const [model, setModel] = useState(() => loadLS(LS_MODEL, "gemini-3.8-flash"));
  const [keyState, setKeyState] = useState(null); // null | "ok" | "bad" | "checking"
  const [file, setFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [voiceMode, setVoiceMode] = useState("auto"); // auto | piseth | sreymom
  const [origVolume, setOrigVolume] = useState(20); // %
  const [segments, setSegments] = useState([]);
  const [stage, setStage] = useState("idle"); // idle|transcribing|tts|ready|exporting|done|error
  const [log, setLog] = useState([]);
  const [error, setError] = useState("");
  const [ttsProgress, setTtsProgress] = useState({ done: 0, total: 0 });
  const [quality, setQuality] = useState("1080p");
  const [audioOnly, setAudioOnly] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResult, setExportResult] = useState(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [busy, setBusy] = useState(false);

  const videoRef = useRef(null);
  const ctxRef = useRef(null);
  const playerRef = useRef(null);
  const logEndRef = useRef(null);
  const exportCtlRef = useRef(null);

  const addLog = useCallback((text) => {
    setLog((l) => [...l.slice(-29), { t: new Date().toLocaleTimeString(), text }]);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [log]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, apiKey);
    } catch {
      /* ignore */
    }
  }, [apiKey]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_MODEL, model);
    } catch {
      /* ignore */
    }
  }, [model]);

  useEffect(() => () => videoUrl && URL.revokeObjectURL(videoUrl), [videoUrl]);

  // AudioContext + DubPlayer (បង្កើតក្រោយ user gesture)
  const ensureAudio = useCallback(() => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new AC();
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    if (!playerRef.current && videoRef.current) {
      playerRef.current = new DubPlayer(ctxRef.current, videoRef.current);
    }
    return ctxRef.current;
  }, []);

  // sync dubbed playback ជាមួយ video play/pause
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => {
      if (previewOn && playerRef.current) playerRef.current.play(segments);
    };
    const onPause = () => playerRef.current?.pause();
    const onLoaded = () => setDuration(v.duration || 0);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("loadedmetadata", onLoaded);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [videoUrl, previewOn, segments]);

  useEffect(() => () => playerRef.current?.destroy(), []);

  const handleFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(f);
    setVideoUrl(URL.createObjectURL(f));
    setSegments([]);
    setExportResult(null);
    setStage("idle");
    setError("");
    setPreviewOn(false);
    addLog(`បានជ្រើស file៖ ${f.name}`);
  };

  const handleCheckKey = async () => {
    if (!apiKey.trim()) {
      setError("សូមបញ្ចូល Gemini API key សិន");
      return;
    }
    setKeyState("checking");
    setError("");
    try {
      await checkKey(apiKey.trim());
      setKeyState("ok");
      addLog("Gemini key ប្រើបាន ✓");
    } catch (e) {
      setKeyState("bad");
      setError(e.message || "Key មិនត្រឹមត្រូវ");
    }
  };

  const updateSeg = (id, patch) => {
    setSegments((segs) =>
      segs.map((s) => (s.id === id ? { ...s, ...patch } : s))
    );
  };

  const runTranscribe = async () => {
    if (!file) {
      setError("សូមជ្រើសវីដេអូ/សំឡេងសិន");
      return;
    }
    if (!apiKey.trim()) {
      setError("សូមបញ្ចូល Gemini API key សិន (ជំហាន Start)");
      return;
    }
    setBusy(true);
    setError("");
    setStage("transcribing");
    setLog([]);
    addLog(`Upload file ទៅ Gemini… (${file.name})`);
    try {
      const segs = await transcribeFile(file, apiKey.trim(), model.trim() || "gemini-2.5-flash", (st) => {
        if (st === "uploading") addLog("Uploading ទៅ Gemini…");
        if (st === "processing") addLog("Gemini កំពុងដំណើរការ file…");
        if (st === "transcribing") addLog("កំពុង transcribe + translate ទៅ Khmer…");
      });
      setSegments(segs);
      setStage("ready");
      addLog(`Transcribe រួចរាល់ — បាន ${segs.length} lines ✓`);
    } catch (e) {
      setStage("error");
      setError(e.message || "Transcribe បរាជ័យ");
      addLog(`Transcribe បរាជ័យ៖ ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const runTts = async (onlyId = null) => {
    const ctx = ensureAudio();
    const targets = segments.filter((s) =>
      onlyId ? s.id === onlyId : s.ttsState !== "ok" || !s.tts
    );
    if (!targets.length) return;
    setBusy(true);
    setError("");
    setStage("tts");
    addLog("ពិនិត្យ Edge TTS helper…");
    const online = await pingEdge(20000);
    if (!online) {
      addLog("Edge helper អត់ឆ្លើយ — អាចកំពុង wake up, នឹងព្យាយាមទៀត…");
    } else {
      addLog("Edge helper online ✓");
    }
    setTtsProgress({ done: 0, total: targets.length });
    let done = 0;
    for (const seg of targets) {
      updateSeg(seg.id, { ttsState: "loading" });
      const voice = voiceFor(seg.g, voiceMode);
      try {
        const buf = await ttsLine(seg.km, voice, ctx, () => {});
        updateSeg(seg.id, { tts: buf, ttsState: "ok" });
        addLog(`✓ ${fmtClock(seg.s)} ${voice === "km-KH-PisethNeural" ? "♂ Piseth" : "♀ Sreymom"}`);
      } catch (e) {
        updateSeg(seg.id, { tts: null, ttsState: "error" });
        addLog(`✗ ${fmtClock(seg.s)} — ${e.message}`);
      }
      done += 1;
      setTtsProgress({ done, total: targets.length });
    }
    setBusy(false);
    const okCount = segments.filter((s) => s.ttsState === "ok" || s.tts).length;
    // រាប់ឡើងវិញពី state ថ្មី
    setSegments((segs) => {
      const ok = segs.filter((s) => s.tts).length;
      addLog(`Generate voice រួចរាល់ — ${ok}/${segs.length} lines មានសំឡេង`);
      if (ok > 0) {
        setStage("ready");
        setTimeout(() => setStep(4), 600);
      } else {
        setStage("error");
        setError("Generate voice បរាជ័យទាំងអស់ — ពិនិត្យ Edge helper ហើយសាកម្តងទៀត");
      }
      return segs;
    });
    void okCount;
  };

  const playPreview = () => {
    const v = videoRef.current;
    if (!v) return;
    ensureAudio();
    const g = getVideoGraph(ctxRef.current, v);
    g.origGain.gain.value = origVolume / 100;
    g.dubGain.gain.value = 1;
    setPreviewOn(true);
    playerRef.current?.play(segments);
    v.play();
  };

  const pausePreview = () => {
    setPreviewOn(false);
    playerRef.current?.pause();
    videoRef.current?.pause();
  };

  const playLine = (seg) => {
    const v = videoRef.current;
    if (!v) return;
    ensureAudio();
    const g = getVideoGraph(ctxRef.current, v);
    g.origGain.gain.value = origVolume / 100;
    g.dubGain.gain.value = 1;
    setPreviewOn(true);
    v.currentTime = seg.s;
    playerRef.current?.play(segments);
    v.play();
  };

  const reTtsLine = async (seg) => {
    const ctx = ensureAudio();
    updateSeg(seg.id, { ttsState: "loading" });
    try {
      const buf = await ttsLine(seg.km, voiceFor(seg.g, voiceMode), ctx, () => {});
      updateSeg(seg.id, { tts: buf, ttsState: "ok" });
      addLog(`✓ ${fmtClock(seg.s)} regenerate រួចរាល់`);
    } catch (e) {
      updateSeg(seg.id, { tts: null, ttsState: "error" });
      setError(e.message);
    }
  };

  const importSrtFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const segs = parseSrt(text);
    if (!segs.length) {
      setError("អាន .srt មិនបាន — ពិនិត្យ format");
      return;
    }
    setSegments(segs);
    setStage("ready");
    addLog(`Import .srt រួចរាល់ — ${segs.length} lines (ត្រូវ generate voice បន្ទាប់)`);
    setStep(3);
  };

  const importSrtText = (text) => {
    const segs = parseSrt(text);
    if (!segs.length) {
      setError("អាន SRT text មិនបាន");
      return;
    }
    setSegments(segs);
    setStage("ready");
    addLog(`Import SRT text — ${segs.length} lines`);
  };

  const downloadSrt = () => {
    if (!segments.length) return;
    downloadText(
      `${(file?.name || "dub").replace(/\.[^.]+$/, "")}-khmer.srt`,
      segmentsToSrt(segments)
    );
    addLog("Download .srt ✓");
  };

  const downloadDubbedAudio = () => {
    const ctx = ensureAudio();
    const voiced = segments.filter((s) => s.tts);
    if (!voiced.length) {
      setError("មិនទាន់មានសំឡេង — Generate voice សិន");
      return;
    }
    const track = renderDubbedTrack(ctx, voiced, duration || 60);
    downloadBlob(
      `${(file?.name || "dub").replace(/\.[^.]+$/, "")}-khmer-dub.wav`,
      audioBufferToWav(track)
    );
    addLog("Download dubbed audio (.wav) ✓");
  };

  const runExport = async () => {
    const v = videoRef.current;
    if (!v || !file) return;
    const ctx = ensureAudio();
    const graph = getVideoGraph(ctx, v);
    setBusy(true);
    setError("");
    setStage("exporting");
    setExportProgress(0);
    setExportResult(null);
    addLog("កំពុង export video… (ប្រើពេលស្មើប្រវែងវីដេអូ)");
    try {
      if (audioOnly) {
        const voiced = segments.filter((s) => s.tts);
        const track = renderDubbedTrack(ctx, voiced, duration || 60);
        const blob = audioBufferToWav(track);
        const url = URL.createObjectURL(blob);
        setExportResult({
          url,
          filename: `${file.name.replace(/\.[^.]+$/, "")}-khmer-dub.wav`,
          label: "Khmer dubbed audio (.wav)",
        });
        setStage("done");
        setStep(7);
        return;
      }
      const ctl = exportDubbedVideo({
        videoEl: v,
        ctx,
        graph,
        dubPlayer: playerRef.current,
        segments,
        originalVolume: origVolume / 100,
        quality,
        onProgress: (p) => setExportProgress(p),
      });
      exportCtlRef.current = ctl;
      const { blob, ext } = await ctl.promise;
      const url = URL.createObjectURL(blob);
      setExportResult({
        url,
        filename: `${file.name.replace(/\.[^.]+$/, "")}-khmer-dub.${ext}`,
        label: `Dubbed video (.${ext})`,
      });
      setStage("done");
      setStep(7);
      addLog("Export ជោគជ័យ ✓");
    } catch (e) {
      if (String(e.message || "").includes("លុបចោល")) {
        setStage("ready");
        addLog("Export ត្រូវបានលុបចោល");
      } else {
        setStage("error");
        setError(e.message || "Export បរាជ័យ");
        addLog(`Export បរាជ័យ៖ ${e.message}`);
      }
    } finally {
      setBusy(false);
      setPreviewOn(false);
    }
  };

  const reset = () => {
    playerRef.current?.stop();
    setPreviewOn(false);
    setFile(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setSegments([]);
    setStage("idle");
    setLog([]);
    setError("");
    setExportResult(null);
    setExportProgress(0);
    setTtsProgress({ done: 0, total: 0 });
    setStep(0);
  };

  const canNextFrom = (s) => {
    if (s === 1) return !!file;
    if (s === 2) return true;
    if (s === 3) return segments.length > 0;
    if (s === 4) return segments.some((x) => x.tts);
    return true;
  };
  const mime = pickMimeType();
  const voicedCount = segments.filter((s) => s.tts).length;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">🎬 Din Magic Dubbing</div>
        <ol className="stepper">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "active" : i < step ? "done" : ""}>
              <span className="dot">{i < step ? "✓" : i + 1}</span>
              <span className="label">{s}</span>
            </li>
          ))}
        </ol>
      </header>

      <main className="content">
        {error && (
          <div className="card errbox">
            ⚠️ {error}
            <button className="mini" onClick={() => setError("")}>✕</button>
          </div>
        )}

        {step === 0 && (
          <section className="card center">
            <div className="big-icon">🎙️</div>
            <h1>ដាក់បកភាសាដោយ AI</h1>
            <p>
              បញ្ចូលវីដេអូ → Gemini transcribe + translate → Edge TTS
              (Piseth / Sreymom) → Export វីដេអូ dubbing ពិត។
            </p>
            <div className="field">
              <label>Gemini API key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyState(null);
                }}
                placeholder="AIzaSy… (រក្សាក្នុង browser បងតែប៉ុណ្ណោះ)"
              />
              <div className="row">
                <button className="btn ghost" onClick={handleCheckKey} disabled={keyState === "checking"}>
                  {keyState === "checking" ? "កំពុងពិនិត្យ…" : "ពិនិត្យ key"}
                </button>
                {keyState === "ok" && <span className="ok">✓ Key ប្រើបាន</span>}
                {keyState === "bad" && <span className="bad">✗ Key មិនត្រឹមត្រូវ</span>}
              </div>
              <p className="hint">
                យក key free ពី Google AI Studio (aistudio.google.com) — key
                មិនចេញពី browser បងទេ ក្រៅពីផ្ញើទៅ Google។
              </p>
            </div>
            <div className="field">
              <label>Gemini model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="models"
              />
              <datalist id="models">
                {MODEL_PRESETS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <button className="btn primary" onClick={() => setStep(1)}>
              ✨ Start — ចាប់ផ្ដើម
            </button>
          </section>
        )}

        {step === 1 && (
          <section className="card center">
            <label className="dropzone">
              <input type="file" accept="video/*,audio/*" hidden onChange={handleFile} />
              <span className="dz-icon">{file ? "✅" : "📁"}</span>
              <strong>{file ? file.name : "ជ្រើសរើសវីដេអូ / សំឡេង"}</strong>
              <em>MP4 · MP3 · WAV · MOV · MKV — file ធំក៏បាន (Gemini Files API)</em>
            </label>
            {file && duration > 0 && (
              <p className="hint">ប្រវែង៖ {fmtClock(duration)}</p>
            )}
            <details className="srtimport">
              <summary>មាន .srt រួចហើយ? Import វាមក (មិនបាច់ transcribe)</summary>
              <label className="btn ghost">
                📄 ជ្រើស .srt file
                <input type="file" accept=".srt,.vtt,.txt" hidden onChange={importSrtFile} />
              </label>
              <textarea
                placeholder="ឬ paste SRT text នៅទីនេះ…"
                rows={4}
                onBlur={(e) => e.target.value.trim() && importSrtText(e.target.value)}
              />
            </details>
          </section>
        )}

        {step === 2 && (
          <section className="card">
            <h2>🌍 ភាសាគោលដៅ៖ ខ្មែរ</h2>
            <p className="hint">
              Gemini ស្គាល់ភាសាដើមដោយស្វ័យប្រវត្តិ ហើយបកប្រែទៅខ្មែរ។
            </p>
            <h2>🧑‍🎤 សំឡេង Khmer (Edge TTS)</h2>
            <div className="grid">
              {[
                ["auto", "🤖 Auto — តាម gender (♂ Piseth / ♀ Sreymom)"],
                ["piseth", "♂ Piseth តែប៉ុណ្ណោះ"],
                ["sreymom", "♀ Sreymom តែប៉ុណ្ណោះ"],
              ].map(([v, label]) => (
                <button
                  key={v}
                  className={`pick ${voiceMode === v ? "selected" : ""}`}
                  onClick={() => setVoiceMode(v)}
                >
                  {label}
                </button>
              ))}
            </div>
            <h2>🔊 សំឡេងដើម (Original audio)</h2>
            <div className="row">
              <input
                type="range"
                min={0}
                max={100}
                value={origVolume}
                onChange={(e) => setOrigVolume(Number(e.target.value))}
              />
              <span>{origVolume}%</span>
            </div>
            <p className="hint">0% = លឺតែសំឡេង Khmer, 100% = សំឡេងដើមពេញ។</p>
          </section>
        )}

        {step === 3 && (
          <section className="card center">
            <h2>⚙️ Processing — Pipeline ពិត</h2>
            {segments.length === 0 ? (
              <>
                <p>មិនទាន់មាន transcript ទេ — ចុចដើម្បី transcribe វីដេអូដោយ Gemini។</p>
                <button className="btn primary" onClick={runTranscribe} disabled={busy || !file}>
                  🎙️ Transcribe + Translate (Gemini)
                </button>
                <p className="hint">
                  Gemini នឹង upload file, transcribe ការនិយាយទាំងអស់,
                  រក gender អ្នកនិយាយ ហើយបកប្រែទៅខ្មែរ។
                </p>
              </>
            ) : (
              <>
                <p>
                  Transcript រួចរាល់ — <b>{segments.length} lines</b> · មានសំឡេង{" "}
                  <b>
                    {voicedCount}/{segments.length}
                  </b>
                </p>
                <button
                  className="btn primary"
                  onClick={() => runTts()}
                  disabled={busy}
                >
                  🔊 Generate voices — Piseth / Sreymom (Edge TTS)
                </button>
                {ttsProgress.total > 0 && (
                  <>
                    <div className="bar">
                      <div
                        className="fill"
                        style={{ width: `${(ttsProgress.done / ttsProgress.total) * 100}%` }}
                      />
                    </div>
                    <p className="hint">
                      {ttsProgress.done}/{ttsProgress.total} lines
                    </p>
                  </>
                )}
                <p className="hint">
                  Edge TTS ជា server free — call ដំបូងអាចយឺត ~1 នាទីពេល server
                  កំពុង wake up។
                </p>
              </>
            )}
            {(stage === "transcribing" || stage === "tts") && (
              <div className="ring spin">{stage === "tts" && ttsProgress.total ? `${ttsProgress.done}/${ttsProgress.total}` : "…"}</div>
            )}
            <div className="logbox">
              {log.map((l, i) => (
                <div key={i} className="logline">
                  <span>{l.t}</span> {l.text}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="card">
            <h2>👁️ Preview Dubbing</h2>
            <div className="row">
              {!previewOn ? (
                <button className="btn primary" onClick={playPreview} disabled={!voicedCount}>
                  ▶ លេង dubbed (Khmer voice)
                </button>
              ) : (
                <button className="btn ghost" onClick={pausePreview}>⏸ Pause</button>
              )}
              <button className="btn ghost" onClick={downloadSrt}>⬇️ .srt</button>
              <button className="btn ghost" onClick={downloadDubbedAudio}>⬇️ Audio (.wav)</button>
            </div>
            {!voicedCount && (
              <p className="hint">មិនទាន់មានសំឡេងទេ — ត្រឡប់ទៅ Processing ហើយ Generate voices សិន។</p>
            )}
            <div className="transcript">
              <h3>
                Transcript — {segments.length} lines · មានសំឡេង {voicedCount}
              </h3>
              {segments.map((seg) => (
                <div key={seg.id} className="srow">
                  <div className="srow-head">
                    <time>{fmtClock(seg.s)}</time>
                    <button
                      className={`gbtn ${seg.g}`}
                      title="ប្តូរ gender/voice"
                      onClick={() => {
                        const g = seg.g === "f" ? "m" : "f";
                        updateSeg(seg.id, { g, tts: null, ttsState: "pending" });
                      }}
                    >
                      {seg.g === "f" ? "♀ Sreymom" : "♂ Piseth"}
                    </button>
                    <span className={`ttsstate ${seg.ttsState}`}>
                      {seg.ttsState === "ok"
                        ? "✓ voice"
                        : seg.ttsState === "loading"
                          ? "…"
                          : seg.ttsState === "error"
                            ? "✗ voice"
                            : "○ no voice"}
                    </span>
                    <button className="mini" onClick={() => playLine(seg)}>▶</button>
                    <button className="mini" onClick={() => reTtsLine(seg)} title="Generate voice ឡើងវិញ">🔊</button>
                    <button
                      className="mini"
                      onClick={() => setSegments((ss) => ss.filter((x) => x.id !== seg.id))}
                      title="លុប line នេះ"
                    >
                      🗑️
                    </button>
                  </div>
                  {seg.text && <p className="orig">{seg.text}</p>}
                  <textarea
                    className="km-ed"
                    value={seg.km}
                    rows={2}
                    onChange={(e) =>
                      updateSeg(seg.id, { km: e.target.value, tts: null, ttsState: "pending" })
                    }
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {step === 5 && (
          <section className="card">
            <h2>💾 Export Settings</h2>
            <p className="hint">
              Export ជា video ពិត — original video + Khmer voice លាយជាមួយសំឡេងដើម{" "}
              {origVolume}%។ Format ដែល browser បងគាំទ្រ៖{" "}
              <b>{mime ? `.${mime.ext} (${mime.mime || "default"})` : "មិនទាន់ដឹង"}</b>
            </p>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={audioOnly}
                  onChange={(e) => setAudioOnly(e.target.checked)}
                />{" "}
                Export audio only (.wav — Khmer voice តែប៉ុណ្ណោះ)
              </label>
            </div>
            {!audioOnly && (
              <>
                <h2>គុណភាព (Quality)</h2>
                <div className="grid">
                  {["1080p", "720p", "original"].map((q) => (
                    <button
                      key={q}
                      className={`pick ${quality === q ? "selected" : ""}`}
                      onClick={() => setQuality(q)}
                    >
                      ⚙️ {q === "original" ? "Original" : q}
                    </button>
                  ))}
                </div>
                <p className="hint">
                  Export ប្រើពេលស្មើប្រវែងវីដេអូ (ថត real-time) — វីដេអូ 5 នាទី
                  ប្រើពេល export ~5 នាទី។
                </p>
              </>
            )}
          </section>
        )}

        {step === 6 && (
          <section className="card center">
            <div className="big-icon done-icon">
              {stage === "done" ? "🎉" : stage === "exporting" ? "⏳" : "🎬"}
            </div>
            <h2>
              {stage === "done"
                ? "Export ជោគជ័យ!"
                : stage === "exporting"
                  ? "កំពុង Export…"
                  : "រួចរាល់សម្រាប់ Export"}
            </h2>
            {stage === "exporting" && (
              <>
                <div className="bar">
                  <div className="fill" style={{ width: `${exportProgress * 100}%` }} />
                </div>
                <p className="hint">{Math.round(exportProgress * 100)}% — កុំបិទទំព័រនេះ</p>
                <button
                  className="btn ghost"
                  onClick={() => exportCtlRef.current?.cancel()}
                >
                  ✕ លុបចោល
                </button>
              </>
            )}
            {stage !== "exporting" && stage !== "done" && (
              <button className="btn primary" onClick={runExport} disabled={busy || !voicedCount}>
                ⬇️ Export ចុងក្រោយ
              </button>
            )}
            {stage === "done" && exportResult && (
              <p>
                {exportResult.label}:{" "}
                <a href={exportResult.url} download={exportResult.filename}>
                  ⬇️ {exportResult.filename}
                </a>
              </p>
            )}
          </section>
        )}

        {step === 7 && (
          <section className="card center">
            <div className="big-icon">✅</div>
            <h2>រឿងរួចរាល់ហើយ!</h2>
            <p>អរគុណដែលប្រើ Din Magic Dubbing 🙏</p>
            {exportResult && (
              <a className="btn primary" href={exportResult.url} download={exportResult.filename}>
                ⬇️ Download — {exportResult.filename}
              </a>
            )}
            <button className="btn ghost" onClick={reset}>
              🔄 ចាប់ផ្ដើមថ្មី
            </button>
          </section>
        )}

        {/* video element តែមួយ — បង្ហាញនៅ Preview / Export, លាក់នៅជំហានផ្សេង */}
        {videoUrl && (
          <div className={`videowrap ${step === 4 || step === 6 ? "" : "hidden"}`}>
            <video ref={videoRef} src={videoUrl} controls playsInline preload="auto" />
          </div>
        )}
      </main>

      <footer className="nav">
        {step > 0 && stage !== "transcribing" && stage !== "tts" && stage !== "exporting" && (
          <button className="btn ghost" onClick={() => setStep(step - 1)}>
            ← ថយក្រោយ
          </button>
        )}
        <div className="spacer" />
        {step === 1 && (
          <button className="btn primary" disabled={!file} onClick={() => setStep(2)}>
            ដំណាក់កាលបន្ទាប់ →
          </button>
        )}
        {step === 2 && (
          <button className="btn primary" onClick={() => setStep(3)}>
            ដំណាក់កាលបន្ទាប់ →
          </button>
        )}
        {step === 3 && segments.length > 0 && !busy && (
          <button className="btn primary" onClick={() => setStep(4)}>
            Preview →
          </button>
        )}
        {step === 4 && (
          <button className="btn primary" disabled={!voicedCount} onClick={() => setStep(5)}>
            Export →
          </button>
        )}
        {step === 5 && (
          <button className="btn primary" disabled={!voicedCount} onClick={() => setStep(6)}>
            🚀 Start Export →
          </button>
        )}
        {step === 6 && stage === "done" && (
          <button className="btn primary" onClick={() => setStep(7)}>
            ដំណាក់កាលបន្ទាប់ →
          </button>
        )}
      </footer>
    </div>
  );
}
