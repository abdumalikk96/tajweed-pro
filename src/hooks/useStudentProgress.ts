'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  CheckPointEvaluation,
  QuranWord,
  StudentWeaknessStat,
  TajweedRuleType,
  SurahMistakeStat,
  RuleMistakeStat,
} from '@/types/quran';
import { ALL_SURAHS } from '@/data/shortSurahsMatrix';
import { ALL_114_SURAHS_CATALOG } from '@/data/mushafFullCatalog';

const STORAGE_KEY = 'quran_trainer_student_stats_v1';
const FALSE_25_CLEANUP_FLAG = 'quran_trainer_false25_cleaned_v3';

export const RULE_TITLE_UZ: Record<TajweedRuleType, string> = {
  madd_2: 'Madd Tabiiy (2 harakat)',
  madd_4: 'Madd Oriz (4 harakat)',
  madd_6: 'Madd Lozim (6 harakat)',
  ghunnah: "G'unna (Dimog' tovushi)",
  qalqalah: 'Qalqala',
  tafkhim: "Tafxim / Yo'g'on o'qish",
  ithhar: 'Izhor',
  idgham: "Idg'om",
  ikhfa: 'Ixfo',
  makhraj_critical: 'Maxraj va Sifat',
  harakat: 'Harakat (Unli tovushlar)',
  tashdid: 'Tashdid (Harfni ikkilantirish)',
};

export const LETTER_METADATA_UZ: Record<
  string,
  { category: string; commonReasonUz: string; tipUz: string }
> = {
  'ن': {
    category: "Maxraj / G'unna",
    commonReasonUz: "Harakat almashishi (Kasra o'rniga Fatha) yoki G'unna yetishmasligi",
    tipUz: "Til uchini yuqori milkka tekkizib, dimoqdan 2 harakat ushlab talaffuz qiling.",
  },
  'م': {
    category: "Maxraj / G'unna",
    commonReasonUz: "Lablarning to'liq birlashmasligi yoki G'unna tushib qolishi",
    tipUz: "Ikkala labni to'liq qisib, ovozni burun bo'shlig'i orqali yo'naltiring.",
  },
  'ر': {
    category: "Tafxim / Tarqiq",
    commonReasonUz: "Fatha/Dammada yo'g'onlik yetishmasligi yoki ortiqcha titroq",
    tipUz: "Til uchini yuqori tanglayga bir marta sekin uring, ko'p titratmang.",
  },
  'ق': {
    category: "Qalqala / Tafxim",
    commonReasonUz: "Qalqala jaranglamasligi yoki harf yumshoq o'qilishi",
    tipUz: "Til tubini yumshoq tanglayga mahkam urib, jarangdor sakratib chiqaring.",
  },
  'ط': {
    category: "Itboq / Tafxim",
    commonReasonUz: "Ingichka ('te' kabi) o'qilishi yoki itboq yo'qligi",
    tipUz: "Til o'rtasini tanglayga yopishtirib, juda yo'g'on talaffuz qiling.",
  },
  'ص': {
    category: "Itboq / Safir",
    commonReasonUz: "Oddiy 'sin' kabi ingichka chiqishi",
    tipUz: "Lablarni cho'zmasdan, til orqasini ko'tarib yo'g'on 'so' tovushini bering.",
  },
  'ض': {
    category: "Itboq / Istitala",
    commonReasonUz: "Oddiy Z yoki D tovushiga aylanib ketishi",
    tipUz: "Tilning yon chetini yuqori oziq tishlariga mahkam yopishtiring.",
  },
  'ظ': {
    category: "Itboq / Tafxim",
    commonReasonUz: "Oddiy 'z' kabi o'qilishi",
    tipUz: "Til uchini yuqori old tishlar orasidan chiqarib, yo'g'on ayting.",
  },
  'ع': {
    category: "Xalq (Tomoq o'rtasi)",
    commonReasonUz: "Tomoq o'rtasidan siqilmasligi yoki Alifga aylanib ketishi",
    tipUz: "Halqum o'rtasini biroz qisib, chuqur 'Ayn tovushini hosil qiling.",
  },
  'ح': {
    category: "Xalq (Tomoq o'rtasi)",
    commonReasonUz: "Ko'krakdan chiqadigan 'H' yoki xirillovchi 'X' bilan aralashishi",
    tipUz: "Tomoq o'rtasidan mayin, iliq nafas chiqarib ayting.",
  },
  'خ': {
    category: "Xalq / Tafxim",
    commonReasonUz: "Yetarlicha xirillamasligi yoki ingichkalashishi",
    tipUz: "Tomoqning og'izga yaqin qismidan yo'g'on xirillatib chiqaring.",
  },
  'غ': {
    category: "Xalq / Tafxim",
    commonReasonUz: "Qalqala berib qo'yish yoki tomoqdan chiqarmaslik",
    tipUz: "G'ar-g'ara qilgandek tomoq yuqorisidan yo'g'on va oqimli chiqaring.",
  },
  'ث': {
    category: "Lisaviyya (Tish)",
    commonReasonUz: "Oddiy 's' kabi o'qilishi",
    tipUz: "Til uchini old tishlar orasiga qo'yib, havoni mayin chiqaring.",
  },
  'ذ': {
    category: "Lisaviyya (Tish)",
    commonReasonUz: "Oddiy 'z' kabi o'qilishi",
    tipUz: "Til uchini yuqori tishlarga tekkizib, mayin jaranglatib ayting.",
  },
  'ه': {
    category: "Xalq tubi",
    commonReasonUz: "Nafas yetishmasligi yoki qattiq chiqishi",
    tipUz: "Ko'krak qafasidan erkin va chuqur nafas bilan chiqaring.",
  },
  'ء': {
    category: "Hamza / Xalq",
    commonReasonUz: "Harakat noaniqligi yoki uzib o'qilmasligi",
    tipUz: "Ovozni birdan to'xtatib, harakatni aniq (a, i, u) ayting.",
  },
  'ا': {
    category: "Madd / Xalq",
    commonReasonUz: "Cho'zish me'yori buzilishi yoki noaniq fatha",
    tipUz: "Og'izni yaxshi ochib, ovozni 2 harakat tekis cho'zing.",
  },
  'و': {
    category: "Shofaviya (Lab)",
    commonReasonUz: "Lablar to'liq doira qilinmasligi",
    tipUz: "Lablarni oldinga cho'zib, to'garak holatga keltiring.",
  },
  'ي': {
    category: "Javf / Tanglay",
    commonReasonUz: "Kasra yetarlicha pastga tushmasligi",
    tipUz: "Jag'ni biroz pastga tushirib, til o'rtasini tanglayga yaqinlashtiring.",
  },
  'ك': {
    category: "Hams / Maxraj",
    commonReasonUz: "Hams (havo) chiqmasligi yoki qofga aylanishi",
    tipUz: "Til orqasini tanglayga urib, yengil nafas pufagi bilan chiqaring.",
  },
  'ت': {
    category: "Hams / Maxraj",
    commonReasonUz: "Hams yetishmasligi yoki to' harfiga aylanishi",
    tipUz: "Til uchini yuqori tish tubiga tekkizib, yengil havo bilan ayting.",
  },
  'د': {
    category: "Qalqala / Maxraj",
    commonReasonUz: "Sukun holatida qalqala bo'lmasligi",
    tipUz: "Sukunli bo'lganda til uchini tish tubidan sakratib ajrating.",
  },
  'ب': {
    category: "Qalqala / Lab",
    commonReasonUz: "Qalqala berilmasligi yoki lab to'liq yopilmasligi",
    tipUz: "Lablarni mahkam yopib, sakratib kuchli jarang bilan oching.",
  },
  'ج': {
    category: "Qalqala / Shajariya",
    commonReasonUz: "Chala chiqishi yoki 'ch' kabi jaranglamasligi",
    tipUz: "Til o'rtasini tanglayga qattiq yopishtirib, jarangdor sakrating.",
  },
  'ز': {
    category: "Safir",
    commonReasonUz: "Safir (ari ovozi) yetishmasligi",
    tipUz: "Tishlarni jipslashtirib, ari ovozidek jarangdor hushtak chiqaring.",
  },
  'س': {
    category: "Safir / Hams",
    commonReasonUz: "Hams yetishmasligi yoki 'so' ga aylanishi",
    tipUz: "Ingichka va mayin hushtak nafasi bilan talaffuz qiling.",
  },
  'ش': {
    category: "Tafashshiy",
    commonReasonUz: "Og'izda havo to'liq tarqalmasligi",
    tipUz: "Havoni og'iz bo'shlig'i bo'ylab keng yoyib chiqaring.",
  },
  'ل': {
    category: "Tavassut",
    commonReasonUz: "Ortiqcha cho'zish yoki maxrajdan tez uzilish",
    tipUz: "Tilning yon-old qismini yuqori milkka tekkizib, o'rtacha ushlang.",
  },
};

export const RULE_METADATA_UZ: Record<
  TajweedRuleType,
  { category: string; commonReasonUz: string; tipUz: string }
> = {
  madd_2: {
    category: 'Madd Tabiiy',
    commonReasonUz: "Yetarli cho'zilmasligi (1 harakat bo'lib qolishi) yoki ortiqcha cho'zish",
    tipUz: "2 harakat (bir barmoqni ochib-yopish vaqti) me'yorida tekis cho'zing.",
  },
  madd_4: {
    category: 'Madd Oriz/Muttasil',
    commonReasonUz: "4 harakat to'liq cho'zilmasligi",
    tipUz: "O'rtacha me'yorda (4 harakat) to'xtamasdan tekis cho'zing.",
  },
  madd_6: {
    category: 'Madd Lozim',
    commonReasonUz: "6 harakat to'liq cho'zilmasligi yoki tez o'tib ketish",
    tipUz: "Eng uzun me'yorda (6 harakat) kuchli ovoz bilan to'liq cho'zing.",
  },
  ghunnah: {
    category: "G'unna",
    commonReasonUz: "Dimoq ovozi berilmasligi yoki 2 harakat ushlanmasligi",
    tipUz: "Ovozni burun bo'shlig'ida 2 harakat davomida jaranglatib ushlang.",
  },
  qalqalah: {
    category: 'Qalqala',
    commonReasonUz: 'Sakratish (portlash) yetishmasligi yoki ortiqcha harakat qo\'shish',
    tipUz: 'Harf sukunli bo\'lganda maxrajdan kuchli sakrab, jarangdor ajraling.',
  },
  tafkhim: {
    category: 'Tafxim',
    commonReasonUz: "Harf ingichka ('tarqiq') o'qilib qolishi",
    tipUz: "Og'iz bo'shlig'ini to'ldirib, til orqasini yuqoriga ko'targan holda yo'g'on ayting.",
  },
  harakat: {
    category: 'Harakatlar',
    commonReasonUz: 'Kasra, Fatha yoki Damma almashtirib o\'qilishi',
    tipUz: "Harakat belgilariga qat'iy e'tibor bering: a (fatha), i (kasra), u (damma).",
  },
  tashdid: {
    category: 'Tashdid',
    commonReasonUz: "Harf ikkilantirilmasdan, yengil o'qib ketilishi",
    tipUz: "Harf ustida biroz to'xtab, kuchliroq bosim bilan ikkilantiring.",
  },
  idgham: {
    category: "Idg'om",
    commonReasonUz: "Harflar bir-biriga to'liq singib kirmasligi",
    tipUz: "Birinchi harfni ikkinchisiga singdirib, bitta harfdek o'qing.",
  },
  ikhfa: {
    category: 'Ixfo',
    commonReasonUz: "Yashirish va dimoq ovozi me'yori buzilishi",
    tipUz: "Nun tovushini maxrajiga to'liq tekkizmasdan, yengil dimoq bilan yashiring.",
  },
  ithhar: {
    category: 'Izhor',
    commonReasonUz: "Ortiqcha dimoq berish yoki harf orasida to'xtab qolish",
    tipUz: "Harfni o'z maxrajidan aniq va toza, dimoqsiz ajrating.",
  },
  makhraj_critical: {
    category: 'Maxraj va Sifat',
    commonReasonUz: "Harf maxrajining o'xshash harf bilan almashib qolishi",
    tipUz: "Harfning maxraj a'zolariga to'liq diqqat qiling va sifatini saqlang.",
  },
};

export function getBaseArabicLetter(charOrCluster: string): string {
  if (!charOrCluster) return '';
  const cleaned = charOrCluster
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .trim();
  if (!cleaned) return charOrCluster.trim();
  return cleaned[0];
}

export function enrichWeaknessStat(stat: StudentWeaknessStat): StudentWeaknessStat {
  if (stat.key.startsWith('letter_')) {
    const rawLetter = stat.key.replace('letter_', '');
    const baseLetter = getBaseArabicLetter(rawLetter);
    const meta = LETTER_METADATA_UZ[baseLetter] || {
      category: 'Maxraj va Talaffuz',
      commonReasonUz: 'Harakat aniqligi yoki harf maxraji',
      tipUz: "Harakatlarni to'liq (a - ochiq, i - pastga, u - labni yig'ib) talaffuz qiling.",
    };
    return {
      ...stat,
      label: `«${baseLetter}» harfi`,
      baseArabicLetter: baseLetter,
      category: meta.category,
      commonReasonUz: meta.commonReasonUz,
      tipUz: meta.tipUz,
    };
  } else if (stat.key.startsWith('rule_')) {
    const ruleKey = stat.key.replace('rule_', '') as TajweedRuleType;
    const meta = RULE_METADATA_UZ[ruleKey] || {
      category: 'Tajvid qoidasi',
      commonReasonUz: "Qoida me'yoriga to'liq amal qilinmasligi",
      tipUz: "Qoidani xotirjam va me'yorida talaffuz qilishga harakat qiling.",
    };
    return {
      ...stat,
      label: RULE_TITLE_UZ[ruleKey] || stat.label,
      category: meta.category,
      commonReasonUz: meta.commonReasonUz,
      tipUz: meta.tipUz,
    };
  }
  return stat;
}

function migrateAndCleanStatsMap(
  rawMap: Record<string, StudentWeaknessStat>
): Record<string, StudentWeaknessStat> {
  const cleaned: Record<string, StudentWeaknessStat> = {};

  for (const [key, stat] of Object.entries(rawMap)) {
    if (!stat) continue;
    // Отбрасываем ложно накопленные записи со средним баллом <= 35% от старого бага
    if (stat.averageScore <= 35 && stat.mistakesCount >= stat.totalAttempts) {
      continue;
    }

    let cleanLabel = stat.label;
    if (cleanLabel && cleanLabel.includes('Буква «')) {
      cleanLabel = cleanLabel.replace(/Буква\s*«([^»]+)»/g, '«$1» harfi');
    }

    if (key.startsWith('letter_')) {
      const rawLetter = key.replace('letter_', '');
      const baseLetter = getBaseArabicLetter(rawLetter);
      const canonicalKey = `letter_${baseLetter}`;

      const existing = cleaned[canonicalKey];
      if (!existing) {
        cleaned[canonicalKey] = {
          ...stat,
          key: canonicalKey,
          label: `«${baseLetter}» harfi`,
        };
      } else {
        const totalAttempts = existing.totalAttempts + stat.totalAttempts;
        const mistakesCount = existing.mistakesCount + stat.mistakesCount;
        const averageScore = Math.round(
          (existing.averageScore * existing.totalAttempts +
            stat.averageScore * stat.totalAttempts) /
            Math.max(1, totalAttempts)
        );
        cleaned[canonicalKey] = {
          ...existing,
          totalAttempts,
          mistakesCount,
          averageScore,
          lastFeedbackRu: stat.lastFeedbackRu || existing.lastFeedbackRu,
        };
      }
    } else if (key.startsWith('rule_')) {
      const ruleKey = key.replace('rule_', '') as TajweedRuleType;
      const canonicalLabel = RULE_TITLE_UZ[ruleKey] || cleanLabel;
      cleaned[key] = {
        ...stat,
        label: canonicalLabel,
      };
    } else {
      cleaned[key] = {
        ...stat,
        label: cleanLabel,
      };
    }
  }

  return cleaned;
}

interface PersistedStudentData {
  statsMap: Record<string, StudentWeaknessStat>;
  wordLastStatuses: Record<string, 'perfect' | 'warning' | 'mistake'>;
  surahStats?: Record<number, SurahMistakeStat>;
}

export interface UseStudentProgressReturn {
  weakPoints: StudentWeaknessStat[];
  topRuleMistakes: RuleMistakeStat[];
  topSurahMistakes: SurahMistakeStat[];
  surahStats: Record<number, SurahMistakeStat>;
  wordLastStatuses: Record<string, 'perfect' | 'warning' | 'mistake'>;
  recordAttemptEvaluations: (
    evaluations: CheckPointEvaluation[],
    wordIds: string[],
    context?: {
      surahId?: number;
      surahName?: string;
      ayahNumber?: number;
    }
  ) => void;
  getRecommendedDrillWords: () => QuranWord[];
  resetStudentProgress: () => void;
  resolveWeakPoint: (keyOrLetter: string, score: number, feedbackUz?: string) => void;
}

export function useStudentProgress(): UseStudentProgressReturn {
  const [statsMap, setStatsMap] = useState<Record<string, StudentWeaknessStat>>(
    {}
  );
  const [wordLastStatuses, setWordLastStatuses] = useState<
    Record<string, 'perfect' | 'warning' | 'mistake'>
  >({});
  const [surahStats, setSurahStats] = useState<
    Record<number, SurahMistakeStat>
  >({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const alreadyCleaned = window.localStorage.getItem(FALSE_25_CLEANUP_FLAG);
      if (!alreadyCleaned) {
        // Однократный автосброс ложно накопленных 25%-ных ошибок от старого бага
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.setItem(FALSE_25_CLEANUP_FLAG, '1');
        return;
      }

      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedStudentData;
        if (parsed.statsMap) {
          const migrated = migrateAndCleanStatsMap(parsed.statsMap);
          setStatsMap(migrated);
        }
        if (parsed.wordLastStatuses) {
          setWordLastStatuses(parsed.wordLastStatuses);
        }
        if (parsed.surahStats) {
          setSurahStats(parsed.surahStats);
        }
      }
    } catch {
      // ignore corrupted localStorage
    }
  }, []);

  const saveToStorage = useCallback(
    (
      nextStats: Record<string, StudentWeaknessStat>,
      nextWordStatuses: Record<string, 'perfect' | 'warning' | 'mistake'>,
      nextSurahs?: Record<number, SurahMistakeStat>
    ) => {
      if (typeof window === 'undefined') return;
      try {
        const payload: PersistedStudentData = {
          statsMap: nextStats,
          wordLastStatuses: nextWordStatuses,
          surahStats: nextSurahs || surahStats,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // ignore quota errors
      }
    },
    [surahStats]
  );

  const recordAttemptEvaluations = useCallback(
    (
      evaluations: CheckPointEvaluation[],
      wordIds: string[],
      context?: {
        surahId?: number;
        surahName?: string;
        ayahNumber?: number;
      }
    ) => {
      if (evaluations.length === 0) return;

      setStatsMap((prevStats) => {
        const updatedStats: Record<string, StudentWeaknessStat> = {
          ...prevStats,
        };

        const upsertStat = (
          key: string,
          label: string,
          ev: CheckPointEvaluation
        ) => {
          const existing = updatedStats[key];
          const isMistakeOrWarn = ev.status !== 'perfect' ? 1 : 0;
          if (!existing) {
            updatedStats[key] = {
              key,
              label,
              totalAttempts: 1,
              mistakesCount: isMistakeOrWarn,
              averageScore: ev.score,
              lastFeedbackRu: ev.feedbackRu,
            };
          } else {
            const totalAttempts = existing.totalAttempts + 1;
            const mistakesCount = existing.mistakesCount + isMistakeOrWarn;
            const averageScore = Math.round(
              (existing.averageScore * existing.totalAttempts + ev.score) /
                totalAttempts
            );
            updatedStats[key] = {
              ...existing,
              totalAttempts,
              mistakesCount,
              averageScore,
              lastFeedbackRu:
                ev.status !== 'perfect'
                  ? ev.feedbackRu
                  : existing.lastFeedbackRu,
            };
          }
        };

        for (const ev of evaluations) {
          const baseLetter = getBaseArabicLetter(ev.letterArabic);
          if (baseLetter) {
            upsertStat(
              `letter_${baseLetter}`,
              `«${baseLetter}» harfi`,
              ev
            );
          }
          upsertStat(`rule_${ev.rule}`, RULE_TITLE_UZ[ev.rule] || ev.rule, ev);
        }

        setWordLastStatuses((prevWordMap) => {
          const nextWordMap = { ...prevWordMap };
          const problemWordIdsInAttempt: string[] = [];

          for (const wId of wordIds) {
            const wordEvals = evaluations.filter((e) =>
              e.checkPointId.includes(wId)
            );
            const targetEvals =
              wordEvals.length > 0 ? wordEvals : evaluations;

            if (targetEvals.some((e) => e.status === 'mistake')) {
              nextWordMap[wId] = 'mistake';
              problemWordIdsInAttempt.push(wId);
            } else if (targetEvals.some((e) => e.status === 'warning')) {
              nextWordMap[wId] = 'warning';
            } else {
              nextWordMap[wId] = 'perfect';
            }
          }

          setSurahStats((prevSurahs) => {
            const nextSurahs = { ...prevSurahs };
            const mistakeCountInAttempt = evaluations.filter(
              (e) => e.status === 'mistake'
            ).length;

            if (mistakeCountInAttempt > 0) {
              let sId = context?.surahId ?? 1;
              let aNum = context?.ayahNumber ?? 1;

              if (sId > 1000 && wordIds.length > 0) {
                const parts = wordIds[0].split('_');
                if (parts.length >= 2) {
                  const parsedS = parseInt(parts[0], 10);
                  const parsedA = parseInt(parts[1], 10);
                  if (!isNaN(parsedS) && parsedS > 0) sId = parsedS;
                  if (!isNaN(parsedA) && parsedA > 0) aNum = parsedA;
                }
              }

              const cat = ALL_114_SURAHS_CATALOG.find((c) => c.id === sId);
              const sName =
                context?.surahName ||
                cat?.nameUz ||
                ALL_SURAHS.find((s) => s.id === sId)?.nameArabic ||
                `Sura ${sId}`;

              const existingSurah = nextSurahs[sId] || {
                surahId: sId,
                surahName: sName,
                totalMistakes: 0,
                ayahMistakes: {},
                problemWordIds: [],
              };

              const updatedAyahMistakes = { ...existingSurah.ayahMistakes };
              updatedAyahMistakes[aNum] =
                (updatedAyahMistakes[aNum] || 0) + mistakeCountInAttempt;

              const mergedWordIds = [...existingSurah.problemWordIds];
              for (const pw of problemWordIdsInAttempt) {
                if (!mergedWordIds.includes(pw)) {
                  mergedWordIds.push(pw);
                }
              }

              nextSurahs[sId] = {
                ...existingSurah,
                surahName: sName,
                totalMistakes:
                  existingSurah.totalMistakes + mistakeCountInAttempt,
                ayahMistakes: updatedAyahMistakes,
                problemWordIds: mergedWordIds.slice(-20),
              };
            }

            saveToStorage(updatedStats, nextWordMap, nextSurahs);
            return nextSurahs;
          });

          return nextWordMap;
        });

        return updatedStats;
      });
    },
    [saveToStorage]
  );

  // Faqat haqiqiy dolzarb zaif harflarni saralash (maksimum 8 ta ustuvor xato)
  const weakPoints: StudentWeaknessStat[] = Object.values(statsMap)
    .filter(
      (s) =>
        s.key.startsWith('letter_') &&
        s.mistakesCount > 0 &&
        s.averageScore < 82
    )
    .sort(
      (a, b) =>
        a.averageScore - b.averageScore || b.mistakesCount - a.mistakesCount
    )
    .slice(0, 8)
    .map(enrichWeaknessStat);

  // Qoidalar bo'yicha eng ko'p uchraydigan 3 ta xato
  const topRuleMistakes: RuleMistakeStat[] = (
    Object.keys(RULE_TITLE_UZ) as TajweedRuleType[]
  )
    .map((ruleKey) => {
      const stat = statsMap[`rule_${ruleKey}`];
      return {
        rule: ruleKey,
        titleUz: RULE_TITLE_UZ[ruleKey],
        mistakesCount: stat?.mistakesCount || 0,
        totalAttempts: stat?.totalAttempts || 0,
        averageScore: stat ? stat.averageScore : 100,
      };
    })
    .filter((r) => r.mistakesCount > 0)
    .sort((a, b) => b.mistakesCount - a.mistakesCount)
    .slice(0, 3);

  // Suralar bo'yicha xatolar reytingi
  const topSurahMistakes: SurahMistakeStat[] = Object.values(surahStats)
    .filter((s) => s.totalMistakes > 0)
    .sort((a, b) => b.totalMistakes - a.totalMistakes)
    .slice(0, 5);

  const getRecommendedDrillWords = useCallback((): QuranWord[] => {
    const allWords = ALL_SURAHS.flatMap((s) =>
      s.ayahs.flatMap((a) => a.words)
    );

    if (weakPoints.length === 0) {
      return allWords.filter((w) =>
        [
          '001_001_003', // ٱلرَّحْمَـٰنِ
          '001_002_004', // ٱلْعَـٰلَمِينَ
          '001_006_002', // ٱلصِّرَٰطَ
          '001_006_003', // ٱلْمُسْتَقِيمَ
          '001_007_006', // ٱلْمَغْضُوبِ
          '001_007_009', // ٱلضَّآلِّينَ
          '112_002_002', // ٱلصَّمَدُ
          '113_004_003', // ٱلنَّفَّـٰثَـٰتِ
        ].includes(w.id)
      );
    }

    const weakKeys = new Set(weakPoints.slice(0, 6).map((wp) => wp.key));

    const scoredWords = allWords.map((word) => {
      let priority = 0;
      if (wordLastStatuses[word.id] === 'mistake') priority += 5;
      else if (wordLastStatuses[word.id] === 'warning') priority += 2;

      for (const cp of word.checkPoints) {
        const baseLetter = getBaseArabicLetter(cp.letterArabic);
        if (weakKeys.has(`letter_${baseLetter}`)) priority += 4;
        if (weakKeys.has(`rule_${cp.rule}`)) priority += 3;
      }
      return { word, priority };
    });

    const filtered = scoredWords
      .filter((item) => item.priority > 0)
      .sort((a, b) => b.priority - a.priority)
      .map((item) => item.word);

    return filtered.length > 0 ? filtered.slice(0, 8) : allWords.slice(0, 6);
  }, [weakPoints, wordLastStatuses]);

  const resetStudentProgress = useCallback(() => {
    setStatsMap({});
    setWordLastStatuses({});
    setSurahStats({});
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const resolveWeakPoint = useCallback(
    (keyOrLetter: string, score: number, feedbackUz?: string) => {
      const raw = keyOrLetter.replace('letter_', '');
      const base = getBaseArabicLetter(raw);
      const letterKey = `letter_${base}`;

      setStatsMap((prevStats) => {
        const nextStats = { ...prevStats };
        const existing = nextStats[letterKey] || nextStats[keyOrLetter];
        const nextScore = Math.max(88, Math.round(score));

        nextStats[letterKey] = {
          ...(existing || {
            key: letterKey,
            label: `«${base}» harfi`,
            totalAttempts: 1,
          }),
          averageScore: nextScore,
          mistakesCount: 0,
          lastFeedbackRu:
            feedbackUz ||
            "Maxraj va talaffuz muvaffaqiyatli to'g'rilandi (85%+)",
        };

        saveToStorage(nextStats, wordLastStatuses, surahStats);
        return nextStats;
      });
    },
    [saveToStorage, wordLastStatuses, surahStats]
  );

  return {
    weakPoints,
    topRuleMistakes,
    topSurahMistakes,
    surahStats,
    wordLastStatuses,
    recordAttemptEvaluations,
    getRecommendedDrillWords,
    resetStudentProgress,
    resolveWeakPoint,
  };
}
