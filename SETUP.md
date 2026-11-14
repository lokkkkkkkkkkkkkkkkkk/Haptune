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

## 8. Developer access and checks you do
- `fly secrets set HAPTUNE_ADMIN_CODE=<a long code only you know>`; type it once in the app (Me → Settings → Developer access).
- Developer panel → **Payments**: approve transfers. **Tutors**: read each paid teaching profile and Verify or Reject. **Reports** and **Feedback** as before.

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

## 10. Before charging real money
- Read `terms.html`, `refunds.html` and `privacy.html` (in `web/assets/legal/`) and change anything that isn't how you want to run it. The refund policy promises a full refund within 7 days of a first payment.
- In the Anthropic Console set a monthly spend limit.

## Testing on your own devices
The automatic tests run in Chrome at phone, tablet and PC sizes. Please check on your real iPhone and iPad: open a long score, play, lock the phone, come back, take a call, use Play Along with the microphone. If sound ever stops, a pill "Tap anywhere to turn the sound back on" should appear; tell me exactly what you did if it doesn't.
