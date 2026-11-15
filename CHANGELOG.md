# Changelog

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
