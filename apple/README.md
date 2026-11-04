# Haptune for iPhone, iPad, Mac and Apple Watch

```
apple/
  Packages/PracticeCore/   Swift package used by the app AND the Watch
     Score.swift            canonical score model (same JSON as the Python engine)
     MusicXMLParser.swift   MusicXML/.mxl import: chords, voices, ties, transposition, repeats, D.C./D.S.
     MIDIFile.swift         MIDI import on the device; zip/unzip for library backups
     MusicXMLWriter.swift   score -> MusicXML (jianpu, MIDI and exercises get engraved), scale generator
     Jianpu.swift           简谱 text import
     DSP.swift              FFT, YIN pitch tracker, log-frequency filterbank, harmonic templates, NMF
     ScoreFollower.swift    the live follower (port of engine/haptune/follower.py)
     Feedback.swift         Watch events, haptic table, rate limiting
     Tests/                 XCTest: parser, MIDI, DSP accuracy, follower on synthetic audio
  iOS/                     the app (iPhone, iPad, and Mac via Mac Catalyst)
     Views/                 Summary, Library, Practice, Band Split + mixer, Tools, Account, Paywall
     Models/                library + history (iCloud-ready files), settings, importer, demo data
     Services/              StoreKit 2, band-split jobs, stem player, link import, reminders, Watch link
     Resources/             Localizable.xcstrings (en, ms, zh-Hans, zh-Hant), Verovio, demo trio
  Watch/                   watchOS app: haptic coach, silent metronome (Digital Crown), last take
  Shared/                  iPhone <-> Watch message format
  Haptune.storekit         subscription + lifetime products for testing purchases without App Store Connect
  project.yml              XcodeGen spec (generates Haptune.xcodeproj)
  scripts/screenshots.sh   screenshots of every screen on iPhone, iPad and Watch simulators
```

## Build and see it without a Mac (GitHub Actions)

1. Push this folder to your GitHub repository (the workflow is `.github/workflows/apple-build.yml`).
2. The **Actions** tab then, on every push:
   * runs `swift test` for PracticeCore;
   * builds the iPhone/iPad app, the Mac app (Mac Catalyst) and the Watch app;
   * opens every screen on iPhone, iPad and Watch simulators with demo data, in English and Chinese, and saves
     screenshots. Download them from the run page under **Artifacts → screenshots**.
3. Red = a compile error; the log shows the file and line. Green = everything builds.

Public repositories get these macOS minutes free; private ones use your free minutes at a 10x rate.

**Letting Claude fix build errors directly:** on github.com open *Settings → Applications → Installed GitHub
Apps → Claude → Configure*, and add this repository under *Repository access*. Then Claude can read the
Actions logs and push fixes itself instead of you pasting logs.

## Install on your own devices

You need Xcode (a borrowed Mac or a rented cloud Mac):

```bash
brew install xcodegen
cd apple && xcodegen generate && open Haptune.xcodeproj
```

1. *Haptune* target → *Signing & Capabilities* → choose your team (a free Apple ID works for your own
   devices; apps expire after 7 days). Change `com.example.haptune` in `project.yml` to your own prefix first.
2. **iPhone + Watch:** plug in the iPhone (paired with the Watch) and press Run; the Watch app installs with it.
3. **iPad:** same, with the iPad as the run destination.
4. **Mac:** choose *My Mac (Mac Catalyst)* as the destination and press Run.

## Turn on the paid features (needs the Apple Developer Program, US$99/year)

* **iCloud sync:** *Signing & Capabilities → + Capability → iCloud*, tick *iCloud Documents*, add a container
  (`iCloud.<your bundle id>`). The app finds it automatically; without it, the library stays on the device.
* **Subscriptions:** in App Store Connect create a subscription group *Haptune Plus* with
  `<prefix>.plus.yearly` (1-week free trial) and `<prefix>.plus.monthly`, and a non-consumable
  `<prefix>.plus.lifetime`. Update the ids in `iOS/Services/Store.swift` and `Haptune.storekit`.
  Until then, Xcode's *Run* uses `Haptune.storekit`, so you can test the whole purchase flow in the simulator.
  Suggested prices: US$3.99 / month, US$24.99 / year, US$59.99 lifetime (about RM 14.90 / RM 99.90 / RM 249.90).
* **TestFlight for friends:** add the App Store Connect API key as repository secrets and un-comment the
  `testflight` job, or archive in Xcode (*Product → Archive → Distribute → TestFlight*). Friends install
  **TestFlight** from the App Store; they need an iPhone (Watch optional), an iPad or a Mac.

## Settings worth knowing

* **Analysis server** (Account → Analysis Server): the URL of `server/`. Needed for scanning, recording → sheet
  music, Band Split and full reports. Practice, MusicXML, MIDI, jianpu, scales and the tuner work offline.
* **Watch screen:** on the Watch set *Settings → General → Return to Clock → Haptune → Return to App*.
* **Microphone:** the app uses the *measurement* audio mode (no automatic gain). Practising with the band
  playing works best with headphones.
* **Language:** iOS also offers a per-app language in *Settings → Haptune → Language*.
