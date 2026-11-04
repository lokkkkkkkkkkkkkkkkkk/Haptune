# Haptune (触乐): the practice coach that taps your wrist

Play from your sheet music. Your iPhone, iPad or Mac listens, follows the score, and your Apple Watch
taps you **the moment** a note is wrong, out of tune or out of time. After each take you get a marked-up
score, a bar-by-bar chart and a practice plan. **Band Split** turns any band recording into a part for
every instrument (audio, sheet music, chords) so you can practise your line with the rest of the band.

```
 mic ──► iPhone / iPad / Mac: score follower ──► Watch: haptic tap + glyph   (live, ~0.1 s)
              │
              ├──► take audio ──► server: full analysis ──► report (coloured score, tempo, intonation, plan)
              └──► band recording ──► server: Band Split ──► voice / violin / keys / bass / drums parts
```

**Platforms:** iPhone, iPad, Mac (Mac Catalyst) and Apple Watch, one code base. Health-app style:
Summary · Library · Band Split · Tools, with a sidebar on iPad and Mac.

**Languages:** English, Bahasa Melayu, 简体中文, 繁體中文 (switch in Account > Language).

**Instruments:** piano, keyboard, violin, viola, cello, double bass, guitar, bass guitar, ukulele, voice
(soprano/alto/tenor/bass), flute, recorder, clarinet, alto/tenor sax, trumpet, trombone, horn, erhu, dizi,
guzheng, and percussion (rhythm only). Transposing instruments are handled automatically.

**Scores in:** MusicXML (.musicxml/.xml/.mxl) and MIDI on the device; jianpu 简谱 text; PDF, photo or
camera scan of printed music (OMR); ABC, MEI and Humdrum; a solo recording (→ sheet music); a band
recording or video (→ Band Split); an Apple Music / Spotify / YouTube link (→ record it playing, then split);
generated scales and arpeggios.

## What is in this folder

| Path | What it is | Status |
|---|---|---|
| `engine/` | Python engine: score import, pitch tracking, polyphonic analysis, alignment, scoring, live follower, OMR, recording→score, **band split** (source separation, lead-line extraction, chords), reports, CLI | 31 tests pass |
| `server/` | FastAPI service for the heavy jobs (OMR, transcription, band split as a background job, full report) + Dockerfile | 6 API tests pass |
| `apple/` | Swift: `PracticeCore` package (parser, MIDI, DSP, follower; shared with the Watch), the app for iPhone/iPad/Mac, the Watch app, String Catalogs, StoreKit test file | Written and syntax-checked; compiled by GitHub Actions (see `apple/README.md`) |

## Features

* **Three practice modes:** *Follow Me* (cursor follows your tempo), *Wait for Me* (score waits for the right
  note), *Metronome* (judged against a silent metronome on the Watch, so the microphone hears only you).
* **Watch vocabulary:** wrong note = strong double tap + the right note on screen · sharp = rising tap ·
  flat = falling tap · rushing = 3 quick taps · dragging = 2 slow taps · clean loop = success chime.
* **Band Split:** pick who is playing (voice, violin, keyboard…), and the recording becomes one track and one
  staff per instrument, plus a chord chart. The mixer solos, mutes and slows the band down without changing
  pitch; *Practise* on any part plays the rest of the band while the Watch coaches you.
* **Summary:** practice time vs. your daily goal, streak, accuracy trend, in-tune rate and plain-language
  highlights ("Your accuracy on Minuet in G rose from 78% to 94%"), like the Health app.
* **Loops & tempo ladder**, tap a note to loop from its bar, tuner, metronome with tap tempo, scale generator.
* **Sync:** iCloud keeps pieces and history the same on iPhone, iPad and Mac. Backups are one .zip you can keep
  in Files, Google Drive, Dropbox or OneDrive.
* **Haptune Plus** (StoreKit 2): Band Split, scanning, recording→sheet music and full reports, with a free first
  try of each. Practice, Watch feedback, tuner, metronome, scales and sync stay free.

## Validation (honest numbers)

| Check | Result |
|---|---|
| MusicXML parser vs music21 (300 corpus files) | 99.99 % of notes identical |
| PDF → score (OMR), clean printed single-staff page | 58/58 notes, ~9 s per page on CPU |
| Planted wrong / missed notes found (14 instruments, synthetic takes) | 100 %, 0 false alarms |
| Live follower decision latency (mono / chords) | ~0.1 s / ~0.13 s |
| Recording → sheet music (solo instrument) | exact notes, tempo within 3 %, key and metre correct |
| **Band split, real 3:26 phone recording (voice + violin + keyboard)** | voice cleanly separated; violin and keyboard split with some overlap; key, tempo and a chord chart found; ~13 min on a 2-core CPU |
| Violin line out of a keyboard mix, synthetic stress test (piano as loud as the violin, same register) | ~3 of 4 violin notes recovered |
| Chord recognition on a synthetic waltz | all four chords of the progression found |
| Live chord feedback (piano/guitar) | beta: some false taps in noisy rooms; the post-take report is reliable |

## Run it

```bash
# engine (Python 3.11+)
cd engine
pip install numpy scipy soundfile music21 mido verovio pymupdf onnxruntime   # + homr for PDF import
python -m haptune demo samples                                   # synthetic takes + HTML reports
python -m haptune analyze score.musicxml take.wav -i violin --report report.html
python -m haptune split song.m4a -i voice,violin,keyboard -o split/    # band split + mixer page
python -m haptune transcribe solo.mp3 -i flute -o solo.musicxml
python -m pytest -q tests

# server
cd server && pip install -r requirements.txt && uvicorn app:app --port 8000
# or: docker build -f server/Dockerfile -t haptune . && docker run -p 8000:8000 haptune
```

The Apple apps: see `apple/README.md` (including building without a Mac, screenshots from CI, and
setting up subscriptions, iCloud and TestFlight).

## Known limits / next steps

1. **Real recordings.** Record 20-30 takes per instrument (phone on a stand, normal room) and tune thresholds.
2. **Band Split** separates voice, drums and bass with trained models; a melody instrument (violin, flute, erhu)
   is found inside the rest by pitch tracking, so where violin and keyboard play the same notes some notes land
   in the wrong part. Demucs (`pip install demucs`, needs PyTorch) adds dedicated piano and guitar stems.
3. OMR is strong on clean printed single-staff music, weaker on dense piano scores, handwriting and skewed photos.
4. The Watch app taps while it is on screen: set *Return to Clock → Haptune → Return to App* on the Watch.

## Third-party pieces and licences

Verovio (LGPL-3.0, engraving), music21 (BSD-3), ZIPFoundation (MIT), homr (AGPL-3.0, OMR, server only).
Band Split downloads MDX-Net models from the UVR project's GitHub releases (Kim Vocal 2, KUIELab MDX-Net);
Demucs (MIT) is used instead when installed. **Before charging money:** keep the server code open (AGPL), or
replace homr, and check the licence of each separation model you ship, or switch to Demucs.
