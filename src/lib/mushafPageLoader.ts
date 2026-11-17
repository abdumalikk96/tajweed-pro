import { Ayah, PhonemeCheckPoint, QuranWord, SurahMetadata } from '@/types/quran';
import { arabicToPhonemeAndHarakaat } from '@/lib/arabicPhonemeMapper';
import { ALL_114_SURAHS_CATALOG } from '@/data/mushafFullCatalog';
import { ALL_SURAHS } from '@/data/shortSurahsMatrix';

interface LetterRuleSpec {
  ipa: string;
  mistakes: string[];
  rule: PhonemeCheckPoint['rule'];
  requireLowF2?: boolean;
  descRu: string;
}

const LETTER_SPECS: Record<string, LetterRuleSpec> = {
  ص: {
    ipa: 'sˤ',
    mistakes: ['s'],
    rule: 'tafkhim',
    requireLowF2: true,
    descRu:
      'Твердая свистящая «Сод» (ص): поднимите заднюю часть языка к мягкому нёбу (Тафхим), не читайте как мягкую «Син» (س).',
  },
  ض: {
    ipa: 'dˤ',
    mistakes: ['d', 'ðˤ', 'z'],
    rule: 'tafkhim',
    requireLowF2: true,
    descRu:
      'Твердая буква «Дод» (ض): прижмите боковой край языка к верхним коренным зубам с глубоким Тафхимом.',
  },
  ط: {
    ipa: 'tˤ',
    mistakes: ['t', 'd'],
    rule: 'tafkhim',
    requireLowF2: true,
    descRu:
      'Самая твердая буква «То» (ط): поднимите спинку языка к мягкому нёбу без придыхания.',
  },
  ظ: {
    ipa: 'ðˤ',
    mistakes: ['z', 'ð', 'dˤ'],
    rule: 'tafkhim',
    requireLowF2: true,
    descRu:
      'Твердая межзубная «Зо» (ظ): выведите кончик языка к краю верхних резцов и поднимите корень языка.',
  },
  ق: {
    ipa: 'q',
    mistakes: ['k', 'g', 'x'],
    rule: 'tafkhim',
    requireLowF2: true,
    descRu:
      'Глубокая увулярная «Коф» (ق): корень языка смыкается с мягким нёбом (не заменяйте на мягкую «Кяф» ك).',
  },
  غ: {
    ipa: 'ɣ',
    mistakes: ['g', 'x'],
    rule: 'tafkhim',
    requireLowF2: true,
    descRu:
      'Твердая верхнегортанная «Гайн» (غ): плавный звонкий звук из верхней части горла.',
  },
  خ: {
    ipa: 'x',
    mistakes: ['h', 'ħ'],
    rule: 'tafkhim',
    requireLowF2: true,
    descRu:
      'Твердая верхнегортанная «Ха» (خ) из области мягкого нёба с легким трением воздуха.',
  },
  ح: {
    ipa: 'ħ',
    mistakes: ['h', 'x'],
    rule: 'makhraj_critical',
    requireLowF2: false,
    descRu:
      'Чистая среднегортанная «Ха» (ح): сузьте среднюю часть гортани без грубого хрипа.',
  },
  ع: {
    ipa: 'ʕ',
    mistakes: ['ʔ', 'a'],
    rule: 'makhraj_critical',
    requireLowF2: false,
    descRu:
      'Глубокая среднегортанная «Айн» (ع): работайте мышцами средней части горла (надгортанником).',
  },
  ه: {
    ipa: 'h',
    mistakes: ['ħ', 'x'],
    rule: 'makhraj_critical',
    requireLowF2: false,
    descRu:
      'Мягкая нижнегортанная «Ха» (ه) из нижней части гортани с чистым выдохом.',
  },
  ث: {
    ipa: 'θ',
    mistakes: ['s', 't'],
    rule: 'makhraj_critical',
    requireLowF2: false,
    descRu:
      'Мягкая межзубная «Са» (ث): коснитесь кончиком языка края верхних резцов (не читайте как свистящую «С»).',
  },
  ذ: {
    ipa: 'ð',
    mistakes: ['z', 'd'],
    rule: 'makhraj_critical',
    requireLowF2: false,
    descRu:
      'Мягкая межзубная «Заль» (ذ): кончик языка у края верхних резцов (не читайте как «З»).',
  },
  س: {
    ipa: 's',
    mistakes: ['sˤ', 'θ'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu:
      'Мягкая свистящая «Син» (س): держите спинку языка опущенной (Таркик).',
  },
  ش: {
    ipa: 'ʃ',
    mistakes: ['s'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu:
      'Мягкая «Шин» (ش) со свойством Тафашши (свободное распространение воздуха во рту).',
  },
  ز: {
    ipa: 'z',
    mistakes: ['ð', 's'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Звонкая свистящая «Зай» (ز) с четкой вибрацией голосовых связок.',
  },
  ك: {
    ipa: 'k',
    mistakes: ['q'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu:
      'Мягкая буква «Кяф» (ك) с легким выходом воздуха (Хамс), не смешивайте с глубокой «Коф» (ق).',
  },
  ج: {
    ipa: 'dʒ',
    mistakes: ['ʒ', 'g'],
    rule: 'makhraj_critical',
    requireLowF2: false,
    descRu:
      'Плотная смычная «Джим» (ج): средняя часть языка плотно касается твердого нёба.',
  },
  ب: {
    ipa: 'b',
    mistakes: ['p'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Звонкая губная «Ба» (ب) с плотным смыканием губ без оглушения.',
  },
  ت: {
    ipa: 't',
    mistakes: ['tˤ', 'd'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Мягкая «Та» (ت) с легким придыханием (Хамс), без твердости.',
  },
  د: {
    ipa: 'd',
    mistakes: ['t', 'dˤ'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Мягкая звонкая «Даль» (د) без оглушения в «Т».',
  },
  ف: {
    ipa: 'f',
    mistakes: ['v', 'p'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu:
      'Губно-зубная «Фа» (ف): верхние резцы легко касаются внутренней стороны нижней губы.',
  },
  ل: {
    ipa: 'l',
    mistakes: ['lˤ'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Мягкая «Лям» (ل): кончик языка у десен верхних резцов (Тавассут).',
  },
  م: {
    ipa: 'm',
    mistakes: ['n'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Губная «Мим» (م) с мягким естественным резонансом.',
  },
  ن: {
    ipa: 'n',
    mistakes: ['m'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Язычная «Нун» (ن) с четкой артикуляцией кончика языка.',
  },
  و: {
    ipa: 'w',
    mistakes: ['v'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu:
      'Губная «Вав» (و): округлите губы вперед, не прикасаясь верхними зубами к нижней губе.',
  },
  ي: {
    ipa: 'j',
    mistakes: ['i'],
    rule: 'ithhar',
    requireLowF2: false,
    descRu: 'Мягкая средненёбная «Йа» (ي) из середины языка.',
  },
};

interface ParsedCluster {
  baseChar: string;
  clusterText: string;
  diacritics: string;
  index: number;
}

/**
 * Разбивает арабское слово на последовательные буквенные кластеры (базовая буква + её огласовки/шадда/мадд)
 * строго справа налево в порядке произнесения.
 */
function splitWordIntoLetterClusters(textUthmani: string): ParsedCluster[] {
  const clusters: ParsedCluster[] = [];
  let currentBase = '';
  let currentDiacritics = '';

  for (const ch of textUthmani) {
    const code = ch.charCodeAt(0);
    const isBaseArabicLetter =
      (code >= 0x0621 && code <= 0x063a) ||
      (code >= 0x0641 && code <= 0x064a) ||
      code === 0x0671; // ٱ

    const isDaggerAlif = code === 0x0670; // ٰ

    if (isBaseArabicLetter) {
      if (currentBase) {
        clusters.push({
          baseChar: currentBase,
          clusterText: currentBase + currentDiacritics,
          diacritics: currentDiacritics,
          index: clusters.length,
        });
      }
      currentBase = ch;
      currentDiacritics = '';
    } else if (isDaggerAlif) {
      currentDiacritics += ch;
    } else if (code >= 0x064b && code <= 0x065f) {
      currentDiacritics += ch;
    }
  }

  if (currentBase) {
    clusters.push({
      baseChar: currentBase,
      clusterText: currentBase + currentDiacritics,
      diacritics: currentDiacritics,
      index: clusters.length,
    });
  }

  return clusters;
}

/**
 * Универсальный пословный и побуквенный генератор точек контроля Таджвида и Таляффуза (`checkPoints`)
 * для любого слова на любой из 604 страниц и 114 сур Корана.
 * Выстраивает точки проверки строго в порядке следования букв в слове и проставляет `relStartInWord`, `relEndInWord` и `referenceWordAudioUrl`.
 */
export function generateCheckPointsForWord(
  wordId: string,
  textUthmani: string,
  wordAudioUrl?: string
): PhonemeCheckPoint[] {
  const clusters = splitWordIntoLetterClusters(textUthmani);
  const totalClusters = Math.max(1, clusters.length);
  const rawPoints: Array<{
    cp: PhonemeCheckPoint;
    priority: number;
    clusterIdx: number;
  }> = [];

  const qalqalahSet = new Set(['ق', 'ط', 'ب', 'ج', 'د']);

  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    const nextCl = clusters[i + 1];
    const isLastCluster = i === clusters.length - 1;
    const hasShaddah = cl.diacritics.includes('\u0651'); // ّ
    const hasSukoon =
      cl.diacritics.includes('\u0652') || cl.diacritics.includes('\u06e1'); // ْ / ۡ
    const hasMaddah =
      cl.baseChar === 'آ' ||
      cl.diacritics.includes('\u0653') ||
      nextCl?.diacritics.includes('\u0653');
    const hasDaggerAlif = cl.diacritics.includes('\u0670'); // ٰ
    const hasFatha = cl.diacritics.includes('\u064e');
    const hasKasra = cl.diacritics.includes('\u0650');
    const hasDamma = cl.diacritics.includes('\u064f');

    const relStartInWord = Number((i / totalClusters).toFixed(2));
    const relEndInWord = Number(
      Math.min(1, (i + 1.35) / totalClusters).toFixed(2)
    );

    // 1. Мадд 6 или 4 хараката (знак волнистой черты ٓ или آ)
    if (hasMaddah) {
      const nextHasShaddah = Boolean(nextCl?.diacritics.includes('\u0651'));
      const isMadd6 = nextHasShaddah || textUthmani.includes('آلّ');
      rawPoints.push({
        priority: 10,
        clusterIdx: i,
        cp: {
          id: `cp_${wordId}_${i}_maddLong`,
          letterArabic: cl.clusterText + (nextCl ? nextCl.baseChar : ''),
          expectedPhonemeIPA: isMadd6 ? 'aːː' : 'aː',
          commonMistakeIPA: ['a'],
          rule: isMadd6 ? 'madd_6' : 'madd_4',
          expectedHarakaat: isMadd6 ? 6 : 4,
          descriptionRu: isMadd6
            ? 'Мадд Лазим: тяните гласную ровно 6 счетов без обрыва.'
            : 'Удлиненный Мадд (4 счета): плавно удерживайте протяжку перед хамзой.',
          referenceWordAudioUrl: wordAudioUrl,
          relStartInWord,
          relEndInWord,
        },
      });
      continue;
    }

    // 2. Ваджиб Гунна на удвоенных نّ или مّ (или Нун с сукуном)
    if ((cl.baseChar === 'ن' || cl.baseChar === 'م') && hasShaddah) {
      const isNun = cl.baseChar === 'ن';
      rawPoints.push({
        priority: 10,
        clusterIdx: i,
        cp: {
          id: `cp_${wordId}_${i}_ghunnah`,
          letterArabic: cl.clusterText,
          expectedPhonemeIPA: isNun ? 'nː' : 'mː',
          commonMistakeIPA: [isNun ? 'n' : 'm'],
          rule: 'ghunnah',
          expectedHarakaat: 2,
          descriptionRu: `Ваджиб Гунна на удвоенной «${
            isNun ? 'Нун' : 'Мим'
          }» (${cl.clusterText}): удерживайте мягкий назальный резонанс в носу ровно 2 счета.`,
          referenceWordAudioUrl: wordAudioUrl,
          relStartInWord,
          relEndInWord,
        },
      });
      continue;
    }

    // 3. Калькаля на ق ط ب ج د (при сукуне или остановке в конце слова)
    if (qalqalahSet.has(cl.baseChar) && (hasSukoon || isLastCluster)) {
      const isHeavyQalqalah = cl.baseChar === 'ق' || cl.baseChar === 'ط';
      rawPoints.push({
        priority: 9,
        clusterIdx: i,
        cp: {
          id: `cp_${wordId}_${i}_qalqalah`,
          letterArabic: cl.clusterText,
          expectedPhonemeIPA: LETTER_SPECS[cl.baseChar]?.ipa || cl.baseChar,
          commonMistakeIPA: LETTER_SPECS[cl.baseChar]?.mistakes || [],
          rule: 'qalqalah',
          requireLowF2: isHeavyQalqalah ? true : false,
          descriptionRu: `Калькаля на букве «${cl.baseChar}» (${cl.clusterText}): сделайте четкий упругий отскок звука в точке смычки без добавления гласной.`,
          referenceWordAudioUrl: wordAudioUrl,
          relStartInWord,
          relEndInWord,
        },
      });
      continue;
    }

    // 4. Естественный Мадд Табии (2 счета): кинжальный алиф ٰ, либо ا после фатхи, ي после кясры, و после даммы
    const isAlifMadd =
      hasDaggerAlif ||
      (hasFatha &&
        nextCl &&
        (nextCl.baseChar === 'ا' || nextCl.baseChar === 'ى') &&
        nextCl.diacritics.length === 0);
    const isYaMadd =
      hasKasra &&
      nextCl &&
      nextCl.baseChar === 'ي' &&
      (nextCl.diacritics.length === 0 || nextCl.diacritics.includes('\u0652'));
    const isWawMadd =
      hasDamma &&
      nextCl &&
      nextCl.baseChar === 'و' &&
      (nextCl.diacritics.length === 0 || nextCl.diacritics.includes('\u0652'));

    if (isAlifMadd || isYaMadd || isWawMadd) {
      const displayMadd =
        cl.clusterText + (nextCl && !hasDaggerAlif ? nextCl.baseChar : '');
      const maddVowelIpa = isAlifMadd ? 'aː' : isYaMadd ? 'iː' : 'uː';
      rawPoints.push({
        priority: 8,
        clusterIdx: i,
        cp: {
          id: `cp_${wordId}_${i}_madd2`,
          letterArabic: displayMadd,
          expectedPhonemeIPA: maddVowelIpa,
          commonMistakeIPA: [maddVowelIpa[0]],
          rule: 'madd_2',
          expectedHarakaat: 2,
          descriptionRu: `Мадд Табии (${displayMadd}): тяните долгую гласную ровно 2 счета.`,
          referenceWordAudioUrl: wordAudioUrl,
          relStartInWord,
          relEndInWord: Number(
            Math.min(1, (i + 1.8) / totalClusters).toFixed(2)
          ),
        },
      });
    }

    // 5. Буква «Ра» (ر): Тафхим при фатхе/дамме, Таркик при кясре
    if (cl.baseChar === 'ر') {
      const isSoftRa = hasKasra;
      rawPoints.push({
        priority: 8,
        clusterIdx: i,
        cp: {
          id: `cp_${wordId}_${i}_ra`,
          letterArabic: cl.clusterText,
          expectedPhonemeIPA: isSoftRa ? 'r' : 'rˤ',
          commonMistakeIPA: [isSoftRa ? 'rˤ' : 'r'],
          rule: isSoftRa ? 'ithhar' : 'tafkhim',
          requireLowF2: !isSoftRa,
          descriptionRu: isSoftRa
            ? `Мягкая буква «Ра» (${cl.clusterText}) с кясрой (Таркик): читайте мягко без грубого раската.`
            : `Твердая буква «Ра» (${cl.clusterText}) с фатхой/даммой (Тафхим): поднимите заднюю часть языка, избегая многократной дрожи (Такрир).`,
          referenceWordAudioUrl: wordAudioUrl,
          relStartInWord,
          relEndInWord,
        },
      });
      continue;
    }

    // 6. Специфические правила для остальных букв слова (Истиъля, Гортанные, Межзубные, Изхар)
    // Исключаем пустой Алиф и Хамзатуль-васл (ا / ٱ без хамзы أ/إ/ء) из проверки Махраджа
    if (
      (cl.baseChar === 'ا' || cl.baseChar === 'ٱ') &&
      !cl.clusterText.includes('أ') &&
      !cl.clusterText.includes('إ') &&
      !cl.clusterText.includes('ء')
    ) {
      continue;
    }

    const spec = LETTER_SPECS[cl.baseChar];
    if (spec) {
      const priority =
        spec.rule === 'tafkhim'
          ? 9
          : spec.rule === 'makhraj_critical'
          ? 8
          : 5;
      rawPoints.push({
        priority,
        clusterIdx: i,
        cp: {
          id: `cp_${wordId}_${i}_${cl.baseChar}`,
          letterArabic: cl.clusterText,
          expectedPhonemeIPA: spec.ipa,
          commonMistakeIPA: spec.mistakes,
          rule: spec.rule,
          requireLowF2: spec.requireLowF2,
          descriptionRu: spec.descRu,
          referenceWordAudioUrl: wordAudioUrl,
          relStartInWord,
          relEndInWord,
        },
      });
    }
  }

  // Отбираем до 4 самых важных точек слова, затем сортируем их СТРОГО в порядке следования букв в слове (по clusterIdx)
  const selected = rawPoints
    .sort((a, b) => b.priority - a.priority || a.clusterIdx - b.clusterIdx)
    .slice(0, 4)
    .sort((a, b) => a.clusterIdx - b.clusterIdx)
    .map((item) => item.cp);

  if (selected.length === 0) {
    const nonAlifCluster = clusters.find(
      (c) =>
        (c.baseChar !== 'ا' && c.baseChar !== 'ٱ') ||
        c.clusterText.includes('أ') ||
        c.clusterText.includes('إ')
    );
    const firstCluster =
      nonAlifCluster?.clusterText || clusters[0]?.clusterText || textUthmani;
    selected.push({
      id: `cp_${wordId}_base`,
      letterArabic: firstCluster,
      expectedPhonemeIPA:
        arabicToPhonemeAndHarakaat(textUthmani).ipaSequence || 'a',
      commonMistakeIPA: [],
      rule: 'ithhar',
      requireLowF2: false,
      descriptionRu:
        'Произнесите букву и её огласовку четко, соблюдая чистоту махариджа.',
      referenceWordAudioUrl: wordAudioUrl,
      relStartInWord: 0,
      relEndInWord: 1,
    });
  }

  // Нормализуем интервалы [relStartInWord, relEndInWord] выбранных точек, чтобы каждая карточка указывала на свой слог
  return selected.map((cp, idx) => {
    const fallbackStart = Number((idx / selected.length).toFixed(2));
    const fallbackEnd = Number(((idx + 1) / selected.length).toFixed(2));
    return {
      ...cp,
      referenceWordAudioUrl: cp.referenceWordAudioUrl ?? wordAudioUrl,
      relStartInWord: cp.relStartInWord ?? fallbackStart,
      relEndInWord: cp.relEndInWord ?? fallbackEnd,
    };
  });
}

/**
 * Каноническая разметка строк 1-й страницы Мусхафа (Сура Аль-Фатиха, 7 строк):
 */
function getBuiltInLineNumber(
  surahId: number,
  ayahNum: number,
  wordIdx: number
): number {
  if (surahId === 1) {
    if (ayahNum === 1) return 2;
    if (ayahNum === 2) return 3;
    if (ayahNum === 3) return wordIdx === 1 ? 3 : 4;
    if (ayahNum === 4) return 4;
    if (ayahNum === 5) return 5;
    if (ayahNum === 6) return wordIdx === 1 ? 5 : 6;
    if (ayahNum === 7) return wordIdx <= 3 ? 6 : 7;
  }
  return ayahNum;
}

/**
 * Дополняет встроенные матрицы сур (1, 112, 113, 114) ссылками на пословное аудио `referenceWordAudioUrl`,
 * номером строки Мусхафа `lineNumber` и относительными границами `relStartInWord` / `relEndInWord` внутри каждого слова.
 */
export function enrichSurahCheckPointsWithWordAudio(
  surah: SurahMetadata
): SurahMetadata {
  return {
    ...surah,
    ayahs: surah.ayahs.map((ayah) => ({
      ...ayah,
      words: ayah.words.map((word) => {
        const totalCps = Math.max(1, word.checkPoints.length);
        return {
          ...word,
          lineNumber:
            word.lineNumber ??
            getBuiltInLineNumber(surah.id, ayah.number, word.wordIndex),
          checkPoints: word.checkPoints.map((cp, idx) => ({
            ...cp,
            referenceWordAudioUrl: cp.referenceWordAudioUrl ?? word.audioUrl,
            relStartInWord:
              cp.relStartInWord ?? Number((idx / totalCps).toFixed(2)),
            relEndInWord:
              cp.relEndInWord ?? Number(((idx + 1) / totalCps).toFixed(2)),
          })),
        };
      }),
    })),
  };
}

interface QuranComWordApi {
  id: number;
  position: number;
  line_number?: number;
  char_type_name: string;
  text_uthmani: string;
  audio_url: string | null;
  transliteration?: { text?: string | null };
}

interface QuranComVerseApi {
  id: number;
  verse_number: number;
  verse_key: string;
  page_number?: number;
  text_uthmani?: string;
  words: QuranComWordApi[];
}

function mapApiVersesToAyahs(verses: QuranComVerseApi[]): Ayah[] {
  return verses.map((v, vIdx) => {
    const [surahStr, ayahStr] = (v.verse_key || '1:1').split(':');
    const surahNum = Number(surahStr) || 1;
    const ayahNum = Number(ayahStr) || v.verse_number || vIdx + 1;

    const paddedSurah = String(surahNum).padStart(3, '0');
    const paddedAyah = String(ayahNum).padStart(3, '0');
    const fullAyahAudioUrl = `https://everyayah.com/data/Husary_128kbps/${paddedSurah}${paddedAyah}.mp3`;

    const actualWords = (v.words || []).filter(
      (w) =>
        w.char_type_name === 'word' &&
        Boolean(w.text_uthmani) &&
        /[\u0621-\u064A\u0671]/.test(w.text_uthmani)
    );

    const quranWords: QuranWord[] = actualWords.map((w, wIdx) => {
      // Строгая 1-базовая нумерация реальных произносимых слов (без сдвига из-за знаков вакфа ۗ/ۖ/ۚ)
      const paddedWord = String(wIdx + 1).padStart(3, '0');
      const wordId = `${paddedSurah}_${paddedAyah}_${paddedWord}`;
      const wbwAudio = `https://audio.qurancdn.com/wbw/${wordId}.mp3`;

      const ipaInfo = arabicToPhonemeAndHarakaat(w.text_uthmani);

      return {
        id: wordId,
        ayahNumber: ayahNum,
        wordIndex: wIdx + 1,
        lineNumber: w.line_number,
        textUthmani: w.text_uthmani,
        transliteration:
          w.transliteration?.text || `Слово ${wIdx + 1} (${v.verse_key})`,
        audioUrl: wbwAudio,
        expectedPhonemes: ipaInfo.ipaSequence || w.text_uthmani,
        checkPoints: generateCheckPointsForWord(
          wordId,
          w.text_uthmani,
          wbwAudio
        ),
      };
    });

    const combinedUthmani =
      v.text_uthmani || quranWords.map((qw) => qw.textUthmani).join(' ');

    return {
      number: ayahNum,
      verseKey: v.verse_key,
      textUthmani: combinedUthmani,
      audioUrl: fullAyahAudioUrl,
      words: quranWords,
    };
  });
}

const pageCache = new Map<number, SurahMetadata>();
const chapterCache = new Map<number, SurahMetadata>();

/**
 * Загружает любую страницу Мусхафа (1–604) из официального API Quran.com (v4)
 * со всеми аятами, пословным аудио и авто-генерацией правил Таджвида для каждого слова.
 */
export async function fetchMushafPage(
  pageNumber: number
): Promise<SurahMetadata | null> {
  const safePage = Math.max(1, Math.min(604, Math.round(pageNumber)));
  if (pageCache.has(safePage)) {
    return pageCache.get(safePage)!;
  }

  try {
    const url = `https://api.quran.com/api/v4/verses/by_page/${safePage}?language=ru&words=true&per_page=50&word_fields=text_uthmani,audio_url,transliteration,line_number`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const verses: QuranComVerseApi[] = Array.isArray(data?.verses)
      ? data.verses
      : [];

    if (verses.length === 0) return null;

    const ayahs = mapApiVersesToAyahs(verses);
    const firstVerseKey = verses[0]?.verse_key || '1:1';
    const surahIdFromPage = Number(firstVerseKey.split(':')[0]) || 1;
    const catalogEntry = ALL_114_SURAHS_CATALOG.find(
      (c) => c.id === surahIdFromPage
    );

    const pageMetadata: SurahMetadata = {
      id: 1000 + safePage,
      pageNumber: safePage,
      surahId: surahIdFromPage,
      nameArabic: catalogEntry
        ? `${catalogEntry.nameArabic} • صَفْحَة ${safePage}`
        : `صَفْحَة ${safePage}`,
      nameRu: catalogEntry
        ? `Стр. ${safePage} • ${catalogEntry.nameRu}`
        : `Страница Мусхафа ${safePage}`,
      ayahs,
    };

    pageCache.set(safePage, pageMetadata);
    return pageMetadata;
  } catch {
    return null;
  }
}

/**
 * Загружает любую из 114 сур Корана по номеру суры (1–114):
 * - Если сура есть во встроенной ручной матрице (1, 112, 113, 114), возвращает её с обогащенными ссылками на пословное аудио.
 * - Для всех остальных сур (2–111) подгружает аяты и слова из официального API Quran.com (`verses/by_chapter/{chapterId}`)
 *   с автоматической генерацией полной матрицы Таджвида для каждого слова.
 */
export async function fetchSurahByChapter(
  chapterId: number
): Promise<SurahMetadata | null> {
  const safeChapter = Math.max(1, Math.min(114, Math.round(chapterId)));

  const manualMatch = ALL_SURAHS.find((s) => s.id === safeChapter);
  if (manualMatch) {
    return enrichSurahCheckPointsWithWordAudio(manualMatch);
  }

  if (chapterCache.has(safeChapter)) {
    return chapterCache.get(safeChapter)!;
  }

  const catalogEntry = ALL_114_SURAHS_CATALOG.find((c) => c.id === safeChapter);

  try {
    const url = `https://api.quran.com/api/v4/verses/by_chapter/${safeChapter}?language=ru&words=true&per_page=100&word_fields=text_uthmani,audio_url,transliteration,line_number`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const verses: QuranComVerseApi[] = Array.isArray(data?.verses)
      ? data.verses
      : [];

    if (verses.length === 0) return null;

    const ayahs = mapApiVersesToAyahs(verses);

    const surahMetadata: SurahMetadata = {
      id: safeChapter,
      pageNumber: catalogEntry?.startPage ?? verses[0]?.page_number ?? 1,
      surahId: safeChapter,
      nameArabic: catalogEntry?.nameArabic ?? `سُورَة ${safeChapter}`,
      nameRu: catalogEntry?.nameRu ?? `Сура ${safeChapter}`,
      ayahs,
    };

    chapterCache.set(safeChapter, surahMetadata);
    return surahMetadata;
  } catch {
    return null;
  }
}
