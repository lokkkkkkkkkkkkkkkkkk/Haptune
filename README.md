# Melovyn: the sheet music for any song, and practice that listens

**Two things, done well.** (1) Get the score: search a song name, drop a PDF, photo, MusicXML or MIDI, or type 簡譜;
4,900 free pieces are built in. (2) **Stage**, the community: request any song, musicians write it, play the daily
challenge with friends, earn Notes that unlock Pro days. Then practise with an app that hears every note.

* Website: `https://haptune.name.my/` (landing page) and `/app/` (the app, installable on PC, iPad, iPhone).
  Android: Google Play (`web/ANDROID.md`).
* **What only the owner can do to go live (domain, Stripe, DuitNow QR, Fly secrets): see [SETUP.md](SETUP.md).**
* Plans: Free (practice, exact imports, 簡譜, key change, mixer, editor, export, free library, Stage), Plus (AI song
  finder, tutor), Pro (AI reads PDFs and photos). Pay by card (Stripe), Google Play, or DuitNow / bank transfer.
* Tests: `cd web && npm test && npm run build && npm run e2e` (browser walk-through at phone, tablet and PC sizes);
  `cd server && python -m pytest -q`.

The sections below describe the earlier parts of the project in detail.

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
camera scan of printed music (read by AI, or classic OMR); a song name or link (AI finds the sheet music);
ABC, MEI and Humdrum; a solo recording (→ sheet music); a band
recording or video (→ Band Split); an Apple Music / Spotify / YouTube link (→ record it playing, then split);
generated scales and arpeggios.

## What is in this folder

| Path | What it is | Status |
|---|---|---|
| `engine/` | Python engine: score import, pitch tracking, polyphonic analysis, alignment, scoring, live follower, OMR, recording→score, **band split** (source separation, lead-line extraction, chords), reports, CLI, and the **AI sheet-music reader** (`haptune/ai/`) | 49 tests pass (1 skipped) |
| `server/` | FastAPI service for the heavy jobs (OMR, transcription, band split, full report), the **AI reader, song finder and tutor**, **accounts and plans** (`accounts.py`), the **community** (`community.py`) and **Academy classes** + Dockerfile and Fly.io config | 34 API tests pass |
| `apple/` | Swift: `PracticeCore` package (parser, MIDI, DSP, follower; shared with the Watch), the app for iPhone/iPad/Mac, the Watch app, String Catalogs, StoreKit test file | Compiled by GitHub Actions (see `apple/README.md`) |
| `web/` | The app (Preact) for Android (Capacitor, `web/android/`), PCs and phones in the browser: library, Play Along, real piano playback with a MuseScore-style cursor, the **Community** (requests, Q&A, library, challenges, leaderboards, profiles), plans, Academy, tools | 32 unit tests + click-through tests pass; see `web/README.md` and `web/ANDROID.md` |

## The community (`server/community.py`, Community tab)

* **Requests.** Ask for any song's score with a link to listen (YouTube is only linked, never downloaded) or photos/PDF
  of the page. Others tap "I want this too" and can add credits to the reward. A helper taps "I'll make it" (theirs for
  48 hours), makes the score in any notation app or in Melovyn and sends MusicXML. The requester opens it in Melovyn,
  plays it, then accepts it with stars or asks for changes. Closing an unanswered request returns every credit.
* **Rewards.** The helper gets the whole reward plus a Melovyn bonus = size (10 + 1 per 20 notes, up to 60) × speed
  (×1.5 within a day, ×1.25 within 3 days, ×0.8 after a week) × stars (×0.5 to ×1.5), at most 300 a request and 600 a day
  per helper. Other useful scores (up to 40) and helpful comments (5) are thanked too. Credits are never bought or paid
  out, and nothing in the app needs them.
* **Copyright.** Scores of copyrighted songs are visible only to the requester and the people who wanted it; only
  public-domain music and people's own work are listed in the Library.
* **Q&A** (the free alternative to the AI tutor), the **Library** of shared scores, practice **wins**, a **weekly
  challenge** (a public-domain song, best Play Along accuracy wins), **leaderboards**, **profiles with badges**,
  follows, blocks, reports (three reports hide a post until reviewed), notifications, and in-app **feedback**.
* **Developer panel** (unlocked with `HAPTUNE_ADMIN_CODE`): members, AI use this month, reports, the feedback inbox,
  giving plans or credits.

## Plans (`server/accounts.py`)

Free covers everything that costs nothing to run. Plus (RM 14.90 / US$3.99 a month, RM 99.90 / US$24.99 a year) and
Pro (RM 29.90 / US$7.99, RM 229.90 / US$59.99) add the features that call the paid AI API, plus all improviser styles,
more open requests, spotlights and bonus credits. The developer account has no limits. Purchases go through Google Play
and RevenueCat; see [web/ANDROID.md](web/ANDROID.md).

**AI allowances follow what the AI costs, so no plan loses money.** Each member gets a monthly AI budget (Plus US$1.20,
Pro US$3.60, well under what the plan earns after the store's 15%), split between reading music (60%), the song finder
(25%) and the tutor (15%). The server turns it into pages, searches and answers from the cost of the model each feature
runs on (`fly.toml`):

| Reading music on | Plus: pages a month | Pro |
|---|---|---|
| Opus 5.5 (now; accuracy measured below) | 2 | 7 |
| Sonnet 5.5, Opus re-reads doubtful bars | 3 | 11 |
| Haiku 5.5, Opus re-reads doubtful bars | 11 | 33 |
| Haiku 5.5 only | 36 | 108 |

The tutor runs on Haiku 5.5 (Plus 360 answers, Pro 1,080) and the song finder on Sonnet 5.5 (1 and 3 searches; a song
anyone searched in the last 7 days is answered from a shared cache, free and without using the allowance). Before
switching the reader, run **Actions → ai-bench** (with the `ANTHROPIC_API_KEY` repository secret): it reads pages with
known answers on each model and reports notes read exactly and the cost, within a budget you set.

## Online features: AI reader, song finder, classes

* **AI sheet-music reader.** A PDF or photos of printed (or neat handwritten) music become MusicXML the app
  plays like any other file: notes, rests, ties, tuplets, chords, dynamics, articulations, slurs, tempo marks,
  repeats, lyrics and chord symbols. Each page is split into systems, every system is read by Claude, each bar
  is checked (does it add up to the time signature? right number of staves? sensible range?) and doubtful
  bars are read again zoomed in. Bars it still isn't sure of are marked on the score so you can check them.
* **Find a song.** Type a song name or paste a YouTube / Spotify / Apple Music link. The server searches the
  web for free sheet music (MusicXML, MIDI, ABC, PDF), checks each link really is a music file, and adds the
  one you pick. YouTube is used for listening only.
* **Academy classes.** A teacher makes a class and shares a 6-letter code. Assignments say which piece, which
  bars, what speed and score to aim for, and when they open and are due. Students practise whenever they like
  before the due date; each Play Along try can be handed in, and the teacher answers with stickers, a comment
  and the bars to work on. Each class has an activity feed and a weekly leaderboard.
* **Hapi the tutor** answers music questions in the app's language.

People using the apps never type a server address or a key: the address is built into the apps, and the
Claude API key stays on the server. Each device gets a fair daily allowance of AI reads and searches.

### Turn on the server (one time, by the developer)

1. Create a [Fly.io](https://fly.io) account (Fly asks for a payment card; the server sleeps when nobody is
   using it), install `flyctl`, and run `fly apps create haptune`
   (pick another name if it is taken and change `app` in `fly.toml`), then
   `fly volumes create haptune_data --region sin --size 1` for the Academy database.
2. `fly secrets set ANTHROPIC_API_KEY=sk-ant-...` (from console.anthropic.com). The key never leaves the server.
   In the Anthropic Console, also set a monthly spend limit, so a busy day can't cost more than you planned.
   Also `fly secrets set HAPTUNE_ADMIN_CODE=<a long code only you know>`: typing it in the app (Account → Developer
   access) gives your account every feature with no limits and the developer panel.
3. `fly tokens create deploy`, and save the token as the repository secret **FLY_API_TOKEN**
   (GitHub: Settings → Secrets and variables → Actions → New repository secret).
4. Add the repository **variable** **HAPTUNE_SERVER_URL** = `https://<app-name>.fly.dev`
   (same page, Variables tab). The web build and the iPhone app read it, so both talk to your server.
5. Merge to `main`. `.github/workflows/server.yml` tests and deploys the server; the web app and the
   iPhone build pick up the address on their next build. (Deploying by hand instead: `fly deploy --ha=false`
   from a checkout of the branch.) The server must run as **one** machine: read jobs are kept in memory and the
   Academy database is on its volume. If `fly status` ever shows two, run `fly scale count 1`.

What the AI costs (Claude Opus 5.5): a page of music $0.17-0.65 and a tutor answer about $0.01 (measured); a
song search about $0.28 with three web searches, and up to about $1 when it searches and opens more pages
(most of it is the web pages it reads). Limits per device per day can be
changed with `HAPTUNE_READS_PER_DAY`, `HAPTUNE_FINDS_PER_DAY` and `HAPTUNE_TUTOR_PER_DAY`, and the whole
server's daily caps with `HAPTUNE_READS_ALL_PER_DAY` (60), `HAPTUNE_FINDS_ALL_PER_DAY` (40) and
`HAPTUNE_TUTOR_ALL_PER_DAY` (300) (Fly secrets or `[env]` in `fly.toml`). Without a key the apps still work;
only the AI features say they are not switched on yet.

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
* **Melovyn Plus** (StoreKit 2): Band Split, scanning, recording→sheet music and full reports, with a free first
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
| AI reader (Claude Opus 5.5), engraved pages with known answers: Minuet in G for violin, for piano, and the piano page as a tilted, blurred, unevenly lit photo-like JPEG | 64/64, 94/94 and 94/94 notes exact; 12-33 s and about $0.17 a page |
| AI reader, denser 12-bar pages: Mozart K. 545 (piano), Maple Leaf Rag (piano), Schumann *Dichterliebe* No. 2 (voice + piano, lyrics) | 189/191, 185/193 and 134/146 notes exact. Slips: a whole-note chord, a natural sign on the wrong chord note, a clef change in mid-line, missed ties. Most wrong bars were marked as unsure. 22-90 s, $0.23-0.65 a page |
| Song finder, "Ode to Joy easy piano" (web search only) | 7 free, legitimate sources with licence and level in 48 s; about $0.28 |

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
3. Classic OMR is strong on clean printed single-staff music, weaker on dense piano scores, handwriting and
   skewed photos; the AI reader handles those better, and marks any bar it is unsure of. It has been tested
   against the real API on engraved pages with known answers (see Validation); real scans, phone photos of
   real pages and handwriting are the next thing to compare against their originals.
4. The Watch app taps while it is on screen: set *Return to Clock → Melovyn → Return to App* on the Watch.

## Third-party pieces and licences

Verovio (LGPL-3.0, engraving), music21 (BSD-3), ZIPFoundation (MIT), homr (AGPL-3.0, OMR, server only),
Preact (MIT) and PDF.js (Apache-2.0) in the web app.
Band Split downloads MDX-Net models from the UVR project's GitHub releases (Kim Vocal 2, KUIELab MDX-Net);
Demucs (MIT) is used instead when installed. **Before charging money:** keep the server code open (AGPL), or
replace homr, and check the licence of each separation model you ship, or switch to Demucs.
