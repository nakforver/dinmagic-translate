// Audio — WAV encode + dubbed playback (TTS តាម timeline) + video audio graph

// AudioBuffer → WAV Blob (16-bit PCM)
export function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const len = buffer.length * numCh * 2;
  const out = new DataView(new ArrayBuffer(44 + len));
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) out.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  out.setUint32(4, 36 + len, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, numCh, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * numCh * 2, true);
  out.setUint16(32, numCh * 2, true);
  out.setUint16(34, 16, true);
  writeStr(36, "data");
  out.setUint32(40, len, true);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      out.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Video audio graph — បង្កើតម្តងក្នុងមួយ video element
// origGain = original audio, dubGain = Khmer TTS — ទាំងពីរភ្ជាប់ទៅ destination
export function getVideoGraph(ctx, videoEl) {
  if (videoEl._dinmagicGraph) return videoEl._dinmagicGraph;
  const source = ctx.createMediaElementSource(videoEl);
  const origGain = ctx.createGain();
  const dubGain = ctx.createGain();
  source.connect(origGain);
  origGain.connect(ctx.destination);
  dubGain.connect(ctx.destination);
  // video element ខ្លួនវា mute — សំឡេងចេញតាម graph តែប៉ុណ្ណោះ
  videoEl.muted = true;
  const graph = { ctx, source, origGain, dubGain };
  videoEl._dinmagicGraph = graph;
  return graph;
}

// Player សម្រាប់ស្តាប់ dubbed audio តាម video timeline
export class DubPlayer {
  constructor(ctx, videoEl) {
    this.ctx = ctx;
    this.videoEl = videoEl;
    this.sources = [];
    this.playing = false;
    this.segments = [];
    this.onEnded = null;
    this._onSeeked = () => {
      if (this.playing) this._schedule();
    };
    this._onVideoEnded = () => {
      this.stop();
      this.onEnded?.();
    };
    videoEl.addEventListener("seeked", this._onSeeked);
    videoEl.addEventListener("ended", this._onVideoEnded);
  }

  setVolume(v) {
    const g = getVideoGraph(this.ctx, this.videoEl);
    g.dubGain.gain.value = v;
  }

  setOriginalVolume(v) {
    const g = getVideoGraph(this.ctx, this.videoEl);
    g.origGain.gain.value = v;
  }

  _stopSources() {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
  }

  _schedule() {
    this._stopSources();
    const g = getVideoGraph(this.ctx, this.videoEl);
    const now = this.videoEl.currentTime;
    const t0 = this.ctx.currentTime + 0.05;
    for (const seg of this.segments) {
      if (!seg.tts || seg.e <= now) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = seg.tts;
      src.connect(g.dubGain);
      const offset = Math.max(0, now - seg.s);
      const when = t0 + Math.max(0, seg.s - now);
      try {
        src.start(when, offset);
      } catch {
        continue;
      }
      this.sources.push(src);
    }
  }

  play(segments) {
    if (segments) this.segments = segments;
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.playing = true;
    this._schedule();
  }

  pause() {
    this.playing = false;
    this._stopSources();
  }

  stop() {
    this.playing = false;
    this._stopSources();
  }

  destroy() {
    this.stop();
    this.videoEl.removeEventListener("seeked", this._onSeeked);
    this.videoEl.removeEventListener("ended", this._onVideoEnded);
  }
}

// Render dubbed voice ទាំងអស់ជា AudioBuffer មួយ (សម្រាប់ download audio only)
export function renderDubbedTrack(ctx, segments, duration) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.ceil(duration * rate));
  const out = ctx.createBuffer(1, len, rate);
  const ch = out.getChannelData(0);
  for (const seg of segments) {
    if (!seg.tts) continue;
    const src = seg.tts.getChannelData(0);
    const start = Math.floor(seg.s * rate);
    const n = Math.min(src.length, len - start);
    for (let i = 0; i < n; i++) ch[start + i] += src[i];
  }
  return out;
}
