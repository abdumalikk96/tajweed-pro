'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Ayah,
  PhonemeCheckPoint,
  QuranWord,
  RecitationAnalysisResult,
  RecitationPace,
  SurahMetadata,
  TrainingMode,
  VoiceCalibrationProfile,
  StudentWeaknessStat,
  SurahMistakeStat,
  TajweedRuleType,
  SheikhId,
  TEN_SHEIKHS_CATALOG,
  buildSheikhAyahAudioUrl,
  ExamSubMode,
  ExamRollbackRule,
} from '@/types/quran';
import { ALL_SURAHS } from '@/data/shortSurahsMatrix';
import { ALL_114_SURAHS_CATALOG } from '@/data/mushafFullCatalog';
import {
  enrichSurahCheckPointsWithWordAudio,
  fetchMushafPage,
  fetchSurahByChapter,
} from '@/lib/mushafPageLoader';
import { useRawAudioRecorder } from '@/hooks/useRawAudioRecorder';
import { useQuranNeuralEngine } from '@/hooks/useQuranNeuralEngine';
import {
  useStudentProgress,
  enrichWeaknessStat,
  getBaseArabicLetter,
} from '@/hooks/useStudentProgress';
import InteractiveMistakeDrill from '@/components/InteractiveMistakeDrill';
import { analyzeWordOrAyahAudio } from '@/lib/acousticAnalyzer';
import {
  analyzeRecitationWithPythonFallback,
  analyzeLiveChunkWithPythonFallback,
} from '@/lib/pythonApiClient';
import { trimSilence, playErrorBuzzSound } from '@/lib/audioUtils';
import {
  fetchAndDecodeReferenceAudio,
  compareQiraatWithSheikh,
} from '@/lib/qiraatProsodyAnalyzer';
import AcousticFeedbackPanel from '@/components/AcousticFeedbackPanel';
import DualWaveformVisualizer from '@/components/DualWaveformVisualizer';
import VoiceCalibrationModal, {
  DEFAULT_CALIBRATION_PROFILE,
  VOICE_CALIBRATION_STORAGE_KEY,
} from '@/components/VoiceCalibrationModal';
import { cn } from '@/lib/utils';
import {
  Volume2,
  Mic,
  BookOpen,
  Square,
  Settings,
  RotateCcw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Layers,
  Sparkles,
  Menu,
  X,
  FileText,
  Image as ImageIcon,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';

const PACE_PLAYBACK_RATE_MAP: Record<RecitationPace, number> = {
  tahqiq: 0.75, // Sekin
  tadwir: 1.0,  // O'rta (Tartil)
  hadr: 1.25,   // Tez
  fast: 2.0,    // Tezkor (2.0x)
};

function toArabicDigits(num: number | string): string {
  const digits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return String(num).replace(/[0-9]/g, (d) => digits[parseInt(d, 10)]);
}

export interface ArabicLetterCluster {
  raw: string;
  baseLetter: string;
  charIndex: number;
}

function isArabicDiacritic(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0670 ||
    (code >= 0x0653 && code <= 0x0655) ||
    (code >= 0x06d6 && code <= 0x06ed) ||
    code === 0x0640
  );
}

function baseArabicLetter(text: string): string {
  const stripped = (text || '')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
  const match = stripped.match(/[\u0621-\u064A]/);
  return match ? match[0] : stripped;
}

export function splitIntoArabicLetterClusters(
  wordText: string
): ArabicLetterCluster[] {
  const clusters: ArabicLetterCluster[] = [];
  const chars = Array.from(wordText || '');
  let i = 0;
  let letterIndex = 0;

  while (i < chars.length) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (isArabicDiacritic(ch)) {
      if (clusters.length > 0) {
        clusters[clusters.length - 1].raw += ch;
      }
      i++;
      continue;
    }

    let clusterRaw = ch;
    let j = i + 1;
    while (j < chars.length && isArabicDiacritic(chars[j])) {
      clusterRaw += chars[j];
      j++;
    }

    clusters.push({
      raw: clusterRaw,
      baseLetter: baseArabicLetter(ch),
      charIndex: letterIndex,
    });
    letterIndex++;
    i = j;
  }

  return clusters;
}

const TAFKHIM_LETTERS = new Set(['ص', 'ض', 'ط', 'ظ', 'خ', 'غ', 'ق']);
const QALQALAH_LETTERS = new Set(['ق', 'ط', 'ب', 'ج', 'د']);
const MADD_LONG_VOWEL_LETTERS = new Set(['ا', 'و', 'ي', 'ى']);
const SHORT_VOWEL_OR_SUKUN_REGEX = /[\u064B-\u0652\u06E1]/;
const TANWEEN_REGEX = /[\u064B-\u064D]/;

/**
 * Расширенная 7-цветная каноническая кодировка Мусхафа Таджвида (7-Color Tajweed Coding):
 * 1. 🔴 Madd Lazim / Wajib (4–6 harakat) — text-red-500 (#EF4444)
 * 2. 🟠 Madd Tabiiy / Munfasil (2–4 harakat) — text-orange-400 (#FB923C)
 * 3. 🟢 G'unna va Ikhfo (Dimoq bilan 2 harakat) — text-emerald-400 (#10B981)
 * 4. 🟣 Idg'om va Iqlob (Kirishish / Almashtirish) — text-purple-400 (#C084FC)
 * 5. 🔵 Qalqala (Tebranish — ق ط ب ج د) — text-cyan-400 (#22D3EE)
 * 6. 🔷 Tafxim (Yo'g'on harflar — خص ضغط قظ и твердая ر) — text-indigo-400 (#818CF8)
 * 7. ⚪ O'qilmaydigan harflar (Hamzatul-vasl / Shamsiyya Lomi) — text-slate-500 (#64748B)
 */
function getTajweedColorClass(
  cluster: ArabicLetterCluster,
  wordCheckPoints?: PhonemeCheckPoint[],
  allWordClusters?: ArabicLetterCluster[]
): string {
  const raw = cluster.raw;
  const base = cluster.baseLetter;
  const idx = cluster.charIndex;
  const nextCluster =
    allWordClusters && idx + 1 < allWordClusters.length
      ? allWordClusters[idx + 1]
      : undefined;
  const prevCluster =
    allWordClusters && idx > 0 ? allWordClusters[idx - 1] : undefined;

  // 7. ⚪ O'qilmaydigan harflar (Hamzatul-vasl ٱ, кружок нечитаемой буквы \u06DF/\u06E0, либо Лам шамсийя перед буквой с шаддой)
  const isHamzatulWasl = raw.includes('ٱ') || raw.includes('\u0671');
  const hasSilentZeroMark = raw.includes('\u06DF') || raw.includes('\u06E0');
  const isShamsiyyaLam =
    base === 'ل' &&
    !SHORT_VOWEL_OR_SUKUN_REGEX.test(raw) &&
    Boolean(
      prevCluster &&
        (prevCluster.raw.includes('ٱ') ||
          prevCluster.raw.includes('\u0671') ||
          prevCluster.baseLetter === 'ا') &&
        nextCluster &&
        (nextCluster.raw.includes('\u0651') || nextCluster.raw.includes('ّ'))
    );

  if (isHamzatulWasl || hasSilentZeroMark || isShamsiyyaLam) {
    return 'text-slate-500';
  }

  // 1. 🔴 Madd Lazim / Wajib (4–6 harakat): волнистый знак мадда (ٓ / آ / \u0653 / \u06E4) или правило madd_4 / madd_6
  const hasMaddWave =
    raw.includes('\u0653') ||
    raw.includes('ٓ') ||
    raw.includes('آ') ||
    raw.includes('\u06E4');
  const matchesLongMaddCheckpoint = wordCheckPoints?.some(
    (cp) =>
      (cp.rule === 'madd_4' || cp.rule === 'madd_6') &&
      baseArabicLetter(cp.letterArabic) === base
  );

  if (hasMaddWave || matchesLongMaddCheckpoint) {
    return 'text-red-500 font-semibold';
  }

  // 2. 🟠 Madd Tabiiy / Munfasil (2–4 harakat): алиф ханджария (ٰ / \u0670), долгие гласные без собственных харакатов (ا و ي ى), либо madd_2
  const hasDaggerAlif = raw.includes('\u0670') || raw.includes('ٰ');
  const matchesShortMaddCheckpoint = wordCheckPoints?.some(
    (cp) => cp.rule === 'madd_2' && baseArabicLetter(cp.letterArabic) === base
  );
  const isNaturalMaddLetter =
    MADD_LONG_VOWEL_LETTERS.has(base) &&
    idx > 0 &&
    !SHORT_VOWEL_OR_SUKUN_REGEX.test(raw) &&
    !raw.includes('\u0651') &&
    !raw.includes('ّ');

  if (hasDaggerAlif || matchesShortMaddCheckpoint || isNaturalMaddLetter) {
    return 'text-orange-400 font-semibold';
  }

  // 4. 🟣 Idg'om va Iqlob (Kirishish / Almashtirish): знак иклаба (ۢ / \u06E2 / \u06ED), идгам без гунны (перед ل / ر), либо шадда на буквах кроме ن и م
  const hasIqlabMark =
    raw.includes('\u06E2') || raw.includes('\u06ED') || raw.includes('ۢ');
  const hasShaddah = raw.includes('\u0651') || raw.includes('ّ');
  const hasSukun =
    raw.includes('\u0652') || raw.includes('ْ') || raw.includes('\u06E1');
  const isNoonOrTanweenBeforeLamRa =
    (base === 'ن' || TANWEEN_REGEX.test(raw)) &&
    !SHORT_VOWEL_OR_SUKUN_REGEX.test(raw.replace(TANWEEN_REGEX, '')) &&
    Boolean(
      nextCluster &&
        (nextCluster.baseLetter === 'ل' || nextCluster.baseLetter === 'ر')
    );
  const matchesIdghamCheckpoint = wordCheckPoints?.some(
    (cp) =>
      (cp.rule === 'idgham' || cp.rule === 'tashdid') &&
      baseArabicLetter(cp.letterArabic) === base &&
      base !== 'ن' &&
      base !== 'م'
  );

  if (
    hasIqlabMark ||
    isNoonOrTanweenBeforeLamRa ||
    matchesIdghamCheckpoint ||
    (hasShaddah && base !== 'ن' && base !== 'م')
  ) {
    return 'text-purple-400 font-semibold';
  }

  // 3. 🟢 G'unna va Ikhfo (Dimoq bilan 2 harakat): نّ / مّ с шаддой, танвин, нун/мим сакина с ихфа/гунна
  const hasTanween = TANWEEN_REGEX.test(raw);
  const isGhunnahShaddah = hasShaddah && (base === 'ن' || base === 'م');
  const isUnvoweledNoonOrMeem =
    (base === 'ن' || base === 'م') && !SHORT_VOWEL_OR_SUKUN_REGEX.test(raw);
  const matchesGhunnahCheckpoint = wordCheckPoints?.some(
    (cp) =>
      (cp.rule === 'ghunnah' || cp.rule === 'ikhfa') &&
      baseArabicLetter(cp.letterArabic) === base
  );

  if (
    isGhunnahShaddah ||
    hasTanween ||
    isUnvoweledNoonOrMeem ||
    matchesGhunnahCheckpoint
  ) {
    return 'text-emerald-400 font-semibold';
  }

  // 5. 🔵 Qalqala (Tebranish — ق ط ب ج د): буквы калкалы с сукуном (ْ) либо правило qalqalah
  const matchesQalqalahCheckpoint = wordCheckPoints?.some(
    (cp) => cp.rule === 'qalqalah' && baseArabicLetter(cp.letterArabic) === base
  );

  if (QALQALAH_LETTERS.has(base) && (hasSukun || matchesQalqalahCheckpoint)) {
    return 'text-cyan-400 font-semibold';
  }

  // 6. 🔷 Tafxim (Yo'g'on harflar — خص ضغط قظ и твердая ر с фатхой/даммой)
  const matchesTafkhimCheckpoint = wordCheckPoints?.some(
    (cp) => cp.rule === 'tafkhim' && baseArabicLetter(cp.letterArabic) === base
  );

  if (TAFKHIM_LETTERS.has(base) || matchesTafkhimCheckpoint) {
    return 'text-indigo-400 font-medium';
  }

  if (
    base === 'ر' &&
    (raw.includes('\u064E') ||
      raw.includes('\u064F') ||
      raw.includes('َ') ||
      raw.includes('ُ'))
  ) {
    return 'text-indigo-400 font-medium';
  }

  return 'text-white';
}

function formatSimpleCheckPointTipUz(
  cp: PhonemeCheckPoint,
  idx: number
): string {
  if (cp.expectedHarakaat) {
    return `${idx + 1}. «${cp.letterArabic}» harfi — ${
      cp.expectedHarakaat
    } harakat miqdorida cho'zib o'qing (Madd).`;
  }
  if (cp.requireLowF2 || cp.rule === 'tafkhim') {
    return `${idx + 1}. «${
      cp.letterArabic
    }» harfi — yo'g'on va chuqur ovozda o'qing (Tafxim).`;
  }
  if (cp.rule === 'qalqalah') {
    return `${idx + 1}. «${
      cp.letterArabic
    }» harfi — tovushni tebratib (Qalqala bilan) talaffuz qiling.`;
  }
  if (cp.rule === 'ghunnah') {
    return `${idx + 1}. «${
      cp.letterArabic
    }» harfi — dimog'da 2 harakat ushlab o'qing (G'unna).`;
  }
  if (cp.rule === 'idgham') {
    return `${idx + 1}. «${
      cp.letterArabic
    }» harfi — keyingi harfga ravon kirishtirib o'qing (Idg'om).`;
  }
  if (cp.rule === 'ikhfa') {
    return `${idx + 1}. «${
      cp.letterArabic
    }» harfi — tovushni yumshoq yashirib o'qing (Ixfo).`;
  }
  return `${idx + 1}. «${
    cp.letterArabic
  }» harfi — maxrajini aniq va ravshan talaffuz qiling.`;
}

const ENRICHED_INITIAL_SURAHS = ALL_SURAHS.map(
  enrichSurahCheckPointsWithWordAudio
);

export default function MushafTrainer() {
  // Выдвижная левая колонка строго для выбора Корана (открыта по умолчанию)
  const [isNavOpen, setIsNavOpen] = useState<boolean>(true);
  const [navTab, setNavTab] = useState<'quran' | 'drill' | 'settings'>('quran');
  const [activeHeaderPanel, setActiveHeaderPanel] = useState<
    'colors' | 'drill' | 'settings' | null
  >(null);
  const [quickAyahInput, setQuickAyahInput] = useState<string>('');

  // Разделение масштаба отображения (So'z / Oyat / Sahifa) и режима экзамена (🎓 Dars topshirish)
  const [isExamMode, setIsExamMode] = useState<boolean>(false);
  const [readingScope, setReadingScope] = useState<'word' | 'ayah' | 'page'>('word');
  const viewScope = readingScope;
  const setViewScope = setReadingScope;
  const [drillModeActive, setDrillModeActive] = useState<boolean>(false);

  // Производный trainingMode для полной совместимости со всеми проверками в коде
  const trainingMode: TrainingMode = isExamMode
    ? 'exam'
    : drillModeActive
    ? 'drill'
    : readingScope;

  const setTrainingMode = useCallback((mode: TrainingMode) => {
    if (mode === 'exam') {
      setIsExamMode(true);
      setDrillModeActive(false);
    } else if (mode === 'drill') {
      setDrillModeActive(true);
      setIsExamMode(false);
    } else {
      setReadingScope(mode);
      setDrillModeActive(false);
      // Смена масштаба чтения (So'z/Oyat/Sahifa) не сбрасывает режим экзамена (Dars topshirish)!
    }
  }, []);

  const toggleExamMode = useCallback((enable?: boolean) => {
    setIsExamMode((prev) => {
      const next = typeof enable === 'boolean' ? enable : !prev;
      setIsExamTextRevealed(false);
      setExamMistakeBanner(null);
      setExamSuccessBanner(null);
      setExamFailedWordId(null);
      if (next) {
        setAnalysisResult(null);
        setDrillModeActive(false);
      }
      return next;
    });
  }, []);

  const activateStudyMode = useCallback(() => {
    if (examRollbackTimerRef.current) {
      clearTimeout(examRollbackTimerRef.current);
      examRollbackTimerRef.current = null;
    }
    setIsExamMode(false);
    setDrillModeActive(false);
    setTrainingMode(readingScope);
    setIsExamTextRevealed(false);
    setExamMistakeBanner(null);
    setExamSuccessBanner(null);
    setExamFailedWordId(null);
  }, [readingScope, setTrainingMode]);

  const activateExamMode = useCallback(() => {
    if (examRollbackTimerRef.current) {
      clearTimeout(examRollbackTimerRef.current);
      examRollbackTimerRef.current = null;
    }
    setIsExamMode(true);
    setDrillModeActive(false);
    setTrainingMode('exam');
    setIsExamTextRevealed(false);
    setExamMistakeBanner(null);
    setExamSuccessBanner(null);
    setExamFailedWordId(null);
    setAnalysisResult(null);
  }, [setTrainingMode]);

  // Защита от Race Condition в живых чанках
  const recordingSessionIdRef = useRef<number>(0);
  const liveChunkAbortControllerRef = useRef<AbortController | null>(null);
  const isRecordingRef = useRef<boolean>(false);

  const [pace, setPace] = useState<RecitationPace>('tadwir');
  const [customSurahs, setCustomSurahs] = useState<SurahMetadata[]>([]);
  const [selectedSurahId, setSelectedSurahId] = useState<number>(1);
  const [selectedAyahNumber, setSelectedAyahNumber] = useState<number>(1);
  const [selectedAyahKey, setSelectedAyahKey] = useState<string>('1:1');
  const [selectedWord, setSelectedWord] = useState<QuranWord>(
    ENRICHED_INITIAL_SURAHS[0].ayahs[0].words[0]
  );
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);

  // Состояния аналитики и ожидания ответа ИИ
  const [analysisResult, setAnalysisResult] =
    useState<RecitationAnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);

  // Готовая запись ученика для наложения на волну эталона (DualWaveformVisualizer)
  const [userRecordingBuffer, setUserRecordingBuffer] =
    useState<Float32Array | null>(null);
  const [userRecordingUrl, setUserRecordingUrl] = useState<string | null>(null);

  const [mushafPageInput, setMushafPageInput] = useState<string>('1');
  const [activeMushafPage, setActiveMushafPage] = useState<number>(1);
  const [isLoadingPage, setIsLoadingPage] = useState<boolean>(false);
  const [pageViewMode, setPageViewMode] = useState<'text' | 'image'>('text');
  const [activeHighlightedMistakeId, setActiveHighlightedMistakeId] =
    useState<string | null>(null);
  const [activeHighlightedWordId, setActiveHighlightedWordId] = useState<
    string | null
  >(null);

  const [calibrationProfile, setCalibrationProfile] =
    useState<VoiceCalibrationProfile>(DEFAULT_CALIBRATION_PROFILE);
  const [isCalibrationModalOpen, setIsCalibrationModalOpen] =
    useState<boolean>(false);

  // Настройка процента сложности / строгости проверки (50% - 100%), выбора голоса из 10 шейхов и масштаба шрифта (0.85 - 1.65)
  const [strictnessLevel, setStrictnessLevel] = useState<number>(75);
  const [selectedSheikhId, setSelectedSheikhId] = useState<SheikhId>('husary');
  const [fontScale, setFontScale] = useState<number>(1.15);

  // Режим сдачи урока (Dars topshirish / Imtihon): формат и правило возврата при ошибке
  const [examSubMode, setExamSubMode] = useState<ExamSubMode>('memorized');
  const [examRollbackRule, setExamRollbackRule] =
    useState<ExamRollbackRule>('prev_ayah');
  const [isExamTextRevealed, setIsExamTextRevealed] = useState<boolean>(false);
  const [examMistakeBanner, setExamMistakeBanner] = useState<string | null>(
    null
  );
  const [examSuccessBanner, setExamSuccessBanner] = useState<string | null>(
    null
  );
  const [examFailedWordId, setExamFailedWordId] = useState<string | null>(null);
  const examRollbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const isLiveChunkInFlightRef = useRef<boolean>(false);
  const liveVerifiedWordsCountRef = useRef<number>(0);
  const stopRecordingRef = useRef<
    (() => Promise<(Float32Array & { recordedAudioUrl?: string }) | null>) | null
  >(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(VOICE_CALIBRATION_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as VoiceCalibrationProfile;
        if (typeof parsed.dynamicTafkhimThresholdHz === 'number') {
          setCalibrationProfile(parsed);
        }
      }
      const savedStrictness = window.localStorage.getItem('quran_trainer_strictness_level_v1');
      if (savedStrictness) {
        const num = Number(savedStrictness);
        if (!Number.isNaN(num) && num >= 50 && num <= 100) {
          setStrictnessLevel(num);
        }
      }
      const savedSheikh = window.localStorage.getItem('quran_trainer_selected_sheikh_v1');
      if (savedSheikh && TEN_SHEIKHS_CATALOG.some((s) => s.id === savedSheikh)) {
        setSelectedSheikhId(savedSheikh as SheikhId);
      }
      const savedFontScale = window.localStorage.getItem('quran_trainer_font_scale_v1');
      if (savedFontScale) {
        const num = Number(savedFontScale);
        if (!Number.isNaN(num) && num >= 0.85 && num <= 1.65) {
          setFontScale(Number(num.toFixed(2)));
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const handleFontScaleChange = useCallback((nextScale: number) => {
    const clamped = Number(
      Math.max(0.85, Math.min(1.65, nextScale)).toFixed(2)
    );
    setFontScale(clamped);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          'quran_trainer_font_scale_v1',
          String(clamped)
        );
      } catch {
        // ignore
      }
    }
  }, []);

  const handleStrictnessChange = useCallback((nextLevel: number) => {
    const clamped = Math.max(50, Math.min(100, Math.round(nextLevel / 5) * 5));
    setStrictnessLevel(clamped);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('quran_trainer_strictness_level_v1', String(clamped));
      } catch {
        // ignore
      }
    }
  }, []);

  const handleSheikhChange = useCallback((nextSheikh: SheikhId) => {
    setSelectedSheikhId(nextSheikh);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('quran_trainer_selected_sheikh_v1', nextSheikh);
      } catch {
        // ignore
      }
    }
  }, []);

  const handleSaveCalibrationProfile = useCallback(
    (profile: VoiceCalibrationProfile) => {
      setCalibrationProfile(profile);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(
            VOICE_CALIBRATION_STORAGE_KEY,
            JSON.stringify(profile)
          );
        } catch {
          // ignore
        }
      }
    },
    []
  );

  const {
    weakPoints,
    topRuleMistakes,
    topSurahMistakes,
    surahStats,
    wordLastStatuses,
    recordAttemptEvaluations,
    getRecommendedDrillWords,
    resetStudentProgress,
    resolveWeakPoint,
  } = useStudentProgress();

  const [selectedDrillWeakPoint, setSelectedDrillWeakPoint] =
    useState<StudentWeaknessStat | null>(null);
  const [showAllWeakPoints, setShowAllWeakPoints] = useState<boolean>(false);

  const {
    engineStatus,
    startLiveMonitor,
    stopLiveMonitor,
    getLiveTranscript,
    transcribeAudioBuffer,
  } = useQuranNeuralEngine();

  const allAvailableSurahs = [...ENRICHED_INITIAL_SURAHS, ...customSurahs];
  const currentSurah: SurahMetadata =
    allAvailableSurahs.find((s) => s.id === selectedSurahId) ??
    ENRICHED_INITIAL_SURAHS[0];

  const effectiveSurahId =
    currentSurah.surahId ??
    (currentSurah.ayahs[0]?.verseKey
      ? Number(currentSurah.ayahs[0].verseKey.split(':')[0])
      : currentSurah.id <= 114
      ? currentSurah.id
      : 1);

  const currentCatalogEntry = ALL_114_SURAHS_CATALOG.find(
    (c) => c.id === effectiveSurahId
  );
  const currentSurahNameUz =
    currentCatalogEntry
      ? `${currentCatalogEntry.id}. ${currentCatalogEntry.nameUz}`
      : `Sahifa ${activeMushafPage}`;

  const currentAyah: Ayah =
    currentSurah.ayahs.find(
      (a) =>
        (a.verseKey && selectedAyahKey
          ? a.verseKey === selectedAyahKey
          : a.number === selectedAyahNumber)
    ) ?? currentSurah.ayahs[0];

  // При смене аята или сахифы гарантируем, что выбранное слово принадлежит новому аяту
  useEffect(() => {
    if (currentAyah && currentAyah.words && currentAyah.words.length > 0) {
      const exists = currentAyah.words.some((w) => w.id === selectedWord.id);
      if (!exists) {
        setSelectedWord(currentAyah.words[0]);
      }
    }
  }, [currentAyah, selectedWord.id]);

  const referencePlaybackRate = PACE_PLAYBACK_RATE_MAP[pace] ?? 1.0;

  useEffect(() => {
    return () => {
      if (examRollbackTimerRef.current) {
        clearTimeout(examRollbackTimerRef.current);
      }
    };
  }, []);

  /**
   * Потоковый анализ во время активной записи микрофона (Real-Time Live Audio Streaming):
   * Каждые 1.2 секунды или на межсловной паузе оценивает уже произнесенные слова и буквы
   * и обновляет подсветку текста и правую панель `AcousticFeedbackPanel` на лету.
   */
  const handleLiveChunk = useCallback(
    async (
      chunkBuffer: Float32Array,
      elapsedMs?: number,
      chunkReason?: 'interval' | 'word_pause'
    ) => {
      if (
        isLiveChunkInFlightRef.current ||
        !chunkBuffer ||
        chunkBuffer.length < 1600
      ) {
        return;
      }
      isLiveChunkInFlightRef.current = true;
      try {
        setUserRecordingBuffer(chunkBuffer);

        const isSingleWordMode =
          viewScope === 'word' || trainingMode === 'drill';
        const isPageMode = viewScope === 'page';

        const activeCheckPoints = isPageMode
          ? currentSurah.ayahs.flatMap((a) =>
              a.words.flatMap((w) => w.checkPoints)
            )
          : isSingleWordMode
          ? selectedWord.checkPoints
          : currentAyah.words.flatMap((w) => w.checkPoints);

        const targetUthmani = isPageMode
          ? currentSurah.ayahs.map((a) => a.textUthmani).join(' ')
          : isSingleWordMode
          ? selectedWord.textUthmani
          : currentAyah.textUthmani;

        const expectedPhonemes = isPageMode
          ? currentSurah.ayahs
              .flatMap((a) => a.words.map((w) => w.expectedPhonemes))
              .join(' | ')
          : isSingleWordMode
          ? selectedWord.expectedPhonemes
          : currentAyah.words.map((w) => w.expectedPhonemes).join(' | ');

        const activeWordIds = isPageMode
          ? currentSurah.ayahs.flatMap((a) => a.words.map((w) => w.id))
          : isSingleWordMode
          ? [selectedWord.id]
          : currentAyah.words.map((w) => w.id);

        const baseLiveDsp = analyzeWordOrAyahAudio(
          chunkBuffer,
          16000,
          activeCheckPoints,
          pace,
          {
            neuralOutput: null,
            targetUthmani,
            expectedPhonemes,
            calibrationProfile,
            strictnessLevel,
          }
        );

        const liveTranscript = getLiveTranscript();
        const thisSessionId = recordingSessionIdRef.current;

        const liveResult = await analyzeLiveChunkWithPythonFallback(
          chunkBuffer,
          16000,
          activeCheckPoints,
          baseLiveDsp,
          {
            expectedText: targetUthmani,
            strictnessLevel,
            sheikhId: selectedSheikhId,
            activeWordIds,
            liveTranscript,
            verifiedWordsCount: liveVerifiedWordsCountRef.current,
            chunkReason: chunkReason ?? 'interval',
            signal: liveChunkAbortControllerRef.current?.signal,
          }
        );

        // Защита от Race Condition: если сессия записи уже завершена, отбрасываем ответ
        if (
          thisSessionId !== recordingSessionIdRef.current ||
          !isRecordingRef.current
        ) {
          return;
        }

        if (typeof liveResult.verifiedWordsCount === 'number') {
          liveVerifiedWordsCountRef.current = Math.max(
            liveVerifiedWordsCountRef.current,
            liveResult.verifiedWordsCount
          );
        }

        const passThreshold = Math.round(
          60 + ((strictnessLevel - 50) / 50) * 25
        );
        const hasLiveMistake =
          (liveResult.failedWordIndex !== null &&
            liveResult.failedWordIndex !== undefined &&
            liveResult.failedWordIndex >= 0) ||
          liveResult.overallScore < (trainingMode === 'exam' ? 60 : 45) ||
          (liveResult.letterEvaluations || []).some(
            (le) => le.status === 'mistake' && le.score < passThreshold
          );

        setAnalysisResult((prev) => {
          // Не перезаписываем финальный результат, если запись уже завершилась
          if (prev && prev.isLivePreview === false) return prev;
          return liveResult;
        });

        // В режиме «Dars topshirish (Imtihon)» при ошибке на слове:
        // МГНОВЕННО прерываем запись, звуковой зуммер ошибки и откат!
        if (
          isExamMode &&
          trainingMode === 'exam' &&
          hasLiveMistake &&
          (chunkBuffer.length >= 3200 || liveResult.activeSpeechDurationMs >= 200)
        ) {
          playErrorBuzzSound();
          setIsExamTextRevealed(true);

          const failedIdx =
            liveResult.failedWordIndex !== null &&
            liveResult.failedWordIndex !== undefined &&
            liveResult.failedWordIndex >= 0
              ? liveResult.failedWordIndex
              : Math.max(0, (liveResult.spokenWordsCount ?? 1) - 1);

          const failedWord =
            currentAyah.words[failedIdx] ??
            currentAyah.words.find(
              (w) => w.textUthmani === liveResult.failedWordArabic
            ) ??
            currentAyah.words[0];

          const failedWordId = failedWord?.id ?? currentAyah.words[0]?.id;
          const failedWordText =
            liveResult.failedWordArabic ??
            failedWord?.textUthmani ??
            "so'z";

          setExamFailedWordId(failedWordId);
          setActiveHighlightedWordId(failedWordId);
          setExamSuccessBanner(null);
          setExamMistakeBanner(
            `⚠️ Xato aniqlandi! "${failedWordText}" so'zida xato qilindi — darhol to'xtatildi.`
          );

          // 1) НЕМЕДЛЕННО принудительно останавливаем запись микрофона
          const liveArabic = stopLiveMonitor();
          await stopRecordingRef.current?.();

          // 2) Применяем правило отката (Shu oyat boshidan или Oldingi oyatdan)
          const currentAyahIdx = currentSurah.ayahs.findIndex((a) =>
            a.verseKey && selectedAyahKey
              ? a.verseKey === selectedAyahKey
              : a.number === selectedAyahNumber
          );

          if (examRollbackTimerRef.current) {
            clearTimeout(examRollbackTimerRef.current);
          }

          if (examRollbackRule === 'prev_ayah' && currentAyahIdx > 0) {
            const prevAyah = currentSurah.ayahs[currentAyahIdx - 1];
            examRollbackTimerRef.current = setTimeout(() => {
              setSelectedAyahNumber(prevAyah.number);
              if (prevAyah.verseKey) {
                setSelectedAyahKey(prevAyah.verseKey);
              }
              if (prevAyah.words && prevAyah.words.length > 0) {
                setSelectedWord(prevAyah.words[0]);
              }
              setIsExamTextRevealed(false);
              setExamFailedWordId(null);
              setExamMistakeBanner(null);
              liveVerifiedWordsCountRef.current = 0;
            }, 3500);
          } else {
            // Shu oyat boshidan
            examRollbackTimerRef.current = setTimeout(() => {
              setIsExamTextRevealed(false);
              setExamFailedWordId(null);
              setExamMistakeBanner(null);
              liveVerifiedWordsCountRef.current = 0;
            }, 3500);
          }
        }
      } finally {
        isLiveChunkInFlightRef.current = false;
      }
    },
    [
      trainingMode,
      currentSurah,
      selectedWord,
      currentAyah,
      pace,
      calibrationProfile,
      strictnessLevel,
      selectedSheikhId,
      getLiveTranscript,
      stopLiveMonitor,
      playErrorBuzzSound,
      examRollbackRule,
      selectedAyahKey,
      selectedAyahNumber,
    ]
  );

  /**
   * Отправка записанного буфера на бэкенд и ИИ-анализатор:
   * - Если во время записи уже рассчитан Live-результат (`isLivePreview`), оставляет его на экране без пустого экрана ожидания
   * - Досчитывает финальный вердикт за доли секунды
   * - В режиме экзамена (`trainingMode === 'exam'`) мгновенно открывает скрытый текст и при ошибке выполняет откат
   */
  const processRecordedBuffer = useCallback(
    async (
      recordedBuffer: Float32Array,
      directWavUrl?: string,
      liveCapturedArabic?: string
    ) => {
      if (!recordedBuffer || recordedBuffer.length === 0) return;

      if (examRollbackTimerRef.current) {
        clearTimeout(examRollbackTimerRef.current);
        examRollbackTimerRef.current = null;
      }

      // Сохраняем готовую запись для статичного наложения на волну шейха
      setUserRecordingBuffer(recordedBuffer);
      setUserRecordingUrl(directWavUrl ?? null);

      // Если в режиме сдачи наизусть запись закончилась — сразу открываем текст с уже готовой live-подсветкой!
      if (trainingMode === 'exam') {
        setIsExamTextRevealed(true);
      }

      // Не сбрасываем analysisResult в null, если уже есть live-превью (чтобы ученик не ждал перед пустым экраном)
      setAnalysisResult((prev) => (prev?.isLivePreview ? prev : null));
      setIsAnalyzing(true);

      try {
        const isSingleWordMode =
          viewScope === 'word' || trainingMode === 'drill';
        const isPageMode = viewScope === 'page';

        const activeCheckPoints = isPageMode
          ? currentSurah.ayahs.flatMap((a) => a.words.flatMap((w) => w.checkPoints))
          : isSingleWordMode
          ? selectedWord.checkPoints
          : currentAyah.words.flatMap((w) => w.checkPoints);

        const targetUthmani = isPageMode
          ? currentSurah.ayahs.map((a) => a.textUthmani).join(' ')
          : isSingleWordMode
          ? selectedWord.textUthmani
          : currentAyah.textUthmani;

        const expectedPhonemes = isPageMode
          ? currentSurah.ayahs.flatMap((a) => a.words.map((w) => w.expectedPhonemes)).join(' | ')
          : isSingleWordMode
          ? selectedWord.expectedPhonemes
          : currentAyah.words.map((w) => w.expectedPhonemes).join(' | ');

        const referenceUrl = isSingleWordMode
          ? selectedWord.audioUrl
          : buildSheikhAyahAudioUrl(
              selectedSheikhId,
              currentSurah.id,
              currentAyah.number,
              currentAyah.verseKey
            );

        const evaluatedWordIds = isPageMode
          ? currentSurah.ayahs.flatMap((a) => a.words.map((w) => w.id))
          : isSingleWordMode
          ? [selectedWord.id]
          : currentAyah.words.map((w) => w.id);

        const initialNeuralOutput =
          liveCapturedArabic && liveCapturedArabic.trim().length > 0
            ? { text: liveCapturedArabic.trim(), modelId: 'live-ar' }
            : null;

        // Базовый расчет DSP для передачи в гибридный Python-оркестратор
        const baseDspResult = analyzeWordOrAyahAudio(
          recordedBuffer,
          16000,
          activeCheckPoints,
          pace,
          {
            neuralOutput: initialNeuralOutput,
            targetUthmani,
            expectedPhonemes,
            calibrationProfile,
            recordedAudioUrl: directWavUrl,
            strictnessLevel,
          }
        );

        // 3. Выполняем fetch-запрос к Python API (localhost:8000) + декодирование эталона + ASR
        let referenceBuffer: Float32Array | null = null;
        let refDurationMs = 0;

        if (isPageMode) {
          const ayahBuffers = await Promise.all(
            currentSurah.ayahs.map((a) =>
              fetchAndDecodeReferenceAudio(
                buildSheikhAyahAudioUrl(
                  selectedSheikhId,
                  currentSurah.id,
                  a.number,
                  a.verseKey
                )
              )
            )
          );
          for (const buf of ayahBuffers) {
            if (buf) {
              const { startOffsetMs, endOffsetMs } = trimSilence(buf, 16000);
              const trimmed = endOffsetMs - startOffsetMs;
              refDurationMs +=
                trimmed > 0 ? trimmed : Math.round((buf.length / 16000) * 1000);
            }
          }
          referenceBuffer = ayahBuffers.find((b): b is Float32Array => b !== null) ?? null;
        } else {
          referenceBuffer = await fetchAndDecodeReferenceAudio(referenceUrl);
          if (referenceBuffer) {
            const { startOffsetMs, endOffsetMs } = trimSilence(referenceBuffer, 16000);
            const trimmed = endOffsetMs - startOffsetMs;
            refDurationMs =
              trimmed > 0 ? trimmed : Math.round((referenceBuffer.length / 16000) * 1000);
          }
        }

        const [neuralOutput, pythonEnrichedResult] = await Promise.all([
          transcribeAudioBuffer(recordedBuffer, liveCapturedArabic),
          analyzeRecitationWithPythonFallback(
            recordedBuffer,
            16000,
            activeCheckPoints,
            baseDspResult,
            {
              expectedText: targetUthmani,
              referenceDurationMs: refDurationMs,
              strictnessLevel,
              sheikhId: selectedSheikhId,
            }
          ),
        ]);

        const qiraatProsody = referenceBuffer
          ? compareQiraatWithSheikh(recordedBuffer, referenceBuffer, 16000)
          : undefined;

        const localEnrichedResult = analyzeWordOrAyahAudio(
          recordedBuffer,
          16000,
          activeCheckPoints,
          pace,
          {
            neuralOutput: neuralOutput ?? initialNeuralOutput,
            targetUthmani,
            expectedPhonemes,
            calibrationProfile,
            recordedAudioUrl: directWavUrl,
            strictnessLevel,
          }
        );

        const finalBaseResult =
          pythonEnrichedResult !== baseDspResult
            ? pythonEnrichedResult
            : localEnrichedResult;

        // Если бэкенд ответил — показываем ТОЛЬКО текст Whisper (даже пустой)
        const pythonResponded = pythonEnrichedResult !== baseDspResult;
        const trueTranscribedText = pythonResponded
          ? pythonEnrichedResult.transcribedArabic
          : localEnrichedResult.transcribedArabic;

        const isEmptyRecognizedSpeech =
          !trueTranscribedText || trueTranscribedText.trim().length === 0;

        const finalResult: RecitationAnalysisResult = isEmptyRecognizedSpeech
          ? {
              ...finalBaseResult,
              overallScore: 0,
              evaluations: [],
              letterEvaluations: [],
              detectedIssue: "Ovoz eshitilmadi — qaytadan o'qing",
              transcribedArabic: '',
              multiSheikhConsensus: 0,
              qiraatProsody,
              isLivePreview: false,
              spokenWordsCount: 0,
              totalWordsCount: evaluatedWordIds.length,
            }
          : {
              ...finalBaseResult,
              transcribedArabic: trueTranscribedText,
              letterEvaluations: pythonEnrichedResult.letterEvaluations,
              qiraatProsody,
              isLivePreview: false,
              spokenWordsCount: evaluatedWordIds.length,
              totalWordsCount: evaluatedWordIds.length,
            };

        // 4. Обновляем результаты и сохраняем статистику студента
        setAnalysisResult(finalResult);

        // 5. Логика режима «Dars topshirish (Imtihon)»: пословное открытие, зуммер и точечный маркер ошибки
        if (trainingMode === 'exam') {
          setIsExamTextRevealed(true);
          const passThreshold = Math.round(
            55 + ((strictnessLevel - 50) / 50) * 30
          );
          const hasExamMistake =
            finalResult.overallScore === 0 ||
            (finalResult.overallScore < 90 &&
              (finalResult.overallScore < passThreshold ||
                finalResult.evaluations.some(
                  (ev) => ev.status === 'mistake' || ev.score < passThreshold
                ) ||
                (finalResult.letterEvaluations || []).some(
                  (le) => le.status === 'mistake' || le.score < passThreshold
                )));

          if (hasExamMistake) {
            playErrorBuzzSound();
            setExamSuccessBanner(null);

            // Определяем конкретное слово, на котором произошла ошибка
            let detectedFailedWordId: string | null = null;
            if (isSingleWordMode) {
              detectedFailedWordId = selectedWord.id;
            } else {
              for (const w of currentAyah.words) {
                const wordFailed = finalResult.evaluations.some(
                  (ev) =>
                    (ev.status === 'mistake' || ev.score < passThreshold) &&
                    (ev.checkPointId.includes(w.id) ||
                      w.checkPoints.some((cp) => cp.id === ev.checkPointId))
                );
                if (wordFailed) {
                  detectedFailedWordId = w.id;
                  break;
                }
              }
              if (!detectedFailedWordId && currentAyah.words.length > 0) {
                const firstErrLetter = (
                  finalResult.letterEvaluations || []
                ).find(
                  (le) => le.status === 'mistake' || le.score < passThreshold
                );
                if (firstErrLetter) {
                  const errBase = baseArabicLetter(firstErrLetter.letter);
                  const matchedWord = currentAyah.words.find((w) =>
                    w.textUthmani.includes(errBase)
                  );
                  detectedFailedWordId =
                    matchedWord?.id ?? currentAyah.words[0].id;
                } else {
                  detectedFailedWordId = currentAyah.words[0].id;
                }
              }
            }
            setExamFailedWordId(detectedFailedWordId);
            if (detectedFailedWordId) {
              setActiveHighlightedWordId(detectedFailedWordId);
            }

            setExamMistakeBanner(
              finalResult.overallScore === 0
                ? "⚠️ Ovoz eshitilmadi — qaytadan o'qing!"
                : "⚠️ Xato aniqlandi! Qizil bilan belgilangan so'zda xato bor — qaytadan o'qing."
            );

            const currentAyahIdx = currentSurah.ayahs.findIndex((a) =>
              a.verseKey && selectedAyahKey
                ? a.verseKey === selectedAyahKey
                : a.number === selectedAyahNumber
            );

            if (examRollbackRule === 'prev_ayah' && currentAyahIdx > 0) {
              const prevAyah = currentSurah.ayahs[currentAyahIdx - 1];
              examRollbackTimerRef.current = setTimeout(() => {
                setSelectedAyahNumber(prevAyah.number);
                if (prevAyah.verseKey) {
                  setSelectedAyahKey(prevAyah.verseKey);
                }
                if (prevAyah.words && prevAyah.words.length > 0) {
                  setSelectedWord(prevAyah.words[0]);
                }
                setIsExamTextRevealed(false);
                setExamFailedWordId(null);
              }, 4500);
            }
          } else {
            setExamFailedWordId(null);
            setExamMistakeBanner(null);
            setExamSuccessBanner(
              "✅ Mashaalloh! Oyat xatosiz topshirildi."
            );
          }
        }

        let realSurahId = currentSurah.id;
        let realAyahNum = currentAyah.number;
        if (currentAyah.verseKey) {
          const parts = currentAyah.verseKey.split(':');
          if (parts.length === 2) {
            const parsedS = parseInt(parts[0], 10);
            const parsedA = parseInt(parts[1], 10);
            if (!isNaN(parsedS) && parsedS > 0) realSurahId = parsedS;
            if (!isNaN(parsedA) && parsedA > 0) realAyahNum = parsedA;
          }
        }
        const cat = ALL_114_SURAHS_CATALOG.find((c) => c.id === realSurahId);
        const surahDisplayName = cat ? cat.nameUz : currentSurah.nameArabic;

        recordAttemptEvaluations(finalResult.evaluations, evaluatedWordIds, {
          surahId: realSurahId,
          surahName: surahDisplayName,
          ayahNumber: realAyahNum,
        });
      } finally {
        setIsAnalyzing(false);
      }
    },
    [
      trainingMode,
      selectedWord,
      currentAyah,
      currentSurah,
      pace,
      calibrationProfile,
      recordAttemptEvaluations,
      transcribeAudioBuffer,
      strictnessLevel,
      selectedSheikhId,
      examRollbackRule,
      selectedAyahKey,
      selectedAyahNumber,
    ]
  );

  const {
    isRecording,
    recordingDurationMs,
    liveDb,
    liveLevelPercent,
    liveWaveform,
    recordedAudioUrl,
    audioDevices,
    selectedDeviceId,
    setSelectedDeviceId,
    refreshAudioDevices,
    autoStopOnSilence,
    setAutoStopOnSilence,
    startRecording,
    stopRecording,
    error: micError,
  } = useRawAudioRecorder({
    autoStopOnSilence: true,
    ambientNoiseRms: calibrationProfile.ambientNoiseRms,
    onLiveChunk: handleLiveChunk,
    onAutoStop: (buffer, wavUrl) => {
      recordingSessionIdRef.current += 1;
      liveChunkAbortControllerRef.current?.abort();
      liveChunkAbortControllerRef.current = null;
      isRecordingRef.current = false;
      const liveArabic = stopLiveMonitor();
      processRecordedBuffer(buffer, wavUrl, liveArabic);
    },
  });

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCacheRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const [isAudioBufferingId, setIsAudioBufferingId] = useState<string | null>(
    null
  );
  const [playingPageAyahIndex, setPlayingPageAyahIndex] = useState<number | null>(null);
  const [playingQueueInfo, setPlayingQueueInfo] = useState<{
    currentIndex: number;
    queueLength: number;
    currentPlayingAyah: number;
  } | null>(null);

  // Состояния выбора диапазона «От (pageStartAyah)» и «До (pageEndAyah)» в блоке OYATLAR
  const [pageStartAyah, setPageStartAyah] = useState<number>(1);
  const [pageEndAyah, setPageEndAyah] = useState<number>(7);
  const isSelectingEndRef = useRef<boolean>(false);

  const getAyahDisplayNumber = useCallback((ayah: Ayah): number => {
    if (ayah.verseKey) {
      const parts = ayah.verseKey.split(':');
      const parsed = parseInt(parts[parts.length - 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return ayah.number;
  }, []);

  const firstPageAyahNumber = useMemo(() => {
    if (!currentSurah.ayahs || currentSurah.ayahs.length === 0) return 1;
    return getAyahDisplayNumber(currentSurah.ayahs[0]);
  }, [currentSurah.ayahs, getAyahDisplayNumber]);

  const lastPageAyahNumber = useMemo(() => {
    if (!currentSurah.ayahs || currentSurah.ayahs.length === 0) return 1;
    return getAyahDisplayNumber(
      currentSurah.ayahs[currentSurah.ayahs.length - 1]
    );
  }, [currentSurah.ayahs, getAyahDisplayNumber]);

  // Синхронизация границ диапазона по умолчанию при смене списка аятов страницы/суры
  useEffect(() => {
    if (!currentSurah.ayahs || currentSurah.ayahs.length === 0) return;
    const firstNum = getAyahDisplayNumber(currentSurah.ayahs[0]);
    const lastNum = getAyahDisplayNumber(
      currentSurah.ayahs[currentSurah.ayahs.length - 1]
    );
    setPageStartAyah(firstNum);
    setPageEndAyah(lastNum);
    isSelectingEndRef.current = false;
  }, [currentSurah.id, activeMushafPage, currentSurah.ayahs, getAyahDisplayNumber]);

  const getOrPreloadAudio = useCallback((url: string): HTMLAudioElement => {
    let cached = audioCacheRef.current.get(url);
    if (!cached && typeof window !== 'undefined') {
      cached = new Audio(url);
      cached.preload = 'auto';
      audioCacheRef.current.set(url, cached);
    }
    return cached!;
  }, []);

  // Preload Pool: предзагрузка аудио для текущего аята, следующего аята и всех слов текущего аята
  useEffect(() => {
    if (typeof window === 'undefined' || !currentAyah) return;

    const urlsToPreload: string[] = [];
    const curAyahUrl = buildSheikhAyahAudioUrl(
      selectedSheikhId,
      currentSurah.id,
      currentAyah.number,
      currentAyah.verseKey
    );
    if (curAyahUrl) urlsToPreload.push(curAyahUrl);

    const curIdx = currentSurah.ayahs.findIndex((a) =>
      a.verseKey && currentAyah.verseKey
        ? a.verseKey === currentAyah.verseKey
        : a.number === currentAyah.number
    );
    if (curIdx >= 0 && curIdx + 1 < currentSurah.ayahs.length) {
      const nextAyah = currentSurah.ayahs[curIdx + 1];
      const nextAyahUrl = buildSheikhAyahAudioUrl(
        selectedSheikhId,
        currentSurah.id,
        nextAyah.number,
        nextAyah.verseKey
      );
      if (nextAyahUrl) urlsToPreload.push(nextAyahUrl);
    }

    for (const w of currentAyah.words || []) {
      if (w.audioUrl) urlsToPreload.push(w.audioUrl);
    }

    if (readingScope === 'page') {
      for (const a of currentSurah.ayahs) {
        const u = buildSheikhAyahAudioUrl(
          selectedSheikhId,
          currentSurah.id,
          a.number,
          a.verseKey
        );
        if (u) urlsToPreload.push(u);
      }
    }

    // Ограничиваем размер пула (до 140 элементов), чтобы не перегружать память
    if (audioCacheRef.current.size > 140) {
      const keys = Array.from(audioCacheRef.current.keys());
      for (let i = 0; i < 40; i++) {
        audioCacheRef.current.delete(keys[i]);
      }
    }

    for (const u of urlsToPreload) {
      if (!audioCacheRef.current.has(u)) {
        const a = new Audio(u);
        a.preload = 'auto';
        audioCacheRef.current.set(u, a);
      }
    }
  }, [currentAyah, currentSurah, selectedSheikhId, readingScope]);

  // Реактивное обновление playbackRate при переключении селектора скорости (Sekin=0.75, O'rta=1.0, Tez=1.25)
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = referencePlaybackRate;
    }
  }, [referencePlaybackRate]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.onplaying = null;
      audioRef.current.pause();
      try {
        audioRef.current.currentTime = 0;
      } catch {
        // ignore
      }
      audioRef.current = null;
    }
    setPlayingAudioId(null);
    setIsAudioBufferingId(null);
    setPlayingPageAyahIndex(null);
    setPlayingQueueInfo(null);
  }, []);

  const playAudioUrl = useCallback(
    (url: string, id: string) => {
      if (!url) return;

      if (playingAudioId === id) {
        stopAudio();
        return;
      }

      stopAudio();

      const audio = getOrPreloadAudio(url);
      try {
        audio.currentTime = 0;
      } catch {
        // ignore if not seekable yet
      }
      audio.playbackRate = referencePlaybackRate;
      audioRef.current = audio;
      setPlayingAudioId(id);
      setIsAudioBufferingId(audio.readyState >= 3 ? null : id);
      setPlayingPageAyahIndex(null);

      audio.onplaying = () => {
        setIsAudioBufferingId(null);
      };
      // Жёсткая остановка строго на границе слова или аята (без автоперехода!)
      audio.onended = () => {
        stopAudio();
      };
      audio.onerror = () => {
        stopAudio();
      };

      audio.play().catch(() => {
        stopAudio();
      });
    },
    [playingAudioId, stopAudio, getOrPreloadAudio, referencePlaybackRate]
  );

  // Жёсткая фильтрация очереди аятов по диапазону [pageStartAyah .. pageEndAyah] и последовательное чтение
  const playPageAudio = (pageAyahs: Ayah[]) => {
    if (playingAudioId === 'main_stage_page_reference') {
      stopAudio();
      return;
    }

    if (!pageAyahs || pageAyahs.length === 0) return;

    // СТРОГАЯ фильтрация списка аятов страницы по выбранному диапазону [pageStartAyah .. pageEndAyah]
    const queue = pageAyahs.filter((a) => {
      const aNum = getAyahDisplayNumber(a);
      return aNum >= pageStartAyah && aNum <= pageEndAyah;
    });

    const effectiveQueue = queue.length > 0 ? queue : pageAyahs;

    stopAudio();
    setPlayingAudioId('main_stage_page_reference');

    const playNext = (currentIndex: number) => {
      // Как только дочитался последний аят из queue (pageEndAyah) — плеер НЕМЕДЛЕННО ОСТАНАВЛИВАЕТСЯ!
      if (currentIndex >= effectiveQueue.length) {
        stopAudio();
        return;
      }

      const ayah = effectiveQueue[currentIndex];
      const ayahNum = getAyahDisplayNumber(ayah);
      const pageIdx = pageAyahs.findIndex((pa) =>
        pa.verseKey && ayah.verseKey
          ? pa.verseKey === ayah.verseKey
          : getAyahDisplayNumber(pa) === ayahNum
      );

      setPlayingPageAyahIndex(pageIdx >= 0 ? pageIdx : currentIndex);
      setPlayingQueueInfo({
        currentIndex,
        queueLength: effectiveQueue.length,
        currentPlayingAyah: ayahNum,
      });

      // Синхронно обновляем currentAyah, чтобы на странице Корана зелёным подсвечивался именно читаемый аят
      handleSelectAyah(ayah);

      const sheikhAyahUrl = buildSheikhAyahAudioUrl(
        selectedSheikhId,
        currentSurah.id,
        ayah.number,
        ayah.verseKey
      );
      const audio = getOrPreloadAudio(sheikhAyahUrl);
      try {
        audio.currentTime = 0;
      } catch {
        // ignore
      }
      audio.playbackRate = referencePlaybackRate;
      audioRef.current = audio;
      setIsAudioBufferingId(
        audio.readyState >= 3 ? null : 'main_stage_page_reference'
      );

      audio.onplaying = () => {
        setIsAudioBufferingId(null);
      };
      audio.onended = () => {
        if (currentIndex + 1 >= effectiveQueue.length) {
          stopAudio();
        } else {
          playNext(currentIndex + 1);
        }
      };
      audio.onerror = () => {
        if (currentIndex + 1 >= effectiveQueue.length) {
          stopAudio();
        } else {
          playNext(currentIndex + 1);
        }
      };

      audio.play().catch(() => {
        stopAudio();
      });
    };

    // Запускаем воспроизведение СТРОГО с queue[0] (то есть с pageStartAyah)!
    playNext(0);
  };
  const playPageAyahsSequential = playPageAudio;

  const handleSelectSurah = async (surahId: number) => {
    stopAudio();
    setAnalysisResult(null);
    const catEntry = ALL_114_SURAHS_CATALOG.find((c) => c.id === surahId);
    const startPage = catEntry?.startPage ?? 1;
    await handleLoadMushafPage(startPage, 'first');
  };

  const handleLoadMushafPage = async (
    pageNumber: number,
    targetAyahSelector?: 'first' | 'last' | number
  ) => {
    stopAudio();
    const safePage = Math.max(1, Math.min(604, Math.round(pageNumber)));
    setActiveMushafPage(safePage);
    setMushafPageInput(String(safePage));
    setAnalysisResult(null);
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);

    const applySelection = (loaded: SurahMetadata) => {
      setSelectedSurahId(loaded.id);
      if (loaded.ayahs && loaded.ayahs.length > 0) {
        if (typeof targetAyahSelector === 'number') {
          const match =
            loaded.ayahs.find((a) => a.number === targetAyahSelector) ??
            loaded.ayahs.find(
              (a) =>
                a.verseKey &&
                parseInt(a.verseKey.split(':')[1], 10) === targetAyahSelector
            ) ??
            loaded.ayahs[0];
          handleSelectAyah(match);
        } else if (targetAyahSelector === 'last') {
          handleSelectAyah(loaded.ayahs[loaded.ayahs.length - 1]);
        } else {
          // По умолчанию всегда выбираем первый аят загруженной сахифы
          handleSelectAyah(loaded.ayahs[0]);
        }
      }
    };

    // 1. Проверяем кэш уже загруженных страниц
    const cachedPageId = 1000 + safePage;
    const existing = customSurahs.find((s) => s.id === cachedPageId);
    if (existing && existing.ayahs.length > 0) {
      applySelection(existing);
      return;
    }

    // 2. Страница 1 (Аль-Фатиха)
    if (safePage === 1) {
      const p1 = ENRICHED_INITIAL_SURAHS.find((s) => s.id === 1);
      if (p1 && p1.ayahs.length > 0) {
        applySelection(p1);
        return;
      }
    }

    // 3. Загрузка через fetchMushafPage
    setIsLoadingPage(true);
    try {
      const loadedPage = await fetchMushafPage(safePage);
      if (loadedPage && loadedPage.ayahs.length > 0) {
        setCustomSurahs((prev) => {
          const filtered = prev.filter((p) => p.id !== loadedPage.id);
          return [...filtered, loadedPage];
        });
        applySelection(loadedPage);
      }
    } catch (err) {
      console.error('[handleLoadMushafPage error]', err);
    } finally {
      setIsLoadingPage(false);
    }
  };

  const handleSelectAyah = (ayah: Ayah) => {
    if (examRollbackTimerRef.current) {
      clearTimeout(examRollbackTimerRef.current);
      examRollbackTimerRef.current = null;
    }
    setSelectedAyahNumber(ayah.number);
    if (ayah.verseKey) {
      setSelectedAyahKey(ayah.verseKey);
    }
    if (ayah.words && ayah.words.length > 0) {
      setSelectedWord(ayah.words[0]);
    }
    setAnalysisResult(null);
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
    setIsExamTextRevealed(false);
    setExamMistakeBanner(null);
    setExamSuccessBanner(null);
    setExamFailedWordId(null);
  };

  // Сброс диапазона прослушивания страницы на всю страницу (кнопка «Hammasi»)
  const resetPageAyahRange = useCallback(() => {
    if (playingAudioId !== null) {
      stopAudio();
    }
    setPageStartAyah(firstPageAyahNumber);
    setPageEndAyah(lastPageAyahNumber);
    isSelectingEndRef.current = false;
    if (currentSurah.ayahs && currentSurah.ayahs.length > 0) {
      handleSelectAyah(currentSurah.ayahs[0]);
    }
  }, [
    playingAudioId,
    stopAudio,
    firstPageAyahNumber,
    lastPageAyahNumber,
    currentSurah.ayahs,
  ]);

  // Выбор «Начало (От)» и «Конец (До)» кликами по кнопкам Oyat X в блоке OYATLAR
  const handleOyatlarButtonClick = (ayah: Ayah) => {
    // Если проигрывание уже идет — немедленно останавливаем старое аудио и обновляем диапазон!
    if (playingAudioId !== null) {
      stopAudio();
    }

    const clickedNum = getAyahDisplayNumber(ayah);

    if (readingScope === 'page') {
      if (!isSelectingEndRef.current) {
        // 1-й клик: устанавливает НАЧАЛО pageStartAyah = X, КОНЕЦ ставит на последний аят страницы
        setPageStartAyah(clickedNum);
        setPageEndAyah(lastPageAyahNumber);
        isSelectingEndRef.current = true;
        handleSelectAyah(ayah);
      } else {
        // 2-й клик: устанавливает КОНЕЦ pageEndAyah = Y (или меняет местами, если Y < pageStartAyah)
        if (clickedNum >= pageStartAyah) {
          setPageEndAyah(clickedNum);
        } else {
          const oldStart = pageStartAyah;
          setPageStartAyah(clickedNum);
          setPageEndAyah(oldStart);
          handleSelectAyah(ayah);
        }
        isSelectingEndRef.current = false;
      }
    } else {
      handleSelectAyah(ayah);
      setPageStartAyah(clickedNum);
      setPageEndAyah(lastPageAyahNumber);
      isSelectingEndRef.current = true;
    }
  };

  const getCurrentAyahIndex = (): number => {
    if (!currentSurah || !currentSurah.ayahs || currentSurah.ayahs.length === 0) return 0;
    const idx = currentSurah.ayahs.findIndex(
      (a) =>
        (a.verseKey && selectedAyahKey
          ? a.verseKey === selectedAyahKey
          : a.number === selectedAyahNumber)
    );
    return idx >= 0 ? idx : 0;
  };

  const handleNextAyah = () => {
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
    setAnalysisResult(null);

    if (!currentSurah || !currentSurah.ayahs || currentSurah.ayahs.length === 0) return;

    const currentIndex = getCurrentAyahIndex();
    if (currentIndex < currentSurah.ayahs.length - 1) {
      handleSelectAyah(currentSurah.ayahs[currentIndex + 1]);
    } else if (activeMushafPage < 604) {
      handleLoadMushafPage(activeMushafPage + 1, 'first');
    }
  };

  const handlePrevAyah = () => {
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
    setAnalysisResult(null);

    if (!currentSurah || !currentSurah.ayahs || currentSurah.ayahs.length === 0) return;

    const currentIndex = getCurrentAyahIndex();
    if (currentIndex > 0) {
      handleSelectAyah(currentSurah.ayahs[currentIndex - 1]);
    } else if (activeMushafPage > 1) {
      handleLoadMushafPage(activeMushafPage - 1, 'last');
    }
  };

  const handleNextWord = () => {
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
    setAnalysisResult(null);

    const words = currentAyah.words;
    const currentIdx = words.findIndex((w) => w.id === selectedWord.id);
    if (currentIdx >= 0 && currentIdx < words.length - 1) {
      const nextWord = words[currentIdx + 1];
      setSelectedWord(nextWord);
      playAudioUrl(nextWord.audioUrl, nextWord.id);
    } else {
      const currentIndex = getCurrentAyahIndex();
      if (currentIndex < currentSurah.ayahs.length - 1) {
        handleSelectAyah(currentSurah.ayahs[currentIndex + 1]);
      } else if (activeMushafPage < 604) {
        handleLoadMushafPage(activeMushafPage + 1, 'first');
      }
    }
  };

  const handlePrevWord = () => {
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
    setAnalysisResult(null);

    const words = currentAyah.words;
    const currentIdx = words.findIndex((w) => w.id === selectedWord.id);
    if (currentIdx > 0) {
      const prevWord = words[currentIdx - 1];
      setSelectedWord(prevWord);
      playAudioUrl(prevWord.audioUrl, prevWord.id);
    } else {
      const currentIndex = getCurrentAyahIndex();
      if (currentIndex > 0) {
        const prevAyah = currentSurah.ayahs[currentIndex - 1];
        handleSelectAyah(prevAyah);
        if (prevAyah.words && prevAyah.words.length > 0) {
          const lastWord = prevAyah.words[prevAyah.words.length - 1];
          setSelectedWord(lastWord);
          playAudioUrl(lastWord.audioUrl, lastWord.id);
        }
      } else if (activeMushafPage > 1) {
        handleLoadMushafPage(activeMushafPage - 1, 'last');
      }
    }
  };

  const handleQuickAyahJump = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const num = parseInt(quickAyahInput.trim(), 10);
    if (Number.isNaN(num) || num <= 0) return;

    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
    setAnalysisResult(null);

    const targetAyah =
      currentSurah.ayahs.find((a) => {
        if (a.verseKey) {
          const parts = a.verseKey.split(':');
          const vNum = parseInt(parts[parts.length - 1], 10);
          if (vNum === num) return true;
        }
        return a.number === num;
      }) ||
      currentSurah.ayahs.find((_, idx) => idx + 1 === num);

    if (targetAyah) {
      handleSelectAyah(targetAyah);
      setQuickAyahInput('');
      setTimeout(() => {
        const el = document.getElementById(
          `ayah-btn-${targetAyah.verseKey ?? targetAyah.number}`
        );
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }

    // Если аят на другой странице этой суры — подгружаем через API Quran.com точную страницу аята
    try {
      setIsLoadingPage(true);
      const res = await fetch(
        `https://api.quran.com/api/v4/verses/by_key/${effectiveSurahId}:${num}`
      );
      if (res.ok) {
        const data = await res.json();
        const pNum = data?.verse?.page_number;
        if (typeof pNum === 'number' && pNum >= 1 && pNum <= 604) {
          await handleLoadMushafPage(pNum, num);
          setQuickAyahInput('');
          return;
        }
      }
    } catch (err) {
      console.error('[handleQuickAyahJump error]', err);
    } finally {
      setIsLoadingPage(false);
    }
  };

  const handleWordClick = (word: QuranWord) => {
    setSelectedAyahNumber(word.ayahNumber);
    const parentAyah = currentSurah.ayahs.find(
      (a) =>
        getAyahDisplayNumber(a) === word.ayahNumber ||
        a.number === word.ayahNumber
    );
    if (parentAyah?.verseKey) {
      setSelectedAyahKey(parentAyah.verseKey);
    }
    setSelectedWord(word);
    if (!mistakeWordIds.has(word.id)) {
      setAnalysisResult(null);
      setUserRecordingBuffer(null);
      setUserRecordingUrl(null);
    }
    playAudioUrl(word.audioUrl, word.id);
  };

  const handlePracticeMistake = (
    letterArabic: string,
    rule?: TajweedRuleType
  ) => {
    handleSelectMistakeFromPanel('', letterArabic, rule);
  };

  const handleDrillRule = (rule: TajweedRuleType) => {
    const allWords = allAvailableSurahs.flatMap((s) =>
      s.ayahs.flatMap((a) => a.words)
    );
    const matchingWord =
      allWords.find((w) => w.checkPoints.some((cp) => cp.rule === rule)) ||
      allWords[0];
    if (matchingWord) {
      setTrainingMode('drill');
      handleWordClick(matchingWord);
      setNavTab('quran');
      setActiveHeaderPanel(null);
    }
  };

  const handleNavigateToSurahMistake = async (stat: SurahMistakeStat) => {
    const surahId = stat.surahId;
    const ayahEntries = Object.entries(stat.ayahMistakes);
    const targetAyahNumber =
      ayahEntries.length > 0
        ? parseInt(ayahEntries.sort((a, b) => b[1] - a[1])[0][0], 10)
        : 1;

    await handleSelectSurah(surahId);

    const targetSurah =
      allAvailableSurahs.find((s) => s.id === surahId) ??
      customSurahs.find((s) => s.id === surahId);

    if (targetSurah) {
      const targetAyah =
        targetSurah.ayahs.find(
          (a) =>
            a.number === targetAyahNumber ||
            (a.verseKey && a.verseKey.endsWith(`:${targetAyahNumber}`))
        ) ?? targetSurah.ayahs[0];

      if (targetAyah) {
        handleSelectAyah(targetAyah);
        if (targetAyah.words && targetAyah.words.length > 0) {
          const problemWord =
            targetAyah.words.find((w) => stat.problemWordIds.includes(w.id)) ??
            targetAyah.words[0];
          if (problemWord) {
            setSelectedWord(problemWord);
          }
        }
      }
    }

    setTrainingMode('word');
    setNavTab('quran');
    setActiveHeaderPanel(null);
  };

  const handleToggleRecording = async () => {
    if (!isRecording) {
      recordingSessionIdRef.current += 1;
      liveChunkAbortControllerRef.current = new AbortController();
      isRecordingRef.current = true;
      if (examRollbackTimerRef.current) {
        clearTimeout(examRollbackTimerRef.current);
        examRollbackTimerRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        setPlayingAudioId(null);
      }
      // В режиме сдачи наизусть при начале новой записи текст снова скрывается
      if (trainingMode === 'exam') {
        setIsExamTextRevealed(false);
        setExamMistakeBanner(null);
        setExamSuccessBanner(null);
        setExamFailedWordId(null);
        liveVerifiedWordsCountRef.current = 0;
      }
      setAnalysisResult(null);
      // Новая запись — очищаем предыдущую зеленую волну
      setUserRecordingBuffer(null);
      setUserRecordingUrl(null);
      startLiveMonitor();
      await startRecording();
    } else {
      recordingSessionIdRef.current += 1;
      liveChunkAbortControllerRef.current?.abort();
      liveChunkAbortControllerRef.current = null;
      isRecordingRef.current = false;
      const liveArabic = stopLiveMonitor();
      const recordedBuffer = await stopRecording();
      if (recordedBuffer && recordedBuffer.length > 0) {
        await processRecordedBuffer(
          recordedBuffer,
          recordedBuffer.recordedAudioUrl ?? recordedAudioUrl ?? undefined,
          liveArabic
        );
      }
    }
  };

  const isSingleWordMode = viewScope === 'word';
  const isPageMode = viewScope === 'page';
  const isExamHiddenNow =
    isExamMode && examSubMode === 'memorized' && !isExamTextRevealed;
  const isExamReferenceLocked = isExamMode;

  const activeTargetTitle = isExamMode
    ? `🎓 DARS TOPSHIRISH (${
        examSubMode === 'memorized' ? "Yoddan o'qish" : 'Uyga vazifa'
      }) • ${
        isPageMode
          ? `Sahifa ${activeMushafPage}`
          : isSingleWordMode
          ? `«${selectedWord.textUthmani}»`
          : `Oyat ${currentAyah.number}`
      }`
    : trainingMode === 'drill'
    ? `XATOLAR USTIDA: «${selectedWord.textUthmani}» (${selectedWord.transliteration})`
    : isPageMode
    ? `📖 DARS QILISH (MASHQ) • Sahifa ${activeMushafPage}`
    : isSingleWordMode
    ? `📖 DARS QILISH (MASHQ) • «${selectedWord.textUthmani}» (${selectedWord.transliteration})`
    : `📖 DARS QILISH (MASHQ) • ${currentSurahNameUz} • Oyat ${currentAyah.number}`;

  const currentSheikhProfile =
    TEN_SHEIKHS_CATALOG.find((s) => s.id === selectedSheikhId) ??
    TEN_SHEIKHS_CATALOG[0];

  const currentSheikhAyahUrl = buildSheikhAyahAudioUrl(
    selectedSheikhId,
    currentSurah.id,
    currentAyah.number,
    currentAyah.verseKey
  );

  const activeReferenceUrl = isSingleWordMode
    ? selectedWord.audioUrl
    : currentSheikhAyahUrl;

  const { activeWaveformUrls, activeWaveformLabel } = useMemo(() => {
    if (isSingleWordMode || playingAudioId === selectedWord.id) {
      return {
        activeWaveformUrls: [selectedWord.audioUrl],
        activeWaveformLabel: `Sheikh Namuna (Etalon) • So'z: «${selectedWord.textUthmani}»`,
      };
    }
    if (!isPageMode) {
      return {
        activeWaveformUrls: [currentSheikhAyahUrl],
        activeWaveformLabel: `Sheikh Namuna (Etalon) • Oyat ${
          currentAyah.verseKey ?? currentAyah.number
        }`,
      };
    }
    const queueAyahs = currentSurah.ayahs.filter((a) => {
      const aNum = getAyahDisplayNumber(a);
      return aNum >= pageStartAyah && aNum <= pageEndAyah;
    });
    const sliceAyahs = queueAyahs.length > 0 ? queueAyahs : currentSurah.ayahs;
    const pageUrls = sliceAyahs.map((a) =>
      buildSheikhAyahAudioUrl(
        selectedSheikhId,
        currentSurah.id,
        a.number,
        a.verseKey
      )
    );
    const isFullPageSelected =
      pageStartAyah === firstPageAyahNumber &&
      pageEndAyah === lastPageAyahNumber;
    return {
      activeWaveformUrls: pageUrls.length > 0 ? pageUrls : [currentSheikhAyahUrl],
      activeWaveformLabel: isFullPageSelected
        ? `Sheikh Namuna (Etalon) • Sahifa ${activeMushafPage}`
        : `Sheikh Namuna (Etalon) • Oraliq: Oyat ${pageStartAyah}–${pageEndAyah}`,
    };
  }, [
    isSingleWordMode,
    isPageMode,
    playingAudioId,
    selectedWord.id,
    selectedWord.audioUrl,
    selectedWord.textUthmani,
    currentSheikhAyahUrl,
    currentAyah,
    pageStartAyah,
    pageEndAyah,
    firstPageAyahNumber,
    lastPageAyahNumber,
    currentSurah.ayahs,
    currentSurah.id,
    selectedSheikhId,
    activeMushafPage,
    getAyahDisplayNumber,
  ]);

  const activeCheckPoints = isPageMode
    ? currentSurah.ayahs.flatMap((a) => a.words.flatMap((w) => w.checkPoints))
    : isSingleWordMode
    ? selectedWord.checkPoints
    : currentAyah.words.flatMap((w) => w.checkPoints);

  const activeTargetUthmani = isPageMode
    ? currentSurah.ayahs.map((a) => a.textUthmani).join(' ')
    : isSingleWordMode
    ? selectedWord.textUthmani
    : currentAyah.textUthmani;

  const activeExpectedPhonemes = isPageMode
    ? currentSurah.ayahs.flatMap((a) => a.words.map((w) => w.expectedPhonemes)).join(' | ')
    : isSingleWordMode
    ? selectedWord.expectedPhonemes
    : currentAyah.words.map((w) => w.expectedPhonemes).join(' | ');

  const recommendedDrillWords = getRecommendedDrillWords();

  // Анализ ошибок для подсветки прямо на тексте / аятах (Inline Error Highlighting)
  const mistakeEvaluations = useMemo(() => {
    if (!analysisResult?.evaluations) return [];
    return analysisResult.evaluations.filter(
      (ev) => ev.score < 75 || ev.status === 'mistake' || ev.status === 'warning'
    );
  }, [analysisResult]);

  const { mistakeWordIds, mistakeAyahKeys, wordMistakeMap } = useMemo(() => {
    const wordIds = new Set<string>();
    const ayahKeys = new Set<string>();
    const map = new Map<string, typeof mistakeEvaluations>();

    const letterMistakes = (analysisResult?.letterEvaluations || []).filter(
      (le) => le.status === 'mistake' || le.status === 'warning' || le.score < 75
    );

    if (
      mistakeEvaluations.length === 0 &&
      letterMistakes.length === 0 &&
      !examFailedWordId &&
      (analysisResult === null || analysisResult.overallScore > 22)
    ) {
      return {
        mistakeWordIds: wordIds,
        mistakeAyahKeys: ayahKeys,
        wordMistakeMap: map,
      };
    }

    if (examFailedWordId) {
      wordIds.add(examFailedWordId);
    }

    if (isSingleWordMode) {
      wordIds.add(selectedWord.id);
      const ayahKey = currentAyah.verseKey ?? `ayah-${currentAyah.number}`;
      ayahKeys.add(ayahKey);
      map.set(selectedWord.id, mistakeEvaluations);
      return {
        mistakeWordIds: wordIds,
        mistakeAyahKeys: ayahKeys,
        wordMistakeMap: map,
      };
    }

    for (const ev of mistakeEvaluations) {
      for (const ayah of currentSurah.ayahs) {
        const ayahKey = ayah.verseKey ?? `ayah-${ayah.number}`;
        for (const word of ayah.words) {
          if (
            ev.checkPointId.includes(word.id) ||
            word.checkPoints.some((cp) => cp.id === ev.checkPointId)
          ) {
            wordIds.add(word.id);
            ayahKeys.add(ayahKey);
            const list = map.get(word.id) || [];
            list.push(ev);
            map.set(word.id, list);
          }
        }
      }
    }

    if (
      typeof analysisResult?.failedWordIndex === 'number' &&
      analysisResult.failedWordIndex >= 0 &&
      currentAyah.words[analysisResult.failedWordIndex]
    ) {
      const fw = currentAyah.words[analysisResult.failedWordIndex];
      wordIds.add(fw.id);
      ayahKeys.add(currentAyah.verseKey ?? `ayah-${currentAyah.number}`);
    }

    for (const le of letterMistakes) {
      if (
        typeof le.word_index === 'number' &&
        le.word_index >= 0 &&
        currentAyah.words[le.word_index]
      ) {
        const w = currentAyah.words[le.word_index];
        wordIds.add(w.id);
        ayahKeys.add(currentAyah.verseKey ?? `ayah-${currentAyah.number}`);
      }
    }

    return {
      mistakeWordIds: wordIds,
      mistakeAyahKeys: ayahKeys,
      wordMistakeMap: map,
    };
  }, [
    mistakeEvaluations,
    analysisResult,
    examFailedWordId,
    isSingleWordMode,
    selectedWord.id,
    currentAyah.number,
    currentAyah.verseKey,
    currentAyah.words,
    currentSurah.ayahs,
  ]);

  const hasVisualErrors = useMemo(() => {
    if (isRecording) return false;
    return (
      mistakeWordIds.size > 0 ||
      mistakeEvaluations.length > 0 ||
      Boolean(examFailedWordId) ||
      Boolean(examMistakeBanner) ||
      (analysisResult !== null &&
        (analysisResult.overallScore < 80 ||
          (analysisResult.letterEvaluations || []).some(
            (le) => le.status === 'mistake' || le.status === 'warning'
          )))
    );
  }, [
    isRecording,
    mistakeWordIds,
    mistakeEvaluations,
    examFailedWordId,
    examMistakeBanner,
    analysisResult,
  ]);

  // Мгновенный сброс всех красных подсветок ошибок со слов и букв («✕ Xatolarni tozalash»)
  const clearVisualErrors = useCallback(() => {
    setAnalysisResult(null);
    setActiveHighlightedMistakeId(null);
    setActiveHighlightedWordId(null);
    setExamFailedWordId(null);
    setExamMistakeBanner(null);
    setExamSuccessBanner(null);
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
  }, []);

  // Двунаправленный скролл 1: Клик по ошибке в тексте -> скролл к карточке ошибки в правой панели
  const scrollToMistakeInPanel = (wordId: string) => {
    const evList = wordMistakeMap.get(wordId);
    const targetEv =
      evList && evList.length > 0 ? evList[0] : mistakeEvaluations[0];
    if (!targetEv) return;

    setActiveHighlightedMistakeId(targetEv.checkPointId);
    setActiveHighlightedWordId(wordId);

    const el = document.getElementById(`mistake-card-${targetEv.checkPointId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    setTimeout(() => {
      setActiveHighlightedMistakeId(null);
    }, 2800);
  };

  // Интерактивная отработка ошибки: Клик по карточке ошибки открывает интерактивный тренажер прямо внутри модального окна
  const handleSelectMistakeFromPanel = async (
    checkPointId: string,
    letterArabic?: string,
    rule?: TajweedRuleType
  ) => {
    const targetEv = mistakeEvaluations.find(
      (ev) => ev.checkPointId === checkPointId
    );
    const targetLetter =
      (targetEv ? baseArabicLetter(targetEv.letterArabic) : '') ||
      (letterArabic ? baseArabicLetter(letterArabic) : '') ||
      'م';

    const existingWp = weakPoints.find(
      (wp) => wp.baseArabicLetter === targetLetter || wp.key.includes(targetLetter)
    );
    const targetWp: StudentWeaknessStat = existingWp || {
      key: `letter_${targetLetter}`,
      label: `«${targetLetter}» harfi maxraji`,
      category: 'Maxraj / Talaffuz',
      totalAttempts: 1,
      mistakesCount: 1,
      averageScore: 65,
      lastFeedbackRu: `«${targetLetter}» harfi maxraji mashqi.`,
      baseArabicLetter: targetLetter,
      commonReasonUz: `«${targetLetter}» harfi maxrajini mustahkamlash va ovozda to'g'ri chiqarish mashqi.`,
      tipUz: "Harf maxrajiga e'tibor bering.",
    };

    setSelectedDrillWeakPoint(targetWp);
    setActiveHeaderPanel('drill');
  };

  // Переход к чтению целевой буквы непосредственно на странице Мусхафа
  const handleDrillInAyah = async (
    letterArabic: string,
    rule?: TajweedRuleType
  ) => {
    setActiveHeaderPanel(null);
    setNavTab('quran');
    setTrainingMode('drill');

    const targetLetter = baseArabicLetter(letterArabic);
    let foundAyah: Ayah | null = null;
    let foundWord: QuranWord | null = null;

    for (const ayah of currentSurah.ayahs) {
      for (const word of ayah.words) {
        if (
          baseArabicLetter(word.textUthmani).includes(targetLetter) ||
          word.checkPoints.some(
            (cp) => baseArabicLetter(cp.letterArabic) === targetLetter
          )
        ) {
          foundAyah = ayah;
          foundWord = word;
          break;
        }
      }
      if (foundWord) break;
    }

    if (foundAyah && foundWord) {
      setSelectedAyahNumber(foundAyah.number);
      if (foundAyah.verseKey) {
        setSelectedAyahKey(foundAyah.verseKey);
      }
      setSelectedWord(foundWord);
      setActiveHighlightedWordId(foundWord.id);
      setActiveHighlightedMistakeId(foundWord.checkPoints[0]?.id || null);

      if (foundWord.audioUrl) {
        playAudioUrl(foundWord.audioUrl, foundWord.id);
      }

      setTimeout(() => {
        const letterEl =
          document.querySelector(
            `[data-word-id="${foundWord!.id}"][data-base-letter="${targetLetter}"]`
          ) ||
          document.getElementById(`page-word-${foundWord!.id}`) ||
          document.getElementById(`center-word-${foundWord!.id}`);

        if (letterEl) {
          letterEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 350);
    }
  };

  // Точечный побуквенный рендеринг арабского слова (Character-Level Error Highlighting + Real-Time Live Streaming)
  const renderWordLetterClusters = (
    word: QuranWord,
    options?: {
      textSize?: 'giant' | 'large' | 'regular';
    }
  ) => {
    const clusters = splitIntoArabicLetterClusters(word.textUthmani);
    const wordEvs = wordMistakeMap.get(word.id) || [];
    const relevantEvs =
      isSingleWordMode && selectedWord.id === word.id
        ? mistakeEvaluations
        : wordEvs;
    const isOverallFail =
      analysisResult?.overallScore !== undefined &&
      analysisResult.overallScore <= 22 &&
      !analysisResult.isLivePreview &&
      !isRecording;

    const passThreshold = Math.round(60 + ((strictnessLevel - 50) / 50) * 25);

    // Определяем, было ли это слово уже прочитано в потоковом режиме (Real-Time) или в финальном результате
    const wordPosInAyah = currentAyah.words.findIndex((w) => w.id === word.id);
    const isLiveStreaming = Boolean(analysisResult?.isLivePreview || isRecording);
    const spokenWordsLimit =
      analysisResult?.spokenWordsCount ?? (isRecording ? 1 : currentAyah.words.length);
    const isWordSpokenInSession =
      analysisResult !== null &&
      (isSingleWordMode
        ? selectedWord.id === word.id
        : isLiveStreaming
        ? wordPosInAyah >= 0 && wordPosInAyah < spokenWordsLimit
        : wordPosInAyah >= 0);

    const isWordCompletedInLive =
      isLiveStreaming &&
      !isSingleWordMode &&
      wordPosInAyah >= 0 &&
      wordPosInAyah < spokenWordsLimit - 1;

    const spokenLetterLimit =
      analysisResult?.spokenLetterCount ?? clusters.length;

    const textSize = options?.textSize || 'regular';
    const wavyOffsetClass =
      textSize === 'giant'
        ? 'underline-offset-8 sm:underline-offset-12 decoration-4 sm:decoration-6'
        : textSize === 'large'
        ? 'underline-offset-6 sm:underline-offset-8 decoration-3 sm:decoration-4'
        : 'underline-offset-4 decoration-2';

    return clusters.map((cluster, cIdx) => {
      const isClusterSpokenNow =
        isWordSpokenInSession &&
        (!isLiveStreaming ||
          !isSingleWordMode ||
          cIdx < spokenLetterLimit);

      const matchingEv =
        !isLiveStreaming && isClusterSpokenNow
          ? relevantEvs.find(
              (ev) =>
                baseArabicLetter(ev.letterArabic) === cluster.baseLetter &&
                (ev.status === 'mistake' || ev.score < passThreshold)
            )
          : undefined;

      const matchingPyLetter =
        !isLiveStreaming &&
        isClusterSpokenNow &&
        (isSingleWordMode || wordEvs.length > 0 || wordMistakeMap.size === 0)
          ? (analysisResult?.letterEvaluations || []).find(
              (ple) =>
                (ple.letter === cluster.raw ||
                  baseArabicLetter(ple.letter) === cluster.baseLetter) &&
                (ple.status !== 'perfect' || ple.score < passThreshold)
            )
          : undefined;

      // Во время активной записи (isLiveStreaming) НЕ раскрашиваем буквы в красный цвет вперед читающего!
      const isMistake = Boolean(
        !isLiveStreaming &&
          isClusterSpokenNow &&
          (matchingEv || matchingPyLetter || isOverallFail)
      );
      const isSpokenCorrect = Boolean(
        (isWordCompletedInLive || (!isLiveStreaming && isClusterSpokenNow)) &&
          !isMistake
      );
      const cpId = matchingEv?.checkPointId;

      const isLetterHighlighted =
        (activeHighlightedMistakeId && cpId === activeHighlightedMistakeId) ||
        (activeHighlightedMistakeId &&
          matchingPyLetter &&
          activeHighlightedWordId === word.id &&
          baseArabicLetter(matchingPyLetter.letter) === cluster.baseLetter) ||
        (activeHighlightedWordId === word.id && isMistake);

      // В режиме «Uyga vazifa (Ko'rib topshirish)» цветные подсказки Таджвида скрыты до прочтения
      const tajweedColorClass =
        isExamMode && examSubMode === 'homework'
          ? 'text-white'
          : getTajweedColorClass(cluster, word.checkPoints, clusters);

      return (
        <span
          key={`${word.id}-cluster-${cIdx}`}
          id={`char-${word.id}-${cIdx}`}
          data-word-id={word.id}
          data-base-letter={cluster.baseLetter}
          data-letter-cp={cpId ?? undefined}
          onClick={(e) => {
            if (isMistake && cpId) {
              e.stopPropagation();
              setActiveHighlightedMistakeId(cpId);
              setActiveHighlightedWordId(word.id);
              const el = document.getElementById(`mistake-card-${cpId}`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }
          }}
          className={cn(
            'inline transition-all duration-150',
            isLetterHighlighted
              ? cn(
                  'text-amber-300 font-bold underline decoration-amber-400 decoration-wavy bg-amber-400/30 rounded px-1 ring-2 ring-amber-400 animate-pulse cursor-pointer',
                  wavyOffsetClass
                )
              : isMistake
              ? cn(
                  'text-rose-300 font-bold underline decoration-rose-500 decoration-wavy bg-rose-500/25 rounded px-0.5 ring-1 ring-rose-500/50 hover:bg-rose-500/35 cursor-pointer',
                  wavyOffsetClass
                )
              : isSpokenCorrect && (isRecording || isLiveStreaming || isExamMode)
              ? 'text-emerald-400 font-semibold drop-shadow-[0_0_8px_rgba(52,211,153,0.35)]'
              : tajweedColorClass
          )}
          title={
            isMistake
              ? `«${cluster.raw}» harfida xato aniqlandi (${
                  matchingEv?.feedbackRu ||
                  matchingPyLetter?.issue_uz ||
                  "To'g'rilash uchun bosing"
                })`
              : isSpokenCorrect && (isRecording || isLiveStreaming)
              ? `«${cluster.raw}» to'g'ri o'qildi`
              : undefined
          }
        >
          {cluster.raw}
        </span>
      );
    });
  };

  // При переключении на другое слово / аят / суру / режим — очищаем зеленую волну ученика
  useEffect(() => {
    setUserRecordingBuffer(null);
    setUserRecordingUrl(null);
  }, [activeReferenceUrl, trainingMode, activeMushafPage]);

  // Глобальные горячие клавиши (Keyboard Shortcuts)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Игнорируем нажатия, если фокус находится в полях ввода, выпадающих списках или textarea
      const target = e.target as HTMLElement | null;
      if (e.key === 'Escape') {
        setActiveHeaderPanel(null);
        return;
      }

      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        if (!isAnalyzing) {
          handleToggleRecording();
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (trainingMode === 'page') {
          handleLoadMushafPage(activeMushafPage + 1);
        } else if (isSingleWordMode) {
          handleNextWord();
        } else {
          handleNextAyah();
        }
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (trainingMode === 'page') {
          handleLoadMushafPage(activeMushafPage - 1);
        } else if (isSingleWordMode) {
          handlePrevWord();
        } else {
          handlePrevAyah();
        }
      } else if (
        e.key === 'r' ||
        e.key === 'R' ||
        e.key === 'n' ||
        e.key === 'N'
      ) {
        e.preventDefault();
        if (trainingMode === 'exam') {
          return;
        }
        if (trainingMode === 'page') {
          playPageAyahsSequential(currentSurah.ayahs);
        } else {
          playAudioUrl(activeReferenceUrl, 'main_stage_reference');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    isAnalyzing,
    trainingMode,
    activeMushafPage,
    currentSurah,
    handleToggleRecording,
    handleNextWord,
    handlePrevWord,
    handleNextAyah,
    handlePrevAyah,
    handleLoadMushafPage,
    playPageAyahsSequential,
    activeReferenceUrl,
    playAudioUrl,
  ]);

  return (
    <div className="h-screen w-full max-w-[100vw] box-border overflow-hidden bg-[#12161F] text-slate-100 flex relative pl-2.5 sm:pl-3.5 pr-2.5 sm:pr-3.5 py-2 gap-3">
      <VoiceCalibrationModal
        isOpen={isCalibrationModalOpen}
        onClose={() => setIsCalibrationModalOpen(false)}
        currentProfile={calibrationProfile}
        onSaveProfile={handleSaveCalibrationProfile}
      />

      {/* ============================================================================ */}
      {/* МОДАЛЬНОЕ ОКНО ДЛЯ SOZLAMALAR И XATOLAR (НЕ ДВИГАЕТ ОСНОВНУЮ СТРАНИЦУ!)      */}
      {/* ============================================================================ */}
      {(activeHeaderPanel === 'settings' || activeHeaderPanel === 'drill') && (
        <div
          onClick={() => setActiveHeaderPanel(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-2xl w-full max-h-[88vh] overflow-y-auto rounded-2xl bg-[#1B2028] border border-[#52437A] shadow-2xl p-6 space-y-5 text-slate-100"
          >
            {/* Заголовок модального окна + салатово-зеленые кнопки + ✕ Yopish */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-[#52437A]/50">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setNavTab('settings');
                    setActiveHeaderPanel('settings');
                  }}
                  className={cn(
                    'px-4 py-2 rounded-xl text-xs sm:text-sm font-extrabold border-2 transition-all cursor-pointer flex items-center gap-1.5 shadow-sm',
                    activeHeaderPanel === 'settings'
                      ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md'
                      : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                  )}
                >
                  <Settings className="w-4 h-4 shrink-0" />
                  <span>⚙️ Sozlamalar</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setNavTab('drill');
                    setActiveHeaderPanel('drill');
                  }}
                  className={cn(
                    'px-4 py-2 rounded-xl text-xs sm:text-sm font-extrabold border-2 transition-all cursor-pointer flex items-center gap-1.5 shadow-sm',
                    activeHeaderPanel === 'drill'
                      ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md'
                      : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                  )}
                >
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>⚠️ Xatolar tahlili</span>
                  {weakPoints.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-[#4ADE80] text-[#0B1710] text-[10px] font-extrabold border border-[#5E4D8C]">
                      {weakPoints.length}
                    </span>
                  )}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setActiveHeaderPanel(null)}
                className="px-3.5 py-2 rounded-xl bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] hover:border-[#5E4D8C] text-xs font-extrabold flex items-center gap-1.5 cursor-pointer shadow-sm transition-all"
              >
                <span>✕ Yopish</span>
              </button>
            </div>

            {activeHeaderPanel === 'settings' && (
              <div className="space-y-4">
                {/* Mashq rejimi */}
                <div className="rounded-2xl bg-[#242B35] border border-[#5E4D8C] p-4 space-y-3">
                  <label className="text-xs font-extrabold uppercase tracking-wider text-slate-100 block">
                    ASOSIY REJIM (DARS QILISH / TOPSHIRISH)
                  </label>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        activateStudyMode();
                      }}
                      className={cn(
                        'px-3 py-2.5 rounded-xl text-xs transition-all cursor-pointer shadow-sm',
                        !isExamMode
                          ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                          : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] font-semibold'
                      )}
                    >
                      📖 Dars qilish (So&apos;z / Oyat / Sahifa)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        activateExamMode();
                      }}
                      className={cn(
                        'px-3 py-2.5 rounded-xl text-xs transition-all cursor-pointer shadow-sm',
                        isExamMode
                          ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                          : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] font-semibold'
                      )}
                    >
                      🎓 Dars topshirish (Imtihon)
                    </button>
                  </div>

                  <div className="pt-2.5 border-t border-[#52437A]/50 space-y-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-200 block">
                      O&apos;qish ko&apos;lami (So&apos;z / Oyat / Sahifa):
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setReadingScope('word');
                        }}
                        className={cn(
                          'px-2.5 py-2 rounded-xl text-xs transition-all cursor-pointer shadow-sm',
                          readingScope === 'word'
                            ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                            : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] font-semibold'
                        )}
                      >
                        So&apos;zma-so&apos;z o&apos;qish
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReadingScope('ayah');
                        }}
                        className={cn(
                          'px-2.5 py-2 rounded-xl text-xs transition-all cursor-pointer shadow-sm',
                          readingScope === 'ayah'
                            ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                            : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] font-semibold'
                        )}
                      >
                        Oyatni to&apos;liq o&apos;qish
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReadingScope('page');
                          setUserRecordingBuffer(null);
                          setUserRecordingUrl(null);
                          setAnalysisResult(null);
                          if (selectedSurahId < 1000) {
                            handleLoadMushafPage(activeMushafPage);
                          }
                        }}
                        className={cn(
                          'px-2.5 py-2 rounded-xl text-xs transition-all cursor-pointer shadow-sm',
                          readingScope === 'page'
                            ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                            : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] font-semibold'
                        )}
                      >
                        Sahifani to&apos;liq o&apos;qish
                      </button>
                    </div>
                  </div>

                  {/* Темп чтения */}
                  <div className="pt-3 border-t border-[#52437A]/50 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-100">
                        Tilovat sur&apos;ati:
                      </span>
                      <span className="text-xs font-extrabold text-slate-100">
                        {referencePlaybackRate}x
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <button
                        type="button"
                        onClick={() => setPace('tahqiq')}
                        className={cn(
                          'py-2 px-2 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shadow-sm',
                          pace === 'tahqiq'
                            ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md font-extrabold'
                            : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                        )}
                      >
                        Tahqiq (0.75x)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPace('tadwir')}
                        className={cn(
                          'py-2 px-2 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shadow-sm',
                          pace === 'tadwir'
                            ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md font-extrabold'
                            : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                        )}
                      >
                        Tartil (1.0x)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPace('hadr')}
                        className={cn(
                          'py-2 px-2 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shadow-sm',
                          pace === 'hadr'
                            ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md font-extrabold'
                            : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                        )}
                      >
                        Hadr (1.25x)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPace('fast')}
                        className={cn(
                          'py-2 px-2 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shadow-sm',
                          pace === 'fast'
                            ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md font-extrabold'
                            : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                        )}
                      >
                        Tezkor (2.0x)
                      </button>
                    </div>
                  </div>
                </div>

                {/* Сложность ИИ и Микрофон */}
                <div className="rounded-2xl bg-[#242B35] border border-[#5E4D8C] p-4 space-y-3 text-slate-100">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-extrabold uppercase tracking-wider text-slate-100">
                      AI TEKSHIRUV QATTIQLIGI (50% – 100%)
                    </label>
                    <span className="px-2.5 py-0.5 rounded-full bg-[#4ADE80] text-[#0B1710] border border-[#5E4D8C] text-xs font-extrabold">
                      {strictnessLevel}%
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <button
                      type="button"
                      onClick={() => handleStrictnessChange(50)}
                      className={cn(
                        'py-2 px-2 rounded-xl border-2 text-xs font-bold transition-all cursor-pointer shadow-sm',
                        strictnessLevel <= 55
                          ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                          : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                      )}
                    >
                      50% (Yumshoq)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStrictnessChange(75)}
                      className={cn(
                        'py-2 px-2 rounded-xl border-2 text-xs font-bold transition-all cursor-pointer shadow-sm',
                        strictnessLevel > 55 && strictnessLevel < 90
                          ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                          : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                      )}
                    >
                      75% (Standart)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStrictnessChange(100)}
                      className={cn(
                        'py-2 px-2 rounded-xl border-2 text-xs font-bold transition-all cursor-pointer shadow-sm',
                        strictnessLevel >= 90
                          ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                          : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                      )}
                    >
                      100% (Ekspert)
                    </button>
                  </div>

                  {/* Выбор шейха и микрофона */}
                  <div className="pt-3 border-t border-[#52437A]/50 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-100">
                        Namuna ovozi (10 qori):
                      </span>
                      <select
                        value={selectedSheikhId}
                        onChange={(e) => handleSheikhChange(e.target.value as SheikhId)}
                        className="text-xs font-bold px-3 py-1.5 rounded-xl bg-[#242B35] text-slate-100 border border-[#5E4D8C] hover:border-[#6EE7A0]/50 cursor-pointer"
                      >
                        {TEN_SHEIKHS_CATALOG.map((sh, idx) => (
                          <option key={sh.id} value={sh.id} className="bg-[#1E2530] text-slate-100">
                            {idx + 1}. {sh.nameUz}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-100">
                        Mikrofon:
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsCalibrationModalOpen(true)}
                        className="px-3 py-1 rounded-xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] hover:border-[#6EE7A0]/50 text-slate-100 text-xs font-bold cursor-pointer shadow-sm"
                      >
                        🎙️ Kalibratsiya
                      </button>
                    </div>
                    <select
                      value={selectedDeviceId}
                      onChange={(e) => setSelectedDeviceId(e.target.value)}
                      disabled={isRecording}
                      aria-label="Mikrofon tanlash"
                      className="w-full text-xs font-semibold px-3 py-2 rounded-xl bg-[#242B35] text-slate-100 border border-[#5E4D8C]"
                    >
                      {audioDevices.length === 0 ? (
                        <option value="">Standart tizim mikrofoni</option>
                      ) : (
                        audioDevices.map((dev) => (
                          <option key={dev.deviceId} value={dev.deviceId}>
                            {dev.label}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {activeHeaderPanel === 'drill' && (
              <div className="space-y-4">
                {selectedDrillWeakPoint ? (
                  <InteractiveMistakeDrill
                    weakPoint={selectedDrillWeakPoint}
                    onBack={() => setSelectedDrillWeakPoint(null)}
                    onSuccessResolved={(letter, score) => {
                      resolveWeakPoint(letter, score);
                    }}
                    onDrillInAyah={(letter, r) => {
                      handleDrillInAyah(letter, r);
                    }}
                    strictnessLevel={strictnessLevel}
                    sheikhId={selectedSheikhId}
                    calibrationProfile={calibrationProfile}
                  />
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5 text-[#4ADE80]" />
                        <h3 className="text-sm font-extrabold text-slate-100 uppercase tracking-wider">
                          Xatolar ustida ishlash • Zaif nuqtalar ({weakPoints.length})
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          resetStudentProgress();
                          setSelectedDrillWeakPoint(null);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] text-xs font-bold text-slate-100 flex items-center gap-1.5 cursor-pointer shadow-sm transition-all active:scale-95"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Statistikani tozalash</span>
                      </button>
                    </div>

                    {weakPoints.length === 0 &&
                    topRuleMistakes.length === 0 &&
                    topSurahMistakes.length === 0 ? (
                      <div className="rounded-2xl border border-[#5E4D8C] bg-[#242B35] p-5 text-center space-y-3 text-slate-100">
                        <CheckCircle2 className="w-8 h-8 text-[#4ADE80] mx-auto" />
                        <h4 className="text-sm font-bold text-slate-100">
                          Hozircha xatolar yo&apos;q
                        </h4>
                        <p className="text-xs text-slate-300">
                          Mashqlarni bajaring yoki quyidagi harflardan birini tanlab, mustaqil mashq qiling:
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                          {['م', 'ر', 'ح', 'ق', 'ع', 'ص', 'ض', 'ط', 'ظ', 'خ', 'غ', 'ث'].map(
                            (char) => (
                              <button
                                key={char}
                                type="button"
                                onClick={() => {
                                  const syntheticWp: StudentWeaknessStat = {
                                    key: `letter_${char}`,
                                    label: `«${char}» harfi maxraji`,
                                    category: 'Maxraj / Talaffuz',
                                    totalAttempts: 1,
                                    mistakesCount: 1,
                                    averageScore: 65,
                                    lastFeedbackRu: `«${char}» harfi maxraji mashqi.`,
                                    baseArabicLetter: char,
                                    commonReasonUz: `«${char}» harfi maxrajini mustahkamlash va ovozda to'g'ri chiqarish mashqi.`,
                                    tipUz: "Harf maxrajiga e'tibor bering.",
                                  };
                                  setSelectedDrillWeakPoint(syntheticWp);
                                }}
                                className="px-3 py-1.5 rounded-xl bg-[#242B35] hover:bg-[#4ADE80] border border-[#5E4D8C] text-xs font-extrabold text-slate-100 hover:text-[#0B1710] flex items-center gap-1.5 cursor-pointer shadow-sm transition-all"
                              >
                                <span dir="rtl" className="font-arabic text-base">
                                  {char}
                                </span>
                                <span>mashqi</span>
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {weakPoints.map((wp) => (
                          <div
                            key={wp.key}
                            onClick={() => setSelectedDrillWeakPoint(wp)}
                            className="rounded-2xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] hover:border-emerald-400 p-3.5 space-y-2.5 transition-all cursor-pointer shadow-sm hover:shadow-md active:scale-[0.99] group text-slate-100"
                            title="Interaktiv mashg'ulotni ochish uchun bosing"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2.5">
                                {wp.baseArabicLetter && (
                                  <span
                                    dir="rtl"
                                    className="font-arabic text-3xl font-bold text-emerald-400 px-2.5 py-1 rounded-xl bg-[#1E2631] border border-[#5E4D8C] group-hover:border-emerald-400 group-hover:text-emerald-300 transition-colors"
                                  >
                                    {wp.baseArabicLetter}
                                  </span>
                                )}
                                <div>
                                  <span className="font-extrabold text-xs sm:text-sm text-slate-100 block">
                                    {wp.label}
                                  </span>
                                  <span className="text-[10px] text-slate-300 font-medium">
                                    {wp.category || "Maxraj / Talaffuz"}
                                  </span>
                                </div>
                              </div>
                              <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-[#1E2631] text-[#4ADE80] border border-[#5E4D8C]">
                                {wp.averageScore}%
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-300 leading-snug font-medium line-clamp-2">
                              {wp.commonReasonUz ||
                                wp.lastFeedbackRu ||
                                'Talaffuz aniqligi'}
                            </p>
                            <div className="pt-1 flex items-center justify-between text-[11px] font-bold">
                              <span className="flex items-center gap-1 text-[#4ADE80]">
                                <Sparkles className="w-3.5 h-3.5" />
                                <span>Mashq trenajyori</span>
                              </span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDrillInAyah(wp.baseArabicLetter || wp.key);
                                  }}
                                  className="px-2 py-0.5 rounded-lg bg-[#1E2631] hover:bg-[#2C3542] border border-[#5E4D8C] text-slate-300 hover:text-white transition-colors font-extrabold cursor-pointer"
                                  title="Qur'on matniga o'tish va shu so'zni mashq qilish"
                                >
                                  Oyatda o&apos;qish →
                                </button>
                                <span className="px-2.5 py-1 rounded-lg bg-[#4ADE80] text-[#0B1710] font-extrabold border border-[#6EE7A0] shadow-[0_0_12px_rgba(74,222,128,0.2)]">
                                  🎯 Mashq qilish →
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============================================================================ */}
      {/* 1. ЛЕВЫЙ СТОЛБИК: ВЫБОР КОРАНА + ПОСТОЯННО ОТКРЫТЫЙ ТАДЖВИД (7 ЦВЕТОВ)       */}
      {/* ============================================================================ */}
      <aside className="w-[310px] sm:w-[328px] shrink-0 h-full rounded-2xl bg-[#1B2028] border border-[#52437A] overflow-y-auto px-4 py-3.5 space-y-3.5 shadow-2xl z-20 box-border text-slate-100">
        {/* Заголовок колонки выбора Корана с иконкой */}
        <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#52437A]/50">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-[#4ADE80] border border-[#52437A] flex items-center justify-center text-[#0B1710] shrink-0 shadow-sm font-extrabold">
              <BookOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="text-xs font-extrabold text-slate-100 uppercase tracking-wider truncate">
                  📖 SURA VA OYAT TANLASH
                </h2>
                <span
                  title={
                    engineStatus === 'ready'
                      ? 'AI tayyor'
                      : 'Ovoz tahlilchisi faol'
                  }
                  className="w-2.5 h-2.5 rounded-full shrink-0 bg-[#4ADE80] ring-1 ring-[#6EE7A0]"
                />
              </div>
              <p className="text-[10px] text-slate-300 truncate font-medium">
                114 sura • 604 sahifa • Oyatlar
              </p>
            </div>
          </div>
        </div>

        {/* Блок 1: Выбор Суры (1–114) и Сахифы (1–604) */}
        <div className="rounded-2xl bg-[#242B35] border border-[#5E4D8C] p-3 space-y-2 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-100">
              SURA TANLASH (1–114)
            </label>
            <span className="text-xs text-slate-300 font-arabic font-bold">
              {currentCatalogEntry?.nameArabic ?? currentSurah.nameArabic}
            </span>
          </div>

          <select
            value={effectiveSurahId}
            onChange={(e) => {
              const val = Number(e.target.value);
              handleSelectSurah(val);
            }}
            aria-label="Sura tanlash"
            className="w-full text-xs font-semibold px-2.5 py-2 rounded-xl bg-[#1E2530] text-slate-100 border border-[#5E4D8C] hover:border-[#4ADE80] focus:outline-none focus:border-[#4ADE80] cursor-pointer shadow-sm"
          >
            {ALL_114_SURAHS_CATALOG.map((cat) => (
              <option
                key={cat.id}
                value={cat.id}
                className="bg-[#1E2530] text-slate-100"
              >
                {cat.id}. {cat.nameUz} ({cat.versesCount} oyat) — {cat.nameArabic}
              </option>
            ))}
          </select>

          {/* Навигация по страницам Мусхафа (SAHIFA 1–604) */}
          <div className="space-y-1.5 pt-1.5 border-t border-[#52437A]/40">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold uppercase tracking-wider text-slate-100">
                SAHIFA (1–604)
              </span>
              <span className="text-slate-300 font-mono font-bold">
                {activeMushafPage} / 604
              </span>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const num = Number(mushafPageInput);
                if (!Number.isNaN(num) && num >= 1 && num <= 604) {
                  handleLoadMushafPage(num);
                }
              }}
              className="flex items-center gap-1.5 w-full min-w-0"
            >
              {/* Кнопка предыдущей страницы (<) */}
              <button
                type="button"
                onClick={() => handleLoadMushafPage(activeMushafPage - 1)}
                disabled={activeMushafPage <= 1 || isLoadingPage}
                title="Oldingi sahifa"
                className="w-8 h-8 rounded-xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] disabled:opacity-40 text-slate-100 flex items-center justify-center transition-all shrink-0 cursor-pointer disabled:cursor-not-allowed shadow-sm"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              {/* Поле ввода номера страницы */}
              <input
                type="number"
                min={1}
                max={604}
                value={mushafPageInput}
                onChange={(e) => setMushafPageInput(e.target.value)}
                placeholder="1–604"
                className="w-16 flex-1 min-w-0 px-2 py-1 text-center rounded-xl bg-[#1E2530] border border-[#5E4D8C] text-xs text-slate-100 font-mono font-bold focus:outline-none focus:border-[#4ADE80]"
              />

              {/* Кнопка перехода O'tish в салатово-зеленом цвете */}
              <button
                type="submit"
                onClick={() => {
                  const num = Number(mushafPageInput);
                  if (!Number.isNaN(num) && num >= 1 && num <= 604) {
                    handleLoadMushafPage(num);
                  }
                }}
                disabled={isLoadingPage}
                title="Sahifaga o'tish"
                className="px-2.5 py-1.5 rounded-xl bg-[#4ADE80] hover:bg-[#38CB71] disabled:opacity-50 text-[#0B1710] text-xs font-extrabold border border-[#52437A] shadow-sm flex items-center gap-1 transition-all shrink-0 cursor-pointer disabled:cursor-not-allowed"
              >
                {isLoadingPage ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <span>O&apos;tish</span>
                )}
              </button>

              {/* Кнопка следующей страницы (>) */}
              <button
                type="button"
                onClick={() => handleLoadMushafPage(activeMushafPage + 1)}
                disabled={activeMushafPage >= 604 || isLoadingPage}
                title="Keyingi sahifa"
                className="w-8 h-8 rounded-xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] disabled:opacity-40 text-slate-100 flex items-center justify-center transition-all shrink-0 cursor-pointer disabled:cursor-not-allowed shadow-sm"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </form>
          </div>

          {/* Быстрый переход к конкретному аяту */}
          <form
            onSubmit={handleQuickAyahJump}
            className="flex items-center gap-1.5 pt-1.5 border-t border-[#52437A]/40 w-full min-w-0"
          >
            <input
              type="number"
              min={1}
              max={
                currentCatalogEntry?.versesCount ||
                currentSurah.ayahs.length ||
                286
              }
              value={quickAyahInput}
              onChange={(e) => setQuickAyahInput(e.target.value)}
              placeholder="Oyat raqami..."
              className="w-20 flex-1 min-w-0 px-2.5 py-1 rounded-xl bg-[#1E2530] border border-[#5E4D8C] text-xs text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-[#4ADE80]"
            />
            <button
              type="submit"
              title="Oyatga o'tish"
              className="px-2.5 py-1 rounded-xl bg-[#4ADE80] hover:bg-[#38CB71] text-[#0B1710] text-xs font-extrabold border border-[#52437A] shadow-sm flex items-center justify-center transition-all shrink-0 cursor-pointer"
            >
              Oyatga o&apos;tish
            </button>
          </form>
        </div>

        {/* Блок 2: Выбор аятов (OYATLAR) */}
        <div className="rounded-2xl bg-[#242B35] border border-[#5E4D8C] p-3 space-y-2 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-100 block">
                OYATLAR ({currentSurah.ayahs.length})
              </label>
              <span className="text-[10px] text-slate-300 font-medium truncate block">
                {currentSurahNameUz}
              </span>
            </div>

            {/* Стрелки переключения аята Oldingi (<) / Keyingi (>) */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handlePrevAyah}
                title="Oldingi oyat"
                className="w-7 h-7 rounded-xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] text-slate-100 flex items-center justify-center transition-all cursor-pointer shadow-sm"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleNextAyah}
                title="Keyingi oyat"
                className="w-7 h-7 rounded-xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] text-slate-100 flex items-center justify-center transition-all cursor-pointer shadow-sm"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Индикатор диапазона «От и До» и кнопка сброса Hammasi */}
          <div className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/80">
            <span className="text-[10px] font-extrabold text-[#4ADE80] truncate">
              Oraliq: Oyat {pageStartAyah} — {pageEndAyah}
            </span>
            <button
              type="button"
              onClick={resetPageAyahRange}
              title="Butun sahifani tanlash (boshidan oxirigacha)"
              className={cn(
                'px-2 py-0.5 rounded-lg text-[10px] font-bold transition-all cursor-pointer shrink-0 border',
                pageStartAyah === firstPageAyahNumber &&
                  pageEndAyah === lastPageAyahNumber
                  ? 'bg-[#4ADE80]/20 text-[#4ADE80] border-[#4ADE80]/50'
                  : 'bg-[#242B35] hover:bg-[#4ADE80] text-slate-200 hover:text-[#0B1710] border-[#5E4D8C]'
              )}
            >
              Hammasi
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5 max-h-36 overflow-y-auto pr-1 pt-0.5">
            {currentSurah.ayahs.map((ayah) => {
              const ayahNum = getAyahDisplayNumber(ayah);
              const isSelectedSingle =
                ayah.verseKey && selectedAyahKey
                  ? ayah.verseKey === selectedAyahKey
                  : ayah.number === selectedAyahNumber;
              const isStart = ayahNum === pageStartAyah;
              const isEnd = ayahNum === pageEndAyah;
              const isBetween =
                ayahNum > pageStartAyah && ayahNum < pageEndAyah;

              return (
                <button
                  key={ayah.verseKey ?? `${currentSurah.id}_${ayah.number}`}
                  id={`ayah-btn-${ayah.verseKey ?? ayah.number}`}
                  type="button"
                  onClick={() => handleOyatlarButtonClick(ayah)}
                  title={
                    isPageMode
                      ? `Oyat ${ayahNum}: 1-bosish — boshlanishi (▶️), 2-bosish — tugashi (⏹️)`
                      : `Oyat ${ayahNum}`
                  }
                  className={cn(
                    'px-1.5 py-1.5 rounded-xl text-[11px] transition-all truncate cursor-pointer shadow-sm flex items-center justify-center gap-1',
                    isPageMode
                      ? isStart || isEnd
                        ? 'bg-[#4ADE80] text-[#0B1710] font-bold border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                        : isBetween
                        ? 'bg-[#4ADE80]/25 text-[#4ADE80] border border-[#4ADE80]/60 font-bold'
                        : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-300 border border-[#5E4D8C] hover:border-[#4ADE80] font-semibold'
                      : isSelectedSingle
                      ? 'bg-[#4ADE80] text-[#0B1710] font-extrabold border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md'
                      : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] hover:border-[#4ADE80] font-extrabold'
                  )}
                >
                  {isPageMode && isStart && (
                    <span className="text-[9px] leading-none">▶️</span>
                  )}
                  <span className="truncate">Oyat {ayahNum}</span>
                  {isPageMode && isEnd && (
                    <span className="text-[9px] leading-none">⏹️</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ======================================================================== */}
        {/* Блок 3: ПОСТОЯННО ОТКРЫТЫЙ БЛОК «🎨 TAJVID QOIDALARI (7 RANG)» СЛЕВА!     */}
        {/* ======================================================================== */}
        <div className="rounded-2xl bg-[#242B35] border border-[#5E4D8C] p-3 space-y-2 shadow-sm">
          <div className="flex items-center justify-between pb-1 border-b border-[#52437A]/50">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-100">
              🎨 TAJVID QOIDALARI (7 RANG)
            </span>
            <span className="text-[10px] font-semibold text-slate-300">
              Doim ochiq
            </span>
          </div>

          <div className="space-y-1.5">
            {/* 1. Madd Lazim / Wajib */}
            <div className="px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/60 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0 shadow-sm" />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-red-700 block truncate">
                    Madd Lazim / Wajib (4–6 harakat)
                  </span>
                  <span className="text-[10px] text-slate-300 block truncate">
                    To&apos;lqinli belgi (ٓ) uzun cho&apos;ziladi
                  </span>
                </div>
              </div>
              <span className="font-arabic text-xs px-1.5 py-0.5 rounded bg-red-100 border border-red-300 text-red-800 shrink-0">
                آ / ٓ
              </span>
            </div>

            {/* 2. Madd Tabiiy */}
            <div className="px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/60 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-orange-400 shrink-0 shadow-sm" />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-orange-700 block truncate">
                    Madd Tabiiy (2–4 harakat)
                  </span>
                  <span className="text-[10px] text-slate-300 block truncate">
                    Kichik alif (ٰ) va ا و ي 2 harakat
                  </span>
                </div>
              </div>
              <span className="font-arabic text-xs px-1.5 py-0.5 rounded bg-orange-100 border border-orange-300 text-orange-800 shrink-0">
                ـٰ / ا و ي
              </span>
            </div>

            {/* 3. G'unna va Ikhfo */}
            <div className="px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/60 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0 shadow-sm" />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-emerald-700 block truncate">
                    G&apos;unna va Ikhfo (2 harakat)
                  </span>
                  <span className="text-[10px] text-slate-300 block truncate">
                    Dimoq (burun) orqali 2 harakat ushlash
                  </span>
                </div>
              </div>
              <span className="font-arabic text-xs px-1.5 py-0.5 rounded bg-emerald-100 border border-emerald-300 text-emerald-800 shrink-0">
                نّ / مّ
              </span>
            </div>

            {/* 4. Idg'om va Iqlob */}
            <div className="px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/60 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500 shrink-0 shadow-sm" />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-purple-700 block truncate">
                    Idg&apos;om va Iqlob (Kirishish)
                  </span>
                  <span className="text-[10px] text-slate-300 block truncate">
                    Keyingi harfga qo&apos;shib o&apos;qish
                  </span>
                </div>
              </div>
              <span className="font-arabic text-xs px-1.5 py-0.5 rounded bg-purple-100 border border-purple-300 text-purple-800 shrink-0">
                لّ / ۢ
              </span>
            </div>

            {/* 5. Qalqala */}
            <div className="px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/60 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-500 shrink-0 shadow-sm" />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-cyan-700 block truncate">
                    Qalqala (Tebranish — ق ط ب ج د)
                  </span>
                  <span className="text-[10px] text-slate-300 block truncate">
                    Sukunli harfda jarangdor tebranish
                  </span>
                </div>
              </div>
              <span className="font-arabic text-xs px-1.5 py-0.5 rounded bg-cyan-100 border border-cyan-300 text-cyan-800 shrink-0">
                قْ طْ بْ
              </span>
            </div>

            {/* 6. Tafxim */}
            <div className="px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/60 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 shrink-0 shadow-sm" />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-indigo-700 block truncate">
                    Tafxim (Yo&apos;g&apos;on — خص ضغط قظ)
                  </span>
                  <span className="text-[10px] text-slate-300 block truncate">
                    Til orqasini ko&apos;tarib yo&apos;g&apos;on o&apos;qish
                  </span>
                </div>
              </div>
              <span className="font-arabic text-xs px-1.5 py-0.5 rounded bg-indigo-100 border border-indigo-300 text-indigo-800 shrink-0">
                ص ض ط ق
              </span>
            </div>

            {/* 7. O'qilmaydigan harflar */}
            <div className="px-2.5 py-1.5 rounded-xl bg-[#1E2530] border border-[#5E4D8C]/60 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-400 shrink-0" />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-slate-600 block truncate">
                    O&apos;qilmaydigan harf (Vasla / Shamsiyya)
                  </span>
                  <span className="text-[10px] text-slate-300 block truncate">
                    Talaffuz qilinmaydi, ulab ketiladi
                  </span>
                </div>
              </div>
              <span className="font-arabic text-xs px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 text-slate-700 shrink-0">
                ٱ / لْ
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* ============================================================================ */}
      {/* 2. ЦЕНТРАЛЬНАЯ КОЛОНКА (БЕЗ ВЫДВИЖНЫХ БЛОКОВ, СДВИГАЮЩИХ СТРАНИЦУ!)          */}
      {/* ============================================================================ */}
      <main className="flex-1 min-w-0 w-full max-w-full box-border h-full overflow-y-auto overflow-x-hidden flex flex-col p-3 sm:p-5 relative rounded-2xl bg-[#1B2028] border border-[#52437A] shadow-xl text-slate-100">
        {/* Верхняя панель с четкими кнопками */}
        <header className="w-full flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-[#52437A]/50 mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <div>
              <h1 className="text-sm sm:text-base font-extrabold text-slate-100 tracking-tight">
                Tajweed Pro
              </h1>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <p className="text-xs text-slate-300 flex items-center gap-1.5">
                  <span className="text-slate-100 font-bold">
                    {currentSurahNameUz}
                  </span>
                  <span>•</span>
                  <span className="font-semibold text-slate-100">
                    {isPageMode
                      ? `Sahifa ${activeMushafPage} / 604`
                      : `Oyat ${currentAyah.verseKey ?? currentAyah.number}`}
                  </span>
                  <span className="text-slate-300 font-arabic text-sm">
                    ({currentCatalogEntry?.nameArabic ?? currentSurah.nameArabic})
                  </span>
                </p>

                {/* Быстрые стрелочки перехода между аятами или страницами */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={
                      isPageMode
                        ? () => handleLoadMushafPage(activeMushafPage - 1)
                        : handlePrevAyah
                    }
                    disabled={
                      isPageMode ? activeMushafPage <= 1 || isLoadingPage : false
                    }
                    title={isPageMode ? 'Oldingi sahifa' : 'Oldingi oyat'}
                    className="w-7 h-7 rounded-lg bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] flex items-center justify-center text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-sm hover:border-[#5E4D8C]"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={
                      isPageMode
                        ? () => handleLoadMushafPage(activeMushafPage + 1)
                        : handleNextAyah
                    }
                    disabled={
                      isPageMode
                        ? activeMushafPage >= 604 || isLoadingPage
                        : false
                    }
                    title={isPageMode ? 'Keyingi sahifa' : 'Keyingi oyat'}
                    className="w-7 h-7 rounded-lg bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] flex items-center justify-center text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-sm hover:border-[#5E4D8C]"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Кнопки управления в шапке: ⚠️ Xatolar | ⚙️ Sozlamalar | 📖 Dars qilish | 🎓 Dars topshirish */}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                setNavTab('drill');
                setActiveHeaderPanel('drill');
              }}
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shrink-0 shadow-sm',
                activeHeaderPanel === 'drill' || trainingMode === 'drill'
                  ? 'bg-[#4ADE80] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md font-extrabold'
                  : 'bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] text-slate-100'
              )}
              title="Xatolar ustida ishlash oynasini ochish"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-slate-300" />
              <span>⚠️ Xatolar</span>
              {weakPoints.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-[#4ADE80] text-[#0B1710] text-[10px] font-extrabold border border-[#5E4D8C]">
                  {weakPoints.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setNavTab('settings');
                setActiveHeaderPanel('settings');
              }}
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shrink-0 shadow-sm',
                activeHeaderPanel === 'settings'
                  ? 'bg-[#4ADE80] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md font-extrabold'
                  : 'bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] text-slate-100'
              )}
              title="Sozlamalar oynasini ochish"
            >
              <Settings className="w-3.5 h-3.5 shrink-0 text-slate-300" />
              <span>⚙️ Sozlamalar</span>
            </button>

            <button
              type="button"
              onClick={() => {
                activateStudyMode();
              }}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs transition-all cursor-pointer shrink-0',
                !isExamMode
                  ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                  : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] font-semibold'
              )}
              title="Dars qilish (Mashq / Tayyorgarlik) rejimini yoqish"
            >
              <span>📖 Dars qilish</span>
            </button>

            <button
              type="button"
              onClick={() => {
                activateExamMode();
              }}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs transition-all cursor-pointer shrink-0',
                isExamMode
                  ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                  : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] font-semibold'
              )}
              title="Dars topshirish (Imtihon / Yoddan o'qish) rejimini yoqish"
            >
              <span>🎓 Dars topshirish</span>
            </button>
          </div>
        </header>

        {/* Центрированная карточка фокуса с благородным тёмно-серым фоном #1E2530 (расширяется вместе с масштабом страницы!) */}
        <div className="flex-1 min-w-0 w-full max-w-full box-border flex items-start justify-center p-1 sm:p-2">
          <div
            className={cn(
              'min-w-0 w-full max-w-full box-border h-auto overflow-visible rounded-3xl bg-[#1E2530] border border-[#52437A] shadow-2xl text-center transition-all text-white',
              isPageMode && pageViewMode === 'image'
                ? 'p-3 sm:p-5 space-y-3'
                : isPageMode || currentAyah.words.length > 12
                ? 'p-3 sm:p-5 space-y-3'
                : 'max-w-3xl p-5 sm:p-7 space-y-4'
            )}
            style={
              isPageMode
                ? { maxWidth: `min(100%, ${Math.max(860, Math.round(880 * fontScale))}px)` }
                : currentAyah.words.length > 12
                ? { maxWidth: `min(100%, ${Math.max(820, Math.round(840 * fontScale))}px)` }
                : { maxWidth: '100%' }
            }
          >
            {/* Метка выбранного слова / аята / сахифы + переключатели режимов */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs text-white border-b border-[#5E4D8C] pb-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-extrabold text-[#0B1710] uppercase tracking-wider px-3 py-1 rounded-xl bg-[#4ADE80] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]">
                  {isExamMode
                    ? `🎓 DARS TOPSHIRISH • ${
                        readingScope === 'word'
                          ? "SO'Z"
                          : readingScope === 'page'
                          ? `SAHIFA ${activeMushafPage}`
                          : 'OYAT'
                      }`
                    : `📖 DARS QILISH (MASHQ) • ${
                        readingScope === 'word'
                          ? "SO'Z"
                          : readingScope === 'page'
                          ? `SAHIFA ${activeMushafPage}`
                          : 'OYAT'
                      }`}
                </span>

                {/* Быстрые кнопки переключения масштаба чтения (не сбрасывают режим экзамена!) */}
                <div className="flex flex-wrap items-center gap-2 p-1 rounded-2xl bg-[#2A3441] border border-[#5E4D8C]">
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setReadingScope('word');
                    }}
                    className={cn(
                      'px-3 py-1 rounded-xl text-[11px] font-bold border-2 transition-all cursor-pointer shadow-sm',
                      readingScope === 'word'
                        ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                        : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                    )}
                  >
                    So&apos;z
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setReadingScope('ayah');
                    }}
                    className={cn(
                      'px-3 py-1 rounded-xl text-[11px] font-bold border-2 transition-all cursor-pointer shadow-sm',
                      readingScope === 'ayah'
                        ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                        : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                    )}
                  >
                    To&apos;liq oyat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setReadingScope('page');
                      if (selectedSurahId < 1000) {
                        handleLoadMushafPage(activeMushafPage);
                      }
                    }}
                    className={cn(
                      'px-3 py-1 rounded-xl text-[11px] font-bold border-2 transition-all cursor-pointer shadow-sm',
                      readingScope === 'page'
                        ? 'bg-[#4ADE80] text-[#0B1710] font-bold border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                        : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                    )}
                  >
                    Sahifa
                  </button>
                </div>

                {/* Регулятор размера арабского шрифта A- / 115% / A+ */}
                <div className="flex items-center gap-1 p-1 rounded-2xl bg-[#2A3441] border border-[#5E4D8C]">
                  <button
                    type="button"
                    onClick={() => handleFontScaleChange(fontScale - 0.1)}
                    disabled={fontScale <= 0.85}
                    title="Shriftni kichraytirish (A-)"
                    className="px-2.5 py-1 rounded-xl text-[11px] font-extrabold bg-[#242B35] hover:bg-[#2C3542] disabled:opacity-40 text-slate-100 border border-[#5E4D8C] transition-all cursor-pointer disabled:cursor-not-allowed shadow-sm"
                  >
                    A-
                  </button>
                  <span className="px-2 py-0.5 text-[11px] font-extrabold text-[#4ADE80] font-mono select-none">
                    {Math.round(fontScale * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => handleFontScaleChange(fontScale + 0.1)}
                    disabled={fontScale >= 1.65}
                    title="Shriftni kattalashtirish (A+)"
                    className="px-2.5 py-1 rounded-xl text-[11px] font-extrabold bg-[#242B35] hover:bg-[#2C3542] disabled:opacity-40 text-slate-100 border border-[#5E4D8C] transition-all cursor-pointer disabled:cursor-not-allowed shadow-sm"
                  >
                    A+
                  </button>
                </div>

                {/* Кнопка сброса красных ошибок («✕ Xatolarni tozalash») */}
                {hasVisualErrors && (
                  <button
                    type="button"
                    onClick={clearVisualErrors}
                    title="Barcha qizil xato belgilarini bir bosishda tozalash"
                    className="bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/40 rounded-lg px-3 py-1 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1 shadow-sm"
                  >
                    <span>✕ Xatolarni tozalash</span>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                {/* Переключатель вида (Matn / Rasm) только в режиме сахифы */}
                {isPageMode && (
                  <div className="flex items-center gap-2 bg-[#2A3441] border border-[#5E4D8C] rounded-xl p-1">
                    <button
                      type="button"
                      onClick={() => setPageViewMode('text')}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-[11px] font-bold border-2 flex items-center gap-1 transition-all cursor-pointer shadow-sm',
                        pageViewMode === 'text'
                          ? 'bg-[#4ADE80] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                          : 'bg-[#1E2530] text-slate-200 border-[#5E4D8C] hover:bg-[#323D4D]'
                      )}
                    >
                      <FileText className="w-3 h-3" />
                      <span>Matn</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPageViewMode('image')}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-[11px] font-bold border-2 flex items-center gap-1 transition-all cursor-pointer shadow-sm',
                        pageViewMode === 'image'
                          ? 'bg-[#4ADE80] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                          : 'bg-[#1E2530] text-slate-200 border-[#5E4D8C] hover:bg-[#323D4D]'
                      )}
                    >
                      <ImageIcon className="w-3 h-3" />
                      <span>Mus&apos;haf rasmi</span>
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={
                      isPageMode
                        ? () => handleLoadMushafPage(activeMushafPage - 1)
                        : isSingleWordMode
                        ? handlePrevWord
                        : handlePrevAyah
                    }
                    disabled={
                      isPageMode ? activeMushafPage <= 1 || isLoadingPage : false
                    }
                    title={
                      isPageMode
                        ? 'Oldingi sahifa'
                        : isSingleWordMode
                        ? "Oldingi so'z"
                        : 'Oldingi oyat'
                    }
                    className="w-8 h-8 rounded-xl bg-[#2A3441] hover:bg-[#323D4D] border border-[#5E4D8C] flex items-center justify-center text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-sm hover:border-[#5E4D8C]"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="px-3 py-1 rounded-xl bg-[#2A3441] border border-[#52437A] text-white font-bold shadow-sm">
                    {isPageMode
                      ? `Sahifa ${activeMushafPage} / 604`
                      : isSingleWordMode
                      ? `${selectedWord.wordIndex} / ${currentAyah.words.length}`
                      : `Oyat ${currentAyah.verseKey ?? currentAyah.number}`}
                  </span>
                  <button
                    type="button"
                    onClick={
                      isPageMode
                        ? () => handleLoadMushafPage(activeMushafPage + 1)
                        : isSingleWordMode
                        ? handleNextWord
                        : handleNextAyah
                    }
                    disabled={
                      isPageMode
                        ? activeMushafPage >= 604 || isLoadingPage
                        : false
                    }
                    title={
                      isPageMode
                        ? 'Keyingi sahifa'
                        : isSingleWordMode
                        ? "Keyingi so'z"
                        : 'Keyingi oyat'
                    }
                    className="w-8 h-8 rounded-xl bg-[#2A3441] hover:bg-[#323D4D] border border-[#5E4D8C] flex items-center justify-center text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-sm hover:border-[#5E4D8C]"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Панель управления режимом «Dars topshirish (Imtihon)» + плашка отката при ошибке */}
            {isExamMode && (
              <div className="rounded-2xl bg-[#242B35] border border-[#5E4D8C] p-3.5 space-y-3 text-left shadow-md text-slate-100">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setExamSubMode('memorized');
                        setIsExamTextRevealed(false);
                      }}
                      className={cn(
                        'px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border-2 shadow-sm',
                        examSubMode === 'memorized'
                          ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                          : 'bg-[#1E2530] text-slate-200 border-[#5E4D8C] hover:bg-[#323D4D]'
                      )}
                    >
                      🙈 Yoddan topshirish (Matn yashirin)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setExamSubMode('homework');
                        setIsExamTextRevealed(true);
                      }}
                      className={cn(
                        'px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border-2 shadow-sm',
                        examSubMode === 'homework'
                          ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                          : 'bg-[#1E2530] text-slate-200 border-[#5E4D8C] hover:bg-[#323D4D]'
                      )}
                    >
                      📖 Uyga vazifa (Ko&apos;rib topshirish)
                    </button>
                  </div>

                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-slate-300 font-semibold shrink-0">
                      Qayta o&apos;qish:
                    </span>
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setExamRollbackRule('current_ayah')}
                        className={cn(
                          'px-2.5 py-1.5 rounded-xl text-[11px] font-bold transition-all cursor-pointer border-2 shadow-sm',
                          examRollbackRule === 'current_ayah'
                            ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                            : 'bg-[#1E2530] text-slate-200 border-[#5E4D8C] hover:bg-[#323D4D]'
                        )}
                      >
                        Shu oyat boshidan
                      </button>
                      <button
                        type="button"
                        onClick={() => setExamRollbackRule('prev_ayah')}
                        className={cn(
                          'px-2.5 py-1.5 rounded-xl text-[11px] font-bold transition-all cursor-pointer border-2 shadow-sm',
                          examRollbackRule === 'prev_ayah'
                            ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                            : 'bg-[#1E2530] text-slate-200 border-[#5E4D8C] hover:bg-[#323D4D]'
                        )}
                      >
                        Oldingi oyatdan (-1 oyat)
                      </button>
                    </div>
                  </div>
                </div>

                {examMistakeBanner && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-rose-950/80 border-2 border-rose-500 text-rose-200 text-xs font-semibold">
                    <span>{examMistakeBanner}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (examRollbackTimerRef.current) {
                          clearTimeout(examRollbackTimerRef.current);
                          examRollbackTimerRef.current = null;
                        }
                        const curIdx = getCurrentAyahIndex();
                        if (examRollbackRule === 'prev_ayah' && curIdx > 0) {
                          const prevAyah = currentSurah.ayahs[curIdx - 1];
                          setSelectedAyahNumber(prevAyah.number);
                          if (prevAyah.verseKey) {
                            setSelectedAyahKey(prevAyah.verseKey);
                          }
                          if (prevAyah.words && prevAyah.words.length > 0) {
                            setSelectedWord(prevAyah.words[0]);
                          }
                        }
                        setIsExamTextRevealed(false);
                        setExamFailedWordId(null);
                        setAnalysisResult(null);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-[#4ADE80] hover:bg-[#38C96E] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] text-[11px] font-extrabold shrink-0 cursor-pointer transition-all shadow-sm"
                    >
                      {examRollbackRule === 'prev_ayah' && getCurrentAyahIndex() > 0
                        ? '↩️ Oldingi oyatga qaytib yoddan o‘qish'
                        : '🔄 Matnni yashirib qayta o‘qish'}
                    </button>
                  </div>
                )}

                {examSuccessBanner && (
                  <div className="flex items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-[#2A3441] border-2 border-[#4ADE80] text-white text-xs font-semibold">
                    <span>{examSuccessBanner}</span>
                    {getCurrentAyahIndex() < currentSurah.ayahs.length - 1 && (
                      <button
                        type="button"
                        onClick={handleNextAyah}
                        className="px-3 py-1.5 rounded-xl bg-[#4ADE80] hover:bg-[#38C96E] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] text-[11px] font-extrabold shrink-0 cursor-pointer transition-all shadow-sm"
                      >
                        Keyingi oyatni topshirish →
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Арабский текст: Жестко ограниченный контейнер области чтения без наезда на подпись и осциллограмму */}
            <div className="space-y-2.5 py-1 relative min-w-0 w-full max-w-full box-border">
              {isExamHiddenNow &&
                (analysisResult?.spokenWordsCount ?? 0) === 0 && (
                  <div className="mb-2 flex items-center justify-center pointer-events-none select-none">
                    <div className="px-4 py-1.5 rounded-xl bg-[#2A3441] border border-[#52437A] shadow-lg text-white text-xs font-bold flex items-center gap-2">
                      <span>🙈</span>
                      <span>
                        Yoddan o&apos;qing — aytilgan so&apos;zlar ovozingiz ortidan birma-bir ochiladi
                      </span>
                    </div>
                  </div>
                )}

              {/* Контейнер страницы и текста без внутренних полос прокрутки (куб растет вместе со страницей, жестко удерживая левую и правую границы!) */}
              <div className="h-auto min-w-0 w-full max-w-full overflow-x-hidden box-border rounded-2xl border border-[#5E4D8C] bg-[#161B22] shadow-2xl p-4 sm:p-5">
                  {isPageMode ? (
                    pageViewMode === 'image' ? (
                      /* Режим изображения страницы Мусхафа (целиком помещается в растущий куб без выхода за края карточки!) */
                      <div
                        className="h-auto w-full max-w-full overflow-x-hidden box-border mx-auto select-none"
                        style={{
                          maxWidth: `min(100%, ${Math.round(680 * fontScale)}px)`,
                          width: '100%',
                          height: 'auto',
                        }}
                      >
                        <img
                          src={`https://android.quran.com/data/width_1260/page${String(activeMushafPage).padStart(3, '0')}.png`}
                          alt={`Mus'haf sahifasi ${activeMushafPage}`}
                          className="max-w-full w-full h-auto block mx-auto object-contain select-none transition-all filter invert brightness-150 contrast-125 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                          loading="eager"
                        />
                      </div>
                    ) : (
                      /* Точная построчная копия страницы печатного Мусхафа (все 15 строк целиком с адаптивным переносом внутри рамки!) */
                      <div
                        dir="rtl"
                        className="font-arabic text-right select-text transition-all duration-200 h-auto min-w-0 w-full max-w-full overflow-x-hidden box-border mx-auto text-white space-y-1.5"
                        style={{
                          maxWidth: '100%',
                          fontSize: `clamp(18px, calc(${
                            currentSurah.ayahs.reduce(
                              (acc, a) => acc + a.words.length,
                              0
                            ) > 85
                              ? '1.35rem'
                              : currentSurah.ayahs.reduce(
                                  (acc, a) => acc + a.words.length,
                                  0
                                ) > 45
                              ? '1.5rem'
                              : '1.65rem'
                          } * ${fontScale}), 48px)`,
                          lineHeight: 2.1,
                        }}
                      >
                    {(() => {
                      type PageLineItem =
                        | {
                            kind: 'word';
                            word: QuranWord;
                            ayah: Ayah;
                            aIdx: number;
                          }
                        | {
                            kind: 'ayah_end';
                            ayah: Ayah;
                            aIdx: number;
                            ayahNumInSurah: string | number;
                          };

                      interface PageSurahBlock {
                        surahId: number;
                        startsAtAyahOne: boolean;
                        linesMap: Map<number, PageLineItem[]>;
                      }

                      const blocks: PageSurahBlock[] = [];
                      let fallbackLineCounter = 1;
                      let wordsInFallbackLine = 0;

                      currentSurah.ayahs.forEach((ayah, aIdx) => {
                        const sId = ayah.verseKey
                          ? Number(ayah.verseKey.split(':')[0]) || effectiveSurahId
                          : effectiveSurahId;
                        const ayahNumInSurah = ayah.verseKey
                          ? ayah.verseKey.split(':')[1] || ayah.number
                          : ayah.number;
                        const isAyahOne = Number(ayahNumInSurah) === 1;

                        let currentBlock = blocks[blocks.length - 1];
                        if (!currentBlock || currentBlock.surahId !== sId) {
                          currentBlock = {
                            surahId: sId,
                            startsAtAyahOne: isAyahOne,
                            linesMap: new Map<number, PageLineItem[]>(),
                          };
                          blocks.push(currentBlock);
                        }

                        let lastLineNum = fallbackLineCounter;

                        ayah.words.forEach((word) => {
                          let lineNum = word.lineNumber;
                          if (!lineNum || lineNum <= 0) {
                            if (wordsInFallbackLine >= 7) {
                              fallbackLineCounter += 1;
                              wordsInFallbackLine = 0;
                            }
                            lineNum = fallbackLineCounter;
                            wordsInFallbackLine += 1;
                          }
                          lastLineNum = lineNum;
                          const list = currentBlock.linesMap.get(lineNum) || [];
                          list.push({ kind: 'word', word, ayah, aIdx });
                          currentBlock.linesMap.set(lineNum, list);
                        });

                        const endList =
                          currentBlock.linesMap.get(lastLineNum) || [];
                        endList.push({
                          kind: 'ayah_end',
                          ayah,
                          aIdx,
                          ayahNumInSurah,
                        });
                        currentBlock.linesMap.set(lastLineNum, endList);
                      });

                      return blocks.map((block, bIdx) => {
                        const surahCat = ALL_114_SURAHS_CATALOG.find(
                          (c) => c.id === block.surahId
                        );
                        const sortedLines = Array.from(
                          block.linesMap.entries()
                        ).sort((a, b) => a[0] - b[0]);

                        return (
                          <div
                            key={`mushaf-surah-block-${block.surahId}-${bIdx}`}
                            className="space-y-1.5 w-full"
                          >
                            {/* Декоративная каноническая шапка суры и Басмала, если на странице начинается 1-й аят */}
                            {block.startsAtAyahOne && (
                              <div className="space-y-1.5 pb-1">
                                <div
                                  dir="rtl"
                                  className="w-full rounded-xl border-2 border-[#5E4D8C] bg-gradient-to-r from-[#1E2530] via-[#263142] to-[#1E2530] px-4 py-2 flex items-center justify-between shadow-md select-none"
                                >
                                  <span className="text-xs font-bold text-[#FBBF24] tracking-wider">
                                    سُورَة {block.surahId}
                                  </span>
                                  <span className="font-arabic text-2xl sm:text-3xl font-bold text-[#FBBF24] drop-shadow-sm">
                                    سُورَةُ{' '}
                                    {surahCat?.nameArabic ??
                                      currentSurah.nameArabic}
                                  </span>
                                  <span className="text-xs font-bold text-[#4ADE80]">
                                    {surahCat?.versesCount ??
                                      currentSurah.ayahs.length}{' '}
                                    آيَات
                                  </span>
                                </div>

                                {block.surahId !== 1 && block.surahId !== 9 && (
                                  <div
                                    dir="rtl"
                                    className="w-full text-center font-arabic text-2xl sm:text-3xl text-white py-1.5 border-b border-slate-800/60 select-none"
                                  >
                                    بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Строки страницы Мусхафа (до 15 канонических строк сверху вниз с защитой flex-wrap от выхода за рамку) */}
                            {sortedLines.map(([lineNum, items]) => (
                              <div
                                key={`mushaf-line-${block.surahId}-${lineNum}`}
                                dir="rtl"
                                className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 w-full max-w-full box-border border-b border-slate-800/40 py-0.5 leading-[2.1]"
                              >
                                {items.map((item, iIdx) => {
                                  if (item.kind === 'word') {
                                    const { word, ayah, aIdx } = item;
                                    const hasMistake = mistakeWordIds.has(
                                      word.id
                                    );
                                    const isSelected =
                                      selectedWord.id === word.id;
                                    const isHighlighted =
                                      activeHighlightedWordId === word.id;
                                    const ayahNumeric =
                                      getAyahDisplayNumber(ayah);
                                    const isInPageRange =
                                      ayahNumeric >= pageStartAyah &&
                                      ayahNumeric <= pageEndAyah;
                                    const isCustomRangeActive =
                                      pageStartAyah !== firstPageAyahNumber ||
                                      pageEndAyah !== lastPageAyahNumber;
                                    const isCurrentAyahActive =
                                      currentAyah.number === ayah.number &&
                                      currentAyah.verseKey === ayah.verseKey;
                                    const isCurrentlyPlayingThisAyah =
                                      playingPageAyahIndex === aIdx;
                                    const isWordPlayingNow =
                                      playingAudioId === word.id ||
                                      isAudioBufferingId === word.id;

                                    return (
                                      <span
                                        key={`${word.id}-${iIdx}`}
                                        id={`page-word-${word.id}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleWordClick(word);
                                          if (hasMistake) {
                                            scrollToMistakeInPanel(word.id);
                                          }
                                        }}
                                        className={cn(
                                          'relative inline-flex items-center gap-0.5 px-1 py-0.5 rounded-lg cursor-pointer transition-all duration-200 max-w-full whitespace-nowrap',
                                          isHighlighted
                                            ? 'bg-[#4ADE80]/40 text-white ring-2 ring-[#4ADE80]'
                                            : isSelected
                                            ? 'bg-[#4ADE80]/25 text-[#4ADE80] font-bold'
                                            : isCurrentlyPlayingThisAyah
                                            ? 'bg-[#4ADE80]/25 text-white ring-1 ring-[#4ADE80]'
                                            : isCustomRangeActive && isInPageRange
                                            ? 'bg-[#4ADE80]/10 ring-1 ring-[#4ADE80]/40 rounded-lg'
                                            : isCurrentAyahActive
                                            ? 'bg-[#4ADE80]/10 ring-1 ring-[#4ADE80]/30 rounded-lg'
                                            : 'hover:text-[#4ADE80]'
                                        )}
                                        title={
                                          hasMistake
                                            ? `Xato: ${word.textUthmani} (O'ng paneldan ko'rish uchun bosing)`
                                            : word.transliteration
                                        }
                                      >
                                        {isWordPlayingNow && (
                                          <Volume2 className="w-3.5 h-3.5 text-[#4ADE80] animate-pulse shrink-0" />
                                        )}
                                        {renderWordLetterClusters(word, {
                                          textSize: 'regular',
                                        })}
                                        {hasMistake && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              clearVisualErrors();
                                            }}
                                            title="Xato belgisini tozalash (✕)"
                                            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-500/30 hover:bg-rose-500 text-rose-200 hover:text-white border border-rose-400/60 text-[9px] font-sans font-extrabold leading-none shrink-0 transition-all cursor-pointer"
                                          >
                                            ✕
                                          </button>
                                        )}
                                      </span>
                                    );
                                  }

                                  const { ayah, aIdx, ayahNumInSurah } = item;
                                  const ayahKey =
                                    ayah.verseKey ?? `ayah-${ayah.number}`;
                                  const hasAyahMistake =
                                    mistakeAyahKeys.has(ayahKey);
                                  const isCurrentAyahActive =
                                    currentAyah.number === ayah.number &&
                                    currentAyah.verseKey === ayah.verseKey;
                                  const isCurrentlyPlayingThisAyah =
                                    playingPageAyahIndex === aIdx;
                                  const numericAyah =
                                    Number(ayahNumInSurah) || ayah.number;
                                  const isStartMedallion =
                                    numericAyah === pageStartAyah;
                                  const isEndMedallion =
                                    numericAyah === pageEndAyah;

                                  return (
                                    <span
                                      key={`ayah-end-${ayahKey}-${aIdx}-${iIdx}`}
                                      onClick={() => {
                                        handleOyatlarButtonClick(ayah);
                                        if (hasAyahMistake) {
                                          const firstErrWord = ayah.words.find(
                                            (w) => mistakeWordIds.has(w.id)
                                          );
                                          if (firstErrWord) {
                                            scrollToMistakeInPanel(
                                              firstErrWord.id
                                            );
                                          }
                                        }
                                      }}
                                      className={cn(
                                        'text-[#FBBF24] bg-[#4ADE80]/15 border border-[#4ADE80]/50 rounded-full px-2 py-0.2 mx-1 inline-flex items-center justify-center gap-1 font-bold shadow-sm select-none font-arabic text-base sm:text-lg cursor-pointer transition-all shrink-0',
                                        hasAyahMistake &&
                                          'text-rose-300 bg-rose-500/25 border-rose-500/70 ring-1 ring-rose-500/50',
                                        isCurrentlyPlayingThisAyah &&
                                          'bg-[#4ADE80]/35 border-[#4ADE80] ring-2 ring-[#4ADE80] text-white',
                                        (isStartMedallion || isEndMedallion) &&
                                          !hasAyahMistake &&
                                          'bg-[#4ADE80]/25 border-[#4ADE80] ring-2 ring-[#4ADE80] text-white',
                                        isCurrentAyahActive &&
                                          !hasAyahMistake &&
                                          'border-[#4ADE80] ring-1 ring-[#4ADE80]/60'
                                      )}
                                      title={`Oyat ${
                                        ayah.verseKey ?? ayah.number
                                      } — Oraliqni tanlash uchun bosing (▶️ Boshlanishi / ⏹️ Tugashi)${
                                        hasAyahMistake
                                          ? ' • Xato aniqlangan'
                                          : ''
                                      }`}
                                    >
                                      {isStartMedallion && (
                                        <span className="text-[10px] font-sans leading-none">
                                          ▶️
                                        </span>
                                      )}
                                      <span>{`﴿${toArabicDigits(ayahNumInSurah)}﴾`}</span>
                                      {isEndMedallion && (
                                        <span className="text-[10px] font-sans leading-none">
                                          ⏹️
                                        </span>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        );
                      });
                    })()}
                  </div>
                )
              ) : isSingleWordMode ? (
                /* Режим отдельного слова: Точечный рендеринг */
                <div
                  dir="rtl"
                  id={`center-word-${selectedWord.id}`}
                  onClick={() => {
                    handleWordClick(selectedWord);
                    if (mistakeWordIds.has(selectedWord.id)) {
                      scrollToMistakeInPanel(selectedWord.id);
                    }
                  }}
                  className={cn(
                    'relative inline-flex flex-wrap items-center justify-center gap-3 font-arabic text-white leading-normal select-none py-2 transition-all cursor-pointer max-w-full box-border',
                    isExamHiddenNow && 'blur-xl select-none opacity-20',
                    activeHighlightedWordId === selectedWord.id && 'ring-4 ring-[#4ADE80]/80 rounded-3xl px-6 bg-[#4ADE80]/20 text-white'
                  )}
                  style={{
                    fontSize: `clamp(32px, calc(4.8rem * ${fontScale}), 96px)`,
                  }}
                >
                  {(playingAudioId === selectedWord.id ||
                    playingAudioId === 'main_stage_reference' ||
                    isAudioBufferingId === selectedWord.id ||
                    isAudioBufferingId === 'main_stage_reference') && (
                    <Volume2 className="w-7 h-7 text-[#4ADE80] animate-pulse shrink-0" />
                  )}
                  {renderWordLetterClusters(selectedWord, { textSize: 'giant' })}
                  {hasVisualErrors && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        clearVisualErrors();
                      }}
                      title="Xato belgisini tozalash (✕)"
                      className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-rose-500/25 hover:bg-rose-500 text-rose-200 hover:text-white border border-rose-400/60 text-xs font-sans font-extrabold leading-none shrink-0 transition-all cursor-pointer"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ) : (
                /* Режим целого аята и экзамена */
                <div
                  dir="rtl"
                  className={cn(
                    'font-arabic text-white select-none flex flex-wrap items-center justify-between gap-x-2 gap-y-2 w-full max-w-full overflow-x-hidden box-border rounded-2xl',
                    currentAyah.words.length <= 8
                      ? 'leading-relaxed justify-center gap-x-3.5 gap-y-2.5 py-2'
                      : currentAyah.words.length <= 20
                      ? 'leading-snug justify-center gap-x-2.5 gap-y-2 py-1.5'
                      : currentAyah.words.length <= 40
                      ? 'leading-snug gap-x-2 gap-y-1.5 py-1'
                      : 'leading-normal gap-1.5 p-3 bg-[#181F2A] border border-[#5E4D8C]'
                  )}
                  style={{
                    fontSize: `clamp(18px, calc(${
                      currentAyah.words.length <= 8
                        ? '2.1rem'
                        : currentAyah.words.length <= 20
                        ? '1.75rem'
                        : currentAyah.words.length <= 40
                        ? '1.5rem'
                        : '1.35rem'
                    } * ${fontScale}), 48px)`,
                  }}
                >
                  {currentAyah.words.map((word, wIdx) => {
                    const hasMistake = !isRecording && mistakeWordIds.has(word.id);
                    const isExamFailedWord =
                      isExamMode && examFailedWordId === word.id;
                    const examFailedWordIdx = examFailedWordId
                      ? currentAyah.words.findIndex(
                          (w) => w.id === examFailedWordId
                        )
                      : -1;
                    const isUnreadTailAfterExamFail =
                      isExamMode &&
                      examFailedWordIdx >= 0 &&
                      wIdx > examFailedWordIdx;

                    const liveSpokenCount = isRecording
                      ? (analysisResult?.failedWordIndex !== null && analysisResult?.failedWordIndex !== undefined && analysisResult.failedWordIndex >= 0)
                        ? analysisResult.failedWordIndex + 1
                        : analysisResult?.spokenWordsCount ?? 0
                      : isExamTextRevealed
                      ? currentAyah.words.length
                      : 0;
                    const isWordHiddenInMemorizedExam =
                      isExamMode &&
                      examSubMode === 'memorized' &&
                      !isExamTextRevealed &&
                      wIdx >= liveSpokenCount;

                    const isSelected = selectedWord.id === word.id;
                    const isHighlighted =
                      activeHighlightedWordId === word.id;
                    const activeLiveWordIdx = Math.max(
                      0,
                      Math.min(
                        currentAyah.words.length - 1,
                        (analysisResult?.spokenWordsCount ?? 1) - 1
                      )
                    );
                    const isLiveActiveCursor =
                      isRecording && wIdx === activeLiveWordIdx;
                    const isWordPlayingNow =
                      playingAudioId === word.id ||
                      isAudioBufferingId === word.id;

                    return (
                      <span
                        key={word.id}
                        id={`center-word-${word.id}`}
                        onClick={() => {
                          handleWordClick(word);
                          if (hasMistake) {
                            scrollToMistakeInPanel(word.id);
                          }
                        }}
                        className={cn(
                          'inline-flex items-center gap-1 cursor-pointer rounded-xl px-2 py-1 transition-all duration-200 max-w-full whitespace-nowrap',
                          isWordHiddenInMemorizedExam
                            ? 'blur-lg select-none opacity-20 pointer-events-none'
                            : 'blur-0 opacity-100',
                          isUnreadTailAfterExamFail && 'opacity-35 blur-sm select-none pointer-events-none',
                          isExamFailedWord
                            ? 'border-2 border-rose-500 bg-rose-500/30 text-rose-200 ring-2 ring-rose-500 animate-pulse'
                            : isHighlighted
                            ? 'bg-[#4ADE80]/30 text-white ring-2 ring-[#4ADE80]'
                            : isLiveActiveCursor
                            ? 'bg-[#2A3441] text-white ring-2 ring-[#4ADE80]'
                            : isSelected
                            ? 'bg-[#4ADE80]/25 text-[#4ADE80] font-bold'
                            : 'hover:text-[#4ADE80]'
                        )}
                        title={
                          hasMistake || isExamFailedWord
                            ? `Xato: ${word.textUthmani} (O'ng paneldan ko'rish uchun bosing)`
                            : word.transliteration
                        }
                      >
                        {isWordPlayingNow && (
                          <Volume2 className="w-4 h-4 text-[#4ADE80] animate-pulse shrink-0" />
                        )}
                        {renderWordLetterClusters(word, {
                          textSize:
                            currentAyah.words.length > 20 ? 'regular' : 'large',
                        })}
                        {(hasMistake || isExamFailedWord) && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              clearVisualErrors();
                            }}
                            title="Xato belgisini tozalash (✕)"
                            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-500/30 hover:bg-rose-500 text-rose-200 hover:text-white border border-rose-400/60 text-[10px] font-sans font-extrabold leading-none shrink-0 transition-all cursor-pointer"
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    );
                  })}
                  <span
                    onClick={() => {
                      if (!isExamReferenceLocked) {
                        playAudioUrl(
                          currentSheikhAyahUrl,
                          'main_stage_reference'
                        );
                      }
                    }}
                    className={cn(
                      'text-[#FBBF24] bg-[#4ADE80]/15 border border-[#4ADE80]/50 rounded-full px-2 py-0.2 mx-1 inline-flex items-center justify-center gap-1 font-bold shadow-sm select-none font-arabic text-2xl sm:text-3xl shrink-0 cursor-pointer transition-all hover:bg-[#4ADE80]/25',
                      isExamHiddenNow && 'blur-lg select-none opacity-20',
                      (playingAudioId === 'main_stage_reference' ||
                        isAudioBufferingId === 'main_stage_reference') &&
                        'ring-2 ring-[#4ADE80] bg-[#4ADE80]/30'
                    )}
                    title={`Oyat ${currentAyah.verseKey ?? currentAyah.number} — Oyatni eshitish uchun bosing`}
                  >
                    {(playingAudioId === 'main_stage_reference' ||
                      isAudioBufferingId === 'main_stage_reference') && (
                      <Volume2 className="w-4 h-4 text-[#4ADE80] animate-pulse shrink-0" />
                    )}
                    {`﴿${toArabicDigits(
                      currentAyah.verseKey
                        ? currentAyah.verseKey.split(':')[1] ||
                            currentAyah.number
                        : currentAyah.number
                    )}﴾`}
                  </span>
                </div>
              )}
              </div>

              {isPageMode &&
                pageViewMode === 'image' &&
                mistakeEvaluations.length > 0 && (
                  <div className="flex items-center justify-between gap-2 px-4 py-2 rounded-xl bg-rose-950/80 border border-rose-500/50 text-rose-300 text-xs w-full max-w-xl mx-auto">
                    <span className="font-medium">
                      ⚠️ Sahifada {mistakeEvaluations.length} ta xato aniqlandi
                    </span>
                    <button
                      type="button"
                      onClick={() => setPageViewMode('text')}
                      className="font-semibold text-rose-200 underline hover:text-white cursor-pointer"
                    >
                      Matnda ko&apos;rish va tuzatish →
                    </button>
                  </div>
                )}

              <p
                className={cn(
                  'font-medium text-slate-300 tracking-wide pt-1',
                  isExamHiddenNow && 'blur-md select-none opacity-20',
                  !isSingleWordMode && currentAyah.words.length > 16
                    ? 'text-xs sm:text-sm line-clamp-2'
                    : 'text-sm sm:text-base'
                )}
              >
                {isPageMode
                  ? `${currentSurahNameUz} — Sahifada ${currentSurah.ayahs.length} ta oyat mavjud`
                  : isSingleWordMode
                  ? selectedWord.transliteration
                  : currentAyah.words.map((w) => w.transliteration).join(' • ')}
              </p>
            </div>

            {/* Блок правил: E'tibor berish kerak bo'lgan qoidalar */}
            {pageViewMode !== 'image' && !isExamMode && (
              <div className="text-left rounded-2xl bg-[#242B35] border border-[#5E4D8C] p-4 sm:p-5 space-y-2 shadow-sm text-slate-100">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200 block">
                  E&apos;tibor berish kerak bo&apos;lgan qoidalar:
                </span>
                <ul className="space-y-1.5 text-xs sm:text-sm text-slate-300 leading-relaxed">
                  {activeCheckPoints.slice(0, 4).map((cp, idx) => (
                    <li key={cp.id}>{formatSimpleCheckPointTipUz(cp, idx)}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* ======================================================================== */}
            {/* ЗАКРЕПЛЕННАЯ НИЖНЯЯ ПАНЕЛЬ УПРАВЛЕНИЯ И АУДИО-ВОЛНЫ (Sticky Control Dock) */}
            {/* ======================================================================== */}
            <div className="sticky bottom-0 z-30 mt-3 pt-2.5 pb-3 px-4 bg-[#1B2028]/95 backdrop-blur-md border-t border-[#5E4D8C] rounded-b-2xl shadow-[0_-10px_30px_rgba(0,0,0,0.65)] space-y-2.5">
              {/* 1. Компактная двойная визуализация звука (Эталон Шейха + Живой голос) */}
              <DualWaveformVisualizer
                referenceAudioUrl={activeReferenceUrl}
                referenceAudioUrls={activeWaveformUrls}
                referenceLabel={activeWaveformLabel}
                compact
                isRecording={isRecording}
                userAudioBuffer={userRecordingBuffer}
                userSampleRate={16000}
                userAudioUrl={userRecordingUrl}
              />

              {/* 2. Компактный переключатель голоса из 10 шейхов + бейдж консенсуса */}
              <div className="rounded-xl bg-[#242B35] border border-[#5E4D8C] p-2.5 shadow-sm text-slate-100">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <Volume2 className="w-3.5 h-3.5 text-[#4ADE80] shrink-0" />
                    <span className="text-xs font-bold text-white shrink-0">
                      Namuna ovozi (10 qori):
                    </span>
                    <select
                      value={selectedSheikhId}
                      onChange={(e) =>
                        handleSheikhChange(e.target.value as SheikhId)
                      }
                      aria-label="Namuna uchun shayx ovozi"
                      className="text-xs font-bold px-2.5 py-1 rounded-lg bg-[#1E2530] text-white border border-[#52437A] hover:border-[#4ADE80] focus:outline-none focus:border-[#4ADE80] cursor-pointer truncate max-w-full sm:max-w-[240px]"
                    >
                      {TEN_SHEIKHS_CATALOG.map((sh, idx) => (
                        <option
                          key={sh.id}
                          value={sh.id}
                          className="bg-[#1E2530] text-white"
                        >
                          {idx + 1}. {sh.nameUz}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="hidden md:inline-block px-2 py-0.5 rounded-lg bg-[#1E2530] border border-[#52437A]/80 text-slate-300 text-[10px] font-semibold">
                      10 qori tajvid konsensusi • Individual tahlil
                    </span>
                    {isSingleWordMode && (
                      <button
                        type="button"
                        disabled={isExamReferenceLocked}
                        onClick={() => {
                          if (isExamReferenceLocked) return;
                          playAudioUrl(
                            currentSheikhAyahUrl,
                            'sheikh_full_ayah_preview'
                          );
                        }}
                        className={cn(
                          'px-2.5 py-1 rounded-lg text-[11px] font-bold border flex items-center gap-1 transition-all cursor-pointer shrink-0 shadow-sm disabled:opacity-45 disabled:cursor-not-allowed',
                          playingAudioId === 'sheikh_full_ayah_preview'
                            ? 'bg-[#4ADE80] text-[#0B1710] border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
                            : 'bg-[#1E2530] hover:bg-[#323D4D] text-white border-[#5E4D8C]'
                        )}
                        title={
                          isExamReferenceLocked
                            ? "Imtihon rejimida namuna eshitish bloklangan"
                            : "Tanlangan shayx ovozida oyatni to'liq eshitish"
                        }
                      >
                        <Volume2 className="w-3.5 h-3.5 shrink-0" />
                        <span>🔊 Oyatni shayx ovozida eshitish</span>
                      </button>
                    )}
                    <span className="px-2.5 py-0.5 rounded-lg bg-[#1E2530] border border-[#52437A] text-[#4ADE80] text-[11px] font-bold shrink-0">
                      Qiyinlik: {strictnessLevel}%
                    </span>
                  </div>
                </div>
              </div>

              {/* 3. Панель с кнопками записи и прослушивания эталона */}
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={isExamReferenceLocked}
                  onClick={() => {
                    if (isExamReferenceLocked) return;
                    if (isPageMode) {
                      playPageAyahsSequential(currentSurah.ayahs);
                    } else {
                      playAudioUrl(activeReferenceUrl, 'main_stage_reference');
                    }
                  }}
                  title={
                    isExamReferenceLocked
                      ? "Imtihon rejimida namuna eshitish bloklangan"
                      : undefined
                  }
                  className={cn(
                    'w-full sm:w-auto px-5 py-3 rounded-2xl text-xs sm:text-sm font-bold border-2 flex items-center justify-center gap-2 transition-all shadow-md cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed',
                    playingAudioId === 'main_stage_page_reference' ||
                      playingAudioId === 'main_stage_reference' ||
                      playingAudioId === selectedWord.id
                      ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-md font-extrabold'
                      : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C]'
                  )}
                >
                  <Volume2
                    className={cn(
                      'w-4 h-4 text-[#4ADE80] shrink-0',
                      (playingAudioId !== null || isAudioBufferingId !== null) &&
                        'animate-pulse'
                    )}
                  />
                  <span>
                    {isExamReferenceLocked
                      ? '🔒 Imtihon vaqtida namuna yopiq'
                      : isPageMode
                      ? playingAudioId === 'main_stage_page_reference'
                        ? `⏹️ Oyat ${
                            playingQueueInfo?.currentPlayingAyah ?? pageStartAyah
                          } o'qilmoqda (${
                            (playingQueueInfo?.currentIndex ?? 0) + 1
                          }/${playingQueueInfo?.queueLength ?? 1})...`
                        : pageStartAyah === firstPageAyahNumber &&
                          pageEndAyah === lastPageAyahNumber
                        ? `🔊 Sahifani to'liq eshitish (${referencePlaybackRate}x)`
                        : `🔊 Oyat ${pageStartAyah}–${pageEndAyah} eshitish (${referencePlaybackRate}x)`
                      : isSingleWordMode
                      ? playingAudioId === 'main_stage_reference' ||
                        playingAudioId === selectedWord.id
                        ? `So'z o'qilmoqda (${referencePlaybackRate}x)...`
                        : `🔊 Namuna eshitish (${referencePlaybackRate}x)`
                      : playingAudioId === 'main_stage_reference'
                      ? `Oyat o'qilmoqda (${referencePlaybackRate}x)...`
                      : `🔊 Oyatni eshitish (${referencePlaybackRate}x)`}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleRecording}
                  disabled={isAnalyzing}
                  className={cn(
                    'w-full sm:w-auto min-w-[230px] px-7 py-3 rounded-2xl text-xs sm:text-sm font-extrabold border-2 flex items-center justify-center gap-2 transition-all shadow-xl cursor-pointer disabled:opacity-60',
                    isRecording
                      ? 'bg-rose-600 hover:bg-rose-500 text-white border-[#5E4D8C] ring-4 ring-rose-500/30 animate-pulse'
                      : 'bg-[#4ADE80] hover:bg-[#38C96E] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] shadow-xl shadow-[#4ADE80]/30'
                  )}
                >
                  {isRecording ? (
                    <>
                      <Square className="w-4 h-4 fill-current shrink-0" />
                      <span>To&apos;xtatish</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4 shrink-0" />
                      <span>🎙️ O&apos;qish uchun bosing</span>
                    </>
                  )}
                </button>
              </div>

              {/* Подсказка горячих клавиш клавиатуры */}
              <p className="text-[11px] text-slate-300 font-medium select-none">
                Klaviatura: <span className="text-[#4ADE80] font-bold">[Probel]</span> — Yozish/To&apos;xtatish •{' '}
                <span className="text-[#4ADE80] font-bold">[←/→]</span> —{' '}
                {isPageMode
                  ? 'Oldingi/Keyingi sahifa'
                  : isSingleWordMode
                  ? "Oldingi/Keyingi so'z"
                  : 'Oldingi/Keyingi oyat'}{' '}
                • <span className="text-[#4ADE80] font-bold">[N]</span> —{' '}
                {isPageMode ? "Sahifani to'liq eshitish" : 'Namuna'}
              </p>

              {/* Индикатор уровня микрофона во время записи */}
              {isRecording && (
                <div className="max-w-md mx-auto pt-0.5 space-y-1.5">
                  <div className="rounded-xl bg-[#1E2631] border border-[#5E4D8C] px-3 py-1.5 space-y-1">
                    <div className="flex items-center justify-between text-xs font-medium">
                      <span className="text-white">
                        Ovoz darajasi:{' '}
                        <strong className="text-[#4ADE80]">
                          {liveLevelPercent}% ({liveDb} dB)
                        </strong>
                      </span>
                      <span className="font-mono text-[#4ADE80] font-bold">
                        {(recordingDurationMs / 1000).toFixed(1)} s
                      </span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-[#1E2530] overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-75',
                          liveLevelPercent > 15
                            ? 'bg-emerald-400'
                            : 'bg-[#4ADE80]'
                        )}
                        style={{ width: `${Math.max(4, liveLevelPercent)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {micError && (
                <p className="text-xs text-rose-200 bg-rose-950/80 border-2 border-rose-500 rounded-xl p-2.5 max-w-md mx-auto">
                  {micError}
                </p>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* ============================================================================ */}
      {/* 3. ПРАВАЯ ПАНЕЛЬ АНАЛИТИКИ (Tilovat tahlili)                                 */}
      {/* ============================================================================ */}
      <aside className="w-[320px] sm:w-[340px] shrink-0 h-full bg-[#1B2028] border border-[#52437A] rounded-2xl overflow-y-auto p-4 flex flex-col shadow-xl text-slate-100">
        <div className="flex items-center justify-between pb-3 mb-4 border-b-2 border-[#52437A]/50">
          <h2 className="text-xs sm:text-sm font-extrabold text-slate-100 flex items-center gap-2 uppercase tracking-wider">
            <Sparkles className="w-4 h-4 text-slate-300 shrink-0" />
            <span>Tilovat tahlili</span>
          </h2>
          {analysisResult && (
            <span
              className={cn(
                'text-xs font-extrabold px-2.5 py-0.5 rounded-full border-2',
                analysisResult.overallScore >= 80
                  ? 'bg-emerald-600 text-white border-[#5E4D8C]'
                  : analysisResult.overallScore >= 62
                  ? 'bg-[#4ADE80] text-[#0B1710] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                  : 'bg-rose-600 text-white border-rose-800'
              )}
            >
              {!analysisResult.isLivePreview &&
              (!analysisResult.transcribedArabic ||
                !analysisResult.transcribedArabic.trim())
                ? 0
                : analysisResult.overallScore}
              %
            </span>
          )}
        </div>

        {/* Состояние 1: ИИ анализирует аудио, но живого превью еще нет */}
        {isAnalyzing && analysisResult === null && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 rounded-2xl bg-[#242B35] border border-[#5E4D8C] space-y-4 text-slate-100">
            <div className="w-12 h-12 rounded-2xl bg-[#4ADE80] border border-[#52437A] flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-[#0B1710] animate-spin" />
            </div>
            <p className="text-xs sm:text-sm font-semibold text-slate-100 animate-pulse leading-relaxed">
              AI audioni tahlil qilmoqda va tajvidni tekshirmoqda...
            </p>
          </div>
        )}

        {/* Состояние 2: Заглушка (analysisResult === null && !isAnalyzing) */}
        {!isAnalyzing && analysisResult === null && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 rounded-2xl bg-[#242B35] border border-dashed border-[#5E4D8C] space-y-3 text-slate-100">
            <div className="w-12 h-12 rounded-2xl bg-[#1E2631] border border-[#5E4D8C] flex items-center justify-center text-[#4ADE80] shadow-md">
              <Mic className="w-5 h-5 text-slate-300" />
            </div>
            <p className="text-xs sm:text-sm font-semibold text-slate-100 leading-relaxed">
              {isRecording
                ? "O'qishni davom ettiring — jonli tahlil shu zahoti chiqadi..."
                : "Tahlil olish uchun so'zni o'qing"}
            </p>
          </div>
        )}

        {/* Состояние 3: Анализ */}
        {analysisResult !== null && (
          <div className="space-y-3">
            {isAnalyzing && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#1E2631] border border-[#5E4D8C] text-xs font-semibold text-slate-100">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-slate-300" />
                <span>Yakuniy so&apos;z aniqlashtirilmoqda...</span>
              </div>
            )}
            <AcousticFeedbackPanel
              result={analysisResult}
              targetTitle={activeTargetTitle}
              targetUthmani={activeTargetUthmani}
              expectedPhonemes={activeExpectedPhonemes}
              checkPoints={activeCheckPoints}
              referenceAudioUrl={activeReferenceUrl}
              onPlayReferenceAudio={playAudioUrl}
              playingReferenceId={playingAudioId}
              playbackRate={referencePlaybackRate}
              highlightedCheckPointId={activeHighlightedMistakeId}
              onSelectMistakeCard={handleSelectMistakeFromPanel}
              strictnessLevel={strictnessLevel}
              onPracticeMistake={handlePracticeMistake}
              onClearErrors={clearVisualErrors}
            />
          </div>
        )}
      </aside>
    </div>
  );
}
