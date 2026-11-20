import { useState, useEffect, useRef } from "react";
import "./app.css";

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

const LANGUAGES = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "km", name: "ខ្មែរ", flag: "🇰🇭" },
  { code: "th", name: "ไทย", flag: "🇹🇭" },
  { code: "ja", name: "日本語", flag: "🇯🇵" },
  { code: "ko", name: "한국어", flag: "🇰🇷" },
  { code: "zh", name: "中文", flag: "🇨🇳" },
];

const VOICES = [
  "Male (Natural)",
  "Female (Natural)",
  "Male (Energetic)",
  "Female (Soft)",
];

const TRANSCRIPT = [
  { t: 1, text: "សួស្ដី សូមស្វាគមន៍មកកាន់ Din Magic Dubbing!" },
  { t: 5, text: "Interface របស់យើងងាយស្រួលប្រើ។" },
  { t: 9, text: "សូមរីករាយជាមួយ capabilities របស់ AI!" },
];

const STAGES = [
  "👟 Transcribing audio...",
  "🌍 Translating script...",
  "🎙️ Synthesizing voice...",
  "🔊 Syncing dub & exporting...",
];

const FORMATS = ["mp4", "mkv", "mov"];
const QUALITIES = ["720p", "1080p", "4K"];

const fmtTime = (sec) =>
  `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(
    Math.floor(sec % 60)
  ).padStart(2, "0")}`;

export default function App() {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [src, setSrc] = useState(null);
  const [lang, setLang] = useState("km");
  const [voice, setVoice] = useState(VOICES[0]);
  const [progress, setProgress] = useState(0);
  const [format, setFormat] = useState("mp4");
  const [audioOnly, setAudioOnly] = useState(false);
  const [quality, setQuality] = useState("1080p");
  const [exported, setExported] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const videoRef = useRef(null);

  const stage = Math.min(Math.floor(progress / 25), STAGES.length - 1);
  const processing = step === 3;
  const canNext = step === 0 || step === 7 || (step === 1 ? !!file : true);

  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => {
      setProgress((p) => Math.min(p + 2, 100));
    }, 60);
    return () => clearInterval(timer);
  }, [processing]);

  useEffect(() => {
    if (progress < 100) return;
    const t = setTimeout(() => setStep(4), 500);
    return () => clearTimeout(t);
  }, [progress]);

  useEffect(() => () => src && URL.revokeObjectURL(src), [src]);

  const handleFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setSrc(URL.createObjectURL(f));
  };

  const reset = () => {
    setFile(null);
    setSrc(null);
    setProgress(0);
    setExported(false);
    setDownloaded(false);
    setAudioOnly(false);
    setFormat("mp4");
    setQuality("1080p");
    setLang("km");
    setVoice(VOICES[0]);
    setStep(0);
  };

  const seekTo = (sec) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = sec;
    videoRef.current.play();
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">🎬 Din Magic Dubbing</div>
        <ol className="stepper">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={i === step ? "active" : i < step ? "done" : ""}
            >
              <span className="dot">{i < step ? "✓" : i + 1}</span>
              <span className="label">{s}</span>
            </li>
          ))}
        </ol>
      </header>

      <main className="content">
        {step === 0 && (
          <section className="card center">
            <div className="big-icon">🎙️</div>
            <h1>ដាក់បកភាសាដោយ AI</h1>
            <p>
              បញ្ចូលវីដេអូ → ជ្រើសភាសា → ទទួលបានវីដេអូ dubbing ក្នុងរយៈពេលតិចតួច។
            </p>
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
              <em>MP4 · MP3 · WAV · MOV · MKV</em>
            </label>
          </section>
        )}

        {step === 2 && (
          <section className="card">
            <h2>🌍 ជ្រើសភាសាគោលដៅ</h2>
            <div className="grid">
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  className={`pick ${lang === l.code ? "selected" : ""}`}
                  onClick={() => setLang(l.code)}
                >
                  <span className="flag">{l.flag}</span> {l.name}
                </button>
              ))}
            </div>
            <h2>🧑‍🎤 សំឡេង (Voice)</h2>
            <div className="grid">
              {VOICES.map((v) => (
                <button
                  key={v}
                  className={`pick ${voice === v ? "selected" : ""}`}
                  onClick={() => setVoice(v)}
                >
                  <span className="flag">🔊</span> {v}
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="card center">
            <div className={`ring ${progress < 100 ? "spin" : ""}`}>
              {progress}%
            </div>
            <p className="stage">{STAGES[stage]}</p>
            <div className="bar">
              <div className="fill" style={{ width: `${progress}%` }} />
            </div>
            <ul className="stagelist">
              {STAGES.map((s, i) => (
                <li key={s} className={i < stage ? "done" : i === stage ? "doing" : ""}>
                  {i < stage ? "✔ " : i === stage ? "▶ " : "○ "}
                  {s}
                </li>
              ))}
            </ul>
          </section>
        )}

        {step === 4 && (
          <section className="card">
            <h2>👁️ Preview Dubbing</h2>
            <video ref={videoRef} src={src ?? undefined} controls />
            <div className="transcript">
              <h3>
                Transcript ({lang.toUpperCase()} · {voice})
              </h3>
              {TRANSCRIPT.map((row) => (
                <div key={row.t} className="line">
                  <time>{fmtTime(row.t)}</time>
                  <p>{row.text}</p>
                  <button
                    className="mini"
                    aria-label={`Play from ${fmtTime(row.t)}`}
                    onClick={() => seekTo(row.t)}
                  >
                    ▶
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {step === 5 && (
          <section className="card">
            <h2>💾 Export Settings</h2>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={audioOnly}
                  onChange={(e) => setAudioOnly(e.target.checked)}
                />Export audio only (MP3)
              </label>
            </div>
            {!audioOnly && (
              <>
                <h2>ទម្រង់ (Format)</h2>
                <div className="grid">
                  {FORMATS.map((f) => (
                    <button
                      key={f}
                      className={`pick ${format === f ? "selected" : ""}`}
                      onClick={() => setFormat(f)}
                    >
                      🎞️ {f.toUpperCase()}
                    </button>
                  ))}
                </div>
                <h2>គុណភាព (Quality)</h2>
                <div className="grid">
                  {QUALITIES.map((q) => (
                    <button
                      key={q}
                      className={`pick ${quality === q ? "selected" : ""}`}
                      onClick={() => setQuality(q)}
                    >
                      ⚙️ {q}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {step === 6 && (
          <section className="card center">
            <div className="big-icon done-icon">{exported ? "🎉" : "⏳"}</div>
            <h2>{exported ? "Export ជោគជ័យ!" : "កំពុង Export..."}</h2>
            {!exported ? (
              <button className="btn primary" onClick={() => setExported(true)}>
                ⬇️ Export ចុងក្រោយ
              </button>
            ) : (
              <p>ទម្រង់៖ {audioOnly ? "MP3" : `${format.toUpperCase()} · ${quality}`}</p>
            )}
          </section>
        )}

        {step === 7 && (
          <section className="card center">
            <div className="big-icon">✅</div>
            <h2>រឿងរួចរាល់ហើយ!</h2>
            <p>អរគុណដែលប្រើ Din Magic Dubbing 🙏</p>
            <button className="btn primary" onClick={() => setDownloaded(true)} disabled={downloaded}>
              {downloaded ? "⬇️ Downloaded" : "⬇️ Download"}
            </button>
            <button className="btn ghost" onClick={reset}>
              🔄 ចាប់ផ្ដើមថ្មី
            </button>
          </section>
        )}
      </main>

      <footer className="nav">
        {step > 0 && !processing && (
          <button className="btn ghost" onClick={() => setStep(step - 1)}>
            ← ថយក្រោយ
          </button>
        )}
        <div className="spacer" />
        {step >= 1 && step <= 3 && (
          <button
            className="btn primary"
            disabled={processing || !canNext}
            onClick={() => setStep(step + 1)}
          >
            ដំណាក់កាលបន្ទាប់ →
          </button>
        )}
        {step === 5 && (
          <button className="btn primary" onClick={() => setStep(6)}>
            🚀 Start Export →
          </button>
        )}
        {step === 6 && exported && (
          <button className="btn primary" onClick={() => setStep(7)}>
            ដំណាក់កាលបន្ទាប់ →
          </button>
        )}
      </footer>
    </div>
  );
}
