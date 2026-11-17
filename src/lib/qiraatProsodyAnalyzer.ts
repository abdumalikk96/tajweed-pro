import { QiraatProsodyComparison } from '@/types/quran';
import { trimSilence } from '@/lib/audioUtils';

const TARGET_SAMPLE_RATE = 16000;
const CONTOUR_POINTS = 40;
const referenceAudioCache = new Map<string, Float32Array>();

/**
 * Облегченный алгоритм YIN (разностная функция с кумулятивной нормализацией CMND)
 * для точного определения частоты основного тона голоса (pitchF0Hz) в диапазоне 75–450 Гц.
 * Возвращает 0, если участок шумный или невокализованный.
 */
export function detectPitchYIN(
  frameSamples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE
): number {
  const n = frameSamples.length;
  if (n < 128) return 0;

  // Проверяем минимальную энергию фрейма
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumSq += frameSamples[i] * frameSamples[i];
  }
  const rms = Math.sqrt(sumSq / n);
  if (rms < 0.01) return 0;

  const minLag = Math.max(2, Math.floor(sampleRate / 450)); // ~35 сэмплов при 16 кГц (450 Гц)
  const maxLag = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / 75)); // ~160..213 сэмплов (75 Гц)

  if (maxLag <= minLag) return 0;

  const diff = new Float32Array(maxLag + 1);
  const cmnd = new Float32Array(maxLag + 1);

  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0;
    const limit = n - tau;
    for (let i = 0; i < limit; i++) {
      const delta = frameSamples[i] - frameSamples[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = runningSum > 1e-9 ? (diff[tau] * tau) / runningSum : 1;
  }

  const yinThreshold = 0.22;
  let bestTau = -1;

  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < yinThreshold) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) {
        tau++;
      }
      bestTau = tau;
      break;
    }
  }

  // Если порог 0.22 не достигнут, ищем глобальный минимум CMND (если он < 0.42 для вокализованной речи)
  if (bestTau === -1) {
    let minVal = 1.0;
    let minIdx = -1;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (cmnd[tau] < minVal) {
        minVal = cmnd[tau];
        minIdx = tau;
      }
    }
    if (minVal < 0.42) {
      bestTau = minIdx;
    }
  }

  if (bestTau <= 0) return 0;

  // Параболическая интерполяция вокруг bestTau для суб-сэмпловой точности
  let refinedTau = bestTau;
  if (bestTau > minLag && bestTau < maxLag) {
    const s0 = cmnd[bestTau - 1];
    const s1 = cmnd[bestTau];
    const s2 = cmnd[bestTau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-6) {
      refinedTau = bestTau + (s2 - s0) / denom;
    }
  }

  const f0 = sampleRate / refinedTau;
  if (f0 < 75 || f0 > 450) return 0;

  return Math.round(f0);
}

/**
 * Скачивает эталонный MP3 (слова или аята шейха Аль-Хусари), декодирует через AudioContext
 * в 16000 Гц Mono Float32Array и кэширует в памяти.
 */
export async function fetchAndDecodeReferenceAudio(
  audioUrl: string
): Promise<Float32Array | null> {
  if (!audioUrl || typeof window === 'undefined') return null;

  const cached = referenceAudioCache.get(audioUrl);
  if (cached) {
    return cached;
  }

  try {
    const proxiedUrl = `/api/audio-proxy?url=${encodeURIComponent(audioUrl)}`;
    const response = await fetch(proxiedUrl);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    const tempCtx = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
    const decoded = await tempCtx.decodeAudioData(arrayBuffer);
    await tempCtx.close().catch(() => {});

    const rawChannel = decoded.getChannelData(0);
    let finalBuffer: Float32Array;

    if (decoded.sampleRate !== TARGET_SAMPLE_RATE) {
      const ratio = decoded.sampleRate / TARGET_SAMPLE_RATE;
      const outLen = Math.round(rawChannel.length / ratio);
      finalBuffer = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio;
        const i0 = Math.floor(srcIdx);
        const i1 = Math.min(rawChannel.length - 1, i0 + 1);
        const frac = srcIdx - i0;
        finalBuffer[i] = rawChannel[i0] * (1 - frac) + rawChannel[i1] * frac;
      }
    } else {
      finalBuffer = new Float32Array(rawChannel.length);
      finalBuffer.set(rawChannel);
    }

    referenceAudioCache.set(audioUrl, finalBuffer);
    return finalBuffer;
  } catch {
    return null;
  }
}

/**
 * Извлекает последовательность вокализованных значений F0 и огибающей энергии из буфера.
 */
function extractPitchAndEnergySeries(
  buffer: Float32Array,
  sampleRate: number
): { voicedPitchesHz: number[]; rmsSeries: number[] } {
  const { trimmedBuffer } = trimSilence(buffer, sampleRate);
  const workBuf = trimmedBuffer.length > 320 ? trimmedBuffer : buffer;

  // Используем окно 30 мс (480 сэмплов при 16 кГц) для надежного захвата мужского баритона/баса от 75 Гц
  const winSize = Math.round(sampleRate * 0.03);
  const hopSize = Math.round(sampleRate * 0.015);

  const voicedPitchesHz: number[] = [];
  const rmsSeries: number[] = [];

  for (let start = 0; start + winSize <= workBuf.length; start += hopSize) {
    const slice = workBuf.subarray(start, start + winSize);
    let sumSq = 0;
    for (let i = 0; i < slice.length; i++) {
      sumSq += slice[i] * slice[i];
    }
    const rms = Math.sqrt(sumSq / slice.length);
    rmsSeries.push(rms);

    const f0 = detectPitchYIN(slice, sampleRate);
    if (f0 > 0) {
      voicedPitchesHz.push(f0);
    }
  }

  return { voicedPitchesHz, rmsSeries };
}

/**
 * Переводит массив частот (Гц) в относительные полутоны от среднего тона говорящего:
 * st = 12 * log2(f / meanF0). Это полностью устраняет разницу между басом, баритоном и тенором,
 * оставляя чистый мелодический рисунок (Кироат).
 */
function normalizeToSemitones(pitchesHz: number[]): number[] {
  if (pitchesHz.length === 0) {
    return new Array(CONTOUR_POINTS).fill(0);
  }
  const meanF0 =
    pitchesHz.reduce((acc, v) => acc + v, 0) / Math.max(1, pitchesHz.length);

  return pitchesHz.map((f) => {
    const st = 12 * Math.log2(Math.max(50, f) / Math.max(50, meanF0));
    return Number(Math.max(-8, Math.min(8, st)).toFixed(2));
  });
}

/**
 * Линейная интерполяция массива произвольной длины к строго фиксированному числу точек (40).
 */
function interpolateSeries(series: number[], targetLen = CONTOUR_POINTS): number[] {
  if (series.length === 0) {
    return new Array(targetLen).fill(0);
  }
  if (series.length === 1) {
    return new Array(targetLen).fill(series[0]);
  }

  const out: number[] = [];
  for (let i = 0; i < targetLen; i++) {
    const pos = (i / (targetLen - 1)) * (series.length - 1);
    const idx0 = Math.floor(pos);
    const idx1 = Math.min(series.length - 1, idx0 + 1);
    const frac = pos - idx0;
    const val = series[idx0] * (1 - frac) + series[idx1] * frac;
    out.push(Number(val.toFixed(2)));
  }
  return out;
}

/**
 * Dynamic Time Warping (DTW) между двумя контурами (в полутонах или энергии).
 * Возвращает среднюю ошибку на шаг пути.
 */
function computeDTWDistance(seqA: number[], seqB: number[]): number {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return 6.0;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(Infinity)
  );
  dp[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = Math.abs(seqA[i - 1] - seqB[j - 1]);
      dp[i][j] =
        cost +
        Math.min(
          dp[i - 1][j], // вставка
          dp[i][j - 1], // удаление
          dp[i - 1][j - 1] // совпадение
        );
    }
  }

  return dp[n][m] / (n + m);
}

/**
 * Сравнивает мелодику (Кироат), ритмику и стабильность удержания тона студента
 * с эталонной записью шейха Махмуда Халиля Аль-Хусари.
 */
export function compareQiraatWithSheikh(
  studentBuffer: Float32Array,
  referenceBuffer: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE
): QiraatProsodyComparison {
  const studentData = extractPitchAndEnergySeries(studentBuffer, sampleRate);
  const refData = extractPitchAndEnergySeries(referenceBuffer, sampleRate);

  const studentSemitones = normalizeToSemitones(studentData.voicedPitchesHz);
  const refSemitones = normalizeToSemitones(refData.voicedPitchesHz);

  const studentPitchContourNorm = interpolateSeries(
    studentSemitones,
    CONTOUR_POINTS
  );
  const referencePitchContourNorm = interpolateSeries(
    refSemitones,
    CONTOUR_POINTS
  );

  // 1. Оценка совпадения мелодического движения по DTW (в полутонах)
  const dtwSemitoneDist = computeDTWDistance(
    studentPitchContourNorm,
    referencePitchContourNorm
  );
  const melodySimilarityScore = Math.max(
    35,
    Math.min(99, Math.round(100 - dtwSemitoneDist * 18))
  );

  // 2. Оценка совпадения ритмической огибающей энергии (пропорции слогов и маддов)
  const maxStuRms = Math.max(0.001, ...studentData.rmsSeries);
  const maxRefRms = Math.max(0.001, ...refData.rmsSeries);
  const stuNormRms = interpolateSeries(
    studentData.rmsSeries.map((r) => r / maxStuRms),
    CONTOUR_POINTS
  );
  const refNormRms = interpolateSeries(
    refData.rmsSeries.map((r) => r / maxRefRms),
    CONTOUR_POINTS
  );
  const dtwRhythmDist = computeDTWDistance(stuNormRms, refNormRms);
  const rhythmSimilarityScore = Math.max(
    40,
    Math.min(98, Math.round(100 - dtwRhythmDist * 85))
  );

  // 3. Оценка стабильности удержания тона (отсутствие резких скачков/дрожания голоса на маддах)
  let jitterSum = 0;
  for (let i = 1; i < studentPitchContourNorm.length; i++) {
    jitterSum += Math.abs(
      studentPitchContourNorm[i] - studentPitchContourNorm[i - 1]
    );
  }
  const avgStepSemitones =
    jitterSum / Math.max(1, studentPitchContourNorm.length - 1);
  const pitchStabilityScore = Math.max(
    45,
    Math.min(99, Math.round(100 - Math.max(0, avgStepSemitones - 0.35) * 32))
  );

  // Формируем персональный совет по Кироату
  const adviceParts: string[] = [];
  if (melodySimilarityScore >= 82) {
    adviceParts.push(
      'Интонационный контур близко следует классическому тартилю шейха Аль-Хусари.'
    );
  } else {
    adviceParts.push(
      'Обратите внимание на плавные переходы высоты тона у шейха Аль-Хусари: избегайте резких подъемов голоса на согласных.'
    );
  }

  if (pitchStabilityScore < 75) {
    adviceParts.push(
      'Заметно дрожание или «плавание» тона на долгих гласных (Маддах) — удерживайте ровную вокальную опору до конца харакатов.'
    );
  } else {
    adviceParts.push(
      'Хорошая вокальная опора и ровное удержание ноты на протяженных участках.'
    );
  }

  return {
    melodySimilarityScore,
    rhythmSimilarityScore,
    pitchStabilityScore,
    studentPitchContourNorm,
    referencePitchContourNorm,
    qiraatAdviceRu: adviceParts.join(' '),
  };
}
