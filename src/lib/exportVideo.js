// Export video — ថត video (canvas) + audio លាយ (original + Khmer TTS) តាម MediaRecorder
// លទ្ធផលជា file video ពិត (.mp4 បើ browser គាំទ្រ មិនដូច្នោះ .webm)

const MIME_CANDIDATES = [
  { mime: 'video/mp4;codecs="avc1.640028,mp4a.40.2"', ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: 'video/webm;codecs="vp9,opus"', ext: "webm" },
  { mime: 'video/webm;codecs="vp8,opus"', ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

export function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      /* ignore */
    }
  }
  return { mime: "", ext: "webm" };
}

function qualityScale(videoEl, quality) {
  const w = videoEl.videoWidth || 1280;
  const h = videoEl.videoHeight || 720;
  const targetH = quality === "720p" ? 720 : quality === "1080p" ? 1080 : h;
  if (h <= targetH) return { w, h };
  const s = targetH / h;
  return { w: Math.round((w * s) / 2) * 2, h: Math.round((h * s) / 2) * 2 };
}

// Export — ត្រូវការ dubPlayer ដែលបាន set segments រួច
export function exportDubbedVideo({
  videoEl,
  ctx,
  graph,
  dubPlayer,
  segments,
  originalVolume = 0.2,
  quality = "1080p",
  onProgress,
}) {
  let cancelled = false;
  let recorder = null;
  let raf = 0;
  let dest = null;

  const promise = (async () => {
    const picked = pickMimeType();
    if (!picked) throw new Error("Browser នេះមិនគាំទ្រ MediaRecorder ទេ");
    if (ctx.state === "suspended") await ctx.resume();

    const { w, h } = qualityScale(videoEl, quality);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c2d = canvas.getContext("2d");

    // audio → MediaStreamDestination (បន្ថែមពី destination ដែលមានស្រាប់)
    dest = ctx.createMediaStreamDestination();
    graph.origGain.connect(dest);
    graph.dubGain.connect(dest);
    graph.origGain.gain.value = originalVolume;
    graph.dubGain.gain.value = 1;

    const canvasStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const bits = h >= 1080 ? 8_000_000 : h >= 720 ? 5_000_000 : 2_500_000;
    recorder = new MediaRecorder(
      combined,
      picked.mime
        ? { mimeType: picked.mime, videoBitsPerSecond: bits }
        : { videoBitsPerSecond: bits }
    );
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    // draw loop
    const draw = () => {
      if (cancelled) return;
      try {
        if (videoEl.readyState >= 2) {
          c2d.drawImage(videoEl, 0, 0, w, h);
        }
      } catch {
        /* ignore */
      }
      if (!videoEl.ended && !videoEl.paused) raf = requestAnimationFrame(draw);
    };

    const onTime = () => {
      if (videoEl.duration)
        onProgress?.(Math.min(1, videoEl.currentTime / videoEl.duration));
    };
    videoEl.addEventListener("timeupdate", onTime);

    try {
      videoEl.currentTime = 0;
      await new Promise((r) => setTimeout(r, 150));
      recorder.start(500);
      dubPlayer.play(segments);
      raf = requestAnimationFrame(draw);
      await videoEl.play();
      // រង់ចាំ video ចប់
      await new Promise((resolve) => {
        if (videoEl.ended) return resolve();
        const onEnd = () => {
          videoEl.removeEventListener("ended", onEnd);
          resolve();
        };
        videoEl.addEventListener("ended", onEnd);
        const watcher = setInterval(() => {
          if (cancelled || videoEl.ended) {
            clearInterval(watcher);
            videoEl.removeEventListener("ended", onEnd);
            resolve();
          }
        }, 300);
      });
    } finally {
      cancelAnimationFrame(raf);
      videoEl.removeEventListener("timeupdate", onTime);
      videoEl.pause();
      dubPlayer.stop();
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      try {
        graph.origGain.disconnect(dest);
        graph.dubGain.disconnect(dest);
      } catch {
        /* ignore */
      }
    }

    if (cancelled) throw new Error("Export ត្រូវបានលុបចោល");
    const type = picked.mime || "video/webm";
    return { blob: new Blob(chunks, { type }), ext: picked.ext };
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      try {
        videoEl.pause();
      } catch {
        /* ignore */
      }
    },
  };
}
