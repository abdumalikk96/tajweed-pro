'use client';

/**
 * Реальный двухконтурный модуль распознавания арабского чтения:
 * 1) Локальная нейросеть Whisper (`@huggingface/transformers` -> `Xenova/whisper-tiny` / `Xenova/whisper-base`)
 *    с фильтрацией тишины и галлюцинаций.
 * 2) Параллельный мгновенный захват арабских букв во время записи (`ar-SA`).
 */

export interface RealTranscriptionOutput {
  text: string;
  modelId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedWhisperPipeline: any = null;
let isPipelineLoading = false;

const WHISPER_HALLUCINATION_PHRASES = [
  'اشتركوا',
  'القناة',
  'ترجمة',
  'موسيقى',
  'شكرا',
  'شكراً',
  'لا تنسوا',
  'الإعجاب',
  'نانسي',
  'قناتي',
];

/**
 * Очищает результат ASR от неарабских символов и типичных галлюцинаций Whisper на коротких аудио.
 */
export function sanitizeRecognizedArabicText(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  for (const hall of WHISPER_HALLUCINATION_PHRASES) {
    if (trimmed.includes(hall)) {
      return '';
    }
  }
  // Оставляем только арабские буквы, огласовки и пробелы
  const arabicOnly = trimmed
    .replace(/[^\u0621-\u065F\u0670\u0671\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return arabicOnly;
}

export async function getOrLoadWhisperPipeline(
  onProgress?: (progressPct: number) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (typeof window === 'undefined') return null;
  if (cachedWhisperPipeline) return cachedWhisperPipeline;

  if (isPipelineLoading) {
    let waited = 0;
    while (isPipelineLoading && waited < 15000) {
      await new Promise((r) => setTimeout(r, 200));
      waited += 200;
    }
    return cachedWhisperPipeline;
  }

  isPipelineLoading = true;
  try {
    const transformers = await import('@huggingface/transformers');
    transformers.env.allowLocalModels = false;
    transformers.env.useBrowserCache = true;
    if (transformers.env.backends?.onnx?.wasm) {
      transformers.env.backends.onnx.wasm.wasmPaths =
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0/dist/';
    }

    const progressCb = (info: Record<string, unknown>) => {
      if (typeof info?.progress === 'number') {
        onProgress?.(Math.min(99, Math.round(info.progress)));
      }
    };

    try {
      cachedWhisperPipeline = await transformers.pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny',
        { progress_callback: progressCb }
      );
    } catch {
      cachedWhisperPipeline = await transformers.pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-base',
        { progress_callback: progressCb }
      );
    }

    onProgress?.(100);
    return cachedWhisperPipeline;
  } catch {
    return null;
  } finally {
    isPipelineLoading = false;
  }
}

export async function runWhisperOnFloat32(
  audioBuffer: Float32Array,
  onProgress?: (progressPct: number) => void
): Promise<RealTranscriptionOutput | null> {
  if (!audioBuffer || audioBuffer.length < 3200) return null;

  // Строгая проверка энергии: никогда не запускаем Whisper на тишине, чтобы исключить галлюцинации
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < audioBuffer.length; i++) {
    const s = audioBuffer[i];
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / audioBuffer.length);
  if (rms < 0.0005 && peak < 0.001) {
    return null;
  }

  try {
    const transcriber = await getOrLoadWhisperPipeline(onProgress);
    if (!transcriber) return null;

    const output = await transcriber(audioBuffer, {
      language: 'arabic',
      task: 'transcribe',
      chunk_length_s: 15,
    });

    const rawText = typeof output?.text === 'string' ? output.text.trim() : '';
    const cleanText = sanitizeRecognizedArabicText(rawText);
    if (!cleanText) return null;

    return {
      text: cleanText,
      modelId: 'Xenova/whisper-tiny',
    };
  } catch {
    return null;
  }
}

/**
 * Класс мгновенного параллельного слушателя арабской речи во время открытого микрофона.
 */
export class LiveArabicSpeechMonitor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognition: any = null;
  private transcript = '';

  public start(): void {
    this.transcript = '';
    if (typeof window === 'undefined') return;

    const SpeechRec =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).SpeechRecognition ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).webkitSpeechRecognition;

    if (!SpeechRec) return;

    try {
      const rec = new SpeechRec();
      rec.lang = 'ar-SA';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (event: any) => {
        let collected = '';
        for (let i = 0; i < event.results.length; i++) {
          collected += event.results[i][0].transcript + ' ';
        }
        this.transcript = sanitizeRecognizedArabicText(collected);
      };

      rec.onerror = () => {};
      rec.start();
      this.recognition = rec;
    } catch {
      this.recognition = null;
    }
  }

  public stop(): string {
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // ignore
      }
      this.recognition = null;
    }
    return sanitizeRecognizedArabicText(this.transcript);
  }

  public getLatestTranscript(): string {
    return sanitizeRecognizedArabicText(this.transcript);
  }
}
