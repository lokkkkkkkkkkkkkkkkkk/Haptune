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

## Install on your own iPhone or iPad from Windows (free, no Mac)

Every push builds **Haptune-test-app** (Actions → the run → Artifacts). It holds two files:
`Haptune.ipa` (iPhone and iPad) and `Haptune-with-Watch.ipa` (the same app with the Watch app inside).
They are test builds: every Plus feature is unlocked.

1. On the Windows PC install **iTunes** and **iCloud** from apple.com (the website versions, not the
   Microsoft Store versions), then **Sideloadly** from sideloadly.io.
2. Plug the iPhone in with a cable, unlock it and tap **Trust This Computer**.
3. Open Sideloadly, drag `Haptune.ipa` into it, type your Apple ID email and press **Start**. Enter the
   Apple ID password and the 6-digit code when asked. (You can use a second Apple ID if you prefer.)
4. On the iPhone: *Settings → Privacy & Security → Developer Mode* → on → restart → **Turn On**.
   Then *Settings → General → VPN & Device Management* → your Apple ID → **Trust**.
5. Open Haptune. The iPad is the same, with the iPad plugged in.

A free Apple ID keeps the app working for **7 days**; plug in and press Start again (your pieces stay).
Sideloadly's *automatic refresh* option does this for you while the PC is on. Free Apple IDs allow
3 sideloaded apps at a time. **Apple Watch:** try `Haptune-with-Watch.ipa`; if the Watch app does not
appear, use `Haptune.ipa` (the iPhone app works on its own) and add the Watch once you have TestFlight.

## Install with Xcode (if you can borrow a Mac)

```bash
brew install xcodegen
cd apple && xcodegen generate && open Haptune.xcodeproj
```

1. *Haptune* target → *Signing & Capabilities* → choose your team (a free Apple ID works for your own
   devices; apps expire after 7 days). Change `com.haptune.app` in `project.yml` to your own prefix if
   Xcode says the identifier is taken.
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

* **Online features** (Account → Online Features): the server address is built in at build time from the
  repository variable `HAPTUNE_SERVER_URL` (see the main README, "Turn on the server"), so nobody types it.
  It is needed for the AI reader (scans, photos, PDFs), Find a Song, recording → sheet music, Band Split and
  full reports. A developer can point one device at another server under Advanced. Practice, MusicXML, MIDI,
  jianpu, scales and the tuner work offline.
* **Watch screen:** on the Watch set *Settings → General → Return to Clock → Haptune → Return to App*.
* **Microphone:** the app uses the *measurement* audio mode (no automatic gain). Practising with the band
  playing works best with headphones.
* **Language:** iOS also offers a per-app language in *Settings → Haptune → Language*.
