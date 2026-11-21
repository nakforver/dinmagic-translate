// SRT — format / parse subtitle segments

export function fmtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secInt = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(secInt)},${p(ms, 3)}`;
}

export function fmtClock(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const secInt = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(secInt).padStart(2, "0")}`;
}

function parseTime(t) {
  const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  );
}

// segments → .srt text (រក្សា [M]/[F] tag ដូច dinmagicdubbing)
export function segmentsToSrt(segments) {
  return segments
    .map((seg, i) => {
      const tag = seg.g === "f" ? "[F]" : "[M]";
      return `${i + 1}\n${fmtTime(seg.s)} --> ${fmtTime(seg.e)}\n${tag} ${seg.km}\n`;
    })
    .join("\n");
}

// .srt text → segments (text ដើម = km, gender តាម [M]/[F] បើមាន)
export function parseSrt(text) {
  const blocks = (text || "").replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const segs = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    // lines[0] អាចជា index, lines[1] ជា timestamp
    let timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [a, b] = timeLine.split("-->");
    const s = parseTime(a);
    const e = parseTime(b);
    if (s == null || e == null || e <= s) continue;
    const textLines = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l));
    let joined = textLines.join(" ").trim();
    if (!joined) continue;
    let g = "m";
    const tag = joined.match(/^\[(M|F)\]\s*/i);
    if (tag) {
      g = tag[1].toLowerCase() === "f" ? "f" : "m";
      joined = joined.slice(tag[0].length).trim();
    }
    segs.push({
      id: `seg-import-${segs.length}-${Math.floor(s * 1000)}`,
      s,
      e,
      g,
      text: "",
      km: joined,
      tts: null,
      ttsState: "pending",
    });
  }
  return segs.sort((x, y) => x.s - y.s);
}

export function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
