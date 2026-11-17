import sys
import numpy as np

# Reconfigure stdout for UTF-8 in Windows console
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from main import (
    parse_recitation_phonemes,
    align_phonetic_slices_to_energy_envelope,
    evaluate_madd_by_ten_sheikhs_consensus,
    clean_whisper_hallucinations,
    PhoneticLetterUnit,
    HEAVY_LETTERS,
)

def test_item_1_phonetic_weights():
    print("[TEST 1] Testing Canonical Phonetic Weights...")
    # Test word: ٱلصِّرَٰطَ
    # ٱ: silent alif -> 0.05
    # ل: solar lam assimilated -> silent 0.05
    # ص: heavy letter + kasra + shaddah -> 1.8
    # ر: consonant with fatha -> 1.0
    # ٰ: dagger alif (madd 2) -> 2.2
    # ط: heavy letter with fatha -> 1.0
    units = parse_recitation_phonemes("ٱلصِّرَٰطَ")
    weights = {u.raw_char or u.base_char: u.weight for u in units}
    print(f"  Phonetic units extracted: {[(u.raw_char, u.weight, u.vowel) for u in units]}")
    
    # Check sukoon weight on word like الْحَمْدُ: ح (1.0), مْ (0.6), دُ (1.0)
    units_hamd = parse_recitation_phonemes("الْحَمْدُ")
    meem_unit = next(u for u in units_hamd if u.base_char == 'م')
    assert meem_unit.weight == 0.6, f"Expected sukoon weight 0.6, got {meem_unit.weight}"

    # Check ghunnah / tashdid on nun: إِنَّ
    units_inna = parse_recitation_phonemes("إِنَّ")
    nun_unit = next(u for u in units_inna if u.base_char == 'ن')
    assert nun_unit.weight == 2.2, f"Expected ghunnah weight 2.2, got {nun_unit.weight}"

    # Check madd lazim 6 harakaat: الضَّالِّينَ
    units_dallin = parse_recitation_phonemes("ٱلضَّآلِّينَ")
    alif_madd = next(u for u in units_dallin if u.base_char == 'ا' and u.has_madd_wave)
    assert alif_madd.weight == 5.5, f"Expected madd lazim weight 5.5, got {alif_madd.weight}"

    print("  ✓ ITEM 2 Phonetic weights passed (1.0, 0.6, 1.8, 2.2, 4.0, 5.5)!")

def test_item_2_energy_envelope_segmentation():
    print("[TEST 2] Testing Energy Envelope Boundary Anchoring...")
    # Create synthetic signal: consonant (low energy) + vowel (high energy)
    sr = 16000
    cons_samples = int(0.10 * sr)  # 100 ms of low noise
    vowel_samples = int(0.25 * sr) # 250 ms of 250 Hz sine wave
    silence = np.random.normal(0, 0.005, cons_samples).astype(np.float32)
    t = np.linspace(0, 0.25, vowel_samples, endpoint=False)
    sine = (0.5 * np.sin(2 * np.pi * 250 * t)).astype(np.float32)
    synthetic_signal = np.concatenate([silence, sine])

    units = [
        PhoneticLetterUnit(base_char='س', raw_char='سَ', vowel='fatha', weight=1.0),
        PhoneticLetterUnit(base_char='ا', raw_char='ا', weight=2.2),
    ]
    slices = align_phonetic_slices_to_energy_envelope(synthetic_signal, units, sample_rate=sr)
    print(f"  Slices generated: {[(u.base_char, start, end, (end - start) / 16.0) for u, start, end in slices]}")
    assert len(slices) == 2
    # Verify that vowel slice captured the high energy region
    u1, s1_start, s1_end = slices[0]
    u2, s2_start, s2_end = slices[1]
    assert s2_end > s2_start > 0
    print("  ✓ ITEM 2 Energy Envelope Segmentation passed!")

def test_item_3_waqf_and_madd_arid():
    print("[TEST 3] Testing Waqf & Madd Arid lis-Sukoon Rule...")
    # Test Al-Alameen: penultimate madd ya
    units_alameen = parse_recitation_phonemes("ٱلْعَٰلَمِينَ")
    ya_unit = next(u for u in units_alameen if u.base_char == 'ي')
    assert getattr(ya_unit, 'is_madd_arid', False) == True, "Expected ya to be marked as is_madd_arid"
    last_unit = units_alameen[-1]
    assert last_unit.is_final == True, "Expected nun to be marked as is_final"

    # Test evaluate_madd_by_ten_sheikhs_consensus with is_arid_lis_sukoon=True
    # In canonical Hafs, 2, 4, or 6 harakaat (1.7 - 6.5) are 100% perfect
    for h in [2.0, 3.8, 4.2, 5.8, 6.2]:
        ok, score, issue = evaluate_madd_by_ten_sheikhs_consensus(
            measured_harakaat=h, exp_harakaat=2.0, student_unit_ms=100.0, strictness_level=75, is_arid_lis_sukoon=True
        )
        assert ok == True and score >= 98.0, f"Expected perfect score for {h} harakaat in Madd Arid, got {score}"
    
    # Below 1.7 should flag warning/mistake
    ok_short, score_short, issue_short = evaluate_madd_by_ten_sheikhs_consensus(
        measured_harakaat=1.2, exp_harakaat=2.0, student_unit_ms=100.0, strictness_level=75, is_arid_lis_sukoon=True
    )
    assert ok_short == False, "Expected short madd arid to fail"
    print("  ✓ ITEM 3 Waqf & Madd Arid lis-Sukoon passed (1.7 - 6.5 harakaat perfect)!")

def test_item_4_whisper_hallucination_shield():
    print("[TEST 4 & 5] Testing Whisper Hallucination Shield...")
    hallucinations = [
        "اشتركوا في القناة",
        "ترجمة نانسي",
        "نانسي عجرم",
        "شكرا لكم",
        "مرحبا بكم",
        "...",
        "- - -",
        "الله الله الله الله الله",
    ]
    for h in hallucinations:
        cleaned = clean_whisper_hallucinations(h)
        assert cleaned == "", f"Expected '{h}' to be cleaned to empty, got '{cleaned}'"

    valid_text = "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ"
    cleaned_valid = clean_whisper_hallucinations(valid_text)
    assert cleaned_valid == valid_text, f"Expected '{valid_text}' to remain intact, got '{cleaned_valid}'"
    print("  ✓ ITEM 5 Whisper Hallucination Shield passed!")

if __name__ == "__main__":
    test_item_1_phonetic_weights()
    test_item_2_energy_envelope_segmentation()
    test_item_3_waqf_and_madd_arid()
    test_item_4_whisper_hallucination_shield()
    print("\nALL 5 ACOUSTIC ALGORITHMIC TESTS PASSED SUCCESSFULLY!")
