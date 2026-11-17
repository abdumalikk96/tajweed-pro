/// <reference lib="webworker" />

import { pipeline, env } from '@huggingface/transformers';

// В браузерном воркере отключаем локальные файловые пути Node.js и указываем CDN для ONNX WASM
env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths =
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0/dist/';
}

export interface WorkerTranscribeChunk {
  text: string;
  timestamp: [number, number | null];
}

export interface WorkerTranscriptionOutput {
  text: string;
  chunks?: WorkerTranscribeChunk[];
  modelId: string;
}

const PRIMARY_QURAN_MODEL = 'Xenova/whisper-base';
const QURAN_SPECIALIZED_MODEL = 'tarteel-ai/whisper-base-ar-quran';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asrPipelineInstance: any = null;
let loadedModelId: string = PRIMARY_QURAN_MODEL;
let isInitializing = false;

async function getOrInitPipeline() {
  if (asrPipelineInstance) {
    return asrPipelineInstance;
  }
  if (isInitializing) {
    while (isInitializing) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return asrPipelineInstance;
  }

  isInitializing = true;
  self.postMessage({
    type: 'status',
    engineStatus: 'loading',
    loadingProgress: 5,
  });

  const progressCallback = (progressInfo: {
    status?: string;
    progress?: number;
    file?: string;
  }) => {
    if (typeof progressInfo.progress === 'number') {
      self.postMessage({
        type: 'progress',
        loadingProgress: Math.min(99, Math.round(progressInfo.progress)),
        file: progressInfo.file ?? '',
      });
    }
  };

  try {
    try {
      asrPipelineInstance = await pipeline(
        'automatic-speech-recognition',
        QURAN_SPECIALIZED_MODEL,
        {
          progress_callback: progressCallback,
        }
      );
      loadedModelId = QURAN_SPECIALIZED_MODEL;
    } catch {
      asrPipelineInstance = await pipeline(
        'automatic-speech-recognition',
        PRIMARY_QURAN_MODEL,
        {
          progress_callback: progressCallback,
        }
      );
      loadedModelId = PRIMARY_QURAN_MODEL;
    }

    self.postMessage({
      type: 'status',
      engineStatus: 'ready',
      loadingProgress: 100,
      modelId: loadedModelId,
    });
    return asrPipelineInstance;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Ошибка загрузки ONNX-весов модели';
    self.postMessage({
      type: 'status',
      engineStatus: 'error',
      error: message,
    });
    throw err;
  } finally {
    isInitializing = false;
  }
}

self.addEventListener('message', async (event: MessageEvent) => {
  const { type, audioBuffer, requestId } = event.data ?? {};

  if (type === 'warmup') {
    try {
      await getOrInitPipeline();
    } catch {
      // Ошибка уже отправлена в главный поток
    }
    return;
  }

  if (type === 'transcribe') {
    try {
      const transcriber = await getOrInitPipeline();
      self.postMessage({
        type: 'status',
        engineStatus: 'analyzing',
      });

      const float32Audio =
        audioBuffer instanceof Float32Array
          ? audioBuffer
          : new Float32Array(audioBuffer);

      const output = await transcriber(float32Audio, {
        language: 'arabic',
        task: 'transcribe',
        return_timestamps: 'word',
        chunk_length_s: 15,
      });

      const result: WorkerTranscriptionOutput = {
        text: typeof output?.text === 'string' ? output.text.trim() : '',
        chunks: Array.isArray(output?.chunks) ? output.chunks : [],
        modelId: loadedModelId,
      };

      self.postMessage({
        type: 'result',
        requestId,
        result,
      });

      self.postMessage({
        type: 'status',
        engineStatus: 'ready',
        loadingProgress: 100,
        modelId: loadedModelId,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Ошибка нейросетевого распознавания';
      self.postMessage({
        type: 'error',
        requestId,
        error: message,
      });
    }
  }
});
