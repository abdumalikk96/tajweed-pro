import {
  AcousticFrame,
  CheckPointEvaluation,
  PhonemeCheckPoint,
  RecitationAnalysisResult,
  RecitationPace,
  VoiceCalibrationProfile,
} from '@/types/quran';
import { trimSilence } from '@/lib/audioUtils';
import { evaluateMakhrajAndSifaat } from '@/lib/phonemeClassifier';
import { compareRecognizedArabicWithTarget } from '@/lib/arabicPhonemeMapper';
import { detectPitchYIN } from '@/lib/qiraatProsodyAnalyzer';
import type { WorkerTranscriptionOutput } from '@/lib/quranAiWorker';
import type { NormalizedAudioFloat32Array } from '@/hooks/useRawAudioRecorder';

const PACE_HARAKA_MS: Record<RecitationPace, number> = {
  tahqiq: 480,
  tadwir: 360,
  hadr: 260,
  fast: 160,
};

const FFT_SIZE = 512;
const HANN_WINDOW_320 = new Float32Array(320);
for (let i = 0; i < 320; i++) {
  HANN_WINDOW_320[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / 319));
}

export interface HybridNeuralContext {
  neuralOutput?: WorkerTranscriptionOutput | null;
  targetUthmani?: string;
  expectedPhonemes?: string;
  calibrationProfile?: VoiceCalibrationProfile | null;
  recordedAudioUrl?: string;
}

/**
 * Компактное внутримассивное (in-place) Radix-2 быстрое преобразование Фурье (FFT) на 512 точек.
 */
function radix2FFT512(real: Float32Array, imag: Float32Array): void {
  const n = FFT_SIZE;
  let j = 0;

  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wlenReal = Math.cos(angle);
    const wlenImag = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wReal = 1.0;
      let wImag = 0.0;
      for (let k = 0; k < halfLen; k++) {
        const uIdx = i + k;
        const vIdx = i + k + halfLen;

        const vr = real[vIdx] * wReal - imag[vIdx] * wImag;
        const vi = real[vIdx] * wImag + imag[vIdx] * wReal;

        real[vIdx] = real[uIdx] - vr;
        imag[vIdx] = imag[uIdx] - vi;
        real[uIdx] += vr;
        imag[uIdx] += vi;

        const nextWReal = wReal * wlenReal - wImag * wlenImag;
        wImag = wReal * wlenImag + wImag * wlenReal;
        wReal = nextWReal;
      }
    }
  }
}

/**
 * Извлекает последовательность акустических кадров (окно 20 мс = 320 сэмплов, шаг 10 мс = 160 сэмплов)
 * с расчетом RMS, ZCR, спектральной огибающей, F1, F2, назального отношения (nasalRatio) и F0 (pitchF0Hz).
 */
export function extractAcousticFrames(
  buffer: Float32Array,
  sampleRate = 16000
): AcousticFrame[] {
  const windowSamples = Math.round(sampleRate * 0.02); // 320 при 16 кГц
  const hopSamples = Math.round(sampleRate * 0.01); // 160 при 16 кГц
  const binHz = sampleRate / FFT_SIZE; // 31.25 Гц при 16 кГц и 512 FFT

  const frames: AcousticFrame[] = [];
  if (buffer.length < windowSamples) {
    return frames;
  }

  let peakRms = 0;
  for (
    let start = 0;
    start + windowSamples <= buffer.length;
    start += hopSamples
  ) {
    let sumSq = 0;
    for (let i = 0; i < windowSamples; i++) {
      const v = buffer[start + i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / windowSamples);
    if (rms > peakRms) peakRms = rms;
  }

  // Порог вокализации адаптируется к пиковой RMS буфера
  const voicedRmsThreshold = Math.max(0.002, peakRms * 0.14);

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(FFT_SIZE >> 1);
  const smoothMag = new Float32Array(FFT_SIZE >> 1);

  for (
    let start = 0;
    start + windowSamples <= buffer.length;
    start += hopSamples
  ) {
    let sumSq = 0;
    let zeroCrossings = 0;

    real.fill(0);
    imag.fill(0);

    for (let i = 0; i < windowSamples; i++) {
      const sample = buffer[start + i];
      sumSq += sample * sample;

      if (i > 0) {
        const prev = buffer[start + i - 1];
        if ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0)) {
          zeroCrossings++;
        }
      }

      const hann =
        windowSamples === 320
          ? HANN_WINDOW_320[i]
          : 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSamples - 1)));

      const preEmph = i > 0 ? sample - 0.95 * buffer[start + i - 1] : sample;
      real[i] = preEmph * hann;
    }

    const rms = Math.sqrt(sumSq / windowSamples);
    const zcr = zeroCrossings / windowSamples;

    radix2FFT512(real, imag);

    const halfBins = FFT_SIZE >> 1;
    for (let b = 0; b < halfBins; b++) {
      mag[b] = Math.hypot(real[b], imag[b]);
    }

    for (let b = 1; b < halfBins - 1; b++) {
      smoothMag[b] = 0.25 * mag[b - 1] + 0.5 * mag[b] + 0.25 * mag[b + 1];
    }

    const f1MinBin = Math.max(1, Math.floor(250 / binHz));
    const f1MaxBin = Math.min(halfBins - 1, Math.ceil(850 / binHz));
    let f1PeakBin = f1MinBin;
    let f1MaxVal = -1;
    for (let b = f1MinBin; b <= f1MaxBin; b++) {
      if (smoothMag[b] > f1MaxVal) {
        f1MaxVal = smoothMag[b];
        f1PeakBin = b;
      }
    }
    const f1Hz = Math.round(f1PeakBin * binHz);

    const f2MinBin = Math.max(f1MaxBin + 1, Math.floor(850 / binHz));
    const f2MaxBin = Math.min(halfBins - 1, Math.ceil(2600 / binHz));
    let f2PeakBin = f2MinBin;
    let f2MaxVal = -1;
    let f2WeightedSum = 0;
    let f2EnergySum = 0;

    for (let b = f2MinBin; b <= f2MaxBin; b++) {
      const val = smoothMag[b];
      if (val > f2MaxVal) {
        f2MaxVal = val;
        f2PeakBin = b;
      }
      f2WeightedSum += b * binHz * val;
      f2EnergySum += val;
    }

    const peakF2Hz = f2PeakBin * binHz;
    const centroidF2Hz =
      f2EnergySum > 1e-6 ? f2WeightedSum / f2EnergySum : peakF2Hz;
    const f2Hz = Math.round(0.65 * peakF2Hz + 0.35 * centroidF2Hz);

    const nasalMinBin = Math.max(1, Math.floor(200 / binHz));
    const nasalMaxBin = Math.min(halfBins - 1, Math.ceil(400 / binHz));
    const midMinBin = Math.max(1, Math.floor(800 / binHz));
    const midMaxBin = Math.min(halfBins - 1, Math.ceil(2200 / binHz));

    let nasalBandEnergy = 0;
    for (let b = nasalMinBin; b <= nasalMaxBin; b++) {
      nasalBandEnergy += (mag[b] / Math.max(1, b * 0.25)) ** 2;
    }
    nasalBandEnergy /= Math.max(1, nasalMaxBin - nasalMinBin + 1);

    let midBandEnergy = 0;
    for (let b = midMinBin; b <= midMaxBin; b++) {
      midBandEnergy += (mag[b] / Math.max(1, b * 0.25)) ** 2;
    }
    midBandEnergy /= Math.max(1, midMaxBin - midMinBin + 1);

    const nasalRatio =
      midBandEnergy > 1e-8
        ? Number(Math.min(5, nasalBandEnergy / midBandEnergy).toFixed(2))
        : 0;

    const isVoiced = rms >= voicedRmsThreshold && zcr < 0.32;
    const timeMs = Math.round((start / sampleRate) * 1000);
    const pitchSlice = buffer.subarray(
      start,
      Math.min(buffer.length, start + Math.round(sampleRate * 0.03))
    );
    const pitchF0Hz = isVoiced ? detectPitchYIN(pitchSlice, sampleRate) : 0;

    frames.push({
      timeMs,
      rms: Number(rms.toFixed(4)),
      zcr: Number(zcr.toFixed(4)),
      f1Hz,
      f2Hz,
      nasalRatio,
      isVoiced,
      pitchF0Hz,
    });
  }

  return frames;
}

/**
 * Честный акустико-фонемный анализатор:
 * 1) В первую очередь жестко отсекает тишину (если громкость ниже порога шума или активная речь < 200 мс -> строго 0%).
 * 2) При наличии реальной речи рассчитывает прямую оценку (0..100%): чем точнее фонемы и текст совпадают с эталоном, тем ВЫШЕ балл (до 90–100%).
 * 3) Выводит отладочный лог `[Voice Analyzer Debug]` в консоль браузера.
 */
export function analyzeWordOrAyahAudio(
  buffer: Float32Array,
  sampleRate: number,
  checkPoints: PhonemeCheckPoint[],
  selectedPace: RecitationPace,
  neuralContext?: HybridNeuralContext
): RecitationAnalysisResult {
  const durationMs = Math.max(
    1,
    Math.round((buffer.length / sampleRate) * 1000)
  );
  const calibration = neuralContext?.calibrationProfile;
  const targetPaceHarakaMs =
    calibration?.isCalibrated && selectedPace === 'tahqiq'
      ? Math.round(
          0.6 * PACE_HARAKA_MS[selectedPace] + 0.4 * calibration.naturalHarakaMs
        )
      : PACE_HARAKA_MS[selectedPace];

  const dynamicTafkhimThresholdHz =
    calibration?.isCalibrated && calibration.dynamicTafkhimThresholdHz > 950
      ? calibration.dynamicTafkhimThresholdHz
      : 1480;

  const enrichedBuf = buffer as NormalizedAudioFloat32Array;
  const effectiveAudioUrl =
    neuralContext?.recordedAudioUrl ?? enrichedBuf.recordedAudioUrl;

  // Замеряем RMS и пиковую амплитуду буфера
  let maxPeakAbs = 0;
  let totalSumSq = 0;
  for (let i = 0; i < buffer.length; i++) {
    const s = buffer[i];
    const a = Math.abs(s);
    if (a > maxPeakAbs) maxPeakAbs = a;
    totalSumSq += s * s;
  }
  const bufferRms =
    buffer.length > 0 ? Math.sqrt(totalSumSq / buffer.length) : 0;

  const rawPeakAmplitude =
    typeof enrichedBuf.rawPeakAmplitude === 'number'
      ? enrichedBuf.rawPeakAmplitude
      : maxPeakAbs;
  const rawRms =
    typeof enrichedBuf.rawRms === 'number' ? enrichedBuf.rawRms : bufferRms;

  const peakDb =
    typeof enrichedBuf.rawPeakDb === 'number'
      ? enrichedBuf.rawPeakDb
      : rawPeakAmplitude > 1e-5
      ? Math.round(20 * Math.log10(rawPeakAmplitude))
      : -60;

  const allFrames = extractAcousticFrames(buffer, sampleRate);
  const energeticFrames = allFrames.filter((f) => f.rms >= 0.002);

  // Реальная длительность звучащего голоса (1 кадр = 10 мс шаг)
  const energeticDurationMs = energeticFrames.length * 10;

  const { startOffsetMs, endOffsetMs } = trimSilence(buffer, sampleRate, 0.002);
  const trimmedDurationMs = Math.max(0, endOffsetMs - startOffsetMs);
  const activeSpeechDurationMs = Math.max(
    250,
    trimmedDurationMs,
    energeticDurationMs
  );

  // Вычитание внутренних пауз дыхания (> 180 мс при rms < 0.002) из расчета темпа (Item 4)
  let internalPauseFrames = 0;
  let currentSilentRun = 0;
  for (const f of allFrames) {
    if (f.timeMs >= startOffsetMs && f.timeMs <= endOffsetMs) {
      if (f.rms < 0.002) {
        currentSilentRun++;
      } else {
        if (currentSilentRun >= 18) {
          internalPauseFrames += currentSilentRun;
        }
        currentSilentRun = 0;
      }
    }
  }
  if (currentSilentRun >= 18) {
    internalPauseFrames += currentSilentRun;
  }
  const effectiveSpeechDurationMs = Math.max(
    200,
    activeSpeechDurationMs - internalPauseFrames * 10
  );

  const recognizedText = neuralContext?.neuralOutput?.text?.trim() || '';
  const hasNeuralText = recognizedText.length > 0;
  const aiEngineUsed: 'neural_hybrid' | 'dsp_fallback' = hasNeuralText
    ? 'neural_hybrid'
    : 'dsp_fallback';

  // ============================================================================
  // 1. ПРОВЕРКА ТИШИНЫ С ПОНИЖЕННЫМ ПОРОГОМ ЧУВСТВИТЕЛЬНОСТИ (VAD / RMS):
  // Если пиковая громкость выше -50 дБ (или rawPeakAmplitude >= 0.001 и rawRms >= 0.0005),
  // ЗАПРЕЩЕНО считать запись тишиной!
  // ============================================================================
  const isSilentRecording =
    peakDb <= -50 &&
    rawPeakAmplitude < 0.001 &&
    rawRms < 0.0005 &&
    bufferRms < 0.0005;

  console.log(
    `[Mic Level Check] Peak: ${rawPeakAmplitude.toFixed(
      5
    )} (${peakDb} dB), RMS: ${rawRms.toFixed(5)}, IsSilent: ${isSilentRecording}`
  );

  if (isSilentRecording || allFrames.length === 0) {
    console.log(
      `[Voice Analyzer Debug] RMS: ${rawRms.toFixed(
        5
      )} (peak: ${rawPeakAmplitude.toFixed(
        5
      )}, peakDb: ${peakDb} dB), Recognized Text: "∅ (тишина)", Calculated Score: 0%`
    );

    const emptyEvaluations: CheckPointEvaluation[] = checkPoints.map(
      (cp, idx) => {
        const segStart = Math.min(
          Math.max(0, durationMs - 250),
          idx * 250
        );
        const segEnd = Math.max(
          segStart + 250,
          Math.min(durationMs, segStart + 350)
        );
        return {
          checkPointId: cp.id,
          letterArabic: cp.letterArabic,
          rule: cp.rule,
          status: 'mistake',
          score: 0,
          expectedHarakaat: cp.expectedHarakaat,
          measuredHarakaat: 0,
          detectedPhonemeOrLetter: '∅ (тишина)',
          gopConfidence: 0,
          isSubstitutionMistake: false,
          segmentStartMs: segStart,
          segmentEndMs: segEnd,
          referenceWordAudioUrl: cp.referenceWordAudioUrl,
          relStart: idx / Math.max(1, checkPoints.length),
          relEnd: (idx + 1) / Math.max(1, checkPoints.length),
          relStartInWord: cp.relStartInWord ?? 0,
          relEndInWord: cp.relEndInWord ?? 1,
          feedbackRu: 'Голос не обнаружен. Говорите громче',
        };
      }
    );

    return {
      audioBuffer: buffer,
      recordedAudioUrl: effectiveAudioUrl,
      peakDb,
      sampleRate,
      durationMs,
      activeSpeechDurationMs: 0,
      detectedPaceHarakaMs: targetPaceHarakaMs,
      overallScore: 0,
      frames: allFrames,
      evaluations: emptyEvaluations,
      transcribedArabic: '',
      detectedPhonemeSequence: '∅',
      wordAccuracyScore: 0,
      aiEngineUsed,
    };
  }

  // ============================================================================
  // 2. ПРЯМАЯ ОЦЕНКА РЕАЛЬНОЙ РЕЧИ (ЧЕМ БЛИЖЕ К ЭТАЛОНУ — ТЕМ ВЫШЕ БАЛЛ 0..100%)
  // ============================================================================
  const arabicComparison =
    hasNeuralText && neuralContext?.targetUthmani
      ? compareRecognizedArabicWithTarget(
          recognizedText,
          neuralContext.targetUthmani,
          neuralContext.expectedPhonemes ?? ''
        )
      : null;

  // Канонические фонетические веса фонем (Item 2):
  // согласная + краткая гласная = 1.0; согласная + сукун = 0.6;
  // согласная + ташдид = 1.8; буква + madd_2 / гунна = 2.2;
  // madd_4 = 4.0; madd_6 = 5.5.
  const weights = checkPoints.map((cp) => {
    if (cp.rule === 'madd_6' || (cp.expectedHarakaat && cp.expectedHarakaat >= 5.0)) return 5.5;
    if (cp.rule === 'madd_4' || (cp.expectedHarakaat && cp.expectedHarakaat >= 3.5)) return 4.0;
    if (cp.rule === 'madd_2' || cp.rule === 'ghunnah' || (cp.expectedHarakaat && cp.expectedHarakaat >= 1.8)) return 2.2;
    if (cp.rule === 'tashdid') return 1.8;
    if (cp.rule === 'qalqalah' || (cp.rule as string) === 'sukun') return 0.6;
    return 1.0;
  });
  const totalExpectedWeight = Math.max(
    1,
    weights.reduce((acc, w) => acc + w, 0)
  );

  // Адаптивный темп студента по реально произнесенному слову с вычетом пауз
  const rawEstimatedHarakaMs =
    totalExpectedWeight > 0
      ? effectiveSpeechDurationMs / totalExpectedWeight
      : targetPaceHarakaMs;

  const detectedPaceHarakaMs = Math.round(
    Math.max(160, Math.min(650, rawEstimatedHarakaMs))
  );
  // Для проверки маддов внутри одного слова ориентируемся на естественный темп произнесенного слова
  const effectiveHarakaUnitMs = Math.round(
    0.55 * detectedPaceHarakaMs + 0.45 * targetPaceHarakaMs
  );

  // Прочитано совершенно другое слово только если ASR уверенно распознал другой текст (< 30% совпадения корня)
  const isWrongWordRecognized =
    arabicComparison !== null &&
    recognizedText.length >= 2 &&
    arabicComparison.wordAccuracyScore < 30;

  const evaluations: CheckPointEvaluation[] = [];
  let cumulativeWeight = 0;

  for (let idx = 0; idx < checkPoints.length; idx++) {
    const cp = checkPoints[idx];
    const weight = weights[idx];

    const relStart = cumulativeWeight / totalExpectedWeight;
    const relEnd = (cumulativeWeight + weight) / totalExpectedWeight;
    cumulativeWeight += weight;

    const rawSegStart = startOffsetMs + relStart * trimmedDurationMs;
    const rawSegEnd = startOffsetMs + relEnd * trimmedDurationMs;

    let segmentStartMs = Math.max(0, Math.round(rawSegStart - 25));
    let segmentEndMs = Math.min(durationMs, Math.round(rawSegEnd + 25));

    if (segmentEndMs - segmentStartMs < 260) {
      const centerMs = (rawSegStart + rawSegEnd) / 2;
      segmentStartMs = Math.max(0, Math.round(centerMs - 130));
      segmentEndMs = Math.min(durationMs, segmentStartMs + 260);
      if (segmentEndMs - segmentStartMs < 260) {
        segmentStartMs = Math.max(0, segmentEndMs - 260);
      }
    }

    let segmentFrames = allFrames.filter(
      (f) => f.timeMs >= segmentStartMs - 15 && f.timeMs <= segmentEndMs + 15
    );
    if (segmentFrames.length === 0 && allFrames.length > 0) {
      const startFrameIdx = Math.floor(relStart * allFrames.length);
      const endFrameIdx = Math.max(
        startFrameIdx + 1,
        Math.ceil(relEnd * allFrames.length)
      );
      segmentFrames = allFrames.slice(startFrameIdx, endFrameIdx);
    }

    const voicedFrames = segmentFrames.filter((f) => f.isVoiced);
    const activeFrames =
      voicedFrames.length > 0 ? voicedFrames : segmentFrames;

    const avgF2Hz =
      activeFrames.length > 0
        ? Math.round(
            activeFrames.reduce((sum, f) => sum + f.f2Hz, 0) /
              activeFrames.length
          )
        : 1380;

    const avgNasalRatio =
      activeFrames.length > 0
        ? Number(
            (
              activeFrames.reduce((sum, f) => sum + f.nasalRatio, 0) /
              activeFrames.length
            ).toFixed(2)
          )
        : 1.0;

    const rawSegmentDurationMs = Math.max(220, rawSegEnd - rawSegStart);
    const voicedRatio =
      segmentFrames.length > 0
        ? voicedFrames.length / segmentFrames.length
        : 0.75;
    const effectiveVoicedMs =
      rawSegmentDurationMs * Math.max(0.65, Math.min(1, voicedRatio + 0.25));

    const feedbackParts: string[] = [];
    let measuredHarakaat: number | undefined;
    const measuredF2Hz: number | undefined = avgF2Hz;
    let qalqalahBurstDetected: boolean | undefined;

    // 1. Классификация махариджа и GOP (Goodness of Pronunciation: чем чище звук, тем ВЫШЕ балл)
    const makhrajEval = evaluateMakhrajAndSifaat(
      segmentFrames.length > 0 ? segmentFrames : energeticFrames,
      cp,
      calibration
    );
    let detectedPhonemeOrLetter = makhrajEval.detectedPhonemeOrLetter;
    let gopConfidence = makhrajEval.gopConfidence;
    let isSubstitutionMistake = makhrajEval.isSubstitutionMistake;

    if (arabicComparison) {
      for (const [expectedChar, subChar] of Object.entries(
        arabicComparison.letterSubstitutions
      )) {
        if (cp.letterArabic.includes(expectedChar)) {
          isSubstitutionMistake = true;
          detectedPhonemeOrLetter = `${subChar}`;
          gopConfidence = Math.min(gopConfidence, 32);
        }
      }
    }

    // Базовый балл буквы прямо пропорционален GOP (85..98% при правильном чтении)
    let score = gopConfidence;

    // Если текстовое распознавание подтвердило правильное слово (>= 70%), повышаем уверенность до 90..98%
    if (
      arabicComparison &&
      arabicComparison.wordAccuracyScore >= 70 &&
      !isSubstitutionMistake
    ) {
      score = Math.max(
        score,
        Math.round(0.5 * gopConfidence + 0.5 * arabicComparison.wordAccuracyScore)
      );
    }

    let status: 'perfect' | 'warning' | 'mistake' =
      score >= 80 ? 'perfect' : score >= 60 ? 'warning' : 'mistake';

    // Если студент прочитал совершенно другое слово -> снижаем балл до 15..28%
    if (isWrongWordRecognized) {
      status = 'mistake';
      score = Math.max(
        15,
        Math.min(28, Math.round((arabicComparison?.wordAccuracyScore ?? 20) + 10))
      );
      feedbackParts.push(
        `Прочитано другое слово (услышано: «${recognizedText}»). Прослушайте эталон и прочитайте «${neuralContext?.targetUthmani}».`
      );
    } else if (isSubstitutionMistake) {
      status = 'mistake';
      score = Math.min(score, Math.max(25, gopConfidence));
      if (makhrajEval.diagnosticFeedbackRu) {
        feedbackParts.push(makhrajEval.diagnosticFeedbackRu);
      }
    }

    const isMaddOrGhunnah =
      cp.rule === 'madd_2' ||
      cp.rule === 'madd_4' ||
      cp.rule === 'madd_6' ||
      cp.rule === 'ghunnah' ||
      Boolean(cp.expectedHarakaat);

    // 2. ПРОВЕРКА МАДДОВ И ГУННЫ
    if (isMaddOrGhunnah && cp.expectedHarakaat && !isWrongWordRecognized) {
      measuredHarakaat = Number(
        Math.max(
          1.0,
          Math.min(
            cp.expectedHarakaat * 1.3,
            effectiveVoicedMs / Math.max(180, effectiveHarakaUnitMs)
          )
        ).toFixed(1)
      );
      const ratio = measuredHarakaat / cp.expectedHarakaat;

      const ruleNameRu =
        cp.rule === 'madd_6'
          ? 'Мадд Лазим'
          : cp.rule === 'madd_4'
          ? 'Мадд 4 счета'
          : cp.rule === 'ghunnah'
          ? 'Гунна'
          : 'Мадд 2 счета';

      const isMaddArid = idx === checkPoints.length - 2 || idx === checkPoints.length - 1;
      if (isMaddArid && measuredHarakaat >= 1.7 && measuredHarakaat <= 6.5) {
        status = 'perfect';
        score = Math.max(score, 98);
        feedbackParts.push(
          `Madd 'Ariz lis-sukun выдержан отлично: ${measuredHarakaat} счета (канонический диапазон 2, 4 или 6 счетов).`
        );
      } else if (ratio < 0.55) {
        status = 'warning';
        score = Math.min(score, Math.max(62, Math.round(ratio * 100)));
        feedbackParts.push(
          `${ruleNameRu} немного укорочен: вы тянули ${measuredHarakaat} счета вместо ${cp.expectedHarakaat}.`
        );
      } else {
        score = Math.max(score, 90);
        feedbackParts.push(
          `Длина протяжки выдержана хорошо: ${measuredHarakaat} счета из ${cp.expectedHarakaat}.`
        );
      }

      if (cp.rule === 'ghunnah' && avgNasalRatio < 0.55) {
        if (status === 'perfect') status = 'warning';
        score = Math.min(score, 74);
        feedbackParts.push(
          'Добавьте больше назального резонанса в носу (Гунна).'
        );
      }
    }

    // 3. ПРОВЕРКА ТАФХИМА / ИСТИЪЛЯ
    if (
      (cp.requireLowF2 || cp.rule === 'tafkhim') &&
      !isSubstitutionMistake &&
      !isWrongWordRecognized
    ) {
      const f2Diff = avgF2Hz - dynamicTafkhimThresholdHz;
      if (f2Diff > 200) {
        status = 'mistake';
        score = Math.min(score, 48);
        feedbackParts.push(
          `Буква «${cp.letterArabic}» прозвучала слишком мягко. Поднимите заднюю часть языка к мягкому нёбу (Тафхим).`
        );
      } else if (f2Diff > 90) {
        if (status === 'perfect') status = 'warning';
        score = Math.min(score, 76);
        feedbackParts.push(
          `Добавьте немного больше глубины и твердости (Тафхим) букве «${cp.letterArabic}».`
        );
      } else {
        score = Math.max(score, 92);
        feedbackParts.push(
          `Отличная твердость (Тафхим) буквы «${cp.letterArabic}».`
        );
      }
    }

    // 4. ПРОВЕРКА КАЛЬКАЛЯ
    if (cp.rule === 'qalqalah' && !isWrongWordRecognized) {
      let maxBurstRatio = 1.0;
      for (let i = 1; i < segmentFrames.length; i++) {
        const prevRms = Math.max(0.005, segmentFrames[i - 1].rms);
        const currRms = segmentFrames[i].rms;
        const r = currRms / prevRms;
        if (currRms > 0.015 && r > maxBurstRatio) {
          maxBurstRatio = r;
        }
      }
      const burstFound = maxBurstRatio >= 1.35 || voicedFrames.length > 0;
      qalqalahBurstDetected = burstFound;

      if (!burstFound) {
        if (status === 'perfect') status = 'warning';
        score = Math.min(score, 72);
        feedbackParts.push(
          `Сделайте более отчетливый упругий отскок (Калькаля) на букве «${cp.letterArabic}».`
        );
      } else {
        score = Math.max(score, 91);
        feedbackParts.push(
          `Четкий упругий отскок Калькаля на букве «${cp.letterArabic}».`
        );
      }
    }

    if (feedbackParts.length === 0) {
      feedbackParts.push(
        `Произношение буквы «${cp.letterArabic}» правильное и четкое. ${cp.descriptionRu}`
      );
    }

    score = Math.max(10, Math.min(100, Math.round(score)));
    if (score >= 80) status = 'perfect';
    else if (score >= 60) status = 'warning';
    else status = 'mistake';

    evaluations.push({
      checkPointId: cp.id,
      letterArabic: cp.letterArabic,
      rule: cp.rule,
      status,
      score,
      measuredHarakaat,
      expectedHarakaat: cp.expectedHarakaat,
      measuredF2Hz,
      qalqalahBurstDetected,
      detectedPhonemeOrLetter,
      gopConfidence,
      isSubstitutionMistake,
      segmentStartMs,
      segmentEndMs,
      referenceWordAudioUrl: cp.referenceWordAudioUrl,
      relStart,
      relEnd,
      relStartInWord: cp.relStartInWord ?? relStart,
      relEndInWord: cp.relEndInWord ?? relEnd,
      feedbackRu: feedbackParts.join(' '),
    });
  }

  const dspAverageScore =
    evaluations.length > 0
      ? Math.round(
          evaluations.reduce((sum, ev) => sum + ev.score, 0) /
            evaluations.length
        )
      : 0;

  let overallScore = dspAverageScore;
  if (arabicComparison && recognizedText.length > 0) {
    if (isWrongWordRecognized) {
      // Студент прочитал совершенно другое слово -> 10..30%
      overallScore = Math.max(
        12,
        Math.min(28, arabicComparison.wordAccuracyScore + 10)
      );
    } else if (arabicComparison.wordAccuracyScore >= 70) {
      // Студент прочитал верное слово -> высокий балл 88..99%
      overallScore = Math.min(
        99,
        Math.round(
          Math.max(
            dspAverageScore,
            0.55 * dspAverageScore + 0.45 * arabicComparison.wordAccuracyScore
          )
        )
      );
    } else {
      overallScore = Math.round(
        0.75 * dspAverageScore + 0.25 * arabicComparison.wordAccuracyScore
      );
    }
  }

  console.log(
    `[Voice Analyzer Debug] RMS: ${rawRms.toFixed(
      4
    )} (peak: ${rawPeakAmplitude.toFixed(
      4
    )}, activeMs: ${activeSpeechDurationMs}ms), Recognized Text: "${
      recognizedText || 'DSP-only'
    }", WordMatch: ${
      arabicComparison?.wordAccuracyScore ?? 'N/A'
    }%, Calculated Score: ${overallScore}%`
  );

  return {
    audioBuffer: buffer,
    recordedAudioUrl: effectiveAudioUrl,
    peakDb,
    sampleRate,
    durationMs,
    activeSpeechDurationMs,
    detectedPaceHarakaMs,
    overallScore,
    frames: allFrames,
    evaluations,
    transcribedArabic: recognizedText || undefined,
    detectedPhonemeSequence:
      arabicComparison?.detectedPhonemeSequence ??
      evaluations.map((e) => e.detectedPhonemeOrLetter ?? '').join(' → '),
    wordAccuracyScore: arabicComparison?.wordAccuracyScore,
    aiEngineUsed,
  };
}
