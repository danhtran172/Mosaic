# Licensing and payment

Mosaic is sold once and unlocked for good:

| | |
|---|---|
| **Price** | By region: **200.000 ₫** in Vietnam, **US$14.99** everywhere else. The region is the one Windows is set to. |
| **What it buys** | The whole app, for life, on 2 computers, with free updates |
| **Before buying** | A 30-day trial. After it, a paywall replaces the app until a key is activated. The Library, Galleries and tags are never touched. |

The prices were set by the owner on 2026-10-19. They replace an earlier plan of 75% of Eagle's price in each region (Eagle sells at US$34.95, ¥229 in China and NT$1050 in Taiwan).

The numbers live in `package.json` → `mosaicLicense.pricing`, as one `default` price plus a `regions` entry per country code. The code is in two places:

- `main.js`, section "Licensing"
- `ui/src/components/allsight/License.tsx`

## How the trial is counted

- **When it starts:** the first time a window opens on a build that has licensing.
- **What it is tied to:** the machine. The trial is keyed by a SHA-256 hash of the Windows `MachineGuid`; the GUID itself is never stored.
- **Where it is stored:** in two places, and the earliest start recorded for this machine wins:
  - `%APPDATA%\Mosaic\license.json` (`machine`, `trialStartedAt`);
  - the registry, `HKCU\Software\Mosaic` → `Trial_<hash>`.
- **What does not reset it:**
  - deleting `license.json`, or deleting the registry value;
  - uninstalling and reinstalling (the installer also keeps AppData, `deleteAppDataOnUninstall: false`);
  - copying a `license.json` over from another computer. That file's trial is ignored, and so is any activated key in it: an activation belongs to the computer it was made on.
- **What does reset it:**
  - reinstalling Windows, which gives a new `MachineGuid`;
  - deleting both stored copies;
  - another Windows account on the same PC, because `HKCU` is per account. Covering that would need `HKLM`, which needs admin rights.
- **Existing users** who upgrade start their 30 days at the upgrade.

## Two kinds of key

As in Eagle, **every key activates only together with the buyer's email**.

- **Why:** passing a key on means passing on one's email too.
- **Matching:** case-insensitive.
- **Wrong key or wrong email:** both get the same message, so neither can be guessed on its own.

1. **Card checkout (Lemon Squeezy).**
   - **Delivery:** the buyer pays on the checkout page, and Lemon Squeezy emails a license key.
   - **Activation:**
     - The app first checks the key without activating it (`validate` with no instance). The email and the product must match before `activate` runs, so a wrong email never takes up a device slot.
     - Lemon Squeezy enforces the 2-device limit.
   - **Weekly re-check:** a refunded or disabled key is revoked. If the API cannot be reached, the activation is kept; only an explicit "not valid" revokes it.
   - **Moving computers:** "Deactivate on this computer" frees the slot.
   - **Lost key:** the "Lost your key?" link opens `recoverUrl`, Lemon Squeezy's customer portal, where buyers look up their orders.
2. **Signed `MOSAIC-` key**, for sales made another way (bank transfer, invoice, gift).
   - **Issuing:** `scripts/issue-license.cjs` signs it with an Ed25519 private key.
   - **Checking:** the app verifies it offline against `mosaicLicense.publicKey`.
   - **Tied to machines:** the paywall shows this computer's **machine code** (e.g. `2CTHB-EJ64E`, derived from the hashed MachineGuid). The key names the machine codes it runs on, at most two per purchase. On any other computer it is refused, with a hint to send that computer's code.
   - **Gifts:** a key issued with `--any-machine` runs anywhere.

## License server (recommended)

`license-server/` is a Cloudflare Worker with a D1 database. It runs on the free plan; deployment steps are in [license-server/README.md](../license-server/README.md). Once `package.json → mosaicLicense.licenseServer` holds its address:

- **Activation, like Eagle's:**
  - Every key except a signed `MOSAIC-` key activates through the server, with the buyer's email.
  - At the device limit the app lists the computers using the key. "Gỡ" frees one from any computer, and activation is retried.
  - Settings → License shows the same list.
- **Bank transfers unlock by themselves:**
  - The app asks for an email and opens an order on the server, then shows the VietQR code.
  - SePay reports the transfer, and the server matches `MOSAIC <code>` and the amount.
  - The app polls the order every 5 seconds and activates the key it receives. Measured locally, it unlocked about 1.5 s after the webhook.
  - Nobody matches payments by hand.
- **Lemon Squeezy** still sells and emails card keys. Its webhook (`license_key_created`/`updated`, `order_refunded`) hands them to the server.
- **Signed proof:** an activation is stored with a token the server signed for this machine code. On every start the app re-checks the token, and a signed `MOSAIC-` key is checked the same way. A `license.json` without valid proof is dropped. That covers:
  - a hand-edited file;
  - a forged token;
  - a token edited to name another machine;
  - with a server configured, a bare Lemon Squeezy record.
- **Weekly re-check:**
  - An answer of `invalid`, `revoked` or `not-activated` locks the app.
  - An unreachable server does not lock it.
  - A `validatedAt` in the future counts as due for a re-check.

**Without a server** the app falls back to calling Lemon Squeezy directly. That mode is weaker: a hand-edited `license.json` can claim a card activation, and buyers can only free the computer they are on.

A development run (`electron .`) is never locked. Set `MOSAIC_LICENSE_ENFORCE=1` to test the real behaviour.

## Ways to pay

- **Card (Lemon Squeezy).** Mainly for buyers outside Vietnam, at US$14.99.
  - Each region can have its own checkout link: `pricing.default.checkoutUrl` and `pricing.regions.VN.checkoutUrl`. A Vietnamese card checkout needs a Lemon Squeezy product or variant priced at the VND amount.
  - Without a link, a region shows no card button when bank transfer is available, and a disabled one otherwise.
- **Bank transfer (VietQR).** For Vietnam, at 200.000 ₫.
  - **Payment:** the paywall shows a NAPAS VietQR code with the amount and a description `MOSAIC <order code>` filled in, plus the account details with copy buttons. Any Vietnamese banking app can scan it.
  - **Where the QR is made:** on the computer, by `vietQrPayload` in `main.js` and the `qrcode` package. Nothing is sent anywhere.
  - **After payment:** the buyer sends the description, their email and their machine code to `bankTransfer.contact`. You match the transfer, then issue a `MOSAIC-` key for that machine (below).
  - **When it shows:** only when the region is in `bankTransfer.regions`, the price is in VND, and both `bankBin` and `accountNumber` are set.

## Going live: what still has to be done

Signed keys work already. Each payment channel needs its own setup.

### Bank transfer (Vietnam)

Fill in `package.json` → `mosaicLicense.bankTransfer`:

| Field | Value |
|---|---|
| `bankBin` | the bank's 6-digit NAPAS BIN, e.g. `970436` for Vietcombank or `970422` for MB |
| `bankName` | the bank name as buyers should see it |
| `accountNumber` | the account number |
| `accountName` | the account holder, in capitals without diacritics |
| `contact` | where buyers send the description: an email or a Zalo number |

### Card (Lemon Squeezy)

1. Create a Lemon Squeezy store, with payouts to your bank or PayPal.
2. Create a product "Mosaic":
   - single payment of **US$14.99**;
   - **License keys** turned on, activation limit **2**, no expiry.
3. Copy these values into `package.json` → `mosaicLicense`:
   - the checkout link → `pricing.default.checkoutUrl`;
   - the **Store ID** → `lemonSqueezy.storeId`;
   - the **Product ID** → `lemonSqueezy.productId`.

   The app refuses keys from any other store or product.

Then build a release (`npm run dist:win`).

## Issuing a key by hand

```bash
node scripts/issue-license.cjs issue --email buyer@example.com --machine 2CTHB-EJ64E --name "Buyer Name"
```

- **Second computer:** run it again with both codes (`--machine A --machine B`) and send the new key. One purchase covers two computers.
- **Changed computer:** issue a key for the new code. The old key keeps working only on the old machine.
- **Gift:** `--any-machine` gives a key that runs on any computer.

**Back up the private key.** It is in `%USERPROFILE%\.mosaic-licensing\mosaic-license-ed25519.pem` and is never in the repo.

- Without it, no new `MOSAIC-` key can be issued.
- Anyone who has it can issue keys.

If it is lost or leaked:

1. Run `init` with a new path (`MOSAIC_LICENSE_PRIVATE_KEY`).
2. Put the new public key in `package.json`.

Keys signed with the old private key stop working in builds that carry the new public key.

## Testing

The test-only overrides work only in an unpackaged run. A packaged build ignores them, so it cannot be pointed at a fake license server:

- `MOSAIC_LICENSE_API`
- `MOSAIC_LS_STORE_ID`
- `MOSAIC_LS_PRODUCT_ID`
- `MOSAIC_CHECKOUT_URL`
- `MOSAIC_LICENSE_REGION`
- `MOSAIC_BANK_TRANSFER` (JSON)
- `MOSAIC_LICENSE_REGISTRY_KEY`

Regional pricing was tested with fake bank details:

- **Region VN:** shows 200.000 ₫ and a VietQR transfer. The on-screen QR was decoded with jsQR: CRC valid, amount 200000, the right bank and account, and the description shown.
- **Region US:** shows US$15 and the card button (tested when the price was US$15; US$14.99 is shown with two decimals).

Email and machine binding were also tested:

- **Card key:**
  - wrong email → refused, and the mock saw no `activate`;
  - other product → refused before activation;
  - right email in different case → activated.
- **Signed key:**
  - for another machine → refused with the machine-code hint;
  - for this machine with the wrong email → refused;
  - right email → activated;
  - `--any-machine` → activated.
- **Paywall** shows the machine code, the "Lost your key?" link and the contact.

The 2026-10-19 end-to-end run used an isolated Mosaic and a mock license API. It checked:

- **Trial:** the first launch shows "30 days left".
- **Expiry:** the paywall replaces the app.
- **Bad keys rejected:** a tampered signed key, a key over the device limit, a key for another product (its slot is released), and an unknown key.
- **Valid card key:** unlocks at once, and survives a restart.
- **Deactivate** frees the slot and brings back the paywall.
- **Signed key:** unlocks offline.
- **Re-check:**
  - with the API unreachable, the activation is kept;
  - with the key refunded, it is revoked and the paywall is back.
- **Dev run:** stays unlocked.
- **Trial tied to the machine:**
  - a fresh machine writes the same start to the file and to the registry;
  - deleting the file or the registry value keeps the earlier start;
  - a `license.json` copied from another machine loses its key and its fresh trial.

  This run used the registry key override `MOSAIC_LICENSE_REGISTRY_KEY`, which is development only.
- **Race found and fixed:** AppShell and Sidebar asking for the status at the same moment made two loads race on one temporary file. The second one failed, and the app showed itself without a status.
  - **Fix:** loads are now shared, and each write gets its own temporary file.
  - **Renderer:** retries a failed status request.

The real checkout page and real Lemon Squeezy API have not been exercised.
