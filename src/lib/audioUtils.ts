/**
 * Утилиты работы с сырым аудио-буфером (16 кГц, Mono Float32Array):
 * - точное определение границ активной речи (trimSilence) с учетом Auto-Gain нормализации
 * - мгновенное воспроизведение среза записи студента по таймкодам (playAudioSlice)
 * - декодирование и пословное/побуквенное воспроизведение эталона шейха через AudioContext (playReferenceAudioSlice)
 * - кодирование в стандартный WAV 16-bit PCM (encodeWavBlob)
 */

let sharedPlaybackCtx: AudioContext | null = null;
let currentSourceNode: AudioBufferSourceNode | null = null;
let currentHtmlAudio: HTMLAudioElement | null = null;

const referencePcmCache = new Map<
  string,
  { pcm: Float32Array; sampleRate: number }
>();

async function getPlaybackAudioContext(): Promise<AudioContext> {
  if (typeof window === 'undefined') {
    throw new Error('AudioContext доступен только в браузере');
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  if (!sharedPlaybackCtx || sharedPlaybackCtx.state === 'closed') {
    sharedPlaybackCtx = new AudioCtx();
  }
  if (sharedPlaybackCtx.state === 'suspended') {
    await sharedPlaybackCtx.resume();
  }
  return sharedPlaybackCtx;
}

export interface TrimSilenceResult {
  trimmedBuffer: Float32Array;
  startOffsetMs: number;
  endOffsetMs: number;
}

/**
 * Точно находит начало (startOffsetMs) и конец (endOffsetMs) реального голоса в буфере,
 * отсекая пред-запись и 1.2-секундную паузу авто-остановки в конце.
 * Порог адаптируется к пиковой RMS (18% от maxRms), поэтому даже после Auto-Gain нормализации
 * фоновый шум комнаты гарантированно отрезается и таймкоды букв не смещаются.
 */
export function trimSilence(
  buffer: Float32Array,
  sampleRate: number,
  thresholdRms = 0.015
): TrimSilenceResult {
  if (!buffer || buffer.length === 0) {
    return {
      trimmedBuffer: new Float32Array(0),
      startOffsetMs: 0,
      endOffsetMs: 0,
    };
  }

  const totalDurationMs = Math.round((buffer.length / sampleRate) * 1000);
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.01)); // окно 10 мс
  const totalWindows = Math.floor(buffer.length / windowSize);

  if (totalWindows <= 2) {
    return {
      trimmedBuffer: buffer.slice(),
      startOffsetMs: 0,
      endOffsetMs: Math.max(250, totalDurationMs),
    };
  }

  let maxRms = 0;
  let minRms = Infinity;
  let maxPeak = 0;
  const windowRmsValues = new Float32Array(totalWindows);

  for (let w = 0; w < totalWindows; w++) {
    let sumSq = 0;
    const offset = w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      const s = buffer[offset + i];
      const abs = Math.abs(s);
      if (abs > maxPeak) maxPeak = abs;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    windowRmsValues[w] = rms;
    if (rms > maxRms) maxRms = rms;
    if (rms < minRms) minRms = rms;
  }

  if (maxPeak < 0.0005 && maxRms < 0.0003) {
    return {
      trimmedBuffer: new Float32Array(0),
      startOffsetMs: 0,
      endOffsetMs: 0,
    };
  }

  // Оцениваем уровень фонового шума по самым тихим 20% окон
  const sortedRms = Array.from(windowRmsValues).sort((a, b) => a - b);
  const noiseFloorRms =
    sortedRms[Math.floor(sortedRms.length * 0.2)] ?? minRms ?? 0;

  // Адаптивный порог активной речи: выше шумового пола и ~18% от пиковой энергии речи
  const adaptiveThreshold = Math.max(
    thresholdRms,
    noiseFloorRms * 2.4,
    maxRms * 0.18
  );
  // Защита, чтобы порог никогда не превышал 65% от maxRms
  const effectiveThreshold = Math.min(maxRms * 0.65, adaptiveThreshold);

  let firstActiveWindow = 0;
  while (
    firstActiveWindow < totalWindows &&
    windowRmsValues[firstActiveWindow] < effectiveThreshold
  ) {
    firstActiveWindow++;
  }

  let lastActiveWindow = totalWindows - 1;
  while (
    lastActiveWindow > firstActiveWindow &&
    windowRmsValues[lastActiveWindow] < effectiveThreshold
  ) {
    lastActiveWindow--;
  }

  if (firstActiveWindow > lastActiveWindow) {
    return {
      trimmedBuffer: buffer.slice(),
      startOffsetMs: 0,
      endOffsetMs: totalDurationMs,
    };
  }

  // Небольшой запас (35 мс до начала и 45 мс после конца) для сохранения начальной согласной и сукуна
  const padStartWindows = 3;
  const padEndWindows = 4;
  const startSample = Math.max(
    0,
    (firstActiveWindow - padStartWindows) * windowSize
  );
  const endSample = Math.min(
    buffer.length,
    (lastActiveWindow + 1 + padEndWindows) * windowSize
  );

  const trimmedBuffer = buffer.slice(startSample, endSample);
  const startOffsetMs = Math.round((startSample / sampleRate) * 1000);
  const rawEndOffsetMs = Math.round((endSample / sampleRate) * 1000);
  const endOffsetMs = Math.min(
    totalDurationMs,
    Math.max(startOffsetMs + 220, rawEndOffsetMs)
  );

  return {
    trimmedBuffer,
    startOffsetMs,
    endOffsetMs,
  };
}

export function stopActiveAudioPlayback(): void {
  if (currentSourceNode) {
    try {
      currentSourceNode.stop();
      currentSourceNode.disconnect();
    } catch {
      // ignore
    }
    currentSourceNode = null;
  }

  if (currentHtmlAudio) {
    currentHtmlAudio.pause();
    currentHtmlAudio = null;
  }
}

/**
 * Проигрывает четкий двухтональный звуковой сигнал ошибки (320Hz -> 180Hz, 250 мс)
 * на базе Web Audio API AudioContext для режима сдачи урока («Dars topshirish»).
 */
export async function playErrorBuzzSound(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const ctx = await getPlaybackAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.setValueAtTime(180, now + 0.11);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.015);
    gain.gain.setValueAtTime(0.22, now + 0.21);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.26);
  } catch {
    // ignore AudioContext restrictions
  }
}

/**
 * Проигрывает выбранный срез Float32Array от startMs до endMs с автоматическим resume() AudioContext
 * и нормализацией громкости до 0.85.
 */
export async function playAudioSlice(
  buffer: Float32Array,
  sampleRate: number,
  startMs?: number,
  endMs?: number,
  onEnded?: () => void,
  playbackRate = 1.0
): Promise<void> {
  if (!buffer || buffer.length === 0) {
    onEnded?.();
    return;
  }

  stopActiveAudioPlayback();

  const totalDurationMs = (buffer.length / sampleRate) * 1000;
  let safeStartMs = Math.max(0, Math.min(startMs ?? 0, totalDurationMs));
  let safeEndMs = Math.min(endMs ?? totalDurationMs, totalDurationMs);

  // Гарантируем минимальную длину проигрываемого среза не менее 260 мс
  if (safeEndMs - safeStartMs < 260) {
    const mid = (safeStartMs + safeEndMs) / 2;
    safeStartMs = Math.max(0, mid - 130);
    safeEndMs = Math.min(totalDurationMs, safeStartMs + 260);
    if (safeEndMs - safeStartMs < 260) {
      safeStartMs = Math.max(0, safeEndMs - 260);
    }
  }

  const startSample = Math.max(
    0,
    Math.floor((safeStartMs / 1000) * sampleRate)
  );
  const endSample = Math.min(
    buffer.length,
    Math.ceil((safeEndMs / 1000) * sampleRate)
  );

  const sliceLength = Math.max(1, endSample - startSample);
  const normalizedSlice = new Float32Array(sliceLength);

  let maxAbs = 0;
  for (let i = 0; i < sliceLength; i++) {
    const abs = Math.abs(buffer[startSample + i] ?? 0);
    if (abs > maxAbs) maxAbs = abs;
  }
  const gainFactor =
    maxAbs > 0.001 ? Math.min(25.0, 0.85 / maxAbs) : 1.0;

  const fadeSamples = Math.min(
    Math.floor(sampleRate * 0.008),
    Math.floor(sliceLength / 6)
  );

  for (let i = 0; i < sliceLength; i++) {
    let sample = (buffer[startSample + i] ?? 0) * gainFactor;
    if (fadeSamples > 0) {
      if (i < fadeSamples) {
        sample *= i / fadeSamples;
      } else if (i >= sliceLength - fadeSamples) {
        sample *= (sliceLength - 1 - i) / fadeSamples;
      }
    }
    normalizedSlice[i] = Math.max(-1, Math.min(1, sample));
  }

  try {
    const wavBlob = encodeWavBlob(normalizedSlice, sampleRate);
    const url = URL.createObjectURL(wavBlob);
    const audio = new Audio(url);
    audio.playbackRate = playbackRate;
    currentHtmlAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentHtmlAudio === audio) {
        currentHtmlAudio = null;
      }
      onEnded?.();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentHtmlAudio === audio) {
        currentHtmlAudio = null;
      }
      onEnded?.();
    };
    await audio.play();
    return;
  } catch {
    // Fallback на Web Audio API AudioContext
  }

  try {
    const ctx = await getPlaybackAudioContext();
    const audioBuffer = ctx.createBuffer(1, sliceLength, sampleRate);
    audioBuffer.getChannelData(0).set(normalizedSlice);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = playbackRate;
    source.connect(ctx.destination);
    currentSourceNode = source;

    source.onended = () => {
      if (currentSourceNode === source) {
        currentSourceNode = null;
      }
      onEnded?.();
    };

    source.start(0);
  } catch {
    onEnded?.();
  }
}

/**
 * Загружает и декодирует внешнее эталонное аудио (слово или аят) в Float32Array с кэшированием.
 */
async function decodeRemoteAudioToPcm(
  audioUrl: string
): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
  if (!audioUrl) return null;
  if (referencePcmCache.has(audioUrl)) {
    return referencePcmCache.get(audioUrl)!;
  }

  const proxyUrl = `/api/audio-proxy?url=${encodeURIComponent(audioUrl)}`;
  const urlsToTry = [proxyUrl, audioUrl];

  for (const candidateUrl of urlsToTry) {
    try {
      const resp = await fetch(candidateUrl);
      if (!resp.ok) continue;
      const arrayBuf = await resp.arrayBuffer();
      if (arrayBuf.byteLength < 100) continue;

      const ctx = await getPlaybackAudioContext();
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      const ch0 = decoded.getChannelData(0);
      const pcm = new Float32Array(ch0.length);
      pcm.set(ch0);

      const entry = { pcm, sampleRate: decoded.sampleRate };
      referencePcmCache.set(audioUrl, entry);
      return entry;
    } catch {
      // Пробуем следующий URL
    }
  }

  return null;
}

/**
 * Проигрывает эталонный звук конкретного слова или выделенного сегмента буквы/правила через AudioContext:
 * 1) Сначала пытается загрузить пословное аудио `wordAudioUrl` (например https://audio.qurancdn.com/wbw/...)
 *    и вырезает нужный фрагмент буквы `[relStartInWord, relEndInWord]` (с естественным запасом ~380 мс, чтобы звук буквы и огласовки звучал разборчиво).
 * 2) Если пословное аудио недоступно, декодирует общий файл аята `fallbackAyahAudioUrl` и вырезает ровно нужный фрагмент `[relStartInAyah, relEndInAyah]` через AudioContext (вместо проигрывания всего аята целиком!).
 */
export async function playReferenceAudioSlice(options: {
  wordAudioUrl?: string;
  fallbackAyahAudioUrl: string;
  relStartInWord?: number;
  relEndInWord?: number;
  relStartInAyah?: number;
  relEndInAyah?: number;
  playbackRate?: number;
  onEnded?: () => void;
}): Promise<void> {
  const {
    wordAudioUrl,
    fallbackAyahAudioUrl,
    relStartInWord = 0,
    relEndInWord = 1,
    relStartInAyah = 0,
    relEndInAyah = 1,
    playbackRate = 1.0,
    onEnded,
  } = options;

  stopActiveAudioPlayback();

  // 1. Пробуем декодировать пословное аудио (wbw) и проигрываем слово целиком без обрезки слогов,
  // чтобы ученик всегда слышал точное эталонное произношение именно этого слова
  if (wordAudioUrl) {
    const decodedWord = await decodeRemoteAudioToPcm(wordAudioUrl);
    if (decodedWord && decodedWord.pcm.length > 0) {
      const { startOffsetMs, endOffsetMs } = trimSilence(
        decodedWord.pcm,
        decodedWord.sampleRate,
        0.01
      );
      await playAudioSlice(
        decodedWord.pcm,
        decodedWord.sampleRate,
        Math.max(0, startOffsetMs - 30),
        Math.min(
          (decodedWord.pcm.length / decodedWord.sampleRate) * 1000,
          endOffsetMs + 50
        ),
        onEnded,
        playbackRate
      );
      return;
    }
  }

  // 2. Если пословное аудио недоступно — декодируем файл аята и вырезаем ровно нужный фрагмент через AudioContext
  const decodedAyah = await decodeRemoteAudioToPcm(fallbackAyahAudioUrl);
  if (decodedAyah && decodedAyah.pcm.length > 0) {
    const { startOffsetMs, endOffsetMs } = trimSilence(
      decodedAyah.pcm,
      decodedAyah.sampleRate,
      0.012
    );
    const activeAyahMs = Math.max(400, endOffsetMs - startOffsetMs);
    const sliceStartMs = Math.max(
      0,
      startOffsetMs + relStartInAyah * activeAyahMs - 80
    );
    const sliceEndMs = Math.min(
      (decodedAyah.pcm.length / decodedAyah.sampleRate) * 1000,
      Math.max(sliceStartMs + 450, startOffsetMs + relEndInAyah * activeAyahMs + 80)
    );

    await playAudioSlice(
      decodedAyah.pcm,
      decodedAyah.sampleRate,
      sliceStartMs,
      sliceEndMs,
      onEnded,
      playbackRate
    );
    return;
  }

  // 3. Крайний резервный вариант — проигрываем пословный URL напрямую через HTML5 Audio
  const targetUrl = wordAudioUrl || fallbackAyahAudioUrl;
  try {
    const audio = new Audio(targetUrl);
    audio.playbackRate = playbackRate;
    currentHtmlAudio = audio;
    audio.onended = () => {
      if (currentHtmlAudio === audio) currentHtmlAudio = null;
      onEnded?.();
    };
    audio.onerror = () => {
      if (currentHtmlAudio === audio) currentHtmlAudio = null;
      onEnded?.();
    };
    await audio.play();
  } catch {
    onEnded?.();
  }
}

/**
 * Кодирует моно Float32Array в стандартный RIFF WAV (16-bit PCM) Blob.
 */
export function encodeWavBlob(buffer: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    const clamped = Math.max(-1, Math.min(1, buffer[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
