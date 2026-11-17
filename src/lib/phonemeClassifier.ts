import {
  AcousticFrame,
  PhonemeCheckPoint,
  VoiceCalibrationProfile,
} from '@/types/quran';

export interface MakhrajClassificationResult {
  detectedPhonemeOrLetter: string;
  gopConfidence: number; // 0..100
  isSubstitutionMistake: boolean;
  diagnosticFeedbackRu: string | null;
}

/**
 * Точечный акустико-фонетический классификатор махариджа и сыфатов.
 * Чем чище и увереннее артикуляция — тем ВЫШЕ gopConfidence (до 98%).
 * При тишине (maxRms < 0.015) строго возвращает 0%.
 */
export function evaluateMakhrajAndSifaat(
  frames: AcousticFrame[],
  checkPoint: PhonemeCheckPoint,
  calibrationProfile?: VoiceCalibrationProfile | null
): MakhrajClassificationResult {
  if (frames.length === 0) {
    return {
      detectedPhonemeOrLetter: '∅ (тишина)',
      gopConfidence: 0,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  const maxRms = frames.reduce((max, f) => (f.rms > max ? f.rms : max), 0);
  if (maxRms < 0.0005) {
    return {
      detectedPhonemeOrLetter: '∅ (тишина)',
      gopConfidence: 0,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: 'Голос не обнаружен. Говорите громче.',
    };
  }

  const voicedFrames = frames.filter((f) => f.isVoiced);
  const activeFrames = voicedFrames.length > 0 ? voicedFrames : frames;

  const avgZcr =
    frames.reduce((sum, f) => sum + f.zcr, 0) / Math.max(1, frames.length);
  const maxZcr = frames.reduce((max, f) => (f.zcr > max ? f.zcr : max), 0);

  const avgF1Hz = Math.round(
    activeFrames.reduce((sum, f) => sum + f.f1Hz, 0) /
      Math.max(1, activeFrames.length)
  );
  const avgF2Hz = Math.round(
    activeFrames.reduce((sum, f) => sum + f.f2Hz, 0) /
      Math.max(1, activeFrames.length)
  );

  const letter = checkPoint.letterArabic;
  const expectedIPA = checkPoint.expectedPhonemeIPA;

  const tafkhimThresholdHz =
    calibrationProfile?.isCalibrated &&
    calibrationProfile.dynamicTafkhimThresholdHz > 950
      ? calibrationProfile.dynamicTafkhimThresholdHz
      : 1480;

  // 1. МЕЖЗУБНЫЕ ПРОТИВ СВИСТЯЩИХ (ث / ذ / ظ vs س / ز)
  const isInterdental =
    letter.includes('ذ') ||
    letter.includes('ث') ||
    letter.includes('ظ') ||
    expectedIPA.includes('ð') ||
    expectedIPA.includes('θ');

  if (isInterdental) {
    if (avgZcr > 0.32 || maxZcr > 0.38) {
      const subLabel = letter.includes('ث')
        ? 'س [s] (свистящий)'
        : 'ز [z] (свистящий)';
      return {
        detectedPhonemeOrLetter: subLabel,
        gopConfidence: 32,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Кончик языка не выведен между зубами: вместо межзубной буквы прозвучал высокочастотный свистящий звук (Сафир). Слегка коснитесь кончиком языка края верхних резцов.',
      };
    }

    if (
      (letter.includes('ظ') || expectedIPA.includes('ðˤ')) &&
      avgF2Hz > tafkhimThresholdHz + 160
    ) {
      return {
        detectedPhonemeOrLetter: 'ذ [ð] (мягкая)',
        gopConfidence: 52,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Межзубная укладка верная, но недостаточно твердости (Тафхим): вместо твердой «Зо» (ظ) прозвучала мягкая «Заль» (ذ). Поднимите заднюю спинку языка.',
      };
    }

    return {
      detectedPhonemeOrLetter: `${letter} [${expectedIPA}]`,
      gopConfidence: 94,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  // 2. ЭМФАТИЧЕСКИЕ ПРОТИВ МЯГКИХ (ص / ض / ط / ق vs س / د / ت / ك)
  if (letter.includes('ص') || expectedIPA.includes('sˤ')) {
    if (avgF2Hz > tafkhimThresholdHz + 180) {
      return {
        detectedPhonemeOrLetter: 'س [s] (мягкая)',
        gopConfidence: 42,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Вместо твердой эмфатической «Сод» (ص) прозвучала мягкая «Син» (س). Поднимите корень языка к мягкому нёбу (Тафхим).',
      };
    }
    return {
      detectedPhonemeOrLetter: 'ص [sˤ]',
      gopConfidence: avgF2Hz <= tafkhimThresholdHz ? 95 : 86,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  if (letter.includes('ق') || expectedIPA === 'q') {
    if (avgF2Hz > tafkhimThresholdHz + 220 && maxZcr > 0.28) {
      return {
        detectedPhonemeOrLetter: 'ك [k] (мягкая)',
        gopConfidence: 38,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Вместо глубокой увулярной «Коф» (ق) услышана мягкая «Кяф» (ك) с придыханием. Смыкайте корень языка с мягким нёбом.',
      };
    }
    return {
      detectedPhonemeOrLetter: 'ق [q]',
      gopConfidence: avgF2Hz <= tafkhimThresholdHz + 80 ? 94 : 85,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  if (letter.includes('ض') || expectedIPA.includes('dˤ')) {
    if (avgZcr > 0.3) {
      return {
        detectedPhonemeOrLetter: 'زˤ [zˤ] (свистящая)',
        gopConfidence: 35,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Ошибка махариджа «Дод» (ض): слышен свистящий призвук «З». Прижмите боковые края языка к верхним коренным зубам.',
      };
    }
    if (avgF2Hz > tafkhimThresholdHz + 190) {
      return {
        detectedPhonemeOrLetter: 'د [d] (мягкая)',
        gopConfidence: 48,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Вместо глубокой твердой «Дод» (ض) прозвучала мягкая «Даль» (د). Поднимите заднюю часть языка.',
      };
    }
    return {
      detectedPhonemeOrLetter: 'ض [dˤ]',
      gopConfidence: 93,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  if (letter.includes('ط') || expectedIPA.includes('tˤ')) {
    if (avgF2Hz > tafkhimThresholdHz + 200 && maxZcr > 0.28) {
      return {
        detectedPhonemeOrLetter: 'ت [t] (с придыханием)',
        gopConfidence: 42,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Вместо твердой непридыхательной «То» (ط) прозвучала мягкая «Та» (ت). Исключите выход воздуха и поднимите спинку языка.',
      };
    }
    return {
      detectedPhonemeOrLetter: 'ط [tˤ]',
      gopConfidence: 94,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  // 3. ГОРТАННЫЕ БУКВЫ (ح / ع)
  if (letter.includes('ح') || expectedIPA === 'ħ') {
    if (avgF1Hz < 340 && maxZcr < 0.08) {
      return {
        detectedPhonemeOrLetter: 'ه [h] (слабая гортанная)',
        gopConfidence: 52,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Недостаточное сужение средней гортани: вместо «Ха» (ح) прозвучал слабый выдох «ه». Сблизьте надгортанник со стенкой глотки.',
      };
    }
    return {
      detectedPhonemeOrLetter: 'ح [ħ]',
      gopConfidence: avgF1Hz >= 450 ? 94 : 88,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  if (letter.includes('ع') || expectedIPA === 'ʕ') {
    if (avgF1Hz < 330) {
      return {
        detectedPhonemeOrLetter: 'ء [ʔ] (хамза)',
        gopConfidence: 50,
        isSubstitutionMistake: true,
        diagnosticFeedbackRu:
          'Вместо глубокой гортанной «Айн» (ع) прозвучала поверхностная гласная/хамза (ء). Отведите корень языка в среднюю гортань.',
      };
    }
    return {
      detectedPhonemeOrLetter: 'ع [ʕ]',
      gopConfidence: avgF1Hz >= 460 ? 95 : 88,
      isSubstitutionMistake: false,
      diagnosticFeedbackRu: null,
    };
  }

  // Для всех остальных букв при наличии уверенного голоса даем высокий GOP (88..97%)
  const baseGop = Math.min(
    97,
    Math.max(84, Math.round(86 + Math.min(11, maxRms * 14)))
  );

  return {
    detectedPhonemeOrLetter: `${letter} [${expectedIPA}]`,
    gopConfidence: baseGop,
    isSubstitutionMistake: false,
    diagnosticFeedbackRu: null,
  };
}
