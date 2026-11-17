'use client';

import React, { useState } from 'react';
import { VoiceCalibrationProfile } from '@/types/quran';
import { useRawAudioRecorder } from '@/hooks/useRawAudioRecorder';
import { extractAcousticFrames } from '@/lib/acousticAnalyzer';
import { trimSilence } from '@/lib/audioUtils';
import { cn } from '@/lib/utils';
import {
  Mic,
  Square,
  CheckCircle2,
  Sliders,
  X,
  Sparkles,
  Activity,
  RotateCcw,
} from 'lucide-react';

export const VOICE_CALIBRATION_STORAGE_KEY =
  'quran_trainer_voice_calibration_v1';

export const DEFAULT_CALIBRATION_PROFILE: VoiceCalibrationProfile = {
  isCalibrated: false,
  ambientNoiseRms: 0.006,
  basePitchF0Hz: 135,
  softLetterAvgF2Hz: 1620,
  heavyLetterAvgF2Hz: 1120,
  dynamicTafkhimThresholdHz: 1350,
  naturalHarakaMs: 520,
};

interface VoiceCalibrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProfile: VoiceCalibrationProfile;
  onSaveProfile: (profile: VoiceCalibrationProfile) => void;
}

export default function VoiceCalibrationModal({
  isOpen,
  onClose,
  currentProfile,
  onSaveProfile,
}: VoiceCalibrationModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [draftProfile, setDraftProfile] =
    useState<VoiceCalibrationProfile>(currentProfile);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const {
    isRecording,
    recordingDurationMs,
    liveRms,
    liveWaveform,
    startRecording,
    stopRecording,
  } = useRawAudioRecorder({ autoStopOnSilence: false });

  if (!isOpen) return null;

  // Шаг 1: Замер фонового шума комнаты (первые 1.2 сек) + чтение «Бисмилляхи» (F0 и длина хараката)
  const handleStep1Toggle = async () => {
    if (!isRecording) {
      setStatusMessage(null);
      await startRecording();
    } else {
      const buffer = await stopRecording();
      if (!buffer || buffer.length < 16000) {
        setStatusMessage(
          'Запись слишком короткая. Сначала помолчите 1–2 секунды, затем прочитайте «Бисмилляхи».'
        );
        return;
      }

      // 1. Замеряем шум комнаты по первым 1000 мс (или минимальным 20% окон)
      const frames = extractAcousticFrames(buffer, 16000);
      const sortedByRms = [...frames].sort((a, b) => a.rms - b.rms);
      const quietCount = Math.max(3, Math.floor(sortedByRms.length * 0.25));
      const quietRmsAvg =
        sortedByRms
          .slice(0, quietCount)
          .reduce((acc, f) => acc + f.rms, 0) / quietCount;
      const ambientNoiseRms = Number(
        Math.max(0.003, Math.min(0.025, quietRmsAvg)).toFixed(4)
      );

      // 2. Вычисляем базовую ноту голоса F0 и естественную длину 1 хараката на «Бисмилляхи» (~5 весовых единиц)
      const voicedPitches = frames
        .filter((f) => f.isVoiced && f.pitchF0Hz > 70)
        .map((f) => f.pitchF0Hz);

      const basePitchF0Hz =
        voicedPitches.length > 0
          ? Math.round(
              voicedPitches.reduce((a, b) => a + b, 0) / voicedPitches.length
            )
          : 135;

      const { startOffsetMs, endOffsetMs } = trimSilence(
        buffer,
        16000,
        Math.max(0.01, ambientNoiseRms * 2.2)
      );
      const activeSpeechMs = Math.max(600, endOffsetMs - startOffsetMs);
      const naturalHarakaMs = Math.max(
        260,
        Math.min(680, Math.round(activeSpeechMs / 4.5))
      );

      setDraftProfile((prev) => ({
        ...prev,
        ambientNoiseRms,
        basePitchF0Hz,
        naturalHarakaMs,
      }));
      setStep(2);
    }
  };

  // Шаг 2: Контраст Таркик «سَا» (Са) против Тафхим «صَا» (Со) для расчета dynamicTafkhimThresholdHz
  const handleStep2Toggle = async () => {
    if (!isRecording) {
      setStatusMessage(null);
      await startRecording();
    } else {
      const buffer = await stopRecording();
      if (!buffer || buffer.length < 12000) {
        setStatusMessage(
          'Запись слишком короткая. Произнесите четко мягкий слог «САА» (سَا), затем твердый «СОО» (صَا).'
        );
        return;
      }

      const frames = extractAcousticFrames(buffer, 16000);
      const voicedFrames = frames.filter((f) => f.isVoiced);
      if (voicedFrames.length < 6) {
        setStatusMessage(
          'Голос звучал слишком тихо. Повторите попытку, протягивая гласную после «Син» и «Сод».'
        );
        return;
      }

      // Делим вокализованные кадры на первую половину (мягкая سَا с высокой F2) и вторую половину (твердая صَا с низкой F2)
      const midIdx = Math.floor(voicedFrames.length / 2);
      const firstHalf = voicedFrames.slice(0, midIdx);
      const secondHalf = voicedFrames.slice(midIdx);

      const f2First = Math.round(
        firstHalf.reduce((acc, f) => acc + f.f2Hz, 0) /
          Math.max(1, firstHalf.length)
      );
      const f2Second = Math.round(
        secondHalf.reduce((acc, f) => acc + f.f2Hz, 0) /
          Math.max(1, secondHalf.length)
      );

      const softLetterAvgF2Hz = Math.max(1380, Math.max(f2First, f2Second));
      const heavyLetterAvgF2Hz = Math.min(1260, Math.min(f2First, f2Second));
      const dynamicTafkhimThresholdHz = Math.round(
        (softLetterAvgF2Hz + heavyLetterAvgF2Hz) / 2
      );

      const finalProfile: VoiceCalibrationProfile = {
        ...draftProfile,
        isCalibrated: true,
        softLetterAvgF2Hz,
        heavyLetterAvgF2Hz,
        dynamicTafkhimThresholdHz,
      };

      setDraftProfile(finalProfile);
      setStep(3);
    }
  };

  const handleConfirmCalibration = () => {
    onSaveProfile(draftProfile);
    onClose();
  };

  const handleResetDefault = () => {
    onSaveProfile(DEFAULT_CALIBRATION_PROFILE);
    setDraftProfile(DEFAULT_CALIBRATION_PROFILE);
    setStep(1);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl rounded-2xl bg-slate-900 border border-emerald-500/40 shadow-2xl overflow-hidden">
        {/* Шапка модального окна */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base sm:text-lg font-bold text-white">
              Акустическая калибровка микрофона и голоса
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Индикатор шагов */}
        <div className="px-6 pt-4 flex items-center gap-2">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={cn(
                'flex-1 h-1.5 rounded-full transition-all',
                step >= s ? 'bg-emerald-500' : 'bg-slate-800'
              )}
            />
          ))}
        </div>

        <div className="p-6 space-y-5">
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                  Шаг 1 из 2 • Фоновый шум комнаты, базовая нота F0 и темп
                </span>
                <h3 className="text-lg font-bold text-white">
                  Помолчите 1–2 секунды, затем прочитайте «Бисмилляхи»
                </h3>
                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  Нажмите кнопку записи, выдержите короткую паузу тишины для
                  замера шума микрофона, а затем спокойно произнесите:
                </p>
              </div>

              <div
                dir="rtl"
                className="rounded-2xl bg-slate-950 border border-slate-800 py-5 px-6 text-center font-arabic text-4xl sm:text-5xl text-emerald-300"
              >
                بِسْمِ ٱللَّهِ
              </div>

              {/* Мини-индикатор волны */}
              <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                <div className="flex justify-between text-xs font-mono text-slate-400 mb-2">
                  <span className="flex items-center gap-1.5">
                    <Activity
                      className={cn(
                        'w-3.5 h-3.5',
                        isRecording
                          ? 'text-rose-400 animate-pulse'
                          : 'text-slate-500'
                      )}
                    />
                    {isRecording ? 'Запись шага 1...' : 'Ожидание'}
                  </span>
                  <span>
                    {(recordingDurationMs / 1000).toFixed(1)} сек • RMS:{' '}
                    {liveRms.toFixed(3)}
                  </span>
                </div>
                <div className="h-10 flex items-end gap-1">
                  {liveWaveform.slice(0, 24).map((h, i) => (
                    <div
                      key={i}
                      className={cn(
                        'flex-1 rounded-t transition-all',
                        isRecording ? 'bg-emerald-500' : 'bg-slate-800'
                      )}
                      style={{ height: `${isRecording ? Math.max(10, h) : 12}%` }}
                    />
                  ))}
                </div>
              </div>

              {statusMessage && (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                  {statusMessage}
                </p>
              )}

              <button
                type="button"
                onClick={handleStep1Toggle}
                className={cn(
                  'w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all',
                  isRecording
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                )}
              >
                {isRecording ? (
                  <>
                    <Square className="w-4 h-4 fill-current" />
                    <span>Завершить Шаг 1</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4" />
                    <span>Начать замер Шага 1</span>
                  </>
                )}
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                  Шаг 2 из 2 • Калибровка форманты F2 (Таркик vs Тафхим)
                </span>
                <h3 className="text-lg font-bold text-white">
                  Произнесите мягкий слог «САА» (سَا), затем твердый «СОО» (صَا)
                </h3>
                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  Это позволит DSP-движку вычислить ваш индивидуальный порог
                  второй форманты F2 между мягкими и твердыми буквами Истиъля.
                </p>
              </div>

              <div
                dir="rtl"
                className="grid grid-cols-2 gap-4 text-center font-arabic text-4xl sm:text-5xl"
              >
                <div className="rounded-2xl bg-slate-950 border border-sky-500/30 py-4 text-sky-300">
                  سَا
                  <span
                    dir="ltr"
                    className="block text-xs font-sans text-slate-400 mt-1"
                  >
                    1. Мягко (Таркик)
                  </span>
                </div>
                <div className="rounded-2xl bg-slate-950 border border-amber-500/40 py-4 text-amber-300">
                  صَا
                  <span
                    dir="ltr"
                    className="block text-xs font-sans text-slate-400 mt-1"
                  >
                    2. Твердо (Тафхим)
                  </span>
                </div>
              </div>

              {statusMessage && (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                  {statusMessage}
                </p>
              )}

              <button
                type="button"
                onClick={handleStep2Toggle}
                className={cn(
                  'w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all',
                  isRecording
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-amber-600 hover:bg-amber-500 text-white'
                )}
              >
                {isRecording ? (
                  <>
                    <Square className="w-4 h-4 fill-current" />
                    <span>Остановить и рассчитать порог F2</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4" />
                    <span>Записать «سَا ... صَا»</span>
                  </>
                )}
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2.5 text-emerald-400">
                <CheckCircle2 className="w-6 h-6" />
                <h3 className="text-lg font-bold text-white">
                  Персональный акустический профиль готов!
                </h3>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                  <span className="text-slate-400 block">Фоновый шум RMS:</span>
                  <strong className="text-sm font-mono text-emerald-300">
                    {draftProfile.ambientNoiseRms}
                  </strong>
                </div>
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                  <span className="text-slate-400 block">Базовый тон F0:</span>
                  <strong className="text-sm font-mono text-sky-300">
                    {draftProfile.basePitchF0Hz} Гц
                  </strong>
                </div>
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                  <span className="text-slate-400 block">
                    Мягкая F2 (س) / Твердая F2 (ص):
                  </span>
                  <strong className="text-sm font-mono text-amber-300">
                    {draftProfile.softLetterAvgF2Hz} /{' '}
                    {draftProfile.heavyLetterAvgF2Hz} Гц
                  </strong>
                </div>
                <div className="rounded-xl bg-slate-950 border border-emerald-500/30 p-3">
                  <span className="text-slate-400 block">
                    Персональный порог Тафхима:
                  </span>
                  <strong className="text-sm font-mono text-emerald-400">
                    ≤ {draftProfile.dynamicTafkhimThresholdHz} Гц
                  </strong>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleConfirmCalibration}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm flex items-center justify-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Сохранить и применить профиль</span>
                </button>
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium"
                >
                  Повторить
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Нижняя строка сброса к заводским настройкам */}
        <div className="px-6 py-3 bg-slate-950/90 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>
            Текущий порог Тафхима F2:{' '}
            <strong className="text-slate-200 font-mono">
              {draftProfile.dynamicTafkhimThresholdHz} Гц
            </strong>
          </span>
          <button
            type="button"
            onClick={handleResetDefault}
            className="inline-flex items-center gap-1 text-slate-400 hover:text-rose-300 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Сбросить к стандартным порогам</span>
          </button>
        </div>
      </div>
    </div>
  );
}
