# Putting Haptune online: what only you can do

The code is ready. These steps need your accounts, so they are yours. Do them in this order.

## 1. Merge
Merge the branch into `main`. GitHub then builds the website and app (Pages), the Android app, and deploys the server to Fly.

## 2. The website on haptune.name.my
1. GitHub → repository **Settings → Pages** → Source: **GitHub Actions**; Custom domain: `haptune.name.my` → Save; tick **Enforce HTTPS** once offered.
2. At your domain registrar, DNS for `haptune.name.my`: four **A** records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (and, if you want `www`, a **CNAME** `www` → `lokkkkkkkkkkkkkkkkkk.github.io`).
3. After DNS spreads (minutes to a few hours): `https://haptune.name.my/` is the landing page, `https://haptune.name.my/app/` the app.

## 3. The server (Fly)
`https://haptune-lok.fly.dev/` used to say "Not Found" because the server had no front page; it now shows a page that points to the website. Check it is alive at `/health`.

Repository **Settings → Secrets and variables → Actions → Variables**:
- `HAPTUNE_SERVER_URL` = `https://haptune-lok.fly.dev`
- `HAPTUNE_PLAY_URL` = your Google Play page (when published; the website's download button uses it)

## 4. Card payments (Stripe)
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

## 5. DuitNow QR and bank transfer
- Put your DuitNow QR picture at `web/assets/pay/duitnow-qr.png` and commit it. Without it people see the CIMB account number (7647680094) only.
- Optional: `fly secrets set HAPTUNE_PAY_NAME="<name on the account>" -a haptune-lok` so people see who they are paying.
- When someone pays: the app's **Me → Developer panel → Payments** lists it with their code. Find the transfer with that code in your bank, then **Approve**. Their plan turns on and they are notified.

## 6. Developer access and checks you do
- `fly secrets set HAPTUNE_ADMIN_CODE=<a long code only you know>`; type it once in the app (Me → Settings → Developer access).
- Developer panel → **Payments**: approve transfers. **Tutors**: read each paid teaching profile and Verify or Reject. **Reports** and **Feedback** as before.

## 7. Google Play
Unchanged from `web/ANDROID.md`. Inside the Android app, plans are bought with Google Play (Google requires it). The same account then has the plan on the website and PC too.

## 8. Before charging real money
- Read `terms.html`, `refunds.html` and `privacy.html` (in `web/assets/legal/`) and change anything that isn't how you want to run it. The refund policy promises a full refund within 7 days of a first payment.
- In the Anthropic Console set a monthly spend limit.

## Testing on your own devices
The automatic tests run in Chrome at phone, tablet and PC sizes. Please check on your real iPhone and iPad: open a long score, play, lock the phone, come back, take a call, use Play Along with the microphone. If sound ever stops, a pill "Tap anywhere to turn the sound back on" should appear; tell me exactly what you did if it doesn't.
