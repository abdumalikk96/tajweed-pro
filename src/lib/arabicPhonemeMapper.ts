/**
 * Маппер арабского коранического текста (с огласовками-харакатами и шаддой)
 * в цепочку фонем IPA и детектор точности совпадения слова с эталоном Мусхафа.
 */

const ARABIC_CHAR_TO_IPA: Record<string, string> = {
  ء: 'ʔ',
  أ: 'ʔ',
  إ: 'ʔ',
  آ: 'ʔ aː',
  ٱ: '',
  ا: 'aː',
  ى: 'aː',
  'ٰ': 'aː', // кинжальный алиф
  ب: 'b',
  ت: 't',
  ث: 'θ',
  ج: 'dʒ',
  ح: 'ħ',
  خ: 'x',
  د: 'd',
  ذ: 'ð',
  ر: 'rˤ',
  ز: 'z',
  س: 's',
  ش: 'ʃ',
  ص: 'sˤ',
  ض: 'dˤ',
  ط: 'tˤ',
  ظ: 'ðˤ',
  ع: 'ʕ',
  غ: 'ɣ',
  ف: 'f',
  ق: 'q',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ه: 'h',
  ة: 'h',
  و: 'w',
  ي: 'j',
  'َ': 'a', // фатха
  'ِ': 'i', // касра
  'ُ': 'u', // дамма
  'ً': 'a n', // танвин фатх
  'ٍ': 'i n', // танвин каср
  'ٌ': 'u n', // танвин дамм
  'ّ': 'ː', // шадда
  'ْ': '', // сукун
  'ٓ': 'ː', // мадда
};

export interface PhonemeMappingResult {
  normalizedArabic: string;
  skeletonConsonants: string;
  rootConsonants: string;
  ipaSequence: string;
  harakaatSummary: string[];
}

/**
 * Нормализует арабскую букву для честного сравнения Усманийского письма Мусхафа
 * и стандартного арабского письма ASR (например: بسم vs باسم, الرحمن vs الرحمان, مالك vs ملك).
 */
function normalizeArabicBaseChar(ch: string): string {
  if (ch === 'ٱ' || ch === 'أ' || ch === 'إ' || ch === 'آ' || ch === 'ى') {
    return 'ا';
  }
  if (ch === 'ة') return 'ه';
  if (ch === 'ؤ') return 'و';
  if (ch === 'ئ') return 'ي';
  return ch;
}

/**
 * Переводит арабскую строку с огласовками в последовательность фонем IPA,
 * консонантный скелет (skeletonConsonants) и корневой консонантный скелет без букв удлинения (rootConsonants).
 */
export function arabicToPhonemeAndHarakaat(
  arabicText: string
): PhonemeMappingResult {
  const cleaned = arabicText
    .replace(/[ـ۞۩\u06D6-\u06ED]/g, '') // удаляем татвиль и коранические знаки остановки
    .replace(/[\u06DF\u06E0]/g, '') // немой круглый ноль
    .replace(/و[\u064B-\u065F]*\u0670/g, 'ا') // وٰ -> ا (الصَّلَوٰةَ, ٱلزَّكَوٰةَ)
    .replace(/[يى][\u064B-\u065F]*\u0670/g, 'ا')
    .replace(/\u0670/g, 'ا') // алиф-ханджария -> ا
    .trim();

  const ipaTokens: string[] = [];
  const harakaatSummary: string[] = [];
  let skeletonConsonants = '';
  let rootConsonants = '';

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === ' ') {
      ipaTokens.push('|');
      skeletonConsonants += ' ';
      continue;
    }

    if (ch === 'َ' || ch === 'ِ' || ch === 'ُ' || ch === 'ّ' || ch === 'ْ') {
      const prevLetter = i > 0 ? cleaned[i - 1] : '';
      harakaatSummary.push(`${prevLetter}${ch}`);
    } else if (/[\u0621-\u064A\u0671]/.test(ch)) {
      const normConsonant = normalizeArabicBaseChar(ch);
      skeletonConsonants += normConsonant;
      // Для корневого скелета убираем слабые буквы алиф, чтобы "باسم" и "بِسْمِ" или "الرحمان" и "ٱلرَّحْمَٰنِ" совпадали на 100%
      if (normConsonant !== 'ا' && normConsonant !== 'ء') {
        rootConsonants += normConsonant;
      }
    }

    const mapped = ARABIC_CHAR_TO_IPA[ch];
    if (mapped !== undefined && mapped.length > 0) {
      ipaTokens.push(mapped);
    }
  }

  return {
    normalizedArabic: cleaned,
    skeletonConsonants: skeletonConsonants.replace(/\s+/g, '').trim(),
    rootConsonants: rootConsonants.replace(/\s+/g, '').trim(),
    ipaSequence: ipaTokens.join(' ').replace(/\s+/g, ' ').trim(),
    harakaatSummary,
  };
}

/**
 * Классическое расстояние Левенштейна между двумя строками.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

export interface ArabicComparisonDiagnostic {
  wordAccuracyScore: number; // 0..100
  detectedPhonemeSequence: string;
  lahnJaliMistakesRu: string[];
  letterSubstitutions: Record<string, string>;
}

/**
 * Сверяет распознанный нейросетью арабский текст с эталонным словом/аятом
 * без ложных штрафов за Усманийскую орфографию (кинжальный алиф ٰ, васлу ٱ и огласовки).
 * Чем ближе прочитанный текст к эталону — тем ВЫШЕ wordAccuracyScore (до 100%).
 */
export function compareRecognizedArabicWithTarget(
  recognizedArabic: string,
  targetUthmani: string,
  expectedPhonemes: string
): ArabicComparisonDiagnostic {
  const recMap = arabicToPhonemeAndHarakaat(recognizedArabic);
  const targetMap = arabicToPhonemeAndHarakaat(targetUthmani);

  if (!recMap.skeletonConsonants && !recMap.rootConsonants) {
    return {
      wordAccuracyScore: 0,
      detectedPhonemeSequence: '',
      lahnJaliMistakesRu: [],
      letterSubstitutions: {},
    };
  }

  // 1. Точность по полному консонантному скелету (без огласовок)
  const maxSkeletonLen = Math.max(
    1,
    targetMap.skeletonConsonants.length,
    recMap.skeletonConsonants.length
  );
  const skelDist = levenshteinDistance(
    recMap.skeletonConsonants,
    targetMap.skeletonConsonants
  );
  const skeletonAccuracy = Math.max(
    0,
    Math.round(((maxSkeletonLen - skelDist) / maxSkeletonLen) * 100)
  );

  // 2. Точность по корневым согласным (учитывает разницу Усманийского расма: بِسْمِ vs باسم, ٱلرَّحْمَٰنِ vs الرحمان)
  const maxRootLen = Math.max(
    1,
    targetMap.rootConsonants.length,
    recMap.rootConsonants.length
  );
  const rootDist = levenshteinDistance(
    recMap.rootConsonants,
    targetMap.rootConsonants
  );
  const rootAccuracy = Math.max(
    0,
    Math.round(((maxRootLen - rootDist) / maxRootLen) * 100)
  );

  // 3. Проверка вхождения подстроки (если прочитано целевое слово и ASR добавил артикль или соседний звук)
  let containmentBonusScore = 0;
  if (
    targetMap.rootConsonants.length >= 2 &&
    recMap.rootConsonants.includes(targetMap.rootConsonants)
  ) {
    containmentBonusScore = 95;
  } else if (
    recMap.rootConsonants.length >= 2 &&
    targetMap.rootConsonants.includes(recMap.rootConsonants)
  ) {
    containmentBonusScore = Math.round(
      (recMap.rootConsonants.length / targetMap.rootConsonants.length) * 95
    );
  }

  const wordAccuracyScore = Math.min(
    100,
    Math.max(skeletonAccuracy, rootAccuracy, containmentBonusScore)
  );

  const lahnJaliMistakesRu: string[] = [];
  const letterSubstitutions: Record<string, string> = {};

  // Проверяем известные критические пары букв (Таляффуз)
  const criticalPairs: Array<{
    expected: string;
    mistake: string;
    desc: string;
  }> = [
    {
      expected: 'ص',
      mistake: 'س',
      desc: 'Услышана мягкая «Син» (س) вместо твердой «Сод» (ص).',
    },
    {
      expected: 'ض',
      mistake: 'د',
      desc: 'Услышана мягкая «Даль» (د) вместо твердой «Дод» (ض).',
    },
    {
      expected: 'ض',
      mistake: 'ظ',
      desc: 'Услышана межзубная «Зо» (ظ) вместо боковой «Дод» (ض).',
    },
    {
      expected: 'ط',
      mistake: 'ت',
      desc: 'Услышана мягкая «Та» (ت) вместо твердой «То» (ط).',
    },
    {
      expected: 'ق',
      mistake: 'ك',
      desc: 'Услышана мягкая «Кяф» (ك) вместо увулярной «Коф» (ق).',
    },
    {
      expected: 'ح',
      mistake: 'ه',
      desc: 'Услышана нижнегортанная «Ха» (ه) вместо фарингальной «Ха» (ح).',
    },
    {
      expected: 'ح',
      mistake: 'خ',
      desc: 'Услышана хриплая «Ха» (خ) вместо чистой гортанной «Ха» (ح).',
    },
    {
      expected: 'ذ',
      mistake: 'ز',
      desc: 'Услышана свистящая «Зай» (ز) вместо межзубной «Заль» (ذ).',
    },
    {
      expected: 'ع',
      mistake: 'أ',
      desc: 'Услышана хамза (أ) вместо глубокой гортанной «Айн» (ع).',
    },
  ];

  for (const pair of criticalPairs) {
    if (
      targetMap.skeletonConsonants.includes(pair.expected) &&
      !recMap.skeletonConsonants.includes(pair.expected) &&
      recMap.skeletonConsonants.includes(pair.mistake)
    ) {
      lahnJaliMistakesRu.push(`Ляхн Джали (подмена буквы): ${pair.desc}`);
      letterSubstitutions[pair.expected] = pair.mistake;
    }
  }

  return {
    wordAccuracyScore,
    detectedPhonemeSequence: recMap.ipaSequence || expectedPhonemes,
    lahnJaliMistakesRu,
    letterSubstitutions,
  };
}
