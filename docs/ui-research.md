# UI research for Melovyn Part 2 (November 2026)

What we borrow is **information hierarchy, not branding**. Everything is rebuilt in Melovyn's own design system
(`web/src/ui/v3.css`, `components.jsx`, Plus Jakarta Sans, one colour per place).

| App | What it does well | What Melovyn takes |
|---|---|---|
| **Spotify (Home)** | Time-of-day greeting; the top of Home is a compact block of familiar things so you can jump back in; discovery comes lower down; Home changes with the time of day. | Greeting by time of day + streak; a one-tap **Continue** card at the very top (last piece and bar); familiar first, discovery after. |
| **YouTube Music (Home)** | Mood/activity **chips** at the top re-filter the whole feed and clear on a second tap; **Listen again** is a dense 3×2 grid instead of a carousel; shelves have pill-shaped **More** and **Play all**. | Filter chips under the hero (My instrument, Beginner, Hymns/Church, Classical, Pop requests, Exam pieces, 5-minute practice) that re-sort every shelf; dense 3×2 practice shelves; **Play all** = Play Along on the first item. |
| **SoundCloud (track page, feed)** | The waveform is the main element; comments are pinned to a moment on it and pop up during playback; reposts carry a note; a vertical feed of cards with inline players. | Timed comments on takes and Sounds pinned to the waveform; repost with a note; inline waveform in the Stage feed; "Layer"/duet on Sounds. |
| **Yousician (Learn / Songs / Challenges)** | Home = shortcuts (daily session, continue learning, your songs, new, challenges, riff of the day); Learn is a **path** of missions with stars; end screen with leaderboard toggled My level / Friends / Global; **Weekly challenge** per instrument; streaks counted in weeks; badges. | Learn path with locks and stars; Daily riff and Weekly challenge with friends/global boards; "Beat my score" from any report; streaks include challenge plays. |
| **Simply Piano** | Playing a real melody within minutes of opening the app; a few onboarding questions tailor the course; 5-minute workouts and quick recaps; family profiles. | **≤2 taps to a playable sheet** from Home; "5-minute practice" chip; first-run questions (instrument, level) drive shelves. |
| **Google Classroom** | Class cards with colour/cover; class tabs Stream · Classwork · People · Grades; student **To do / Done / Missing** across classes; teacher's per-student view filtered by turned in / returned / missing; guardian email summaries (missing work, upcoming work, class activity; no grades). | Class tabs Stream · Classwork · People · Progress; To do / Done / Missing; teacher dashboard (takes to review, inactive 7 days, nudge); weekly guardian summary with minutes, missing work and upcoming lessons. |
| **MuseScore 4 (studio)** | Tabs at the top (Home/Score/Publish), playback toolbar beside the Mixer button, a **note input toolbar** across the window, a left sidebar with **Palettes / Instruments / Properties**, the score in the middle, status bar, a mixer panel with one channel strip per instrument. Palette rule: select, then click a palette item. | Studio with SCORE · MIX · SHARE tabs, transport in the middle, note toolbar row, left panel Palettes / Instruments / Properties, Verovio score centre, mixer drawer with channel strips; phone: full-screen score, scrolling bottom toolbar, palettes and mixer as sheets. |

## Rules we apply everywhere
1. **One primary action per screen**, and a visible **Next** chip row at the end of every flow (no dead ends).
2. **Familiar before new.** Continue first, then the three hero tiles (New · Find · Create), then shelves.
3. **Chips filter, they don't navigate.** A second tap clears; the chosen chip is remembered for the session.
4. **Dense shelves** (3×2 on phones, 4–6 across on PC) with cover art generated from title, key and instrument
   when a piece has none, so every shelf looks finished.
5. **Social proof stays small**: counts and avatars on cards, never a feed on Home.
6. **Phone first**: everything reachable with a thumb; sheets instead of new pages for quick choices; the mini-player
   sits above the tab bar on every tab.


## Part 3 (Nov 2026): Summary, one-tap Google, and a design system from open-source kits

What we took, and from where (all MIT licensed; values copied, no code dependency added):

- **Radix Colors** (github.com/radix-ui/colors): a 12-step `slate` grey and `violet` scale, light and dark made as
  pairs. Steps 1-2 are backgrounds, 3-5 fills, 6-8 lines, 9-10 solid colour, 11-12 text. Mapping our tokens to
  them (`--ink` = slate12, `--ink2` = slate11, `--line` = slateA6...) keeps text contrast right in both themes
  without checking each colour by hand (the axe-core check still runs in CI).
- **Konsta UI** and **Framework7** (github.com/konstaui/konsta, github.com/framework7io/framework7): the shape of
  native-feeling mobile screens. From them: inset grouped lists with 52 px rows, 44-48 px touch targets on every
  button, a grab handle on bottom sheets, a large title that hands over to the content, and for the Android app a
  Material 3 navigation bar (an indicator pill behind the chosen tab, 72 px tall) and Roboto.
- **Open Props** (github.com/argyleink/open-props): easing curves (`ease-out` for things settling, `ease-spring`
  for small pops) and soft two-layer shadows, all switched off with reduced motion.
- **Apple Health's Summary**: the first tab is now *Summary*: today's rings (practise minutes, learning XP,
  streak), then a pinned tile for each part of Melovyn (practice time, accuracy, Learn, Stage, Create, Library,
  level, Google), each one tap from its screen, a big number, a short line and a small chart where there is one.
  The music shelves stay below as "Discover music", so a playable sheet is still two taps away.
- **Guides instead of explanations**: a three-step "Welcome" card on Summary for someone new (find a song, play
  along, join your class), closed for good with one tap; Play Along shows a live microphone level and, after 6
  silent seconds, says what to do; Settings → "Why can't I open Developer mode?" says what the server sees.


## Part 4 (November 2026)
- Reference: Apple Health on iPad (Summary with profile header, Pinned + Edit, Show All, Get More cards, Articles;
  Browse with colour category tiles; sidebar with Summary / Sharing / Browse and folding categories).
- [@formkit/auto-animate](https://github.com/formkit/auto-animate) (MIT, ~3 KB): one call per list adds smooth
  add/remove/move animation; used for pinned tiles, Get more cards and sidebar categories.
- [View Transitions API](https://developer.mozilla.org/docs/Web/API/View_Transition_API) (built into Chrome, Edge,
  Safari 18, Android WebView): cross-fades tab changes without a library; skipped for reduced motion.
- Considered and not used: Framer Motion / Motion One (React-first or larger), GSAP (licence and size), Lottie
  (needs authored animation files).
