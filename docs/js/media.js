// Gem.AI · análise visual de vídeo, 100% no navegador
//
// Não há ffmpeg, servidor nem transcrição de áudio aqui. O que fazemos:
//   1) criamos um blob URL do arquivo (sem carregar 1 GiB na memória);
//   2) abrimos num <video> e lemos duração/largura/altura;
//   3) buscamos 3 instantes (10%, 50%, 90%) e desenhamos cada um num <canvas>;
//   4) enviamos esses JPEGs ao modelo de visão como image_url.
//
// É "amostragem visual", não compreensão temporal completa: o modelo vê 3
// fotogramas, não o movimento nem o áudio. Formatos que o navegador não
// decodifica (MKV, AVI, codecs raros) geram um aviso claro em vez de erro.

export const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "mov", "webm", "ogv", "ogg", "3gp", "3g2", "mkv", "avi", "wmv", "flv", "ts", "mts",
];

export function isVideo(name, mime = "") {
  const ext = String(name).split(".").pop().toLowerCase();
  return String(mime).toLowerCase().startsWith("video/") || VIDEO_EXTENSIONS.includes(ext);
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitMetadata(video) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("formato de vídeo não suportado por este navegador")); };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("loadedmetadata", ok, { once: true });
    video.addEventListener("error", fail, { once: true });
    if (video.readyState >= 1) ok();
  });
}

function seekTo(video, time, ms = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", done);
      resolve();
    };
    // Alguns WebViews não disparam `seeked`: seguimos com o frame disponível.
    const timer = setTimeout(done, ms);
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", done, { once: true });
    try {
      video.currentTime = time;
    } catch {
      done();
    }
  });
}

/** Desenha o frame atual do vídeo num canvas e devolve um data URI JPEG. */
function frameToJpeg(video, width, height, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(32, Math.round(width * scale));
  const h = Math.max(32, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Extrai frames representativos de um vídeo.
 * Nunca lança: devolve { frames, duration, width, height, times, warning }.
 */
export async function extractVideoFrames(file, options = {}) {
  const {
    count = 3,
    maxEdge = 768,
    quality = 0.78,
    timeoutMs = 12000,
  } = options;
  const result = { frames: [], times: [], duration: 0, width: 0, height: 0, warning: "" };

  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    result.warning = "Este navegador não permite ler vídeos localmente.";
    return result;
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.src = url;

  try {
    await withTimeout(waitMetadata(video), timeoutMs, "tempo esgotado ao abrir o vídeo");
    result.duration = Number.isFinite(video.duration) ? video.duration : 0;
    result.width = video.videoWidth || 0;
    result.height = video.videoHeight || 0;
    if (!result.width || !result.height) {
      result.warning = "Não foi possível ler as dimensões do vídeo.";
      return result;
    }

    const d = result.duration;
    const fractions = count === 1 ? [0.5] : count === 2 ? [0.25, 0.75] : [0.1, 0.5, 0.9];
    const times = d > 0.2
      ? fractions.map((f) => Math.min(Math.max(0.05, d * f), Math.max(0.05, d - 0.05)))
      : [0];
    result.times = times.slice(0, count);

    // Garante que o primeiro frame foi decodificado antes de desenhar.
    await seekTo(video, result.times[0]);
    for (const time of result.times) {
      await seekTo(video, time);
      const dataUrl = frameToJpeg(video, result.width, result.height, maxEdge, quality);
      if (dataUrl && dataUrl.length > 1000) result.frames.push(dataUrl);
      if (result.frames.length >= count) break;
    }
    if (!result.frames.length) {
      result.warning =
        "O navegador não conseguiu extrair fotogramas (codec não suportado, MKV/AVI ou vídeo protegido). " +
        "Converta para MP4 (H.264) ou envie capturas de tela em PNG/JPG para análise visual.";
    }
  } catch (error) {
    result.warning =
      `${error?.message || "Falha ao ler o vídeo"}. O arquivo foi salvo, mas sem análise visual; ` +
      "converta para MP4 (H.264) ou envie capturas PNG/JPG.";
  } finally {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch { /* nada a fazer */ }
    URL.revokeObjectURL(url);
  }
  return result;
}
