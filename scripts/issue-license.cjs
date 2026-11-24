#!/usr/bin/env node
/**
 * Issue Mosaic license keys for sales made outside the card checkout (a bank
 * transfer, an invoice, a gift). Keys are signed with an Ed25519 private key
 * that never enters the repository; the app checks them offline against the
 * public key in package.json → mosaicLicense.publicKey.
 *
 *   node scripts/issue-license.cjs init                      create the key pair (once) and print the public key
 *   node scripts/issue-license.cjs issue --email a@b.com --machine ABCDE-12345 [--machine FGHJK-67890] [--name "Ten Khach"]
 *   node scripts/issue-license.cjs issue --email a@b.com --any-machine      a key that runs on any computer (gifts)
 *   node scripts/issue-license.cjs verify <key>
 *
 * A key is tied to the buyer's email (the app asks for it on activation) and,
 * unless --any-machine is given, to the "Machine code" the buyer reads from
 * Mosaic's purchase screen: at most two per order, as with a card purchase.
 *
 * The private key lives in %USERPROFILE%\.mosaic-licensing (or the file named
 * by MOSAIC_LICENSE_PRIVATE_KEY). Back it up: without it no new key can be
 * issued, and anyone who has it can issue keys.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_FILE = process.env.MOSAIC_LICENSE_PRIVATE_KEY
  || path.join(os.homedir(), '.mosaic-licensing', 'mosaic-license-ed25519.pem');
const PREFIX = 'MOSAIC-';

const base64url = buffer => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = text => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}
function options(name) {
  return process.argv.flatMap((value, index) => (value === `--${name}` && process.argv[index + 1] ? [process.argv[index + 1]] : []));
}

function publicKeyText(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
}

function loadPrivateKey() {
  if (!fs.existsSync(KEY_FILE)) throw new Error(`No private key at ${KEY_FILE}. Run "init" first.`);
  return crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
}

const command = process.argv[2];
if (command === 'init') {
  if (fs.existsSync(KEY_FILE)) {
    console.log(`A key pair already exists at ${KEY_FILE}; it was not replaced.`);
  } else {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`Private key written to ${KEY_FILE}. Back it up somewhere safe.`);
  }
  console.log(`Public key (package.json → mosaicLicense.publicKey):\n${publicKeyText(loadPrivateKey())}`);
} else if (command === 'issue') {
  const email = option('email');
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Pass --email with the buyer\'s address.');
  const machines = options('machine').map(code => code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (machines.some(code => code.length !== 10)) throw new Error('A machine code has 10 letters and digits, e.g. ABCDE-12345.');
  if (!machines.length && !process.argv.includes('--any-machine')) throw new Error("Pass --machine with the buyer's machine code (or --any-machine for a key that runs anywhere).");
  if (machines.length > 2) throw new Error('One purchase covers at most two computers.');
  const payload = { v: 1, id: crypto.randomUUID(), email: email.trim().toLowerCase(), issued: new Date().toISOString() };
  if (machines.length) payload.machines = machines.map(code => `${code.slice(0, 5)}-${code.slice(5)}`);
  const name = option('name');
  if (name) payload.name = name;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(null, body, loadPrivateKey());
  console.log(`${PREFIX}${base64url(body)}.${base64url(signature)}`);
} else if (command === 'verify') {
  const key = String(process.argv[3] || '').trim();
  const [body, signature] = key.slice(PREFIX.length).split('.');
  const publicKey = crypto.createPublicKey(loadPrivateKey());
  const valid = key.startsWith(PREFIX) && body && signature && crypto.verify(null, fromBase64url(body), publicKey, fromBase64url(signature));
  console.log(valid ? `valid: ${fromBase64url(body).toString('utf8')}` : 'invalid');
  process.exitCode = valid ? 0 : 1;
} else {
  console.log('Usage: issue-license.cjs init | issue --email <address> (--machine <code> [--machine <code>] | --any-machine) [--name <name>] | verify <key>');
  process.exitCode = 1;
}
