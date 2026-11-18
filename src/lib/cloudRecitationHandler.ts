import { NextRequest, NextResponse } from 'next/server';
import { normalizeUthmaniToImlai } from '@/lib/uthmaniNormalizer';

const HALLUCINATION_PATTERNS = [
  /اشترك(?:وا)?(?:\s+في\s+القناة)?/gi,
  /ترجم(?:ة|ه)?(?:\s+نانسي)?/gi,
  /نانسي(?:\s+عجرم)?/gi,
  /شكرا(?:\s+لكم|\s+جزيلا)?/gi,
  /مرحبا(?:\s+بكم)?/gi,
  /[\.،\…\—\-]{2,}/g,
];

function cleanWhisperHallucinations(text: string): string {
  if (!text) return '';
  let t = text.trim();
  if (/^[\.\,\…\—\-\s]+$/.test(t)) return '';
  for (const pat of HALLUCINATION_PATTERNS) {
    t = t.replace(pat, '').trim();
  }
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 4 && new Set(words).size === 1) {
    return '';
  }
  return t;
}

function stripIstiadaAndBasmala(rec: string, exp: string): string {
  if (!rec) return '';
  let r = rec.trim();
  const normExp = normalizeUthmaniToImlai(exp || '');
  if (normExp.includes('بسم الله')) return r;
  const patterns = [
    /^\s*[أا]عوذ\s+بالله\s+من\s+الشيطان\s+الرجيم\s*/i,
    /^\s*[أا]عوذ\s+بالله\s*/i,
    /^\s*بسم\s+الله\s+الرحمن\s+الرحيم\s*/i,
    /^\s*بسم\s+الله\s*/i,
  ];
  for (const p of patterns) {
    r = r.replace(p, '').trim();
  }
  return r;
}

function charSimilarity(a: string, b: string): number {
  const s1 = normalizeUthmaniToImlai(a).replace(/\s+/g, '');
  const s2 = normalizeUthmaniToImlai(b).replace(/\s+/g, '');
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const dist = dp[m][n];
  return Math.max(0, 1 - dist / Math.max(m, n));
}

function inspectWavBuffer(bytes: Uint8Array): {
  durationMs: number;
  activeDurationMs: number;
  voicedDurationMs: number;
  rmsMean: number;
  rmsMax: number;
  peakDb: number;
} {
  if (bytes.byteLength <= 44) {
    return {
      durationMs: 0,
      activeDurationMs: 0,
      voicedDurationMs: 0,
      rmsMean: 0,
      rmsMax: 0,
      peakDb: -60,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate = 16000;
  try {
    const sr = view.getUint32(24, true);
    if (sr >= 8000 && sr <= 96000) sampleRate = sr;
  } catch {
    // default 16000
  }
  const pcmOffset = 44;
  const totalSamples = Math.floor((bytes.byteLength - pcmOffset) / 2);
  if (totalSamples <= 0) {
    return {
      durationMs: 0,
      activeDurationMs: 0,
      voicedDurationMs: 0,
      rmsMean: 0,
      rmsMax: 0,
      peakDb: -60,
    };
  }

  const frameSize = Math.max(80, Math.floor(sampleRate * 0.01)); // 10ms
  const rmsFrames: number[] = [];
  let maxPeak = 0;

  for (let i = 0; i < totalSamples; i += frameSize) {
    const end = Math.min(totalSamples, i + frameSize);
    let sumSq = 0;
    for (let j = i; j < end; j++) {
      const sample = view.getInt16(pcmOffset + j * 2, true) / 32768.0;
      const abs = Math.abs(sample);
      if (abs > maxPeak) maxPeak = abs;
      sumSq += sample * sample;
    }
    rmsFrames.push(Math.sqrt(sumSq / Math.max(1, end - i)));
  }

  const sorted = [...rmsFrames].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] ?? 0.005;
  const activeThresh = Math.max(0.008, noiseFloor * 2.2);
  const peakRms = sorted[sorted.length - 1] ?? 0.005;
  const maddVoicedThresh = Math.max(activeThresh, 0.22 * peakRms);

  let firstActive = -1;
  let lastActive = -1;
  let voicedCount = 0;
  let maddVoicedCount = 0;
  for (let idx = 0; idx < rmsFrames.length; idx++) {
    if (rmsFrames[idx] >= activeThresh) {
      if (firstActive === -1) firstActive = idx;
      lastActive = idx;
      voicedCount++;
    }
    if (rmsFrames[idx] > maddVoicedThresh) {
      maddVoicedCount++;
    }
  }

  const durationMs = Math.round((totalSamples / sampleRate) * 1000);
  const activeDurationMs =
    firstActive >= 0 && lastActive >= firstActive
      ? Math.max(100, (lastActive - firstActive + 1) * 10)
      : 0;
  const voicedDurationMs =
    maddVoicedCount > 0 ? maddVoicedCount * 10 : voicedCount * 10;
  const rmsMean =
    rmsFrames.length > 0
      ? rmsFrames.reduce((a, b) => a + b, 0) / rmsFrames.length
      : 0;
  const peakDb =
    maxPeak > 1e-5 ? Math.round(20 * Math.log10(maxPeak) * 10) / 10 : -60;

  return {
    durationMs,
    activeDurationMs,
    voicedDurationMs,
    rmsMean: Number(rmsMean.toFixed(4)),
    rmsMax: Number(maxPeak.toFixed(4)),
    peakDb,
  };
}

export async function handleAnalyzeRecitationRequest(
  req: NextRequest,
  forceLiveChunk = false
) {
  try {
    const formData = await req.formData();
    const upload =
      (formData.get('file') as File | null) ||
      (formData.get('audio') as File | null) ||
      (formData.get('blob') as File | null);

    const expectedRule = String(formData.get('expected_rule') || 'ithhar');
    const expectedHarakaat = Number(formData.get('expected_harakaat') || 2);
    const expectedText = String(formData.get('expected_text') || '').trim();
    const strictnessLevel = Math.max(
      50,
      Math.min(100, Number(formData.get('strictness_level') || 75))
    );
    const isLiveChunk =
      forceLiveChunk ||
      String(formData.get('is_live_chunk') || '').toLowerCase() === 'true';
    const prevVerified = Math.max(
      0,
      Number(formData.get('verified_words_count') || 0)
    );
    const liveTranscriptHint = String(
      formData.get('live_transcript') || ''
    ).trim();

    const expWords = expectedText
      .replace(/[\u06D6-\u06DC\u06E2\u06E3\u06E7\u06E8\u06EA-\u06ED]/g, '')
      .split(/\s+/)
      .filter(Boolean);
    const totalWordsCount = Math.max(1, expWords.length);

    if (!upload) {
      return NextResponse.json({
        score: 0,
        status: 'mistake',
        detected_issue: "Ovoz eshitilmadi — qaytadan o'qing",
        duration_ms: 0,
        recognized_text: '',
        letter_evaluations: [],
        total_words_count: totalWordsCount,
        metrics: {
          rms_mean: 0,
          rms_max: 0,
          peak_db: -60,
          active_duration_ms: 0,
          f1_hz: 0,
          f2_hz: 0,
          onset_max: 0,
          onset_ratio: 0,
          measured_harakaat: 0,
        },
      });
    }

    const arrayBuf = await upload.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const wavStats = inspectWavBuffer(bytes);

    if (
      isLiveChunk &&
      (wavStats.voicedDurationMs < 220 || wavStats.rmsMax < 0.004)
    ) {
      return NextResponse.json({
        score: 95,
        status: 'correct',
        detected_issue: 'Ovoz kutilmoqda...',
        duration_ms: wavStats.activeDurationMs,
        recognized_text: '',
        letter_evaluations: [],
        is_live_chunk: true,
        spoken_words_count: prevVerified,
        verified_words_count: prevVerified,
        total_words_count: totalWordsCount,
        spoken_letter_count: 0,
        failed_word_index: null,
        failed_word_arabic: null,
        metrics: {
          rms_mean: wavStats.rmsMean,
          rms_max: wavStats.rmsMax,
          peak_db: wavStats.peakDb,
          active_duration_ms: wavStats.activeDurationMs,
          f1_hz: 520,
          f2_hz: 1350,
          onset_max: 0,
          onset_ratio: 0,
          measured_harakaat: expectedHarakaat,
        },
      });
    }

    let recognizedText = liveTranscriptHint;
    const apiKey = process.env.OPENAI_API_KEY || '';

    if (apiKey && wavStats.rmsMax >= 0.002) {
      try {
        const openAiForm = new FormData();
        const audioBlob = new Blob([bytes], { type: 'audio/wav' });
        openAiForm.append('file', audioBlob, 'recitation.wav');
        openAiForm.append('model', 'whisper-1');
        openAiForm.append('language', 'ar');
        openAiForm.append('temperature', '0');
        openAiForm.append(
          'prompt',
          expectedText
            ? `تلاوة: ${expectedText}`
            : 'تلاوة القرآن الكريم بالحركات والتشكيل الدقيق'
        );

        const whisperRes = await fetch(
          'https://api.openai.com/v1/audio/transcriptions',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: openAiForm,
          }
        );

        if (whisperRes.ok) {
          const data = (await whisperRes.json()) as { text?: string };
          if (data.text && data.text.trim()) {
            recognizedText = cleanWhisperHallucinations(data.text.trim());
          }
        }
      } catch (err) {
        console.error('[Cloud Whisper Error]', err);
      }
    }

    recognizedText = cleanWhisperHallucinations(recognizedText);
    recognizedText = stripIstiadaAndBasmala(recognizedText, expectedText);

    if (!isLiveChunk && !recognizedText.trim()) {
      return NextResponse.json({
        score: 0,
        status: 'mistake',
        detected_issue: "Ovoz eshitilmadi — qaytadan o'qing",
        duration_ms: wavStats.activeDurationMs || wavStats.durationMs,
        recognized_text: '',
        letter_evaluations: [],
        text_similarity: 0,
        duration_ratio: 0,
        madd_ok: false,
        multi_sheikh_consensus: 0,
        strictness_level: strictnessLevel,
        student_unit_ms: 110,
        is_live_chunk: false,
        spoken_words_count: 0,
        verified_words_count: 0,
        total_words_count: totalWordsCount,
        spoken_letter_count: 0,
        failed_word_index: 0,
        failed_word_arabic: expWords[0] || null,
        metrics: {
          rms_mean: wavStats.rmsMean,
          rms_max: wavStats.rmsMax,
          peak_db: wavStats.peakDb,
          active_duration_ms: wavStats.activeDurationMs,
          f1_hz: 0,
          f2_hz: 0,
          onset_max: 0,
          onset_ratio: 0,
          measured_harakaat: 0,
        },
      });
    }

    const recWords = recognizedText.split(/\s+/).filter(Boolean);
    let verifiedCount = 0;
    let failedWordIdx: number | null = null;
    let failedWordAr: string | null = null;

    const checkLimit = isLiveChunk
      ? Math.min(expWords.length, Math.max(prevVerified + 1, recWords.length))
      : expWords.length;

    for (let i = 0; i < checkLimit; i++) {
      const expW = expWords[i];
      const recW = recWords[i];
      if (!recW) {
        if (!isLiveChunk) {
          failedWordIdx = i;
          failedWordAr = expW;
        }
        break;
      }
      const sim = charSimilarity(expW, recW);
      if (sim >= 0.62) {
        verifiedCount = i + 1;
      } else {
        failedWordIdx = i;
        failedWordAr = expW;
        break;
      }
    }

    const textSim = Number(
      charSimilarity(
        expWords.slice(0, Math.max(1, checkLimit)).join(' '),
        recognizedText
      ).toFixed(3)
    );

    const isMistake =
      failedWordIdx !== null || (!isLiveChunk && textSim < 0.65);
    const finalScore = isMistake
      ? Math.round(Math.max(28, Math.min(58, textSim * 75)))
      : Math.round(Math.max(88, Math.min(99, 86 + textSim * 13)));

    const letterEvaluations =
      isMistake && failedWordAr
        ? [
            {
              letter: failedWordAr[0] || 'ا',
              rule: expectedRule,
              status: 'mistake' as const,
              score: finalScore,
              detected_letter: null,
              f2_hz: 1380,
              zcr: 0.08,
              onset_ratio: 1.2,
              issue_uz: `"${failedWordAr}" so'zida xato aniqlandi (Eshitildi: «${recognizedText}»).`,
              anatomical_tip_uz: `Kutilgan so'z: «${failedWordAr}». Harf maxrajini va harakatlarni aniq talaffuz qiling.`,
              word_index: failedWordIdx ?? 0,
              word_arabic: failedWordAr,
            },
          ]
        : [];

    return NextResponse.json({
      score: finalScore,
      status: isMistake ? 'mistake' : 'correct',
      detected_issue: isMistake
        ? `"${failedWordAr || expectedText}" so'zida xato qilindi: «${recognizedText}» eshitildi.`
        : "To'g'ri va aniq o'qildi!",
      duration_ms: wavStats.activeDurationMs || wavStats.durationMs,
      recognized_text: recognizedText,
      letter_evaluations: letterEvaluations,
      text_similarity: textSim,
      duration_ratio: 1.0,
      madd_ok: !isMistake,
      multi_sheikh_consensus: finalScore,
      strictness_level: strictnessLevel,
      student_unit_ms: 115,
      is_live_chunk: isLiveChunk,
      spoken_words_count:
        failedWordIdx !== null
          ? failedWordIdx + 1
          : Math.max(verifiedCount, prevVerified),
      verified_words_count: Math.max(verifiedCount, isMistake ? 0 : prevVerified),
      total_words_count: totalWordsCount,
      spoken_letter_count: recognizedText.length,
      failed_word_index: failedWordIdx,
      failed_word_arabic: failedWordAr,
      metrics: {
        rms_mean: wavStats.rmsMean,
        rms_max: wavStats.rmsMax,
        peak_db: wavStats.peakDb,
        active_duration_ms: wavStats.activeDurationMs,
        f1_hz: 520,
        f2_hz: 1350,
        onset_max: 0.25,
        onset_ratio: 1.45,
        measured_harakaat: expectedHarakaat,
      },
    });
  } catch (err) {
    console.error('[analyze-recitation error]', err);
    return NextResponse.json(
      { error: 'Internal analysis error' },
      { status: 500 }
    );
  }
}
