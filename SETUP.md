# Putting Melovyn online: what only you can do

The code is ready. These steps need your accounts, so they are yours. Do them in this order.

## 1. Merge
Merge the branch into `main`. GitHub then builds the website and app (Pages), the Android app, and deploys the server to Fly.

## 2. The website on haptune.name.my with HTTPS
Your DNS is correct (checked from GitHub's own servers: Cloudflare nameservers, the four GitHub A records, `www`
→ `lokkkkkkkkkkkkkkkkkk.github.io`, no DNSSEC, no CAA). GitHub's "DNS check unsuccessful / InvalidDNSError" comes
from GitHub's checker not reading `.name.my` domains, not from your settings, so waiting may never fix it. Two ways
around it; **A** takes two minutes:

**A. Let Cloudflare give the site its HTTPS (recommended)**
1. Cloudflare → haptune.name.my → **DNS → Records**: switch the four `A` records and `www` to **Proxied** (orange cloud).
2. **SSL/TLS → Overview**: encryption mode **Full** (not Flexible, not Full strict).
3. **SSL/TLS → Edge Certificates**: turn on **Always Use HTTPS**.
4. **Caching → Configuration → Purge Everything**.
5. GitHub → Settings → Pages: keep Source = **GitHub Actions** and the custom domain `haptune.name.my`. Leave
   "Enforce HTTPS" unticked and ignore GitHub's DNS warning: Cloudflare serves HTTPS to visitors.
`https://haptune.name.my/` then works within minutes.

**B. Host on Cloudflare Pages instead (also free)**
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Direct upload**, project name **melovyn** (upload any
   small file once to create it), then **Custom domains → Set up a domain → haptune.name.my**.
2. Cloudflare → My Profile → **API Tokens → Create Token → "Edit Cloudflare Workers"** template.
3. GitHub → Settings → Secrets and variables → Actions → **Secrets**: `CLOUDFLARE_API_TOKEN` (the token) and
   `CLOUDFLARE_ACCOUNT_ID` (on the right of the Cloudflare dashboard home). Every push then also publishes there.

## 3. Sign in with Google (teachers, students and Stage need an account)
1. https://console.cloud.google.com → create a project "Melovyn" → **APIs & Services → OAuth consent screen**:
   External, app name Melovyn, your support email, authorised domain `haptune.name.my`, scopes: email, profile, openid.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised JavaScript origins:
   `https://haptune.name.my` and `https://www.haptune.name.my` (and `http://localhost:8080` for testing). No redirect URI needed.
3. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`; it is public, not a secret).
4. GitHub → Settings → Secrets and variables → Actions → **Variables** → `GOOGLE_CLIENT_ID` = that ID.
5. Re-run **Actions → server** and **Actions → Web app (GitHub Pages)** (or push anything): the website shows
   "Continue with Google" and the server checks it. The Android app signs in through the website with a code.
Until this is done people can still make an account with a username and password.

### 3b. Google Calendar + Meet, Drive and Contacts (class sessions, Save to Drive, invite from Contacts)
Each feature asks people only for the one permission it needs, when they first use it. To switch them on:
1. Google Cloud → **APIs & Services → Library**: enable **Google Calendar API**, **Google Drive API** and **People API**.
2. **OAuth consent screen → Data access → Add or remove scopes**: add `.../auth/calendar.events`,
   `.../auth/drive.file` and `.../auth/contacts.readonly`.
3. **Credentials → your Web client**: copy the **Client secret**.
4. On your computer (the second value is any long random text; keep it, as changing it disconnects everyone):
   ```bash
   fly secrets set GOOGLE_CLIENT_SECRET=GOCSPX-... HAPTUNE_TOKEN_KEY=$(openssl rand -hex 32) -a haptune-lok
   ```
5. While the consent screen is in **Testing**, add yourself and your testers as test users. Before opening it to
   everyone, press **Publish app**: Google reviews apps that use Calendar and Contacts (a short video of the feature
   and the privacy policy link; it can take a few weeks). `drive.file` needs no review.
Without these, everything else works; the Connections screen says Google connections aren't set up yet.

### 3c. Email for class notices (optional)
Announcements, new assignments and grades are always in the app's notifications. To also email them:
`fly secrets set SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=you@gmail.com SMTP_PASSWORD=<app password> SMTP_FROM="Melovyn <you@gmail.com>" -a haptune-lok`
(for Gmail, make an **App password** under Google Account → Security → 2-Step Verification).

### 3d. Verified teachers
Teachers ask in the app (**Me → Get verified as a teacher**, or when they try to open a class to everyone); you approve them in **Developer panel → Teachers to verify**.
To approve a music school's teachers at once, list its email domains:
`fly secrets set HAPTUNE_TEACHER_DOMAINS="yourmusicschool.edu.my,partner-school.com" -a haptune-lok`

## 4. Google search (Search Console)
1. https://search.google.com/search-console → your property `haptune.name.my` (the TXT record you added is already there).
2. **Sitemaps** → add `https://haptune.name.my/sitemap.xml` → Submit.
3. **URL inspection** → `https://haptune.name.my/` → **Request indexing**; do the same for `/teachers.html`,
   `/sheet-music-writer.html` and `/play-along.html`.
New sites take days to a few weeks to appear. What helps most after that: links to the site from music schools,
teachers' pages, your social media and the Google Play listing, and a name people search for. Melovyn is a new word, so
searches for "Melovyn" will find you quickly; generic words like "sheet music app" take longer.

## 5. The server (Fly)
Check it is alive at `https://haptune-lok.fly.dev/health`.

Repository **Settings → Secrets and variables → Actions → Variables**:
- `HAPTUNE_SERVER_URL` = `https://haptune-lok.fly.dev`
- `GOOGLE_CLIENT_ID` = see step 3
- `HAPTUNE_PLAY_URL` = your Google Play page (when published; the website's download button uses it)

## 6. Card payments (Stripe)
1. Stripe Dashboard → Developers → API keys: copy the **secret key**.
2. Developers → Webhooks → Add endpoint: `https://haptune-lok.fly.dev/c/billing/stripe/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy the **signing secret**.
3. Settings → Billing → Customer portal: switch it on (lets people change card or cancel).
4. On your computer:
   ```bash
   fly secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... -a haptune-lok
   ```
5. Try it with Stripe's **test** keys first (card 4242 4242 4242 4242), then switch to live keys.

Prices are sent with each checkout (RM 14.90 / 99.90 for Plus, RM 29.90 / 229.90 for Pro, US$ equivalents), so nothing has to be created in Stripe.

## 7. DuitNow QR and bank transfer
- Put your DuitNow QR picture at `web/assets/pay/duitnow-qr.png` and commit it. Without it people see the CIMB account number (7647680094) only.
- Optional: `fly secrets set HAPTUNE_PAY_NAME="<name on the account>" -a haptune-lok` so people see who they are paying.
- When someone pays: the app's **Me → Developer panel → Payments** lists it with their code. Find the transfer with that code in your bank, then **Approve**. Their plan turns on and they are notified.

## 8. You as the owner, Developer mode, and the dashboard
1. Make yourself the owner (only this server setting can do it; nobody can take it from the app):
   ```bash
   fly secrets set HAPTUNE_OWNER_EMAILS=you@gmail.com -a haptune-lok
   ```
   Then sign in to Melovyn with **that Google account**. (Once an owner is set, the old developer code no longer works;
   accounts that used it stay developers until you revoke them in Access.)
2. **Me → Developer mode**: the first time it asks you to set up 2-step verification with an authenticator app
   (Google Authenticator, Microsoft Authenticator, 1Password). Save the recovery codes it shows. After that, each
   switch-on asks for a code and lasts 8 hours on that device. With it off you use Melovyn like everyone else.
3. The dashboard: **Overview** (people active, sign-ups, sessions, practice, retention, devices, countries), **Users**
   (search, one person's timeline, give a plan, verify a teacher, suspend, message, export, delete), **Activity**
   (live feed and where people drop out), **Features** (time per screen; switch unfinished features off or to Beta
   without a new version), **Errors** (app and server errors grouped), **Access** (give someone developer access with
   only the parts they need and an end date; revoke instantly), **Audit** (every staff action, can't be edited; CSV).
   Payments, teacher and tutor checks, Stage reports and feedback are there too.
4. Optional: `fly secrets set HAPTUNE_TOKEN_KEY=...` (see §3b) also encrypts the 2-step secrets.
5. Privacy: the tracking is described in `privacy.html` (English, 中文, Bahasa Melayu). People can switch it off in
   Settings, download their data and delete their account. Raw events are kept 180 days, then only daily totals.

## 9. Google Play
Follow `web/ANDROID.md`. The app is now **Melovyn** with the app ID **`com.sloky.melovyn`** (changed from the earlier test IDs before anything was published;
it can never change once it is on Google Play). **Check before uploading:** if you had already created an app in the Play
Console under the old ID, tell me and I will switch the ID back. In short:
1. Play Console account (US$25, one time) → **Create app** "Melovyn", category *Education*.
2. Make the upload key and add the four `HAPTUNE_KEYSTORE…` secrets → the next build makes `Melovyn.aab`.
3. Upload it to **Testing → Closed testing**, invite 12+ testers, wait 14 days (Google's rule for new personal accounts).
4. Store listing text is in `web/ANDROID.md`; privacy policy URL: `https://haptune.name.my/privacy.html`.
5. Data safety form: the app collects name, email (Google sign-in), audio recordings (only when sent to a teacher or
   posted), and app activity; all in transit over HTTPS; people can delete their account in the app.
Inside the Android app, plans are bought with Google Play (Google requires it). The same account then has the plan on the website and PC too.

## 9b. Hapi, the AI helper (the sparkle button on every screen)
1. `fly secrets set ANTHROPIC_API_KEY=sk-ant-... -a haptune-lok` (console.anthropic.com; the key stays on the server).
2. Hapi counts as a tutor answer, which is part of Plus and Pro. To let free accounts try it, give them a few a month:
   `fly secrets set HAPTUNE_PLANS_JSON='{"free": {"tutor": 10}}' -a haptune-lok`. On the Haiku model (fly.toml,
   `HAPTUNE_AI_MODEL_TUTOR`) an answer costs about US$0.001–0.003, so 10 a month for 1,000 people is about US$30.
3. Caps that protect the bill (fly.toml or secrets): `HAPTUNE_CHAT_PER_DAY` (per device, default 60) and
   `HAPTUNE_CHAT_ALL_PER_DAY` (whole server, default 600).

## 9c. The free library
Nothing to do. It now has about 6,700 public-domain and openly licensed pieces (Mutopia, OpenScore, tune books);
each piece's licence and source page are under Details, and the list of collections is at the bottom of the free
library. To add a collection later, see `web/tools/import-catalog.mjs` (only Public domain, CC0, CC BY and CC BY-SA
are accepted). Popular songs still in copyright are never added: people get them through Stage requests or by
importing a sheet they own.

## 10. Before charging real money
- Read `terms.html`, `refunds.html` and `privacy.html` (in `web/assets/legal/`) and change anything that isn't how you want to run it. The refund policy promises a full refund within 7 days of a first payment.
- In the Anthropic Console set a monthly spend limit.

## Testing on your own devices
The automatic tests run in Chrome at phone, tablet and PC sizes. Please check on your real iPhone and iPad: open a long score, play, lock the phone, come back, take a call, use Play Along with the microphone. If sound ever stops, a pill "Tap anywhere to turn the sound back on" should appear; tell me exactly what you did if it doesn't.
