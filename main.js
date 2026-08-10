const { app, BrowserWindow, dialog, ipcMain, clipboard, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const ffmpegPath = require('ffmpeg-static');

// Rebrand the desktop application without moving existing profiles and
// libraries out of Electron's previous InDeck user-data folder.
app.setName('Mosaic');
app.setPath('userData', path.join(app.getPath('appData'), 'InDeck'));

const MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.mp4', '.mov', '.m4v', '.webm', '.avi', '.ts']);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);
const WEB_IMPORTS_SOURCE_ID = 'allsight-web-imports';
const PROFILE_MAIN_LIBRARY_SOURCE_ID = 'indeck-profile-main-library';
const VAULT_BRIDGE_FILE = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'MasterVisionVault', 'indeck-bridge.json');
// Keep branded resources inside the project so packaged/source builds never
// depend on a user Downloads path.
const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon.png');
const DEFAULT_PROFILE_ID = 'default';
const NATIVE_HOST_NAME = 'com.indeck.mastervision';
const EXTENSION_ID = 'fpbeciobaoekefhhjjenfomhkffmejah';
const profileWindows = new Map();
const webContentsProfileIds = new Map();
const profileWatchers = new Map();
let profileRegistryWriteQueue = Promise.resolve();
const NATIVE_MESSAGING_MODE = process.argv.some(argument => String(argument).startsWith('chrome-extension://'));
const NATIVE_HOST_REGISTRATION_MODE = process.argv.includes('--register-native-host');
let nativeHostInput = Buffer.alloc(0);
let nativeHostInputEnded = false;
let nativeHostStarted = false;
let nativeHostHandling = Promise.resolve();
const nativeHostKeepAlive = NATIVE_MESSAGING_MODE ? setInterval(() => {}, 1000) : null;
let nativeHostWindow = null;
function requestedProfileId(argv = process.argv) {
  const argument = argv.find(value => String(value).startsWith('--profile='));
  return argument ? String(argument).slice('--profile='.length) || null : null;
}
if (NATIVE_MESSAGING_MODE) {
  // Chrome writes the request immediately after starting the executable. Begin
  // buffering before Electron's ready event so a very short-lived connection
  // cannot finish before the native host subscribes to stdin.
  process.stdin.on('data', chunk => {
    nativeHostInput = Buffer.concat([nativeHostInput, Buffer.from(chunk)]);
    if (nativeHostStarted) processNativeInput();
  });
  process.stdin.on('end', () => {
    nativeHostInputEnded = true;
    if (nativeHostStarted) finishNativeInput();
  });
  process.stdin.resume();
}

function profilesRegistryPath() { return path.join(app.getPath('userData'), 'profiles.json'); }
function legacyProfile() {
  return {
    id: DEFAULT_PROFILE_ID,
    name: 'Default',
    dataPath: app.getPath('userData'),
    mediaPath: path.join(app.getPath('pictures'), 'InDeckMedia'),
    lastMediaPath: path.join(app.getPath('pictures'), 'InDeckMedia'),
    isDefault: true,
    initialized: true,
    createdAt: 0,
  };
}
function profileDataPath(profile) { return path.resolve(profile?.dataPath || legacyProfile().dataPath); }
function profileMediaPath(profile) {
  if (profile && !profile.mediaPath) throw new Error('Profile library location has not been configured');
  return path.resolve(profile?.mediaPath || legacyProfile().mediaPath);
}
function isProfileReady(profile) { return Boolean(profile?.initialized && profile?.mediaPath); }
function profileRecoveryMediaPath(profile) {
  const candidates = [profile?.lastMediaPath, profile?.mediaPath]
    .map(value => String(value || '').trim())
    .filter(value => value && !isRecycleBinPath(value));
  return candidates[0] || path.join(app.getPath('pictures'), `InDeckMedia_${safeFolderPart(profile?.name || 'Profile')}`);
}
function newProfileId() { return `profile-${crypto.randomUUID()}`; }
function cleanProfileName(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
function comparableProfileName(value) { return cleanProfileName(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase(); }
function profileNameIsAvailable(name, profiles, exceptId = null) { const comparable = comparableProfileName(name); return !profiles.some(profile => profile.id !== exceptId && comparableProfileName(profile.name) === comparable); }
function restoredProfileName(name, activeProfiles) {
  const base = cleanProfileName(name) || 'Recovered profile';
  if (profileNameIsAvailable(base, activeProfiles)) return base;
  for (let number = 2; number < 10000; number += 1) {
    const suffix = ` (${number})`;
    const candidate = `${base.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
    if (profileNameIsAvailable(candidate, activeProfiles)) return candidate;
  }
  throw new Error('Could not create a unique recovered profile name');
}
async function readProfileRegistry() {
  try {
    const value = JSON.parse(await fs.promises.readFile(profilesRegistryPath(), 'utf8'));
    if (!Array.isArray(value?.profiles) || !value.profiles.length) throw new Error('Invalid profile registry');
    const profiles = value.profiles
      .filter(profile => profile?.id && profile?.dataPath)
      .map(profile => ({
        ...profile,
        id: String(profile.id),
        name: cleanProfileName(profile.name) || 'Untitled profile',
        initialized: profile.initialized ?? Boolean(profile.mediaPath),
        lastMediaPath: profile.lastMediaPath || profile.mediaPath || null,
      }));
    if (!profiles.length) throw new Error('Invalid profile registry');
    if (!profiles.some(profile => profile.isDefault)) profiles[0].isDefault = true;
    return { version: 2, profiles, discardedProfiles: Array.isArray(value.discardedProfiles) ? value.discardedProfiles : [] };
  } catch {
    const registry = { version: 2, profiles: [legacyProfile()], discardedProfiles: [] };
    await writeProfileRegistry(registry);
    return registry;
  }
}
async function writeProfileRegistry(value) {
  const snapshot = JSON.parse(JSON.stringify(value));
  profileRegistryWriteQueue = profileRegistryWriteQueue.catch(() => {}).then(async () => {
    const target = profilesRegistryPath();
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.promises.rename(temporary, target);
  });
  return profileRegistryWriteQueue;
}
async function profileById(profileId) {
  const registry = await readProfileRegistry();
  return registry.profiles.find(profile => profile.id === String(profileId)) || null;
}
async function defaultProfile() {
  const registry = await readProfileRegistry();
  return registry.profiles.find(profile => profile.isDefault) || registry.profiles[0] || null;
}
async function profileForWebContents(webContents) {
  const profileId = webContentsProfileIds.get(webContents?.id);
  const profile = profileId && await profileById(profileId);
  if (!profile) throw new Error('This window is not associated with a profile');
  return profile;
}
async function createProfile(name) {
  const profileName = cleanProfileName(name);
  if (!profileName) throw new Error('Profile name is required');
  const registry = await readProfileRegistry();
  if (!profileNameIsAvailable(profileName, registry.profiles)) throw new Error('A profile with this name already exists');
  const id = newProfileId();
  const profile = {
    id,
    name: profileName,
    dataPath: path.join(app.getPath('userData'), 'profiles', id),
    mediaPath: null,
    lastMediaPath: null,
    isDefault: false,
    initialized: false,
    createdAt: Date.now(),
  };
  await fs.promises.mkdir(profile.dataPath, { recursive: true });
  registry.profiles.push(profile);
  await writeProfileRegistry(registry);
  return profile;
}
function isInDeckLibraryFolder(folder) { return /^indeckmedia(?:_|$)/i.test(path.basename(folder)); }
function libraryMediaPathForSelection(folder, profile) {
  const value = String(folder || '').trim();
  if (!value) throw new Error('Choose a library location');
  const selected = path.resolve(value);
  // Selecting an existing InDeckMedia_* explicitly means sharing it. A new
  // selection always creates a Library named after the profile that owns it.
  if (isInDeckLibraryFolder(selected)) return selected;
  return path.join(selected, `InDeckMedia_${safeFolderPart(profile?.name || 'Profile')}`);
}
async function libraryLocationStatus(profileId, folder) {
  const profile = await profileById(profileId);
  if (!profile) throw new Error('Profile not found');
  const mediaPath = libraryMediaPathForSelection(folder, profile);
  const exists = await fs.promises.stat(mediaPath).then(stat => stat.isDirectory()).catch(() => false);
  const registry = await readProfileRegistry();
  const sharedWith = registry.profiles
    .filter(profile => profile.mediaPath && normalizedPath(profile.mediaPath) === normalizedPath(mediaPath))
    .map(profile => ({ id: profile.id, name: profile.name }));
  return { mediaPath, exists, sharedWith };
}
async function updateProfileInRegistry(profile) {
  const registry = await readProfileRegistry();
  const index = registry.profiles.findIndex(item => item.id === profile.id);
  if (index < 0) throw new Error('Profile not found');
  registry.profiles[index] = { ...registry.profiles[index], ...profile };
  await writeProfileRegistry(registry);
  return registry.profiles[index];
}
async function configureProfileLibrary(profileId, folder, useExisting) {
  const profile = await profileById(profileId);
  if (!profile) throw new Error('Profile not found');
  const status = await libraryLocationStatus(profileId, folder);
  if (status.exists && !useExisting) throw new Error('InDeckMedia already exists here. Confirm that you want to use it.');
  await fs.promises.mkdir(status.mediaPath, { recursive: true });
  profile.mediaPath = status.mediaPath;
  profile.lastMediaPath = status.mediaPath;
  profile.mediaTracking = await identifyFolder(status.mediaPath);
  profile.initialized = true;
  profile.libraryLocationConfiguredAt = Date.now();
  const stored = await updateProfileInRegistry(profile);
  await recoverProfileLibrary(stored);
  return stored;
}
async function relocateManagedProfilePaths(profile, previousMediaPath) {
  if (!previousMediaPath || normalizedPath(previousMediaPath) === normalizedPath(profile.mediaPath)) return false;
  const data = await readStore(profile);
  let changed = false;
  const relocate = value => {
    if (!value || !isPathInside(previousMediaPath, value)) return value;
    changed = true;
    return path.join(profile.mediaPath, path.relative(previousMediaPath, value));
  };
  for (const source of data.sources || []) {
    const before = source.path;
    source.path = relocate(source.path);
    if (before !== source.path) source.assets = (source.assets || []).map(asset => ({ ...asset, path: relocate(asset.path) }));
  }
  for (const gallery of data.collections || []) gallery.defaultSourcePath = relocate(gallery.defaultSourcePath);
  if (changed) await writeStore(profile, data);
  return changed;
}
async function trackProfileLibraryLocation(profile) {
  if (!isProfileReady(profile)) return profile;
  if (isRecycleBinPath(profile.mediaPath) || isRecycleBinPath(profile.lastMediaPath)) {
    const recoveredPath = profileRecoveryMediaPath(profile);
    await fs.promises.mkdir(recoveredPath, { recursive: true });
    profile.mediaPath = recoveredPath;
    profile.lastMediaPath = recoveredPath;
    profile.mediaTracking = await identifyFolder(recoveredPath);
    return updateProfileInRegistry(profile);
  }
  const previousMediaPath = profile.mediaPath;
  const resolved = await resolveTrackedFolder({ folder: profile.mediaPath || profile.lastMediaPath, tracking: profile.mediaTracking });
  if (resolved && normalizedPath(resolved) !== normalizedPath(profile.mediaPath)) {
    profile.mediaPath = resolved;
    profile.lastMediaPath = resolved;
    profile.mediaTracking = await identifyFolder(resolved) || profile.mediaTracking;
    const stored = await updateProfileInRegistry(profile);
    await relocateManagedProfilePaths(stored, previousMediaPath);
    return stored;
  }
  if (resolved && !profile.mediaTracking) {
    profile.mediaTracking = await identifyFolder(resolved);
    profile.lastMediaPath = resolved;
    return updateProfileInRegistry(profile);
  }
  return profile;
}
async function recoverProfileLibrary(profile) {
  if (!isProfileReady(profile)) throw new Error('Choose a Default Library Location before recovering this profile');
  profile = await ensureProfileLibraryFolders(profile);
  const data = await readStore(profile);
  const defaultSaveChanged = await ensureProfileDefaultSaveSource(profile, data);
  const mainLibraryChanged = await ensureProfileMainLibrarySource(profile, data);
  const prunedUnavailable = await reconcileUnavailableSources(profile, data);
  const repairedDefaults = await ensureDefaultSourcesForExistingGalleries(profile, data);
  if (defaultSaveChanged || mainLibraryChanged || prunedUnavailable || repairedDefaults) await writeStore(profile, data);
  return { profile, repairedDefaults, prunedUnavailable, defaultSaveChanged, mainLibraryChanged, mediaPath: profile.mediaPath };
}
async function renameProfile(profileId, name) {
  const profileName = cleanProfileName(name);
  if (!profileName) throw new Error('Profile name is required');
  const registry = await readProfileRegistry();
  const profile = registry.profiles.find(item => item.id === String(profileId));
  if (!profile) throw new Error('Profile not found');
  if (!profileNameIsAvailable(profileName, registry.profiles, profile.id)) throw new Error('A profile with this name already exists');
  profile.name = profileName;
  await writeProfileRegistry(registry);
  return profile;
}
async function setDefaultProfile(profileId) {
  const registry = await readProfileRegistry();
  const profile = registry.profiles.find(item => item.id === String(profileId));
  if (!profile) throw new Error('Profile not found');
  registry.profiles.forEach(item => { item.isDefault = item.id === profile.id; });
  await writeProfileRegistry(registry);
  return profile;
}
async function deleteProfile(profileId, typedName, replacementDefaultId = null) {
  const id = String(profileId);
  const registry = await readProfileRegistry();
  const profile = registry.profiles.find(item => item.id === id);
  if (!profile) throw new Error('Profile not found');
  if (comparableProfileName(typedName) !== comparableProfileName(profile.name)) throw new Error('The confirmation name does not match');
  if (registry.profiles.length < 2) throw new Error('The last active profile cannot be deleted');
  let replacement = null;
  if (profile.isDefault) {
    replacement = registry.profiles.find(item => item.id === String(replacementDefaultId));
    if (!replacement || replacement.id === profile.id) throw new Error('Choose another profile to become Default');
    profile.isDefault = false;
    replacement.isDefault = true;
  }
  registry.profiles = registry.profiles.filter(item => item.id !== id);
  registry.discardedProfiles ||= [];
  registry.discardedProfiles.unshift({ ...profile, isDefault: false, discardedAt: Date.now() });
  await writeProfileRegistry(registry);
  if (replacement) await createWindow(replacement.id);
  const window = profileWindows.get(id);
  if (window && !window.isDestroyed()) setTimeout(() => window.close(), 0);
  return profile;
}
async function recoverDiscardedProfile(profileId) {
  const registry = await readProfileRegistry();
  const index = registry.discardedProfiles.findIndex(profile => profile.id === String(profileId));
  if (index < 0) throw new Error('Discarded profile not found');
  const profile = { ...registry.discardedProfiles[index], discardedAt: undefined, isDefault: false };
  delete profile.discardedAt;
  profile.name = restoredProfileName(profile.name, registry.profiles);
  registry.discardedProfiles.splice(index, 1);
  if (!registry.profiles.some(item => item.isDefault)) profile.isDefault = true;
  registry.profiles.push(profile);
  await writeProfileRegistry(registry);
  return profile;
}
async function createProfileShortcut(profileId) {
  const profile = await profileById(profileId);
  if (!profile) throw new Error('Profile not found');
  const fileName = `Mosaic - ${safeFolderPart(profile.name)}.lnk`;
  const shortcutPath = path.join(app.getPath('desktop'), fileName);
  const options = app.isPackaged
    ? {
      target: app.getPath('exe'),
      args: `--profile=${profile.id}`,
      description: `Open Mosaic profile ${profile.name}`,
      workingDirectory: path.dirname(app.getPath('exe')),
    }
    : {
      // Keep the feature testable from the source checkout too. The batch
      // file rebuilds ui/dist, then forwards the profile argument to Electron.
      target: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      args: `/d /c ""${path.join(__dirname, 'Run MasterVision.bat')}" --profile=${profile.id}"`,
      description: `Open Mosaic profile ${profile.name}`,
      workingDirectory: __dirname,
    };
  if (fs.existsSync(APP_ICON_PATH)) options.icon = APP_ICON_PATH;
  if (!shell.writeShortcutLink(shortcutPath, 'create', options)) throw new Error('Could not create the profile shortcut');
  return shortcutPath;
}

if (!NATIVE_MESSAGING_MODE && !NATIVE_HOST_REGISTRATION_MODE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_event, argv) => {
  if (NATIVE_MESSAGING_MODE) return;
  createWindow(requestedProfileId(argv)).catch(error => console.error('Could not open profile window:', error.message));
});

function storePath(profile) { return path.join(profileDataPath(profile), 'library.json'); }
async function readStore(profile) {
  try { return JSON.parse(await fs.promises.readFile(storePath(profile), 'utf8')); }
  catch { return { sources: [], collections: [], assetMeta: {}, passwordHash: null }; }
}
const storeWriteQueues = new Map();
async function writeStore(profile, value) {
  // Renderer saves can be triggered by several independent UI interactions.
  // Serialize and atomically replace the file so a crash or a racing render
  // never leaves a half-written library.json behind.
  const snapshot = JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {}));
  const queueKey = profile?.id || DEFAULT_PROFILE_ID;
  const previous = storeWriteQueues.get(queueKey) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const target = storePath(profile);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.promises.rename(temporary, target);
  });
  storeWriteQueues.set(queueKey, next);
  return next;
}
function catalogPath(profile) { return path.join(profileDataPath(profile), 'media-catalog.json'); }
function thumbnailDirectory(profile) { return path.join(profileDataPath(profile), 'thumbnails'); }
const catalogPromises = new Map();
const catalogWriteQueues = new Map();
function readCatalog(profile) {
  const key = profile?.id || DEFAULT_PROFILE_ID;
  if (!catalogPromises.has(key)) catalogPromises.set(key, fs.promises.readFile(catalogPath(profile), 'utf8')
    .then(JSON.parse)
    .then(value => value && typeof value === 'object' && value.sources ? value : { format: 1, sources: {} })
    .catch(() => ({ format: 1, sources: {} })));
  return catalogPromises.get(key);
}
async function writeCatalog(profile) {
  const catalog = await readCatalog(profile);
  const key = profile?.id || DEFAULT_PROFILE_ID;
  const previous = catalogWriteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const target = catalogPath(profile), temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(temporary, JSON.stringify(catalog), 'utf8');
    await fs.promises.rename(temporary, target);
  });
  catalogWriteQueues.set(key, next);
  return next;
}
async function cacheSourceScan(profile, source, result) {
  if (!source?.id) return;
  const catalog = await readCatalog(profile);
  catalog.sources[source.id] = {
    folder: result.folder,
    tracking: result.tracking || null,
    vaultBridgeId: result.vaultBridgeId || null,
    indexedAt: Date.now(),
    assets: result.assets || []
  };
  await writeCatalog(profile);
}
async function cachedSourceScan(profile, source) {
  const record = (await readCatalog(profile)).sources?.[source?.id];
  if (!record?.assets || !Array.isArray(record.assets)) return null;
  return { ...record, assets: record.assets };
}
async function removeCachedSource(profile, sourceId) {
  const catalog = await readCatalog(profile);
  if (!catalog.sources?.[sourceId]) return;
  delete catalog.sources[sourceId];
  await writeCatalog(profile);
}
function thumbnailPath(profile, asset) { return path.join(thumbnailDirectory(profile), `${crypto.createHash('sha1').update(`${asset.id}:${asset.modified || 0}`).digest('hex')}.png`); }
function createVideoThumbnail(asset, target) {
  const source = asset?.vault ? asset.contentUrl : asset?.path;
  if (!ffmpegPath || !source) return Promise.resolve(false);
  return new Promise(resolve => execFile(ffmpegPath, [
    // Do not seek before MPEG-TS input: transport streams often start at a
    // non-zero timestamp, which can otherwise produce no frame at all.
    '-hide_banner', '-loglevel', 'error', '-i', source,
    '-frames:v', '1', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-y', target
  ], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, error => resolve(!error)));
}
async function createThumbnail(profile, asset) {
  if (!asset?.id || !['image', 'video'].includes(asset.type)) return null;
  // Do not reveal a stale thumbnail for a deleted file. The cache is not a
  // source of truth: paths in Windows Recycle Bin, InDeck Discards, or paths
  // that no longer exist are permanently ineligible.
  if (!asset.vault) {
    const assetPath = String(asset.path || '');
    if (!assetPath || isRecycleBinPath(assetPath) || isInDeckDiscardPath(profile, assetPath)) return null;
    const exists = await fs.promises.stat(assetPath).then(stat => stat.isFile()).catch(() => false);
    if (!exists) return null;
  }
  const target = thumbnailPath(profile, asset);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp.png`;
  try {
    await fs.promises.access(target);
    return pathToFileURL(target).href;
  } catch { /* Generate missing cache entry below. */ }
  try {
    await fs.promises.mkdir(thumbnailDirectory(profile), { recursive: true });
    if (asset.type === 'video') {
      if (!(await createVideoThumbnail(asset, temporary))) { await fs.promises.rm(temporary, { force: true }).catch(() => {}); return null; }
      await fs.promises.rename(temporary, target);
      return pathToFileURL(target).href;
    }
    let image;
    if (asset.vault) {
      const response = await fetch(asset.contentUrl || '');
      if (!response.ok) return null;
      image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        if (width && height) image = width >= height ? image.resize({ width: Math.min(512, width) }) : image.resize({ height: Math.min(512, height) });
      }
    } else if (asset.path) image = await nativeImage.createThumbnailFromPath(asset.path, { width: 512, height: 512 });
    else return null;
    if (image.isEmpty()) return null;
    await fs.promises.writeFile(temporary, image.toPNG());
    await fs.promises.rename(temporary, target);
    return pathToFileURL(target).href;
  } catch { await fs.promises.rm(temporary, { force: true }).catch(() => {}); return null; }
}
async function createThumbnails(profile, assets) {
  // The renderer reveals media in 50-item batches. Keep the backend bounded
  // too, so an accidental large IPC payload cannot spike image decoding.
  const items = Array.isArray(assets) ? assets.slice(0, 50) : [];
  const output = {};
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const asset = items[next++];
      const thumbnailUrl = await createThumbnail(profile, asset);
      if (thumbnailUrl) output[asset.id] = thumbnailUrl;
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  return output;
}

function normalizeFolder(value) { return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase(); }
// A deleted directory retains its NTFS id while it is in the Windows Recycle
// Bin. It is no longer a valid Media Source and must not be treated as a
// renamed folder by the tracking resolver.
function isRecycleBinPath(value) {
  return /(?:^|[\\/])\$recycle\.bin(?:[\\/]|$)/i.test(String(value || ''));
}
function assetIdFor(source, relativePath) {
  const sourceKey = source?.id || normalizeFolder(source?.path);
  return crypto.createHash('sha1').update(`source:${sourceKey}\0${relativePath.replace(/\\/g, '/')}`).digest('hex');
}
function runFileCommand(command, args) {
  return new Promise(resolve => execFile(command, args, { windowsHide: true }, (error, stdout) => resolve({ error, stdout: String(stdout || '') })));
}
function fileIdFromOutput(output) {
  const matches = String(output).match(/0x[0-9a-f]+/gi);
  return matches?.at(-1) || null;
}
async function identifyFolder(folder) {
  const absolute = path.resolve(String(folder || ''));
  const volume = path.parse(absolute).root.replace(/[\\/]+$/, '');
  if (!volume) return null;
  const result = await runFileCommand('fsutil', ['file', 'queryfileid', absolute]);
  const fileId = !result.error && fileIdFromOutput(result.stdout);
  return fileId ? { volume, fileId } : null;
}
async function resolveTrackedFolder(record) {
  const saved = String(record?.folder || record?.path || '');
  const fallback = saved && !isRecycleBinPath(saved) ? path.resolve(saved) : null;
  if (saved) {
    try { if ((await fs.promises.stat(saved)).isDirectory() && !isRecycleBinPath(saved)) return path.resolve(saved); }
    catch { /* A rename or Vault ACL can make the saved path unavailable. */ }
  }
  const volume = String(record?.tracking?.volume || record?.volume || '');
  const fileId = String(record?.tracking?.fileId || record?.fileId || record?.file_id || '');
  if (!volume || !fileId) return fallback;
  const result = await runFileCommand('fsutil', ['file', 'queryfilenamebyid', volume, fileId]);
  if (result.error) return fallback;
  const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    const absolute = line.match(/(?:\\\\\?\\)?([A-Za-z]:\\[^\r\n]+)$/);
    if (absolute && !isRecycleBinPath(absolute[1])) return path.resolve(absolute[1]);
    const relative = line.match(/(\\[^\r\n]+)$/);
    if (relative) {
      const candidate = `${volume}${relative[1]}`;
      if (!isRecycleBinPath(candidate)) return path.resolve(candidate);
    }
  }
  return fallback;
}
function bridgeTracking(bridge) {
  const volume = String(bridge?.volume || '');
  const fileId = String(bridge?.fileId || bridge?.file_id || '');
  return volume && fileId ? { volume, fileId } : null;
}
async function readVaultBridges() {
  try {
    const document = JSON.parse(await fs.promises.readFile(VAULT_BRIDGE_FILE, 'utf8'));
    return Array.isArray(document.vaults) ? document.vaults : [];
  } catch { return []; }
}
async function vaultBridgeForSource(source) {
  const bridges = await readVaultBridges();
  if (source?.vaultBridgeId) {
    const matched = bridges.find(item => String(item.id) === String(source.vaultBridgeId));
    if (matched) return matched;
  }
  const sourceTracking = source?.tracking;
  if (sourceTracking?.volume && sourceTracking?.fileId) {
    const matched = bridges.find(item => {
      const tracking = bridgeTracking(item);
      return tracking?.volume.toLowerCase() === String(sourceTracking.volume).toLowerCase() && tracking.fileId.toLowerCase() === String(sourceTracking.fileId).toLowerCase();
    });
    if (matched) return matched;
  }
  return bridges.find(item => normalizeFolder(item.folder) === normalizeFolder(source?.path)) || null;
}
function vaultFileUrl(bridge, fileId) {
  return `${bridge.endpoint}/v1/files/${encodeURIComponent(fileId)}/content?token=${encodeURIComponent(bridge.token)}`;
}
async function scanVaultDirectory(folder, bridge, source) {
  const response = await fetch(`${bridge.endpoint}/v1/files?token=${encodeURIComponent(bridge.token)}`);
  if (!response.ok) throw new Error('Vault is unavailable or Mosaic is not authorized');
  const document = await response.json();
  return (document.files || [])
    .filter(entry => MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => ({
      id: assetIdFor(source, entry.name),
      path: path.join(folder, entry.name),
      relativePath: entry.name.replace(/\\/g, '/'),
      name: path.basename(entry.name),
      type: imageExtensions.has(path.extname(entry.name).toLowerCase()) ? 'image' : 'video',
      modified: Number(entry.modified_ns || 0) / 1e6,
      vault: true,
      vaultFileId: entry.id,
      contentUrl: vaultFileUrl(bridge, entry.id)
    }))
    .sort((a, b) => b.modified - a.modified);
}
async function scanDirectory(folder, source) {
  // A folder in the Windows Recycle Bin is deleted content, not a renamed
  // source. Never walk it, even when its NTFS id is still queryable.
  if (!folder || isRecycleBinPath(folder)) return [];
  const results = [];
  const pendingDirectories = [folder];
  while (pendingDirectories.length) {
    const dir = pendingDirectories.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (isRecycleBinPath(fullPath)) continue;
      if (entry.isDirectory()) { pendingDirectories.push(fullPath); continue; }
      if (!entry.isFile() || !MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = await fs.promises.stat(fullPath);
        const relativePath = path.relative(folder, fullPath).replace(/\\/g, '/');
        results.push({ id: assetIdFor(source, relativePath), path: fullPath, relativePath, name: entry.name, type: imageExtensions.has(path.extname(entry.name).toLowerCase()) ? 'image' : 'video', modified: stat.mtimeMs });
      } catch { /* skipped */ }
    }
  }
  return results.sort((a, b) => b.modified - a.modified);
}
async function resolveSource(source) {
  const bridge = await vaultBridgeForSource(source);
  const tracking = bridgeTracking(bridge) || source?.tracking || null;
  const folder = await resolveTrackedFolder({ folder: bridge?.folder || source?.path, tracking });
  return { folder, tracking, vaultBridgeId: bridge?.id || source?.vaultBridgeId || null, vault: Boolean(bridge) };
}
async function scanSource(profile, source) {
  const normalized = typeof source === 'string' ? { path: source, id: normalizeFolder(source) } : source;
  if (!normalized?.path || isRecycleBinPath(normalized.path) || isInDeckDiscardPath(profile, normalized.path)) {
    return { folder: null, tracking: null, vaultBridgeId: null, vault: false, assets: [] };
  }
  const resolved = await resolveSource(normalized);
  if (!resolved.folder || isRecycleBinPath(resolved.folder) || isInDeckDiscardPath(profile, resolved.folder)) return { ...resolved, assets: [] };
  const tracking = resolved.tracking || await identifyFolder(resolved.folder);
  const bridge = resolved.vault ? await vaultBridgeForSource({ ...normalized, vaultBridgeId: resolved.vaultBridgeId, tracking }) : null;
  const assets = bridge ? await scanVaultDirectory(resolved.folder, bridge, normalized) : await scanDirectory(resolved.folder, normalized);
  const result = { folder: resolved.folder, tracking, vaultBridgeId: bridge?.id || resolved.vaultBridgeId, vault: Boolean(bridge), assets };
  await cacheSourceScan(profile, normalized, result);
  return result;
}

function removeLibraryAssetReferences(data, assetIds) {
  if (!assetIds.size) return false;
  let changed = false;
  for (const gallery of [...(data.collections || []), ...(data.discardedGalleries || [])]) {
    for (const field of ['items', 'discardedIds', 'manualItemIds', 'extensionItemIds']) {
      if (!Array.isArray(gallery[field])) continue;
      const next = gallery[field].map(String).filter(id => !assetIds.has(id));
      if (next.length !== gallery[field].length) { gallery[field] = next; changed = true; }
    }
    if (assetIds.has(String(gallery.coverId))) { delete gallery.coverId; changed = true; }
  }
  for (const group of data.libraryGroups || []) {
    if (!Array.isArray(group.assets)) continue;
    const next = group.assets.map(String).filter(id => !assetIds.has(id));
    if (next.length !== group.assets.length) { group.assets = next; changed = true; }
  }
  for (const id of assetIds) {
    if (data.assetMeta?.[id]) { delete data.assetMeta[id]; changed = true; }
  }
  return changed;
}

async function reconcileUnavailableSources(profile, data) {
  const missingSourceIds = new Set();
  const missingAssetIds = new Set();
  let changed = false;
  for (const source of data.sources || []) {
    const sourcePath = String(source.path || '');
    // Vault sources are remote; their availability is handled by the Vault
    // bridge rather than local filesystem checks.
    if (source.vaultBridgeId) continue;
    const sourceAvailable = sourcePath && !isRecycleBinPath(sourcePath) && !isInDeckDiscardPath(profile, sourcePath)
      && await fs.promises.stat(sourcePath).then(stat => stat.isDirectory()).catch(() => false);
    if (!sourceAvailable) {
      missingSourceIds.add(String(source.id));
      for (const asset of source.assets || []) missingAssetIds.add(String(asset.id));
      changed = true;
      continue;
    }
    const keptAssets = [];
    for (const asset of source.assets || []) {
      const assetPath = String(asset.path || '');
      const exists = assetPath && !isRecycleBinPath(assetPath) && !isInDeckDiscardPath(profile, assetPath)
        && await fs.promises.stat(assetPath).then(stat => stat.isFile()).catch(() => false);
      if (exists) keptAssets.push(asset);
      else { missingAssetIds.add(String(asset.id)); changed = true; }
    }
    if (keptAssets.length !== (source.assets || []).length) source.assets = keptAssets;
  }
  if (missingSourceIds.size) {
    data.sources = (data.sources || []).filter(source => !missingSourceIds.has(String(source.id)));
    data.librarySourceIds = (data.librarySourceIds || []).map(String).filter(id => !missingSourceIds.has(id));
    data.mainSourceIds = (data.mainSourceIds || []).map(String).filter(id => !missingSourceIds.has(id));
    for (const gallery of [...(data.collections || []), ...(data.discardedGalleries || [])]) {
      const before = gallery.sourceIds || [];
      gallery.sourceIds = before.map(String).filter(id => !missingSourceIds.has(id));
      if (gallery.sourceIds.length !== before.length) changed = true;
      if (gallery.defaultSourceId && missingSourceIds.has(String(gallery.defaultSourceId))) {
        delete gallery.defaultSourceId;
        delete gallery.defaultSourcePath;
        changed = true;
      }
    }
  }
  return removeLibraryAssetReferences(data, missingAssetIds) || changed;
}

function indeckMediaPath(profile) { return profileMediaPath(profile); }
async function ensureProfileLibraryFolders(profile) {
  profile = await trackProfileLibraryLocation(profile);
  const desiredPath = profileRecoveryMediaPath(profile);
  const exists = await fs.promises.stat(desiredPath).then(stat => stat.isDirectory()).catch(() => false);
  if (!exists) {
    await fs.promises.mkdir(desiredPath, { recursive: true });
    profile.mediaPath = desiredPath;
    profile.lastMediaPath = desiredPath;
    profile.mediaTracking = await identifyFolder(desiredPath);
    profile = await updateProfileInRegistry(profile);
  }
  await Promise.all([
    fs.promises.mkdir(indeckMediaPath(profile), { recursive: true }),
    fs.promises.mkdir(extensionImportsPath(profile), { recursive: true }),
    fs.promises.mkdir(discardsPath(profile), { recursive: true }),
  ]);
  return profile;
}
async function ensureProfileDefaultSaveSource(profile, data) {
  const folder = extensionImportsPath(profile);
  data.sources ||= [];
  let source = data.sources.find(item => String(item.id) === WEB_IMPORTS_SOURCE_ID)
    || data.sources.find(item => normalizedPath(item.path) === normalizedPath(folder));
  let changed = false;
  if (!source) {
    source = { id: WEB_IMPORTS_SOURCE_ID, name: 'DefaultSave', path: folder, assets: [] };
    data.sources.push(source);
    changed = true;
  }
  if (source.path !== folder) { source.path = folder; changed = true; }
  if (source.name !== 'DefaultSave') { source.name = 'DefaultSave'; changed = true; }
  const scanned = await scanDirectoryKeepingKnownIds(folder, source);
  if (JSON.stringify(source.assets || []) !== JSON.stringify(scanned)) { source.assets = scanned; changed = true; }
  return changed;
}
async function ensureProfileMainLibrarySource(profile, data) {
  const root = indeckMediaPath(profile);
  data.sources ||= [];
  // Main Gallery is the All Media view in the current UI. Register the
  // profile's InDeckMedia root as its managed source so every file placed in
  // the Library is visible there immediately, including first-run profiles.
  let source = data.sources.find(item => String(item.id) === PROFILE_MAIN_LIBRARY_SOURCE_ID)
    || data.sources.find(item => normalizedPath(item.path) === normalizedPath(root));
  let changed = false;
  if (!source) {
    source = { id: PROFILE_MAIN_LIBRARY_SOURCE_ID, name: 'InDeckMedia', path: root, assets: [] };
    data.sources.push(source);
    changed = true;
  }
  if (source.path !== root) { source.path = root; changed = true; }
  if (!source.name) { source.name = 'InDeckMedia'; changed = true; }
  const managedChildFolders = [
    extensionImportsPath(profile),
    // Discards is InDeck's trash. It must never be surfaced through the root
    // Main Gallery source after a Gallery/source has been removed.
    discardsPath(profile),
    ...(data.collections || []).map(gallery => gallery.defaultSourcePath).filter(Boolean),
    ...data.sources.filter(item => item !== source).map(item => item.path).filter(folder => folder && isPathInside(root, folder)),
  ];
  // The root source owns user-managed media. InDeck-managed child sources
  // remain represented by their own source, preventing duplicate cards in
  // Main Gallery when DefaultSave or a Gallery Default Source is populated.
  const scanned = (await scanDirectoryKeepingKnownIds(root, source)).filter(asset =>
    !managedChildFolders.some(folder => normalizedPath(folder) !== normalizedPath(root) && isPathInside(folder, asset.path)),
  );
  if (JSON.stringify(source.assets || []) !== JSON.stringify(scanned)) { source.assets = scanned; changed = true; }
  data.librarySourceIds ||= [];
  if (!data.librarySourceIds.includes(source.id)) { data.librarySourceIds.push(source.id); changed = true; }
  return changed;
}
function extensionImportsPath(profile) { return path.join(indeckMediaPath(profile), 'DefaultSave'); }
function previousExtensionImportsPath(profile) { return path.join(indeckMediaPath(profile), 'Extension', 'Default Save'); }
function discardsPath(profile) { return path.join(indeckMediaPath(profile), 'Discards'); }
const DISCARDS_SOURCE_ID = 'indeck-discards';
function isInDeckDiscardPath(profile, value) {
  const candidate = String(value || '').trim();
  return Boolean(candidate) && (
    normalizedPath(candidate) === normalizedPath(discardsPath(profile))
    || isPathInside(discardsPath(profile), candidate)
  );
}
function legacyExtensionImportsPath(profile) { return path.join(profileMediaPath(profile) === legacyProfile().mediaPath ? app.getPath('pictures') : indeckMediaPath(profile), 'AllSight Web Imports'); }
function normalizedPath(value) { return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase(); }
function safeFolderPart(value) {
  const clean = String(value || 'Untitled Gallery').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim();
  return clean.slice(0, 100) || 'Untitled Gallery';
}
function galleryDefaultSourceId(galleryId) { return `indeck-gallery-default:${String(galleryId)}`; }
function galleryDefaultSourcePathWithSuffix(profile, galleryName, index) {
  const base = `${safeFolderPart(galleryName)} Default Source`;
  return path.join(indeckMediaPath(profile), index > 0 ? `${base} ${index}` : base);
}
async function availableGalleryDefaultSourcePath(profile, data, gallery, currentPath = null) {
  const sourceId = String(gallery.defaultSourceId || galleryDefaultSourceId(gallery.id));
  const knownSources = data.sources || [];
  for (let index = 0; index < 10000; index += 1) {
    const candidate = galleryDefaultSourcePathWithSuffix(profile, gallery.name, index);
    const candidateKey = normalizedPath(candidate);
    const assigned = knownSources.find(source => normalizedPath(source.path) === candidateKey);
    // A path already assigned to this same Gallery source is its stable home.
    if (assigned && String(assigned.id) === sourceId) return candidate;
    // Never take a directory already assigned to another source, even where
    // the Gallery display names happen to be identical.
    if (assigned) continue;
    if (currentPath && normalizedPath(currentPath) === candidateKey) return candidate;
    const exists = await fs.promises.stat(candidate).then(stat => stat.isDirectory()).catch(() => false);
    // An unknown existing folder is also left untouched; choose the next
    // suffix instead of accidentally merging files from another library.
    if (!exists) return candidate;
  }
  throw new Error('Could not allocate a unique Gallery Default Source folder');
}
async function moveDirectoryIfNeeded(from, to) {
  if (normalizedPath(from) === normalizedPath(to)) return false;
  const exists = await fs.promises.stat(from).then(stat => stat.isDirectory()).catch(() => false);
  if (!exists) return false;
  const destinationExists = await fs.promises.access(to).then(() => true).catch(() => false);
  if (destinationExists) return false;
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rename(from, to);
  return true;
}
async function mergeDirectoryInto(from, to) {
  if (normalizedPath(from) === normalizedPath(to)) return false;
  const exists = await fs.promises.stat(from).then(stat => stat.isDirectory()).catch(() => false);
  if (!exists) return false;
  await fs.promises.mkdir(to, { recursive: true });
  const entries = await fs.promises.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const parsed = path.parse(entry.name);
    let destination = path.join(to, entry.name);
    for (let index = 1; await fs.promises.access(destination).then(() => true).catch(() => false); index += 1) {
      destination = path.join(to, `${parsed.name} ${index}${parsed.ext}`);
    }
    await fs.promises.rename(path.join(from, entry.name), destination);
  }
  await fs.promises.rmdir(from);
  return true;
}
function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
async function uniqueDiscardFilePath(profile, name, reserved) {
  const parsed = path.parse(name);
  const cleanBase = safeFolderPart(parsed.name).slice(0, 160) || 'media';
  const extension = parsed.ext || '';
  for (let index = 0; index < 10000; index += 1) {
    const target = path.join(discardsPath(profile), index ? `${cleanBase} ${index}${extension}` : `${cleanBase}${extension}`);
    const key = normalizedPath(target);
    if (reserved.has(key)) continue;
    const exists = await fs.promises.access(target).then(() => true).catch(() => false);
    if (!exists) { reserved.add(key); return target; }
  }
  throw new Error('Could not allocate a unique discarded file name');
}
async function moveFileSafely(from, to) {
  try { await fs.promises.rename(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}
async function discardGalleryDefaultSource(profile, { sourceId, sourcePath }) {
  const folder = path.resolve(String(sourcePath || ''));
  if (!String(sourceId || '').startsWith('indeck-gallery-default:') || !isPathInside(indeckMediaPath(profile), folder)) {
    throw new Error('Only a Gallery Default Source inside InDeckMedia can be discarded');
  }
  const exists = await fs.promises.stat(folder).then(stat => stat.isDirectory()).catch(() => false);
  if (!exists) return { source: { id: DISCARDS_SOURCE_ID, name: 'Discards', path: discardsPath(profile) }, moved: [] };
  await fs.promises.mkdir(discardsPath(profile), { recursive: true });
  const assets = await scanDirectory(folder, { id: sourceId, path: folder });
  const reserved = new Set();
  const moved = [];
  for (const asset of assets) {
    const target = await uniqueDiscardFilePath(profile, path.basename(asset.path), reserved);
    await moveFileSafely(asset.path, target);
    moved.push({ from: asset.path, to: target });
  }
  // This folder is InDeck-managed and all media has moved successfully. Any
  // remaining non-media sidecars are intentionally removed with the source.
  await fs.promises.rm(folder, { recursive: true, force: true });
  return { source: { id: DISCARDS_SOURCE_ID, name: 'Discards', path: discardsPath(profile) }, moved };
}
async function migrateInDeckMedia(profile, data) {
  const legacy = legacyExtensionImportsPath(profile);
  const previous = previousExtensionImportsPath(profile);
  const target = extensionImportsPath(profile);
  let moved = false;
  for (const from of [previous, legacy]) {
    const targetExists = await fs.promises.stat(target).then(stat => stat.isDirectory()).catch(() => false);
    moved = (targetExists ? await mergeDirectoryInto(from, target) : await moveDirectoryIfNeeded(from, target)) || moved;
  }
  await Promise.all([
    fs.promises.mkdir(target, { recursive: true }),
    fs.promises.mkdir(discardsPath(profile), { recursive: true }),
  ]);
  let changed = moved;
  for (const source of data.sources || []) {
    const oldSourcePath = source.path;
    if (![legacy, previous, target].some(folder => normalizedPath(oldSourcePath) === normalizedPath(folder))) continue;
    source.path = target;
    source.name = 'DefaultSave';
    source.assets = (source.assets || []).map(asset => ({
      ...asset,
      path: path.join(target, path.relative(oldSourcePath, asset.path || path.basename(asset.name || ''))),
    }));
    changed = true;
  }
  // The old Extension container is no longer part of the library layout.
  await fs.promises.rmdir(path.dirname(previous)).catch(() => {});
  return changed;
}
async function ensureGalleryDefaultSource(profile, data, gallery, preferredPath) {
  profile = await ensureProfileLibraryFolders(profile);
  const id = String(gallery.defaultSourceId || galleryDefaultSourceId(gallery.id));
  const existing = (data.sources || []).find(source => String(source.id) === id);
  const current = existing?.path || gallery.defaultSourcePath;
  // Recovery recreates a missing managed folder at its recorded location. Do
  // not silently move a Gallery that already has a valid/default path.
  const target = preferredPath || current || await availableGalleryDefaultSourcePath(profile, data, gallery, current);
  if (current && normalizedPath(current) !== normalizedPath(target)) await moveDirectoryIfNeeded(current, target);
  await fs.promises.mkdir(target, { recursive: true });
  const source = existing || { id, name: 'Default Source', path: target, assets: [] };
  source.id = id;
  source.name = 'Default Source';
  source.path = target;
  source.assets = await scanDirectoryKeepingKnownIds(target, source);
  if (!existing) data.sources = [...(data.sources || []), source];
  gallery.defaultSourceId = id;
  gallery.defaultSourcePath = target;
  gallery.sourceIds = [...new Set([...(gallery.sourceIds || []).map(String), id])];
  gallery.items ||= [];
  const discarded = new Set((gallery.discardedIds || []).map(String));
  for (const asset of source.assets) if (!discarded.has(String(asset.id)) && !gallery.items.includes(asset.id)) gallery.items.push(asset.id);
  return source;
}
async function disconnectMissingGalleryDefaultSources(data) {
  let changed = false;
  for (const gallery of data.collections || []) {
    const sourceId = gallery.defaultSourceId ? String(gallery.defaultSourceId) : null;
    if (!sourceId) continue;
    const source = (data.sources || []).find(item => String(item.id) === sourceId);
    const sourcePath = source?.path || gallery.defaultSourcePath;
    const exists = sourcePath && await fs.promises.stat(sourcePath).then(stat => stat.isDirectory()).catch(() => false);
    if (exists) continue;

    // A manually deleted Default Source is a real disconnect. Do not recreate
    // it at startup; an explicit Extension save may create and reconnect it.
    const assetIds = new Set((source?.assets || []).map(asset => String(asset.id)));
    data.sources = (data.sources || []).filter(item => String(item.id) !== sourceId);
    gallery.sourceIds = (gallery.sourceIds || []).map(String).filter(id => id !== sourceId);
    for (const field of ['items', 'discardedIds', 'manualItemIds', 'extensionItemIds']) {
      if (Array.isArray(gallery[field])) gallery[field] = gallery[field].map(String).filter(id => !assetIds.has(id));
    }
    if (assetIds.has(String(gallery.coverId))) delete gallery.coverId;
    delete gallery.defaultSourceId;
    delete gallery.defaultSourcePath;
    for (const assetId of assetIds) delete data.assetMeta?.[assetId];
    changed = true;
  }
  return changed;
}
async function scanDirectoryKeepingKnownIds(folder, source) {
  const previousIds = new Map((source?.assets || []).map(asset => [normalizedPath(asset.path), asset.id]));
  const scanned = await scanDirectory(folder, source);
  return scanned.map(asset => ({ ...asset, id: previousIds.get(normalizedPath(asset.path)) || asset.id }));
}
function isExtensionImportSource(profile, source) {
  if (!source) return false;
  return String(source.id) === WEB_IMPORTS_SOURCE_ID
    || normalizedPath(source.path) === normalizedPath(extensionImportsPath(profile))
    || normalizedPath(source.path) === normalizedPath(previousExtensionImportsPath(profile))
    || normalizedPath(source.path) === normalizedPath(legacyExtensionImportsPath(profile))
    || /(?:allsight|indeck)\s+web\s+(?:imports?|extention)/i.test(String(source.name || ''));
}
/**
 * Older builds accidentally allowed the extension import folder to be attached
 * as a Gallery Media Source. That made every file in the folder appear in that
 * Gallery. Keep only the explicit per-slot imports and remove that source
 * relationship once during startup/import.
 */
function sanitizeExtensionGalleryMembership(profile, data) {
  const extensionSources = (data.sources || []).filter(source => isExtensionImportSource(profile, source));
  const extensionSourceIds = new Set(extensionSources.map(source => String(source.id)));
  const extensionAssetIds = new Set(extensionSources.flatMap(source => (source.assets || []).map(asset => String(asset.id))));
  let changed = false;
  for (const gallery of data.collections || []) {
    const sourceIds = (gallery.sourceIds || []).map(String);
    const keptSourceIds = sourceIds.filter(id => !extensionSourceIds.has(id));
    if (keptSourceIds.length !== sourceIds.length) { gallery.sourceIds = keptSourceIds; changed = true; }
    const extensionItemIds = (gallery.extensionItemIds || []).map(String).filter(id => extensionAssetIds.has(id));
    if (extensionItemIds.length !== (gallery.extensionItemIds || []).length) { gallery.extensionItemIds = extensionItemIds; changed = true; }
    const explicit = new Set([...extensionItemIds, ...(gallery.manualItemIds || [])].map(String));
    for (const field of ['items', 'discardedIds']) {
      const current = (gallery[field] || []).map(String);
      const kept = current.filter(id => !extensionAssetIds.has(id) || explicit.has(id));
      if (kept.length !== current.length) { gallery[field] = kept; changed = true; }
    }
  }
  return changed;
}
function isMediaLocationSyncCandidate(profile, assetPath, targetFolder) {
  const sourceParent = normalizedPath(path.dirname(targetFolder));
  const assetFolder = normalizedPath(path.dirname(assetPath));
  return assetFolder === sourceParent || assetFolder === normalizedPath(extensionImportsPath(profile));
}
async function syncMediaLocations(profile, entries) {
  const data = await readStore(profile);
  const sources = data.sources || [];
  const moved = [], skipped = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const source = sources.find(item => item.id === entry?.targetSourceId);
    const assetPath = path.resolve(String(entry?.assetPath || ''));
    if (!source || !entry?.assetId || !assetPath || !isMediaLocationSyncCandidate(profile, assetPath, source.path)) { skipped.push({ assetId: entry?.assetId, reason: 'not-eligible' }); continue; }
    const targetPath = path.join(source.path, path.basename(assetPath));
    if (normalizedPath(assetPath) === normalizedPath(targetPath)) { skipped.push({ assetId: entry.assetId, reason: 'already-in-source' }); continue; }
    try {
      const [assetInfo, targetInfo, targetExists] = await Promise.all([fs.promises.stat(assetPath), fs.promises.stat(source.path), fs.promises.access(targetPath).then(() => true).catch(() => false)]);
      if (!assetInfo.isFile() || !targetInfo.isDirectory()) { skipped.push({ assetId: entry.assetId, reason: 'invalid-path' }); continue; }
      if (targetExists) { skipped.push({ assetId: entry.assetId, reason: 'target-exists' }); continue; }
      try { await fs.promises.rename(assetPath, targetPath); }
      catch (error) { if (error.code !== 'EXDEV') throw error; await fs.promises.copyFile(assetPath, targetPath); await fs.promises.unlink(assetPath); }
      moved.push({ assetId: entry.assetId, from: assetPath, to: targetPath });
    } catch (error) { skipped.push({ assetId: entry.assetId, reason: error.code || 'move-failed' }); }
  }
  return { moved, skipped };
}
function broadcast(profileId, channel, value) {
  const window = profileWindows.get(String(profileId));
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}
function safeImportName(value) {
  const clean = String(value || '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return clean.slice(0, 90) || `web-image-${Date.now()}`;
}
function extensionFor(contentType, sourceUrl) {
  const byType = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp' };
  if (byType[String(contentType || '').split(';')[0].toLowerCase()]) return byType[String(contentType).split(';')[0].toLowerCase()];
  const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
  return imageExtensions.has(extension) ? extension : '.jpg';
}
function extensionGalleryConfig(profile, data) {
  const galleries = (data.collections || [])
    .map(gallery => ({ id: String(gallery.id), name: String(gallery.name || 'Untitled Gallery') }));
  const allowed = new Set(galleries.map(gallery => gallery.id));
  const seen = new Set();
  const slots = Array.from({ length: 4 }, (_, index) => {
    const id = data.extensionGallerySlots?.[index] == null ? null : String(data.extensionGallerySlots[index]);
    if (!id || !allowed.has(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
  return {
    defaultFolder: { name: 'DefaultSave', path: extensionImportsPath(profile) },
    galleries,
    slots: slots.map(id => id ? galleries.find(gallery => gallery.id === id) : null)
  };
}
function setExtensionGallerySlots(profile, data, galleryIds) {
  const allowed = new Set((data.collections || []).map(gallery => String(gallery.id)));
  const seen = new Set();
  data.extensionGallerySlots = Array.from({ length: 4 }, (_, index) => {
    const raw = Array.isArray(galleryIds) ? galleryIds[index] : null;
    const id = raw == null ? null : String(raw);
    if (!id || !allowed.has(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
  return extensionGalleryConfig(profile, data);
}
async function importWebImage(profile, sourceUrl, galleryId = null) {
  profile = await ensureProfileLibraryFolders(profile);
  let url;
  try { url = new URL(sourceUrl); } catch { throw new Error('Invalid image URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web image URLs are supported');
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mosaic Web Importer' } });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw new Error('The dropped item is not an image');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 80 * 1024 * 1024) throw new Error('Image is empty or too large');
  const data = await readStore(profile);
  // A target Gallery receives web imports in its own managed Default Source.
  // The extension-wide Default Save is only used when no Gallery slot was
  // chosen. This prevents one Gallery source from receiving every import.
  const gallery = galleryId && (data.collections || []).find(item => String(item.id) === String(galleryId));
  const gallerySource = gallery ? await ensureGalleryDefaultSource(profile, data, gallery) : null;
  const directory = gallerySource?.path || extensionImportsPath(profile);
  await fs.promises.mkdir(directory, { recursive: true });
  const base = safeImportName(path.basename(url.pathname, path.extname(url.pathname)));
  const target = path.join(directory, `${base}-${Date.now()}${extensionFor(contentType, url.href)}`);
  await fs.promises.writeFile(target, bytes);
  // Never tell the extension that an import succeeded until the bytes are
  // observable on disk. This also catches a vanished/recycled Library root
  // between directory creation and the actual write.
  const savedFile = await fs.promises.stat(target).catch(() => null);
  if (!savedFile?.isFile() || savedFile.size !== bytes.length) {
    throw new Error('The image could not be confirmed in the Library');
  }
  // Reuse the Gallery default source when a slot is selected. Otherwise use
  // the standalone Default Save source shared by the extension.
  let source = gallerySource || data.sources?.find(item => isExtensionImportSource(profile, item));
  if (!source) {
    source = { id: WEB_IMPORTS_SOURCE_ID, path: directory, name: 'DefaultSave', assets: [] };
    data.sources = [...(data.sources || []), source];
  }
  source.name = gallerySource ? 'Default Source' : 'DefaultSave';
  source.path = directory;
  source.assets = await scanDirectoryKeepingKnownIds(directory, source);
  const asset = source.assets.find(item => normalizedPath(item.path) === normalizedPath(target));
  // A locked Gallery is still a valid extension target. Locking controls
  // viewing, not whether an explicitly configured import target receives its
  // file. The media stays hidden until that Gallery is unlocked.
  if (gallery && asset) {
    gallery.items ||= [];
    gallery.manualItemIds ||= [];
    gallery.extensionItemIds ||= [];
    gallery.discardedIds ||= [];
    if (!gallery.items.includes(asset.id)) {
      if (gallery.itemOrder === 'newest-first') gallery.items.unshift(asset.id);
      else gallery.items.push(asset.id);
    }
    // The first image ever added is the default cover until the user chooses
    // a different one from the Gallery UI.
    if (!gallery.coverId) gallery.coverId = gallery.items[0] ?? asset.id;
    // Keep this explicit membership as a durable record of the import. The
    // source itself is also attached, so a later scan remains correct.
    if (!gallery.manualItemIds.includes(asset.id)) gallery.manualItemIds.push(asset.id);
    if (!gallery.extensionItemIds.includes(asset.id)) gallery.extensionItemIds.push(asset.id);
    gallery.discardedIds = gallery.discardedIds.filter(id => id !== asset.id);
    data.assetMeta ||= {};
    const meta = (data.assetMeta[asset.id] ||= {});
    meta.tags ||= [];
    meta.persons ||= [];
    (gallery.defaultTags || []).forEach(tag => { if (!meta.tags.includes(tag)) meta.tags.push(tag); });
    (gallery.defaultPersons || []).forEach(tag => { if (!meta.persons.includes(tag)) meta.persons.push(tag); });
    for (const [groupId, values] of Object.entries(gallery.autoTagGroups || {})) {
      meta.tagGroups ||= {};
      meta.tagGroups[groupId] ||= [];
      values.forEach(value => { if (!meta.tagGroups[groupId].includes(value)) meta.tagGroups[groupId].push(value); });
    }
  }
  await writeStore(profile, data);
  broadcast(profile.id, 'media:imported', { asset, sourceId: source.id, galleryId: gallery?.id || null });
  return { asset, galleryId: gallery?.id || null, saved: true };
}
function nativeHostManifestPath() { return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'InDeck', 'native-messaging', `${NATIVE_HOST_NAME}.json`); }
function nativeHostLauncherPath() { return path.join(path.dirname(nativeHostManifestPath()), `${NATIVE_HOST_NAME}.cmd`); }
async function nativeHostExecutablePath() {
  if (app.isPackaged) return app.getPath('exe');
  const hostScript = path.join(__dirname, 'extension', 'native-host.js');
  if (!fs.existsSync(hostScript)) throw new Error('Native messaging worker was not found');
  // Electron's GUI runtime does not expose Chrome's binary stdin reliably in
  // a source checkout. A small Node worker keeps this protocol headless.
  const launcher = nativeHostLauncherPath();
  const content = `@echo off\r\nnode.exe "${hostScript}" %*\r\n`;
  await fs.promises.mkdir(path.dirname(launcher), { recursive: true });
  await fs.promises.writeFile(launcher, content, 'utf8');
  return launcher;
}
async function registerNativeMessagingHost() {
  const manifestPath = nativeHostManifestPath();
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Mosaic profile-aware media importer',
    path: await nativeHostExecutablePath(),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  const result = await runFileCommand('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
  if (result.error) throw new Error('Could not register the Chrome native messaging host');
  return { installed: true, manifestPath };
}
function writeNativeMessage(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}
async function handleNativeMessage(message) {
  const type = String(message?.type || '');
  if (type === 'profiles:list') {
    const registry = await readProfileRegistry();
    return { ok: true, profiles: registry.profiles.filter(isProfileReady).map(profile => ({ id: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault) })) };
  }
  if (type === 'profile:config') {
    let profile = await profileById(message.profileId);
    if (!profile) throw new Error('The selected profile no longer exists');
    if (!isProfileReady(profile)) throw new Error('Finish Default Library Location setup before using this profile in the extension');
    profile = await ensureProfileLibraryFolders(profile);
    return { ok: true, profile: { id: profile.id, name: profile.name }, ...extensionGalleryConfig(profile, await readStore(profile)) };
  }
  if (type === 'profile:slots') {
    let profile = await profileById(message.profileId);
    if (!profile) throw new Error('The selected profile no longer exists');
    if (!isProfileReady(profile)) throw new Error('Finish Default Library Location setup before using this profile in the extension');
    profile = await ensureProfileLibraryFolders(profile);
    const data = await readStore(profile);
    const config = setExtensionGallerySlots(profile, data, message.galleryIds);
    await writeStore(profile, data);
    return { ok: true, profile: { id: profile.id, name: profile.name }, ...config };
  }
  if (type === 'media:import') {
    let profile = await profileById(message.profileId);
    if (!profile) throw new Error('The selected profile no longer exists');
    if (!isProfileReady(profile)) throw new Error('Finish Default Library Location setup before using this profile in the extension');
    // Native Messaging may receive an import while the desktop window is
    // closed. Recover the selected profile's Library graph before writing so
    // a deleted InDeckMedia root cannot turn into a false success response.
    profile = (await recoverProfileLibrary(profile)).profile;
    const imported = await importWebImage(profile, message.url, message.galleryId);
    return { ok: true, saved: imported.saved === true, asset: { id: imported.asset.id, name: imported.asset.name }, profileId: profile.id, galleryId: imported.galleryId };
  }
  throw new Error('Unsupported native message');
}
function finishNativeInput() {
  if (!nativeHostInputEnded || nativeHostInput.length) return;
  nativeHostHandling.finally(() => { if (nativeHostKeepAlive) clearInterval(nativeHostKeepAlive); app.quit(); });
}
function processNativeInput() {
  while (nativeHostInput.length >= 4) {
    const length = nativeHostInput.readUInt32LE(0);
    if (length > 1024 * 1024) { writeNativeMessage({ ok: false, error: 'Request too large' }); app.quit(); return; }
    if (nativeHostInput.length < length + 4) return;
    const raw = nativeHostInput.subarray(4, length + 4);
    nativeHostInput = nativeHostInput.subarray(length + 4);
    nativeHostHandling = nativeHostHandling.then(async () => {
      try { writeNativeMessage(await handleNativeMessage(JSON.parse(raw.toString('utf8')))); }
      catch (error) { writeNativeMessage({ ok: false, error: error.message || 'Import failed' }); }
    });
  }
  finishNativeInput();
}
function startNativeMessagingHost() {
  const origin = process.argv.find(argument => String(argument).startsWith('chrome-extension://'));
  if (origin !== `chrome-extension://${EXTENSION_ID}/`) {
    writeNativeMessage({ ok: false, error: 'Unauthorized extension' });
    if (nativeHostKeepAlive) clearInterval(nativeHostKeepAlive);
    app.quit();
    return;
  }
  // Electron exits an app that has no windows even while stdin is open. Keep a
  // deliberately invisible host window only for the duration of this native
  // request; it is never loaded or shown to the user.
  nativeHostWindow = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  nativeHostStarted = true;
  processNativeInput();
}
function stopFolderWatchers(profileId = null) {
  const targets = profileId == null ? [...profileWatchers.entries()] : [[String(profileId), profileWatchers.get(String(profileId))]];
  targets.forEach(([id, watchers]) => {
    if (!watchers) return;
    watchers.forEach(({ watcher, timer }) => {
      clearTimeout(timer);
      watcher.close();
    });
    profileWatchers.delete(id);
  });
}
function watchFolders(profile, webContents, folders) {
  const key = String(profile.id);
  stopFolderWatchers(key);
  const watchers = new Map();
  [...new Set(folders.filter(folder => folder && !isRecycleBinPath(folder) && !isInDeckDiscardPath(profile, folder)))].forEach(folder => {
    try {
      const record = { watcher: null, timer: null };
      record.watcher = fs.watch(folder, { recursive: true }, () => {
        // File managers commonly emit several events for one copy/move operation.
        clearTimeout(record.timer);
        record.timer = setTimeout(() => {
          if (!webContents.isDestroyed()) webContents.send('folder:changed', folder);
        }, 450);
      });
      record.watcher.on('error', () => { /* Folder may have been disconnected or removed. */ });
      watchers.set(folder, record);
    } catch { /* An unavailable source folder is handled by the next scan. */ }
  });
  profileWatchers.set(key, watchers);
}

function rendererEntry() {
  // The React/Lovable UI ships with the desktop app instead of living in a
  // separate Downloads folder.  INDECK_UI_DIR remains an explicit development
  // override only.
  const defaultUiDirectory = path.join(__dirname, 'ui', 'dist');
  const uiDirectory = String(process.env.INDECK_UI_DIR || defaultUiDirectory).trim();
  const candidate = uiDirectory && path.resolve(uiDirectory, 'index.html');
  return candidate && fs.existsSync(candidate) ? candidate : path.join(__dirname, 'index.html');
}
function focusWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
async function createWindow(profileId = null) {
  let profile = profileId ? await profileById(profileId) : await defaultProfile();
  if (!profile) throw new Error('Profile not found');
  if (isProfileReady(profile)) profile = await trackProfileLibraryLocation(profile);
  const existing = profileWindows.get(profile.id);
  if (existing && !existing.isDestroyed()) { focusWindow(existing); return existing; }
  const window = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1050, minHeight: 700,
    title: `Mosaic — ${profile.name}`, titleBarStyle: 'hidden', backgroundColor: '#111217',
    icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  // BrowserWindow.webContents is destroyed before the `closed` event runs.
  // Keep the stable id now so the cleanup handler never touches a destroyed
  // Electron object when the custom Close button is used.
  const webContentsId = window.webContents.id;
  window.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    console.error('[InDeck renderer load failed]', errorCode, errorDescription, validatedURL);
  });
  window.webContents.on('console-message', (_, level, message, line, sourceId) => {
    if (level >= 2) console.error('[InDeck renderer]', message, `${sourceId}:${line}`);
  });
  window.webContents.on('render-process-gone', (_, details) => {
    console.error('[InDeck renderer process gone]', details.reason, details.exitCode);
  });
  window.on('closed', () => {
    webContentsProfileIds.delete(webContentsId);
    if (profileWindows.get(profile.id) === window) {
      profileWindows.delete(profile.id);
      stopFolderWatchers(profile.id);
    }
  });
  profileWindows.set(profile.id, window);
  webContentsProfileIds.set(webContentsId, profile.id);
  window.loadFile(rendererEntry());
  return window;
}

app.whenReady().then(async () => {
  if (NATIVE_HOST_REGISTRATION_MODE) {
    try {
      const registration = await registerNativeMessagingHost();
      console.log(`Native messaging host registered: ${registration.manifestPath}`);
    } catch (error) {
      console.error('Could not register native messaging host:', error.message);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
    return;
  }
  if (NATIVE_MESSAGING_MODE) {
    startNativeMessagingHost();
    return;
  }
  let currentDefaultProfile = await defaultProfile();
  if (isProfileReady(currentDefaultProfile)) {
    currentDefaultProfile = await trackProfileLibraryLocation(currentDefaultProfile);
    const library = await readStore(currentDefaultProfile);
    const migrated = await migrateInDeckMedia(currentDefaultProfile, library);
    const sanitized = sanitizeExtensionGalleryMembership(currentDefaultProfile, library);
    const prunedUnavailable = await reconcileUnavailableSources(currentDefaultProfile, library);
    const disconnectedDefaults = await disconnectMissingGalleryDefaultSources(library);
    if (migrated || sanitized || prunedUnavailable || disconnectedDefaults) await writeStore(currentDefaultProfile, library);
  }
  registerNativeMessagingHost().catch(error => console.error('Could not register native messaging host:', error.message));
  async function readReconciledStore(profile) {
    const data = await readStore(profile);
    // DefaultSave is the permanent Main Gallery destination for extension
    // imports. Re-index it on every renderer snapshot so a file that has
    // already reached the folder cannot be invisible just because an older
    // state write omitted its source record.
    const defaultSaveChanged = await ensureProfileDefaultSaveSource(profile, data);
    const prunedUnavailable = await reconcileUnavailableSources(profile, data);
    const disconnectedDefaults = await disconnectMissingGalleryDefaultSources(data);
    if (defaultSaveChanged || prunedUnavailable || disconnectedDefaults) await writeStore(profile, data);
    return data;
  }
  ipcMain.handle('store:read', async event => readReconciledStore(await profileForWebContents(event.sender)));
  ipcMain.handle('store:write', async (event, value) => {
    const profile = await profileForWebContents(event.sender);
    const data = value && typeof value === 'object' ? value : {};
    // A renderer may hold an old snapshot while a file/source is deleted.
    // Reconcile before every write so stale UI state can never resurrect it.
    await reconcileUnavailableSources(profile, data);
    await disconnectMissingGalleryDefaultSources(data);
    return writeStore(profile, data);
  });
  // New renderers consume a versioned snapshot instead of treating browser
  // storage as a library. Keep store:* temporarily for the legacy renderer.
  ipcMain.handle('library:snapshot', async event => {
    const profile = await profileForWebContents(event.sender);
    return { version: 1, library: await readReconciledStore(profile) };
  });
  ipcMain.handle('profiles:list', async () => (await readProfileRegistry()).profiles.map(profile => ({ id: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault), initialized: isProfileReady(profile), mediaPath: profile.mediaPath || null, lastMediaPath: profile.lastMediaPath || null })));
  ipcMain.handle('profiles:discarded-list', async () => (await readProfileRegistry()).discardedProfiles.map(profile => ({ id: profile.id, name: profile.name, initialized: isProfileReady(profile), mediaPath: profile.mediaPath || null, discardedAt: profile.discardedAt || null })));
  ipcMain.handle('profiles:current', async event => {
    const profile = await profileForWebContents(event.sender);
    return { id: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault), initialized: isProfileReady(profile), mediaPath: profile.mediaPath || null, lastMediaPath: profile.lastMediaPath || null };
  });
  ipcMain.handle('profiles:create', async (_, name) => {
    const profile = await createProfile(name);
    return { id: profile.id, name: profile.name, isDefault: false, initialized: false };
  });
  ipcMain.handle('profiles:rename', async (_, profileId, name) => {
    const profile = await renameProfile(profileId, name);
    const window = profileWindows.get(profile.id);
    if (window && !window.isDestroyed()) window.setTitle(`Mosaic — ${profile.name}`);
    return { id: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault), initialized: isProfileReady(profile) };
  });
  ipcMain.handle('profiles:set-default', async (_, profileId) => {
    const profile = await setDefaultProfile(profileId);
    return { id: profile.id, name: profile.name, isDefault: true, initialized: isProfileReady(profile) };
  });
  ipcMain.handle('profiles:delete', async (_, profileId, typedName, replacementDefaultId) => {
    const profile = await deleteProfile(profileId, typedName, replacementDefaultId);
    return { id: profile.id };
  });
  ipcMain.handle('profiles:recover', async (_, profileId) => recoverDiscardedProfile(profileId));
  ipcMain.handle('profiles:library-location-status', async (_, profileId, folder) => libraryLocationStatus(profileId, folder));
  ipcMain.handle('profiles:configure-library', async (_, profileId, folder, useExisting) => configureProfileLibrary(profileId, folder, Boolean(useExisting)));
  ipcMain.handle('profiles:recover-library', async (_, profileId) => {
    const profile = await profileById(profileId);
    if (!profile) throw new Error('Profile not found');
    return recoverProfileLibrary(profile);
  });
  ipcMain.handle('profiles:open', async (_, profileId) => {
    const window = await createWindow(profileId);
    return { id: String(profileId), focused: !window.isDestroyed() };
  });
  ipcMain.handle('profiles:create-shortcut', async (_, profileId) => createProfileShortcut(profileId));
  ipcMain.handle('window:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle('window:is-maximized', event => Boolean(BrowserWindow.fromWebContents(event.sender)?.isMaximized()));
  ipcMain.handle('window:toggle-maximize', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('window:close', event => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle('folders:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('gallery:default-source:ensure', async (event, payload = {}) => {
    let profile = await profileForWebContents(event.sender);
    profile = await ensureProfileLibraryFolders(profile);
    const galleryId = String(payload.galleryId || '');
    const galleryName = String(payload.galleryName || 'Untitled Gallery');
    if (!galleryId) throw new Error('Gallery id is required');
    const data = await readStore(profile);
    const stored = (data.collections || []).find(gallery => String(gallery.id) === galleryId);
    const previousPath = payload.previousPath ? String(payload.previousPath) : null;
    const gallery = {
      id: galleryId,
      name: galleryName,
      defaultSourceId: stored?.defaultSourceId || galleryDefaultSourceId(galleryId),
      defaultSourcePath: previousPath || stored?.defaultSourcePath,
    };
    const target = await availableGalleryDefaultSourcePath(profile, data, gallery, previousPath || stored?.defaultSourcePath);
    if (previousPath && normalizedPath(previousPath) !== normalizedPath(target)) await moveDirectoryIfNeeded(previousPath, target);
    await fs.promises.mkdir(target, { recursive: true });
    return { id: gallery.defaultSourceId, name: 'Default Source', path: target };
  });
  ipcMain.handle('gallery:default-source:discard', async (event, payload = {}) => discardGalleryDefaultSource(await profileForWebContents(event.sender), payload));
  ipcMain.handle('folder:scan', async (event, source) => scanSource(await profileForWebContents(event.sender), source));
  ipcMain.handle('source:catalog', async (event, source) => cachedSourceScan(await profileForWebContents(event.sender), source));
  ipcMain.handle('source:catalog-remove', async (event, sourceId) => removeCachedSource(await profileForWebContents(event.sender), sourceId));
  ipcMain.handle('source:resolve', (_, source) => resolveSource(source));
  ipcMain.handle('thumbnails:ensure', async (event, assets) => createThumbnails(await profileForWebContents(event.sender), assets));
  ipcMain.handle('vault:bridges', async () => (await readVaultBridges())
    .filter(item => item?.id && item?.folder)
    .map(item => ({ id: String(item.id), folder: String(item.folder), tracking: bridgeTracking(item) })));
  ipcMain.handle('media:sync-locations', async (event, entries) => syncMediaLocations(await profileForWebContents(event.sender), entries));
  ipcMain.handle('sources:watch', (event, folders) => {
    return profileForWebContents(event.sender).then(profile => watchFolders(profile, event.sender, Array.isArray(folders) ? folders : []));
  });
  ipcMain.handle('image:copy', async (_, asset) => {
    let image;
    if (asset?.vault) {
      try { image = nativeImage.createFromBuffer(Buffer.from(await (await fetch(asset.contentUrl)).arrayBuffer())); }
      catch { return false; }
    } else image = nativeImage.createFromPath(asset?.path || '');
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });
  ipcMain.handle('image:show-in-folder', (_, asset) => {
    if (asset?.vault) return false;
    shell.showItemInFolder(asset?.path || ''); return true;
  });
  ipcMain.handle('media:open-default', async (_, asset) => {
    if (asset?.vault || !asset?.path) return false;
    return !(await shell.openPath(asset.path));
  });
  ipcMain.handle('media:permanent-delete', async (_, asset) => {
    try {
      if (asset?.vault) return (await fetch(asset.contentUrl.replace('/content?', '?'), { method: 'DELETE' })).ok;
      await fs.promises.unlink(asset?.path || ''); return true;
    }
    catch { return false; }
  });
  if (!NATIVE_MESSAGING_MODE) {
    await createWindow(requestedProfileId());
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }
});
app.on('window-all-closed', () => { if (!NATIVE_MESSAGING_MODE && process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopFolderWatchers);
