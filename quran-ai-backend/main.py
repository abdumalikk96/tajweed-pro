import io
import os
import re
import struct
import wave
from difflib import SequenceMatcher
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, Tuple

import av
import numpy as np
import parselmouth
from fastapi import FastAPI, Form, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from openai import OpenAI

# Анатомические инструкции для Махраджа на узбекском языке
MAKHRAJ_ANATOMICAL_INSTRUCTIONS: Dict[str, str] = {
    "ق": "Til ildizini (orqasini) yumshoq tanglayga tekkizib, chuqur va yo'g'on talaffuz qiling (oddiy «ك» kabi oldinga surmang).",
    "ك": "Til orqasini qattiq tanglayga yaqinlashtirib, nafas oqimi (hams) bilan yumshoq chiqaring.",
    "ط": "Til uchini oldingi yuqori tishlar tubiga qo'yib, til o'rtasini tanglayga ko'tarib yo'g'on o'qing (oddiy «ت» bo'lib qolmasin).",
    "ت": "Til uchini yuqori tishlar tubiga tekshirib, yengil nafas bilan yumshoq chiqaring.",
    "ص": "Til uchini pastki tishlar orqasiga qo'yib, til orqasini ko'targan holda yo'g'on hushtak bilan chiqaring (oddiy «س» emas).",
    "س": "Til uchini pastki oldingi tishlar orqasiga qo'yib, ingichka va mayin hushtak bilan talaffuz qiling.",
    "ض": "Tilning yon qirrasini yuqori oziq tishlarga yopishtirib, cho'ziqroq va yo'g'on ovozda chiqaring (oddiy «د» yoki «ز» emas).",
    "ظ": "Til uchini oldingi yuqori tishlar qirrasidan biroz chiqarib, yo'g'on holda o'qing (hushtak chiqarmang).",
    "ذ": "Til uchini oldingi yuqori tishlar chetidan biroz chiqarib, mayin va hushtaksiz o'qing (oddiy «ز» emas).",
    "ث": "Til uchini oldingi tishlar orasiga qo'yib, havoni erkin chiqarib mayin ayting (oddiy «س» kabi hushtak chalmang).",
    "خ": "Halqumning yuqori qismidan (tilcha yonidan) xirillagan yo'g'on tovush bilan chiqaring.",
    "غ": "Halqumning yuqori qismidan tomoqni qirmasdan, yo'g'on va g'uldiragan ohangda chiqaring.",
    "ح": "Tomoq o'rtasini (halqum) biroz qisib, toza va issiq havo oqimi bilan talaffuz qiling (oddiy «ه» emas).",
    "ع": "Halqum (tomoq) o'rtasini qattiqroq siqib, chuqur va bo'g'iq ovoz bilan chiqaring (oddiy «А» yoki hamza emas).",
    "ه": "Tomoqning eng tubidan (ko'krakka yaqin) erkin nafas chiqarish orqali o'qing.",
    "ء": "Ovoz pardalarini bir lahzaga to'liq yopib ochish orqali aniq hamza bilan talaffuz qiling.",
    "ج": "Til o'rtasini qattiq tanglayga to'liq yopishtirib, qattiq va jarangdor chiqaring.",
    "ش": "Til o'rtasini tanglayga yaqinlashtirib, og'iz bo'shlig'iga havoni yoyib (tafashshiy) chiqaring.",
    "ي": "Til o'rtasini tanglayga ko'tarib, havoni qismasdan ravon chiqaring.",
    "ر": "Til uchining orqa qismini tanglayga 1-2 marta yengil urib chiqaring (ko'p qaltiramang).",
    "ل": "Til uchining ikki yonini oldingi tanglayga tekkizib, ravshan va mayin ayting.",
    "ن": "Til uchini yuqori tishlar milkiga qo'yib, ovozni dimog'dan (g'unna bilan) chiqaring.",
    "م": "Ikkala labni bir-biriga yengil yopib, ovozning bir qismini dimog'dan chiqaring.",
    "ب": "Ikkala labning nam qismini qattiqroq jipslashtirib, keskin va jarangdor oching.",
    "ف": "Oldingi yuqori tishlar uchini pastki labning ichki qismiga qo'yib, havo bilan chiqaring.",
    "و": "Ikkala labni oldinga cho'chchaytirib doira qilib, lablarni bir-biriga tekkizmasdan chiqaring.",
}

# Матрица путаницы махраджей (какая буква часто подменяется какой)
MAKHRAJ_CONFUSION_PAIRS: Dict[str, List[str]] = {
    "ق": ["ك", "g"],
    "ك": ["ق"],
    "ط": ["ت", "d"],
    "ت": ["ط", "s"],
    "ص": ["س", "z"],
    "س": ["ص", "ث"],
    "ض": ["د", "ز", "z"],
    "ظ": ["ز", "ذ", "س"],
    "ذ": ["ز", "д", "d"],
    "ث": ["س", "ت", "t"],
    "ح": ["ه", "x", "h"],
    "ع": ["ا", "ء", "hamza", "a"],
    "خ": ["ح", "h"],
    "غ": ["q", "g"],
}

HEAVY_LETTERS = ["ق", "ط", "ص", "ض", "ظ", "خ", "غ"]
SOFT_PAIRS_OF_HEAVY = ["ك", "ت", "س", "د", "ز", "ذ"]

SOLAR_LETTERS = set("تثدذرزسشصضطظلن")
WAQF_MARKS_REGEX = re.compile(r"[\u06D6-\u06DC\u06E2\u06E3\u06E7\u06E8\u06EA-\u06ED]")

VOWEL_CHARS = set(['\u064B', '\u064C', '\u064D', '\u064E', '\u064F', '\u0650'])

VOWEL_NAMES_UZ = {
    '\u064E': "Fatha (a)",
    '\u0650': "Kasra (i)",
    '\u064F': "Damma (u)",
    '\u064B': "Tanvin fatha (an)",
    '\u064D': "Tanvin kasra (in)",
    '\u064C': "Tanvin damma (un)",
    'fatha': "Fatha (a)",
    'kasra': "Kasra (i)",
    'damma': "Damma (u)",
    'tanween_fath': "Tanvin fatha (an)",
    'tanween_kasr': "Tanvin kasra (in)",
    'tanween_damm': "Tanvin damma (un)",
    'tanween_fatha': "Tanvin fatha (an)",
    'tanween_kasra': "Tanvin kasra (in)",
    'tanween_damma': "Tanvin damma (un)",
}

VOWEL_TIPS_UZ = {
    'kasra': "Pastki jag'ni biroz tushirib, ingichka va aniq «i» qilib talaffuz qiling.",
    'tanween_kasr': "Pastki jag'ni biroz tushirib, ingichka va aniq «i» qilib talaffuz qiling.",
    'tanween_kasra': "Pastki jag'ni biroz tushirib, ingichka va aniq «i» qilib talaffuz qiling.",
    'damma': "Og'izni keng ochmasdan, lablarni oldinga to'liq cho'chchaytirib (doira qilib), toza «u» chiqaring.",
    'tanween_damm': "Og'izni keng ochmasdan, lablarni oldinga to'liq cho'chchaytirib (doira qilib), toza «u» chiqaring.",
    'tanween_damma': "Og'izni keng ochmasdan, lablarni oldinga to'liq cho'chchaytirib (doira qilib), toza «u» chiqaring.",
    'fatha': "Og'izni tabiiy ochib, tilni orqaga tortmay ravshan «a» chiqaring.",
    'tanween_fath': "Og'izni tabiiy ochib, tilni orqaga tortmay ravshan «a» chiqaring.",
    'tanween_fatha': "Og'izni tabiiy ochib, tilni orqaga tortmay ravshan «a» chiqaring.",
}

class PhoneticLetterUnit(BaseModel):
    base_char: str
    raw_char: str
    vowel: Optional[str] = None
    has_shaddah: bool = False
    has_madd_wave: bool = False
    has_dagger_alif: bool = False
    is_silent: bool = False
    is_ta_marbuta: bool = False
    is_final: bool = False
    is_madd_arid: bool = False
    weight: float = 1.0
    word_index: int = 0
    word_arabic: str = ""

class LetterEvaluation(BaseModel):
    letter: str
    rule: str
    status: Literal["perfect", "warning", "mistake"]
    score: float
    detected_letter: Optional[str] = None
    f2_hz: Optional[float] = None
    zcr: Optional[float] = None
    onset_ratio: Optional[float] = None
    issue_uz: str
    anatomical_tip_uz: str
    word_index: Optional[int] = None
    word_arabic: Optional[str] = None

class AcousticMetrics(BaseModel):
    rms_mean: float
    rms_max: float
    peak_db: float
    active_duration_ms: int
    f1_hz: float
    f2_hz: float
    onset_max: float
    onset_ratio: float
    measured_harakaat: float

class AnalyzeRecitationResponse(BaseModel):
    score: float
    status: Literal["correct", "mistake"]
    detected_issue: str
    duration_ms: int
    metrics: AcousticMetrics
    recognized_text: str = ""
    letter_evaluations: List[LetterEvaluation] = []
    text_similarity: float = 1.0
    duration_ratio: Optional[float] = None
    madd_ok: bool = True
    multi_sheikh_consensus: float = 95.0
    strictness_level: int = 75
    student_unit_ms: float = 110.0
    is_live_chunk: bool = False
    spoken_words_count: int = 0
    verified_words_count: int = 0
    total_words_count: int = 0
    spoken_letter_count: int = 0
    failed_word_index: Optional[int] = None
    failed_word_arabic: Optional[str] = None

# База данных акустических профилей 10 всемирно признанных чтецов (Multi-Sheikh Consensus Reference Engine)
TEN_SHEIKHS_ACOUSTIC_PROFILES: Dict[str, Dict[str, Any]] = {
    "husary": {
        "name_uz": "Shayx Mahmud Xalil Al-Xusariy (Muallim)",
        "everyayah_folder": "Husary_128kbps",
        "pace_haraka_ms_range": (115.0, 155.0),
        "madd_ratios": {"madd_2": (1.85, 2.35), "madd_4": (3.7, 4.5), "madd_6": (5.6, 6.6)},
        "tafkhim_f2_drop_ratio": 0.78,
        "envelope_smoothness": 0.92,
    },
    "minshawi": {
        "name_uz": "Shayx Muhammad Siddiq Al-Minshaviy",
        "everyayah_folder": "Minshawy_Murattal_128kbps",
        "pace_haraka_ms_range": (112.0, 150.0),
        "madd_ratios": {"madd_2": (1.85, 2.30), "madd_4": (3.6, 4.4), "madd_6": (5.5, 6.5)},
        "tafkhim_f2_drop_ratio": 0.79,
        "envelope_smoothness": 0.94,
    },
    "abdulbasit": {
        "name_uz": "Shayx Abdulbosit Abdussomad",
        "everyayah_folder": "Abdul_Basit_Murattal_192kbps",
        "pace_haraka_ms_range": (110.0, 148.0),
        "madd_ratios": {"madd_2": (1.90, 2.40), "madd_4": (3.8, 4.6), "madd_6": (5.7, 6.7)},
        "tafkhim_f2_drop_ratio": 0.77,
        "envelope_smoothness": 0.93,
    },
    "afasy": {
        "name_uz": "Shayx Mishariy Roshid Al-Afasiy",
        "everyayah_folder": "Alafasy_128kbps",
        "pace_haraka_ms_range": (100.0, 136.0),
        "madd_ratios": {"madd_2": (1.75, 2.25), "madd_4": (3.5, 4.3), "madd_6": (5.4, 6.4)},
        "tafkhim_f2_drop_ratio": 0.80,
        "envelope_smoothness": 0.91,
    },
    "sudais": {
        "name_uz": "Shayx Abdurrahmon As-Sudays",
        "everyayah_folder": "Abdurrahmaan_As-Sudais_192kbps",
        "pace_haraka_ms_range": (88.0, 122.0),
        "madd_ratios": {"madd_2": (1.65, 2.15), "madd_4": (3.3, 4.1), "madd_6": (5.1, 6.1)},
        "tafkhim_f2_drop_ratio": 0.82,
        "envelope_smoothness": 0.88,
    },
    "shuraym": {
        "name_uz": "Shayx Saud Ash-Shuraym",
        "everyayah_folder": "Saood_ash-Shuraym_128kbps",
        "pace_haraka_ms_range": (85.0, 118.0),
        "madd_ratios": {"madd_2": (1.65, 2.10), "madd_4": (3.2, 4.0), "madd_6": (5.0, 6.0)},
        "tafkhim_f2_drop_ratio": 0.82,
        "envelope_smoothness": 0.87,
    },
    "ghamadi": {
        "name_uz": "Shayx Sa'd Al-G'omidiy",
        "everyayah_folder": "Ghamadi_40kbps",
        "pace_haraka_ms_range": (98.0, 132.0),
        "madd_ratios": {"madd_2": (1.75, 2.25), "madd_4": (3.5, 4.3), "madd_6": (5.3, 6.3)},
        "tafkhim_f2_drop_ratio": 0.80,
        "envelope_smoothness": 0.90,
    },
    "muaiqly": {
        "name_uz": "Shayx Mohir Al-Muayqliy",
        "everyayah_folder": "MaherAlMuaiqly128kbps",
        "pace_haraka_ms_range": (95.0, 128.0),
        "madd_ratios": {"madd_2": (1.70, 2.20), "madd_4": (3.4, 4.2), "madd_6": (5.2, 6.2)},
        "tafkhim_f2_drop_ratio": 0.81,
        "envelope_smoothness": 0.90,
    },
    "shatri": {
        "name_uz": "Shayx Abu Bakr Ash-Shatiriy",
        "everyayah_folder": "Abu_Bakr_Ash-Shaatree_128kbps",
        "pace_haraka_ms_range": (102.0, 138.0),
        "madd_ratios": {"madd_2": (1.80, 2.30), "madd_4": (3.6, 4.4), "madd_6": (5.4, 6.4)},
        "tafkhim_f2_drop_ratio": 0.79,
        "envelope_smoothness": 0.92,
    },
    "ayyoub": {
        "name_uz": "Shayx Muhammad Ayyub",
        "everyayah_folder": "Muhammad_Ayyoub_128kbps",
        "pace_haraka_ms_range": (108.0, 144.0),
        "madd_ratios": {"madd_2": (1.85, 2.35), "madd_4": (3.7, 4.5), "madd_6": (5.5, 6.5)},
        "tafkhim_f2_drop_ratio": 0.78,
        "envelope_smoothness": 0.93,
    },
}

app = FastAPI(title="Tajweed Pro — Quran AI Engine with Deep Makhraj Analysis")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _load_env_key() -> str:
    val = os.getenv("OPENAI_API_KEY", "").strip()
    if val:
        return val
    for rel in [".env", os.path.join("..", ".env")]:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), rel)
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("OPENAI_API_KEY="):
                            return line.split("=", 1)[1].strip().strip('"').strip("'")
            except Exception:
                pass
    return ""

OPENAI_API_KEY = _load_env_key()
client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

def decode_audio_bytes(audio_bytes: bytes, target_sr: int = 16000) -> np.ndarray:
    try:
        container = av.open(io.BytesIO(audio_bytes))
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=target_sr)
        samples = []
        for frame in container.decode(audio=0):
            frame.pts = None
            for r_frame in resampler.resample(frame):
                samples.append(r_frame.to_ndarray()[0])
        if not samples:
            return np.array([], dtype=np.float32)
        return np.concatenate(samples).astype(np.float32)
    except Exception as e:
        print(f"[Audio Decode Warning] {e}")
        return np.array([], dtype=np.float32)

def encode_wav_in_memory(y: np.ndarray, sample_rate: int = 16000) -> bytes:
    """Конвертирует float32 аудио-массив в 16-bit PCM WAV в памяти с помощью wave и struct."""
    clamped = np.clip(y, -1.0, 1.0)
    int16_samples = (clamped * 32767.0).astype(np.int16)
    
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(int16_samples.tobytes())
    return buf.getvalue()

def normalize_arabic(text: str, keep_harakaat: bool = True) -> str:
    """
    Стандартная нормализация арабского текста.
    По умолчанию сохраняет огласовки (фатха, касра, дамма, танвины, шадда, сукун)
    для честной проверки харакатов (Lahn Jali).
    Удаляет только внетекстовые коранические знаки остановок (вакф) и декоративные маркеры.
    """
    if not text:
        return ""
    cleaned = WAQF_MARKS_REGEX.sub('', text)
    cleaned = re.sub(r'[\u0617-\u061A\u06D6-\u06ED]', '', cleaned)
    if not keep_harakaat:
        cleaned = re.sub(r'[\u064B-\u0652\u0670]', '', cleaned)
    cleaned = re.sub(r'[إأآٱ]', 'ا', cleaned)
    cleaned = re.sub(r'ة', 'ه', cleaned)
    cleaned = re.sub(r'ى', 'ي', cleaned)
    if keep_harakaat:
        cleaned = re.sub(r'[^\u0621-\u064A\u064B-\u0652\u0670\s]', '', cleaned)
    else:
        cleaned = re.sub(r'[^\u0621-\u064A\s]', '', cleaned)
    return re.sub(r'\s+', ' ', cleaned).strip()

def normalize_arabic_phonetic(text: str, keep_harakaat: bool = True) -> str:
    """
    Фонетическая нормализация Усманийского расма в реальное звучание (для сопоставления с Whisper):
    - Алиф ханджария ٰ -> ا
    - واو и ى с ханджарией (الصَّلَوٰةَ, عَلَىٰ) -> ا
    - Немой алиф с круглым нулем \u06DF (قَالُوا۟) -> قالوا
    - Сохраняет огласовки (харакаты) при keep_harakaat=True
    """
    if not text:
        return ""
    cleaned = WAQF_MARKS_REGEX.sub('', text)
    cleaned = re.sub(r'[\u0621-\u064A][\u06DF\u06E0]', '', cleaned)
    cleaned = re.sub(r'[وى]\u0670', 'ا', cleaned)
    cleaned = re.sub(r'\u0670', 'ا', cleaned)
    cleaned = re.sub(r'[إأآٱ]', 'ا', cleaned)
    cleaned = re.sub(r'ة', 'ه', cleaned)
    cleaned = re.sub(r'ى', 'ي', cleaned)
    cleaned = re.sub(r'[\u0617-\u061A\u06D6-\u06ED]', '', cleaned)
    if not keep_harakaat:
        cleaned = re.sub(r'[\u064B-\u0652]', '', cleaned)
        cleaned = re.sub(r'[^\u0621-\u064A\s]', '', cleaned)
    else:
        cleaned = re.sub(r'[^\u0621-\u064A\u064B-\u0652\s]', '', cleaned)
    return re.sub(r'\s+', ' ', cleaned).strip()

def normalize_uthmani_to_imlai(text: str) -> str:
    """
    Каноническая нормализация Усманийского расма Мусхафа к современному орфографическому стандарту (Имлаи):
    - Специфические составные обращения, указательные местоимения и слитные формы:
      (يَٰٓأَيُّهَا -> ياايها, يَٰٓأَبَتِ -> ياابت, هَٰٓؤُلَآءِ -> هاولاء, أُو۟لَٰٓئِكَ -> اولئك, هَٰذَا -> هذا, هَٰذِهِ -> هذه, ذَٰلِكَ -> ذلك, لَٰكِنَّ -> لكن)
    - Усманийские написания с вав и алиф-ханджарией (ٱلصَّلَوٰةَ -> الصلاة/الصلاه, ٱلزَّكَوٰةَ -> الزكاة, ٱلْحَيَوٰةِ -> الحياة, ٱلرِّبَوٰا۟ -> الربا)
    - Алиф ханджария (مَٰلِكِ -> مالك, ٱلْعَٰلَمِينَ -> العالمين, ٱلرَّحْمَٰنِ -> الرحمن)
    - Удаление нечитаемых знаков (круглый сукун \u06DF / \u06E0, малый вав \u06E5, малый йа \u06E6, знак мадда \u0653)
    - Унификация всех видов хамзы/алифа [إأآٱءؤئى] -> ا, та марбута ة -> ه
    """
    if not text:
        return ""
    t = text
    # 1. Нечитаемые усманийские знаки
    t = re.sub(r'[\u06DF\u06E0\u06E5\u06E6\u0653]', '', t)
    # 2. Специфические составные обращения и слитные формы
    t = re.sub(r'يَ?\s*ٰ?\s*ٓ?\s*أَيُّ?\s*هَ\s*ا', 'ياايها', t)
    t = re.sub(r'يا\s+أ?يها', 'ياايها', t)
    t = re.sub(r'يَ?\s*ٰ?\s*ٓ?\s*أَبَتِ?', 'ياابت', t)
    t = re.sub(r'هَ?\s*ٰ?\s*ٓ?\s*ؤُلَ\s*آ?\s*ءِ?', 'هاولاء', t)
    t = re.sub(r'ه[ؤو]ل[اآ]ء?', 'هاولاء', t)
    t = re.sub(r'أُو۟?\s*لَ\s*ٰ?\s*ٓ?\s*ئِ\s*كَ', 'اولئك', t)
    t = re.sub(r'ا[وؤ]ل[اآئ]ك', 'اولئك', t)
    t = re.sub(r'هَ?\s*ٰ?\s*ذَ\s*ا', 'هذا', t)
    t = re.sub(r'هَ?\s*ٰ?\s*ذِ\s*هِ', 'هذه', t)
    t = re.sub(r'ذَ?\s*ٰ?\s*لِ\s*كَ', 'ذلك', t)
    t = re.sub(r'لَ?\s*ٰ?\s*كِ\s*نَّ?', 'لكن', t)
    # 3. Вав и йа с алиф-ханджарией
    t = re.sub(r'و[\u064B-\u065F]*\u0670', 'ا', t)
    t = re.sub(r'ي[\u064B-\u065F]*\u0670', 'ا', t)
    t = re.sub(r'ى[\u064B-\u065F]*\u0670', 'ا', t)
    # 4. Одиночная алиф-ханджария
    t = re.sub(r'\u0670', 'ا', t)
    # 5. Снятие огласовок и коранических знаков
    t = re.sub(r'[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED]', '', t)
    # 6. Унификация хамз и окончаний
    t = re.sub(r'[إأآٱءؤئى]', 'ا', t)
    t = re.sub(r'ة', 'ه', t)
    # 7. Сжатие сдвоенных алифов
    t = re.sub(r'ا+', 'ا', t)
    t = re.sub(r'[^\u0621-\u064A\s]', '', t)
    return re.sub(r'\s+', ' ', t).strip()

def strip_istiada_and_basmala(rec: str, exp: str) -> str:
    """
    Удаляет произнесенную чтецом Исти'азу (أعوذ بالله...) и Басмалу (بسم الله...)
    из начала распознанного текста Whisper, ЕСЛИ ожидаемый аят не является сурой 1:1.
    Это предотвращает смещение слов и ложные ошибки на первом слове любого аята.
    """
    if not rec:
        return ""
    r = rec.strip()
    e = (exp or "").strip()
    norm_e = re.sub(r'[^\u0621-\u064A\s]', '', e)
    # Если ожидаемый текст сам начинается со слов بسم الله (например, Аль-Фатиха 1:1), ничего не вырезаем
    if "بسم الله" in norm_e:
        return r

    patterns = [
        r'^\s*أعوذ\s+بالله\s+من\s+الشيطان\s+الرجيم\s*',
        r'^\s*اعوذ\s+بالله\s+من\s+الشيطان\s+الرجيم\s*',
        r'^\s*أعوذ\s+بالله\s*',
        r'^\s*اعوذ\s+بالله\s*',
        r'^\s*بسم\s+الله\s+الرحمن\s+الرحيم\s*',
        r'^\s*بسم\s+الله\s*',
    ]
    for p in patterns:
        r = re.sub(p, '', r, flags=re.IGNORECASE).strip()
    return r

WHISPER_HALLUCINATION_PATTERNS = [
    re.compile(r'اشترك(?:وا)?(?:\s+في\s+القناة)?', re.IGNORECASE),
    re.compile(r'ترجم(?:ة|ه)?(?:\s+نانسي)?', re.IGNORECASE),
    re.compile(r'نانسي(?:\s+عجرم)?', re.IGNORECASE),
    re.compile(r'شكرا(?:\s+لكم|\s+جزيلا)?', re.IGNORECASE),
    re.compile(r'مرحبا(?:\s+بكم)?', re.IGNORECASE),
    re.compile(r'[\.،\…\—\-]{2,}'),
]

def clean_whisper_hallucinations(text: str) -> str:
    """Удаляет известные арабские галлюцинации Whisper на тишине/дыхании."""
    if not text:
        return ""
    t = text.strip()
    if re.fullmatch(r'[\.\,\…\—\-\s]+', t):
        return ""
    for pat in WHISPER_HALLUCINATION_PATTERNS:
        t = pat.sub('', t).strip()
    words = t.split()
    if len(words) >= 4 and len(set(words)) == 1:
        return ""
    return t

def parse_recitation_phonemes(raw_text: str) -> List[PhoneticLetterUnit]:
    """
    Разбирает арабский текст (слово или аят в Усманийском расме) на точные фонетические единицы:
    - Извлекает огласовки (fatha, kasra, damma, tanween, sukun)
    - Фиксирует шадду (удвоение)
    - Обрабатывает алиф ханджария ٰ
    - Обрабатывает немые буквы (буквы с круглым нулевым сукуном \u06DF)
    - Обрабатывает солнечные буквы (ассимиляция лама в ٱلرَّحْمَٰنِ)
    - Отмечает последнюю букву слова/фразы (is_final) для правил Вакфа (остановки на сукун)
    """
    if not raw_text:
        return []

    cleaned = WAQF_MARKS_REGEX.sub('', raw_text).strip()
    words = cleaned.split()
    if not words:
        return []

    arabic_letter_pat = re.compile(r'[\u0621-\u064A\u0671]')
    units: List[PhoneticLetterUnit] = []

    for w_idx, target in enumerate(words):
        is_al_solar = False
        m_solar = re.match(r'^[ٱا]ل([\u0621-\u064A])', target)
        if m_solar and m_solar.group(1) in SOLAR_LETTERS:
            is_al_solar = True

        i = 0
        n = len(target)
        while i < n:
            char = target[i]

            if char == '\u0670':
                units.append(
                    PhoneticLetterUnit(
                        base_char='ا',
                        raw_char='ٰ',
                        vowel=None,
                        has_shaddah=False,
                        has_madd_wave=False,
                        has_dagger_alif=True,
                        is_silent=False,
                        is_ta_marbuta=False,
                        is_final=False,
                        weight=2.2,
                        word_index=w_idx,
                        word_arabic=target,
                    )
                )
                i += 1
                continue

            if arabic_letter_pat.match(char):
                diacritics = []
                j = i + 1
                while j < n and not arabic_letter_pat.match(target[j]):
                    diacritics.append(target[j])
                    j += 1

                d_str = ''.join(diacritics)
                has_shaddah = '\u0651' in d_str
                has_madd_wave = '\u0653' in d_str or '\u06E4' in d_str or char == 'آ'
                has_round_zero = '\u06DF' in d_str or '\u06E0' in d_str
                has_dagger = '\u0670' in d_str

                vowel = None
                if '\u064E' in d_str:
                    vowel = 'fatha'
                elif '\u0650' in d_str:
                    vowel = 'kasra'
                elif '\u064F' in d_str:
                    vowel = 'damma'
                elif '\u064B' in d_str:
                    vowel = 'tanween_fath'
                elif '\u064D' in d_str:
                    vowel = 'tanween_kasr'
                elif '\u064C' in d_str:
                    vowel = 'tanween_damm'
                elif '\u0652' in d_str or '\u06E1' in d_str:
                    vowel = 'sukun'

                base_char = char
                is_silent = False
                is_ta_marbuta = (char == 'ة')

                if has_round_zero:
                    is_silent = True

                if is_al_solar and i == 1 and char == 'ل':
                    is_silent = True

                if char == 'ٱ':
                    base_char = 'ا'

                if char in ['و', 'ى'] and has_dagger:
                    base_char = 'ا'
                    has_dagger = True
                    vowel = None
                elif char == 'ة':
                    base_char = 'ه'
                elif char == 'ى':
                    base_char = 'ي'
                elif char in ['إ', 'أ', 'آ']:
                    base_char = 'ا'

                # Канонические фонетические веса:
                # обычная согласная + краткая гласная = 1.0; согласная + сукун = 0.6;
                # согласная + ташдид = 1.8; буква + madd_2 / гунна = 2.2;
                # madd_4 = 4.0; madd_6 = 5.5; нечитаемая буква = 0.05.
                if is_silent:
                    weight = 0.05
                elif has_madd_wave:
                    is_lazim = False
                    if j < n:
                        next_part = target[j:]
                        if '\u0651' in next_part or '\u0652' in next_part or '\u06E1' in next_part:
                            is_lazim = True
                    weight = 5.5 if is_lazim else 4.0
                elif (has_shaddah and base_char in ['ن', 'م']) or vowel in ['tanween_fath', 'tanween_kasr', 'tanween_damm']:
                    weight = 2.2
                elif char not in ['ٱ', 'إ', 'أ', 'ء'] and (base_char in ['ا', 'و', 'ي'] or has_dagger):
                    weight = 2.2
                elif has_shaddah:
                    weight = 1.8
                elif vowel == 'sukun' or '\u0652' in d_str or '\u06E1' in d_str:
                    weight = 0.6
                else:
                    weight = 1.0

                raw_cluster = char + d_str

                units.append(
                    PhoneticLetterUnit(
                        base_char=base_char,
                        raw_char=raw_cluster,
                        vowel=vowel,
                        has_shaddah=has_shaddah,
                        has_madd_wave=has_madd_wave,
                        has_dagger_alif=has_dagger,
                        is_silent=is_silent,
                        is_ta_marbuta=is_ta_marbuta,
                        is_final=False,
                        weight=weight,
                        word_index=w_idx,
                        word_arabic=target,
                    )
                )

                if has_dagger and char not in ['و', 'ى', 'ا', 'ٱ']:
                    units.append(
                        PhoneticLetterUnit(
                            base_char='ا',
                            raw_char='ٰ',
                            vowel=None,
                            has_shaddah=False,
                            has_madd_wave=False,
                            has_dagger_alif=True,
                            is_silent=False,
                            is_ta_marbuta=False,
                            is_final=False,
                            weight=2.2,
                            word_index=w_idx,
                            word_arabic=target,
                        )
                    )

                i = j
            else:
                i += 1

    # Отмечаем последнюю звучащую букву для правила Вакфа и предпоследний Мадд (Madd 'Arid lis-Sukoon)
    sounding_indices = [idx for idx, u in enumerate(units) if not u.is_silent]
    if sounding_indices:
        last_sound_idx = sounding_indices[-1]
        units[last_sound_idx].is_final = True
        if len(sounding_indices) >= 2:
            prev_sound_idx = sounding_indices[-2]
            prev_u = units[prev_sound_idx]
            if prev_u.base_char in ['ا', 'و', 'ي'] or prev_u.has_dagger_alif or prev_u.has_madd_wave:
                prev_u.is_madd_arid = True

    return units

def align_phonetic_slices_to_energy_envelope(
    y_signal: np.ndarray,
    units: List[PhoneticLetterUnit],
    sample_rate: int = 16000
) -> List[Tuple[PhoneticLetterUnit, int, int]]:
    """
    Сегментирует аудиосигнал пропорционально фонетическим весам (Item 2),
    с привязкой межсегментных границ к локальным впадинам энергии (RMS) между согласными и гласными/маддами.
    Это предотвращает наплыв согласных на смежные сегменты Мадда.
    """
    total_len = len(y_signal)
    if total_len == 0 or not units:
        return []

    total_weight = sum(u.weight for u in units) or 1.0
    frame_len = 160  # 10 ms
    hop_len = 80     # 5 ms

    y_padded = np.pad(y_signal, (0, frame_len), mode='constant')
    rms_envelope = [
        float(np.sqrt(np.mean(y_padded[i : i + frame_len] ** 2)))
        for i in range(0, total_len, hop_len)
    ]
    env_len = len(rms_envelope)

    # 1. Номинальные границы пропорционально весу фонем
    nominal_boundaries = []
    cum_w = 0.0
    for u in units:
        cum_w += u.weight
        nominal_boundaries.append(int((cum_w / total_weight) * total_len))
    nominal_boundaries[-1] = total_len

    # 2. Уточнение границ по локальным минимумам RMS (окно поиска ±35 мс)
    refined_boundaries = [0]
    search_window_frames = 7  # 35 ms

    for i in range(len(units) - 1):
        u_curr = units[i]
        u_next = units[i + 1]
        nom_sample = nominal_boundaries[i]
        nom_frame = max(0, min(env_len - 1, nom_sample // hop_len))

        is_trans_cons_vowel = (
            (u_curr.base_char not in ['ا', 'و', 'ي'] and not u_curr.has_dagger_alif) and
            (u_next.base_char in ['ا', 'و', 'ي'] or u_next.has_dagger_alif or u_next.has_madd_wave)
        )
        is_trans_vowel_cons = (
            (u_curr.base_char in ['ا', 'و', 'ي'] or u_curr.has_dagger_alif or u_curr.has_madd_wave) and
            (u_next.base_char not in ['ا', 'و', 'ي'] and not u_next.has_dagger_alif)
        )

        if is_trans_cons_vowel or is_trans_vowel_cons:
            low_f = max(0, nom_frame - search_window_frames)
            high_f = min(env_len - 1, nom_frame + search_window_frames)
            if high_f > low_f:
                sub_env = rms_envelope[low_f : high_f + 1]
                min_rel_idx = int(np.argmin(sub_env))
                best_frame = low_f + min_rel_idx
                best_sample = min(total_len, max(0, best_frame * hop_len))
                refined_boundaries.append(best_sample)
            else:
                refined_boundaries.append(nom_sample)
        else:
            refined_boundaries.append(nom_sample)

    refined_boundaries.append(total_len)

    # 3. Формирование упорядоченных срезов
    slices: List[Tuple[PhoneticLetterUnit, int, int]] = []
    for idx, unit in enumerate(units):
        start_s = refined_boundaries[idx]
        end_s = max(start_s + 160, refined_boundaries[idx + 1])
        end_s = min(total_len, end_s)
        if start_s >= end_s:
            start_s = max(0, end_s - 160)
        slices.append((unit, start_s, end_s))

    return slices

def extract_letters_with_weights(raw_text: str) -> List[Tuple[str, float]]:
    """Сохраняем обратную совместимость: возвращает список кортежей (буква, вес)."""
    units = parse_recitation_phonemes(raw_text)
    return [(u.base_char, u.weight) for u in units if not u.is_silent]

def extract_base_arabic_letters(text: str) -> List[str]:
    """Извлекает чистые арабские буквы слова без огласовок и спецсимволов."""
    norm = normalize_arabic(text)
    return [ch for ch in norm if re.match(r'[\u0621-\u064A]', ch)]

def compute_zcr(signal: np.ndarray) -> float:
    """Zero-Crossing Rate (частота пересечения нуля сигналом)."""
    if len(signal) < 2:
        return 0.0
    zero_crosses = np.nonzero(np.diff(signal > 0))[0]
    return float(len(zero_crosses) / len(signal))

def compute_high_freq_ratio(signal: np.ndarray, sample_rate: int = 16000) -> float:
    """Доля высокочастотной энергии (выше 3500 Гц) через FFT."""
    if len(signal) < 64:
        return 0.0
    fft = np.abs(np.fft.rfft(signal))
    freqs = np.fft.rfftfreq(len(signal), d=1.0 / sample_rate)
    total_energy = np.sum(fft ** 2) + 1e-9
    hf_energy = np.sum(fft[freqs >= 3500] ** 2)
    return float(hf_energy / total_energy)

def compute_voiced_madd_duration_ms(signal: np.ndarray, sample_rate: int = 16000) -> float:
    """
    Вычисляет длительность удержания гласной (Мадда / Гунны) строго по участку
    вокализованной энергии (где rms > 0.22 * peak_rms и zcr < 0.30 внутри слога),
    исключая глухие согласные и паузы между словами.
    """
    if len(signal) < 160:
        return float((len(signal) / max(1, sample_rate)) * 1000.0)
    frame_len = max(80, sample_rate // 100)  # 10 мс (160 отсчетов при 16 кГц)
    rms_list: List[float] = []
    zcr_list: List[float] = []
    for i in range(0, len(signal) - frame_len + 1, frame_len):
        frame = signal[i : i + frame_len]
        rms_val = float(np.sqrt(np.mean(frame ** 2)))
        zcr_val = compute_zcr(frame)
        rms_list.append(rms_val)
        zcr_list.append(zcr_val)
    if not rms_list:
        return float((len(signal) / max(1, sample_rate)) * 1000.0)
    peak_rms = max(0.002, max(rms_list))
    voiced_thresh = 0.22 * peak_rms
    voiced_frames = sum(
        1 for r, z in zip(rms_list, zcr_list) if r > voiced_thresh and z < 0.30
    )
    if voiced_frames == 0:
        return float((len(signal) / max(1, sample_rate)) * 1000.0 * 0.65)
    return float(voiced_frames * 10.0)

@dataclass
class LetterCluster:
    base_char: str
    raw_char: str
    vowel: Optional[str]
    has_shaddah: bool
    has_madd: bool
    madd_type: Optional[str]
    is_silent: bool
    is_final: bool

def extract_letters_with_harakats(text: str) -> List[LetterCluster]:
    """
    Разбивает арабский текст на массив кластеров с точным извлечением:
    (базовая_буква, огласовка, шадда, долгий_мадд, статус_немой, вакф_финал).
    """
    if not text:
        return []
    cleaned = WAQF_MARKS_REGEX.sub('', text).strip()
    words = cleaned.split()
    all_clusters: List[LetterCluster] = []
    arabic_letter_pat = re.compile(r'[\u0621-\u064A\u0671]')

    for w_idx, word in enumerate(words):
        is_last_word = (w_idx == len(words) - 1)
        i = 0
        n = len(word)
        word_clusters: List[LetterCluster] = []

        while i < n:
            ch = word[i]
            if ch == '\u0670':  # Standalone dagger alif
                if word_clusters:
                    word_clusters[-1].has_madd = True
                    word_clusters[-1].madd_type = 'dagger_alif'
                    word_clusters[-1].raw_char += 'ٰ'
                i += 1
                continue

            if arabic_letter_pat.match(ch):
                diacritics = []
                j = i + 1
                while j < n and not arabic_letter_pat.match(word[j]):
                    diacritics.append(word[j])
                    j += 1
                d_str = ''.join(diacritics)
                has_shaddah = '\u0651' in d_str
                has_dagger = '\u0670' in d_str
                has_madd_wave = '\u0653' in d_str or '\u06E4' in d_str
                has_round_zero = '\u06DF' in d_str or '\u06E0' in d_str

                vowel = None
                if '\u064E' in d_str:
                    vowel = 'fatha'
                elif '\u0650' in d_str:
                    vowel = 'kasra'
                elif '\u064F' in d_str:
                    vowel = 'damma'
                elif '\u064B' in d_str:
                    vowel = 'tanween_fath'
                elif '\u064D' in d_str:
                    vowel = 'tanween_kasr'
                elif '\u064C' in d_str:
                    vowel = 'tanween_damm'
                elif '\u0652' in d_str or '\u06E1' in d_str:
                    vowel = 'sukun'

                base = ch
                if ch in ['ٱ', 'إ', 'أ', 'آ']:
                    base = 'ا'
                elif ch in ['و', 'ى', 'ي'] and has_dagger:
                    base = 'ا'
                elif ch == 'ة':
                    base = 'ه'
                elif ch == 'ى':
                    base = 'ي'

                is_silent = has_round_zero
                # Проверка солнечного лама: 'ال' перед буквой с шаддой
                if i == 1 and ch == 'ل' and len(word) > 2 and word[0] in ['ٱ', 'ا'] and '\u0651' in word[2:]:
                    is_silent = True

                has_madd = has_dagger or has_madd_wave
                madd_type = 'dagger_alif' if has_dagger else ('madd_wave' if has_madd_wave else None)

                # Проверяем, идет ли следом внутри ЭТОГО ЖЕ слова буква мадда (ا / و / ي) без собственных огласовок
                absorbed_next_alif = False
                absorbed_next_end = j
                if j < n and arabic_letter_pat.match(word[j]):
                    next_ch = word[j]
                    k = j + 1
                    next_d = []
                    while k < n and not arabic_letter_pat.match(word[k]):
                        next_d.append(word[k])
                        k += 1
                    next_d_str = ''.join(next_d)
                    has_next_vowels = any(
                        v in next_d_str
                        for v in ['\u064E', '\u0650', '\u064F', '\u064B', '\u064C', '\u064D', '\u0651']
                    )

                    if next_ch in ['ا', 'ى'] and not has_next_vowels and base not in ['ا', 'و', 'ي'] and (vowel in ['fatha', 'tanween_fath', None]):
                        has_madd = True
                        madd_type = 'alif'
                        d_str += next_ch + next_d_str
                        absorbed_next_alif = True
                        absorbed_next_end = k
                    elif next_ch == 'و' and not has_next_vowels and (vowel in ['damma', 'tanween_damm', None]):
                        has_madd = True
                        madd_type = 'waw'
                    elif next_ch == 'ي' and not has_next_vowels and (vowel in ['kasra', 'tanween_kasr', None]):
                        has_madd = True
                        madd_type = 'ya'

                word_clusters.append(
                    LetterCluster(
                        base_char=base,
                        raw_char=ch + d_str,
                        vowel=vowel,
                        has_shaddah=has_shaddah,
                        has_madd=has_madd,
                        madd_type=madd_type,
                        is_silent=is_silent,
                        is_final=False,
                    )
                )
                i = absorbed_next_end if absorbed_next_alif else j
            else:
                i += 1

        if is_last_word and word_clusters:
            for idx in range(len(word_clusters) - 1, -1, -1):
                if not word_clusters[idx].is_silent and (word_clusters[idx].base_char not in ['ا', 'ى'] or word_clusters[idx].vowel):
                    word_clusters[idx].is_final = True
                    break

        all_clusters.extend(word_clusters)

    return all_clusters

def compare_clusters(exp_clusters: List[LetterCluster], rec_clusters: List[LetterCluster]) -> List[Dict[str, Any]]:
    """
    Прямое посимвольное сопоставление кластеров:
    - Сверяет базовые буквы, явно распознанные огласовки, ташдид и мадд.
    - НЕ штрафует за отсутствие харакатов, шадды или алиф-ханджарии (\u0670), если Whisper вернул
      неогласованный текст (например, «الحمد لله رب العالمين» для «ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ»).
    - Фиксирует ошибку хараката/мадда только тогда, когда в ответе Whisper присутствует ЯВНО ДРУГОЙ
      харакат или лишняя/пропущенная долгая гласная буква (например, «أَرْحَمْنَا» вместо «ٱلرَّحْمَٰنِ»).
    """
    audible_exp = [c for c in exp_clusters if not c.is_silent]
    audible_rec = [c for c in rec_clusters if not c.is_silent]

    exp_bases = ''.join(c.base_char for c in audible_exp)
    rec_bases = ''.join(c.base_char for c in audible_rec)

    sm = SequenceMatcher(None, exp_bases, rec_bases)
    mistakes: List[Dict[str, Any]] = []

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for exp_idx, rec_idx in zip(range(i1, i2), range(j1, j2)):
                ec = audible_exp[exp_idx]
                rc = audible_rec[rec_idx]
                added_for_this_cluster = False

                # 1. Проверка Ташдида по тексту Whisper:
                # Штрафуем ТОЛЬКО если Whisper явно распознал сукун вместо шадды (например, رْ в أَرْحَمْنَا вместо رَّ).
                # Если Whisper просто вернул текст без значка шадды — это норма для ASR, не ошибка!
                if ec.has_shaddah and not rc.has_shaddah and rc.vowel == 'sukun':
                    mistakes.append({
                        'letter': ec.raw_char,
                        'base_char': ec.base_char,
                        'rule': 'tashdid',
                        'status': 'mistake',
                        'score': 35.0,
                        'issue': f"«{ec.raw_char}» harfidagi tashdid (shadda ّ) o'rniga sukun o'qildi.",
                        'tip': "Tashdidli harfni bir zum to'xtatib, bosim va kuch bilan ikki barobar cho'zib talaffuz qiling.",
                        'expected': ec.base_char,
                        'recognized': rc.raw_char,
                    })
                    added_for_this_cluster = True

                # 2. Проверка Харакатов (ТОЛЬКО если Whisper явно вернул ДРУГОЙ харакат):
                if ec.vowel and rc.vowel and ec.vowel != rc.vowel:
                    # Вакф на сукун разрешен только на последней букве и БЕЗ лишнего мадда
                    if ec.is_final and rc.vowel == 'sukun' and not rc.has_madd:
                        pass
                    else:
                        exp_v_name = VOWEL_NAMES_UZ.get(ec.vowel, ec.vowel)
                        rec_v_name = VOWEL_NAMES_UZ.get(rc.vowel, rc.vowel)
                        madd_note = " va ortiqcha Alif" if (rc.has_madd and not ec.has_madd) else ""
                        mistakes.append({
                            'letter': ec.raw_char,
                            'base_char': ec.base_char,
                            'rule': 'harakat',
                            'status': 'mistake',
                            'score': 35.0,
                            'issue': f"«{ec.raw_char}» harfida harakat xato: {exp_v_name} o'rniga {rec_v_name}{madd_note} talaffuz qilindi.",
                            'tip': VOWEL_TIPS_UZ.get(ec.vowel, "Harakatni toza va aniq talaffuz qiling."),
                            'expected': ec.base_char,
                            'recognized': rc.raw_char,
                        })
                        added_for_this_cluster = True

                # 3. Проверка лишнего Мадда только на последней букве (например, نَا вместо نِ),
                # НЕ штрафуем орфографические варианты Мусхафа внутри слова (такие как مَٰلِكِ / مَالِكِ),
                # где длительность мадда проверяется акустическим таймингом!
                if (
                    not added_for_this_cluster
                    and ec.is_final
                    and not ec.has_madd
                    and rc.has_madd
                    and ec.base_char not in ['ا', 'و', 'ي']
                ):
                    exp_v_name = VOWEL_NAMES_UZ.get(ec.vowel, "qisqa harakat") if ec.vowel else "qisqa harakat"
                    mistakes.append({
                        'letter': ec.raw_char,
                        'base_char': ec.base_char,
                        'rule': 'harakat',
                        'status': 'mistake',
                        'score': 35.0,
                        'issue': f"«{ec.raw_char}» harfida harakat xato: {exp_v_name} o'rniga ortiqcha cho'zish (Alif/Madd) talaffuz qilindi.",
                        'tip': VOWEL_TIPS_UZ.get(ec.vowel, "Harakatni ortiqcha cho'zmasdan, me'yorida o'qing."),
                        'expected': ec.base_char,
                        'recognized': rc.raw_char,
                    })
                    added_for_this_cluster = True

                # 4. Проверка сброшенного Мадда (ТОЛЬКО если Whisper явно поставил сукун на месте мадда, как مْ вместо مَٰ):
                # Отсутствие значка \u0670 (алиф-ханджария) в строке Whisper НЕ является ошибкой!
                if not added_for_this_cluster and ec.has_madd and not rc.has_madd and rc.vowel == 'sukun':
                    mistakes.append({
                        'letter': ec.raw_char,
                        'base_char': ec.base_char,
                        'rule': 'madd_2',
                        'status': 'mistake',
                        'score': 35.0,
                        'issue': f"«{ec.raw_char}» harfidagi madd (cho'zish) tushib qoldi.",
                        'tip': "Madd harfini to'liq 2 harakat miqdorida cho'zib talaffuz qiling.",
                        'expected': ec.base_char,
                        'recognized': rc.raw_char,
                    })

        elif tag == 'replace':
            for exp_idx in range(i1, i2):
                ec = audible_exp[exp_idx]
                if ec.base_char in ('ا', 'ٱ') and not any(h in ec.raw_char for h in ('أ', 'إ', 'ء')):
                    continue
                mistakes.append({
                    'letter': ec.raw_char,
                    'base_char': ec.base_char,
                    'rule': 'makhraj_critical',
                    'status': 'mistake',
                    'score': 30.0,
                    'issue': f"«{ec.raw_char}» o'rniga boshqa harf eshitildi.",
                    'tip': "Harf maxrajini to'g'ri chiqaring.",
                    'expected': ec.base_char,
                    'recognized': 'boshqa harf',
                })
        elif tag == 'delete':
            for exp_idx in range(i1, i2):
                ec = audible_exp[exp_idx]
                # Не штрафуем пустой Алиф и Хамзатуль-васл (ا / ٱ без хамзы) за махрадж
                if ec.base_char in ('ا', 'ٱ') and not any(h in ec.raw_char for h in ('أ', 'إ', 'ء')):
                    continue
                mistakes.append({
                    'letter': ec.raw_char,
                    'base_char': ec.base_char,
                    'rule': 'makhraj_critical',
                    'status': 'mistake',
                    'score': 25.0,
                    'issue': f"«{ec.raw_char}» harfi tushib qoldi yoki aytilmadi.",
                    'tip': "So'zdagi barcha harflarni to'liq talaffuz qiling.",
                    'expected': ec.base_char,
                    'recognized': None,
                })

    return mistakes

VOWEL_CENTROIDS = {
    'fatha': (650.0, 1400.0, "Fatha (a)"),
    'kasra': (350.0, 2100.0, "Kasra (i)"),
    'damma': (380.0, 950.0, "Damma (u)"),
}

def normalize_speaker_formants_vtln(
    f1: float,
    f2: float,
    speaker_f0_hz: float = 135.0,
    speaker_f2_median: float = 1450.0,
) -> Tuple[float, float]:
    """
    Индивидуальная калибровка тембра (VTLN / Speaker Normalization):
    Нормализует форманты F1/F2 относительно среднего тона (F0) и резонанса голосового
    тракта самого ученика, чтобы высокий, низкий, детский или взрослый голос оценивался
    справедливо по чистоте произношения правил, а не по схожести тембра с одним шейхом.
    """
    safe_f0 = max(75.0, min(400.0, speaker_f0_hz or 135.0))
    f0_warp = float(np.clip((135.0 / safe_f0) ** 0.30, 0.80, 1.20))
    safe_f2_med = max(950.0, min(2100.0, speaker_f2_median or 1450.0))
    tract_warp = float(np.clip((1450.0 / safe_f2_med) ** 0.25, 0.85, 1.15))
    combined_warp = 0.55 * f0_warp + 0.45 * tract_warp
    return float(f1 * combined_warp), float(f2 * combined_warp)

def classify_nearest_vowel(
    f1: float,
    f2: float,
    target_base: Optional[str] = None,
    tolerance_scale: float = 1.0,
) -> Tuple[str, str]:
    """
    Классифицирует измеренные форманты (F1, F2) к ближайшему центроиду гласных:
    - Фатха [a]: F1 ≈ 650 Hz, F2 ≈ 1400 Hz
    - Касра [i]: F1 ≈ 350 Hz, F2 ≈ 2100 Hz
    - Дамма [u]: F1 ≈ 380 Hz, F2 ≈ 950 Hz
    С учетом масштаба строгости tolerance_scale (при 50% допуск в 1.6 раза шире).
    """
    best_vowel = 'fatha'
    best_dist = float('inf')
    best_name = "Fatha (a)"
    dists: Dict[str, float] = {}
    for v_key, (c_f1, c_f2, name_uz) in VOWEL_CENTROIDS.items():
        dist = float(np.sqrt(((f1 - c_f1) * 2.0) ** 2 + (f2 - c_f2) ** 2))
        dists[v_key] = dist
        if dist < best_dist:
            best_dist = dist
            best_vowel = v_key
            best_name = name_uz

    # При пониженной строгости (tolerance_scale > 1.0) прощаем пограничные отклонения тембра,
    # если целевой гласный находится в пределах допустимого окна (радиус 340 * tolerance_scale Гц)
    if target_base and target_base in VOWEL_CENTROIDS and best_vowel != target_base and tolerance_scale > 1.05:
        target_dist = dists.get(target_base, float('inf'))
        allowed_window = 340.0 * tolerance_scale
        if target_dist <= allowed_window and (target_dist - best_dist) <= 130.0 * (tolerance_scale - 0.8):
            return target_base, VOWEL_CENTROIDS[target_base][2]

    return best_vowel, best_name

def evaluate_madd_by_ten_sheikhs_consensus(
    measured_harakaat: float,
    exp_harakaat: float,
    student_unit_ms: float,
    strictness_level: int = 75,
    is_arid_lis_sukoon: bool = False,
) -> Tuple[bool, float, str]:
    """
    Оценивает Мадд (2, 4–5 или 6 харакатов) относительно СОБСТВЕННОГО темпа ученика (student_unit_ms)
    по каноническим целям:
    - Madd Tabiiy (2 хараката): норма 1.6 – 2.8 хараката.
    - Madd Wajib Muttasil / Jaiz Munfasil (4–5 харакатов): норма 3.3 – 5.5 харакатов.
    - Madd Lazim (6 харакатов): норма 4.8 – 6.8 харакатов.
    Если чтец уложился в коридор (с учетом ползунка строгости strictness_level), выставляет 98–100% perfect.
    """
    strictness_clamped = max(50, min(100, strictness_level))
    strictness_slack = ((100.0 - strictness_clamped) / 50.0) * 0.25

    if is_arid_lis_sukoon:
        arid_min = max(1.2, 1.6 - strictness_slack)
        arid_max = 6.8 + strictness_slack
        if arid_min <= measured_harakaat <= arid_max:
            return True, 99.0, ""
        elif measured_harakaat < arid_min:
            deficit_score = round(max(40.0, (measured_harakaat / 1.6) * 82.0), 1)
            return (
                False,
                deficit_score,
                f"Madd 'Ariz lis-sukun qisqa o'qildi: amalda {measured_harakaat:.1f} harakat cho'zildi, qoida bo'yicha kamida 2 harakat (me'yor: 1.6–6.8 harakat) cho'zish kerak!",
            )
        else:
            excess_score = round(max(70.0, 95.0 - (measured_harakaat - arid_max) * 8.0), 1)
            return True, excess_score, ""

    if exp_harakaat >= 5.5:
        base_min, base_max = 4.8, 6.8
        rule_title_uz = "Madd Lazim (6 harakat)"
        target_h = 6
    elif exp_harakaat >= 3.5:
        base_min, base_max = 3.3, 5.5
        rule_title_uz = "Madd Wajib Muttasil / Jaiz Munfasil (4–5 harakat)"
        target_h = 4
    else:
        base_min, base_max = 1.6, 2.8
        rule_title_uz = "Madd Tabiiy (2 harakat)"
        target_h = 2

    corridor_min = max(0.8, round(base_min - strictness_slack, 2))
    corridor_max = round(base_max + strictness_slack, 2)

    if corridor_min <= measured_harakaat <= corridor_max:
        return True, 99.0, ""

    if measured_harakaat < corridor_min:
        deficit_ratio = max(0.25, measured_harakaat / max(corridor_min, 0.5))
        consensus_score = round(max(30.0, deficit_ratio * 78.0), 1)
        issue = (
            f"{rule_title_uz} qisqa o'qildi: amalda {measured_harakaat:.1f} harakat cho'zildi, "
            f"qoida bo'yicha {target_h} harakat (me'yor: {base_min:.1f}–{base_max:.1f} harakat) cho'zish kerak!"
        )
        return False, consensus_score, issue

    excess_score = round(max(65.0, 92.0 - (measured_harakaat - corridor_max) * 8.0), 1)
    issue = (
        f"{rule_title_uz} haddan ortiq cho'zildi: amalda {measured_harakaat:.1f} harakat o'qildi, "
        f"qoida bo'yicha {target_h} harakat (me'yor: {base_min:.1f}–{base_max:.1f} harakat) bo'lishi kerak."
    )
    return True, excess_score, issue

def compute_arabic_similarity(expected: str, recognized: str) -> Tuple[float, str, List[Dict[str, Any]]]:
    """
    Честное сравнение ожидаемого арабского текста (с учетом харакатов и орфографии Мусхафа)
    и текста от Whisper с выявлением перепутанных букв и неверных огласовок (харакатов).
    """
    if not recognized or not recognized.strip():
        return 0.0, "Ovozdan birorta ham so'z aniqlanmadi.", []

    # 0. Каноническая нормализация Усмани <-> Имлаи
    imlai_exp = normalize_uthmani_to_imlai(expected)
    imlai_rec = normalize_uthmani_to_imlai(recognized)
    imlai_sim = SequenceMatcher(None, imlai_exp, imlai_rec).ratio()

    # 1. Прямое кластерное сопоставление букв, харакатов и маддов
    exp_clusters = extract_letters_with_harakats(expected)
    rec_clusters = extract_letters_with_harakats(recognized)
    cluster_mistakes = compare_clusters(exp_clusters, rec_clusters)

    # Если скелет слова полностью совпадает по Усмани/Имлаи, фильтруем ложные ошибки махраджа
    if imlai_exp == imlai_rec or imlai_sim >= 0.85:
        cluster_mistakes = [
            cm for cm in cluster_mistakes
            if cm.get("rule") not in ("makhraj_critical",)
        ]

    letter_confusions: List[Dict[str, Any]] = list(cluster_mistakes)

    # Тексты с сохранением харакатов:
    norm_exp_std = normalize_arabic(expected, keep_harakaat=True)
    norm_exp_pho = normalize_arabic_phonetic(expected, keep_harakaat=True)
    norm_rec = normalize_arabic(recognized, keep_harakaat=True)

    # Тексты без харакатов (чистый скелет согласных):
    bare_exp_std = normalize_arabic(expected, keep_harakaat=False)
    bare_exp_pho = normalize_arabic_phonetic(expected, keep_harakaat=False)
    bare_rec = normalize_arabic(recognized, keep_harakaat=False)

    # Точное совпадение с харакатами:
    if norm_rec in [norm_exp_std, norm_exp_pho] and not cluster_mistakes:
        return 1.0, "", []

    rec_has_vowels = any(c in VOWEL_CHARS for c in norm_rec)

    # Выбираем лучший вариант (стандартный или фонетический)
    matcher_std = SequenceMatcher(None, norm_exp_std, norm_rec)
    matcher_pho = SequenceMatcher(None, norm_exp_pho, norm_rec)

    if matcher_pho.ratio() >= matcher_std.ratio():
        best_matcher = matcher_pho
        norm_exp = norm_exp_pho
        bare_exp = bare_exp_pho
    else:
        best_matcher = matcher_std
        norm_exp = norm_exp_std
        bare_exp = bare_exp_std

    ratio = best_matcher.ratio()
    harakat_issue = cluster_mistakes[0]["issue"] if cluster_mistakes else ""

    if not rec_has_vowels:
        bare_matcher_std = SequenceMatcher(None, bare_exp_std, bare_rec)
        bare_matcher_pho = SequenceMatcher(None, bare_exp_pho, bare_rec)
        if bare_matcher_pho.ratio() >= bare_matcher_std.ratio():
            ratio = bare_matcher_pho.ratio()
            bare_exp = bare_exp_pho
        else:
            ratio = bare_matcher_std.ratio()
            bare_exp = bare_exp_std

    # Если Усмани <-> Имлаи совпадение высокое, гарантируем высокий базовый скор
    if imlai_exp == imlai_rec or imlai_sim >= 0.85:
        ratio = max(ratio, 0.95)

    if cluster_mistakes:
        total_audible = max(1, sum(1 for c in exp_clusters if not c.is_silent))
        err_fraction = min(1.0, len(cluster_mistakes) / total_audible)
        # Пропорциональный штраф за реальные ошибки кластеров (без жесткого потолка 0.35!)
        proportional_ratio = max(0.38, ratio * (1.0 - 0.55 * err_fraction))
        return proportional_ratio, harakat_issue, letter_confusions

    # Поиск замены согласных букв через SequenceMatcher opcodes
    for tag, i1, i2, j1, j2 in best_matcher.get_opcodes():
        if tag == "replace":
            sub_exp = norm_exp[i1:i2]
            sub_rec = norm_rec[j1:j2]
            if sub_exp == 'ه' and sub_rec == 'ت' and i2 == len(norm_exp) and j2 == len(norm_rec):
                continue
            c_exp = [c for c in sub_exp if c not in VOWEL_CHARS]
            c_rec = [c for c in sub_rec if c not in VOWEL_CHARS]
            for exp_char in c_exp:
                confused_candidates = MAKHRAJ_CONFUSION_PAIRS.get(exp_char, [])
                for rec_char in c_rec:
                    if rec_char in confused_candidates:
                        letter_confusions.append({
                            "expected": exp_char,
                            "recognized": rec_char,
                            "rule": "makhraj_critical",
                        })

    exp_words = bare_exp.split()
    rec_words = bare_rec.split()

    # Если Усмани <-> Имлаи совпало (например, составное «يَٰٓأَيُّهَا» vs «يا أيها»),
    # это идеальное совпадение, не считаем слово недочитанным!
    if imlai_exp == imlai_rec or imlai_sim >= 0.85:
        return max(ratio, 0.95), "", []

    if len(exp_words) > len(rec_words) and len(exp_words) > 1:
        missing_count = len(exp_words) - len(rec_words)
        spoken_ratio = len(rec_words) / max(1, len(exp_words))
        return max(0.45, ratio * spoken_ratio), f"Tilovat chala qoldi: {missing_count} ta so'z aytilmadi yoki tushib qoldi.", letter_confusions

    if len(exp_words) == 1 and len(rec_words) >= 1:
        rec_first = rec_words[0]
        exp_first = exp_words[0]
        if len(rec_first) < len(exp_first) * 0.7:
            return min(ratio, 0.45), f"So'z oxirigacha aytilmadi: «{recognized}» eshitildi («{expected}» o'rniga).", letter_confusions
        if ratio < 0.5:
            return ratio, f"Boshqa so'z o'qildi: «{recognized}» eshitildi («{expected}» o'rniga).", letter_confusions

    if ratio < 0.6:
        return ratio, f"Siz boshqa so'z o'qidingiz: «{recognized}» (Kutilgan so'z: «{expected}»). Iltimos, tanlangan so'zni o'qing.", letter_confusions

    return ratio, "", letter_confusions


def align_recognized_tokens_to_expected(exp_words: List[str], rec_words: List[str]) -> List[str]:
    """
    Синхронизирует токены от Whisper с ожидаемыми словами Мусхафа, склеивая
    однобуквенные союзы/предлоги (و، ف، ب، ل، ك) или части составных обращений (يا أيها),
    если в Мусхафе они написаны слитно (например, «وَمَثَلُ» vs «و مثل», «يَٰٓأَيُّهَا» vs «يا أيها»).
    """
    if not exp_words or not rec_words:
        return rec_words
    aligned: List[str] = []
    r_idx = 0
    e_idx = 0
    while r_idx < len(rec_words):
        cur_r = rec_words[r_idx]
        bare_r = normalize_arabic_phonetic(cur_r, keep_harakaat=False)
        # 1. Склейка однобуквенных союзов и предлогов (و، ف، ب، ل، ك)
        if (
            len(bare_r) == 1
            and bare_r in ("و", "ف", "ب", "ل", "ك")
            and r_idx + 1 < len(rec_words)
            and e_idx < len(exp_words)
        ):
            bare_e = normalize_arabic_phonetic(exp_words[e_idx], keep_harakaat=False)
            bare_merged = normalize_arabic_phonetic(cur_r + rec_words[r_idx + 1], keep_harakaat=False)
            if bare_e.startswith(bare_r) and len(bare_e) >= 2 and SequenceMatcher(None, bare_e, bare_merged).ratio() > 0.50:
                aligned.append(cur_r + rec_words[r_idx + 1])
                r_idx += 2
                e_idx += 1
                continue
        # 2. Склейка составных обращений (يا أيها, يا أبت, هؤلاء)
        if (
            bare_r in ("يا", "ها")
            and r_idx + 1 < len(rec_words)
            and e_idx < len(exp_words)
        ):
            bare_e = normalize_arabic_phonetic(exp_words[e_idx], keep_harakaat=False)
            merged = cur_r + " " + rec_words[r_idx + 1]
            imlai_e = normalize_uthmani_to_imlai(exp_words[e_idx])
            imlai_m = normalize_uthmani_to_imlai(merged)
            if imlai_e == imlai_m or SequenceMatcher(None, imlai_e, imlai_m).ratio() >= 0.70:
                aligned.append(merged)
                r_idx += 2
                e_idx += 1
                continue
        aligned.append(cur_r)
        r_idx += 1
        e_idx += 1
    return aligned


def count_completed_speech_islands(
    rms_frames: List[float],
    active_thresh: float,
) -> Tuple[int, bool, int]:
    """
    Подсчитывает количество полностью завершенных речевых островков (>= 220 мс речи + >= 160 мс паузы)
    и возвращает (completed_islands, in_island, island_speech_frames).
    """
    completed_islands = 0
    in_island = False
    island_speech_frames = 0
    silence_run = 0
    for r in rms_frames:
        if r >= active_thresh * 1.05:
            if not in_island:
                in_island = True
                island_speech_frames = 0
            island_speech_frames += 1
            silence_run = 0
        else:
            if in_island:
                silence_run += 1
                if silence_run >= 16:
                    if island_speech_frames >= 22:
                        completed_islands += 1
                    in_island = False
                    island_speech_frames = 0
    return completed_islands, in_island, island_speech_frames


def verify_words_sequentially(
    exp_words: List[str],
    recognized_text: str,
    prev_verified_count: int,
    rms_frames: List[float],
    active_thresh: float,
    active_dur_ms: int,
    is_live_chunk: bool,
    chunk_reason: str = "interval",
    strictness_level: int = 75,
) -> Tuple[str, int, int, int, int, Optional[int], Optional[str], float, str, List[Dict[str, Any]]]:
    """
    ЖЕСТКАЯ ПОСЛОВНАЯ СИНХРОНИЗАЦИЯ (Word-by-Word Sequential Matching):
    1) Сопоставляет произнесенные слова со словарем аята строго последовательно (0 -> 1 -> 2 ...).
       Пока слово i (например, «وَمَثَلُ») не распознано и не проверено без ошибок,
       алгоритм НЕ ИМЕЕТ ПРАВА переходить к проверке слова i + 1 («ٱلَّذِينَ»).
    2) Если аудио-чанк содержит тишину или невнятный звук (нет распознанных слов),
       индекс прочитанных слов НЕ продвигается вперед.
    3) Как только на слове w_idx обнаружена ошибка (харакат, ташдид, мадд, махрадж или чужое слово),
       проверка немедленно останавливается на этом слове и возвращает:
       failed_word_index = w_idx, failed_word_arabic = exp_words[w_idx].
    """
    total_words_count = max(1, len(exp_words))
    safe_prev = max(0, min(total_words_count, prev_verified_count))
    if not exp_words:
        return "", 0, 0, 1, 0, None, None, 1.0, "", []

    completed_islands, in_island, island_speech_frames = count_completed_speech_islands(
        rms_frames, active_thresh
    )

    clean_rec = strip_istiada_and_basmala(recognized_text or "", " ".join(exp_words))
    raw_rec_words = [w for w in clean_rec.split() if w.strip()]
    rec_words = align_recognized_tokens_to_expected(exp_words, raw_rec_words)

    # Если в живом чанке нет распознанных арабских слов (тишина, вдох или невнятный звук):
    # НЕ продвигаем индекс вперед!
    if not rec_words:
        if is_live_chunk:
            active_word_cursor = safe_prev
            partial_exp = " ".join(exp_words[: max(1, active_word_cursor)])
            p_units = parse_recitation_phonemes(partial_exp)
            return (
                partial_exp,
                active_word_cursor,
                safe_prev,
                total_words_count,
                len(p_units),
                None,
                None,
                0.95,
                "",
                [],
            )
        else:
            full_exp = " ".join(exp_words)
            p_units = parse_recitation_phonemes(full_exp)
            return full_exp, 0, 0, total_words_count, len(p_units), 0, exp_words[0], 0.0, "Ovozdan so'z aniqlanmadi.", []

    # Последовательная проверка слово за словом (0, 1, 2, ...)
    verified_count = 0
    spoken_count = 0
    failed_word_idx: Optional[int] = None
    failed_word_ar: Optional[str] = None
    collected_confusions: List[Dict[str, Any]] = []
    agg_sim_scores: List[float] = []
    first_issue = ""

    # В режиме live-чанка разрешаем проверить максимум до safe_prev + 2 слов за один шаг,
    # чтобы исключить галлюцинации и перескоки вперед
    max_words_to_inspect = min(
        len(exp_words),
        len(rec_words),
        (safe_prev + 2) if is_live_chunk else len(exp_words),
    )

    for w_idx in range(max_words_to_inspect):
        exp_w = exp_words[w_idx]
        rec_w = rec_words[w_idx]
        is_last_rec = (w_idx == len(rec_words) - 1)

        bare_exp_w = normalize_arabic_phonetic(exp_w, keep_harakaat=False)
        bare_rec_w = normalize_arabic_phonetic(rec_w, keep_harakaat=False)

        # Если ученик прямо сейчас произносит последнее слово чанка и еще не договорил его до конца:
        if (
            is_live_chunk
            and is_last_rec
            and chunk_reason != "word_pause"
            and len(bare_rec_w) < len(bare_exp_w)
            and bare_exp_w.startswith(bare_rec_w)
        ):
            exp_w_clusters = extract_letters_with_harakats(exp_w)
            rec_w_clusters = extract_letters_with_harakats(rec_w)
            prefix_mistakes = compare_clusters(
                exp_w_clusters[: len(rec_w_clusters)], rec_w_clusters
            )
            if not prefix_mistakes:
                # Слово еще произносится — не штрафуем, но и не засчитываем как завершенное
                spoken_count = w_idx + 1
                break

        w_sim, w_issue, w_confusions = compute_arabic_similarity(exp_w, rec_w)
        for cm in w_confusions:
            cm["word_index"] = w_idx
            cm["word_arabic"] = exp_w

        imlai_exp_w = normalize_uthmani_to_imlai(exp_w)
        imlai_rec_w = normalize_uthmani_to_imlai(rec_w)
        consonant_sim_imlai = SequenceMatcher(None, imlai_exp_w, imlai_rec_w).ratio()
        consonant_sim_bare = SequenceMatcher(None, bare_exp_w, bare_rec_w).ratio()

        # Короткие односложные слова (длина 1-2 буквы скелета, например: ما, في, قل, لا, من, عن, إن, قد, بل, ذو)
        is_short_word = len(bare_exp_w) <= 2

        consonants_match = (
            imlai_exp_w == imlai_rec_w
            or bare_exp_w == bare_rec_w
            or consonant_sim_imlai >= 0.68
            or consonant_sim_bare >= 0.68
            or (is_short_word and (consonant_sim_imlai >= 0.50 or consonant_sim_bare >= 0.50))
        )

        # Если слово короче ожидаемого более чем на 35% (проглочено окончание или часть слова)
        is_truncated_word = (
            not is_short_word
            and len(bare_exp_w) >= 3
            and len(bare_rec_w) < len(bare_exp_w) * 0.68
            and (not is_live_chunk or not is_last_rec or chunk_reason == "word_pause")
            and (imlai_exp_w != imlai_rec_w and consonant_sim_imlai < 0.85)
        )

        # Смягчение для «упрямых» слов: если Whisper подтвердил совпадение согласных букв слова,
        # повышаем базовый коэффициент совпадения и прощаем мелкую погрешность формант
        if consonants_match and not is_truncated_word:
            base_word_score = 0.92 if strictness_level <= 75 else 0.88
            w_sim = max(w_sim, base_word_score)
            w_confusions = [
                cm for cm in w_confusions
                if cm.get("rule") not in ["makhraj_critical", "ithhar"]
            ]

        if w_confusions or w_sim < (0.58 if strictness_level <= 75 else 0.62) or is_truncated_word:
            failed_word_idx = w_idx
            failed_word_ar = exp_w
            verified_count = w_idx
            spoken_count = w_idx + 1
            collected_confusions.extend(w_confusions)
            agg_sim_scores.append(min(w_sim, 0.42))
            if w_issue:
                first_issue = f'"{exp_w}" so\'zida xato: {w_issue}'
            elif w_confusions and w_confusions[0].get("issue"):
                first_issue = f'"{exp_w}" so\'zida xato: {w_confusions[0]["issue"]}'
            else:
                first_issue = f'"{exp_w}" so\'zida xato qilindi («{rec_w}» eshitildi).'
            # НЕМЕДЛЕННО прекращаем проверку следующих слов!
            break

        # Слово w_idx успешно прошло проверку! Только теперь разрешено переходить к w_idx + 1
        verified_count = w_idx + 1
        spoken_count = w_idx + 1
        agg_sim_scores.append(w_sim)

    effective_words_slice = exp_words[: max(1, spoken_count)]
    partial_exp_text = " ".join(effective_words_slice)
    partial_units = parse_recitation_phonemes(partial_exp_text)
    spoken_units_count = (
        max(1, len(partial_units))
        if partial_units
        else max(1, len(extract_base_arabic_letters(partial_exp_text)))
    )
    overall_sim = float(np.mean(agg_sim_scores)) if agg_sim_scores else 0.95

    return (
        partial_exp_text,
        spoken_count,
        verified_count,
        total_words_count,
        spoken_units_count,
        failed_word_idx,
        failed_word_ar,
        overall_sim,
        first_issue,
        collected_confusions,
    )


@app.get("/")
@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": "Tajweed Pro AI Backend"}


@app.post("/api/analyze-live-chunk", response_model=AnalyzeRecitationResponse)
async def analyze_live_chunk(
    request: Request,
    rule_type: Optional[str] = Query(None),
    target_letter: Optional[str] = Query(None),
    expected_harakaat: Optional[float] = Query(None),
    expected_text: Optional[str] = Query(None),
    reference_duration_ms: Optional[float] = Query(None),
    strictness_level_q: Optional[int] = Query(None, alias="strictness_level"),
):
    return await analyze_recitation(
        request=request,
        rule_type=rule_type,
        target_letter=target_letter,
        expected_harakaat=expected_harakaat,
        expected_text=expected_text,
        reference_duration_ms=reference_duration_ms,
        strictness_level_q=strictness_level_q,
        is_live_chunk_q=True,
    )


@app.post("/api/analyze-recitation", response_model=AnalyzeRecitationResponse)
async def analyze_recitation(
    request: Request,
    rule_type: Optional[str] = Query(None),
    target_letter: Optional[str] = Query(None),
    expected_harakaat: Optional[float] = Query(None),
    expected_text: Optional[str] = Query(None),
    reference_duration_ms: Optional[float] = Query(None),
    strictness_level_q: Optional[int] = Query(None, alias="strictness_level"),
    is_live_chunk_q: Optional[bool] = Query(None, alias="is_live_chunk"),
):
    try:
        form = await request.form()
        upload_file = form.get("audio") or form.get("file") or form.get("blob")
        if upload_file is None:
            for val in form.values():
                if hasattr(val, "read"):
                    upload_file = val
                    break

        raw_live_flag = is_live_chunk_q if is_live_chunk_q is not None else form.get("is_live_chunk")
        is_live_chunk = str(raw_live_flag).lower() in ("true", "1", "yes") if raw_live_flag is not None else False
        live_transcript_hint = str(form.get("live_transcript") or "").strip()
        chunk_reason = str(form.get("chunk_reason") or "interval").strip().lower()
        try:
            prev_verified_words = max(0, int(form.get("verified_words_count") or 0))
        except (ValueError, TypeError):
            prev_verified_words = 0

        rule = (
            rule_type
            or form.get("expected_rule")
            or form.get("rule_type")
            or form.get("rule")
            or form.get("type")
            or ""
        ).lower()
        exp_harakaat = float(
            expected_harakaat
            or form.get("expected_harakaat")
            or form.get("harakaat")
            or 2.0
        )
        exp_text = (
            expected_text
            or form.get("expected_text")
            or form.get("target_uthmani")
            or form.get("target_text")
            or ""
        )
        target_let = (
            target_letter
            or form.get("target_letter")
            or form.get("letter_arabic")
            or form.get("letter")
            or ""
        )
        ref_dur_ms = float(
            reference_duration_ms
            or form.get("reference_duration_ms")
            or form.get("ref_duration_ms")
            or 0.0
        )
        raw_strictness = (
            strictness_level_q
            if strictness_level_q is not None
            else form.get("strictness_level")
        )
        try:
            strictness_level = max(50, min(100, int(float(raw_strictness)))) if raw_strictness is not None else 75
        except (ValueError, TypeError):
            strictness_level = 75

        strictness_factor = strictness_level / 100.0
        norm_strictness = max(0.0, min(1.0, (strictness_level - 50.0) / 50.0))
        # При 50% (Yumshoq) допуск F1/F2 расширяется на 70% (tolerance_scale = 1.70), при 100% (Ekspert) — канонически строгий (1.00)
        tolerance_scale = 1.70 - 0.70 * norm_strictness
        # Порог прохождения буквы: от 55% при сложности 50% до 85% при сложности 100%
        pass_threshold = 55.0 + 30.0 * norm_strictness
        penalty_weight = 0.50 + 0.50 * norm_strictness
        madd_tolerance_harakaat = 0.60 - 0.25 * norm_strictness

        exp_words_all = [w for w in WAQF_MARKS_REGEX.sub('', exp_text or "").split() if w.strip()]
        total_words_count = max(1, len(exp_words_all))

        raw_bytes = await upload_file.read() if upload_file else b""
        y = decode_audio_bytes(raw_bytes, target_sr=16000) if raw_bytes else np.array([], dtype=np.float32)
        total_dur_ms = int((len(y) / 16000.0) * 1000) if len(y) > 0 else 0

        raw_peak = float(np.max(np.abs(y))) if len(y) > 0 else 0.0
        if len(y) < 1600 or raw_peak < 0.0005:
            if is_live_chunk:
                return AnalyzeRecitationResponse(
                    score=95.0,
                    status="correct",
                    detected_issue="Ovoz kutilmoqda...",
                    duration_ms=total_dur_ms,
                    recognized_text="",
                    letter_evaluations=[],
                    is_live_chunk=True,
                    spoken_words_count=prev_verified_words,
                    verified_words_count=prev_verified_words,
                    total_words_count=total_words_count,
                    spoken_letter_count=0,
                    failed_word_index=None,
                    failed_word_arabic=None,
                    metrics=AcousticMetrics(
                        rms_mean=0.0,
                        rms_max=0.0,
                        peak_db=-60.0,
                        active_duration_ms=0,
                        f1_hz=520,
                        f2_hz=1350,
                        onset_max=0.0,
                        onset_ratio=0.0,
                        measured_harakaat=0.0,
                    ),
                )
            return AnalyzeRecitationResponse(
                score=0.0,
                status="mistake",
                detected_issue="Ovoz aniqlanmadi. Mikrofonga yaqinroq va balandroq o'qing.",
                duration_ms=total_dur_ms,
                recognized_text="",
                letter_evaluations=[],
                total_words_count=total_words_count,
                metrics=AcousticMetrics(
                    rms_mean=0.0,
                    rms_max=0.0,
                    peak_db=-60.0,
                    active_duration_ms=0,
                    f1_hz=520,
                    f2_hz=1350,
                    onset_max=0.0,
                    onset_ratio=0.0,
                    measured_harakaat=0.0,
                ),
            )

        # 1. Программное усиление тихого микрофона (Auto-Gain)
        gain_factor = min(35.0, 0.9 / max(raw_peak, 1e-4))
        y_boosted = np.clip(y * gain_factor, -1.0, 1.0)
        boosted_wav_bytes = encode_wav_in_memory(y_boosted, 16000)

        # Обрезка тишины и подсчет активной речи
        frame_len = 160
        rms_frames = [
            np.sqrt(np.mean(y_boosted[i : i + frame_len] ** 2))
            for i in range(0, len(y_boosted), frame_len)
        ]
        noise_floor = np.percentile(rms_frames, 20) if rms_frames else 0.01
        active_thresh = max(0.015, noise_floor * 2.5)

        active_indices = [idx for idx, r in enumerate(rms_frames) if r >= active_thresh]
        if active_indices:
            start_frame = max(0, active_indices[0] - 2)
            end_frame = min(len(rms_frames), active_indices[-1] + 3)

            # Item 3: Отсекаем хвост затухания комнатного эха (последние 150 мс с падающей энергией < 15% от пика)
            peak_active_rms = max(rms_frames[start_frame:end_frame]) if end_frame > start_frame else 0.1
            reverb_thresh = peak_active_rms * 0.15
            while end_frame - 1 > start_frame and (end_frame - start_frame) > 25:
                if rms_frames[end_frame - 1] < reverb_thresh:
                    end_frame -= 1
                else:
                    break

            y_active = y_boosted[start_frame * frame_len : end_frame * frame_len]
        else:
            start_frame = 0
            end_frame = len(rms_frames)
            y_active = y_boosted

        active_dur_ms = int((len(y_active) / 16000.0) * 1000)
        peak_db = float(20.0 * np.log10(max(raw_peak, 1e-4)))

        # Item 4: Вычитание внутренних пауз дыхания (> 180 мс при RMS < VAD threshold) из темпа речи
        internal_pause_frames = 0
        current_silent_run = 0
        for f_idx in range(start_frame, end_frame):
            if rms_frames[f_idx] < active_thresh:
                current_silent_run += 1
            else:
                if current_silent_run >= 18:  # 18 кадров по 10 мс = 180 мс
                    internal_pause_frames += current_silent_run
                current_silent_run = 0
        if current_silent_run >= 18:
            internal_pause_frames += current_silent_run
        pause_dur_ms = internal_pause_frames * 10
        effective_speech_dur_ms = max(180, active_dur_ms - pause_dur_ms)

        # Item 5: Защита от галлюцинаций Whisper в режиме Live-чанка (Voiced Energy Pre-check):
        # Длительность звучащей речи должна быть >= 220 мс, а пиковая энергия выше активного порога.
        # Если микрофон поймал только дыхание, шорох или тишину — возвращаем ожидание БЕЗ вызова Whisper!
        voiced_frames_count = sum(1 for idx in range(start_frame, end_frame) if rms_frames[idx] >= active_thresh)
        voiced_dur_ms = voiced_frames_count * 10
        if is_live_chunk and (voiced_dur_ms < 220 or raw_peak < 0.005):
            return AnalyzeRecitationResponse(
                score=95.0,
                status="correct",
                detected_issue="Ovoz kutilmoqda...",
                duration_ms=active_dur_ms,
                recognized_text="",
                letter_evaluations=[],
                is_live_chunk=True,
                spoken_words_count=prev_verified_words,
                verified_words_count=prev_verified_words,
                total_words_count=total_words_count,
                spoken_letter_count=0,
                failed_word_index=None,
                failed_word_arabic=None,
                metrics=AcousticMetrics(
                    rms_mean=round(float(np.mean(rms_frames)) if rms_frames else 0.0, 4),
                    rms_max=round(raw_peak, 4),
                    peak_db=round(peak_db, 1),
                    active_duration_ms=active_dur_ms,
                    f1_hz=520.0,
                    f2_hz=1350.0,
                    onset_max=0.0,
                    onset_ratio=0.0,
                    measured_harakaat=0.0,
                ),
            )

        # Честный подсчет соотношения длительности (Madd duration ratio)
        duration_ratio: Optional[float] = None
        madd_ok = True
        if ref_dur_ms > 150:
            duration_ratio = active_dur_ms / ref_dur_ms
            if duration_ratio >= 0.75:
                madd_ok = True
            elif duration_ratio < 0.6:
                madd_ok = False
            else:
                madd_ok = True

        # 2. Нейтральный вызов Whisper с защитой от галлюцинаций (Item 5)
        recognized_text = live_transcript_hint
        raw_use_whisper = str(form.get("use_whisper") or "true").lower()
        use_whisper_in_live = raw_use_whisper not in ("false", "0", "no")
        if client and (not is_live_chunk or (use_whisper_in_live and voiced_dur_ms >= 220)):
            try:
                audio_io = io.BytesIO(boosted_wav_bytes)
                audio_io.name = "boosted_recitation.wav"
                whisper_prompt = f"تلاوة: {exp_text}" if exp_text else "تلاوة القرآن الكريم بالحركات والتشكيل الدقيق"
                transcript = client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_io,
                    language="ar",
                    temperature=0.0,
                    prompt=whisper_prompt,
                )
                if transcript.text and transcript.text.strip():
                    recognized_text = clean_whisper_hallucinations(transcript.text.strip())
            except Exception as e:
                print(f"[Whisper Phonetic Recognition Error] {e}")

        # Удаляем вводную Исти'азу / Басмалу и артефакты галлюцинаций
        recognized_text = clean_whisper_hallucinations(recognized_text)
        recognized_text = strip_istiada_and_basmala(recognized_text, exp_text)

        spoken_words_count = total_words_count
        verified_words_count = total_words_count
        spoken_units_limit = 0
        effective_exp_text = exp_text
        failed_word_index: Optional[int] = None
        failed_word_arabic: Optional[str] = None
        text_sim = 1.0
        text_issue = ""
        letter_confusions: List[Dict[str, Any]] = []

        if exp_words_all:
            (
                partial_exp_text,
                spoken_words_count,
                verified_words_count,
                total_words_count,
                spoken_units_limit,
                failed_word_index,
                failed_word_arabic,
                text_sim,
                text_issue,
                letter_confusions,
            ) = verify_words_sequentially(
                exp_words=exp_words_all,
                recognized_text=recognized_text,
                prev_verified_count=prev_verified_words,
                rms_frames=rms_frames,
                active_thresh=active_thresh,
                active_dur_ms=active_dur_ms,
                is_live_chunk=is_live_chunk,
                chunk_reason=chunk_reason,
                strictness_level=strictness_level,
            )
            effective_exp_text = partial_exp_text

            # Если в режиме live-чанка ни одного слова не было распознано (тишина или невнятный звук),
            # возвращаем статус ожидания без продвижения индекса слов вперед
            if is_live_chunk and not recognized_text.strip() and failed_word_index is None:
                return AnalyzeRecitationResponse(
                    score=95.0,
                    status="correct",
                    detected_issue="Aniq talaffuz kutilmoqda...",
                    duration_ms=active_dur_ms,
                    recognized_text="",
                    letter_evaluations=[],
                    text_similarity=0.95,
                    is_live_chunk=True,
                    spoken_words_count=prev_verified_words,
                    verified_words_count=prev_verified_words,
                    total_words_count=total_words_count,
                    spoken_letter_count=0,
                    failed_word_index=None,
                    failed_word_arabic=None,
                    metrics=AcousticMetrics(
                        rms_mean=round(float(np.mean(rms_frames)) if rms_frames else 0.05, 4),
                        rms_max=round(raw_peak, 4),
                        peak_db=round(peak_db, 1),
                        active_duration_ms=active_dur_ms,
                        f1_hz=520.0,
                        f2_hz=1350.0,
                        onset_max=0.0,
                        onset_ratio=0.0,
                        measured_harakaat=exp_harakaat,
                    ),
                )
        elif effective_exp_text:
            text_sim, text_issue, letter_confusions = compute_arabic_similarity(effective_exp_text, recognized_text)

        # ЗАПРЕТ НА ФЕЙКОВЫЕ 89% ПРИ ПУСТОЙ РЕЧИ:
        # Если в финальном анализе (not is_live_chunk) Whisper вернул пустую строку (Ovozdan so'z aniqlanmadi),
        # оценка ОБЯЗАНА быть 0% со статусом "Ovoz eshitilmadi — qaytadan o'qing"!
        if not is_live_chunk and (not recognized_text or not recognized_text.strip()):
            return AnalyzeRecitationResponse(
                score=0.0,
                status="mistake",
                detected_issue="Ovoz eshitilmadi — qaytadan o'qing",
                duration_ms=active_dur_ms or total_dur_ms,
                recognized_text="",
                letter_evaluations=[],
                text_similarity=0.0,
                duration_ratio=0.0,
                madd_ok=False,
                multi_sheikh_consensus=0.0,
                strictness_level=strictness_level,
                student_unit_ms=100.0,
                is_live_chunk=False,
                spoken_words_count=0,
                verified_words_count=0,
                total_words_count=total_words_count,
                spoken_letter_count=0,
                failed_word_index=0 if exp_words_all else None,
                failed_word_arabic=exp_words_all[0] if exp_words_all else None,
                metrics=AcousticMetrics(
                    rms_mean=round(float(np.mean(rms_frames)) if rms_frames else 0.0, 4),
                    rms_max=round(raw_peak, 4),
                    peak_db=round(peak_db, 1),
                    active_duration_ms=active_dur_ms,
                    f1_hz=0.0,
                    f2_hz=0.0,
                    onset_max=0.0,
                    onset_ratio=0.0,
                    measured_harakaat=0.0,
                ),
            )

        # СТРОГАЯ ПРОВЕРКА СОВПАДЕНИЯ СЛОВ (Expected vs Recognized Text):
        has_text_harakat_err = any(c.get("rule") in ["harakat", "tashdid", "madd_2"] for c in letter_confusions)
        if exp_text and text_sim < 0.6 and not has_text_harakat_err and (not is_live_chunk or failed_word_index is not None):
            err_word_ar = failed_word_arabic or (exp_words_all[0] if exp_words_all else exp_text)
            err_word_idx = failed_word_index if failed_word_index is not None else 0
            wrong_issue = (
                f'"{err_word_ar}" so\'zida xato qilindi: «{recognized_text}» eshitildi.'
                if recognized_text
                else f"Ovozdan so'z aniqlanmadi (Kutilgan so'z: «{err_word_ar}»)."
            )
            wrong_evals: List[LetterEvaluation] = []
            target_units_for_err = parse_recitation_phonemes(err_word_ar)
            if not target_units_for_err:
                base_letters = extract_base_arabic_letters(err_word_ar) or ([target_let] if target_let else [])
                target_units_for_err = [
                    PhoneticLetterUnit(
                        base_char=ch,
                        raw_char=ch,
                        vowel=None,
                        has_shaddah=False,
                        has_madd_wave=False,
                        has_dagger_alif=False,
                        is_silent=False,
                        is_ta_marbuta=(ch == 'ة'),
                        is_final=(i == len(base_letters) - 1),
                        weight=1.0,
                        word_index=err_word_idx,
                        word_arabic=err_word_ar,
                    )
                    for i, ch in enumerate(base_letters)
                ]

            for u in target_units_for_err:
                let = u.raw_char or u.base_char
                let_rule = (
                    "tashdid"
                    if u.has_shaddah
                    else (
                        "madd_2"
                        if u.base_char in ["ا", "و", "ي"] or u.has_dagger_alif
                        else ("tafkhim" if u.base_char in HEAVY_LETTERS else "makhraj_critical")
                    )
                )
                wrong_evals.append(
                    LetterEvaluation(
                        letter=let,
                        rule=let_rule,
                        status="mistake",
                        score=25.0,
                        detected_letter=None,
                        f2_hz=None,
                        zcr=0.0,
                        onset_ratio=0.0,
                        issue_uz=f"«{let}» xato: «{err_word_ar}» so'zi noto'g'ri o'qildi.",
                        anatomical_tip_uz=f"Kutilgan so'z: «{err_word_ar}». Iltimos, aniq o'qing.",
                        word_index=err_word_idx,
                        word_arabic=err_word_ar,
                    )
                )

            return AnalyzeRecitationResponse(
                score=25.0,
                status="mistake",
                detected_issue=wrong_issue,
                duration_ms=active_dur_ms or total_dur_ms,
                recognized_text=recognized_text,
                letter_evaluations=wrong_evals,
                text_similarity=round(text_sim, 3),
                duration_ratio=round(duration_ratio, 3) if duration_ratio is not None else None,
                madd_ok=False,
                is_live_chunk=is_live_chunk,
                spoken_words_count=err_word_idx + 1,
                verified_words_count=err_word_idx,
                total_words_count=total_words_count,
                spoken_letter_count=len(wrong_evals),
                failed_word_index=err_word_idx,
                failed_word_arabic=err_word_ar,
                metrics=AcousticMetrics(
                    rms_mean=round(float(np.mean(rms_frames)) if rms_frames else 0.05, 4),
                    rms_max=round(raw_peak, 4),
                    peak_db=round(peak_db, 1),
                    active_duration_ms=active_dur_ms,
                    f1_hz=520.0,
                    f2_hz=0.0,
                    onset_max=0.0,
                    onset_ratio=0.0,
                    measured_harakaat=0.0,
                ),
            )

        # 4. ПОСЕГМЕНТНЫЙ АКУСТИЧЕСКИЙ АНАЛИЗ МАХРАДЖА, ХАРАКАТОВ И ТАШДИДА
        phonetic_units = parse_recitation_phonemes(effective_exp_text) if effective_exp_text else []
        if not phonetic_units:
            base_letters = extract_base_arabic_letters(effective_exp_text) if effective_exp_text else ([target_let] if target_let else [])
            if not base_letters and target_let:
                base_letters = [target_let]
            phonetic_units = [
                PhoneticLetterUnit(
                    base_char=ch,
                    raw_char=ch,
                    vowel=None,
                    has_shaddah=False,
                    has_madd_wave=False,
                    has_dagger_alif=False,
                    is_silent=False,
                    is_ta_marbuta=(ch == 'ة'),
                    is_final=(i == len(base_letters) - 1),
                    weight=1.0,
                    word_index=0,
                    word_arabic=effective_exp_text,
                )
                for i, ch in enumerate(base_letters)
            ]

        if is_live_chunk and spoken_units_limit > 0 and len(phonetic_units) > spoken_units_limit:
            phonetic_units = phonetic_units[:spoken_units_limit]

        spoken_letter_count = len(phonetic_units)

        letter_evaluations: List[LetterEvaluation] = []
        total_weight = sum(u.weight for u in phonetic_units) or 1.0
        total_active_len = len(y_active)

        # Сегментация с привязкой границ к локальным впадинам RMS (Item 2)
        letter_slices = align_phonetic_slices_to_energy_envelope(y_active, phonetic_units, sample_rate=16000)

        # Базовая длительность обычной одиночной согласной (для контроля Ташдида)
        # и ИНДИВИДУАЛЬНОЙ нормализации темпа ученика (student_unit_ms = 1 харакат из собственной речи ученика)
        consonant_durations_ms = [
            (end_s - start_s) / 16.0
            for u, start_s, end_s in letter_slices
            if not u.is_silent and not u.has_shaddah and u.base_char not in ['ا', 'و', 'ي'] and not u.has_dagger_alif
        ]
        avg_cons_ms = float(np.median(consonant_durations_ms)) if consonant_durations_ms else 95.0

        short_voweled_durations_ms = [
            (end_s - start_s) / 16.0
            for u, start_s, end_s in letter_slices
            if not u.is_silent
            and not u.has_shaddah
            and not u.has_dagger_alif
            and not u.has_madd_wave
            and u.base_char not in ['ا', 'و', 'ي']
            and u.vowel in ['fatha', 'kasra', 'damma']
        ]
        weighted_pace_ms = effective_speech_dur_ms / max(1.0, total_weight)
        if short_voweled_durations_ms:
            student_unit_ms = float(np.clip(0.6 * np.median(short_voweled_durations_ms) + 0.4 * weighted_pace_ms, 70.0, 220.0))
        else:
            student_unit_ms = float(np.clip(weighted_pace_ms, 75.0, 200.0))

        # Извлечение формант и высоты тона через Parselmouth.
        global_sound = parselmouth.Sound(y_active, sampling_frequency=16000)
        global_formants = global_sound.to_formant_burg(
            time_step=0.01, max_number_of_formants=5, maximum_formant=5000.0
        )
        global_pitch = global_sound.to_pitch(time_step=0.01, pitch_floor=75.0, pitch_ceiling=500.0)

        # Вычисление индивидуального F0 и резонанса голосового тракта ученика (VTLN Speaker Normalization)
        all_f0_vals: List[float] = []
        all_f2_vals: List[float] = []
        t_scan = 0.0
        while t_scan <= global_sound.duration:
            p_val = global_pitch.get_value_at_time(t_scan)
            if p_val is not None and not np.isnan(p_val) and 75.0 < p_val < 450.0:
                all_f0_vals.append(float(p_val))
                f2_val = global_formants.get_value_at_time(2, t_scan)
                if f2_val is not None and not np.isnan(f2_val) and 700.0 <= f2_val <= 2400.0:
                    all_f2_vals.append(float(f2_val))
            t_scan += 0.015
        speaker_f0_hz = float(np.median(all_f0_vals)) if all_f0_vals else 135.0
        speaker_f2_median = float(np.median(all_f2_vals)) if all_f2_vals else 1450.0

        def voiced_formants(t_start: float, t_end: float) -> Tuple[Optional[float], Optional[float], int]:
            """Медианные F1/F2 по вокализованным кадрам с VTLN-калибровкой под тембр ученика."""
            f1_list: List[float] = []
            f2_list: List[float] = []
            voiced_count = 0
            t = max(0.0, t_start)
            t_end = min(global_sound.duration, t_end)
            while t <= t_end:
                p = global_pitch.get_value_at_time(t)
                if p is not None and not np.isnan(p) and p > 75.0:
                    voiced_count += 1
                    f1_t = global_formants.get_value_at_time(1, t)
                    f2_t = global_formants.get_value_at_time(2, t)
                    if f1_t is not None and not np.isnan(f1_t) and 200.0 <= f1_t <= 1150.0:
                        f1_list.append(float(f1_t))
                    if f2_t is not None and not np.isnan(f2_t) and 650.0 <= f2_t <= 2350.0:
                        f2_list.append(float(f2_t))
                t += 0.01
            f1_med = float(np.median(f1_list)) if f1_list else None
            f2_med = float(np.median(f2_list)) if f2_list else None
            if f1_med is not None and f2_med is not None:
                f1_med, f2_med = normalize_speaker_formants_vtln(
                    f1_med, f2_med, speaker_f0_hz, speaker_f2_median
                )
            return f1_med, f2_med, voiced_count

        # Правило доверия ИИ: если Whisper распознал слово (без путаницы букв),
        # акустика НЕ может сама по себе объявить замену буквы.
        whisper_confirms_word = bool(recognized_text) and text_sim >= 0.7 and failed_word_index is None

        makhraj_severe_errors = 0

        # Пороги акустики масштабируются через tolerance_scale (1.6 при 50%, 1.0 при 100%)
        heavy_f2_soft_limit = 1650.0 * (1.0 + 0.14 * (tolerance_scale - 1.0))
        interdental_zcr_limit = 0.28 * tolerance_scale
        interdental_hf_limit = 0.45 * tolerance_scale
        pharyngeal_ha_f1_min = 480.0 / tolerance_scale
        pharyngeal_ayn_f1_min = 460.0 / tolerance_scale
        shaddah_min_ms = 85.0 / tolerance_scale

        for idx, (unit, start_s, end_s) in enumerate(letter_slices):
            letter = unit.base_char
            raw_ch = unit.raw_char or letter
            letter_seg = y_active[start_s:end_s] if end_s > start_s else y_active
            seg_ms = len(letter_seg) / 16.0
            is_word_completed = (
                not is_live_chunk
                or unit.word_index < verified_words_count
                or chunk_reason == "word_pause"
            )

            # Немая буква (например, круглый нулевой сукун \u06DF, ассимилированный солнечный лам или пустой Алиф / Хамзатуль-васл без хамзы)
            is_bare_alif_or_wasla = (
                letter in ('ا', 'ٱ')
                and not any(h in raw_ch for h in ('أ', 'إ', 'ء'))
            )
            if unit.is_silent or is_bare_alif_or_wasla:
                letter_evaluations.append(
                    LetterEvaluation(
                        letter=raw_ch,
                        rule="madd_2" if is_bare_alif_or_wasla else "makhraj_critical",
                        status="perfect",
                        score=98.0,
                        detected_letter=None,
                        f2_hz=None,
                        zcr=0.0,
                        onset_ratio=1.0,
                        issue_uz="",
                        anatomical_tip_uz="Ulab o'qiladigan Alif (Hamzatul-vasl) yoki Madd Alif.",
                        word_index=unit.word_index,
                        word_arabic=unit.word_arabic,
                    )
                )
                continue

            t_start = start_s / 16000.0
            t_end = end_s / 16000.0 + 0.06
            f1, f2, voiced_frames = voiced_formants(t_start, t_end)

            zcr = compute_zcr(letter_seg)
            hf_ratio = compute_high_freq_ratio(letter_seg, 16000)

            onset_ratio = 1.0
            if len(letter_seg) > 80:
                half = len(letter_seg) // 2
                e1 = np.mean(letter_seg[:half] ** 2) + 1e-6
                e2 = np.mean(letter_seg[half:] ** 2) + 1e-6
                onset_ratio = float(e2 / e1)

            # Проверяем, была ли буква или огласовка перепутана в Whisper / compare_clusters именно в этом слове
            c_mistake = next(
                (
                    m
                    for m in letter_confusions
                    if (m.get("word_index") is None or m.get("word_index") == unit.word_index)
                    and (m.get("base_char") == letter or m.get("expected") == letter)
                ),
                None,
            )
            confused_with = None
            if c_mistake:
                if c_mistake.get("rule") == "makhraj_critical":
                    confused_with = c_mistake.get("recognized")

            if unit.is_ta_marbuta and unit.is_final:
                if confused_with in ['ه', 'ت']:
                    confused_with = None

            let_status: Literal["perfect", "warning", "mistake"] = "perfect"
            let_score = 95.0
            let_rule = "qalqalah" if ("qalqalah" in rule and letter == target_let) else ("tafkhim" if letter in HEAVY_LETTERS else "makhraj_critical")
            let_issue = ""
            tip = MAKHRAJ_ANATOMICAL_INSTRUCTIONS.get(letter, "Harf maxrajini aniq talaffuz qiling.")

            if c_mistake and let_status == "perfect":
                let_status = "mistake"
                let_score = float(c_mistake.get("score", 30.0))
                let_rule = c_mistake.get("rule", "harakat")
                let_issue = c_mistake.get("issue", "Harakat xato o'qildi.")
                tip = c_mistake.get("tip", VOWEL_TIPS_UZ.get(unit.vowel, "Harakatni aniq talaffuz qiling."))

            is_last_word_in_recitation = (
                len(exp_words_all) <= 1 or unit.word_index == len(exp_words_all) - 1
            )
            # При остановке (Вакф) на последней согласной слова огласовка опускается (сукун) — не штрафуем за харакат (Item 3)
            is_waqf_final_letter = unit.is_final and is_last_word_in_recitation

            # Если Whisper подтвердил правильное чтение слова (схожесть >= 0.70) и для буквы нет реальной подмены:
            # гарантируем высокий базовый балл >= 95% для обычных согласных скелета слова,
            # защищая от ложных карточек Izhor/Maxraj
            if whisper_confirms_word and not confused_with and (not c_mistake or c_mistake.get("rule") != "makhraj_critical"):
                let_status = "perfect"
                let_score = max(let_score, 95.0)
                let_issue = ""

            if is_word_completed:
                # 1. ТАФХИМ (ص ض ط ظ ق غ خ) — акустическая проверка F2 независимо от Whisper (Item 1)
                if letter in HEAVY_LETTERS:
                    if confused_with in SOFT_PAIRS_OF_HEAVY:
                        let_status = "mistake"
                        let_score = 55.0
                        let_rule = "tafkhim"
                        f2_note = f" — F2: {int(f2)} Hz" if f2 else ""
                        let_issue = f"«{raw_ch}» o'rniga yumshoq «{confused_with}» eshitildi{f2_note}."
                        tip = "Tilning orqa qismini yumshoq tanglay tomonga ko'tarib, og'izda yo'g'on (Tafxim) yangrash hosil qiling."
                    elif f2 is not None and f2 >= heavy_f2_soft_limit:
                        let_status = "mistake" if strictness_level >= 65 else "warning"
                        let_score = round(64.0 - 10.0 * penalty_weight, 1)
                        let_rule = "tafkhim"
                        let_issue = f"«{raw_ch}» yumshoq talaffuz qilindi: vokal F2 {int(f2)} Hz (yo'g'on harf uchun {int(heavy_f2_soft_limit)} Hz dan past bo'lishi kerak)."
                        tip = "Tilning orqa qismini yumshoq tanglay tomonga ko'taring va ovozni og'iz bo'shlig'ida to'ldirib yo'g'on chiqaring."

                # 2. МЕЖЗУБНЫЕ (ث، ذ، ظ)
                if letter in ["ث", "ذ", "ظ"] and let_status == "perfect":
                    if confused_with in ["س", "ز", "ص"]:
                        let_status = "mistake"
                        let_score = 56.0
                        let_issue = f"«{raw_ch}» harfida hushtak eshitildi — «{confused_with}» kabi o'qildi."
                    elif not whisper_confirms_word and (zcr > interdental_zcr_limit or hf_ratio > interdental_hf_limit):
                        let_status = "mistake"
                        let_score = round(65.0 - 10.0 * penalty_weight, 1)
                        let_issue = f"«{raw_ch}» harfida hushtak (С/З) eshitildi (ZCR: {zcr:.2f})."

                # 3. ГОРТАННЫЕ (ح، ع)
                if letter == "ح" and let_status == "perfect":
                    if confused_with in ["ه", "خ"]:
                        let_status = "mistake"
                        let_score = 58.0
                        let_issue = f"«ح» oddiy «{confused_with}» kabi chiqdi."
                    elif not whisper_confirms_word and f1 is not None and f1 < pharyngeal_ha_f1_min:
                        let_status = "mistake"
                        let_score = round(66.0 - 8.0 * penalty_weight, 1)
                        let_issue = f"«ح» zaif, «ه» kabi chiqdi (F1: {int(f1)} Hz)."
                if letter == "ع" and let_status == "perfect":
                    if confused_with in ["ا", "ء"]:
                        let_status = "mistake"
                        let_score = 54.0
                        let_issue = "«ع» oddiy «А» (hamza) kabi o'qildi."
                    elif not whisper_confirms_word and f1 is not None and f1 < pharyngeal_ayn_f1_min:
                        let_status = "mistake"
                        let_score = round(65.0 - 9.0 * penalty_weight, 1)
                        let_issue = f"«ع» halqumdan yetarli siqilmadi (F1: {int(f1)} Hz)."

                # 4. КАЛЬКАЛЯ (ق، ط، ب، ج، د с сукуном) — проверка акустического всплеска энергии (Item 1)
                is_qalqalah_target = (
                    ("qalqalah" in rule and letter in ["ق", "ط", "ب", "ج", "د"])
                    or (letter in ["ق", "ط", "ب", "ج", "د"] and (unit.vowel == 'sukun' or '\u0652' in (unit.raw_char or '')))
                )
                if is_qalqalah_target:
                    burst_ok = (onset_ratio >= (1.28 / tolerance_scale)) or (seg_ms >= 55.0 and raw_peak >= 0.02)
                    if not burst_ok:
                        let_status = "mistake" if strictness_level >= 75 else "warning"
                        let_score = round(65.0 - 8.0 * penalty_weight, 1)
                        let_rule = "qalqalah"
                        let_issue = f"«{raw_ch}» harfida Qalqala (sakrash) to'liq hosil qilinmadi: ovoz uzilib qoldi."
                        tip = "Tovush paychalarini bir lahzaga to'liq jipslashtirib, keyin bosim bilan birdaniga yorib sakrating."

                # 5. ГУННА / ИХФА (نّ، مّ، танвин) — проверка длительности назального резонанса по вокализованной энергии
                is_ghunnah_target = (
                    (unit.has_shaddah and letter in ['ن', 'م'])
                    or ('tanween' in (unit.vowel or ''))
                    or ("ghunnah" in rule and letter in ['ن', 'م'])
                )
                if is_ghunnah_target:
                    voiced_ghunnah_ms = compute_voiced_madd_duration_ms(letter_seg, 16000)
                    ghunnah_harakaat = round(voiced_ghunnah_ms / max(student_unit_ms, 65.0), 1)
                    ghunnah_slack = ((100.0 - strictness_level) / 50.0) * 0.25
                    if ghunnah_harakaat >= (1.6 - ghunnah_slack):
                        let_status = "perfect"
                        let_score = max(let_score, 99.0)
                    else:
                        let_status = "mistake" if strictness_level >= 75 else "warning"
                        let_score = round(64.0 - 10.0 * penalty_weight, 1)
                        let_rule = "ghunnah"
                        let_issue = (
                            f"«{raw_ch}» harfida G'unna (burun rezonansi) qisqa o'qildi: amalda {ghunnah_harakaat:.1f} harakat "
                            f"cho'zildi, qoida bo'yicha 2 harakat (me'yor: 1.6–2.8 harakat) ushlab o'qish kerak!"
                        )
                        tip = "Ovozni dimoqqa (burun bo'shlig'iga) yo'naltirib, 2 harakat miqdorida ushlab turing."

                # 6. МАДД (2, 4–5, 6 харакатов) и МАДД 'АРИД ЛИС-СУКУН по вокализованной энергии (rms > 0.22 * peak_rms)
                is_madd_letter = (
                    unit.base_char in ['ا', 'و', 'ي']
                    or unit.has_dagger_alif
                    or unit.has_madd_wave
                    or "madd" in rule
                )
                if is_madd_letter and student_unit_ms > 0:
                    voiced_madd_ms = compute_voiced_madd_duration_ms(letter_seg, 16000)
                    unit_harakaat = round(voiced_madd_ms / max(student_unit_ms, 65.0), 1)
                    madd_slack = ((100.0 - strictness_level) / 50.0) * 0.25
                    if getattr(unit, 'is_madd_arid', False) and is_last_word_in_recitation:
                        if (1.6 - madd_slack) <= unit_harakaat <= (6.8 + madd_slack):
                            let_status = "perfect"
                            let_score = 99.0
                            let_issue = ""
                        elif unit_harakaat < (1.6 - madd_slack):
                            let_status = "mistake" if strictness_level >= 75 else "warning"
                            let_score = 62.0
                            let_rule = "madd_2"
                            let_issue = (
                                f"«{raw_ch}» harfida Madd 'Ariz lis-sukun qisqa o'qildi: amalda {unit_harakaat:.1f} harakat "
                                f"cho'zildi, qoida bo'yicha 2, 4 yoki 6 harakat (me'yor: 1.6–6.8 harakat) cho'zish kerak!"
                            )
                    else:
                        is_lazim_madd = unit.has_madd_wave and (unit.weight >= 5.0 or exp_harakaat >= 5.5 or "madd_6" in rule)
                        is_wajib_madd = not is_lazim_madd and (unit.has_madd_wave or exp_harakaat >= 3.5 or "madd_4" in rule)
                        if is_lazim_madd:
                            m_target, m_min, m_max, m_rule, m_title = 6.0, 4.8, 6.8, "madd_6", "Madd Lazim (6 harakat)"
                        elif is_wajib_madd:
                            m_target, m_min, m_max, m_rule, m_title = 4.0, 3.3, 5.5, "madd_4", "Madd Wajib Muttasil / Jaiz Munfasil (4–5 harakat)"
                        else:
                            m_target, m_min, m_max, m_rule, m_title = 2.0, 1.6, 2.8, "madd_2", "Madd Tabiiy (2 harakat)"

                        if (m_min - madd_slack) <= unit_harakaat <= (m_max + madd_slack):
                            let_status = "perfect"
                            let_score = max(let_score, 99.0)
                            let_rule = m_rule
                            let_issue = ""
                        elif unit_harakaat < (m_min - madd_slack):
                            let_status = "mistake" if strictness_level >= 70 else "warning"
                            let_score = round(max(35.0, (unit_harakaat / m_target) * 78.0), 1)
                            let_rule = m_rule
                            let_issue = (
                                f"«{raw_ch}» harfida {m_title} qisqa o'qildi: amalda {unit_harakaat:.1f} harakat cho'zildi, "
                                f"qoida bo'yicha {m_target:.0f} harakat (me'yor: {m_min:.1f}–{m_max:.1f} harakat) cho'zish kerak!"
                            )
                            tip = f"{m_title} qoidasiga ko'ra unli tovushni to'liq {m_target:.0f} harakat ushlab o'qing."

                if confused_with and let_status == "perfect":
                    let_status = "mistake"
                    let_score = 52.0
                    let_issue = f"«{raw_ch}» o'rniga «{confused_with}» eshitildi."

                # ПРОВЕРКА ТАШДИДА (Shaddah / Tashdid)
                if unit.has_shaddah and let_status == "perfect" and not (len(exp_words_all) > 1 and whisper_confirms_word):
                    if seg_ms < max(65.0, shaddah_min_ms * 0.78) and seg_ms < student_unit_ms * 0.85:
                        let_status = "mistake"
                        let_score = 60.0
                        let_rule = "tashdid"
                        let_issue = f"«{raw_ch}» harfidagi tashdid (shadda ّ) tushib qoldi yoki yetarlicha ushlanmadi."
                        tip = "Tashdidli harfni bir zum to'xtatib, bosim va kuch bilan ikki barobar cho'zib talaffuz qiling."

                # ПРОВЕРКА ХАРАКАТОВ по F1/F2 (при Вакфе на последней согласной не штрафуем — Item 3)
                consonant_locus_letters = {'ح', 'ع', 'خ', 'غ', 'ق', 'ص', 'ض', 'ط', 'ظ', 'م', 'ب', 'و', 'ي', 'ل', 'ن', 'ر', 'ه'}
                if (
                    not whisper_confirms_word
                    and not is_waqf_final_letter
                    and seg_ms >= 85.0
                    and voiced_frames >= 6
                    and letter not in consonant_locus_letters
                    and f1 is not None
                    and f2 is not None
                    and let_status == "perfect"
                    and unit.vowel
                ):
                    target_base = 'fatha' if 'fath' in unit.vowel else ('kasra' if 'kasr' in unit.vowel else ('damma' if 'damm' in unit.vowel else None))
                    if target_base and not unit.is_final:
                        is_clear_fatha_on_high_vowel = (
                            target_base in ('kasra', 'damma')
                            and f1 > 600.0 * tolerance_scale
                            and 1180.0 <= f2 <= 1680.0
                        )
                        is_clear_high_vowel_on_fatha = (
                            target_base == 'fatha'
                            and f1 < (310.0 / tolerance_scale)
                            and (f2 > 2120.0 or f2 < 860.0)
                        )
                        if is_clear_fatha_on_high_vowel or is_clear_high_vowel_on_fatha:
                            classified_v, classified_name = classify_nearest_vowel(
                                f1, f2, target_base=target_base, tolerance_scale=tolerance_scale
                            )
                            if classified_v != target_base:
                                let_status = "mistake"
                                let_score = 45.0
                                let_rule = "harakat"
                                exp_name = VOWEL_NAMES_UZ.get(target_base, target_base)
                                let_issue = f"«{raw_ch}» harfida harakat xato: {exp_name} o'rniga {classified_name} talaffuz qilindi."
                                tip = VOWEL_TIPS_UZ.get(target_base, "Harakatni aniq va toza talaffuz qiling.")

            # 1. Автоматический бонус (+10% к точности) для букв с сукуном и калкалой,
            # чтобы естественные акустические паузы микрофона не трактовались как срыв махраджа:
            is_sukun_unit = (
                unit.vowel == 'sukun'
                or '\u0652' in (unit.raw_char or '')
                or unit.vowel is None
                or not unit.vowel
            )
            is_qalqalah_unit = (
                ("qalqalah" in rule and letter in ["ق", "ط", "ب", "ج", "د"])
                or (is_sukun_unit and letter in ["ق", "ط", "ب", "ج", "د"])
            )
            if is_sukun_unit or is_qalqalah_unit:
                let_score = min(99.0, let_score + 10.0)

            # 2. Если Whisper подтвердил совпадение согласных букв (даже при небольшой погрешности формант):
            # минимальная оценка за букву не опускается ниже 80% в стандартном режиме (и 85% при 50-75%).
            # Но НЕ затираем выявленные ошибки правил Таджвида (Item 1)!
            is_tajweed_rule_violation = (
                let_rule in ("tafkhim", "qalqalah", "ghunnah", "madd_2", "madd_4", "madd_6")
                and let_status in ("mistake", "warning")
            )
            rec_bare_text = normalize_arabic(recognized_text or "", keep_harakaat=False)
            consonant_recognized = (
                whisper_confirms_word
                or (letter in rec_bare_text)
                or (confused_with is None and (not c_mistake or c_mistake.get("rule") != "makhraj_critical"))
            )
            if consonant_recognized and (not confused_with or confused_with == letter) and not is_tajweed_rule_violation:
                min_recognized_score = 85.0 if strictness_level <= 75 else 80.0
                if let_score < min_recognized_score:
                    let_score = min_recognized_score
                if let_score >= pass_threshold:
                    let_status = "perfect"
                    let_issue = ""

            # При мягком режиме строгости (50% - 60%) мелкие отклонения переводим в совет (warning)
            if strictness_level <= 60 and let_status == "mistake" and let_score >= 50.0:
                let_status = "warning"
                let_score = max(70.0, let_score + 15.0)
                if not let_issue.startswith("Maslahat:"):
                    let_issue = f"Maslahat: {let_issue}"

            if let_status == "mistake":
                makhraj_severe_errors += 1

            letter_evaluations.append(
                LetterEvaluation(
                    letter=raw_ch,
                    rule=let_rule,
                    status=let_status,
                    score=let_score,
                    detected_letter=confused_with,
                    f2_hz=round(f2, 1) if f2 is not None else None,
                    zcr=round(zcr, 3),
                    onset_ratio=round(onset_ratio, 2),
                    issue_uz=let_issue,
                    anatomical_tip_uz=tip,
                    word_index=unit.word_index,
                    word_arabic=unit.word_arabic,
                )
            )

        # Гарантируем, что ВСЕ выявленные ошибки из letter_confusions / cluster_mistakes
        # присутствуют в letter_evaluations с точным указанием word_index и word_arabic
        for cm in letter_confusions:
            if cm.get("status") == "mistake":
                cm_base = cm.get("base_char") or cm.get("expected")
                cm_w_idx = cm.get("word_index") if cm.get("word_index") is not None else (failed_word_index or 0)
                cm_w_ar = cm.get("word_arabic") or (exp_words_all[cm_w_idx] if cm_w_idx < len(exp_words_all) else "")
                already_in = any(
                    le.status == "mistake"
                    and (le.word_index == cm_w_idx or le.word_index is None)
                    and (le.letter == cm.get("letter") or le.letter == cm_base)
                    for le in letter_evaluations
                )
                if not already_in:
                    letter_evaluations.append(
                        LetterEvaluation(
                            letter=cm.get("letter") or cm_base or "x",
                            rule=cm.get("rule", "harakat"),
                            status="mistake",
                            score=float(cm.get("score", 35.0)),
                            detected_letter=cm.get("recognized"),
                            f2_hz=None,
                            zcr=0.0,
                            onset_ratio=0.0,
                            issue_uz=cm.get("issue", "Xatolik aniqlandi."),
                            anatomical_tip_uz=cm.get("tip", "Harf va harakatni to'g'ri talaffuz qiling."),
                            word_index=cm_w_idx,
                            word_arabic=cm_w_ar,
                        )
                    )

        # 5. ИНДИВИДУАЛЬНАЯ КАНОНИЧЕСКАЯ ПРОВЕРКА МАДДА ПО КОНСЕНСУСУ 10 ШЕЙХОВ (ПО ВОКАЛИЗОВАННОЙ ЭНЕРГИИ rms > 0.22 * peak_rms)
        madd_slices_ms = [
            compute_voiced_madd_duration_ms(y_active[start_s:end_s], 16000)
            for u, start_s, end_s in letter_slices
            if not u.is_silent and (u.base_char in ['ا', 'و', 'ي'] or u.has_dagger_alif or u.has_madd_wave)
        ]
        if madd_slices_ms and student_unit_ms > 0:
            raw_madd_harakaat = float(np.max(madd_slices_ms)) / max(student_unit_ms, 65.0)
            word_pace_harakaat = (active_dur_ms / max(student_unit_ms * max(total_weight, 1.5), 100.0)) * exp_harakaat
            measured_harakaat_val = round(max(raw_madd_harakaat, word_pace_harakaat), 1)
        elif duration_ratio is not None and duration_ratio > 0:
            measured_harakaat_val = round(exp_harakaat * min(duration_ratio * tolerance_scale, 1.4), 1)
        else:
            measured_harakaat_val = exp_harakaat

        if len(exp_words_all) > 1 and whisper_confirms_word and not letter_confusions:
            measured_harakaat_val = max(measured_harakaat_val, exp_harakaat)

        is_recitation_madd_arid = any(
            getattr(u, 'is_madd_arid', False)
            for u in phonetic_units
            if (len(exp_words_all) <= 1 or u.word_index == len(exp_words_all) - 1)
        )
        madd_ok, consensus_match_score, madd_issue = evaluate_madd_by_ten_sheikhs_consensus(
            measured_harakaat_val,
            exp_harakaat,
            student_unit_ms,
            strictness_level,
            is_arid_lis_sukoon=is_recitation_madd_arid,
        )
        if abs(measured_harakaat_val - exp_harakaat) <= madd_tolerance_harakaat or (
            is_recitation_madd_arid and 1.7 <= measured_harakaat_val <= 6.5
        ):
            madd_ok = True
            consensus_match_score = max(consensus_match_score, 98.0)
            for le in letter_evaluations:
                if le.rule in ("harakat", "madd_2", "madd_4", "madd_6") and (
                    "cho'zish" in (le.issue_uz or "")
                    or "madd" in (le.issue_uz or "").lower()
                    or exp_harakaat <= 2.5
                    or is_recitation_madd_arid
                ):
                    le.status = "perfect"
                    le.score = 98.0
                    le.issue_uz = ""
                    le.anatomical_tip_uz = "Me'yorida to'g'ri cho'zildi."

        duration_ratio = round(measured_harakaat_val / max(exp_harakaat, 1.0), 3)
        dur_score_factor = 1.0 if madd_ok else max(0.7, consensus_match_score / 100.0)

        # 6. ОПРЕДЕЛЕНИЕ КОНКРЕТНОГО ОШИБОЧНОГО СЛОВА И ИТОГОВОГО БАЛЛА:
        mistake_letters = [le for le in letter_evaluations if le.status == "mistake" or le.score < pass_threshold]
        if mistake_letters and failed_word_index is None:
            first_m_let = mistake_letters[0]
            if first_m_let.word_index is not None and 0 <= first_m_let.word_index < len(exp_words_all):
                failed_word_index = first_m_let.word_index
                failed_word_arabic = exp_words_all[failed_word_index]
            elif exp_words_all:
                failed_word_index = max(0, spoken_words_count - 1)
                failed_word_arabic = exp_words_all[failed_word_index]

        if failed_word_index is not None:
            verified_words_count = min(verified_words_count, failed_word_index)
            spoken_words_count = failed_word_index + 1
            letter_evaluations = [
                le for le in letter_evaluations if le.word_index is None or le.word_index <= failed_word_index
            ]
            mistake_letters = [le for le in letter_evaluations if le.status == "mistake" or le.score < pass_threshold]

        has_any_mistake = len(mistake_letters) > 0 or failed_word_index is not None
        total_eval_letters = max(1, len(letter_evaluations))
        avg_letter_score = (
            sum(le.score for le in letter_evaluations) / total_eval_letters
            if letter_evaluations
            else 95.0
        )

        if text_sim < 0.35 and not has_text_harakat_err:
            final_score = round(max(20.0, text_sim * 65.0), 1)
            final_status = "mistake"
            final_issue = text_issue or f"So'z xato o'qildi. «{recognized_text}» eshitildi."
            multi_sheikh_consensus = final_score
        elif has_any_mistake:
            first_err = mistake_letters[0] if mistake_letters else None
            err_ratio = max(0.15, len(mistake_letters) / total_eval_letters)
            proportional_score = 0.65 * avg_letter_score + 0.35 * (text_sim * 100.0) - (err_ratio * 12.0)
            final_score = round(max(28.0, min(58.0 if failed_word_index is not None else 91.0, proportional_score)), 1)
            final_status = "mistake"
            if first_err and first_err.issue_uz:
                final_issue = first_err.issue_uz
                if first_err.anatomical_tip_uz:
                    final_issue += f" {first_err.anatomical_tip_uz}"
            else:
                final_issue = text_issue or f'"{failed_word_arabic or exp_text}" so\'zida xato aniqlandi.'
            multi_sheikh_consensus = round(max(35.0, min(92.0, 0.6 * final_score + 0.4 * consensus_match_score)), 1)
        elif text_sim < 0.70:
            final_score = round(max(45.0, text_sim * 88.0 * dur_score_factor), 1)
            final_status = "mistake"
            final_issue = text_issue or madd_issue or "Ayrim harf yoki so'zlar chala qoldi."
            multi_sheikh_consensus = final_score
            if failed_word_index is None and exp_words_all:
                failed_word_index = max(0, spoken_words_count - 1)
                failed_word_arabic = exp_words_all[failed_word_index]
        elif not madd_ok and not is_live_chunk:
            final_score = round(max(55.0, (0.6 * avg_letter_score + 0.4 * consensus_match_score) * dur_score_factor), 1)
            final_status = "mistake"
            final_issue = madd_issue or "Madd qoidasi 10 qori me'yoriga yetmadi."
            multi_sheikh_consensus = consensus_match_score
            if failed_word_index is None and exp_words_all:
                failed_word_index = max(0, spoken_words_count - 1)
                failed_word_arabic = exp_words_all[failed_word_index]
        else:
            final_score = round(min(99.0, 0.55 * (88.0 + text_sim * 10.0) + 0.45 * consensus_match_score), 1)
            final_status = "correct"
            final_issue = "Mashaalloh! Maxraj va tajvid qoidalari 10 qori me'yori asosida to'g'ri o'qildi."
            multi_sheikh_consensus = consensus_match_score

        measured_f2_overall = next(
            (le.f2_hz for le in letter_evaluations if le.f2_hz is not None), None
        )

        return AnalyzeRecitationResponse(
            score=final_score,
            status=final_status,
            detected_issue=final_issue,
            duration_ms=active_dur_ms or total_dur_ms,
            recognized_text=recognized_text,
            letter_evaluations=letter_evaluations,
            text_similarity=round(text_sim, 3),
            duration_ratio=round(duration_ratio, 3) if duration_ratio is not None else None,
            madd_ok=madd_ok,
            multi_sheikh_consensus=multi_sheikh_consensus,
            strictness_level=strictness_level,
            student_unit_ms=round(student_unit_ms, 1),
            is_live_chunk=is_live_chunk,
            spoken_words_count=spoken_words_count,
            verified_words_count=verified_words_count,
            total_words_count=total_words_count,
            spoken_letter_count=spoken_letter_count,
            failed_word_index=failed_word_index,
            failed_word_arabic=failed_word_arabic,
            metrics=AcousticMetrics(
                rms_mean=round(float(np.mean(rms_frames)) if rms_frames else 0.05, 4),
                rms_max=round(raw_peak, 4),
                peak_db=round(peak_db, 1),
                active_duration_ms=active_dur_ms,
                f1_hz=520.0,
                f2_hz=measured_f2_overall or 0.0,
                onset_max=0.6,
                onset_ratio=2.2,
                measured_harakaat=measured_harakaat_val,
            ),
        )

    except Exception as e:
        print(f"[Analyze Recitation Error] {e}")
        return AnalyzeRecitationResponse(
            score=50.0,
            status="mistake",
            detected_issue="Tahlilda noaniqlik yuz berdi. Iltimos qaytadan o'qing.",
            duration_ms=1000,
            recognized_text="",
            letter_evaluations=[],
            metrics=AcousticMetrics(
                rms_mean=0.05,
                rms_max=0.2,
                peak_db=-20.0,
                active_duration_ms=1000,
                f1_hz=520.0,
                f2_hz=1350.0,
                onset_max=0.5,
                onset_ratio=1.0,
                measured_harakaat=2.0,
            ),
        )

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
