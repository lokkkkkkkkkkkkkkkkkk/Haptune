# Changelog

## The 1-minute demo video (November 2026)
- **"Haptune in 1 minute"** (1:12, 1920×1080, with music): Play Along listening to a real take (92%, 57 of 62 notes),
  a PDF read into a score that checks itself, 簡譜 / slow down / loop / key, Create, the Learning hub, Stage and the
  6,600+ free pieces. Every screen is the real app. For the Google Play promo video (upload the 1080p file to YouTube)
  and the website.
- **Website**: a "See it in action" section right under the hero, and "Watch the 1-minute video" next to Get the
  app (scrolls to it and starts it). The web copy (720p, 5.5 MB) is `site/media/haptune-demo.mp4` with a poster.
  The phone hero no longer runs past the right edge; the free library count now says 6,600+ (6,679 in the index).
- **In the app**: the welcome card has "Watch the 1-minute video", which plays right in the card; it's also in
  Settings › Guide and at the top of Help. The app streams it from the website, so the download doesn't grow. The
  background music and sound effects go quiet while a video plays; the service worker leaves videos alone.

## Part 7: a phone layout of its own, and Haptune's own sounds (November 2026)
- **Phones (up to 599 px) get their own layout** (`ui/v8.css`), after Apple Health on iPhone and the iOS sizes used
  by Konsta UI and Ionic: a floating capsule tab bar with a pill behind the chosen tab, 34 px titles, 17 px text,
  52 px rows, 22 px corners; Home has a small picture top right, the three ways in as a swipeable row of big cards,
  Pinned as one big card per row (big number left, chart right), Get more and Articles as swipeable cards.
- **Background music**: 8 gentle tracks generated on the device (no audio files): Morning Light, Sunny Garden, Paper
  Boats, Warm Tea for the light theme; Night Lights, Moon Hum, Starfield, Rainy Window for the dark one. A random one
  each time the app opens (never the same as last time), the melody different every play. It goes quiet by itself
  while music plays, the microphone listens, a score is open or the app is in the background.
- **Sound effects**: a soft tick on taps, a rising note on tabs, a whoosh for sheets, a chime for "done", a low blip
  for problems. Settings › Sounds: Background music on/off, Play another track, Sound effects on/off.

## Part 6: a reader that checks itself against the page, Import in Create, versions on Stage (November 2026)
- **Score reader accuracy.** A test score (Beautiful in White, violin + piano, 71 bars) read about 80% right; most
  errors were whole bars left empty, which the checker counted as "complete" (a skipped staff was silently turned
  into a rest). Now:
  - the page itself is measured: how much is printed in every bar of every staff (`layout.bar_ink`). A staff read
    as a rest where notes are printed, notes read where the staff is empty, and the same notes on two staves that
    look different on the page are found without asking the model;
  - a staff the model leaves out is marked missing, never a rest;
  - every bar with a real problem gets a second look by the re-read model (up to 60, or half the piece); a line
    with three or more problems is read again whole in one request (runs of missing bars, swapped staves);
  - a second reading that agrees with the first confirms the bar; one that differs and checks out replaces it;
  - the reader's own "uncertain" no longer lists the bar when the second reading agrees (players were shown
    almost every bar); instructions tell the model when R is allowed, to read each staff from its own lines and
    to count lines for long notes.
  - Players see "Please check (n)": the bar, the staff and what is wrong ("Violin: notes are printed here, but
    none were read"), and "Hapi double-checked N bars and corrected M". Small doubts are folded away.
- **Create: a 4th card, Import a file** (MIDI, MusicXML, PDF or a photo), with its own little animation.
- **Stage comments: photos and your own version.** Attach a photo, and/or one of your scores as "My version".
  Under the post, "Versions made in Haptune" lists them: Play, Play Along, or copy a link
  (`#stage/post/ID/v/REPLY`) that opens the version straight away.
- **First run:** one clean welcome card (Hapi, what you play, Show me around / Maybe later); Settings has a
  Guide section (Show me around, Welcome card).
- **Hapi everywhere:** tip of the day on Home, Me page, Settings, every confirmation message.

## Part 5: Learning hub, Friends with chats, Show me around, Create, smooth playback (November 2026)
- **Google sign-in "Error 401: invalid_client, no registered origin"**: the server handed the website the first ID in
  `GOOGLE_CLIENT_IDS`, which can be the Android client. The website now uses its own Web client ID and tells the
  server, which swaps the code with that client and remembers it (also for Calendar/Drive/Contacts and the redirect
  sign-in). `/c/auth/google/status?web=…` says whether the server knows the website's client.
- **Sign out did nothing**: in the Account sheet a variable named `confirm` hid the browser's `confirm()`, so the tap
  failed. Sign out now asks in the sheet and works; Google forgets the last account so the chooser shows next time.
- **Switch account** really switches: Google (web and Android) and new accounts are no longer linked to the account
  that is signed in.
- **Navigation**: Learn is now **Learning hub**; Learning hub and Stage sit with Home, Friends and Browse at the top of
  the sidebar, never repeated in Categories; the phone menu leaves out what the tab bar already has. **Friends** now
  includes the chats (Messages folded in).
- **Show me around**: after the welcome cards, Hapi points at each real button (Home, New song, Learning hub, Stage,
  Friends, Browse, Ask Hapi). Skip any time; replay from Help, Browse, Settings or the Home card.
- **Create**: three big choices (Chords & lyrics, Melody, Record & mix) with small moving pictures and a "For you"
  hint from your instrument; Full notation, Improvise and Exercise under "More ways". Chord/rhythm songs are
  Chords & lyrics without lyrics.
- **A colour for every page**: each place has its own soft gradient that fades into the next (light and dark).
- **Hapi everywhere**: page headers, empty pages, Browse, the Create sheet, the loading screen and the Ask button.
- **Tap feedback**: presses spring, a ripple follows the finger, chosen tabs and chips pop (reduced motion: none).
- **Smooth playback** on slower phones: a light sound (no room reverb, one compressor, no per-note panning or
  vibrato, 24 voices, more look-ahead). Auto for small Android phones and whenever playback falls behind;
  Settings > Smooth playback: Auto / On / Off.

## Part 4: Home, Browse, Google sign-in that finishes, back to Haptune (November 2026)
- **Google sign-in finishes.** The "Continue as …" button was Google's iframe, which hands the answer back from a popup;
  when the browser blocks that hand-back nothing happens. Haptune now has its own **Continue with Google** button that
  opens Google's sign-in window (OAuth code, checked by the server at `/c/auth/google/code`). If the window can't open
  it goes to Google in the same tab and comes back (`/c/auth/google/start` → `/callback` → `/finish`); the Android app
  uses the same path in the phone's browser and pairs itself. Errors are said in words (for example "only test users
  can sign in while the Google app is in Testing"). SETUP §3f lists the two console settings everyone-sign-in needs.
- **Home** (was Summary), after Apple Health: profile header with date and streak, a status card, Pinned tiles with
  Edit, "Show all" into **Browse**, "Get more from Haptune" cards and short guides. The rings are gone.
- **Browse**: search plus colour category tiles for every part of Haptune.
- **Sidebar** with Home / Friends / Browse and a folding Categories list; it shrinks to an icon rail. On phones the
  same list opens as a drawer from the side.
- **Background**: a slow, soft colour wash instead of plain white or black (stops for reduced motion).
- **Motion**: tab changes use the browser's View Transitions; lists animate with AutoAnimate (MIT, 3 KB).
- **Name back to Haptune** everywhere (app, site, Android label, server mails). The Android App ID stays
  `com.sloky.melovyn`, so installed copies update.
- **Search**: clearer title and description, WebSite structured data with alternate names, absolute favicon links
  (48, 96, 192 px and SVG) so Google can show the icon.

## Part 3: Summary, one-tap Google, the microphone, brand, Melovyn 4 look (November 2026)
- **Play Along hears you again.** Two causes found and fixed in the detector (`core/detect.js`): playing (or a count-in)
  while the room was measured made it deaf to that instrument, and phone microphones with their gain control off
  (peaks near -50 dB) were below the old level gate. The room is now the quietest part of that second, the floor
  follows the room down while you play, and the gate starts much lower. A live microphone level shows in Play Along,
  and after 6 silent seconds it says what to try. Noise corpus still passes (99.8 % at 10 dB).
- **Google in one tap.** After signing in with Google, one sheet asks for Calendar, Drive and Contacts together (Google
  lets people untick any; what they allow is kept). The Android app opens the website with a one-time link for its
  account, so nothing needs signing in twice. Connections shows a tick per feature; once all are on there are no
  "Connect" buttons left, only Manage. Any feature that finds a permission missing asks for all of them once.
- **Signed in, clearly.** Settings shows who is signed in (Google email or @username) with **Switch account** and
  **Sign out** (Google accounts had no sign-out before). "Why can't I open Developer mode?" says what the server sees
  (owner not set, signed in without Google, another email). A 2-step secret the server can't read after a key change
  can be set up again instead of locking the owner out.
- **Summary** replaces the Practice home: today's rings, Continue, New · Find · Create, a tile for each part of
  Melovyn (practice time, accuracy, Learn, Stage, Create, Library, level, Google), then Discover music. A three-step
  guide for someone new, closed for good with one tap.
- **Hapi is the icon** of the website (favicon, so Google search), the web app and the Android app (all densities,
  round and adaptive). **Developer mode > Brand** (owner): change the name and icon with previews of a browser tab,
  Google search and the Android home screen; saving commits `web/brand.json` and GitHub rebuilds everything
  (`tools/brand.cjs`, `.github/workflows/brand.yml`). Setup: SETUP.md §9d.
- **Melovyn 4 look** (docs/ui-research.md, Part 3): Radix Colors slate and violet scales, inset grouped lists and
  48 px touch targets (Konsta UI, Framework7), a pill behind the chosen tab, Material 3 navigation and Roboto in the
  Android app, a grab handle on sheets, readable white text on the hero tiles in dark mode.

## Owner account, Developer mode and analytics (November 2026)
- **Roles:** owner (set only by `HAPTUNE_OWNER_EMAILS`, can't be demoted from the app) > developers (scopes and an end
  date, given and revoked by the owner) > verified teachers > users.
- **Developer mode:** a switch in Me, off by default, on per device for 8 hours after a 2-step code (authenticator app,
  recovery codes). Sign-ins and devices list with remote sign-out.
- **Dashboard:** Overview with charts, Users with timelines and actions, Activity and funnels, Features with feature
  flags, Errors, Access, an append-only Audit log; every admin endpoint checks Developer mode and its scope.
- **Analytics without third parties:** batched events to our own server, country only (no IPs), 180-day raw retention
  then daily totals; switch off in Settings; download my data; privacy policy in English, Chinese and Malay.
- Fixed: after setting up 2-step verification the app still thought it was off.

## Melovyn 3.0 (branch `melovyn-v3`, November 2026)

Driven by testers' feedback: the interface was too complicated, Stage was hard to understand, Play Along missed
notes in noisy rooms, some phones played audio with noise, and some functions felt unfinished. Everything is
measured against one goal: **everyone can get their sheets and practise directly and smoothly.**

**Name.** ETASheet is now **Melovyn** everywhere (app, website, Android ID `com.sloky.melovyn`). The domain
`haptune.name.my`, the Fly app and the `HAPTUNE_*` settings keep their names.

**Simpler, more like Apple's own apps.** Home leads with Practice, Learn and Create, with Stage below; everything
else sits in a collapsed "More tools" group. Screens slide in and out the way iOS screens do, sheets spring.

**Create** (was Write): a new-song wizard for any kind of music (lead sheet, melody, full score, improvisation,
rhythm, Sound, exercise) and a real chord-sheet editor: type lyrics, get chords, then change any chord on any beat,
with alternatives, Roman numerals, capo, voicings, sections, rhythm styles, undo, playback and export.

**Learn, at Google Classroom's level.** Stream, Classwork with topics and rubrics, People, Grades from Play Along
scores; voice feedback on bars; class sessions in Google Calendar with a Meet link; Save to Drive; invite from
Contacts, WhatsApp or an .ics file. Teachers are verified (Google-verified email plus a request) before they run
open classes or list themselves as tutors.

**Stage, made understandable.** A header that says what Stage is for, a three-step guide, plain-word post types and
one "+" button; requests show where they stand.

**Sound that works on every phone, and Play Along that copes with noise.** Fixed the feedback loop, sample-rate
mismatch and double audio contexts behind the noise some phones made; a Sound check screen. Play Along calibrates to
the room, filters noise and follows the score more tolerantly (tested on a noise corpus).

**A fuller report after Play Along**: bar-by-bar heat map, synced playback of your take, what to practise next,
export, send to your teacher, post to Stage, or turn the take into a Sound.

**Sounds**: a multitrack mixer (up to 8 tracks: microphone, instrument on the keys, imported audio, chord backing in
any style, a Play Along take) with volume, pan, mute, solo, EQ, reverb, fades, trim, loop, quantize and tempo change.
Export WAV, stems, MIDI or to Drive; share on Stage, where others can listen, layer their own track on top
(with credit) and "Get the sheet" to practise it. A one-minute, four-track mixdown renders in about 3 seconds.

**Hapi everywhere**: an AI helper behind the sparkle button on every main screen. It knows the open piece, your
library and recent takes, can look up your classes and what is due, Stage posts and teachers, and offers next steps
as buttons (open a piece, Play Along, a screen, change key or speed) that run only when you tap them.

**A bigger free library**: 6,679 public-domain and openly licensed pieces, now with piano, guitar, hymns,
songs, ragtime and string quartets (Mutopia Project, OpenScore String Quartets) besides the tune books, Bach
chorales and Lieder. Each piece shows its licence and source; only Public domain, CC0, CC BY and CC BY-SA music is
accepted, and an automatic audit checks every piece. The Android app no longer carries the pieces (12 MB instead of 25 MB).

**Safety and polish.** A crash on one screen no longer takes down the app (Try again / Back / Report); rate limits
on posting, likes, reports and AI; uploads checked by their content; fixed the improviser's note roles and a phone
zoom-out after screen transitions that made the tab bar miss taps.

**Tests.** Web unit tests (88), server tests (84), engine tests (55) and click-through tests at phone, tablet and PC
sizes plus a two-person classroom/Stage/Sounds/Hapi walk-through all pass. Core music code line coverage is 86%.

What you need to set up is in [SETUP.md](SETUP.md) (Google permissions, email, the AI key, Play Console).
