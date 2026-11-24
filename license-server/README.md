# Mosaic license server

A Cloudflare Worker with a D1 database. It runs on Cloudflare's free plan:

- **Workers:** 100,000 requests a day.
- **D1:** 5 million rows read and 100,000 rows written a day.
- **No pausing:** nothing pauses when idle.

## What it does

- **Device counting:** counts the computers each license runs on. A purchase covers 2, as with Eagle.
- **Device management:** lists those computers, and removes any of them from another computer (the app's "Máy đang dùng mã này" list).
- **Bank transfers:** turns a transfer into a key. The app opens an order, SePay reports the transfer, the server matches `MOSAIC <code>` and the amount, and the buyer's app picks up the key and unlocks by itself.
- **Card sales:** takes over card keys from Lemon Squeezy. Lemon Squeezy still sells and emails the key; its webhook tells the server about the key and any refund.
- **Signed answers:** every activation answer is signed with the same Ed25519 key as `scripts/issue-license.cjs`. The app checks it against `package.json → mosaicLicense.publicKey`, so a fake server or a hand-edited `license.json` cannot unlock it.

Endpoints are listed at the top of `src/index.ts`.

## Deploy (once)

Run every command from this folder (`license-server/`).

1. **Install and sign in.** You need a free Cloudflare account.

   ```bash
   npm install
   ```

   ```bash
   npx wrangler login
   ```

2. **Create the database.** This prints a `database_id`. Paste it into `wrangler.jsonc` in place of the zeros.

   ```bash
   npx wrangler d1 create mosaic-license
   ```

3. **Create the tables:**

   ```bash
   npm run migrate:remote
   ```

4. **Add the secrets.** Each command prompts for its value, so nothing lands in a file or in the shell history.

   The signing key is read from the private key file:

   ```bash
   npx wrangler secret put SIGNING_KEY < "%USERPROFILE%\.mosaic-licensing\mosaic-license-ed25519.pem"
   ```

   The other three:

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

   ```bash
   npx wrangler secret put SEPAY_API_KEY
   ```

   ```bash
   npx wrangler secret put LS_WEBHOOK_SECRET
   ```

   | Secret | Value |
   |---|---|
   | `SIGNING_KEY` | the private key file, piped in as shown above |
   | `ADMIN_TOKEN` | a long random string you keep; it creates and revokes keys |
   | `SEPAY_API_KEY` | the API key you set on the SePay webhook (step 7) |
   | `LS_WEBHOOK_SECRET` | the signing secret of the Lemon Squeezy webhook (step 8) |

5. **Fill in `vars` in `wrangler.jsonc`:**
   - `PRICE_VND` must equal the VN price in the app.
   - `LS_STORE_ID` and `LS_PRODUCT_ID` are the Lemon Squeezy store and product IDs.

6. **Deploy:**

   ```bash
   npm run deploy
   ```

   It prints the address, `https://mosaic-license.<your-subdomain>.workers.dev`. Put it in the app's `package.json → mosaicLicense.licenseServer`, then build a release.

7. **SePay (bank transfers):**
   1. Connect the bank account that receives payments.
   2. Add a webhook to `https://…workers.dev/v1/webhooks/sepay`.
   3. Choose **API Key** authentication, with the same key as `SEPAY_API_KEY`.

   The server answers `{"success": true}`, and ignores repeat deliveries by transaction `id`.

8. **Lemon Squeezy (cards):**
   1. Add a webhook to `https://…workers.dev/v1/webhooks/lemonsqueezy`.
   2. Choose the events `license_key_created`, `license_key_updated` and `order_refunded`.
   3. Copy its signing secret into `LS_WEBHOOK_SECRET`.

## Day to day

The admin requests below use `$ADMIN_TOKEN`. Set that variable in your shell from wherever you keep the token; do not type the token itself into the command.

- **Gift or manual key:**

  ```bash
  curl -X POST https://…workers.dev/v1/admin/licenses -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"email":"friend@example.com"}'
  ```

- **Revoke a shared or refunded key:** the app locks at its next weekly check.

  ```bash
  curl -X POST https://…workers.dev/v1/admin/revoke -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"key":"MSC-…"}'
  ```

- **Look at sales:**

  ```bash
  npx wrangler d1 execute mosaic-license --remote --command "SELECT email, source, status, created_at FROM licenses ORDER BY created_at DESC LIMIT 20"
  ```

- **Live logs:**

  ```bash
  npx wrangler tail
  ```

## Local test

1. Put **test-only** values for the four secrets in `.dev.vars`. That file is git-ignored; do not use the real signing key there.
2. Run `npm run migrate:local`, then `npm run dev`.
3. Point a development Mosaic at it with these environment variables:
   - `MOSAIC_LICENSE_SERVER=http://127.0.0.1:8787`
   - `MOSAIC_LICENSE_PUBLIC_KEY=<test public key>`

## Notes

- **Stored keys:** keys are stored only as SHA-256 hashes. The exception is a paid bank order, which keeps its key so the buyer's app can collect it. Only a request with the order code plus the same email and machine code gets it.
- **Unreachable server:** if the app cannot reach the server, it keeps working. Only an explicit `invalid`, `revoked` or `not-activated` answer locks it.
- **Lost signing key:** if the private signing key leaks, generate a new pair with `scripts/issue-license.cjs init` and a new key path. Then update `SIGNING_KEY` and `mosaicLicense.publicKey`, and ship a release.
