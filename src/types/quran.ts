export type TajweedRuleType =
  | 'madd_2'
  | 'madd_4'
  | 'madd_6'
  | 'ghunnah'
  | 'qalqalah'
  | 'tafkhim'
  | 'ithhar'
  | 'idgham'
  | 'ikhfa'
  | 'makhraj_critical'
  | 'harakat'
  | 'tashdid';

export interface PhonemeCheckPoint {
  id: string;
  letterArabic: string;
  expectedPhonemeIPA: string;
  commonMistakeIPA: string[];
  rule: TajweedRuleType;
  expectedHarakaat?: number;
  requireLowF2?: boolean;
  descriptionRu: string;
  referenceWordAudioUrl?: string;
  relStartInWord?: number;
  relEndInWord?: number;
}

export interface QuranWord {
  id: string;
  ayahNumber: number;
  wordIndex: number;
  lineNumber?: number;
  textUthmani: string;
  transliteration: string;
  audioUrl: string;
  expectedPhonemes: string;
  checkPoints: PhonemeCheckPoint[];
}

export interface Ayah {
  number: number;
  verseKey?: string;
  textUthmani: string;
  audioUrl: string;
  words: QuranWord[];
}

export interface SurahMetadata {
  id: number;
  nameArabic: string;
  nameRu: string;
  pageNumber?: number;
  surahId?: number;
  ayahs: Ayah[];
}

export interface VoiceCalibrationProfile {
  isCalibrated: boolean;
  ambientNoiseRms: number;
  basePitchF0Hz: number;
  softLetterAvgF2Hz: number;
  heavyLetterAvgF2Hz: number;
  dynamicTafkhimThresholdHz: number;
  naturalHarakaMs: number;
}

export type RecitationPace = 'tahqiq' | 'tadwir' | 'hadr' | 'fast';

export type TrainingMode = 'ayah' | 'word' | 'drill' | 'page' | 'exam';

export type ExamSubMode = 'memorized' | 'homework';

export type ExamRollbackRule = 'current_ayah' | 'prev_ayah';

export interface AcousticFrame {
  timeMs: number;
  rms: number;
  zcr: number;
  f1Hz: number;
  f2Hz: number;
  nasalRatio: number;
  isVoiced: boolean;
  pitchF0Hz: number;
}

export interface CheckPointEvaluation {
  checkPointId: string;
  letterArabic: string;
  rule: TajweedRuleType;
  status: 'perfect' | 'warning' | 'mistake';
  score: number;
  measuredHarakaat?: number;
  expectedHarakaat?: number;
  measuredF2Hz?: number;
  qalqalahBurstDetected?: boolean;
  detectedPhonemeOrLetter?: string;
  gopConfidence?: number;
  isSubstitutionMistake?: boolean;
  segmentStartMs: number;
  segmentEndMs: number;
  referenceWordAudioUrl?: string;
  relStart?: number;
  relEnd?: number;
  relStartInWord?: number;
  relEndInWord?: number;
  feedbackRu: string;
}

export interface QiraatProsodyComparison {
  melodySimilarityScore: number;
  rhythmSimilarityScore: number;
  pitchStabilityScore: number;
  studentPitchContourNorm: number[];
  referencePitchContourNorm: number[];
  qiraatAdviceRu: string;
}

export interface StudentWeaknessStat {
  key: string;
  label: string;
  totalAttempts: number;
  mistakesCount: number;
  averageScore: number;
  lastFeedbackRu: string;
  category?: string;
  commonReasonUz?: string;
  tipUz?: string;
  baseArabicLetter?: string;
}

export interface SurahMistakeStat {
  surahId: number;
  surahName: string;
  totalMistakes: number;
  ayahMistakes: Record<number, number>;
  problemWordIds: string[];
}

export interface RuleMistakeStat {
  rule: TajweedRuleType;
  titleUz: string;
  mistakesCount: number;
  totalAttempts: number;
  averageScore: number;
}

export interface LetterEvaluationDetail {
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

export type SheikhId =
  | 'husary'
  | 'minshawi'
  | 'abdulbasit'
  | 'afasy'
  | 'sudais'
  | 'shuraym'
  | 'ghamadi'
  | 'muaiqly'
  | 'shatri'
  | 'ayyoub';

export interface SheikhProfile {
  id: SheikhId;
  nameUz: string;
  nameArabic: string;
  styleUz: string;
  everyAyahFolder: string;
  baseHarakaMs: number;
  maddRatios: { madd2: number; madd4: number; madd6: number };
}

export const TEN_SHEIKHS_CATALOG: SheikhProfile[] = [
  {
    id: 'husary',
    nameUz: 'Shayx Mahmud Xalil Al-Xusariy (Muallim)',
    nameArabic: 'محمود خليل الحصري',
    styleUz: 'Tahqiq / Muallim (Aniq maxraj)',
    everyAyahFolder: 'Husary_128kbps',
    baseHarakaMs: 135,
    maddRatios: { madd2: 2.0, madd4: 4.1, madd6: 6.1 },
  },
  {
    id: 'minshawi',
    nameUz: 'Shayx Muhammad Siddiq Al-Minshaviy',
    nameArabic: 'محمد صديق المنشاوي',
    styleUz: 'Murattal (Chuqur ohang va tajvid)',
    everyAyahFolder: 'Minshawy_Murattal_128kbps',
    baseHarakaMs: 130,
    maddRatios: { madd2: 2.0, madd4: 4.0, madd6: 6.0 },
  },
  {
    id: 'abdulbasit',
    nameUz: 'Shayx Abdulbosit Abdussomad',
    nameArabic: 'عبد الباسط عبد الصمد',
    styleUz: 'Murattal (Nafas va aniq cho\'zish)',
    everyAyahFolder: 'Abdul_Basit_Murattal_192kbps',
    baseHarakaMs: 128,
    maddRatios: { madd2: 2.0, madd4: 4.2, madd6: 6.2 },
  },
  {
    id: 'afasy',
    nameUz: 'Shayx Mishariy Roshid Al-Afasiy',
    nameArabic: 'مشاري راشد العفاسي',
    styleUz: 'Tartil (Ravon va ohangdor)',
    everyAyahFolder: 'Alafasy_128kbps',
    baseHarakaMs: 118,
    maddRatios: { madd2: 1.95, madd4: 3.9, madd6: 5.9 },
  },
  {
    id: 'sudais',
    nameUz: 'Shayx Abdurrahmon As-Sudays',
    nameArabic: 'عبد الرحمن السديس',
    styleUz: 'Haramayn uslubi (Tadwir/Hadr)',
    everyAyahFolder: 'Abdurrahmaan_As-Sudais_192kbps',
    baseHarakaMs: 105,
    maddRatios: { madd2: 1.85, madd4: 3.7, madd6: 5.6 },
  },
  {
    id: 'shuraym',
    nameUz: 'Shayx Saud Ash-Shuraym',
    nameArabic: 'سعود الشريم',
    styleUz: 'Haramayn uslubi (Tezkor va aniq)',
    everyAyahFolder: 'Saood_ash-Shuraym_128kbps',
    baseHarakaMs: 102,
    maddRatios: { madd2: 1.85, madd4: 3.6, madd6: 5.5 },
  },
  {
    id: 'ghamadi',
    nameUz: "Shayx Sa'd Al-G'omidiy",
    nameArabic: 'سعد الغامدي',
    styleUz: 'Tartil (Yumshoq va ravshan)',
    everyAyahFolder: 'Ghamadi_40kbps',
    baseHarakaMs: 115,
    maddRatios: { madd2: 1.95, madd4: 3.9, madd6: 5.8 },
  },
  {
    id: 'muaiqly',
    nameUz: 'Shayx Mohir Al-Muayqliy',
    nameArabic: 'ماهر المعيقلي',
    styleUz: 'Tartil / Tadwir (Muvozanatli)',
    everyAyahFolder: 'MaherAlMuaiqly128kbps',
    baseHarakaMs: 112,
    maddRatios: { madd2: 1.9, madd4: 3.8, madd6: 5.8 },
  },
  {
    id: 'shatri',
    nameUz: 'Shayx Abu Bakr Ash-Shatiriy',
    nameArabic: 'أبو بكر الشاطري',
    styleUz: 'Tartil (Tinch va aniq)',
    everyAyahFolder: 'Abu_Bakr_Ash-Shaatree_128kbps',
    baseHarakaMs: 120,
    maddRatios: { madd2: 2.0, madd4: 4.0, madd6: 6.0 },
  },
  {
    id: 'ayyoub',
    nameUz: 'Shayx Muhammad Ayyub',
    nameArabic: 'محمد أيوب',
    styleUz: 'Madina uslubi (Salobatli)',
    everyAyahFolder: 'Muhammad_Ayyoub_128kbps',
    baseHarakaMs: 125,
    maddRatios: { madd2: 2.0, madd4: 4.1, madd6: 6.0 },
  },
];

export function buildSheikhAyahAudioUrl(
  sheikhId: SheikhId,
  surahId: number,
  ayahNumber: number,
  verseKey?: string
): string {
  const sheikh =
    TEN_SHEIKHS_CATALOG.find((s) => s.id === sheikhId) ?? TEN_SHEIKHS_CATALOG[0];
  let realSurah = surahId;
  let realAyah = ayahNumber;
  if (verseKey && verseKey.includes(':')) {
    const parts = verseKey.split(':');
    const s = parseInt(parts[0], 10);
    const a = parseInt(parts[1], 10);
    if (!Number.isNaN(s) && s > 0) realSurah = s;
    if (!Number.isNaN(a) && a > 0) realAyah = a;
  }
  const sPad = String(Math.max(1, Math.min(114, realSurah))).padStart(3, '0');
  const aPad = String(Math.max(1, realAyah)).padStart(3, '0');
  return `https://everyayah.com/data/${sheikh.everyAyahFolder}/${sPad}${aPad}.mp3`;
}

export interface RecitationAnalysisResult {
  audioBuffer: Float32Array;
  recordedAudioUrl?: string;
  peakDb?: number;
  sampleRate: number;
  durationMs: number;
  activeSpeechDurationMs: number;
  detectedPaceHarakaMs: number;
  overallScore: number;
  frames: AcousticFrame[];
  evaluations: CheckPointEvaluation[];
  letterEvaluations?: LetterEvaluationDetail[];
  detectedIssue?: string;
  transcribedArabic?: string;
  detectedPhonemeSequence?: string;
  wordAccuracyScore?: number;
  aiEngineUsed: 'neural_hybrid' | 'dsp_fallback';
  qiraatProsody?: QiraatProsodyComparison;
  multiSheikhConsensus?: number;
  strictnessLevel?: number;
  studentUnitMs?: number;
  isLivePreview?: boolean;
  spokenWordsCount?: number;
  verifiedWordsCount?: number;
  totalWordsCount?: number;
  spokenLetterCount?: number;
  failedWordIndex?: number | null;
  failedWordArabic?: string | null;
}
