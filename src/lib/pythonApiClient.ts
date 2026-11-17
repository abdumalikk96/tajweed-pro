import {
  CheckPointEvaluation,
  PhonemeCheckPoint,
  RecitationAnalysisResult,
  TajweedRuleType,
} from '@/types/quran';
import { encodeWavBlob } from '@/lib/audioUtils';
import { normalizeUthmaniToImlai } from '@/lib/uthmaniNormalizer';

export { normalizeUthmaniToImlai as normalize_uthmani_to_imlai, normalizeUthmaniToImlai };

export const PYTHON_BACKEND_URL = (
  process.env.NEXT_PUBLIC_PYTHON_API_URL ||
  process.env.NEXT_PUBLIC_PYTHON_BACKEND_URL ||
  'http://127.0.0.1:8000'
).replace(/\/+$/, '');

export interface PythonLetterEvaluation {
  letter: string;
  rule: string;
  status: 'perfect' | 'warning' | 'mistake';
  score: number;
  detected_letter?: string | null;
  f2_hz?: number | null;
  zcr?: number | null;
  onset_ratio?: number | null;
  issue_uz: string;
  anatomical_tip_uz: string;
  word_index?: number | null;
  word_arabic?: string | null;
}

export interface PythonAcousticMetrics {
  rms_mean: number;
  rms_max: number;
  peak_db: number;
  active_duration_ms: number;
  f1_hz: number;
  f2_hz: number;
  onset_max: number;
  onset_ratio: number;
  measured_harakaat: number;
}

export interface PythonAnalyzeResponse {
  score: number;
  status: 'correct' | 'mistake';
  detected_issue: string;
  duration_ms: number;
  metrics: PythonAcousticMetrics;
  recognized_text?: string;
  letter_evaluations?: PythonLetterEvaluation[];
  text_similarity?: number;
  duration_ratio?: number | null;
  madd_ok?: boolean;
  multi_sheikh_consensus?: number;
  strictness_level?: number;
  student_unit_ms?: number;
  is_live_chunk?: boolean;
  spoken_words_count?: number;
  verified_words_count?: number;
  total_words_count?: number;
  spoken_letter_count?: number;
  failed_word_index?: number | null;
  failed_word_arabic?: string | null;
}

/** Убирает огласовки и нормализует форму буквы, чтобы «قَ» сопоставлялась с «ق» из бэкенда. */
function baseArabicLetter(text: string): string {
  const stripped = (text || '')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
  const match = stripped.match(/[\u0621-\u064A]/);
  return match ? match[0] : stripped;
}

const STATUS_SEVERITY: Record<PythonLetterEvaluation['status'], number> = {
  perfect: 0,
  warning: 1,
  mistake: 2,
};

/** Правила, которые бэкенд реально проверяет посегментно (Махрадж / Тафхим / Изхар / Харакат / Ташдид). */
const BACKEND_LETTER_RULES: TajweedRuleType[] = [
  'makhraj_critical',
  'tafkhim',
  'ithhar',
  'qalqalah',
  'harakat',
  'tashdid',
];

function isMaddRule(rule: TajweedRuleType): boolean {
  return rule === 'madd_2' || rule === 'madd_4' || rule === 'madd_6';
}

/**
 * Оценка карточки Мадда СТРОГО по длительности (отношение длительности ученика к эталону шейха).
 * Возвращает null, если длительность эталона неизвестна (тогда остаётся локальная оценка).
 */
function evaluateMaddCard(
  ev: CheckPointEvaluation,
  durationRatio: number | null | undefined
): CheckPointEvaluation | null {
  const expected = ev.expectedHarakaat ?? 2;
  if (
    ev.measuredHarakaat !== undefined &&
    Math.abs(ev.measuredHarakaat - expected) < 0.45
  ) {
    return {
      ...ev,
      score: 98,
      status: 'perfect',
      feedbackRu: `Madd ${expected} harakat me'yorida to'g'ri cho'zildi (${ev.measuredHarakaat} harakat).`,
    };
  }
  if (durationRatio === null || durationRatio === undefined || !(durationRatio > 0)) {
    return null;
  }

  const measuredFromRatio = Math.round(expected * durationRatio * 10) / 10;
  if (durationRatio >= 0.75 || Math.abs(measuredFromRatio - expected) < 0.45) {
    const measured = Math.max(
      measuredFromRatio,
      Math.round(expected * Math.min(durationRatio, 1.5) * 10) / 10
    );
    return {
      ...ev,
      score: Math.min(98, Math.round(92 + Math.min(durationRatio, 1.0) * 6)),
      status: 'perfect',
      measuredHarakaat: measured,
      feedbackRu: `Madd ${expected} harakat to'liq cho'zildi.`,
    };
  }

  const measured = Math.round(expected * durationRatio * 10) / 10;
  if (durationRatio >= 0.6) {
    return {
      ...ev,
      score: 76,
      status: 'perfect',
      measuredHarakaat: measured,
      feedbackRu: `Madd deyarli to'liq: ${measured} / ${expected} harakat.`,
    };
  }

  return {
    ...ev,
    score: Math.max(25, Math.round(durationRatio * 100)),
    status: 'mistake',
    measuredHarakaat: measured,
    feedbackRu: `Madd qisqa bo'lib qoldi: siz ${measured} harakat cho'zdingiz, ${expected} harakat kerak.`,
  };
}

function resolveBackendBaseUrls(): string[] {
  if (typeof window === 'undefined') return [PYTHON_BACKEND_URL];
  const isLocalHost =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
  const configuredIsLocal =
    PYTHON_BACKEND_URL.includes('127.0.0.1') ||
    PYTHON_BACKEND_URL.includes('localhost');

  if (!isLocalHost && configuredIsLocal) {
    return [''];
  }
  return [PYTHON_BACKEND_URL, ''];
}

/**
 * Отправляет аудио-Blob с микрофона на Python FastAPI + Whisper + Praat сервер
 * (`POST /api/analyze-recitation`) с автоматическим облачным фоллбэком.
 */
export async function analyzeBlobWithPythonBackend(
  audioBlob: Blob,
  expectedRule: string,
  expectedHarakaat = 2,
  letterArabic = '',
  expectedText = '',
  referenceDurationMs = 0,
  strictnessLevel = 75,
  sheikhId = 'husary'
): Promise<PythonAnalyzeResponse | null> {
  if (typeof window === 'undefined') return null;

  const baseUrls = resolveBackendBaseUrls();

  for (const baseUrl of baseUrls) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18000);

    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'recitation.wav');
      formData.append('expected_rule', expectedRule);
      formData.append('expected_harakaat', String(expectedHarakaat));
      formData.append('letter_arabic', letterArabic);
      formData.append('expected_text', expectedText);
      formData.append('reference_duration_ms', String(referenceDurationMs));
      formData.append('strictness_level', String(strictnessLevel));
      formData.append('sheikh_id', sheikhId);

      const response = await fetch(`${baseUrl}/api/analyze-recitation`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as PythonAnalyzeResponse;
      }
    } catch {
      // try next baseUrl
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

/**
 * Сверхбыстрый потоковый запрос во время активной записи (`POST /api/analyze-live-chunk`):
 * Оценивает уже произнесенные слова и буквы в реальном времени без штрафа за еще не прочитанные слова.
 */
export async function analyzeLiveChunkWithPythonBackend(
  audioBlob: Blob,
  expectedRule: string,
  expectedHarakaat = 2,
  letterArabic = '',
  expectedText = '',
  strictnessLevel = 75,
  sheikhId = 'husary',
  liveTranscript = '',
  verifiedWordsCount = 0,
  chunkReason: 'interval' | 'word_pause' = 'interval',
  externalSignal?: AbortSignal
): Promise<PythonAnalyzeResponse | null> {
  if (typeof window === 'undefined') return null;

  if (externalSignal?.aborted) {
    return null;
  }

  const baseUrls = resolveBackendBaseUrls();

  for (const baseUrl of baseUrls) {
    if (externalSignal?.aborted) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3800);

    const onExternalAbort = () => {
      controller.abort();
    };
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'live_chunk.wav');
      formData.append('expected_rule', expectedRule);
      formData.append('expected_harakaat', String(expectedHarakaat));
      formData.append('letter_arabic', letterArabic);
      formData.append('expected_text', expectedText);
      formData.append('strictness_level', String(strictnessLevel));
      formData.append('sheikh_id', sheikhId);
      formData.append('is_live_chunk', 'true');
      formData.append('use_whisper', 'true');
      formData.append('verified_words_count', String(verifiedWordsCount));
      formData.append('chunk_reason', chunkReason);
      if (liveTranscript) {
        formData.append('live_transcript', liveTranscript);
      }

      const response = await fetch(`${baseUrl}/api/analyze-live-chunk`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as PythonAnalyzeResponse;
      }
    } catch {
      // try next baseUrl
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }
  return null;
}

/**
 * Потоковый анализ накопленного буфера во время записи (`isRecording === true`).
 * Возвращает живые оценки (`letterEvaluations`, `evaluations`, `spokenWordsCount`, `verifiedWordsCount`, `failedWordIndex`)
 * для мгновенной пословной синхронизации и мгновенного прерывания при ошибке в режиме экзамена.
 */
export async function analyzeLiveChunkWithPythonFallback(
  audioBuffer: Float32Array,
  sampleRate: number,
  checkPoints: PhonemeCheckPoint[],
  localResult: RecitationAnalysisResult,
  options?: {
    expectedText?: string;
    strictnessLevel?: number;
    sheikhId?: string;
    liveTranscript?: string;
    activeWordIds?: string[];
    verifiedWordsCount?: number;
    chunkReason?: 'interval' | 'word_pause';
    signal?: AbortSignal;
  }
): Promise<RecitationAnalysisResult> {
  const prevVerified = Math.max(0, options?.verifiedWordsCount ?? 0);
  if (!audioBuffer || audioBuffer.length === 0 || checkPoints.length === 0 || options?.signal?.aborted) {
    return {
      ...localResult,
      isLivePreview: true,
      spokenWordsCount: prevVerified,
      verifiedWordsCount: prevVerified,
      spokenLetterCount: 0,
      failedWordIndex: null,
      failedWordArabic: null,
    };
  }

  const expectedText = options?.expectedText || '';
  const strictnessLevel = Math.max(50, Math.min(100, options?.strictnessLevel ?? 75));
  const sheikhId = options?.sheikhId || 'husary';
  const liveTranscript = options?.liveTranscript || '';
  const chunkReason = options?.chunkReason || 'interval';
  const passThreshold = Math.round(55 + ((strictnessLevel - 50) / 50) * 30);

  const wavBlob = encodeWavBlob(audioBuffer, sampleRate);
  const firstCp = checkPoints[0];

  const liveResp = await analyzeLiveChunkWithPythonBackend(
    wavBlob,
    firstCp.rule,
    firstCp.expectedHarakaat ?? 2,
    firstCp.letterArabic,
    expectedText,
    strictnessLevel,
    sheikhId,
    liveTranscript,
    prevVerified,
    chunkReason,
    options?.signal
  );

  const totalWords = Math.max(
    1,
    expectedText.split(/\s+/).filter((w) => w.trim().length > 0).length
  );
  const activeDurMs =
    liveResp?.metrics?.active_duration_ms ||
    localResult.activeSpeechDurationMs ||
    Math.round((audioBuffer.length / sampleRate) * 1000);

  if (!liveResp) {
    return {
      ...localResult,
      strictnessLevel,
      multiSheikhConsensus: localResult.overallScore,
      isLivePreview: true,
      spokenWordsCount: prevVerified,
      verifiedWordsCount: prevVerified,
      totalWordsCount: totalWords,
      spokenLetterCount: 0,
      failedWordIndex: null,
      failedWordArabic: null,
    };
  }

  // Строгая пословная синхронизация: не перепрыгиваем через непроверенные слова!
  const verifiedWordsCount = Math.max(
    0,
    Math.min(totalWords, liveResp.verified_words_count ?? prevVerified)
  );
  const spokenWordsCount = Math.max(
    verifiedWordsCount,
    Math.min(totalWords, liveResp.spoken_words_count ?? verifiedWordsCount)
  );
  const spokenLetterCount = liveResp.spoken_letter_count ?? 0;
  const failedWordIndex =
    liveResp.failed_word_index !== undefined ? liveResp.failed_word_index : null;
  const failedWordArabic = liveResp.failed_word_arabic ?? null;

  const pyLetters = liveResp.letter_evaluations || [];
  const hasWordMistake =
    liveResp.status === 'mistake' ||
    (failedWordIndex !== null && failedWordIndex >= 0) ||
    pyLetters.some((le) => le.status === 'mistake' || le.score < passThreshold);

  const allowedWordIds = options?.activeWordIds
    ? options.activeWordIds.slice(0, Math.max(1, spokenWordsCount))
    : null;
  const failedWordId =
    failedWordIndex !== null &&
    failedWordIndex >= 0 &&
    options?.activeWordIds &&
    options.activeWordIds[failedWordIndex]
      ? options.activeWordIds[failedWordIndex]
      : null;

  const updatedEvaluations: CheckPointEvaluation[] = localResult.evaluations
    .filter((ev) => {
      if (!allowedWordIds || allowedWordIds.length === 0) return true;
      for (let i = 0; i < allowedWordIds.length; i++) {
        if (ev.checkPointId.includes(allowedWordIds[i])) return true;
      }
      return false;
    })
    .map((ev) => {
      if (hasWordMistake && (!failedWordId || ev.checkPointId.includes(failedWordId))) {
        const matchingPyErr = pyLetters.find(
          (pl) =>
            (pl.status === 'mistake' || pl.score < passThreshold) &&
            baseArabicLetter(pl.letter) === baseArabicLetter(ev.letterArabic)
        );
        const firstPyErr =
          matchingPyErr ??
          pyLetters.find((pl) => pl.status === 'mistake' || pl.score < passThreshold);
        if (matchingPyErr || (failedWordId && ev.checkPointId.includes(failedWordId))) {
          return {
            ...ev,
            score: Math.round(firstPyErr?.score ?? Math.min(45, liveResp.score)),
            status: 'mistake' as const,
            feedbackRu:
              firstPyErr?.issue_uz ||
              liveResp.detected_issue ||
              `«${ev.letterArabic}» xato o'qildi.`,
          };
        }
      }
      return {
        ...ev,
        score: 95,
        status: 'perfect' as const,
        feedbackRu: `«${ev.letterArabic}» to'g'ri o'qildi.`,
      };
    });

  const computedLiveScore = hasWordMistake
    ? Math.min(58, Math.round(liveResp.score))
    : Math.max(88, Math.round(liveResp.score));

  return {
    ...localResult,
    overallScore: computedLiveScore,
    activeSpeechDurationMs: activeDurMs,
    peakDb: Math.round(liveResp.metrics.peak_db),
    evaluations: updatedEvaluations,
    letterEvaluations: pyLetters,
    detectedIssue: liveResp.detected_issue,
    transcribedArabic: liveResp.recognized_text?.trim() || liveTranscript,
    multiSheikhConsensus:
      liveResp.multi_sheikh_consensus ?? computedLiveScore,
    strictnessLevel: liveResp.strictness_level ?? strictnessLevel,
    studentUnitMs: liveResp.student_unit_ms,
    isLivePreview: !hasWordMistake,
    spokenWordsCount,
    verifiedWordsCount,
    totalWordsCount: liveResp.total_words_count ?? totalWords,
    spokenLetterCount,
    failedWordIndex,
    failedWordArabic,
  };
}

/**
 * Честный анализ чтения с бэкенда с глубокой двухступенчатой проверкой Махраджа:
 * 1. Посегментный анализ формант (F2 для твердых букв, ZCR для межзубных, F1 для гортанных).
 * 2. Сличение с матрицей путаницы (MAKHRAJ_CONFUSION_PAIRS) и Whisper с нейтральным промптом.
 * 3. Формирование анатомических инструкций для каждой буквы в карточках ошибок.
 */
export async function analyzeRecitationWithPythonFallback(
  audioBuffer: Float32Array,
  sampleRate: number,
  checkPoints: PhonemeCheckPoint[],
  localResult: RecitationAnalysisResult,
  options?: {
    expectedText?: string;
    referenceDurationMs?: number;
    strictnessLevel?: number;
    sheikhId?: string;
  }
): Promise<RecitationAnalysisResult> {
  if (!audioBuffer || audioBuffer.length === 0 || checkPoints.length === 0) {
    return localResult;
  }

  const expectedText = options?.expectedText || '';
  const referenceDurationMs = options?.referenceDurationMs || 0;
  const strictnessLevel = Math.max(50, Math.min(100, options?.strictnessLevel ?? 75));
  const sheikhId = options?.sheikhId || 'husary';

  // Порог прохождения буквы: от 60% при сложности 50% до 85% при сложности 100%
  const passThreshold = Math.round(55 + ((strictnessLevel - 50) / 50) * 30);

  const fullWavBlob = encodeWavBlob(audioBuffer, sampleRate);
  const firstCp = checkPoints[0];

  const probeResponse = await analyzeBlobWithPythonBackend(
    fullWavBlob,
    firstCp.rule,
    firstCp.expectedHarakaat ?? 2,
    firstCp.letterArabic,
    expectedText,
    referenceDurationMs,
    strictnessLevel,
    sheikhId
  );

  if (!probeResponse) {
    console.log(
      '[Python Backend] Сервер localhost:8000 недоступен — используется локальный анализатор.'
    );
    return {
      ...localResult,
      strictnessLevel,
      multiSheikhConsensus: localResult.overallScore,
    };
  }

  console.log('[Python Backend] Ответ от Whisper/Praat сервера:', probeResponse);

  const recognizedTextFromWhisper = probeResponse.recognized_text?.trim() || '';

  // ЗАПРЕТ НА ФЕЙКОВЫЕ 89% ПРИ ПУСТОЙ РЕЧИ:
  // Если Whisper вернул пустую строку (Ovozdan so'z aniqlanmadi) или бэкенд вернул score === 0,
  // оценка ОБЯЗАНА быть 0% со статусом "Ovoz eshitilmadi — qaytadan o'qing"!
  if (!recognizedTextFromWhisper || probeResponse.score === 0) {
    return {
      ...localResult,
      overallScore: 0,
      evaluations: [],
      letterEvaluations: [],
      detectedIssue: "Ovoz eshitilmadi — qaytadan o'qing",
      transcribedArabic: '',
      multiSheikhConsensus: 0,
      strictnessLevel,
    };
  }

  const isBareAlifOrWasla = (raw: string): boolean => {
    const base = baseArabicLetter(raw);
    return (
      (base === 'ا' || base === 'ٱ' || raw.includes('ٱ')) &&
      !raw.includes('أ') &&
      !raw.includes('إ') &&
      !raw.includes('ء')
    );
  };

  const pyLetters = (probeResponse.letter_evaluations || []).map((plet) => {
    if (isBareAlifOrWasla(plet.letter) && plet.rule === 'makhraj_critical') {
      return {
        ...plet,
        status: 'perfect' as const,
        score: 98,
        issue_uz: '',
      };
    }
    return plet;
  });

  // Карта посегментных оценок по БАЗОВОЙ букве. Если буква встречается в слове
  // несколько раз, сохраняем самый строгий вердикт (с наименьшим баллом).
  const letterMap = new Map<string, PythonLetterEvaluation>();
  for (const plet of pyLetters) {
    const key = baseArabicLetter(plet.letter);
    const existing = letterMap.get(key);
    if (!existing || STATUS_SEVERITY[plet.status] > STATUS_SEVERITY[existing.status] || plet.score < existing.score) {
      letterMap.set(key, plet);
    }
  }

  // Прочитано совершенно другое слово только при крайне низкой текстовой схожести (< 0.35) или пустом ответе
  const wordCompletelyWrong =
    probeResponse.score <= 22.0 ||
    (typeof probeResponse.text_similarity === 'number' &&
      probeResponse.text_similarity < 0.35 &&
      pyLetters.length > 0 &&
      pyLetters.every((l) => l.status === 'mistake'));

  const updatedEvaluations: CheckPointEvaluation[] = localResult.evaluations.map(
    (ev) => {
      const letterKey = baseArabicLetter(ev.letterArabic);
      const pyLetterEval = letterMap.get(letterKey);

      if (wordCompletelyWrong) {
        return {
          ...ev,
          score: 25,
          status: 'mistake',
          feedbackRu:
            probeResponse.detected_issue ||
            `Siz boshqa so'z o'qidingiz: «${recognizedTextFromWhisper}» (Kutilgan: «${expectedText}»). Iltimos, tanlangan so'zni o'qing.`,
        };
      }

      if (
        isBareAlifOrWasla(ev.letterArabic) &&
        (ev.rule === 'makhraj_critical' || ev.rule === 'ithhar')
      ) {
        return {
          ...ev,
          score: 98,
          status: 'perfect',
          isSubstitutionMistake: false,
          feedbackRu: `«${ev.letterArabic}» to'g'ri talaffuz qilindi.`,
        };
      }

      // Если длительность Мадда отличается от ожидаемой менее чем на 0.45 хараката (например, 1.9 при норме 2.0),
      // НЕ выдаем ложную ошибку harakat / madd_2 с 35% (как на «مَ» в مَٰلِكِ) — это 98% точности (perfect)!
      if (
        ev.expectedHarakaat !== undefined &&
        ev.measuredHarakaat !== undefined &&
        Math.abs(ev.measuredHarakaat - ev.expectedHarakaat) < 0.45 &&
        (!pyLetterEval || pyLetterEval.rule === 'harakat' || pyLetterEval.rule === 'madd_2')
      ) {
        return {
          ...ev,
          score: 98,
          status: 'perfect',
          isSubstitutionMistake: false,
          feedbackRu: `Me'yorida to'g'ri cho'zildi (${ev.measuredHarakaat} / ${ev.expectedHarakaat} harakat).`,
        };
      }

      // Если для этой буквы бэкенд выявил ошибку (Харакат / Ташдид / Мадд / Махрадж)
      // карточка ОБЯЗАТЕЛЬНО получает статус mistake, даже если это правило мадда!
      if (pyLetterEval && (pyLetterEval.status !== 'perfect' || pyLetterEval.score < passThreshold)) {
        return {
          ...ev,
          score: Math.min(ev.score, Math.round(pyLetterEval.score)),
          status: pyLetterEval.status,
          rule: (pyLetterEval.rule as TajweedRuleType) || ev.rule,
          feedbackRu: `${pyLetterEval.issue_uz} ${pyLetterEval.anatomical_tip_uz}`.trim(),
          detectedPhonemeOrLetter: pyLetterEval.detected_letter ?? ev.detectedPhonemeOrLetter,
          isSubstitutionMistake: Boolean(pyLetterEval.detected_letter),
          measuredF2Hz:
            pyLetterEval.f2_hz && pyLetterEval.f2_hz > 0
              ? Math.round(pyLetterEval.f2_hz)
              : ev.measuredF2Hz,
        };
      }

      // 1. Мадд — если ошибок по букве нет, оцениваем по длительности
      if (isMaddRule(ev.rule)) {
        return evaluateMaddCard(ev, probeResponse.duration_ratio) ?? ev;
      }

      // 2. Махрадж / Тафхим / Изхар / Харакат / Ташдид — или любое правило при чистом распознавании слова Whisper
      const isWordRecognizedCorrectly =
        probeResponse.score >= 80 ||
        probeResponse.status === 'correct' ||
        (probeResponse.text_similarity !== undefined && probeResponse.text_similarity >= 0.68);

      if (
        (isWordRecognizedCorrectly && (ev.rule === 'makhraj_critical' || ev.rule === 'ithhar')) ||
        (BACKEND_LETTER_RULES.includes(ev.rule) && (!pyLetterEval || pyLetterEval.status === 'perfect')) ||
        (isWordRecognizedCorrectly && (!pyLetterEval || pyLetterEval.status === 'perfect'))
      ) {
        return {
          ...ev,
          score: Math.max(88, ev.score),
          status: 'perfect',
          isSubstitutionMistake: false,
          feedbackRu: `«${ev.letterArabic}» to'g'ri talaffuz qilindi.`,
          measuredF2Hz:
            pyLetterEval?.f2_hz && pyLetterEval.f2_hz > 0
              ? Math.round(pyLetterEval.f2_hz)
              : ev.measuredF2Hz,
        };
      }

      // 3. Остальные правила — локальная оценка
      return ev;
    }
  );

  // 4. Любой элемент в letter_evaluations со статусом mistake или score < passThreshold
  //    (особенно с правилами harakat, tashdid, madd_2, makhraj_critical)
  //    ДОЛЖЕН принудительно превращаться в карточку ошибки в массиве evaluations!
  const isWordRecognizedOverall =
    probeResponse.score >= 80 ||
    probeResponse.status === 'correct' ||
    (probeResponse.text_similarity !== undefined && probeResponse.text_similarity >= 0.68);

  for (const plet of pyLetters) {
    if (isBareAlifOrWasla(plet.letter) && plet.rule === 'makhraj_critical') {
      continue;
    }
    // Защита от ложных ошибок: если слово распознано и подтверждено Whisper,
    // исключаем ложные карточки Izhor и Maxraj
    if (isWordRecognizedOverall && (plet.rule === 'makhraj_critical' || plet.rule === 'ithhar')) {
      continue;
    }
    if (plet.status !== 'perfect' || plet.score < passThreshold) {
      const key = baseArabicLetter(plet.letter);
      const alreadyHasMistake = updatedEvaluations.some(
        (ev) =>
          baseArabicLetter(ev.letterArabic) === key &&
          (ev.status === 'mistake' || ev.status === 'warning')
      );
      if (!alreadyHasMistake) {
        const matchingCp = checkPoints.find(
          (cp) => baseArabicLetter(cp.letterArabic) === key
        );
        updatedEvaluations.push({
          checkPointId:
            matchingCp?.id ??
            `backend_${plet.rule}_${plet.letter}_${Math.random().toString(36).substring(2, 7)}`,
          letterArabic: plet.letter,
          rule: (plet.rule as TajweedRuleType) || 'harakat',
          status: plet.status,
          score: Math.round(plet.score),
          feedbackRu: `${plet.issue_uz} ${plet.anatomical_tip_uz}`.trim(),
          detectedPhonemeOrLetter: plet.detected_letter ?? undefined,
          isSubstitutionMistake: Boolean(plet.detected_letter),
          measuredF2Hz: plet.f2_hz ? Math.round(plet.f2_hz) : undefined,
          segmentStartMs: 0,
          segmentEndMs: probeResponse.duration_ms || 1000,
          referenceWordAudioUrl:
            matchingCp?.referenceWordAudioUrl ??
            localResult.evaluations[0]?.referenceWordAudioUrl,
        });
      }
    }
  }

  // Честный средневзвешенный итоговый балл по всем буквам/словам без искусственного занижения до 25%/45%
  let finalOverallScore: number;
  if (wordCompletelyWrong) {
    finalOverallScore = Math.max(20, Math.round(probeResponse.score));
  } else {
    const avgPyLetterScore =
      pyLetters.length > 0
        ? pyLetters.reduce((sum, l) => sum + l.score, 0) / pyLetters.length
        : updatedEvaluations.length > 0
        ? updatedEvaluations.reduce((sum, e) => sum + e.score, 0) / updatedEvaluations.length
        : probeResponse.score;
    finalOverallScore = Math.round(0.65 * probeResponse.score + 0.35 * avgPyLetterScore);
  }

  // Если общий балл >= 85%, переводим мелкие замечания на отдельных буквах в мягкий совет (warning)
  const normalizedEvaluations: CheckPointEvaluation[] =
    finalOverallScore >= 85
      ? updatedEvaluations.map((ev) =>
          ev.status === 'mistake' && ev.score >= 55
            ? { ...ev, status: 'warning' as const, score: Math.max(ev.score, 78) }
            : ev
        )
      : updatedEvaluations;

  return {
    ...localResult,
    overallScore: finalOverallScore,
    activeSpeechDurationMs:
      probeResponse.metrics.active_duration_ms ||
      localResult.activeSpeechDurationMs,
    peakDb: Math.round(probeResponse.metrics.peak_db),
    evaluations: normalizedEvaluations,
    letterEvaluations: pyLetters,
    detectedIssue: probeResponse.detected_issue,
    transcribedArabic: recognizedTextFromWhisper,
    multiSheikhConsensus:
      probeResponse.multi_sheikh_consensus ?? finalOverallScore,
    strictnessLevel: probeResponse.strictness_level ?? strictnessLevel,
    studentUnitMs: probeResponse.student_unit_ms,
  };
}
