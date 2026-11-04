# Haptune Web

The installable web version of Haptune: the same practice coach as the Apple app, running in Safari on iPhone, iPad and Mac with no App Store account needed.

## What it does

- **Library and exact imports.** Reads MusicXML (`.musicxml`, `.xml`, `.mxl`), MIDI (`.mid`), ABC, ChordPro and chord-over-lyrics text, and PDF chord sheets. Everything is read on the device, so imports use no data. A typical song imports in a fraction of a second, and even a 17,000-note string quartet movement takes about 2 seconds. Timing is kept as exact fractions, never rounded decimals.
- **Up Key / Down Key.** Moves a piece up or down by semitones. Notes, key signature and chord symbols are re-spelled in the simplest key. *Find My Key* suggests keys that fit your voice range.
- **AI Improvise.** Writes a solo over any chord progression (presets or a piece from your library) in eight styles, then plays it with a backing band. There is also a *Jam* mode with a looping band.
- **Academy.** Six courses (reading, rhythm, ear training, harmony, improvisation, instrument labs) with generated quizzes, XP, badges, a daily challenge and challenge codes to send friends. An AI tutor is available in the Claude preview.
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
