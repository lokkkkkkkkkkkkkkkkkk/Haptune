# Haptune Web

The installable web version of Haptune: the same practice coach as the Apple app, running in Safari on iPhone, iPad and Mac with no App Store account needed.

## What it does

- **Add music, guided.** The Add screen comes first: find a song by name or YouTube link (the server searches the web for sheet music), scan or photograph printed music (read by AI, with a short guide: title, instrument, which pages, printed or handwritten), or open a file. Bars the AI reader is unsure of are marked on the score.
- **Song screen.** Title, key, tempo and details at the top; **Play Along** first (the app listens: *Wait for me* waits on each note, *Keep the beat* plays in time), **Listen** second; a transport with bar-by-bar stepping, loops and speed; part and hand choice (right / left hand on piano); export to MusicXML, MIDI, PDF, text or a zip.
- **Library and exact imports.** Reads MusicXML (`.musicxml`, `.xml`, `.mxl`), MIDI (`.mid`), ABC, ChordPro and chord-over-lyrics text, and PDF chord sheets. Everything is read on the device, so imports use no data. A typical song imports in a fraction of a second, and even a 17,000-note string quartet movement takes about 2 seconds. Timing is kept as exact fractions, never rounded decimals.
- **Up Key / Down Key.** Moves a piece up or down by semitones. Notes, key signature and chord symbols are re-spelled in the simplest key. *Find My Key* suggests keys that fit your voice range.
- **AI Improvise.** *Vary a song*: decorates a song's own melody (light touch, balanced or free) while its main notes stay, so it still sounds like the song; compare original and variation at the same beat and save it as a new version. *New solo*: writes a solo over any chord progression in eight styles and plays it with a backing band, with a *Jam* mode.
- **Academy.** Classes with a teacher (join with a code; assignments with due dates; hand in Play Along results; stickers, comments and bars to work on; activity feed and weekly leaderboard), six courses with generated quizzes, XP, badges, a daily challenge, challenge codes for friends, and Hapi the AI tutor (needs the Haptune server).
- **Tools.** Tuner, metronome, chord finder (guitar, ukulele and piano shapes), key changer for pasted chord sheets, scale builder and drone.
- **Languages.** English, Bahasa Melayu, 简体中文 and 繁體中文.

Audio files are not transcribed in the web version. Instead, you can find a song online (Ultimate Guitar, Chordify, MuseScore, IMSLP), paste its chords, or import a PDF chord sheet.

## Run it locally

```bash
cd web
npm ci
npm test          # unit tests for pitch, chords, MusicXML/MIDI round trips, chord sheets, quizzes
npm run build     # writes dist/pages (installable app) and dist/artifact (single-file preview)
npm run serve     # http://localhost:8080
```

## Online features

The server address is set once with the repository variable `HAPTUNE_SERVER_URL`, which the Pages build passes in as `HAPTUNE_SERVER` (see the main README, "Turn on the server"). People using the app never type it. Without it, everything that runs on the device still works and the AI features say they are not available yet.

## Deploy

`.github/workflows/pages.yml` builds and publishes `web/dist/pages` to GitHub Pages on every push to `main` that touches `web/`. In the repository settings, go to **Settings → Pages** and set **Source** to **GitHub Actions** (once). The app then lives at `https://<username>.github.io/<repo>/`.

On iPhone, open that link in Safari, tap **Share**, then **Add to Home Screen**. The app opens full screen, works offline after the first visit, and can use the microphone for the tuner and live practice.

## Layout

```
src/core/     music logic (no browser APIs): exact fractions, pitch spelling, chords,
              score model, MusicXML, MIDI, ABC, chord sheets, improviser, academy, i18n
src/ui/       Preact app: screens, audio engine and synth, storage, importer, Verovio notation
src/data/     songbook (public-domain songs with chords and lyrics)
tests/        node --test unit tests; corpus.mjs compares imports against music21
tools/        smoke.cjs: Playwright click-through of the built app
build.mjs     esbuild bundle and PWA output (manifest, service worker, vendored engines)
```

Third-party code: [Verovio](https://www.verovio.org) (LGPL-3.0) draws the notation, and [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) reads PDFs. Both are bundled unmodified in `dist/pages/vendor`.
