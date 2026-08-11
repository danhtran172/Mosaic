/* Headless Native Messaging worker for the unpacked Windows app.
 * stdout is reserved exclusively for length-prefixed protocol frames. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB_IMPORTS_SOURCE_ID = 'allsight-web-imports';
const registryPaths = [
  path.join(process.env.APPDATA || process.env.USERPROFILE || '.', 'Mosaic', 'profiles.json'),
  // Source builds before the Mosaic rename stored profile data here.
  path.join(process.env.APPDATA || process.env.USERPROFILE || '.', 'InDeck', 'profiles.json'),
];
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

const ready = profile => Boolean(profile?.initialized && profile?.mediaPath);
const isRecycleBinPath = value => /(?:^|[\\/])\$recycle\.bin(?:[\\/]|$)/i.test(String(value || ''));
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
function registryPath() { return registryPaths.find(file => fs.existsSync(file)) || registryPaths[0]; }
function registry() {
  const value = readJson(registryPath(), { profiles: [] });
  value.profiles = Array.isArray(value.profiles) ? value.profiles : [];
  return value;
}
function profiles() { return registry().profiles; }
function profileAvailability(profile) {
  if (!ready(profile)) return { available: false, reason: 'Default Library Location has not been configured.' };
  let reachable = false;
  try { reachable = fs.statSync(profile.mediaPath).isDirectory(); } catch { /* unavailable source */ }
  return reachable
    ? { available: true, reason: null }
    : { available: false, reason: 'Mosaic cannot access this profile’s Library location.' };
}
function profileById(id) { return profiles().find(profile => String(profile.id) === String(id)); }
function readLibrary(profile) { return readJson(path.join(profile.dataPath, 'library.json'), { sources: [], collections: [], assetMeta: {} }); }
function writeLibrary(profile, data) { writeJson(path.join(profile.dataPath, 'library.json'), data); }
function defaultSave(profile) { return path.join(profile.mediaPath, 'DefaultSave'); }
function discards(profile) { return path.join(profile.mediaPath, 'Discards'); }
function safeName(value) { return String(value || 'web-image').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'web-image'; }
function samePath(left, right) { return path.resolve(String(left || '')).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(String(right || '')).replace(/[\\/]+$/, '').toLowerCase(); }
function imageExtension(type, url) {
  const types = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp' };
  const known = types[String(type || '').split(';')[0].toLowerCase()];
  if (known) return known;
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return imageExtensions.has(ext) ? ext : '.jpg';
}

// The extension can run while Electron is closed. Recover the known Library
// root before every operation that needs it, rather than asking Chrome to show
// a success state for a path that has been deleted or moved to the Recycle Bin.
function recoverProfile(profile) {
  const candidates = [profile.lastMediaPath, profile.mediaPath]
    .map(value => String(value || '').trim())
    .filter(value => value && !isRecycleBinPath(value));
  const mediaPath = candidates[0];
  if (!mediaPath) throw new Error('No recoverable Default Library Location was found for this profile');

  const value = registry();
  const stored = value.profiles.find(item => String(item.id) === String(profile.id)) || profile;
  const changed = !samePath(stored.mediaPath, mediaPath) || !samePath(stored.lastMediaPath, mediaPath);
  stored.mediaPath = mediaPath;
  stored.lastMediaPath = mediaPath;
  fs.mkdirSync(mediaPath, { recursive: true });
  fs.mkdirSync(defaultSave(stored), { recursive: true });
  fs.mkdirSync(discards(stored), { recursive: true });
  if (changed) writeJson(registryPath(), value);
  return stored;
}

function galleryDefaultPath(profile, gallery, source) {
  const candidate = gallery.defaultSourcePath || source?.path;
  if (candidate && !isRecycleBinPath(candidate)) return candidate;
  return path.join(profile.mediaPath, `${safeName(gallery.name)} Default Source`);
}
function ensureLibraryStructures(profile, library) {
  let changed = false;
  library.sources ||= [];
  library.collections ||= [];
  const importPath = defaultSave(profile);
  let importSource = library.sources.find(item => String(item.id) === WEB_IMPORTS_SOURCE_ID)
    || library.sources.find(item => samePath(item.path, importPath));
  if (!importSource) {
    importSource = { id: WEB_IMPORTS_SOURCE_ID, name: 'DefaultSave', path: importPath, assets: [] };
    library.sources.push(importSource);
    changed = true;
  }
  if (importSource.id !== WEB_IMPORTS_SOURCE_ID) { importSource.id = WEB_IMPORTS_SOURCE_ID; changed = true; }
  if (importSource.name !== 'DefaultSave') { importSource.name = 'DefaultSave'; changed = true; }
  if (!samePath(importSource.path, importPath)) { importSource.path = importPath; changed = true; }
  importSource.assets ||= [];
  fs.mkdirSync(importPath, { recursive: true });

  for (const gallery of library.collections) {
    const sourceId = String(gallery.defaultSourceId || `indeck-gallery-default:${gallery.id}`);
    let source = library.sources.find(item => String(item.id) === sourceId);
    const folder = galleryDefaultPath(profile, gallery, source);
    fs.mkdirSync(folder, { recursive: true });
    if (!source) {
      source = { id: sourceId, name: 'Default Source', path: folder, assets: [] };
      library.sources.push(source);
      changed = true;
    }
    if (source.name !== 'Default Source') { source.name = 'Default Source'; changed = true; }
    if (!samePath(source.path, folder)) { source.path = folder; changed = true; }
    source.assets ||= [];
    if (String(gallery.defaultSourceId || '') !== sourceId) { gallery.defaultSourceId = sourceId; changed = true; }
    if (!samePath(gallery.defaultSourcePath, folder)) { gallery.defaultSourcePath = folder; changed = true; }
    gallery.sourceIds ||= [];
    if (!gallery.sourceIds.map(String).includes(sourceId)) { gallery.sourceIds.push(sourceId); changed = true; }
  }
  return changed;
}

function profileConfig(profile, library) {
  const galleries = library.collections.map(gallery => ({ id: String(gallery.id), name: String(gallery.name || 'Untitled Gallery') }));
  const allowed = new Set(galleries.map(gallery => gallery.id));
  const seen = new Set();
  const slots = Array.from({ length: 4 }, (_, index) => {
    const id = library.extensionGallerySlots?.[index] == null ? null : String(library.extensionGallerySlots[index]);
    if (!id || !allowed.has(id) || seen.has(id)) return null;
    seen.add(id);
    return galleries.find(gallery => gallery.id === id);
  });
  return { defaultFolder: { name: 'DefaultSave', path: defaultSave(profile) }, galleries, slots };
}
function writeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  fs.writeSync(1, frame);
}

async function importImage(profile, sourceUrl, galleryId) {
  const url = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web image URLs are supported');
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mosaic Web Importer' } });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw new Error('The selected URL is not an image');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 80 * 1024 * 1024) throw new Error('Image is empty or too large');

  const library = readLibrary(profile);
  const recovered = ensureLibraryStructures(profile, library);
  const gallery = galleryId && library.collections.find(item => String(item.id) === String(galleryId));
  const sourceId = gallery ? String(gallery.defaultSourceId) : WEB_IMPORTS_SOURCE_ID;
  const source = library.sources.find(item => String(item.id) === sourceId);
  const directory = source?.path || defaultSave(profile);
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${safeName(path.basename(url.pathname, path.extname(url.pathname)))}-${Date.now()}${imageExtension(contentType, url.href)}`;
  const target = path.join(directory, filename);
  fs.writeFileSync(target, bytes);
  const savedFile = fs.statSync(target, { throwIfNoEntry: false });
  if (!savedFile?.isFile() || savedFile.size !== bytes.length) throw new Error('The image could not be confirmed in the Library');

  source.name = gallery ? 'Default Source' : 'DefaultSave';
  source.path = directory;
  source.assets ||= [];
  const asset = { id: crypto.createHash('sha1').update(`source:${sourceId}\0${filename}`).digest('hex'), path: target, relativePath: filename, name: filename, type: 'image', modified: Date.now(), vault: false };
  source.assets.push(asset);
  if (gallery) {
    gallery.defaultSourceId = sourceId;
    gallery.defaultSourcePath = directory;
    gallery.sourceIds = [...new Set([...(gallery.sourceIds || []), sourceId])];
    gallery.items ||= [];
    gallery.manualItemIds ||= [];
    gallery.extensionItemIds ||= [];
    if (!gallery.items.includes(asset.id)) gallery.itemOrder === 'newest-first' ? gallery.items.unshift(asset.id) : gallery.items.push(asset.id);
    if (!gallery.manualItemIds.includes(asset.id)) gallery.manualItemIds.push(asset.id);
    if (!gallery.extensionItemIds.includes(asset.id)) gallery.extensionItemIds.push(asset.id);
    if (!gallery.coverId) gallery.coverId = asset.id;
  }
  // Persist the recovered source graph together with the item only after the
  // file above has passed the post-write verification.
  writeLibrary(profile, library);
  return { asset, galleryId: gallery?.id || null, saved: true, recovered };
}

async function handle(message) {
  if (message?.type === 'profiles:list') return {
    ok: true,
    profiles: profiles()
      .slice()
      .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
      .map(profile => ({
        id: profile.id,
        name: profile.name,
        isDefault: Boolean(profile.isDefault),
        ...profileAvailability(profile),
      })),
  };
  let profile = profileById(message?.profileId);
  if (!profile) throw new Error('The selected profile no longer exists');
  if (!ready(profile)) throw new Error('Finish Default Library Location setup before using this profile');
  profile = recoverProfile(profile);
  const library = readLibrary(profile);
  const recovered = ensureLibraryStructures(profile, library);
  if (recovered) writeLibrary(profile, library);
  if (message.type === 'profile:config') return { ok: true, profile: { id: profile.id, name: profile.name }, ...profileConfig(profile, library) };
  if (message.type === 'profile:slots') {
    const allowed = new Set(library.collections.map(item => String(item.id)));
    const seen = new Set();
    library.extensionGallerySlots = Array.from({ length: 4 }, (_, index) => {
      const id = message.galleryIds?.[index] == null ? null : String(message.galleryIds[index]);
      if (!id || !allowed.has(id) || seen.has(id)) return null;
      seen.add(id);
      return id;
    });
    writeLibrary(profile, library);
    return { ok: true, profile: { id: profile.id, name: profile.name }, ...profileConfig(profile, library) };
  }
  if (message.type === 'media:import') {
    const result = await importImage(profile, message.url, message.galleryId);
    return { ok: true, saved: result.saved, asset: { id: result.asset.id, name: result.asset.name }, profileId: profile.id, galleryId: result.galleryId };
  }
  throw new Error('Unsupported native message');
}

let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > 1024 * 1024 || input.length < length + 4) return;
    const raw = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    handle(JSON.parse(raw.toString('utf8'))).then(writeMessage).catch(error => writeMessage({ ok: false, error: error.message || 'Native host failed' }));
  }
});
process.stdin.resume();
