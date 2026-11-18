'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  CheckPointEvaluation,
  PhonemeCheckPoint,
  RecitationAnalysisResult,
  TajweedRuleType,
} from '@/types/quran';
import {
  encodeWavBlob,
  playAudioSlice,
  playReferenceAudioSlice,
  stopActiveAudioPlayback,
} from '@/lib/audioUtils';
import { cn } from '@/lib/utils';
import {
  CheckCircle2,
  AlertTriangle,
  Play,
  Volume2,
  ChevronDown,
  ChevronUp,
  BarChart3,
  Mic,
} from 'lucide-react';

const RULE_NAME_UZ: Record<TajweedRuleType, string> = {
  madd_2: 'Madd Tabiiy (2 harakat • 1.6–2.8)',
  madd_4: 'Madd Wajib / Munfasil (4–5 harakat • 3.3–5.5)',
  madd_6: 'Madd Lazim (6 harakat • 4.8–6.8)',
  ghunnah: "G'unna (Dimog'da 2 harakat ushlash)",
  qalqalah: 'Qalqala (Tebranish)',
  tafkhim: "Tafxim (Yo'g'on o'qish)",
  ithhar: 'Izhor (Aniq talaffuz)',
  idgham: "Idg'om (Kirishish)",
  ikhfa: 'Ixfo (Yashirish)',
  makhraj_critical: 'Maxraj (Harf chiqish joyi)',
  harakat: 'Harakat (Fatha / Kasra / Damma)',
  tashdid: 'Tashdid (Ikkilantirish)',
};

// Анатомические инструкции для Махраджа букв на узбекском языке
const MAKHRAJ_ANATOMICAL_TIPS_UZ: Record<string, string> = {
  'ق': "Til ildizini (orqasini) yumshoq tanglayga tekkizib, chuqur va yo'g'on talaffuz qiling (oddiy «ك» kabi oldinga surmang).",
  'ك': "Til orqasini qattiq tanglayga yaqinlashtirib, nafas oqimi (hams) bilan yumshoq chiqaring.",
  'ط': "Til uchini oldingi yuqori tishlar tubiga qo'yib, til o'rtasini tanglayga ko'tarib yo'g'on o'qing (oddiy «ت» bo'lib qolmasin).",
  'ت': "Til uchini yuqori tishlar tubiga tekkizib, yengil nafas bilan yumshoq chiqaring.",
  'ص': "Til uchini pastki tishlar orqasiga qo'yib, til orqasini ko'targan holda yo'g'on hushtak bilan chiqaring (oddiy «س» emas).",
  'س': "Til uchini pastki oldingi tishlar orqasiga qo'yib, ingichka va mayin hushtak bilan talaffuz qiling.",
  'ض': "Tilning yon qirrasini yuqori oziq tishlarga yopishtirib, cho'ziqroq va yo'g'on ovozda chiqaring (oddiy «د» yoki «ز» emas).",
  'ظ': "Til uchini oldingi yuqori tishlar qirrasidan biroz chiqarib, yo'g'on holda o'qing (hushtak chiqarmang).",
  'ذ': "Til uchini oldingi yuqori tishlar chetidan biroz chiqarib, mayin va hushtaksiz o'qing (oddiy «ز» emas).",
  'ث': "Til uchini oldingi tishlar orasiga qo'yib, havoni erkin chiqarib mayin ayting (oddiy «س» kabi hushtak chalmang).",
  'خ': "Halqumning yuqori qismidan (tilcha yonidan) xirillagan yo'g'on tovush bilan chiqaring.",
  'غ': "Halqumning yuqori qismidan tomoqni qirmasdan, yo'g'on va g'uldiragan ohangda chiqaring.",
  'ح': "Tomoq o'rtasini (halqum) biroz qisib, toza va issiq havo oqimi bilan talaffuz qiling (oddiy «ه» emas).",
  'ع': "Halqum (tomoq) o'rtasini qattiqroq siqib, chuqur va bo'g'iq ovoz bilan chiqaring (oddiy «А» yoki hamza emas).",
  'ه': "Tomoqning eng tubidan (ko'krakka yaqin) erkin nafas chiqarish orqali o'qing.",
  'ء': "Ovoz pardalarini bir lahzaga to'liq yopib ochish orqali aniq hamza bilan talaffuz qiling.",
  'ج': "Til o'rtasini qattiq tanglayga to'liq yopishtirib, qattiq va jarangdor chiqaring.",
  'ش': "Til o'rtasini tanglayga yaqinlashtirib, og'iz bo'shlig'iga havoni yoyib (tafashshiy) chiqaring.",
  'ي': "Til o'rtasini tanglayga ko'tarib, havoni qismasdan ravon chiqaring.",
  'ر': "Til uchining orqa qismini tanglayga 1-2 marta yengil urib chiqaring (ko'p qaltiramang).",
  'ل': "Til uchining ikki yonini oldingi tanglayga tekkizib, ravshan va mayin ayting.",
  'ن': "Til uchini yuqori tishlar milkiga qo'yib, ovozni dimog'dan (g'unna bilan) chiqaring.",
  'م': "Ikkala labni bir-biriga yengil yopib, ovozning bir qismini dimog'dan chiqaring.",
  'ب': "Ikkala labning nam qismini qattiqroq jipslashtirib, keskin va jarangdor oching.",
  'ف': "Oldingi yuqori tishlar uchini pastki labning ichki qismiga qo'yib, havo bilan chiqaring.",
  'و': "Ikkala labni oldinga cho'chchaytirib doira qilib, lablarni bir-biriga tekkizmasdan chiqaring.",
};

function getClearMistakeExplanationUz(ev: CheckPointEvaluation): string {
  if (ev.score === 0) {
    return "Ovoz aniqlanmadi. Mikrofonga yaqinroq va balandroq o'qing.";
  }

  // Если с бэкенда или DSP уже пришло детальное узбекское объяснение с харакатами, формантами или анатомической подсказкой
  if (
    ev.feedbackRu &&
    (ev.feedbackRu.includes('harakat') ||
      ev.feedbackRu.includes('amalda') ||
      ev.feedbackRu.includes('Hz') ||
      ev.feedbackRu.includes('Til') ||
      ev.feedbackRu.includes('Halqum') ||
      ev.feedbackRu.includes('Tomoq') ||
      ev.feedbackRu.includes('Qalqala') ||
      ev.feedbackRu.includes('Tafxim'))
  ) {
    return ev.feedbackRu;
  }

  const tip = MAKHRAJ_ANATOMICAL_TIPS_UZ[ev.letterArabic] || '';

  if (ev.isSubstitutionMistake) {
    const wrong = ev.detectedPhonemeOrLetter || 'boshqa harf';
    return `«${ev.letterArabic}» o'rniga «${wrong}» eshitildi. ${tip}`;
  }

  if (ev.status === 'perfect' && ev.score >= 75) {
    if (ev.expectedHarakaat) {
      return `Me'yorida to'g'ri cho'zildi (${ev.measuredHarakaat ?? ev.expectedHarakaat} harakat).`;
    }
    return "Harf va tajvid qoidasi to'g'ri bajarildi.";
  }

  switch (ev.rule) {
    case 'madd_2':
      return `Madd Tabiiy yetarlicha cho'zilmadi: amalda ${
        ev.measuredHarakaat ?? 0
      } harakat o'qildi, qoida bo'yicha ${
        ev.expectedHarakaat ?? 2
      } harakat (me'yor: 1.6–2.8 harakat) cho'zish kerak.`;
    case 'madd_4':
      return `Madd Wajib Muttasil / Jaiz Munfasil qisqa o'qildi: amalda ${
        ev.measuredHarakaat ?? 0
      } harakat o'qildi, qoida bo'yicha ${
        ev.expectedHarakaat ?? 4
      } harakat (me'yor: 3.3–5.5 harakat) cho'zish kerak.`;
    case 'madd_6':
      return `Madd Lazim qisqa o'qildi: amalda ${
        ev.measuredHarakaat ?? 0
      } harakat o'qildi, qoida bo'yicha ${
        ev.expectedHarakaat ?? 6
      } harakat (me'yor: 4.8–6.8 harakat) cho'zish kerak.`;
    case 'tafkhim':
      return `«${ev.letterArabic}» harfi juda yumshoq o'qildi ${ev.measuredF2Hz ? `(F2: ${ev.measuredF2Hz} Hz)` : ''}. ${tip}`;
    case 'qalqalah':
      return `«${ev.letterArabic}» harfi oxirida aniq qalqala (sakrash) eshitilmadi. Qattiq qisib oching.`;
    case 'ghunnah':
      return `«${ev.letterArabic}» harfini dimog'da 2 harakat miqdorida ushlab o'qing.`;
    case 'makhraj_critical':
      return `«${ev.letterArabic}» harfining maxraji noaniq. ${tip}`;
    case 'harakat':
      return `«${ev.letterArabic}» harfida harakat (fatha/kasra/damma) xato o'qildi.`;
    case 'tashdid':
      return `«${ev.letterArabic}» harfida Tashdid (ikkilantirish) tushib qoldi. Harfni ushlab, ikki marta kuchliroq o'qing.`;
    default:
      return `«${ev.letterArabic}» talaffuzida xatolik bor. ${tip}`;
  }
}

function buildSvgContourPoints(
  semitones: number[],
  width = 600,
  height = 100
): string {
  if (!semitones || semitones.length === 0) return '';
  const padY = 12;
  const usableHeight = height - padY * 2;

  return semitones
    .map((st, idx) => {
      const x = (idx / Math.max(1, semitones.length - 1)) * width;
      const clamped = Math.max(-7, Math.min(7, st));
      const normY = (7 - clamped) / 14;
      const y = padY + normY * usableHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

interface AcousticFeedbackPanelProps {
  result: RecitationAnalysisResult;
  targetTitle: string;
  targetUthmani: string;
  expectedPhonemes: string;
  checkPoints: PhonemeCheckPoint[];
  referenceAudioUrl: string;
  onPlayReferenceAudio: (url: string, id: string) => void;
  playingReferenceId: string | null;
  playbackRate?: number;
  highlightedCheckPointId?: string | null;
  onSelectMistakeCard?: (
    checkPointId: string,
    letterArabic?: string,
    rule?: TajweedRuleType
  ) => void;
  strictnessLevel?: number;
  onPracticeMistake?: (letterArabic: string, rule?: TajweedRuleType) => void;
  onClearErrors?: () => void;
}

export default function AcousticFeedbackPanel({
  result,
  targetUthmani,
  expectedPhonemes,
  checkPoints,
  referenceAudioUrl,
  onPlayReferenceAudio,
  playingReferenceId,
  playbackRate = 1.0,
  highlightedCheckPointId,
  onSelectMistakeCard,
  strictnessLevel,
  onPracticeMistake,
  onClearErrors,
}: AcousticFeedbackPanelProps) {
  const [activeSliceId, setActiveSliceId] = useState<string | null>(null);
  const [activeCardRefId, setActiveCardRefId] = useState<string | null>(null);
  const [showDetailsAccordion, setShowDetailsAccordion] =
    useState<boolean>(false);
  const [fallbackWavUrl, setFallbackWavUrl] = useState<string | null>(null);

  const fullRecAudioRef = useRef<HTMLAudioElement | null>(null);
  const cardRefAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (result.recordedAudioUrl) {
      setFallbackWavUrl(null);
      return;
    }
    if (result.audioBuffer && result.audioBuffer.length > 0) {
      const blob = encodeWavBlob(result.audioBuffer, result.sampleRate || 16000);
      const url = URL.createObjectURL(blob);
      setFallbackWavUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
  }, [result.audioBuffer, result.recordedAudioUrl, result.sampleRate]);

  useEffect(() => {
    return () => {
      if (fullRecAudioRef.current) {
        fullRecAudioRef.current.pause();
      }
      if (cardRefAudioRef.current) {
        cardRefAudioRef.current.pause();
      }
    };
  }, []);

  const effectiveRecordedUrl = result.recordedAudioUrl ?? fallbackWavUrl;

  const stopAllLocalAudio = () => {
    stopActiveAudioPlayback();
    if (fullRecAudioRef.current) {
      fullRecAudioRef.current.pause();
      fullRecAudioRef.current = null;
    }
    if (cardRefAudioRef.current) {
      cardRefAudioRef.current.pause();
      cardRefAudioRef.current = null;
    }
  };

  const playFullRecordedUrlFallback = (onDone: () => void) => {
    if (effectiveRecordedUrl) {
      const audio = new Audio(effectiveRecordedUrl);
      fullRecAudioRef.current = audio;
      audio.onended = onDone;
      audio.onerror = onDone;
      audio.play().catch(onDone);
      return;
    }
    playAudioSlice(
      result.audioBuffer,
      result.sampleRate,
      0,
      result.durationMs,
      onDone
    );
  };

  const handlePlayMyFullRecording = () => {
    stopAllLocalAudio();
    setActiveCardRefId(null);

    if (activeSliceId === 'full_recording') {
      setActiveSliceId(null);
      return;
    }

    setActiveSliceId('full_recording');
    playFullRecordedUrlFallback(() => setActiveSliceId(null));
  };

  const handlePlaySegmentSlice = (ev: CheckPointEvaluation) => {
    stopAllLocalAudio();
    setActiveCardRefId(null);

    if (activeSliceId === ev.checkPointId) {
      setActiveSliceId(null);
      return;
    }

    setActiveSliceId(ev.checkPointId);
    const sliceLenMs = (ev.segmentEndMs ?? 0) - (ev.segmentStartMs ?? 0);

    if (
      !result.audioBuffer ||
      result.audioBuffer.length === 0 ||
      sliceLenMs < 200
    ) {
      playFullRecordedUrlFallback(() => setActiveSliceId(null));
      return;
    }

    playAudioSlice(
      result.audioBuffer,
      result.sampleRate,
      ev.segmentStartMs,
      ev.segmentEndMs,
      () => setActiveSliceId(null)
    ).catch(() => {
      playFullRecordedUrlFallback(() => setActiveSliceId(null));
    });
  };

  const handlePlayCardReference = (
    ev: CheckPointEvaluation,
    originCp?: PhonemeCheckPoint
  ) => {
    stopAllLocalAudio();
    setActiveSliceId(null);

    if (activeCardRefId === ev.checkPointId) {
      setActiveCardRefId(null);
      return;
    }

    setActiveCardRefId(ev.checkPointId);
    const matchingByLetter = checkPoints.find(
      (cp) =>
        cp.referenceWordAudioUrl &&
        cp.letterArabic.replace(/[\u064B-\u065F\u0670]/g, '') ===
          ev.letterArabic.replace(/[\u064B-\u065F\u0670]/g, '')
    );
    const wordAudioUrl =
      ev.referenceWordAudioUrl ??
      originCp?.referenceWordAudioUrl ??
      matchingByLetter?.referenceWordAudioUrl ??
      (referenceAudioUrl.includes('/wbw/') ? referenceAudioUrl : undefined);

    playReferenceAudioSlice({
      wordAudioUrl,
      fallbackAyahAudioUrl: referenceAudioUrl,
      relStartInWord: ev.relStartInWord ?? originCp?.relStartInWord ?? 0,
      relEndInWord: ev.relEndInWord ?? originCp?.relEndInWord ?? 1,
      relStartInAyah: ev.relStart ?? 0,
      relEndInAyah: ev.relEnd ?? 1,
      playbackRate,
      onEnded: () => setActiveCardRefId(null),
    }).catch(() => {
      setActiveCardRefId(null);
    });
  };

  const effectiveStrictness = strictnessLevel ?? result.strictnessLevel ?? 75;
  const passThreshold = Math.round(60 + ((effectiveStrictness - 50) / 50) * 25);

  const isBareAlifOrWasla = (raw: string): boolean => {
    const clean = (raw || '').replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
    return (
      (clean === 'ا' || clean === 'ٱ' || raw.includes('ٱ')) &&
      !raw.includes('أ') &&
      !raw.includes('إ') &&
      !raw.includes('ء')
    );
  };

  // Запрет на фейковые 89% при пустой речи ("Ovozdan so'z aniqlanmadi") в финальном результате
  const isEmptySpeechResult =
    !result.isLivePreview &&
    (result.overallScore === 0 ||
      !result.transcribedArabic ||
      result.transcribedArabic.trim().length === 0);

  const effectiveScore = isEmptySpeechResult ? 0 : result.overallScore;
  const isSoftAdviceMode = !isEmptySpeechResult && effectiveScore >= 85;

  // Отбираем ошибки (исключая пустой Алиф/Хамзатуль-васл по правилу махраджа и погрешность мадда < 0.45 хараката)
  const mistakeEvaluations = isEmptySpeechResult
    ? []
    : result.evaluations.filter((ev) => {
        if (
          isBareAlifOrWasla(ev.letterArabic) &&
          (ev.rule === 'makhraj_critical' || ev.rule === 'ithhar')
        ) {
          return false;
        }
        if (
          ev.expectedHarakaat !== undefined &&
          ev.measuredHarakaat !== undefined &&
          Math.abs(ev.measuredHarakaat - ev.expectedHarakaat) < 0.45 &&
          (ev.rule === 'harakat' || ev.rule === 'madd_2')
        ) {
          return false;
        }
        return (
          ev.score < passThreshold ||
          ev.status === 'mistake' ||
          ev.status === 'warning'
        );
      });

  const hasLetterMistakes = isEmptySpeechResult
    ? true
    : (result.letterEvaluations || []).some((ple) => {
        if (isBareAlifOrWasla(ple.letter) && ple.rule === 'makhraj_critical') {
          return false;
        }
        return (
          ple.status === 'mistake' ||
          ple.status === 'warning' ||
          ple.score < passThreshold
        );
      });

  const isOverallGreat = effectiveScore >= 80;
  const isOverallGood = effectiveScore >= 62 && effectiveScore < 80;

  const verdictTitle =
    effectiveScore === 0
      ? "Ovoz eshitilmadi — qaytadan o'qing"
      : isOverallGreat
      ? "A'lo talaffuz! Dars muvaffaqiyatli topshirildi"
      : isOverallGood
      ? 'Yaxshi, lekin xatolar bor'
      : "Xatolarni to'g'rilang";

  const verdictBadgeClass = isOverallGreat
    ? 'bg-emerald-600 text-white border-2 border-emerald-500 shadow-md'
    : isOverallGood
    ? 'bg-[#4ADE80] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold'
    : 'bg-rose-600 text-white border-2 border-rose-800 shadow-md';

  const checkPointMap = new Map<string, PhonemeCheckPoint>(
    checkPoints.map((cp) => [cp.id, cp])
  );

  const prosody = result.qiraatProsody;
  const durationSecStr = (result.activeSpeechDurationMs / 1000).toFixed(1);

  const aiHeardText =
    effectiveScore === 0
      ? "Ovoz eshitilmadi — qaytadan o'qing"
      : result.transcribedArabic && result.transcribedArabic.trim().length > 0
      ? result.transcribedArabic
      : "Ovozdan so'z aniqlanmadi";

  return (
    <div className="space-y-4">
      {/* ======================================================================== */}
      {/* 1. ОБЩАЯ КАРТОЧКА С ПРОЦЕНТОМ И ТЕМ, ЧТО УСЛЫШАЛ ИИ (OpenAI)             */}
      {/* ======================================================================== */}
      <div className="rounded-2xl bg-[#1B2028] border border-[#52437A] p-4 space-y-3.5 shadow-lg text-slate-100">
        {result.isLivePreview && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl bg-[#1E2631] border border-[#5E4D8C] text-[11px] font-bold text-slate-100 animate-pulse">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#4ADE80] inline-block ring-1 ring-[#6EE7A0]" />
              <span>JONLI TAHLIL (Real-Time)</span>
            </span>
            {typeof result.spokenWordsCount === 'number' && (
              <span className="text-slate-300 font-mono font-bold">
                So&apos;z: {result.spokenWordsCount} / {result.totalWordsCount ?? result.spokenWordsCount}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 font-extrabold text-lg',
              verdictBadgeClass
            )}
          >
            {effectiveScore}%
          </div>

          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-bold text-slate-100 leading-snug">
              {verdictTitle}
            </h3>
            <p className="text-xs text-slate-300 flex items-center gap-1.5 font-medium">
              <Mic className="w-3.5 h-3.5 text-slate-300 shrink-0" />
              <span>Davomiyligi: {durationSecStr} s</span>
              {typeof result.multiSheikhConsensus === 'number' && (
                <>
                  <span>•</span>
                  <span className="text-slate-100 font-bold">
                    Konsensus: {Math.round(result.multiSheikhConsensus)}%
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* Бейдж индивидуального анализа по стандарту 10 шейхов и уровню строгости */}
        <div className="rounded-xl bg-[#1E2631] border border-[#5E4D8C] px-3 py-1.5 flex items-center justify-between gap-2 text-[11px] font-bold text-[#4ADE80]">
          <span className="truncate">
            Individual tahlil (10 qori me&apos;yori asosida) • Qiyinlik: {effectiveStrictness}%
          </span>
        </div>

        {/* Блок: Что услышал ИИ (OpenAI) */}
        <div className="rounded-xl bg-[#242B35] border border-[#5E4D8C] p-3 space-y-1 shadow-inner text-slate-100">
          <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-300 block">
            AI eshitdi (OpenAI):
          </span>
          <p
            dir="rtl"
            className="font-arabic text-2xl text-slate-100 leading-relaxed break-words"
          >
            {aiHeardText}
          </p>
        </div>

        {/* Кнопки прослушивания всей записи и эталона */}
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={handlePlayMyFullRecording}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shadow-sm',
              activeSliceId === 'full_recording'
                ? 'bg-[#4ADE80] text-[#0B1710] border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold shadow-md'
                : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] hover:border-[#6EE7A0]/50'
            )}
          >
            <Play className="w-3.5 h-3.5 fill-current shrink-0" />
            <span className="truncate font-extrabold">
              {activeSliceId === 'full_recording' ? 'Tinglanmoqda' : "O'zimniki"}
            </span>
          </button>

          <button
            type="button"
            onClick={() =>
              onPlayReferenceAudio(referenceAudioUrl, 'ref_feedback_header')
            }
            className={cn(
              'inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold border-2 transition-all cursor-pointer shadow-sm',
              playingReferenceId === 'ref_feedback_header'
                ? 'bg-[#4ADE80] text-[#0B1710] border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold shadow-md'
                : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] hover:border-[#6EE7A0]/50'
            )}
          >
            <Volume2 className="w-3.5 h-3.5 text-slate-300 shrink-0" />
            <span className="truncate font-extrabold">Namuna</span>
          </button>
        </div>
      </div>

      {/* ======================================================================== */}
      {/* 2. КРУПНЫЕ КАРТОЧКИ ДЛЯ ОШИБОК И РЕКОМЕНДАЦИЙ                            */}
      {/* ======================================================================== */}
      {mistakeEvaluations.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <span
              className={cn(
                'text-xs font-extrabold uppercase tracking-wider',
                isSoftAdviceMode ? 'text-[#15803D]' : 'text-slate-100'
              )}
            >
              {isSoftAdviceMode
                ? `Tavsiyalar va maslahatlar (${mistakeEvaluations.length})`
                : `Aniqlangan xatolar (${mistakeEvaluations.length})`}
            </span>
            {onClearErrors && (
              <button
                type="button"
                onClick={onClearErrors}
                className="bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/40 rounded-lg px-3 py-1 text-xs font-semibold transition-all cursor-pointer shrink-0"
                title="Sahifadagi barcha qizil xato belgilarini tozalash"
              >
                ✕ Xatolarni tozalash
              </button>
            )}
          </div>

          {mistakeEvaluations.map((ev) => {
            const isPlayingSlice = activeSliceId === ev.checkPointId;
            const isPlayingCardRef = activeCardRefId === ev.checkPointId;
            const originCp = checkPointMap.get(ev.checkPointId);
            const mistakeDescription = getClearMistakeExplanationUz(ev);
            const isSoftCard = isSoftAdviceMode || ev.status === 'warning';

            const harakaProgressPct =
              ev.expectedHarakaat && ev.measuredHarakaat !== undefined
                ? Math.min(
                    100,
                    Math.round((ev.measuredHarakaat / ev.expectedHarakaat) * 100)
                  )
                : null;

            const isHighlighted = highlightedCheckPointId === ev.checkPointId;

            return (
              <div
                key={ev.checkPointId}
                id={`mistake-card-${ev.checkPointId}`}
                onClick={() =>
                  onSelectMistakeCard?.(ev.checkPointId, ev.letterArabic, ev.rule)
                }
                className={cn(
                  'rounded-2xl border-2 p-4 space-y-3.5 shadow-md transition-all cursor-pointer group',
                  isHighlighted
                    ? 'border-[#6EE7A0] bg-[#4ADE80]/30 ring-4 ring-[#4ADE80] scale-[1.01]'
                    : isSoftCard
                    ? 'border-[#5E4D8C] bg-[#242B35] hover:bg-[#2C3542] text-slate-100'
                    : 'border-rose-500/80 bg-[#281E24] hover:bg-[#32232C] text-slate-100'
                )}
                title="Matndagi joyini ochish va to'g'rilash uchun bosing"
              >
                {/* Заголовок карточки ошибки */}
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      dir="rtl"
                      className={cn(
                        'font-arabic text-3xl px-3.5 py-1.5 rounded-xl bg-[#1E2631] border border-[#5E4D8C] text-emerald-400 shrink-0 transition-colors',
                        isSoftCard
                          ? 'border-[#5E4D8C] group-hover:border-[#6EE7A0]/60'
                          : 'border-rose-400/70 group-hover:border-rose-500'
                      )}
                    >
                      {ev.letterArabic}
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-xs sm:text-sm font-bold text-slate-100 leading-snug">
                        {RULE_NAME_UZ[ev.rule]}
                      </h4>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 text-[11px] font-bold mt-0.5',
                          isSoftCard ? 'text-slate-300' : 'text-rose-600'
                        )}
                      >
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        {isSoftCard
                          ? `Maslahat (${ev.score}%)`
                          : `Xato (${ev.score}%)`}
                      </span>
                    </div>
                  </div>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectMistakeCard?.(
                        ev.checkPointId,
                        ev.letterArabic,
                        ev.rule
                      );
                    }}
                    className={cn(
                      'text-[10px] font-bold border-2 px-2 py-0.5 rounded-lg shrink-0 transition-colors cursor-pointer',
                      isSoftCard
                        ? 'text-[#0B1710] bg-[#4ADE80] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)]'
                        : 'text-rose-200 bg-rose-950/60 border border-rose-500/60 group-hover:bg-rose-600 group-hover:text-white'
                    )}
                  >
                    Matnda ko&apos;rish →
                  </span>
                </div>

                {/* Наглядная шкала длительности для правил Мадда */}
                {harakaProgressPct !== null && (
                  <div className="rounded-xl bg-[#1E2631] border border-[#5E4D8C] p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-100 font-medium">
                        Siz: <strong className="text-slate-300 font-bold">{ev.measuredHarakaat} harakat</strong>
                      </span>
                      <span className="text-slate-100 font-bold">
                        Kerak: {ev.expectedHarakaat} harakat
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-[#2A3441] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#4ADE80] transition-all"
                        style={{ width: `${harakaProgressPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Описание ошибки */}
                <p className="text-xs sm:text-sm text-slate-100 leading-relaxed font-medium">
                  {mistakeDescription}
                </p>

                {/* Кнопки прослушивания внутри карточки ошибки */}
                <div className="grid grid-cols-2 gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlaySegmentSlice(ev);
                    }}
                    className={cn(
                      'py-2.5 px-3 rounded-xl text-xs font-bold border-2 flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm',
                      isPlayingSlice
                        ? 'bg-[#4ADE80] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold shadow-md'
                        : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] hover:border-[#6EE7A0]/50'
                    )}
                  >
                    <Play className="w-3.5 h-3.5 fill-current shrink-0" />
                    <span className="truncate">
                      {isPlayingSlice ? 'Tinglanmoqda' : "O'zimniki"}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlayCardReference(ev, originCp);
                    }}
                    className={cn(
                      'py-2.5 px-3 rounded-xl text-xs font-bold border-2 flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm',
                      isPlayingCardRef
                        ? 'bg-[#4ADE80] text-[#0B1710] border-2 border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] font-extrabold shadow-md'
                        : 'bg-[#242B35] hover:bg-[#2C3542] text-slate-100 border border-[#5E4D8C] hover:border-[#6EE7A0]/50'
                    )}
                  >
                    <Volume2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {isPlayingCardRef ? 'Tinglanmoqda' : 'Namuna'}
                    </span>
                  </button>
                </div>

                {/* Кнопка интерактивной отработки ошибки */}
                {onSelectMistakeCard && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectMistakeCard(
                        ev.checkPointId,
                        ev.letterArabic,
                        ev.rule
                      );
                    }}
                    className="w-full mt-2 py-2 px-3 rounded-xl text-xs font-extrabold bg-[#1E2631] hover:bg-[#4ADE80] text-[#4ADE80] hover:text-[#0B1710] border border-[#5E4D8C] transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm active:scale-95"
                  >
                    <span>🎯 Ushbu xato ustida ishlash («{ev.letterArabic}») →</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : effectiveScore === 0 ? (
        /* Если речь не распознана */
        <div className="rounded-2xl border border-rose-500/60 bg-[#281E24] p-5 text-center space-y-2.5 text-slate-100">
          <div className="w-11 h-11 rounded-2xl bg-[#3A1E26] border border-rose-500 flex items-center justify-center mx-auto text-rose-600">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-rose-700">
            Ovoz eshitilmadi — qaytadan o&apos;qing
          </h4>
          <p className="text-xs text-slate-100 leading-relaxed font-medium">
            Mikrofonga yaqinroq va aniqroq ovozda qaytadan o&apos;qing.
          </p>
        </div>
      ) : effectiveScore < 80 || hasLetterMistakes ? (
        /* Если общий балл < 80% */
        <div className="rounded-2xl border border-[#5E4D8C] bg-[#242B35] p-5 text-center space-y-2.5 text-slate-100">
          <div className="w-11 h-11 rounded-2xl bg-amber-500/20 border border-amber-500/50 flex items-center justify-center mx-auto text-amber-400">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-slate-100">
            Talaffuzda xatoliklar mavjud
          </h4>
          <p className="text-xs text-slate-300 leading-relaxed font-medium">
            {result.detectedIssue ||
              "So'z va uning harakatlari to'liq to'g'ri talaffuz qilinmadi. Iltimos, namunani tinglab qayta o'qing."}
          </p>
        </div>
      ) : (
        /* Успешная сдача */
        <div className="rounded-2xl border border-[#52437A] bg-[#1E2530] p-5 text-center space-y-2.5">
          <div className="w-11 h-11 rounded-2xl bg-[#4ADE80] border border-[#6EE7A0] shadow-[0_0_20px_rgba(74,222,128,0.28)] flex items-center justify-center mx-auto text-[#0B1710]">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-slate-100">
            Mashalloh! Xatolar yo&apos;q
          </h4>
          <p className="text-xs text-emerald-400 leading-relaxed font-semibold">
            Barcha harflar va tajvid qoidalari to&apos;g&apos;ri talaffuz qilindi.
          </p>
        </div>
      )}

      {/* ======================================================================== */}
      {/* 3. ДОПОЛНИТЕЛЬНЫЙ АККОРДЕОН ИНТОНАЦИИ (Qiroat va AI tafsilotlari)         */}
      {/* ======================================================================== */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setShowDetailsAccordion((prev) => !prev)}
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[#242B35] hover:bg-[#2C3542] border border-[#5E4D8C] hover:border-[#6EE7A0]/50 text-xs font-bold text-slate-100 transition-colors cursor-pointer shadow-sm"
        >
          <span className="flex items-center gap-2 truncate">
            <BarChart3 className="w-4 h-4 text-slate-300 shrink-0" />
            <span className="truncate">Qiroat ohangi va tafsilotlar</span>
          </span>
          {showDetailsAccordion ? (
            <ChevronUp className="w-4 h-4 text-slate-100 shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-100 shrink-0" />
          )}
        </button>

        {showDetailsAccordion && (
          <div className="mt-2.5 space-y-3 rounded-2xl bg-[#1E2530] border border-[#52437A] p-3.5">
            {prosody && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-[#242B35] border border-[#5E4D8C] p-2">
                    <span className="text-[10px] text-slate-300 block font-bold">
                      Ohang
                    </span>
                    <strong className="text-xs font-bold text-slate-100">
                      {prosody.melodySimilarityScore}%
                    </strong>
                  </div>
                  <div className="rounded-xl bg-[#242B35] border border-[#5E4D8C] p-2">
                    <span className="text-[10px] text-slate-300 block font-bold">
                      Ritm
                    </span>
                    <strong className="text-xs font-bold text-slate-100">
                      {prosody.rhythmSimilarityScore}%
                    </strong>
                  </div>
                  <div className="rounded-xl bg-[#242B35] border border-[#5E4D8C] p-2">
                    <span className="text-[10px] text-slate-300 block font-bold">
                      Tekislik
                    </span>
                    <strong className="text-xs font-bold text-slate-100">
                      {prosody.pitchStabilityScore}%
                    </strong>
                  </div>
                </div>

                <div className="rounded-xl bg-[#0B0F17] border border-[#52437A] p-2.5">
                  <svg
                    viewBox="0 0 600 100"
                    className="w-full h-16 overflow-visible"
                    preserveAspectRatio="none"
                  >
                    <polyline
                      fill="none"
                      stroke="#4ADE80"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={buildSvgContourPoints(
                        prosody.referencePitchContourNorm
                      )}
                    />
                    <polyline
                      fill="none"
                      stroke="#38BDF8"
                      strokeWidth="2.5"
                      strokeDasharray="6 3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={buildSvgContourPoints(
                        prosody.studentPitchContourNorm
                      )}
                    />
                  </svg>
                </div>
              </div>
            )}

            <div className="rounded-xl bg-[#0B0F17] border border-[#52437A] p-2.5 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-300">Asl matn:</span>
                <span dir="rtl" className="font-arabic text-lg text-white">
                  {targetUthmani}
                </span>
              </div>
              <div className="text-slate-300/80 font-mono text-[11px] truncate">
                /{expectedPhonemes}/
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
