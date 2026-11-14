# Melovyn for Android: test it, then launch it on Google Play

The Android app is the web app (`web/`) packaged with [Capacitor](https://capacitorjs.com). App ID:
`com.sloky.melovyn` (it can never change once the app is on Google Play). Nothing here needs a Mac or Android Studio:
GitHub Actions builds everything (`.github/workflows/android.yml`).

## 1. Install the test app on your phone (free, today)

Every push that changes `web/` builds a new test APK and publishes it as the release **android-test**:

**https://github.com/lokkkkkkkkkkkkkkkkkk/Melovyn/releases/download/android-test/Melovyn.apk**

1. Open that link on your Android phone and download `Melovyn.apk`.
2. Open the file. Android asks to allow installing apps from your browser (or Files): allow it once.
3. Install. Later builds install over it and keep your library (they are all signed with the same test key).

The test app talks to the server in the repository variable `HAPTUNE_SERVER_URL` (Settings → Secrets and variables →
Actions → Variables). Purchases stay switched off until step 4.

## 2. Unlock everything for yourself (developer access)

1. Make a long random code, e.g. `haptune-dev-2026-<something only you know>` (12+ characters).
2. Save it on the server: `fly secrets set HAPTUNE_ADMIN_CODE=<the code>` (or Fly dashboard → your app → Secrets).
3. In the app: **Account → Developer access**, type the code. Your account now has every feature with no limits and a
   **Developer panel** (members, AI use this month, reports to review, the feedback inbox, giving plans or credits to
   testers and teachers).

## 3. Google Play account and the first upload

1. Create the developer account at https://play.google.com/console (one-time US$25). Use the email you chose for
   publishing. Choose **personal** account; developer name **sloky**.
2. Google asks new personal accounts to run a **closed test with at least 12 testers for 14 days** before the app can
   go public. Start it as early as possible (step 3.6): it is a fixed waiting time.
3. **Make the upload key** (once; keep the file and passwords safe, e.g. in a password manager):
   ```bash
   keytool -genkeypair -keystore haptune-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```
   Then turn it into text for GitHub:
   ```bash
   base64 -w0 haptune-upload.jks > haptune-upload.txt
   ```
4. In GitHub → Settings → Secrets and variables → Actions → **Secrets**, add:
   `HAPTUNE_KEYSTORE_BASE64` (the contents of haptune-upload.txt), `HAPTUNE_KEYSTORE_PASSWORD`, `HAPTUNE_KEY_ALIAS`
   (`upload`), `HAPTUNE_KEY_PASSWORD`. The next build also makes **Melovyn.aab** (Actions → the run → Artifacts →
   Melovyn-android).
5. In the Play Console: **Create app** → name Melovyn, app, free (with in-app purchases). Turn on **Play App Signing**
   (Google keeps the real signing key; your upload key can be reset if lost).
6. **Testing → Closed testing → Create track**, upload `Melovyn.aab`, add your 12+ testers' Gmail addresses (friends,
   family, students), and send them the opt-in link. They install from Google Play and keep it for 14 days.
7. Fill in the **App content** pages (answers below), the store listing (section 6), then **Production → Create
   release** when Google allows it.

App content answers:
* **Privacy policy URL:** https://haptune.name.my/privacy.html
* **Account deletion URL** (required because accounts exist): https://haptune.name.my/app/ (Me → Settings → Delete account)
  (sign in → Account → Delete account), and it is also in the app.
* **Data safety:** collects name/username (account), user-generated content (posts, scores, photos you attach),
  app activity (practice minutes), purchase history (via Google Play), crash/diagnostic info (only when the user sends
  a problem report). Shared with no one for advertising. Data is encrypted in transit (HTTPS). Users can delete it.
  Microphone audio is processed on the device and not collected.
* **Ads:** no ads.
* **Content rating:** users can interact and share content (community), with report and block; no violence, gambling
  or mature content. Credits cannot be bought or cashed out.
* **Target audience:** 13+ is simplest (the community has user content). Classes with a teacher work for younger
  students too, but choosing under-13 triggers Google's Families rules.

## 4. Subscriptions (Plus and Pro) with RevenueCat

RevenueCat (free until US$2,500 a month in revenue) handles Google Play billing and tells the Melovyn server which plan
each account has. Only one plan check exists, on the server, so a plan bought on the phone also works when the same
account signs in on a PC.

1. Play Console → **Monetize → Subscriptions**, create:

   | Product ID | Base plan | Suggested price (Malaysia / US) |
   |---|---|---|
   | `plus` | `monthly`, `yearly` | RM 14.90 / US$3.99 a month; RM 99.90 / US$24.99 a year |
   | `pro` | `monthly`, `yearly` | RM 29.90 / US$7.99 a month; RM 229.90 / US$59.99 a year |

   A 7-day free trial on the yearly base plans helps people decide.
2. https://app.revenuecat.com → new project → **Google Play app** (`com.sloky.melovyn`) and connect it with a Google
   service account (RevenueCat shows each click).
3. **Entitlements:** `plus` and `pro`. Attach the `plus` products to `plus` and the `pro` products to both `plus` and
   `pro`.
4. **Offerings:** the default offering with four packages (Plus monthly, Plus annual, Pro monthly, Pro annual). The app
   reads them, with the store's local price.
5. GitHub → **Variables:** `REVENUECAT_ANDROID_KEY` = the **public** Google Play SDK key (starts with `goog_`). Builds
   after that can buy.
6. Server secrets: `fly secrets set REVENUECAT_SECRET=<RevenueCat secret API key (sk_...)> REVENUECAT_WEBHOOK_AUTH=<any long random text>`
7. RevenueCat → Integrations → **Webhooks**: URL `https://haptune-lok.fly.dev/c/billing/revenuecat`, authorization
   header = the same `REVENUECAT_WEBHOOK_AUTH`. Renewals and cancellations then update plans on their own.
8. Payouts: Play Console → **Payments profile**. Add your bank account there (never in the code or this repository).

## 5. What each plan includes (set on the server in `server/accounts.py`)

| | Free | Plus | Pro |
|---|---|---|---|
| Practice, Play Along, real piano playback, imports, basic scan, tools | ✓ | ✓ | ✓ |
| Community: requests, help, credits, library, Q&A, challenge, classes | ✓ | ✓ | ✓ |
| Open requests at a time | 3 | 10 | 30 |
| AI reads photos/PDFs (pages a month) | – | 2 on Opus, up to 36 on Haiku | 7 to 108 |
| AI song finder (searches a month; repeats of anyone's search are free) | – | 1 | 3 |
| Hapi AI tutor (answers a month, on Haiku) | – | 360 | 1,080 |
| All improviser styles | – | ✓ | ✓ |
| Free spotlights a month, bonus credits a month | – | 1, 100 | 4, 300 |

The AI numbers come from each plan's monthly AI budget (Plus US$1.20, Pro US$3.60) and the cost of the models set in
`fly.toml`, so a cheaper model gives everyone more automatically (README, "Plans"). Fixed numbers can be set without a
new app: `fly secrets set HAPTUNE_PLANS_JSON='{"free": {"tutor": 3}}'` (for example, to give free users three tutor
answers a month). The app reads the plans from the server.

## 6. Store listing (copy, then adjust)

**Title:** Melovyn: Practise, Learn & Write Music

**Short description (80 characters):** Play along with feedback, learn with your teacher, write and share sheet music.

**Full description:**

> Melovyn listens while you play and shows exactly which notes and bars to fix.
>
> • Play Along: the app hears your instrument through the microphone, waits for each note or keeps the beat, buzzes on
>   a wrong note, and gives you a report: your score, the notes to fix, and the bars to loop. Every take is recorded.
> • Learn with your teacher: join a class with a link, a QR code or a code. Your teacher sets songs, sees your progress
>   and listens to your takes, and replies with comments and the bars to practise. Teachers and music schools run
>   their classes here, private or open to everyone.
> • Write: tap notes on the piano keys, scan a PDF or a photo, add chords, change the key, and share it.
> • Stage: post what you are playing, a recording, photos or a score; request any song and help others.
> • 4,900 free pieces, staff notation and 簡譜, piano, violin, guitar, voice, erhu, guzheng and 20+ instruments.
> • In English, Bahasa Melayu, 简体中文 and 繁體中文.
>
> Free: practice, classes, writing and the whole community, with no ads. Melovyn Plus and Pro add AI help: reading
> music from photos and PDFs, finding songs online and the AI tutor.

**Bahasa Melayu (short):** Main bersama dengan maklum balas, belajar bersama guru, tulis dan kongsi skor muzik.

**简体中文（简短）：** 跟奏有反馈，跟老师学习，写谱、分享乐谱。

**繁體中文（簡短）：** 求任何歌曲的樂譜，邊練邊得到回饋，和朋友一起學習。

**Screenshots:** run `tools/community-smoke.cjs` (it saves phone screenshots to `web/shots/`) or take them on your
phone: Community home, a request with a score, Play Along, the score cursor, Plans.

## 7. Updating the app later

Change `version` in `web/package.json` (e.g. 0.4.0 → 0.5.0) when you release. Each build's version code is the GitHub
run number, so it always goes up. Upload the new `Melovyn.aab` to the same track.

## Building on your own computer (optional)

```bash
cd web && npm ci && npm run build && npx cap sync android && cd android && ./gradlew assembleDebug
```
(needs JDK 21 and the Android SDK; Android Studio installs both.)
