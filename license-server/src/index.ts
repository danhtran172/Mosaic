/**
 * Mosaic license server (Cloudflare Workers + D1).
 *
 * It keeps what an app on its own cannot: which computers each license runs
 * on. That gives buyers what Eagle offers — a device list and removing an old
 * computer from a new one — and turns a bank transfer into a key without
 * anyone matching payments by hand.
 *
 * Every answer the app relies on carries a token signed with the Ed25519 key
 * whose public half ships in the app, so a fake server cannot unlock Mosaic.
 *
 *   POST /v1/activate        { key, email, machine, name }  → { ok, token, license } | device-limit + devices
 *   POST /v1/validate        { key, machine }                → { ok, token } | { ok: false, error }
 *   POST /v1/devices         { key, email }                  → { ok, devices }
 *   POST /v1/deactivate      { key, email, machine }         → { ok, devices }
 *   POST /v1/orders          { email, machine }              → { ok, code, content, amount }
 *   POST /v1/orders/status   { code, email, machine }        → { ok, status, key? }
 *   POST /v1/webhooks/sepay         bank transfers (SePay)
 *   POST /v1/webhooks/lemonsqueezy  card sales (Lemon Squeezy)
 *   POST /v1/admin/licenses  { email, deviceLimit? }        → { ok, key }   (Bearer ADMIN_TOKEN)
 *   POST /v1/admin/revoke    { key }                         → { ok }        (Bearer ADMIN_TOKEN)
 */

export interface Env {
  DB: D1Database;
  PRICE_VND: string;
  DEVICE_LIMIT: string;
  LS_STORE_ID: string;
  LS_PRODUCT_ID: string;
  SIGNING_KEY: string;
  ADMIN_TOKEN?: string;
  SEPAY_API_KEY?: string;
  LS_WEBHOOK_SECRET?: string;
}

type License = {
  id: string;
  key_hash: string;
  key_hint: string;
  email: string;
  source: string;
  device_limit: number;
  status: string;
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const encoder = new TextEncoder();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const now = () => Date.now();
const normalizeEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();
const normalizeKey = (value: unknown) => String(value ?? "").trim().toUpperCase();
const normalizeMachine = (value: unknown) => {
  const code = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : "";
};
const validEmail = (email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254;

function randomCode(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 32 divides 256, so the modulo is unbiased.
  return Array.from(bytes, (byte) => ALPHABET[byte % 32]).join("");
}

/** A key for a bank or manual sale: MSC-XXXX-XXXX-XXXX-XXXX (80 random bits). */
function newLicenseKey() {
  const code = randomCode(16);
  return `MSC-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`;
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const keyHash = (key: string) => sha256Hex(`mosaic-license:${normalizeKey(key)}`);
const keyHint = (key: string) => `…${normalizeKey(key).slice(-4)}`;

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let signingKey: Promise<CryptoKey> | null = null;
function loadSigningKey(env: Env) {
  signingKey ||= (async () => {
    const pem = env.SIGNING_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
    return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  })();
  return signingKey;
}

/**
 * The proof the app stores: this license is active on this machine, as of
 * now. The app verifies it offline with the public key it ships with.
 */
async function activationToken(env: Env, license: License, machine: string) {
  const body = encoder.encode(JSON.stringify({ v: 1, kind: "activation", lic: license.id, email: license.email, machine, iat: now() }));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await loadSigningKey(env), body));
  return `${base64url(body)}.${base64url(signature)}`;
}

async function timingSafeEqualText(left: string, right: string) {
  // Compare digests so the lengths always match.
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function findLicense(env: Env, key: string) {
  if (!normalizeKey(key)) return null;
  return env.DB.prepare("SELECT * FROM licenses WHERE key_hash = ?").bind(await keyHash(key)).first<License>();
}

/** The license, if the key and the buyer's email both match. Same answer for either mistake. */
async function authorize(env: Env, key: unknown, email: unknown) {
  const license = await findLicense(env, String(key ?? ""));
  if (!license || license.email !== normalizeEmail(email)) return null;
  return license;
}

async function devicesOf(env: Env, licenseId: string) {
  const { results } = await env.DB.prepare("SELECT machine, name, activated_at, last_seen_at FROM activations WHERE license_id = ? ORDER BY activated_at")
    .bind(licenseId).all<{ machine: string; name: string; activated_at: number; last_seen_at: number }>();
  return results.map((row) => ({ machine: row.machine, name: row.name, activatedAt: row.activated_at, lastSeenAt: row.last_seen_at }));
}

async function createLicense(env: Env, input: { key: string; email: string; source: string; deviceLimit: number; externalId?: string | null; orderRef?: string | null; status?: string }) {
  const id = crypto.randomUUID();
  const at = now();
  await env.DB.prepare(
    "INSERT INTO licenses (id, key_hash, key_hint, email, source, device_limit, status, external_id, order_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, await keyHash(input.key), keyHint(input.key), normalizeEmail(input.email), input.source, input.deviceLimit, input.status ?? "active", input.externalId ?? null, input.orderRef ?? null, at, at).run();
  return id;
}

// ---- app endpoints -----------------------------------------------------------

async function activate(env: Env, body: Record<string, unknown>) {
  const machine = normalizeMachine(body.machine);
  if (!machine) return json({ ok: false, error: "machine" }, 400);
  const license = await authorize(env, body.key, body.email);
  if (!license) return json({ ok: false, error: "invalid" }, 404);
  if (license.status !== "active") return json({ ok: false, error: "revoked" }, 403);
  const given = String(body.name ?? "").trim().slice(0, 80);
  const name = given || "Computer";
  const at = now();
  const existing = await env.DB.prepare("SELECT 1 FROM activations WHERE license_id = ? AND machine = ?").bind(license.id, machine).first();
  if (existing) {
    // Activating again keeps the computer's name unless a new one is given.
    await env.DB.prepare("UPDATE activations SET last_seen_at = ?, name = COALESCE(?, name) WHERE license_id = ? AND machine = ?").bind(at, given || null, license.id, machine).run();
  } else {
    // Count and insert in one statement, so two computers activating at the
    // same moment cannot both take the last slot.
    const inserted = await env.DB.prepare(
      `INSERT INTO activations (license_id, machine, name, activated_at, last_seen_at)
       SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM activations WHERE license_id = ?) < ?`,
    ).bind(license.id, machine, name, at, at, license.id, license.device_limit).run();
    if (!inserted.meta.changes) {
      return json({ ok: false, error: "device-limit", deviceLimit: license.device_limit, devices: await devicesOf(env, license.id) }, 409);
    }
  }
  return json({
    ok: true,
    token: await activationToken(env, license, machine),
    license: { email: license.email, keyHint: license.key_hint, source: license.source, deviceLimit: license.device_limit },
  });
}

async function validate(env: Env, body: Record<string, unknown>) {
  const machine = normalizeMachine(body.machine);
  const license = await findLicense(env, String(body.key ?? ""));
  // Explicit verdicts only: the app revokes on these and nothing else.
  if (!license) return json({ ok: false, error: "invalid" });
  if (license.status !== "active") return json({ ok: false, error: "revoked" });
  const touched = await env.DB.prepare("UPDATE activations SET last_seen_at = ? WHERE license_id = ? AND machine = ?").bind(now(), license.id, machine).run();
  if (!touched.meta.changes) return json({ ok: false, error: "not-activated" });
  return json({ ok: true, token: await activationToken(env, license, machine) });
}

async function devices(env: Env, body: Record<string, unknown>) {
  const license = await authorize(env, body.key, body.email);
  if (!license) return json({ ok: false, error: "invalid" }, 404);
  return json({ ok: true, deviceLimit: license.device_limit, devices: await devicesOf(env, license.id) });
}

async function deactivate(env: Env, body: Record<string, unknown>) {
  const license = await authorize(env, body.key, body.email);
  if (!license) return json({ ok: false, error: "invalid" }, 404);
  const machine = normalizeMachine(body.machine);
  await env.DB.prepare("DELETE FROM activations WHERE license_id = ? AND machine = ?").bind(license.id, machine).run();
  return json({ ok: true, deviceLimit: license.device_limit, devices: await devicesOf(env, license.id) });
}

async function createOrder(env: Env, body: Record<string, unknown>) {
  const email = normalizeEmail(body.email);
  const machine = normalizeMachine(body.machine);
  if (!validEmail(email)) return json({ ok: false, error: "email" }, 400);
  if (!machine) return json({ ok: false, error: "machine" }, 400);
  const amount = Number(env.PRICE_VND);
  // Reopening the purchase screen returns the same order rather than
  // piling up new ones.
  const open = await env.DB.prepare("SELECT code, amount FROM orders WHERE email = ? AND machine = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(email, machine, now() - 7 * 864e5).first<{ code: string; amount: number }>();
  if (open && open.amount === amount) return json({ ok: true, code: open.code, content: `MOSAIC ${open.code}`, amount });
  const code = randomCode(6);
  await env.DB.prepare("INSERT INTO orders (code, email, machine, amount, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").bind(code, email, machine, amount, now()).run();
  return json({ ok: true, code, content: `MOSAIC ${code}`, amount });
}

async function orderStatus(env: Env, body: Record<string, unknown>) {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE code = ?").bind(String(body.code ?? "").toUpperCase()).first<{ email: string; machine: string; status: string; license_key: string | null }>();
  // Only the buyer who opened the order (same email and computer) sees its key.
  if (!order || order.email !== normalizeEmail(body.email) || order.machine !== normalizeMachine(body.machine)) return json({ ok: false, error: "invalid" }, 404);
  return order.status === "paid" ? json({ ok: true, status: "paid", key: order.license_key }) : json({ ok: true, status: "pending" });
}

// ---- webhooks -----------------------------------------------------------------

/**
 * SePay reports each incoming transfer. A transfer whose description holds
 * "MOSAIC <code>" for a pending order, of at least the order's amount, pays
 * it: a license is created and the buyer's app picks the key up.
 */
async function sepayWebhook(env: Env, request: Request) {
  const header = request.headers.get("authorization") ?? "";
  if (!env.SEPAY_API_KEY || !(await timingSafeEqualText(header, `Apikey ${env.SEPAY_API_KEY}`))) return json({ success: false }, 401);
  const tx = await request.json<Record<string, unknown>>();
  if (tx.transferType !== "in") return json({ success: true });
  const content = String(tx.content ?? "");
  // Banks may upper-case the description or drop the space.
  const code = content.toUpperCase().match(/MOSAIC\s*([A-Z2-9]{6})/)?.[1] ?? null;
  const amount = Number(tx.transferAmount) || 0;
  const recorded = await env.DB.prepare("INSERT OR IGNORE INTO bank_transactions (id, order_code, amount, content, received_at) VALUES (?, ?, ?, ?, ?)")
    .bind(Number(tx.id), code, amount, content.slice(0, 500), now()).run();
  // A retried delivery of a transaction already handled.
  if (!recorded.meta.changes || !code) return json({ success: true });
  const order = await env.DB.prepare("SELECT * FROM orders WHERE code = ? AND status = 'pending'").bind(code).first<{ code: string; email: string; amount: number }>();
  if (!order || amount < order.amount) return json({ success: true });
  const key = newLicenseKey();
  const licenseId = await createLicense(env, { key, email: order.email, source: "bank", deviceLimit: Number(env.DEVICE_LIMIT) || 2, orderRef: order.code });
  await env.DB.prepare("UPDATE orders SET status = 'paid', license_id = ?, license_key = ?, paid_at = ? WHERE code = ? AND status = 'pending'").bind(licenseId, key, now(), order.code).run();
  return json({ success: true });
}

async function verifyLemonSqueezy(env: Env, raw: string, signature: string) {
  if (!env.LS_WEBHOOK_SECRET || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.LS_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(raw)));
  const given = Uint8Array.from(signature.match(/../g)!.map((pair) => parseInt(pair, 16)));
  return crypto.subtle.timingSafeEqual(expected, given);
}

/**
 * Lemon Squeezy still sells and emails the key; this server takes over
 * counting its devices. license_key_created/updated keep the key in step,
 * order_refunded revokes it.
 */
async function lemonSqueezyWebhook(env: Env, request: Request) {
  const raw = await request.text();
  if (!(await verifyLemonSqueezy(env, raw, request.headers.get("x-signature") ?? ""))) return json({ ok: false }, 401);
  const payload = JSON.parse(raw) as { meta?: { event_name?: string }; data?: { id?: string; attributes?: Record<string, unknown> } };
  const event = payload.meta?.event_name;
  const attributes = payload.data?.attributes ?? {};
  const id = String(payload.data?.id ?? "");
  const ours = String(attributes.store_id) === env.LS_STORE_ID && (event === "order_refunded" || String(attributes.product_id) === env.LS_PRODUCT_ID);
  if (!ours) return json({ ok: true, ignored: true });
  if (event === "license_key_created" || event === "license_key_updated") {
    const status = ["disabled", "expired"].includes(String(attributes.status)) || attributes.disabled ? "revoked" : "active";
    const limit = Number(attributes.activation_limit) || Number(env.DEVICE_LIMIT) || 2;
    const known = await env.DB.prepare("SELECT id FROM licenses WHERE external_id = ?").bind(id).first<{ id: string }>();
    if (known) {
      await env.DB.prepare("UPDATE licenses SET status = ?, device_limit = ?, email = ?, updated_at = ? WHERE id = ?")
        .bind(status, limit, normalizeEmail(attributes.user_email), now(), known.id).run();
    } else {
      await createLicense(env, { key: String(attributes.key), email: String(attributes.user_email), source: "lemonsqueezy", deviceLimit: limit, externalId: id, orderRef: String(attributes.order_id ?? ""), status });
    }
  } else if (event === "order_refunded") {
    await env.DB.prepare("UPDATE licenses SET status = 'revoked', updated_at = ? WHERE source = 'lemonsqueezy' AND order_ref = ?").bind(now(), id).run();
  }
  return json({ ok: true });
}

// ---- admin ----------------------------------------------------------------------

async function admin(env: Env, request: Request, path: string, body: Record<string, unknown>) {
  const header = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || !(await timingSafeEqualText(header, `Bearer ${env.ADMIN_TOKEN}`))) return json({ ok: false }, 401);
  if (path === "/v1/admin/licenses") {
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) return json({ ok: false, error: "email" }, 400);
    const key = newLicenseKey();
    await createLicense(env, { key, email, source: "manual", deviceLimit: Number(body.deviceLimit) || Number(env.DEVICE_LIMIT) || 2 });
    return json({ ok: true, key });
  }
  if (path === "/v1/admin/revoke") {
    const result = await env.DB.prepare("UPDATE licenses SET status = 'revoked', updated_at = ? WHERE key_hash = ?").bind(now(), await keyHash(String(body.key ?? ""))).run();
    return json({ ok: result.meta.changes > 0 });
  }
  return json({ ok: false, error: "not-found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
    try {
      if (pathname === "/v1/webhooks/sepay") return await sepayWebhook(env, request);
      if (pathname === "/v1/webhooks/lemonsqueezy") return await lemonSqueezyWebhook(env, request);
      const body = await request.json<Record<string, unknown>>().catch(() => ({}));
      if (pathname.startsWith("/v1/admin/")) return await admin(env, request, pathname, body);
      switch (pathname) {
        case "/v1/activate": return await activate(env, body);
        case "/v1/validate": return await validate(env, body);
        case "/v1/devices": return await devices(env, body);
        case "/v1/deactivate": return await deactivate(env, body);
        case "/v1/orders": return await createOrder(env, body);
        case "/v1/orders/status": return await orderStatus(env, body);
        default: return json({ ok: false, error: "not-found" }, 404);
      }
    } catch (error) {
      console.error("license server error", error);
      return json({ ok: false, error: "server" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
