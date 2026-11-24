const { app, BrowserWindow, dialog, ipcMain, clipboard, nativeImage, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const ffmpegPath = require('ffmpeg-static');

// The development instance needs a distinct name so it is never confused
// with the installed Mosaic application. Both continue to share the existing
// profile/library location for realistic testing.
const APP_DISPLAY_NAME = app.isPackaged ? 'Mosaic' : 'MosaicTest';
const LEGACY_USER_DATA_PATH = path.join(app.getPath('appData'), 'InDeck');
const MOSAIC_USER_DATA_PATH = path.join(app.getPath('appData'), 'Mosaic');
app.setName(APP_DISPLAY_NAME);
app.setPath('userData', MOSAIC_USER_DATA_PATH);
// Windows uses the App User Model ID to associate a running Electron process
// with its taskbar icon instead of the generic electron.exe icon.
app.setAppUserModelId(app.isPackaged ? 'com.mosaic.app' : 'com.mosaic.test');
const MOSAIC_XMP_CONFIG_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'mosaic-exif.config')
  : path.join(__dirname, 'assets', 'mosaic-exif.config');
const MOSAIC_EXIFTOOL_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'exiftool-vendored.exe', 'bin', 'exiftool.exe')
  : path.join(__dirname, 'node_modules', 'exiftool-vendored.exe', 'bin', 'exiftool.exe');
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'mosaic-window-state.json');

// Stills Chromium cannot display: camera RAW, HEIC/HEIF, TIFF and PSD. Their
// thumbnails and the Lightbox view are derived JPEGs, and they never receive
// the portable XMP identity write (metadataImageExtensions leaves them out),
// so an original RAW file is only ever read.
const derivedImageExtensions = new Set(['.tif', '.tiff', '.heic', '.heif', '.psd', '.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.raf', '.orf', '.rw2', '.pef', '.srw']);
const MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', '.mp4', '.mov', '.m4v', '.webm', '.avi', '.ts', ...derivedImageExtensions]);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', ...derivedImageExtensions]);
function isDerivedImage(filePath) {
  return derivedImageExtensions.has(path.extname(String(filePath || '')).toLowerCase());
}
// GIF is a Media type rather than an "ẢNH" in Mosaic terminology. It and
// videos are deliberately untouched; only still-image formats attempt the
// portable XMP identity write.
const metadataImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.avif']);
const WEB_IMPORTS_SOURCE_ID = 'allsight-web-imports';
const PROFILE_MAIN_LIBRARY_SOURCE_ID = 'indeck-profile-main-library';
const VAULT_TUNNEL_FILE = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Vault', 'mosaic-tunnel.json');
// Keep branded resources inside the project so packaged/source builds never
// depend on a user Downloads path.
const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon.png');
const APP_ICON_ICO_PATH = path.join(app.getPath('userData'), 'Mosaic.ico');
const DEFAULT_PROFILE_ID = 'default';
// 4 adds video: sources indexed by an earlier version recorded no dimensions
// for a clip, so they have to be walked again to pick one up.
// 5 fixes non-ASCII filenames, whose dimensions version 4 read but discarded.
const ASPECT_INDEX_VERSION = 5;
// Test and installed applications must never overwrite one another's native
// messaging registration. The production extension uses com.mosaic.app.
const NATIVE_HOST_NAME = app.isPackaged ? 'com.mosaic.app' : 'com.mosaictest.app';
const LEGACY_NATIVE_HOST_NAME = 'com.indeck.mastervision';
const EXTENSION_ID = 'fpbeciobaoekefhhjjenfomhkffmejah';
const EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const profileWindows = new Map();
const webContentsProfileIds = new Map();
const profileWatchers = new Map();
let profileRegistryWriteQueue = Promise.resolve();
// Chrome passes its extension origin to a native host, but Electron can strip
// protocol-looking argv values from a packaged executable on Windows. The
// production launcher therefore supplies an explicit flag as well.
const NATIVE_MESSAGING_MODE = process.argv.includes('--native-messaging')
  || process.argv.some(argument => String(argument).startsWith('chrome-extension://'));
const NATIVE_HOST_REGISTRATION_MODE = process.argv.includes('--register-native-host');
let nativeHostInput = Buffer.alloc(0);
let nativeHostInputEnded = false;
let nativeHostStarted = false;
let nativeHostHandling = Promise.resolve();
const nativeHostKeepAlive = NATIVE_MESSAGING_MODE ? setInterval(() => {}, 1000) : null;
let nativeHostWindow = null;
let autoUpdaterConfigured = false;
async function migrateLegacyAppData() {
  if (normalizedPath(LEGACY_USER_DATA_PATH) === normalizedPath(MOSAIC_USER_DATA_PATH)) return;
  const [legacyReady, mosaicReady] = await Promise.all([
    fs.promises.stat(path.join(LEGACY_USER_DATA_PATH, 'profiles.json')).then(stat => stat.isFile()).catch(() => false),
    fs.promises.stat(path.join(MOSAIC_USER_DATA_PATH, 'profiles.json')).then(stat => stat.isFile()).catch(() => false),
  ]);
  if (!legacyReady || mosaicReady) return;
  await fs.promises.mkdir(MOSAIC_USER_DATA_PATH, { recursive: true });
  await fs.promises.cp(LEGACY_USER_DATA_PATH, MOSAIC_USER_DATA_PATH, { recursive: true, force: false, errorOnExist: false });
}
async function migrateProfileDataPaths() {
  const legacyRoot = path.resolve(LEGACY_USER_DATA_PATH);
  const mosaicRoot = path.resolve(MOSAIC_USER_DATA_PATH);
  const rebase = value => {
    if (!value) return value;
    const current = path.resolve(String(value));
    const relative = path.relative(legacyRoot, current);
    if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) return value;
    return path.join(mosaicRoot, relative);
  };
  const registry = await readProfileRegistry();
  let changed = false;
  for (const bucket of [registry.profiles, registry.discardedProfiles || []]) {
    for (const profile of bucket) {
      const nextPath = rebase(profile.dataPath);
      if (nextPath !== profile.dataPath) { profile.dataPath = nextPath; changed = true; }
    }
  }
  if (changed) await writeProfileRegistry(registry);
}
function requestedProfileId(argv = process.argv) {
  const argument = argv.find(value => String(value).startsWith('--profile='));
  return argument ? String(argument).slice('--profile='.length) || null : null;
}
function broadcastUpdateStatus(status) {
  BrowserWindow.getAllWindows().forEach(window => {
    if (!window.isDestroyed()) window.webContents.send('update:status', status);
  });
}
function configureAutoUpdater() {
  if (!app.isPackaged || autoUpdaterConfigured) return;
  autoUpdaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => broadcastUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', info => broadcastUpdateStatus({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => broadcastUpdateStatus({ state: 'idle' }));
  autoUpdater.on('download-progress', progress => broadcastUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', info => broadcastUpdateStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', error => {
    console.warn('[Mosaic updater]', error.message);
    broadcastUpdateStatus({ state: 'error' });
  });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
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
    mediaPath: path.join(app.getPath('pictures'), 'MosaicMedia'),
    lastMediaPath: path.join(app.getPath('pictures'), 'MosaicMedia'),
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
  return candidates[0] || path.join(app.getPath('pictures'), `MosaicMedia_${safeFolderPart(profile?.name || 'Profile')}`);
}
const PROFILE_FOLDER_ICON_MARKER = '; Mosaic Profile Folder';
const PROFILE_FOLDER_ICON_FILE = 'Mosaic Profile.ico';
function icoFromPng(png) {
  // Windows supports PNG payloads inside modern ICO files. This lets the
  // source build reuse the app icon without carrying a second binary asset.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0; header[7] = 0; // 256 × 256
  header[8] = 0; header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}
async function ensureTaskbarIcon() {
  if (!fs.existsSync(APP_ICON_PATH)) return APP_ICON_PATH;
  try {
    await fs.promises.mkdir(path.dirname(APP_ICON_ICO_PATH), { recursive: true });
    await fs.promises.writeFile(APP_ICON_ICO_PATH, icoFromPng(await fs.promises.readFile(APP_ICON_PATH)));
    return APP_ICON_ICO_PATH;
  } catch { return APP_ICON_PATH; }
}
async function ensureProfileFolderIcon(folder) {
  const target = String(folder || '').trim();
  if (!target || !fs.existsSync(APP_ICON_PATH)) return false;
  const desktopIni = path.join(target, 'desktop.ini');
  const existing = await fs.promises.readFile(desktopIni, 'utf8').catch(() => '');
  // Never overwrite a folder appearance explicitly owned by the user.
  if (existing && !existing.includes(PROFILE_FOLDER_ICON_MARKER)) return false;
  try {
    const iconName = PROFILE_FOLDER_ICON_FILE;
    await fs.promises.writeFile(path.join(target, iconName), icoFromPng(await fs.promises.readFile(APP_ICON_PATH)));
    await fs.promises.writeFile(desktopIni, `${PROFILE_FOLDER_ICON_MARKER}\r\n[.ShellClassInfo]\r\nIconResource=${iconName},0\r\n`, 'utf8');
    await Promise.all([
      runFileCommand('attrib', ['+s', target]),
      runFileCommand('attrib', ['+h', '+s', desktopIni]),
      runFileCommand('attrib', ['+h', path.join(target, iconName)]),
    ]);
    return true;
  } catch { return false; }
}
async function existingProfileLibraryLocation(profile) {
  const candidates = [...new Set([profile?.lastMediaPath, profile?.mediaPath]
    .map(value => String(value || '').trim())
    .filter(value => value && !isRecycleBinPath(value)))];
  for (const candidate of candidates) {
    const exists = await fs.promises.stat(candidate).then(stat => stat.isDirectory()).catch(() => false);
    if (exists) return path.resolve(candidate);
  }
  if (profile?.mediaTracking) {
    const tracked = await resolveTrackedFolder({ folder: profile.mediaPath || profile.lastMediaPath, tracking: profile.mediaTracking });
    if (tracked && !isRecycleBinPath(tracked)) return tracked;
  }
  return null;
}
async function migrateLegacyProfileLibraryFolder(folder) {
  const source = path.resolve(folder);
  const base = path.basename(source);
  if (!/^indeckmedia(?:_|$)/i.test(base)) return source;
  const destination = path.join(path.dirname(source), base.replace(/^indeckmedia/i, 'MosaicMedia'));
  if (normalizedPath(source) === normalizedPath(destination)) return source;
  const destinationExists = await fs.promises.stat(destination).then(stat => stat.isDirectory()).catch(() => false);
  if (destinationExists) return source; // Never merge two user Libraries automatically.
  try {
    await fs.promises.rename(source, destination);
    return destination;
  } catch { return source; }
}
async function restoreProfileLibraryLocation(profile) {
  const previous = profile.mediaPath || null;
  const existing = await existingProfileLibraryLocation(profile);
  let location = existing || profileRecoveryMediaPath(profile);
  if (existing) location = await migrateLegacyProfileLibraryFolder(location);
  const changed = !profile.initialized
    || normalizedPath(profile.mediaPath || location) !== normalizedPath(location)
    || normalizedPath(profile.lastMediaPath || location) !== normalizedPath(location);
  if (!changed) return profile;
  profile.mediaPath = location;
  profile.lastMediaPath = location;
  profile.initialized = true;
  profile.mediaTracking = await identifyFolder(location);
  const stored = await updateProfileInRegistry(profile);
  if (previous && normalizedPath(previous) !== normalizedPath(location)) await relocateManagedProfilePaths(stored, previous);
  return stored;
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
function normalizeProfileRegistry(value) {
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
}
async function readProfileRegistry() {
  const target = profilesRegistryPath();
  let text = null;
  try { text = await readFileWithRetry(target); }
  catch (error) {
    // A lock that never cleared is not a missing registry; recreating it here
    // would drop every Profile but Default.
    if (error.code !== 'ENOENT') throw error;
  }
  if (text !== null) {
    try { return normalizeProfileRegistry(parseJsonFile(text)); }
    catch (error) {
      const corruptCopy = await quarantineCorruptFile(target);
      console.error(`profiles.json could not be read (${error.message}); kept as ${corruptCopy}`);
      try {
        const backup = normalizeProfileRegistry(parseJsonFile(await readFileWithRetry(`${target}.bak`)));
        await writeProfileRegistry(backup);
        return backup;
      } catch { /* No usable backup; start a fresh registry below. */ }
    }
  }
  const registry = { version: 2, profiles: [legacyProfile()], discardedProfiles: [] };
  await writeProfileRegistry(registry);
  return registry;
}
async function writeProfileRegistry(value) {
  const snapshot = JSON.parse(JSON.stringify(value));
  profileRegistryWriteQueue = profileRegistryWriteQueue.catch(() => {}).then(async () => {
    const target = profilesRegistryPath();
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.promises.copyFile(target, `${target}.bak`).catch(() => {});
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
  await ensureProfileFolderIcon(profile.dataPath);
  registry.profiles.push(profile);
  await writeProfileRegistry(registry);
  await syncProfileShortcut(profile);
  return profile;
}
function isMosaicLibraryFolder(folder) { return /^(?:mosaicmedia|indeckmedia)(?:_|$)/i.test(path.basename(folder)); }
function libraryMediaPathForSelection(folder, profile) {
  const value = String(folder || '').trim();
  if (!value) throw new Error('Choose a library location');
  const selected = path.resolve(value);
  // Existing legacy Libraries remain shareable. New profiles use MosaicMedia.
  // selection always creates a Library named after the profile that owns it.
  if (isMosaicLibraryFolder(selected)) return selected;
  return path.join(selected, `MosaicMedia_${safeFolderPart(profile?.name || 'Profile')}`);
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
  if (status.exists && !useExisting) throw new Error('A MosaicMedia Library already exists here. Confirm that you want to use it.');
  const previousMediaPath = profile.mediaPath || profile.lastMediaPath || null;
  const locationChanged = Boolean(previousMediaPath && normalizedPath(previousMediaPath) !== normalizedPath(status.mediaPath));

  // Moving a Profile Library is a physical Library migration, not merely a
  // registry edit.  If the target already exists, the user explicitly chose
  // to use it; this also repairs a Library the user moved manually.  For a
  // new target, move the complete Mosaic root before changing the Profile
  // record so a failed cross-drive copy leaves the active Library untouched.
  if (locationChanged && !status.exists) await moveLibraryRootSafely(previousMediaPath, status.mediaPath);
  await fs.promises.mkdir(status.mediaPath, { recursive: true });
  profile.mediaPath = status.mediaPath;
  profile.lastMediaPath = status.mediaPath;
  profile.mediaTracking = await identifyFolder(status.mediaPath);
  profile.initialized = true;
  profile.libraryLocationConfiguredAt = Date.now();
  const stored = await updateProfileInRegistry(profile);
  if (locationChanged) await relocateManagedProfilePaths(stored, previousMediaPath);
  await recoverProfileLibrary(stored);
  await ensureProfileFolderIcon(status.mediaPath);
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

async function directoryTransferSummary(folder) {
  const summary = { files: 0, directories: 0, bytes: 0 };
  const pending = [folder];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) {
        summary.directories += 1;
        pending.push(item);
      } else if (entry.isFile()) {
        summary.files += 1;
        summary.bytes += (await fs.promises.stat(item)).size;
      }
    }
  }
  return summary;
}

async function moveLibraryRootSafely(from, to) {
  const source = path.resolve(String(from || ''));
  const target = path.resolve(String(to || ''));
  if (!source || !target || normalizedPath(source) === normalizedPath(target)) return false;
  const sourceExists = await fs.promises.stat(source).then(stat => stat.isDirectory()).catch(() => false);
  if (!sourceExists) return false;
  const targetExists = await fs.promises.stat(target).then(stat => stat.isDirectory()).catch(() => false);
  if (targetExists) return false;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.rename(source, target);
    return true;
  } catch (error) {
    // Windows only permits a directory rename within one volume. Cross-drive
    // moves copy into a sibling staging folder, verify it, then remove the old
    // root. The profile remains pointed at the old root until all three steps
    // complete, so a failed move cannot make media disappear from Mosaic.
    if (error?.code !== 'EXDEV') throw error;
  }
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.mosaic-moving-${crypto.randomUUID()}`);
  try {
    const before = await directoryTransferSummary(source);
    await fs.promises.cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    const copied = await directoryTransferSummary(staging);
    if (before.files !== copied.files || before.directories !== copied.directories || before.bytes !== copied.bytes) {
      throw new Error('Library copy verification failed');
    }
    await fs.promises.rename(staging, target);
    await fs.promises.rm(source, { recursive: true, force: false, maxRetries: 2, retryDelay: 250 });
    return true;
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 1 }).catch(() => {});
    throw new Error(`Could not move the Library: ${error.message || error}`);
  }
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
  // Recovery is also the repair path for an incomplete profile record. Prefer
  // an existing last-known Library location, then its tracked location; only
  // create a new Mosaic Library when neither can be found.
  profile = await restoreProfileLibraryLocation(profile);
  profile = await ensureProfileLibraryFolders(profile);
  await Promise.all([ensureProfileFolderIcon(profile.dataPath), ensureProfileFolderIcon(profile.mediaPath)]);
  const data = await readStore(profile);
  const defaultSaveChanged = await ensureProfileDefaultSaveSource(profile, data);
  // Rebuild all Gallery DMS links before scanning Main Gallery. That prevents
  // its root source from absorbing DMS files and guarantees every Gallery
  // leaves recovery with a source record, directory, and sourceIds link.
  const repairedDefaults = await ensureDefaultSourcesForExistingGalleries(profile, data);
  const mainLibraryChanged = await ensureProfileMainLibrarySource(profile, data);
  const prunedUnavailable = await reconcileUnavailableSources(profile, data);
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
  await syncProfileShortcut(profile);
  return profile;
}
async function setDefaultProfile(profileId) {
  const registry = await readProfileRegistry();
  const profile = registry.profiles.find(item => item.id === String(profileId));
  if (!profile) throw new Error('Profile not found');
  const previousDefault = registry.profiles.find(item => item.isDefault) || null;
  registry.profiles.forEach(item => { item.isDefault = item.id === profile.id; });
  await writeProfileRegistry(registry);
  // Order matters: the previous Default gives up Mosaic.lnk first, so the
  // new Default can take that name instead of falling back to "Mosaic (2)".
  if (previousDefault && previousDefault.id !== profile.id) await syncProfileShortcut(previousDefault);
  await syncProfileShortcut(profile);
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
  await removeProfileShortcut(profile);
  if (replacement) await syncProfileShortcut(replacement);
  return { profile, replacement };
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
  await syncProfileShortcut(profile);
  return profile;
}

async function permanentlyDeleteDiscardedProfile(profileId, typedName) {
  const registry = await readProfileRegistry();
  const index = registry.discardedProfiles.findIndex(profile => profile.id === String(profileId));
  if (index < 0) throw new Error('Discarded profile not found');
  const profile = registry.discardedProfiles[index];
  if (comparableProfileName(typedName) !== comparableProfileName(profile.name)) throw new Error('The confirmation name does not match');

  // Keep the external MosaicMedia Library intact. It may be shared with another
  // profile, while this operation only makes this discarded profile unrecoverable.
  registry.discardedProfiles.splice(index, 1);
  await writeProfileRegistry(registry);
  await removeProfileShortcut(profile);
  return profile;
}
const DEFAULT_SHORTCUT_NAME = 'Mosaic';
function shortcutTarget(profile) {
  const options = app.isPackaged
    ? {
      target: app.getPath('exe'),
      args: `--profile=${profile.id}`,
      description: `Open Mosaic profile ${profile.name}`,
      workingDirectory: path.dirname(app.getPath('exe')),
    }
    : {
      // Source-checkout shortcuts open the same Electron entry used by
      // MosaicTest, without depending on an old InDeck batch file.
      target: path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: `. --profile=${profile.id}`,
      description: `Open Mosaic profile ${profile.name}`,
      workingDirectory: __dirname,
    };
  if (fs.existsSync(APP_ICON_ICO_PATH)) options.icon = APP_ICON_ICO_PATH;
  else if (fs.existsSync(APP_ICON_PATH)) options.icon = APP_ICON_PATH;
  return options;
}
function readShortcut(shortcutPath) {
  try { return shell.readShortcutLink(shortcutPath); }
  catch { return null; }
}
/** The `--profile=<id>` a shortcut opens, matched as a whole argument. */
function shortcutProfileId(shortcutPath) {
  const args = String(readShortcut(shortcutPath)?.args || '');
  const match = args.match(/(?:^|\s)"?--profile=([^\s"]+)"?(?=\s|$)/);
  return match ? match[1] : null;
}
function shortcutBelongsToProfile(shortcutPath, profileId) {
  return shortcutProfileId(shortcutPath) === String(profileId);
}
/** The installer's own Desktop shortcut: Mosaic.exe without a profile. */
function isGenericMosaicShortcut(shortcutPath) {
  const link = readShortcut(shortcutPath);
  return Boolean(link && !shortcutProfileId(shortcutPath) && /^mosaic\.exe$/i.test(path.basename(String(link.target || ''))));
}
function profileShortcutPath(profile) {
  // Default owns Mosaic.lnk. Every other Profile is named after itself and
  // never takes a file that belongs to something else: a Profile called
  // "Mosaic", two names that sanitize alike ("A:B" / "A-B"), or one matching
  // an unrelated Desktop shortcut ("Google Chrome") used to overwrite it.
  const desktop = app.getPath('desktop');
  const base = profile.isDefault ? DEFAULT_SHORTCUT_NAME : safeFolderPart(profile.name);
  for (let number = 1; number < 1000; number += 1) {
    const name = number === 1 ? base : `${base} (${number})`;
    if (!profile.isDefault && name.toLowerCase() === DEFAULT_SHORTCUT_NAME.toLowerCase()) continue;
    const candidate = path.join(desktop, `${name}.lnk`);
    if (!fs.existsSync(candidate) || shortcutBelongsToProfile(candidate, profile.id)) return candidate;
    if (profile.isDefault && number === 1 && isGenericMosaicShortcut(candidate)) return candidate;
  }
  throw new Error('Could not find a free name for the profile shortcut');
}
function profileShortcutCandidates(profile) {
  const desktop = app.getPath('desktop');
  const base = safeFolderPart(profile.name);
  return [...new Set([
    profile.shortcutPath,
    path.join(desktop, `${base}.lnk`),
    path.join(desktop, `Mosaic - ${base}.lnk`),
    path.join(desktop, `${DEFAULT_SHORTCUT_NAME}.lnk`),
  ].filter(Boolean))];
}
async function removeProfileShortcut(profile, keepPath = null) {
  // Only files that open this exact Profile are removed; anything else that
  // happens to share a name is left alone.
  for (const shortcutPath of profileShortcutCandidates(profile)) {
    if (keepPath && normalizedPath(shortcutPath) === normalizedPath(keepPath)) continue;
    if (!shortcutBelongsToProfile(shortcutPath, profile.id)) continue;
    await fs.promises.unlink(shortcutPath).catch(() => {});
  }
}
/**
 * Bring a Profile's shortcut in line with its current name and Default status
 * after a profile action. A Desktop that cannot be written must not make the
 * action itself fail: the registry change has already been saved.
 */
async function syncProfileShortcut(profile) {
  try { return await createProfileShortcut(profile.id); }
  catch (error) {
    console.error(`Could not update the shortcut for profile ${profile?.id}:`, error.message);
    return null;
  }
}
async function createProfileShortcut(profileId) {
  const profile = await profileById(profileId);
  if (!profile) throw new Error('Profile not found');
  // Write the new shortcut before removing the old one, so a Desktop that
  // refuses the write leaves the Profile with its previous shortcut.
  const shortcutPath = profileShortcutPath(profile);
  if (!shell.writeShortcutLink(shortcutPath, 'create', shortcutTarget(profile))) throw new Error('Could not create the profile shortcut');
  await removeProfileShortcut(profile, shortcutPath);
  const registry = await readProfileRegistry();
  const index = registry.profiles.findIndex(item => item.id === profile.id);
  if (index >= 0 && registry.profiles[index].shortcutPath !== shortcutPath) {
    registry.profiles[index].shortcutPath = shortcutPath;
    await writeProfileRegistry(registry);
  }
  return shortcutPath;
}
/**
 * Startup repair for shortcuts whose program no longer exists (Mosaic was
 * reinstalled to another folder, or a source checkout was moved). Shortcuts
 * that still work are never touched, so a dev build does not retarget the
 * installed app's shortcuts or the other way round.
 */
async function repairBrokenProfileShortcuts() {
  const registry = await readProfileRegistry();
  for (const profile of registry.profiles) {
    const shortcutPath = profile.shortcutPath;
    if (!shortcutPath || !shortcutBelongsToProfile(shortcutPath, profile.id)) continue;
    const target = String(readShortcut(shortcutPath)?.target || '');
    if (target && fs.existsSync(target)) continue;
    if (!shell.writeShortcutLink(shortcutPath, 'replace', shortcutTarget(profile))) console.error(`Could not repair shortcut ${shortcutPath}`);
  }
}
/**
 * Profile actions read profiles.json, change it and write it back, and most
 * then rewrite Desktop shortcuts. Run them one at a time so two quick clicks
 * cannot lose one of the changes or race on the same .lnk file.
 */
let profileOperationQueue = Promise.resolve();
function withProfileLock(operation) {
  const run = profileOperationQueue.catch(() => {}).then(operation);
  profileOperationQueue = run.catch(() => {});
  return run;
}
async function ensureProfileFolderIcons() {
  const registry = await readProfileRegistry();
  for (const profile of registry.profiles) {
    await ensureProfileFolderIcon(profile.dataPath);
    if (profile.mediaPath) await ensureProfileFolderIcon(profile.mediaPath);
  }
}

// MosaicTest is restarted between development edits. This explicit test flag
// bypasses a stale single-instance mutex without weakening normal production
// runs, which keep the one-window-per-profile behavior.
const ALLOW_TEST_MULTIPLE_INSTANCES = process.env.MOSAIC_ALLOW_MULTIPLE_INSTANCES === '1';
if (!ALLOW_TEST_MULTIPLE_INSTANCES && !NATIVE_MESSAGING_MODE && !NATIVE_HOST_REGISTRATION_MODE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_event, argv) => {
  if (NATIVE_MESSAGING_MODE) return;
  launchProfileWindow(argv).catch(error => console.error('Could not open profile window:', error.message));
});
/**
 * Open the window a launch asked for. A shortcut can outlive its Profile
 * (copied elsewhere, pinned to the taskbar, left on another Desktop), so an
 * unknown or deleted Profile opens Default rather than nothing at all.
 */
async function launchProfileWindow(argv = process.argv) {
  const requested = requestedProfileId(argv);
  if (requested && !await profileById(requested)) {
    console.warn(`Profile ${requested} from the launch shortcut no longer exists; opening Default`);
    return createWindow(null);
  }
  return createWindow(requested);
}

function storePath(profile) { return path.join(profileDataPath(profile), 'library.json'); }
function emptyStore() { return { sources: [], collections: [], assetMeta: {}, passwordHash: null }; }
function parseJsonFile(text) { return JSON.parse(String(text).replace(/^﻿/, '')); }
const TRANSIENT_FILE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);
async function readFileWithRetry(file) {
  // Antivirus scanners and backup tools briefly lock files on Windows. A lock
  // is not an empty file: retry, then fail loudly instead of guessing.
  for (let attempt = 0; ; attempt += 1) {
    try { return await fs.promises.readFile(file, 'utf8'); }
    catch (error) {
      if (!TRANSIENT_FILE_ERRORS.has(error.code) || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
async function quarantineCorruptFile(file) {
  const target = `${file}.corrupt-${Date.now()}`;
  await fs.promises.rename(file, target).catch(error => console.error(`Could not set aside ${file}:`, error.message));
  return target;
}
async function readStoreFile(profile) {
  const target = storePath(profile);
  let text;
  try { text = await readFileWithRetry(target); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    // Anything else (a lock that never cleared, a missing drive) must not turn
    // into an empty library: the next write would replace the real one with it.
    throw error;
  }
  try {
    const value = parseJsonFile(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    throw new Error('library.json is not an object');
  } catch (error) {
    // A damaged file is kept for recovery and the last good copy is used.
    const corruptCopy = await quarantineCorruptFile(target);
    console.error(`library.json could not be parsed (${error.message}); kept as ${corruptCopy}`);
    try {
      const backup = parseJsonFile(await readFileWithRetry(`${target}.bak`));
      if (backup && typeof backup === 'object' && !Array.isArray(backup)) {
        await fs.promises.copyFile(`${target}.bak`, target).catch(() => {});
        return backup;
      }
    } catch { /* No usable backup; start from an empty library below. */ }
    return emptyStore();
  }
}
const storeWriteQueues = new Map();
function enqueueStoreTask(profile, task) {
  const queueKey = profile?.id || DEFAULT_PROFILE_ID;
  const previous = storeWriteQueues.get(queueKey) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  storeWriteQueues.set(queueKey, next);
  return next;
}
async function readStore(profile) {
  // Wait for writes already queued so a read never returns the file as it was
  // before an edit the caller (or the renderer) has just saved.
  await (storeWriteQueues.get(profile?.id || DEFAULT_PROFILE_ID) || Promise.resolve()).catch(() => {});
  return readStoreFile(profile);
}
async function writeStoreFile(profile, snapshot) {
  const target = storePath(profile);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
  // Keep the previous version as the fallback readStoreFile uses when the
  // current file turns out to be damaged.
  await fs.promises.copyFile(target, `${target}.bak`).catch(() => {});
  await fs.promises.rename(temporary, target);
}
async function writeStore(profile, value) {
  // Renderer saves can be triggered by several independent UI interactions.
  // Serialize and atomically replace the file so a crash or a racing render
  // never leaves a half-written library.json behind.
  const snapshot = JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {}));
  return enqueueStoreTask(profile, () => writeStoreFile(profile, snapshot));
}
/**
 * Read-modify-write library.json as one step of the write queue, so no other
 * save can land between the read and the write. `mutate` must be quick (no
 * scans or file moves); it returns true when `data` changed and must be saved.
 */
function mutateStore(profile, mutate) {
  return enqueueStoreTask(profile, async () => {
    const data = await readStoreFile(profile);
    const changed = await mutate(data);
    if (changed) await writeStoreFile(profile, JSON.parse(JSON.stringify(data)));
    return changed;
  });
}
function catalogPath(profile) { return path.join(profileDataPath(profile), 'media-catalog.json'); }
function thumbnailDirectory(profile) { return path.join(profileDataPath(profile), 'thumbnails'); }

async function resetThumbnailCaches(profiles) {
  const candidates = [...(profiles?.profiles || []), ...(profiles?.discardedProfiles || [])]
    .map(profile => thumbnailDirectory(profile));
  // Cache is disposable. This is deliberately available only behind an
  // explicit launch flag so support/testing can reset every Profile without
  // touching library metadata or original media.
  await Promise.all([...new Set(candidates)].map(folder => fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {})));
}
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
function thumbnailVariantSize(asset) {
  const requested = Number(asset?.thumbnailSize || 320);
  if (requested <= 160) return 160;
  if (requested <= 320) return 320;
  if (requested <= 512) return 512;
  // The Lightbox view of a still Chromium cannot display (RAW, HEIC, TIFF,
  // PSD). Large enough for a full-screen view, still a fraction of a RAW.
  return THUMBNAIL_DISPLAY_SIZE;
}
const THUMBNAIL_DISPLAY_SIZE = 2048;
const THUMBNAIL_VARIANTS = [160, 320, 512, THUMBNAIL_DISPLAY_SIZE];
// The identity of a source revision. mtime alone kept a stale thumbnail when
// a file was replaced by one carrying the same timestamp (copy tools that
// preserve it), so the byte size is part of it. Vault listings carry no size.
function thumbnailRevision(asset) {
  return `${asset?.id}:${asset?.modified || 0}:${Number(asset?.size) || 0}`;
}
function thumbnailPath(profile, asset) {
  const variant = thumbnailVariantSize(asset);
  // Video moves to v4: covers are now taken at min(10 s, duration / 3), not
  // one second in, which still landed on the fade-in of most clips.
  const key = `${thumbnailRevision(asset)}:${variant}:${asset.type === 'video' ? 'jpeg-v4' : 'jpeg-v2'}`;
  return path.join(thumbnailDirectory(profile), `${crypto.createHash('sha1').update(key).digest('hex')}.jpg`);
}
// A media Library should keep a warm preview for substantially more than a
// fixed number of files. JPEG derivatives are small, and an LRU byte budget
// avoids the old 1,600-file churn in a multi-thousand-media Gallery.
const THUMBNAIL_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const thumbnailCachePruneCounters = new Map();
const thumbnailWorkQueues = new Map();
const thumbnailLatency = new Map();
function thumbnailDecodeConcurrency() {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(3, Math.min(8, Math.ceil(available * 0.6)));
}
function recordThumbnailLatency(profile, job, startedAt, completedAt, outcome) {
  const key = String(profile?.id || DEFAULT_PROFILE_ID);
  const sample = {
    id: String(job.asset?.id || ''),
    size: thumbnailVariantSize(job.asset),
    priority: job.priority,
    queuedMs: Math.round(startedAt - job.enqueuedAt),
    decodeMs: Math.round(completedAt - startedAt),
    totalMs: Math.round(completedAt - job.enqueuedAt),
    outcome,
    at: Date.now(),
  };
  const samples = thumbnailLatency.get(key) || [];
  samples.push(sample);
  if (samples.length > 240) samples.splice(0, samples.length - 240);
  thumbnailLatency.set(key, samples);
  if (process.env.MOSAIC_THUMBNAIL_PROFILE === '1') console.debug('[Mosaic thumbnail]', sample);
}
function enqueueThumbnail(queue, job) {
  const pending = job.priority === 'high' ? queue.highPending : queue.bufferPending;
  pending.push(job);
  pending.sort((left, right) => Number(left.asset?.thumbnailDistance ?? Number.MAX_SAFE_INTEGER) - Number(right.asset?.thumbnailDistance ?? Number.MAX_SAFE_INTEGER));
}
// Thumbnail calls are made by visible cards.  The work queue is shared by the
// whole profile, not by each IPC request, so a fast scroll cannot multiply
// image/video decoding work beyond this fixed concurrency.
function scheduleThumbnail(profile, asset, requestId) {
  const profileKey = String(profile?.id || DEFAULT_PROFILE_ID);
  let queue = thumbnailWorkQueues.get(profileKey);
  if (!queue) {
    const concurrency = thumbnailDecodeConcurrency();
    queue = { active: 0, activeBuffer: 0, concurrency, bufferLimit: Math.max(1, concurrency - 2), highPending: [], bufferPending: [], jobs: new Map() };
    thumbnailWorkQueues.set(profileKey, queue);
  }
  const jobKey = `${thumbnailRevision(asset)}:${thumbnailVariantSize(asset)}`;
  const priority = asset?.thumbnailPriority === 'high' ? 'high' : 'buffer';
  requestId ||= `batch:${crypto.randomUUID()}`;
  let job = queue.jobs.get(jobKey);
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  if (job) {
    const consumers = job.consumers.get(requestId) || [];
    consumers.push(resolve);
    job.consumers.set(requestId, consumers);
    if (!job.started && priority === 'high' && job.priority !== 'high') {
      queue.bufferPending = queue.bufferPending.filter(item => item !== job);
      job.priority = 'high';
      job.asset = { ...job.asset, thumbnailPriority: 'high', thumbnailDistance: Math.min(Number(job.asset?.thumbnailDistance ?? Number.MAX_SAFE_INTEGER), Number(asset?.thumbnailDistance ?? Number.MAX_SAFE_INTEGER)) };
      enqueueThumbnail(queue, job);
    }
    return promise;
  }
  job = { asset, jobKey, priority, enqueuedAt: performance.now(), consumers: new Map([[requestId, [resolve]]]), started: false };
  queue.jobs.set(jobKey, job);
  enqueueThumbnail(queue, job);
  // A thumbnail already on disk needs no decode slot. Probe the cache beside
  // the queue rather than in front of it, so cancellation still sees the job,
  // and settle it here if it has not started — otherwise a warm card waited
  // behind every cold image and ffmpeg frame grab ahead of it.
  const enqueued = job;
  void cachedThumbnailUrl(profile, asset).then(url => {
    if (!url || enqueued.started || queue.jobs.get(jobKey) !== enqueued) return;
    queue.jobs.delete(jobKey);
    queue.highPending = queue.highPending.filter(item => item !== enqueued);
    queue.bufferPending = queue.bufferPending.filter(item => item !== enqueued);
    const settledAt = performance.now();
    recordThumbnailLatency(profile, enqueued, settledAt, settledAt, 'cached');
    enqueued.consumers.forEach(resolvers => resolvers.forEach(done => done(url)));
  }, () => {});
  const pump = () => {
    while (queue.active < queue.concurrency) {
      const next = queue.highPending.shift() || (queue.activeBuffer < queue.bufferLimit ? queue.bufferPending.shift() : null);
      if (!next) break;
      if (!next.consumers.size) { queue.jobs.delete(next.jobKey); continue; }
      queue.active += 1;
      if (next.priority === 'buffer') queue.activeBuffer += 1;
      next.started = true;
      const startedAt = performance.now();
      createThumbnail(profile, next.asset)
        .then(value => {
          recordThumbnailLatency(profile, next, startedAt, performance.now(), value ? 'ok' : 'empty');
          next.consumers.forEach(resolvers => resolvers.forEach(resolve => resolve(value)));
        }, () => {
          recordThumbnailLatency(profile, next, startedAt, performance.now(), 'error');
          next.consumers.forEach(resolvers => resolvers.forEach(resolve => resolve(null)));
        })
        .finally(() => {
          queue.active -= 1;
          if (next.priority === 'buffer') queue.activeBuffer -= 1;
          queue.jobs.delete(next.jobKey);
          pump();
        });
    }
  };
  pump();
  return promise;
}
function cancelThumbnailRequest(profile, requestId) {
  if (!requestId) return;
  const queue = thumbnailWorkQueues.get(String(profile?.id || DEFAULT_PROFILE_ID));
  if (!queue) return;
  queue.jobs.forEach(job => {
    const resolvers = job.consumers.get(requestId);
    if (resolvers) { job.consumers.delete(requestId); resolvers.forEach(resolve => resolve(null)); }
  });
  // Do not let a card that was recycled while scrolling occupy a future slot.
  // Native image work already running cannot be interrupted safely, but it
  // has no consumers and its result is discarded when it settles.
  for (const job of [...queue.jobs.values()]) {
    if (job.started || job.consumers.size) continue;
    queue.jobs.delete(job.jobKey);
    queue.highPending = queue.highPending.filter(item => item !== job);
    queue.bufferPending = queue.bufferPending.filter(item => item !== job);
  }
}
async function pruneThumbnailCache(profile) {
  const key = String(profile?.id || DEFAULT_PROFILE_ID);
  const count = (thumbnailCachePruneCounters.get(key) || 0) + 1;
  thumbnailCachePruneCounters.set(key, count);
  // Pruning occasionally, rather than during every thumbnail lookup, keeps
  // the cache bounded without putting directory enumeration on the scroll path.
  if (count % 160) return;
  try {
    const folder = thumbnailDirectory(profile);
    const files = (await fs.promises.readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name));
    if (!files.length) return;
    const details = await Promise.all(files.map(async entry => ({
      path: path.join(folder, entry.name),
      ...(await fs.promises.stat(path.join(folder, entry.name))),
    })));
    let totalBytes = details.reduce((total, file) => total + file.size, 0);
    if (totalBytes <= THUMBNAIL_CACHE_MAX_BYTES) return;
    details.sort((a, b) => a.mtime - b.mtime);
    const expired = [];
    for (const file of details) {
      if (totalBytes <= THUMBNAIL_CACHE_MAX_BYTES) break;
      totalBytes -= file.size;
      expired.push(file);
    }
    await Promise.all(expired.map(file => fs.promises.rm(file.path, { force: true })));
  } catch { /* A cache is disposable. */ }
}
function grabVideoFrame(source, target, maximum, seekSeconds, outputSeek = true) {
  const seek = seekSeconds ? ['-ss', seekSeconds.toFixed(3)] : [];
  return new Promise(resolve => execFile(ffmpegPath, [
    // Do not seek before MPEG-TS input: transport streams often start at a
    // non-zero timestamp, which can otherwise produce no frame at all. Output
    // seeking decodes from the start instead, so it stays correct for them.
    // Every other container seeks on input, so a cover ten seconds in does
    // not cost ten seconds of decoding.
    '-hide_banner', '-loglevel', 'error', ...(outputSeek ? [] : seek), '-i', source, ...(outputSeek ? seek : []),
    '-frames:v', '1', '-vf', `scale=${maximum}:${maximum}:force_original_aspect_ratio=decrease`, '-q:v', '4', '-y', target
  ], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, error => resolve(!error)));
}
// ffmpeg prints the container duration before it decodes anything, so this
// costs one header read rather than a frame decode.
function videoDurationSeconds(source) {
  if (!ffmpegPath || !source) return Promise.resolve(0);
  return new Promise(resolve => execFile(ffmpegPath, ['-hide_banner', '-i', source], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (_error, _stdout, stderr) => {
    const match = String(stderr || '').match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0);
  }));
}
async function wroteFrame(target) {
  // ffmpeg can exit 0 having written nothing when the seek lands past the end.
  return fs.promises.stat(target).then(stat => stat.isFile() && stat.size > 0).catch(() => false);
}
async function createVideoThumbnail(asset, target, maximum) {
  const source = asset?.vault ? asset.contentUrl : asset?.path;
  if (!ffmpegPath || !source) return false;
  // Frame zero of a video is very often the black lead-in, and one second in
  // is usually still the fade. Take the cover a third of the way through,
  // capped at ten seconds, then fall back to one second and finally to the
  // first frame for clips whose duration cannot be read or that are tiny.
  const outputSeek = /\.(?:ts|m2ts|mts)$/i.test(String(asset?.path || source));
  const duration = await videoDurationSeconds(source);
  const attempts = [...new Set([duration > 0 ? Math.min(10, duration / 3) : 1, 1, 0])].filter(seconds => !duration || seconds < duration);
  for (const seconds of attempts.length ? attempts : [0]) {
    if (await grabVideoFrame(source, target, maximum, seconds, outputSeek) && await wroteFrame(target)) return true;
  }
  return false;
}
// A still that the Windows shell cannot thumbnail (a missing AVIF/WebP codec,
// an unusual BMP, a TIFF or PSD without a shell handler) is decoded by ffmpeg
// instead. ffmpeg applies JPEG EXIF orientation itself, and it runs in a
// child process, so the decode never lands on the main thread.
async function createStillThumbnailWithFfmpeg(source, target, maximum) {
  if (!ffmpegPath || !source) return false;
  return (await grabVideoFrame(source, target, maximum, 0)) && wroteFrame(target);
}
async function writeShellThumbnail(file, target, maximum) {
  // This native Electron decode resolves asynchronously; no renderer canvas
  // or Image decode is allowed to block scrolling on the UI thread. It
  // rejects, rather than returning an empty image, when no shell thumbnail
  // provider handles the file.
  const image = await nativeImage.createThumbnailFromPath(file, { width: maximum, height: maximum }).catch(() => null);
  if (!image || image.isEmpty()) return false;
  await fs.promises.writeFile(target, image.toJPEG(84));
  return true;
}
// SVG is a design format Chromium renders but no thumbnailer here reads:
// nativeImage, the Windows shell and ffmpeg all refuse it. It is drawn by
// Chromium itself in a hidden offscreen window, as an <img> (which never runs
// an SVG's scripts or fetches what it links to), and captured as a JPEG.
function isSvg(filePath) {
  return path.extname(String(filePath || '')).toLowerCase() === '.svg';
}
const SVG_UNITS = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
function svgDimensions(text) {
  const tag = String(text || '').match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const attribute = name => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
  const length = value => {
    const match = String(value || '').trim().match(/^([\d.]+)\s*(px|pt|pc|mm|cm|in)?$/i);
    return match ? Number(match[1]) * SVG_UNITS[(match[2] || '').toLowerCase()] : 0;
  };
  const box = String(attribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const boxWidth = box.length === 4 && box[2] > 0 ? box[2] : 0;
  const boxHeight = box.length === 4 && box[3] > 0 ? box[3] : 0;
  let width = length(attribute('width'));
  let height = length(attribute('height'));
  // One side given ("width=100%" counts as none): the viewBox supplies the ratio.
  if (width && !height && boxWidth) height = width * boxHeight / boxWidth;
  if (height && !width && boxHeight) width = height * boxWidth / boxHeight;
  if (!width || !height) { width = boxWidth; height = boxHeight; }
  if (!(width > 0 && height > 0)) return null;
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}
async function readSvgHead(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
let svgRasterWindow = null;
let svgRasterChain = Promise.resolve();
let svgRasterSessionReady = false;
function svgRasterContents() {
  if (svgRasterWindow && !svgRasterWindow.isDestroyed()) return svgRasterWindow.webContents;
  svgRasterWindow = new BrowserWindow({
    show: false,
    width: 320,
    height: 320,
    useContentSize: true,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      partition: 'mosaic-svg-raster',
    },
  });
  const contents = svgRasterWindow.webContents;
  if (!svgRasterSessionReady) {
    svgRasterSessionReady = true;
    // Only the page Mosaic writes and the SVG it shows may load.
    contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/i.test(details.url) }));
  }
  contents.on('will-navigate', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  svgRasterWindow.on('closed', () => { svgRasterWindow = null; });
  return contents;
}
function rasterizeSvgFile(file, target, maximum) {
  const run = async () => {
    const size = svgDimensions(await readSvgHead(file)) || { width: maximum, height: maximum };
    // A vector scales up as cleanly as down: a 24 px icon fills the card too.
    const scale = Math.min(maximum / size.width, maximum / size.height);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const contents = svgRasterContents();
    svgRasterWindow.setContentSize(width, height);
    const page = path.join(os.tmpdir(), `mosaic-svg-${process.pid}-${crypto.randomUUID()}.html`);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff}img{display:block;width:${width}px;height:${height}px}</style></head><body><img src="${pathToFileURL(file).href}"></body></html>`;
    try {
      await fs.promises.writeFile(page, html, 'utf8');
      await contents.loadFile(page);
      // An offscreen frame paints on its own schedule after the load.
      await new Promise(resolve => setTimeout(resolve, 150));
      let image = await contents.capturePage({ x: 0, y: 0, width, height });
      if (image.isEmpty()) return false;
      // A high-DPI display captures at its scale factor.
      if (image.getSize().width > width) image = image.resize({ width, height, quality: 'best' });
      await fs.promises.writeFile(target, image.toJPEG(88));
      return true;
    } finally {
      await fs.promises.rm(page, { force: true }).catch(() => {});
    }
  };
  // One window draws one SVG at a time.
  const result = svgRasterChain.then(run, run);
  svgRasterChain = result.catch(() => {});
  return result.catch(() => false);
}
async function rasterizeSvgBuffer(bytes, target, maximum) {
  const file = path.join(os.tmpdir(), `mosaic-svg-${process.pid}-${crypto.randomUUID()}.svg`);
  try {
    await fs.promises.writeFile(file, bytes);
    return await rasterizeSvgFile(file, target, maximum);
  } finally {
    await fs.promises.rm(file, { force: true }).catch(() => {});
  }
}
async function createLocalStillThumbnail(file, target, maximum) {
  if (isSvg(file)) return rasterizeSvgFile(file, target, maximum);
  if (isDerivedImage(file)) {
    // RAW, HEIC, TIFF and PSD depend on optional Windows codecs, and the
    // shell may answer a large request with a small cached icon. The camera's
    // own embedded JPEG is exact and usually full size, so the Lightbox view
    // prefers it; grid sizes try the (cached, fast) shell first.
    const order = maximum >= THUMBNAIL_DISPLAY_SIZE
      ? [createThumbnailFromEmbeddedPreview, writeShellThumbnail]
      : [writeShellThumbnail, createThumbnailFromEmbeddedPreview];
    for (const attempt of order) {
      if (!(await attempt(file, target, maximum).catch(() => false))) continue;
      // The embedded route orients its own output; the shell may not have.
      if (attempt === writeShellThumbnail) await orientDerivedThumbnail(file, target).catch(() => {});
      return true;
    }
    if (!(await createStillThumbnailWithFfmpeg(file, target, maximum))) return false;
    // ffmpeg applies EXIF orientation to JPEG input only, not to TIFF or PSD.
    await orientDerivedThumbnail(file, target).catch(() => {});
    return true;
  }
  return (await writeShellThumbnail(file, target, maximum)) || createStillThumbnailWithFfmpeg(file, target, maximum);
}
function ffmpegThumbnailFromBuffer(buffer, target, maximum) {
  if (!ffmpegPath) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-frames:v', '1', '-vf', `scale=${maximum}:${maximum}:force_original_aspect_ratio=decrease`, '-q:v', '4', '-y', target],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, error => resolve(!error));
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  }).then(ok => ok && wroteFrame(target));
}
async function createVaultStillThumbnail(asset, target, maximum) {
  // The previous route decoded the whole original with
  // nativeImage.createFromBuffer, which is synchronous: a large photo froze
  // every window while it decoded. The bytes are piped to ffmpeg instead,
  // which decodes in a child process and applies EXIF orientation. (Given the
  // URL directly, ffmpeg cannot probe a still served over HTTP.)
  const response = await fetch(asset.contentUrl || '').catch(() => null);
  if (!response?.ok) return false;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (isSvg(asset.path || asset.name)) return rasterizeSvgBuffer(bytes, target, maximum);
  if (await ffmpegThumbnailFromBuffer(bytes, target, maximum)) return true;
  // Formats ffmpeg cannot detect from a pipe (AVIF needs a seekable input).
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return false;
  const { width, height } = image.getSize();
  if (width && height) image = width >= height ? image.resize({ width: Math.min(maximum, width) }) : image.resize({ height: Math.min(maximum, height) });
  await fs.promises.writeFile(target, image.toJPEG(84));
  return true;
}
// The shell's TIFF/RAW providers do not all apply EXIF orientation, nor does
// ffmpeg for TIFF, while the scan's dimensions do, so a sideways card would
// be cover-cropped. A
// quarter turn is detectable from the aspect; flips and 180° are not, and
// are rare enough in these formats to leave as the shell drew them.
async function orientDerivedThumbnail(file, target) {
  const listing = await runExifToolOnFile(['-j', '-n', '-Orientation', '-ImageSize'], file);
  const entry = JSON.parse(String(listing || '[]'))[0];
  const orientation = Number(entry?.Orientation || 1);
  if (orientation < 5 || orientation > 8) return;
  const source = String(entry?.ImageSize || '').match(/^(\d+)[x ](\d+)$/);
  const drawn = nativeImage.createFromPath(target).getSize();
  if (!source || !drawn.width) return;
  // Already turned if its landscape-ness differs from the stored bitmap's.
  if ((Number(source[1]) >= Number(source[2])) !== (drawn.width >= drawn.height)) return;
  const turned = `${target}.oriented.jpg`;
  const ok = await new Promise(resolve => execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-noautorotate', '-i', target,
    '-frames:v', '1', '-vf', ORIENTATION_FILTERS[orientation], '-q:v', '3', '-y', turned],
    { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, error => resolve(!error)));
  if (ok && await wroteFrame(turned)) await fs.promises.rename(turned, target);
  else await fs.promises.rm(turned, { force: true }).catch(() => {});
}
// ExifTool takes paths through a UTF-8 argument file; see exifImageDimensions.
async function runExifToolOnFile(args, file, options = {}) {
  if (!fs.existsSync(MOSAIC_EXIFTOOL_PATH)) return null;
  const listPath = path.join(os.tmpdir(), `mosaic-exif-one-${process.pid}-${crypto.randomUUID()}.txt`);
  try {
    await fs.promises.writeFile(listPath, `${file}\n`, 'utf8');
    return await new Promise(resolve => execFile(MOSAIC_EXIFTOOL_PATH, ['-charset', 'filename=UTF8', ...args, '-@', listPath],
      { windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 * 1024, ...options },
      (error, stdout) => resolve(error ? null : stdout)));
  } finally { await fs.promises.rm(listPath, { force: true }).catch(() => {}); }
}
// Largest first is decided from the listing, not assumed: JpgFromRaw is the
// full-size render in most RAW formats, PreviewImage the fallback, and HEIC
// and PSD only carry a small ThumbnailImage / PhotoshopThumbnail.
const EMBEDDED_PREVIEW_TAGS = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage', 'PhotoshopThumbnail'];
// The embedded JPEG is stored in sensor orientation; the container's EXIF
// orientation says how it is meant to be seen.
const ORIENTATION_FILTERS = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
async function createThumbnailFromEmbeddedPreview(file, target, maximum) {
  if (!ffmpegPath) return false;
  const listing = await runExifToolOnFile(['-j', '-n', '-Orientation', ...EMBEDDED_PREVIEW_TAGS.map(tag => `-${tag}`)], file);
  let entry;
  try { entry = JSON.parse(String(listing || '[]'))[0]; } catch { return false; }
  if (!entry) return false;
  const bytes = tag => Number(String(entry[tag] || '').match(/Binary data (\d+) bytes/)?.[1] || 0);
  const tag = EMBEDDED_PREVIEW_TAGS.filter(name => bytes(name) > 0).sort((a, b) => bytes(b) - bytes(a))[0];
  if (!tag) return false;
  const preview = await runExifToolOnFile(['-b', `-${tag}`], file, { encoding: 'buffer' });
  if (!preview?.length) return false;
  // A HEIC or PSD often carries only a 160 px ThumbnailImage. That is better
  // than nothing for a grid card, but would be a blur in the Lightbox, so the
  // display variant declines a small preview and decodes the original.
  const size = imageSizeFromHeader(preview);
  if (maximum >= THUMBNAIL_DISPLAY_SIZE && size && Math.max(size.width, size.height) < 1024) return false;
  const previewPath = `${target}.preview.jpg`;
  try {
    await fs.promises.writeFile(previewPath, preview);
    const orient = ORIENTATION_FILTERS[Number(entry.Orientation)];
    const scale = `scale='min(${maximum},iw)':'min(${maximum},ih)':force_original_aspect_ratio=decrease`;
    // -noautorotate: the orientation is applied once, from the container, even
    // when the embedded JPEG carries a tag of its own.
    const ok = await new Promise(resolve => execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-noautorotate', '-i', previewPath,
      '-frames:v', '1', '-vf', orient ? `${orient},${scale}` : scale, '-q:v', '3', '-y', target],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, error => resolve(!error)));
    return ok && wroteFrame(target);
  } finally { await fs.promises.rm(previewPath, { force: true }).catch(() => {}); }
}
async function thumbnailSourceAvailable(profile, asset) {
  if (!asset?.id || !['image', 'video'].includes(asset.type)) return false;
  // Do not reveal a stale thumbnail for a deleted file. The cache is not a
  // source of truth: paths in Windows Recycle Bin, InDeck Discards, or paths
  // that no longer exist are permanently ineligible.
  if (asset.vault) return true;
  const assetPath = String(asset.path || '');
  if (!assetPath || isRecycleBinPath(assetPath) || isInDeckDiscardPath(profile, assetPath)) return false;
  return fs.promises.stat(assetPath).then(stat => stat.isFile()).catch(() => false);
}
// The filesystem timestamp doubles as the LRU access marker for pruning. An
// hour of resolution is plenty for a 2 GB budget, and it keeps a scroll
// through warm cards from issuing one metadata write per card.
const THUMBNAIL_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
async function existingThumbnailUrl(target) {
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat?.isFile() || !stat.size) return null;
  if (Date.now() - stat.mtimeMs > THUMBNAIL_TOUCH_INTERVAL_MS) void fs.promises.utimes(target, new Date(), new Date()).catch(() => {});
  return pathToFileURL(target).href;
}
async function cachedThumbnailUrl(profile, asset) {
  if (!(await thumbnailSourceAvailable(profile, asset))) return null;
  return existingThumbnailUrl(thumbnailPath(profile, asset));
}
async function createThumbnail(profile, asset) {
  if (!(await thumbnailSourceAvailable(profile, asset))) return null;
  const maximum = thumbnailVariantSize(asset);
  const target = thumbnailPath(profile, asset);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp.jpg`;
  const cached = await existingThumbnailUrl(target);
  if (cached) return cached;
  try {
    await fs.promises.mkdir(thumbnailDirectory(profile), { recursive: true });
    if (asset.type === 'video') {
      if (!(await createVideoThumbnail(asset, temporary, maximum))) { await fs.promises.rm(temporary, { force: true }).catch(() => {}); return null; }
      await fs.promises.rename(temporary, target);
      void pruneThumbnailCache(profile);
      return pathToFileURL(target).href;
    }
    const wrote = asset.vault
      ? await createVaultStillThumbnail(asset, temporary, maximum)
      : asset.path && await createLocalStillThumbnail(asset.path, temporary, maximum);
    if (!wrote) {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
      return null;
    }
    await fs.promises.rename(temporary, target);
    void pruneThumbnailCache(profile);
    return pathToFileURL(target).href;
  } catch { await fs.promises.rm(temporary, { force: true }).catch(() => {}); return null; }
}
// Average colour of each media's thumbnail, used by the renderer to paint its
// placeholder before the thumbnail is decoded. It is derived from the cache,
// so it lives beside it rather than in the Library: a cache reset discards
// both, and a rescan cannot drop it. Keyed by media id and stamped with the
// revision it was measured from, so a changed file is measured again.
const thumbnailColorIndexes = new Map();
function thumbnailColorIndex(profile) {
  const key = String(profile?.id || DEFAULT_PROFILE_ID);
  let index = thumbnailColorIndexes.get(key);
  if (!index) {
    const file = path.join(thumbnailDirectory(profile), 'colors.json');
    index = { file, timer: null, entries: fs.promises.readFile(file, 'utf8').then(JSON.parse).then(value => value && typeof value === 'object' ? value : {}).catch(() => ({})) };
    thumbnailColorIndexes.set(key, index);
  }
  return index;
}
function scheduleThumbnailColorWrite(index) {
  if (index.timer) return;
  // Batch a scroll's worth of new colours into one atomic write.
  index.timer = setTimeout(async () => {
    index.timer = null;
    const temporary = `${index.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(index.file), { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify(await index.entries), 'utf8');
      await fs.promises.rename(temporary, index.file);
    } catch { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
  }, 2000);
}
// sRGB → CIE L*a*b* (D65), so colours are compared the way they look.
function rgbToLab(red, green, blue) {
  const linear = value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const r = linear(red), g = linear(green), b = linear(blue);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = value => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const toHex = (red, green, blue) => `#${[red, green, blue].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
/**
 * Average colour plus a palette of up to six dominant colours with the share
 * of the image each covers, from a 48×48 downscale (nativeImage bitmaps are
 * BGRA on Windows). Pixels are binned at 4 bits per channel and the bins,
 * largest first, are merged into clusters closer than ΔE 14 — enough to fold
 * a gradient into one colour without merging distinct hues.
 */
function measureThumbnailColors(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return null;
  const bitmap = image.resize({ width: 48, height: 48, quality: 'good' }).toBitmap();
  const bins = new Map();
  let red = 0, green = 0, blue = 0, count = 0;
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const b = bitmap[offset], g = bitmap[offset + 1], r = bitmap[offset + 2];
    red += r; green += g; blue += b; count += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key);
    if (bin) { bin.r += r; bin.g += g; bin.b += b; bin.n += 1; } else bins.set(key, { r, g, b, n: 1 });
  }
  if (!count) return null;
  const clusters = [];
  for (const bin of [...bins.values()].sort((left, right) => right.n - left.n)) {
    const lab = rgbToLab(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n);
    const near = clusters.find(cluster => Math.hypot(cluster.lab[0] - lab[0], cluster.lab[1] - lab[1], cluster.lab[2] - lab[2]) < 14);
    if (near) { near.r += bin.r; near.g += bin.g; near.b += bin.b; near.n += bin.n; }
    else clusters.push({ ...bin, lab });
  }
  const palette = clusters
    .sort((left, right) => right.n - left.n)
    .filter(cluster => cluster.n / count >= 0.03)
    .slice(0, 6)
    .map(cluster => [toHex(cluster.r / cluster.n, cluster.g / cluster.n, cluster.b / cluster.n), Math.round((cluster.n / count) * 1000) / 1000]);
  return { color: toHex(red / count, green / count, blue / count), palette };
}
// Entries measured before palettes existed carry only `color`; they are
// measured again (from the cached thumbnail) the next time they are served.
async function thumbnailColor(profile, asset, thumbnailUrl) {
  const index = thumbnailColorIndex(profile);
  const entries = await index.entries;
  const revision = thumbnailRevision(asset);
  const known = entries[asset.id];
  if (known?.revision === revision && Array.isArray(known.palette)) return known;
  // Thumbnails cached before this index existed are backfilled the first time
  // they are served. Decoding a ≤512 px JPEG is a millisecond or two.
  let measured = null;
  try { measured = measureThumbnailColors(fileURLToPath(thumbnailUrl)); } catch { /* Unreadable cache entry. */ }
  if (!measured) return null;
  entries[asset.id] = { revision, ...measured };
  scheduleThumbnailColorWrite(index);
  return entries[asset.id];
}
async function createThumbnails(profile, assets, requestId) {
  // Keep IPC payloads bounded; `scheduleThumbnail` is the profile-wide queue
  // that enforces decoding concurrency across all visible cards.
  const items = Array.isArray(assets) ? assets.slice(0, 50) : [];
  const output = {};
  const urls = await Promise.all(items.map(asset => scheduleThumbnail(profile, asset, requestId)));
  await Promise.all(urls.map(async (thumbnailUrl, index) => {
    if (!thumbnailUrl) return;
    const asset = items[index];
    const measured = await thumbnailColor(profile, asset, thumbnailUrl).catch(() => null);
    output[asset.id] = { url: thumbnailUrl, color: measured?.color || null, palette: measured?.palette || null };
  }));
  return output;
}
// Colour filtering needs a palette for media the user has not scrolled to.
// Those go through the ordinary thumbnail queue in its buffer lane at the far
// end of the distance order, so visible cards are always served first and a
// cached thumbnail is reused rather than decoded again.
async function analyzeThumbnailColors(profile, assets, requestId) {
  const items = (Array.isArray(assets) ? assets.slice(0, 50) : []).filter(asset => ['image', 'video'].includes(asset?.type));
  const entries = await thumbnailColorIndex(profile).entries;
  const output = {};
  await Promise.all(items.map(async asset => {
    const known = entries[asset.id];
    if (known?.revision === thumbnailRevision(asset) && Array.isArray(known.palette)) { output[asset.id] = known; return; }
    // Any size already on disk measures the same; only build one when none is.
    let url = null;
    if (await thumbnailSourceAvailable(profile, asset)) {
      for (const variant of [320, 160, 512]) {
        url = await existingThumbnailUrl(thumbnailPath(profile, { ...asset, thumbnailSize: variant }));
        if (url) break;
      }
    }
    url ||= await scheduleThumbnail(profile, { ...asset, thumbnailSize: 160, thumbnailPriority: 'buffer', thumbnailDistance: Number.MAX_SAFE_INTEGER }, requestId);
    const measured = url && await thumbnailColor(profile, asset, url).catch(() => null);
    // Unreadable media still answer, so the renderer does not ask again.
    output[asset.id] = measured || { revision: thumbnailRevision(asset), color: null, palette: [] };
  }));
  return output;
}
// "Regenerate thumbnail": a bad cover or a thumbnail made before a codec was
// installed is otherwise kept until the file changes. Remove every variant
// and the measured colour; the next request rebuilds them.
async function regenerateThumbnails(profile, assets) {
  const items = Array.isArray(assets) ? assets.slice(0, 500) : [];
  const index = thumbnailColorIndex(profile);
  const entries = await index.entries;
  await Promise.all(items.map(asset => Promise.all(THUMBNAIL_VARIANTS.map(variant =>
    fs.promises.rm(thumbnailPath(profile, { ...asset, thumbnailSize: variant }), { force: true }).catch(() => {})))));
  for (const asset of items) delete entries[asset.id];
  if (items.length) scheduleThumbnailColorWrite(index);
  return items.length;
}
// The whole index, so placeholders are coloured from the first frame of a
// Gallery rather than only once each card's thumbnail request settles.
async function thumbnailColors(profile) {
  return thumbnailColorIndex(profile).entries;
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
const mosaicImageIdCache = new Map();

function mosaicImageIdFromMetadata(tags) {
  const values = [];
  for (const [key, value] of Object.entries(tags || {})) {
    if (!/(?:^|:)MediaId$/i.test(key) && key !== 'MediaId') continue;
    values.push(...(Array.isArray(value) ? value : [value]));
  }
  for (const value of values) {
    const match = String(value || '').match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}
function isMetadataImage(filePath) {
  return metadataImageExtensions.has(path.extname(String(filePath || '')).toLowerCase());
}
function runMosaicExifTool(args) {
  return new Promise((resolve, reject) => {
    execFile(MOSAIC_EXIFTOOL_PATH, ['-config', MOSAIC_XMP_CONFIG_PATH, ...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message || 'ExifTool failed')));
      else resolve(String(stdout || ''));
    });
  });
}
async function readMosaicImageMetadata(filePath) {
  const output = await runMosaicExifTool(['-json', '-XMP-mosaic:MediaId', filePath]);
  const document = JSON.parse(output);
  return mosaicImageIdFromMetadata(Array.isArray(document) ? document[0] : null);
}
/**
 * Read the portable Media ID of many images at once. Starting one ExifTool
 * process per file made a rescan of a large folder take minutes — and a
 * rescan runs before the window opens whenever a source needs re-indexing.
 * Paths travel through a UTF-8 argument file for the same reason as in
 * exifImageDimensions. Returns normalized path -> `mosaic:<id>`.
 */
async function batchMosaicImageIds(files) {
  const found = new Map();
  if (!files.length || !fs.existsSync(MOSAIC_EXIFTOOL_PATH)) return found;
  const chunks = [];
  for (let index = 0; index < files.length; index += 140) chunks.push(files.slice(index, index + 140));
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const chunkIndex = cursor++;
      const batch = chunks[chunkIndex];
      const listPath = path.join(os.tmpdir(), `mosaic-ids-${process.pid}-${chunkIndex}-${Date.now()}.txt`);
      let output = '[]';
      try {
        await fs.promises.writeFile(listPath, `${batch.join('\n')}\n`, 'utf8');
        output = await new Promise(resolve => execFile(
          MOSAIC_EXIFTOOL_PATH,
          ['-config', MOSAIC_XMP_CONFIG_PATH, '-charset', 'filename=UTF8', '-json', '-XMP-mosaic:MediaId', '-@', listPath],
          { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
          (_error, stdout) => resolve(stdout || '[]'),
        ));
      } catch { /* The files of this batch fall back to one-by-one reads. */ }
      await fs.promises.rm(listPath, { force: true }).catch(() => {});
      try {
        for (const entry of JSON.parse(output)) {
          const id = mosaicImageIdFromMetadata(entry);
          if (id && entry.SourceFile) found.set(normalizedPath(entry.SourceFile), id);
        }
      } catch { /* A corrupt answer keeps the slow path for this batch. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
  return found;
}
/**
 * Give many images their portable Media ID in a few ExifTool runs. Stamping
 * one file at a time cost three processes per image (read, write, read back),
 * so the first scan of a large folder took minutes. Each file gets its own
 * `-execute` group in one argument file; the result is then read back in a
 * batch, and only what was really written counts. Returns path -> id.
 */
async function batchStampMosaicImageIds(files) {
  if (!files.length || !fs.existsSync(MOSAIC_EXIFTOOL_PATH)) return new Map();
  const chunks = [];
  for (let index = 0; index < files.length; index += 100) chunks.push(files.slice(index, index + 100));
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const chunkIndex = cursor++;
      const batch = chunks[chunkIndex];
      const listPath = path.join(os.tmpdir(), `mosaic-stamp-${process.pid}-${chunkIndex}-${Date.now()}.txt`);
      try {
        const lines = batch.flatMap(file => [`-XMP-mosaic:MediaId=${crypto.randomUUID().toLowerCase()}`, file, '-execute']);
        await fs.promises.writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');
        await new Promise(resolve => execFile(
          MOSAIC_EXIFTOOL_PATH,
          // -common_args applies to every -execute group and must come last.
          ['-config', MOSAIC_XMP_CONFIG_PATH, '-@', listPath, '-common_args', '-charset', 'filename=UTF8', '-overwrite_original', '-P'],
          { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
          () => resolve(),
        ));
      } catch { /* Whatever was not written keeps a path-based id. */ }
      await fs.promises.rm(listPath, { force: true }).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, worker));
  return batchMosaicImageIds(files);
}
async function mosaicImageIdFor(filePath) {
  if (!isMetadataImage(filePath)) return null;
  let stat;
  try { stat = await fs.promises.stat(filePath); }
  catch { return null; }
  const cacheKey = `${normalizedPath(filePath)}\0${stat.size}:${stat.mtimeMs}`;
  if (mosaicImageIdCache.has(cacheKey)) return mosaicImageIdCache.get(cacheKey);
  try {
    const existing = await readMosaicImageMetadata(filePath);
    if (existing) {
      mosaicImageIdCache.set(cacheKey, existing);
      return existing;
    }
    const generated = crypto.randomUUID().toLowerCase();
    // Mosaic owns this custom XMP namespace, so no user/photographer metadata
    // is overwritten to establish the portable Media ID.
    await runMosaicExifTool(['-overwrite_original', '-P', `-XMP-mosaic:MediaId=${generated}`, filePath]);
    const confirmed = await readMosaicImageMetadata(filePath);
    if (!confirmed) return null;
    mosaicImageIdCache.set(cacheKey, confirmed);
    return confirmed;
  } catch {
    // Unsupported/readonly formats must remain usable through the legacy
    // source-plus-relative-path identity layer.
    mosaicImageIdCache.set(cacheKey, null);
    return null;
  }
}
async function assetIdForMedia(source, relativePath, filePath) {
  // Never stamp a portable Media ID into a file a Vault owns. Establishing one
  // rewrites the plaintext copy, so the next unlock finds the folder's file no
  // longer matching the encrypted original, declines to overwrite it and keeps
  // a second "-restored-" copy instead — which the following lock then
  // encrypts as well. That loop is how a vault fills with twins of photos it
  // already holds, identical but for the id written into them.
  // A Vault-backed source keys on its path anyway, exactly as the Vault's own
  // listing does, so identity also stops shifting between locked and unlocked.
  if (source?.vaultBridgeId) return assetIdFor(source, relativePath);
  const mosaicImageId = await mosaicImageIdFor(filePath);
  return mosaicImageId ? `mosaic:${mosaicImageId}` : assetIdFor(source, relativePath);
}
function runFileCommand(command, args) {
  return new Promise(resolve => execFile(command, args, { windowsHide: true }, (error, stdout) => resolve({ error, stdout: String(stdout || '') })));
}
async function registryApplicationPath(executable) {
  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
    `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
  ];
  for (const key of keys) {
    const result = await runFileCommand('reg', ['query', key, '/ve']);
    const found = result.stdout.match(/REG_SZ\s+(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
    if (found && fs.existsSync(found)) return found;
  }
  return null;
}
async function detectBrowsers() {
  const programFiles = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const definitions = [
    { id: 'chrome', name: 'Google Chrome', executable: 'chrome.exe', folders: ['Google\\Chrome\\Application\\chrome.exe'] },
    { id: 'edge', name: 'Microsoft Edge', executable: 'msedge.exe', folders: ['Microsoft\\Edge\\Application\\msedge.exe'] },
    { id: 'brave', name: 'Brave', executable: 'brave.exe', folders: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'] },
  ];
  return Promise.all(definitions.map(async (browser) => {
    const registryPath = await registryApplicationPath(browser.executable);
    const knownPath = registryPath || programFiles
      .flatMap(folder => browser.folders.map(relative => path.join(folder, relative)))
      .find(candidate => fs.existsSync(candidate)) || null;
    return { id: browser.id, name: browser.name, installed: Boolean(knownPath), path: knownPath };
  }));
}
async function openExtensionInstall(browserId) {
  const browser = (await detectBrowsers()).find(item => item.id === String(browserId));
  if (!browser?.installed) throw new Error('Browser is not installed');
  // Chromium browsers require the user to approve the store installation. The
  // app deliberately opens the official page instead of changing browser
  // profiles or policies behind the user’s back.
  const launched = await runFileCommand(browser.path, [EXTENSION_STORE_URL]);
  if (launched.error) await shell.openExternal(EXTENSION_STORE_URL);
  return { opened: true, storeUrl: EXTENSION_STORE_URL };
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
    const document = JSON.parse(await fs.promises.readFile(VAULT_TUNNEL_FILE, 'utf8'));
    return Array.isArray(document?.vaults) ? document.vaults.filter(bridge => bridge?.id) : [];
  } catch { return []; }
}
function isAutomaticallyAttachedVaultSource(source) {
  // Earlier builds copied every record from the machine-wide Vault tunnel into
  // every Profile and used this dedicated id shape. A Vault is only a
  // discoverable source; it belongs to a Profile only after that Profile adds
  // its folder as a Media Source. Keep manually added sources (src-…) intact.
  return String(source?.id || '').startsWith('vault:');
}
function removeAutomaticallyAttachedVaultSources(data) {
  const removedSources = (data.sources || []).filter(isAutomaticallyAttachedVaultSource);
  if (!removedSources.length) return false;
  const removedIds = new Set(removedSources.map(source => String(source.id)));
  const removedAssetIds = new Set(removedSources.flatMap(source => (source.assets || []).map(asset => String(asset.id))));
  data.sources = (data.sources || []).filter(source => !removedIds.has(String(source.id)));
  data.librarySourceIds = (data.librarySourceIds || []).map(String).filter(id => !removedIds.has(id));
  data.mainSourceIds = (data.mainSourceIds || []).map(String).filter(id => !removedIds.has(id));
  for (const gallery of [...(data.collections || []), ...(data.discardedGalleries || [])]) {
    gallery.sourceIds = (gallery.sourceIds || []).map(String).filter(id => !removedIds.has(id));
  }
  removeLibraryAssetReferences(data, removedAssetIds);
  return true;
}
async function removeAutomaticallyAttachedVaultSourcesFromProfiles() {
  const registry = await readProfileRegistry();
  for (const profile of registry.profiles) {
    const data = await readStore(profile);
    if (removeAutomaticallyAttachedVaultSources(data)) await writeStore(profile, data);
  }
}
async function reconcileVaultBridgeSources(profile, data) {
  // The tunnel is global to the Windows user, not to a Mosaic Profile. Never
  // turn tunnel discovery into a Profile membership. This function only keeps
  // an existing, manually linked Vault source current when its bridge moves or
  // its in-memory catalog is empty.
  const removedAutomaticSources = removeAutomaticallyAttachedVaultSources(data);
  const bridges = await readVaultBridges();
  if (!bridges.length) return removedAutomaticSources;
  let changed = removedAutomaticSources;
  for (const source of data.sources || []) {
    if (!source?.vaultBridgeId) continue;
    const bridge = bridges.find(item => String(item.id) === String(source.vaultBridgeId));
    if (!bridge) continue;
    const folder = String(bridge.folder || '').trim();
    if (!folder) continue;
    if (normalizeFolder(source.path) !== normalizeFolder(folder)) {
      source.path = folder;
      source.name = path.basename(folder) || source.name;
      changed = true;
    }
    const tracking = bridgeTracking(bridge);
    if (JSON.stringify(source.tracking || null) !== JSON.stringify(tracking || null)) {
      source.tracking = tracking;
      changed = true;
    }
    if ((source.assets || []).length === 0) {
      try {
        const result = await scanSource(profile, source);
        const assets = result.assets || [];
        if (JSON.stringify(source.assets || []) !== JSON.stringify(assets)) {
          source.assets = assets;
          changed = true;
        }
      } catch { /* Keep the last catalog when the Vault is temporarily offline. */ }
    }
  }
  return changed;
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
/**
 * Dimensions straight out of an image header. A locked Vault has no file on
 * disk for ExifTool to read, and its listing carries no dimensions, so this is
 * the only way a locked folder can lay out at true aspect ratios instead of
 * the 4:3 fallback. Reading the header alone keeps it to one bounded range
 * request per file rather than downloading the media.
 */
function imageSizeFromHeader(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 10 && buffer.slice(0, 3).toString('latin1') === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length > 26 && buffer.slice(0, 2).toString('latin1') === 'BM') {
    return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (buffer.length > 30 && buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buffer.slice(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      // SOF0–SOF15 carry the frame size; DHT/JPG/DAC are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}
/**
 * Dimensions for video a Vault holds. There is no file on disk and no header
 * this process can parse, but ffmpeg reads the Vault's HTTP URL directly and
 * prints the stream geometry before decoding anything, so one ranged read per
 * clip is enough. Without it every vaulted video stayed on the 4:3 fallback
 * and a justified row laid them all out as identical rectangles.
 */
function videoSizeFromUrl(contentUrl) {
  if (!ffmpegPath) return Promise.resolve(null);
  return new Promise(resolve => execFile(
    ffmpegPath,
    ['-hide_banner', '-i', contentUrl],
    { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    (_error, _stdout, stderr) => {
      const text = String(stderr || '');
      const stream = text.match(/Video:.*?[ ,](\d{2,5})x(\d{2,5})/);
      if (!stream) return resolve(null);
      const width = Number(stream[1]);
      const height = Number(stream[2]);
      if (!(width > 0 && height > 0)) return resolve(null);
      // A phone clip filmed upright is stored landscape plus a rotation.
      const rotation = Math.abs(Number((text.match(/rotation of (-?[\d.]+) degrees/) || [])[1] ?? (text.match(/^\s*rotate\s*:\s*(-?\d+)/m) || [])[1] ?? 0)) % 180;
      resolve(rotation === 90 ? { width: height, height: width } : { width, height });
    },
  ));
}
async function fillVaultVideoDimensions(assets) {
  const pending = assets.filter(asset => asset.vault && asset.contentUrl && !hasUsableAspect(asset) && asset.type === 'video');
  if (!pending.length) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const asset = pending[cursor++];
      const size = await videoSizeFromUrl(asset.contentUrl).catch(() => null);
      if (size) { asset.width = size.width; asset.height = size.height; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
}
/**
 * The first `limit` bytes of a URL, and never more: the stream is cancelled
 * once enough has arrived, so a server that ignores the Range header costs
 * one header's worth of transfer instead of the whole file.
 */
async function readUrlHead(url, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` }, signal: controller.signal });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    return Buffer.concat(chunks).subarray(0, limit);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function fillVaultImageDimensions(assets) {
  const pending = assets.filter(asset => asset.vault && asset.contentUrl && !hasUsableAspect(asset)
    && imageExtensions.has(path.extname(asset.name || '').toLowerCase()));
  if (!pending.length) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const asset = pending[cursor++];
      try {
        // Most headers sit in the first 64 KB; a JPEG with a large embedded
        // preview or colour profile can push its frame header further out.
        let size = imageSizeFromHeader((await readUrlHead(asset.contentUrl, 64 * 1024)) || Buffer.alloc(0));
        if (!size) size = imageSizeFromHeader((await readUrlHead(asset.contentUrl, 1024 * 1024)) || Buffer.alloc(0));
        if (size?.width > 0 && size?.height > 0) { asset.width = size.width; asset.height = size.height; }
      } catch { /* One unreadable file simply keeps the safe fallback ratio. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
}
/**
 * Measure, off the startup path, every Vault media whose aspect ratio is
 * still unknown, then merge just those dimensions into the stored Library and
 * hand them to the open window. A Vault listing carries no dimensions, so
 * without this a vaulted Gallery laid every media out on the 4:3 fallback and
 * a justified layout looked like a plain grid.
 *
 * The store is re-read right before each merge and only width/height are
 * written, so edits made while the (possibly long) measuring ran are kept.
 * Each media is tried once per session, so an unreadable file is not
 * re-fetched over and over.
 */
const vaultDimensionRuns = new Map();
const vaultDimensionAttempted = new Map();
function scheduleVaultDimensionFill(profile) {
  if (!profile?.id) return;
  const running = vaultDimensionRuns.get(profile.id);
  if (running) { running.again = true; return; }
  const run = { again: false };
  vaultDimensionRuns.set(profile.id, run);
  void (async () => {
    try {
      do {
        run.again = false;
        await fillMissingVaultDimensions(profile);
      } while (run.again);
    } catch (error) {
      console.warn('Could not measure Vault media:', error.message);
    } finally {
      vaultDimensionRuns.delete(profile.id);
    }
  })();
}
async function fillMissingVaultDimensions(profile) {
  const attempted = vaultDimensionAttempted.get(profile.id) || new Set();
  vaultDimensionAttempted.set(profile.id, attempted);
  const data = await readStore(profile);
  const pending = [];
  for (const source of data.sources || []) {
    for (const asset of source.assets || []) {
      if (!asset?.vault || !asset.contentUrl || hasUsableAspect(asset) || attempted.has(String(asset.id))) continue;
      attempted.add(String(asset.id));
      pending.push({ ...asset });
    }
  }
  if (!pending.length) return;
  // Work in slices so a large Vault starts laying out correctly long before
  // the last file is measured.
  for (let offset = 0; offset < pending.length; offset += 120) {
    const slice = pending.slice(offset, offset + 120);
    await fillVaultImageDimensions(slice);
    await fillVaultVideoDimensions(slice);
    const measured = new Map(slice.filter(hasUsableAspect).map(asset => [String(asset.id), { width: Number(asset.width), height: Number(asset.height) }]));
    if (!measured.size) continue;
    const fresh = await readStore(profile);
    let changed = false;
    for (const source of fresh.sources || []) {
      for (const asset of source.assets || []) {
        const size = measured.get(String(asset?.id));
        if (!size || hasUsableAspect(asset)) continue;
        asset.width = size.width;
        asset.height = size.height;
        changed = true;
      }
    }
    if (changed) await writeStore(profile, fresh);
    broadcast(profile.id, 'media:dimensions', Object.fromEntries(measured));
  }
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

function hasUsableAspect(asset) {
  return Number(asset?.width) > 4 && Number(asset?.height) > 3;
}
/**
 * An aspect ratio is a property of the media, not of how the scan happened to
 * reach it. A Vault listing carries no dimensions at all, so without this a
 * locked folder laid every one of its media out on the 4:3 fallback, and each
 * lock/unlock toggle threw away the ratios the other mode had just measured —
 * which also made the next unlock re-run ExifTool over the whole folder.
 */
function carryForwardAspect(previousAssets, assets) {
  if (!assets.length) return assets;
  const known = new Map();
  for (const asset of previousAssets || []) {
    if (hasUsableAspect(asset)) known.set(normalizedPath(asset.path), { width: Number(asset.width), height: Number(asset.height) });
  }
  if (!known.size) return assets;
  for (const asset of assets) {
    if (hasUsableAspect(asset)) continue;
    const dimensions = known.get(normalizedPath(asset.path));
    if (dimensions) { asset.width = dimensions.width; asset.height = dimensions.height; }
  }
  return assets;
}

function exifImageDimensions(files) {
  if (!files.length || !fs.existsSync(MOSAIC_EXIFTOOL_PATH)) return Promise.resolve(new Map());
  // Batch the work rather than reading one file per process. Three workers
  // are enough to avoid a huge initial Gallery blocking on one serial
  // process, without saturating disk I/O alongside thumbnail generation.
  const chunks = [];
  for (let index = 0; index < files.length; index += 140) chunks.push(files.slice(index, index + 140));
  const dimensions = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const batch = chunks[cursor++];
      // Paths must reach ExifTool through a UTF-8 argument file. On Windows a
      // command line arrives in the system codepage, so an accented or CJK
      // filename came back with a mangled SourceFile ("Pornó" as "Porn?").
      // Dimensions are keyed on that value, so every such file read its real
      // size and then had it thrown away for failing to match any asset —
      // which is what left those media on the 4:3 fallback ratio. Passing
      // `-charset filename=UTF8` on the command line does not fix it: ExifTool
      // then cannot find the files at all.
      const listPath = path.join(os.tmpdir(), `mosaic-exif-${process.pid}-${cursor}-${Date.now()}.txt`);
      let output = '[]';
      try {
        await fs.promises.writeFile(listPath, `${batch.join('\n')}\n`, 'utf8');
        output = await new Promise(resolve => execFile(
          MOSAIC_EXIFTOOL_PATH,
          ['-charset', 'filename=UTF8', '-j', '-n', '-ImageWidth', '-ImageHeight', '-ImageSize', '-Orientation', '-Rotation', '-Duration', '-@', listPath],
          { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
          (_error, stdout) => resolve(stdout || '[]'),
        ));
      } catch { /* A batch that cannot be listed keeps the safe fallback. */ }
      await fs.promises.rm(listPath, { force: true }).catch(() => {});
      try {
        for (const entry of JSON.parse(output)) {
          // The composite ImageSize is the full image for RAW formats, whose
          // first IFD often describes only the embedded thumbnail.
          const composite = String(entry.ImageSize || '').match(/^(\d+)[x ](\d+)$/);
          const width = Number(composite?.[1] || entry.ImageWidth || 0);
          const height = Number(composite?.[2] || entry.ImageHeight || 0);
          // Seconds for a video; ExifTool reports it with -n as a plain number.
          const duration = Number(entry.Duration) > 0 ? Math.round(Number(entry.Duration) * 1000) / 1000 : 0;
          const orientation = Number(entry.Orientation || 1);
          // EXIF orientations 5–8 rotate the displayed image by 90/270°.
          // ImageWidth/ImageHeight alone describes the encoded bitmap, not
          // the aspect ratio seen by Chromium and the user. A video carries
          // the same idea as a rotation matrix instead — a phone clip filmed
          // upright is stored landscape and would otherwise lay out sideways.
          const rotation = Math.abs(Number(entry.Rotation || 0)) % 180;
          const rotated = (orientation >= 5 && orientation <= 8) || rotation === 90;
          if (!entry.SourceFile) continue;
          if (width > 0 && height > 0) dimensions.set(normalizedPath(entry.SourceFile), { ...(rotated ? { width: height, height: width } : { width, height }), duration });
          else if (duration) dimensions.set(normalizedPath(entry.SourceFile), { duration });
        }
      } catch { /* A corrupt media file simply keeps the safe fallback ratio. */ }
    }
  };
  return Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker)).then(() => dimensions);
}

async function scanDirectory(folder, source) {
  // A folder in the Windows Recycle Bin is deleted content, not a renamed
  // source. Never walk it, even when its NTFS id is still queryable.
  if (!folder || isRecycleBinPath(folder)) return [];
  const files = [];
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
      files.push({ fullPath, name: entry.name });
    }
  }
  // Stat in parallel: a sequential walk paid one disk round trip per file.
  const stats = await Promise.all(files.map(file => fs.promises.stat(file.fullPath).catch(() => null)));
  // Media whose file is unchanged since the last scan keep the id that scan
  // recorded. A portable Media ID lives inside the file, and writing it keeps
  // the file's timestamp (-P), so the same path, size and time mean the
  // same id — no need to start ExifTool for it again.
  const known = new Map((source?.assets || []).map(asset => [normalizedPath(asset.path), asset]));
  const ids = new Map();
  const unread = [];
  files.forEach((file, index) => {
    const stat = stats[index];
    if (!stat) return;
    const key = normalizedPath(file.fullPath);
    const previous = known.get(key);
    if (!source?.vaultBridgeId && isMetadataImage(file.fullPath)) {
      const unchanged = previous && String(previous.id || '').startsWith('mosaic:')
        && Number(previous.modified) === stat.mtimeMs
        && (previous.size === undefined || Number(previous.size) === stat.size);
      if (unchanged) ids.set(key, String(previous.id));
      else unread.push(file.fullPath);
    }
  });
  // Everything else is read in a few batched ExifTool runs, and only media
  // that still carry no id at all are stamped one by one below.
  const batched = await batchMosaicImageIds(unread);
  for (const [key, mosaicId] of batched) ids.set(key, `mosaic:${mosaicId}`);
  // Images that carry no id yet are stamped together, not one by one.
  const unstamped = unread.filter(file => !batched.has(normalizedPath(file)));
  const stamped = await batchStampMosaicImageIds(unstamped);
  for (const [key, mosaicId] of stamped) ids.set(key, `mosaic:${mosaicId}`);
  // Any that could not take one (read-only, unsupported) keep the path-based
  // id at once instead of retrying the slow per-file route.
  const unstampable = new Set(unstamped.map(normalizedPath).filter(key => !stamped.has(key)));
  const results = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const stat = stats[index];
    if (!stat) continue;
    try {
      const relativePath = path.relative(folder, file.fullPath).replace(/\\/g, '/');
      const key = normalizedPath(file.fullPath);
      const id = ids.get(key) || (unstampable.has(key) ? assetIdFor(source, relativePath) : await assetIdForMedia(source, relativePath, file.fullPath));
      results.push({ id, path: file.fullPath, relativePath, name: file.name, type: imageExtensions.has(path.extname(file.name).toLowerCase()) ? 'image' : 'video', modified: stat.mtimeMs, size: stat.size });
    } catch { /* skipped */ }
  }
  // Aspect ratio belongs to the source metadata, never to the thumbnail.
  // Preserve previous values during an ordinary rescan and index only media
  // that has not had a real image dimension recorded yet.
  const previous = new Map((Number(source?.aspectIndexVersion || 0) >= ASPECT_INDEX_VERSION ? source.assets || [] : [])
    .filter(hasUsableAspect)
    .map(asset => [normalizedPath(asset.path), { width: Number(asset.width), height: Number(asset.height), duration: asset.duration }]));
  // Video needs a real aspect ratio just as much as an image does. Excluding
  // it here left every clip on the 4:3 fallback, so a justified row laid them
  // out as identical rectangles no matter their true shape. A video indexed
  // before durations were recorded is read once more for its duration; a
  // duration of 0 means "read, unknown" and is not retried.
  const missing = results.filter(asset => {
    const known = previous.get(normalizedPath(asset.path));
    return !known || (asset.type === 'video' && known.duration === undefined);
  });
  const detected = await exifImageDimensions(missing.map(asset => asset.path));
  // A few valid files have metadata that ExifTool cannot read (and filenames
  // with unusual legacy encoding can be omitted from a batch response).
  // Decode only those leftovers from the original file — never infer layout
  // dimensions from a generated thumbnail.
  for (const asset of missing) {
    // Only a still can be decoded this way; a video keeps the ExifTool value.
    // A RAW, HEIC, TIFF or PSD original is tens of megabytes that nativeImage
    // cannot read anyway, so it is not decoded synchronously here either.
    if (asset.type !== 'image' || isDerivedImage(asset.path)) continue;
    if (detected.has(normalizedPath(asset.path))) continue;
    if (isSvg(asset.path)) {
      // ExifTool reports an SVG's width as written ("210mm", "100%"), which
      // reads as nothing; the markup's own width, height and viewBox do not.
      const size = svgDimensions(await readSvgHead(asset.path).catch(() => ''));
      if (size) detected.set(normalizedPath(asset.path), size);
      continue;
    }
    try {
      const image = nativeImage.createFromPath(asset.path);
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        if (width > 0 && height > 0) detected.set(normalizedPath(asset.path), { width, height });
      }
    } catch { /* Unreadable media keeps only the safe temporary ratio. */ }
  }
  const read = new Set(missing.map(asset => normalizedPath(asset.path)));
  for (const asset of results) {
    const key = normalizedPath(asset.path);
    const known = previous.get(key);
    const fresh = detected.get(key);
    const width = known?.width || fresh?.width;
    const height = known?.height || fresh?.height;
    if (width && height) { asset.width = width; asset.height = height; }
    if (asset.type === 'video') {
      const duration = read.has(key) ? Number(fresh?.duration || 0) : known?.duration;
      if (duration !== undefined) asset.duration = duration;
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
  // A Vault only serves its catalog over HTTP while its folder is locked.
  // Unlocking checks every file back out to the real folder and leaves that
  // listing empty, so a bridged source must never treat the Vault as its only
  // view: an empty or unreachable listing meant the source scanned to nothing,
  // which wiped its assets and stripped those media from every Gallery that
  // referenced them. Whichever of the two views actually holds the media wins.
  let assets = [];
  let servedByVault = false;
  if (bridge) {
    try { assets = await scanVaultDirectory(resolved.folder, bridge, normalized); } catch { assets = []; }
    servedByVault = assets.length > 0;
  }
  if (!assets.length) assets = await scanDirectory(resolved.folder, normalized);
  // Carry ratios over first: anything already measured in either mode costs
  // nothing here. Whatever a Vault listing still lacks is measured in the
  // background afterwards (see scheduleVaultDimensionFill): reading thousands
  // of files over the Vault bridge used to hold up the scan — and with it the
  // window opening — for minutes on a large Vault.
  carryForwardAspect(normalized.assets, assets);
  const result = { folder: resolved.folder, tracking, vaultBridgeId: bridge?.id || resolved.vaultBridgeId, vault: servedByVault, assets };
  await cacheSourceScan(profile, normalized, result);
  return result;
}

function replaceAssetIdInList(values, oldId, newId) {
  if (!Array.isArray(values)) return values;
  return [...new Set(values.map(value => String(value) === oldId ? newId : value))];
}
function mergeAssetMetadata(existing = {}, incoming = {}) {
  const merged = { ...incoming, ...existing };
  for (const key of ['tags', 'persons']) {
    if (Array.isArray(existing[key]) || Array.isArray(incoming[key])) {
      merged[key] = [...new Set([...(incoming[key] || []), ...(existing[key] || [])])];
    }
  }
  if (existing.tagGroups || incoming.tagGroups) {
    merged.tagGroups = { ...(incoming.tagGroups || {}), ...(existing.tagGroups || {}) };
    for (const key of new Set([...Object.keys(incoming.tagGroups || {}), ...Object.keys(existing.tagGroups || {})])) {
      merged.tagGroups[key] = [...new Set([...(incoming.tagGroups?.[key] || []), ...(existing.tagGroups?.[key] || [])])];
    }
  }
  return merged;
}
function remapLibraryAssetId(data, oldId, newId, sourceBeingScanned = null) {
  if (!oldId || !newId || oldId === newId) return false;
  let changed = false;
  for (const source of data.sources || []) {
    if (source === sourceBeingScanned) continue;
    for (const asset of source.assets || []) {
      if (String(asset.id) === oldId) { asset.id = newId; changed = true; }
    }
  }
  for (const gallery of [...(data.collections || []), ...(data.discardedGalleries || [])]) {
    for (const field of ['items', 'discardedIds', 'manualItemIds', 'extensionItemIds', 'excludedItemIds']) {
      const before = gallery[field];
      const next = replaceAssetIdInList(before, oldId, newId);
      if (JSON.stringify(before) !== JSON.stringify(next)) { gallery[field] = next; changed = true; }
    }
    if (String(gallery.coverId || '') === oldId) { gallery.coverId = newId; changed = true; }
    for (const group of gallery.groups || []) {
      const next = replaceAssetIdInList(group.assets, oldId, newId);
      if (JSON.stringify(group.assets) !== JSON.stringify(next)) { group.assets = next; changed = true; }
    }
  }
  for (const group of data.libraryGroups || []) {
    const next = replaceAssetIdInList(group.assets, oldId, newId);
    if (JSON.stringify(group.assets) !== JSON.stringify(next)) { group.assets = next; changed = true; }
  }
  if (data.assetMeta?.[oldId]) {
    data.assetMeta[newId] = mergeAssetMetadata(data.assetMeta[newId], data.assetMeta[oldId]);
    delete data.assetMeta[oldId];
    changed = true;
  }
  return changed;
}
function migrateScannedAssetIds(data, source, scanned) {
  if (!data || !source || !Array.isArray(scanned)) return scanned;
  const previousIds = new Map((source.assets || []).map(asset => [normalizedPath(asset.path), String(asset.id)]));
  for (const asset of scanned) {
    const previousId = previousIds.get(normalizedPath(asset.path));
    if (previousId && previousId !== String(asset.id)) remapLibraryAssetId(data, previousId, String(asset.id), source);
  }
  return scanned;
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
    const sourceRetired = !sourcePath || isRecycleBinPath(sourcePath) || isInDeckDiscardPath(profile, sourcePath);
    if (!sourceRetired && !await fs.promises.stat(sourcePath).then(stat => stat.isDirectory()).catch(() => false)) {
      // Unreachable is not deleted: an unplugged drive, a sleeping NAS or a
      // locked share looks exactly like this at startup. Keep the source, its
      // catalogue and its Gallery links so everything is back when it returns.
      continue;
    }
    if (sourceRetired) {
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
  // Same reasoning as the rescan path: a folder being unreachable right now
  // says nothing about whether the user still wants that media in a Gallery.
  // The source bookkeeping above is corrected, but the references stay.
  void missingAssetIds;
  return changed;
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
    fs.promises.mkdir(galleryDefaultSourcesPath(profile), { recursive: true }),
    fs.promises.mkdir(extensionImportsPath(profile), { recursive: true }),
    fs.promises.mkdir(discardsPath(profile), { recursive: true }),
  ]);
  await ensureProfileFolderIcon(indeckMediaPath(profile));
  return profile;
}
async function ensureProfileDefaultSaveSource(profile, data, { scan = true } = {}) {
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
  // Reading a Library snapshot must be metadata-only.  Recursive scans happen
  // at recovery/import/refresh time or after a watcher event, never merely
  // because React asks for the current state.
  if (scan) {
    const scanned = await scanDirectoryKeepingKnownIds(folder, source, data);
    if (JSON.stringify(source.assets || []) !== JSON.stringify(scanned)) { source.assets = scanned; changed = true; }
  }
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
    source = { id: PROFILE_MAIN_LIBRARY_SOURCE_ID, name: 'MosaicMedia', path: root, assets: [] };
    data.sources.push(source);
    changed = true;
  }
  if (source.path !== root) { source.path = root; changed = true; }
  if (!source.name || source.name === 'InDeckMedia') { source.name = 'MosaicMedia'; changed = true; }
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
  const scanned = (await scanDirectoryKeepingKnownIds(root, source, data)).filter(asset =>
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
function galleryDefaultSourcesPath(profile) { return path.join(indeckMediaPath(profile), 'Galleries'); }
function galleryDefaultSourcePathWithSuffix(profile, galleryName, index) {
  const base = `${safeFolderPart(galleryName)} Default Source`;
  return path.join(galleryDefaultSourcesPath(profile), index > 0 ? `${base} ${index}` : base);
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
  // Older extension builds created DMS folders at the MosaicMedia root, so the
  // folder may sit anywhere inside it — but never inside (or be) one of the
  // folders Mosaic itself owns.
  const protectedFolders = [galleryDefaultSourcesPath(profile), extensionImportsPath(profile), discardsPath(profile)];
  const isProtected = protectedFolders.some(owned => normalizedPath(owned) === normalizedPath(folder))
    || [extensionImportsPath(profile), discardsPath(profile)].some(owned => isPathInside(owned, folder));
  if (!String(sourceId || '').startsWith('indeck-gallery-default:') || !isPathInside(indeckMediaPath(profile), folder) || isProtected) {
    throw new Error('Only a Gallery Default Source inside MosaicMedia can be discarded');
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
  // All recognised media has moved to Discards. Whatever is left (formats the
  // scanner skips, files it could not stat, unreadable subfolders) goes to the
  // Recycle Bin with the folder rather than being deleted for good.
  await shell.trashItem(folder);
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
  const galleryRoot = galleryDefaultSourcesPath(profile);
  const managedPath = [preferredPath, current]
    .map(value => value ? String(value) : null)
    .find(value => value && isPathInside(galleryRoot, value));
  // A Gallery DMS always belongs inside MosaicMedia/Galleries. Older DMS
  // folders directly under the Library are moved into this parent folder;
  // external/stale paths are repaired into a new managed DMS there instead.
  const target = managedPath || await availableGalleryDefaultSourcePath(profile, data, gallery, current);
  const moved = current && normalizedPath(current) !== normalizedPath(target)
    ? await moveDirectoryIfNeeded(current, target)
    : false;
  await fs.promises.mkdir(target, { recursive: true });
  const source = existing || { id, name: 'Default Source', path: target, assets: [] };
  source.id = id;
  source.name = 'Default Source';
  source.path = target;
  if (moved && current) {
    source.assets = (source.assets || []).map(asset => ({
      ...asset,
      path: isPathInside(current, asset.path) ? path.join(target, path.relative(current, asset.path)) : asset.path,
    }));
  }
  source.assets = await scanDirectoryKeepingKnownIds(target, source, data);
  if (!existing) data.sources = [...(data.sources || []), source];
  gallery.defaultSourceId = id;
  gallery.defaultSourcePath = target;
  gallery.sourceIds = [...new Set([...(gallery.sourceIds || []).map(String), id])];
  gallery.items ||= [];
  const discarded = new Set((gallery.discardedIds || []).map(String));
  for (const asset of source.assets) if (!discarded.has(String(asset.id)) && !gallery.items.includes(asset.id)) gallery.items.push(asset.id);
  return source;
}
async function ensureDefaultSourcesForExistingGalleries(profile, data) {
  const before = JSON.stringify({
    sources: data.sources || [],
    collections: data.collections || [],
  });
  for (const gallery of data.collections || []) {
    await ensureGalleryDefaultSource(profile, data, gallery, gallery.defaultSourcePath);
  }
  return before !== JSON.stringify({
    sources: data.sources || [],
    collections: data.collections || [],
  });
}
async function scanDirectoryKeepingKnownIds(folder, source, data = null) {
  const scanned = await scanDirectory(folder, source);
  return migrateScannedAssetIds(data, source, scanned);
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
async function refreshTrackedSources(profile, folders = []) {
  // Scanning can take many seconds. Do it against a snapshot, then apply the
  // results to the library as it is *then*, inside the write queue: edits the
  // renderer saved while the scan ran are kept instead of being overwritten.
  const snapshot = await readStore(profile);
  const requested = new Set((Array.isArray(folders) ? folders : []).map(normalizedPath));
  const scanTargets = (snapshot.sources || []).filter(source => !requested.size || requested.has(normalizedPath(source.path)));
  const scans = new Map();
  for (const source of scanTargets) {
    if (isInDeckDiscardPath(profile, source.path)) continue;
    scans.set(String(source.id), await scanSource(profile, source));
  }
  const removedIds = new Set();
  await mutateStore(profile, data => applySourceScans(data, scans, removedIds));
  return { refreshedSourceIds: scanTargets.map(source => String(source.id)), removedAssetIds: [...removedIds] };
}
function applySourceScans(data, scans, removedIds) {
  const targets = (data.sources || []).filter(source => scans.has(String(source.id)));
  const addedIdsBySource = new Map();
  let changed = false;
  for (const source of targets) {
    const previousByPath = new Map((source.assets || []).map(asset => [normalizedPath(asset.path), String(asset.id)]));
    const previousIds = new Set(previousByPath.values());
    const result = scans.get(String(source.id));
    if (!result.folder) {
      // A source that cannot be reached and holds nothing has nothing to
      // index either. Without this, one missing empty folder sent the
      // Profile through a re-index before every single launch.
      if (!(source.assets || []).length && Number(source.aspectIndexVersion || 0) !== ASPECT_INDEX_VERSION && !source.vaultBridgeId) {
        source.aspectIndexVersion = ASPECT_INDEX_VERSION;
        changed = true;
      }
      continue;
    }
    // A source that held media and now scans to nothing is almost never a
    // deletion of every one of its files: a locked Vault, an unmounted drive,
    // a disconnected share and a renamed folder all look exactly like this.
    // Believing it purged the Gallery membership, tags and notes of every
    // media in that source — data no later rescan can rebuild, because it
    // never lived in the files. Keep the last known catalogue instead and let
    // a scan that can actually see the folder correct it.
    if ((source.assets || []).length > 0 && (result.assets || []).length === 0) continue;
    if (normalizedPath(source.path) !== normalizedPath(result.folder)) {
      source.path = result.folder;
      source.name = path.basename(result.folder) || source.name;
      changed = true;
    }
    if (result.tracking) source.tracking = result.tracking;
    if (result.vaultBridgeId) source.vaultBridgeId = result.vaultBridgeId;
    if (!result.vault && Number(source.aspectIndexVersion || 0) !== ASPECT_INDEX_VERSION) {
      source.aspectIndexVersion = ASPECT_INDEX_VERSION;
      changed = true;
    }
    const nextAssets = migrateScannedAssetIds(data, source, result.assets || []);
    const nextIds = new Set(nextAssets.map(asset => String(asset.id)));
    previousIds.forEach(id => { if (!nextIds.has(id)) removedIds.add(id); });
    addedIdsBySource.set(String(source.id), [...nextIds].filter(id => !previousIds.has(id)));
    if (JSON.stringify(source.assets || []) !== JSON.stringify(nextAssets)) { source.assets = nextAssets; changed = true; }
  }
  for (const gallery of data.collections || []) {
    const addedIds = (gallery.sourceIds || []).flatMap(sourceId => addedIdsBySource.get(String(sourceId)) || []);
    if (!addedIds.length) continue;
    gallery.items ||= [];
    const discarded = new Set((gallery.discardedIds || []).map(String));
    for (const assetId of addedIds) {
      if (discarded.has(assetId) || gallery.items.map(String).includes(assetId)) continue;
      gallery.items.push(assetId);
      const meta = (data.assetMeta ||= {})[assetId] ||= {};
      meta.tags ||= [];
      meta.persons ||= [];
      meta.tagGroups ||= {};
      for (const tag of gallery.defaultTags || []) if (!meta.tags.includes(tag)) meta.tags.push(tag);
      for (const person of gallery.defaultPersons || []) if (!meta.persons.includes(person)) meta.persons.push(person);
      for (const [groupId, values] of Object.entries(gallery.autoTagGroups || {})) {
        const key = String(groupId);
        const target = meta.tagGroups[key] ||= [];
        for (const value of values || []) if (!target.includes(value)) target.push(value);
      }
      changed = true;
    }
  }
  // Deliberately no removeLibraryAssetReferences here. Gallery membership,
  // tags and notes are the user's own work; a scan is only ever a report of
  // what one folder could see at one instant. A Vault mid-unlock lists a
  // fraction of its files, an unmounted drive lists none, and treating either
  // as "the user deleted these" destroyed work no rescan can rebuild — the
  // earlier guard for an empty result did not help, because a partial listing
  // is just as wrong and looks perfectly normal.
  // A reference to media that is genuinely gone costs nothing: the Gallery
  // renders from media that exists, so the id simply never resolves, and it
  // starts working again the moment the folder comes back. Removal now only
  // happens where the user actually asked for it.
  return changed;
}

async function ensureProfileAspectRatios(profile) {
  const data = await readStore(profile);
  const needsIndex = (data.sources || []).filter(source =>
    (!source.vaultBridgeId && Number(source.aspectIndexVersion || 0) < ASPECT_INDEX_VERSION)
    // Deliberately still image-only. A still that ExifTool cannot read is
    // recovered by the nativeImage fallback, so a missing ratio here means the
    // index really is incomplete. A video has no such fallback, so the same
    // test would make one unreadable clip re-scan the source on every launch;
    // picking video up is what the index version bump is for.
    // Vault media are measured in the background instead (see
    // scheduleVaultDimensionFill): a locked Vault serves them one HTTP read
    // at a time, which must never hold the window from opening.
    || (source.assets || []).some(asset => asset?.type === 'image' && !asset.vault && !hasUsableAspect(asset)),
  );
  if (!needsIndex.length) return false;
  // Run once before this Profile's Gallery is mounted. A justified layout must
  // have stable source aspect ratios from its first paint, not gradually turn
  // into equal cells as thumbnails happen to arrive during scrolling.
  // Only the sources that actually need it: one new, empty DefaultSave used
  // to send every source of the Profile through a full rescan first.
  await refreshTrackedSources(profile, needsIndex.map(source => source.path).filter(Boolean));
  return true;
}

function localMediaSource(profile, source) {
  return source && !source.vaultBridgeId && source.path && !isRecycleBinPath(source.path) && !isInDeckDiscardPath(profile, source.path);
}

function flattenedMediaOrder(data, candidateIds) {
  const candidates = new Set([...candidateIds].map(String));
  const metaOrder = id => Number(data.assetMeta?.[id]?.order || 0);
  const groups = (data.libraryGroups || [])
    .map(group => ({
      group,
      ids: (group.assets || []).map(String).filter(id => candidates.has(id)),
      order: Number(group.order || Math.max(0, ...(group.assets || []).map(id => metaOrder(String(id))))),
    }))
    .filter(item => item.ids.length > 0);
  const groupedIds = new Set(groups.flatMap(item => item.ids));
  const entries = [
    ...groups.map(item => ({ kind: 'group', order: item.order, ids: item.ids })),
    ...[...candidates].filter(id => !groupedIds.has(id)).map(id => ({ kind: 'media', order: metaOrder(id), ids: [id] })),
  ].sort((left, right) => right.order - left.order);
  const seen = new Set();
  return entries.flatMap(entry => entry.ids).filter(id => !seen.has(id) && seen.add(id));
}

function withoutMosaicOrderPrefix(fileName) {
  return String(fileName || '').replace(/^\d{4,8}\s+-\s+/, '');
}
async function reorderSourceMediaFiles(source, orderedIds) {
  if (!source?.path || !Array.isArray(orderedIds) || !orderedIds.length) return { renamed: [], skipped: [] };
  const assetsById = new Map((source.assets || []).map(asset => [String(asset.id), asset]));
  const planned = orderedIds.map(id => assetsById.get(String(id))).filter(asset => asset && !asset.vault && asset.path);
  if (!planned.length) return { renamed: [], skipped: [] };
  const width = Math.max(4, String(planned.length).length);
  const reserved = new Set();
  const plannedPaths = new Set(planned.map(asset => normalizedPath(asset.path)));
  const stages = [];
  const skipped = [], renamed = [];
  for (const [index, asset] of planned.entries()) {
    const currentPath = String(asset.path);
    const extension = path.extname(currentPath);
    const originalName = withoutMosaicOrderPrefix(path.basename(currentPath, extension)) || `media-${index + 1}`;
    const prefix = String(index + 1).padStart(width, '0');
    let candidate = path.join(source.path, `${prefix} - ${originalName}${extension}`);
    let duplicate = 2;
    while (reserved.has(normalizedPath(candidate)) || (!plannedPaths.has(normalizedPath(candidate)) && await fs.promises.access(candidate).then(() => true).catch(() => false))) {
      candidate = path.join(source.path, `${prefix} - ${originalName} (${duplicate++})${extension}`);
    }
    reserved.add(normalizedPath(candidate));
    if (normalizedPath(candidate) === normalizedPath(currentPath)) continue;
    stages.push({ asset, from: currentPath, to: candidate, temporary: path.join(source.path, `.__mosaic-order-${crypto.randomUUID()}${extension}`) });
  }
  // Rename through unique temporary names so swapping positions never collides
  // with a file that is waiting for its own new numeric prefix.
  for (const stage of stages) {
    try { await fs.promises.rename(stage.from, stage.temporary); }
    catch (error) { skipped.push({ assetId: stage.asset.id, reason: error.code || 'reorder-stage-failed' }); stage.failed = true; }
  }
  for (const stage of stages) {
    if (stage.failed) continue;
    try {
      await fs.promises.rename(stage.temporary, stage.to);
      stage.asset.path = stage.to;
      stage.asset.relativePath = path.basename(stage.to);
      renamed.push({ assetId: stage.asset.id, from: stage.from, to: stage.to });
    } catch (error) {
      skipped.push({ assetId: stage.asset.id, reason: error.code || 'reorder-failed' });
      try { await fs.promises.rename(stage.temporary, stage.from); } catch { /* Report the original failure above. */ }
    }
  }
  return { renamed, skipped };
}

async function syncMediaLocations(profile) {
  profile = await ensureProfileLibraryFolders(profile);
  const data = await readStore(profile);
  await ensureProfileDefaultSaveSource(profile, data);
  const moved = [], renamed = [], skipped = [], conflicts = [];

  // A physical file can have only one home. Ensure every Gallery has its DMS
  // first, then select it only when that Gallery is the file's sole owner.
  for (const gallery of data.collections || []) {
    try { await ensureGalleryDefaultSource(profile, data, gallery, gallery.defaultSourcePath); }
    catch (error) { skipped.push({ galleryId: gallery.id, reason: error.code || 'default-source-unavailable' }); }
  }
  const sourceById = new Map((data.sources || []).map(source => [String(source.id), source]));

  const assets = (data.sources || []).flatMap(source => (source.assets || []).map(asset => ({ source, asset })));
  for (const { source: origin, asset } of assets) {
    const assetId = String(asset.id);
    const assetPath = String(asset.path || '');
    if (!localMediaSource(profile, origin) || !assetPath || asset.vault || isRecycleBinPath(assetPath) || isInDeckDiscardPath(profile, assetPath)) {
      skipped.push({ assetId, reason: 'not-local' });
      continue;
    }
    const owners = (data.collections || []).filter(gallery =>
      !(gallery.discardedIds || []).map(String).includes(assetId) && (gallery.items || []).map(String).includes(assetId),
    );
    if (owners.length > 1) {
      conflicts.push({ assetId, reason: 'multiple-galleries', galleryIds: owners.map(gallery => String(gallery.id)) });
      continue;
    }
    const target = owners.length === 1
      ? sourceById.get(String(owners[0].defaultSourceId || galleryDefaultSourceId(owners[0].id)))
      : sourceById.get(WEB_IMPORTS_SOURCE_ID);
    if (!target?.path) { skipped.push({ assetId, reason: 'target-unavailable' }); continue; }
    const targetPath = path.join(target.path, path.basename(assetPath));
    if (normalizedPath(assetPath) === normalizedPath(targetPath)) { skipped.push({ assetId, reason: 'already-in-default-source' }); continue; }
    try {
      const [assetInfo, targetInfo, targetExists] = await Promise.all([
        fs.promises.stat(assetPath), fs.promises.stat(target.path), fs.promises.access(targetPath).then(() => true).catch(() => false),
      ]);
      if (!assetInfo.isFile() || !targetInfo.isDirectory()) { skipped.push({ assetId, reason: 'invalid-path' }); continue; }
      if (targetExists) { skipped.push({ assetId, reason: 'target-exists' }); continue; }
      await moveFileSafely(assetPath, targetPath);
      origin.assets = (origin.assets || []).filter(item => String(item.id) !== assetId);
      target.assets ||= [];
      target.assets.push({ ...asset, path: targetPath, relativePath: path.basename(targetPath) });
      moved.push({ assetId, from: assetPath, to: targetPath, galleryId: owners[0] ? String(owners[0].id) : null });
    } catch (error) { skipped.push({ assetId, reason: error.code || 'move-failed' }); }
  }
  // Folder ordering mirrors the Gallery's visible order. A Group occupies a
  // single position in that order, then expands to its members in group order.
  for (const gallery of data.collections || []) {
    const source = sourceById.get(String(gallery.defaultSourceId || galleryDefaultSourceId(gallery.id)));
    if (!source?.assets?.length) continue;
    const galleryIds = (gallery.items || [])
      .map(String)
      .filter(id => !(gallery.discardedIds || []).map(String).includes(id));
    const result = await reorderSourceMediaFiles(source, flattenedMediaOrder(data, galleryIds));
    renamed.push(...result.renamed);
    skipped.push(...result.skipped);
  }
  // Media that belongs only to Main Gallery uses DefaultSave. Keep its folder
  // just as readable as Gallery DMS folders, including Group placement.
  const mainSource = sourceById.get(WEB_IMPORTS_SOURCE_ID);
  if (mainSource?.assets?.length) {
    const ownedIds = new Set((data.collections || []).flatMap(gallery => (gallery.items || []).map(String)));
    const mainOnlyIds = (mainSource.assets || []).map(asset => String(asset.id)).filter(id => !ownedIds.has(id));
    const result = await reorderSourceMediaFiles(mainSource, flattenedMediaOrder(data, mainOnlyIds));
    renamed.push(...result.renamed);
    skipped.push(...result.skipped);
  }
  await writeStore(profile, data);
  return { moved, renamed, skipped, conflicts };
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
  source.assets = await scanDirectoryKeepingKnownIds(directory, source, data);
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
function nativeHostManifestPath(hostName = NATIVE_HOST_NAME) {
  const folder = app.isPackaged ? 'Mosaic' : 'MosaicTest';
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), folder, 'native-messaging', `${hostName}.json`);
}
function nativeHostLauncherPath(hostName = NATIVE_HOST_NAME) { return path.join(path.dirname(nativeHostManifestPath(hostName)), `${hostName}.cmd`); }
async function nativeHostExecutablePath() {
  if (app.isPackaged) {
    // Electron GUI mode does not provide a reliable binary stdin/stdout
    // channel for Chrome Native Messaging. Run the bundled headless worker
    // with Electron's Node runtime instead; it has no BrowserWindow, no
    // single-instance lock, and preserves protocol frames byte-for-byte.
    const launcher = nativeHostLauncherPath();
    const worker = path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar', 'extension', 'native-host.js');
    const content = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${app.getPath('exe')}" "${worker}" %*\r\n`;
    await fs.promises.mkdir(path.dirname(launcher), { recursive: true });
    await fs.promises.writeFile(launcher, content, 'utf8');
    return launcher;
  }
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
  const hostNames = app.isPackaged ? [NATIVE_HOST_NAME, LEGACY_NATIVE_HOST_NAME] : [NATIVE_HOST_NAME];
  const executable = await nativeHostExecutablePath();
  const registrations = [];
  for (const hostName of hostNames) {
    const manifestPath = nativeHostManifestPath(hostName);
    const manifest = {
      name: hostName,
    description: 'Mosaic profile-aware media importer',
      path: executable,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    };
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const registryKeys = [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`,
      `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${hostName}`,
    ];
    const result = await Promise.all(registryKeys.map(async key => {
      const command = await runFileCommand('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
      return { key, hostName, manifestPath, installed: !command.error };
    }));
    registrations.push(...result);
  }
  if (!registrations.some(item => item.installed)) throw new Error('Could not register the native messaging host');
  return { installed: true, manifestPaths: [...new Set(registrations.map(item => item.manifestPath))], registrations };
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
    const profiles = await Promise.all(registry.profiles
      .slice()
      .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
      .map(async profile => {
        const configured = isProfileReady(profile);
        const reachable = configured && await fs.promises.stat(profile.mediaPath).then(stat => stat.isDirectory()).catch(() => false);
        return {
          id: profile.id,
          name: profile.name,
          isDefault: Boolean(profile.isDefault),
          available: Boolean(reachable),
          reason: !configured
            ? 'Default Library Location has not been configured.'
            : reachable ? null : 'Mosaic cannot access this profile’s Library location.',
        };
      }));
    return {
      ok: true,
      profiles,
    };
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
  // Chrome already validates `allowed_origins` in the native-host manifest.
  // Electron production builds may omit the protocol-looking origin from
  // process.argv, so only reject an origin when one is actually available.
  if (origin && origin !== `chrome-extension://${EXTENSION_ID}/`) {
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
function readWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    const width = Math.round(Number(saved?.width));
    const height = Math.round(Number(saved?.height));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return {
      width: Math.max(1050, width),
      height: Math.max(700, height),
      x: Number.isFinite(Number(saved.x)) ? Math.round(Number(saved.x)) : undefined,
      y: Number.isFinite(Number(saved.y)) ? Math.round(Number(saved.y)) : undefined,
      isMaximized: Boolean(saved.isMaximized),
    };
  } catch { return null; }
}
function usableWindowState() {
  const saved = readWindowState();
  if (!saved) return { width: 1480, height: 920, isMaximized: false };
  const point = saved.x == null || saved.y == null ? null : { x: saved.x, y: saved.y };
  const display = point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay();
  const area = display.workArea;
  // A previously used monitor may have been disconnected. Keep the size in a
  // usable range and only restore coordinates that still land on a display.
  const isVisible = point && saved.x + 120 >= area.x && saved.x <= area.x + area.width - 120
    && saved.y + 80 >= area.y && saved.y <= area.y + area.height - 80;
  return {
    width: Math.min(saved.width, area.width),
    height: Math.min(saved.height, area.height),
    ...(isVisible ? { x: saved.x, y: saved.y } : {}),
    isMaximized: saved.isMaximized,
  };
}
function saveWindowState(window) {
  if (!window || window.isDestroyed()) return;
  const bounds = window.getNormalBounds();
  const snapshot = { ...bounds, isMaximized: window.isMaximized() };
  const temporary = `${WINDOW_STATE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // Persist synchronously on each native resize/move notification. Test
    // windows are intentionally closed forcefully between builds, so a
    // debounced asynchronous write can otherwise lose the last resize.
    fs.mkdirSync(path.dirname(WINDOW_STATE_FILE), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(temporary, WINDOW_STATE_FILE);
  } catch { /* Window state is a convenience, never a startup blocker. */ }
}
// Current display name per open Profile window; a rename updates it so a
// later page-title event does not bring the old name back.
const profileWindowNames = new Map();
// ---- Licensing -------------------------------------------------------------
// Mosaic is bought once and then unlocked for good, on up to two devices, with
// free updates. Until then it runs as a trial. Two kinds of key unlock it:
//
// - A Lemon Squeezy key, emailed by the card checkout. It is activated once
//   against the Lemon Squeezy license API, which also counts the devices, and
//   re-checked weekly so a refunded order stops working. An offline machine
//   keeps its activation: only an explicit "not valid" answer revokes it.
// - A "MOSAIC-" key signed with the seller's Ed25519 key
//   (scripts/issue-license.cjs) for sales made any other way. It is verified
//   offline against package.json → mosaicLicense.publicKey.
//
// A development run (`electron .`) is never locked, so the app the author
// works in daily cannot lock itself; MOSAIC_LICENSE_ENFORCE=1 tests the real
// behaviour.
const LICENSE_CONFIG = (() => {
  let config = {};
  try { config = require('./package.json').mosaicLicense || {}; } catch { config = {}; }
  // Test overrides. A packaged build ignores them: pointing it at another
  // license server or product would let any answer unlock it.
  if (!app.isPackaged) {
    const env = process.env;
    let bankTransfer = config.bankTransfer;
    try { if (env.MOSAIC_BANK_TRANSFER) bankTransfer = { ...bankTransfer, ...JSON.parse(env.MOSAIC_BANK_TRANSFER) }; } catch { /* Ignore a malformed override. */ }
    config = {
      ...config,
      testCheckoutUrl: env.MOSAIC_CHECKOUT_URL,
      licenseServer: env.MOSAIC_LICENSE_SERVER ?? config.licenseServer,
      publicKey: env.MOSAIC_LICENSE_PUBLIC_KEY ?? config.publicKey,
      testRegion: env.MOSAIC_LICENSE_REGION,
      bankTransfer,
      lemonSqueezy: { storeId: env.MOSAIC_LS_STORE_ID ?? config.lemonSqueezy?.storeId, productId: env.MOSAIC_LS_PRODUCT_ID ?? config.lemonSqueezy?.productId },
    };
  }
  return config;
})();
const LICENSE_TRIAL_DAYS = Number(LICENSE_CONFIG.trialDays) > 0 ? Number(LICENSE_CONFIG.trialDays) : 30;
const LICENSE_REVALIDATE_MS = 7 * 24 * 60 * 60 * 1000;
const LICENSE_API = String((!app.isPackaged && process.env.MOSAIC_LICENSE_API) || 'https://api.lemonsqueezy.com/v1/licenses').replace(/\/+$/, '');
const OFFLINE_LICENSE_PREFIX = 'MOSAIC-';
function licenseFilePath() { return path.join(app.getPath('userData'), 'license.json'); }
// Prices follow the buyer's region (package.json → mosaicLicense.pricing):
// Vietnam pays in VND, everywhere else the default USD price. The region is
// the one Windows is set to.
function licenseRegion() {
  const code = String(LICENSE_CONFIG.testRegion || app.getLocaleCountryCode?.() || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}
function licensePrice() {
  const pricing = LICENSE_CONFIG.pricing || {};
  const region = licenseRegion();
  const regional = pricing.regions?.[region];
  const chosen = regional || pricing.default || {};
  return {
    region: regional ? region : 'default',
    currency: String(chosen.currency || 'USD'),
    amount: Number(chosen.amount) || 0,
    checkoutUrl: String(LICENSE_CONFIG.testCheckoutUrl || chosen.checkoutUrl || pricing.default?.checkoutUrl || ''),
  };
}
// Bank transfer by VietQR, for regions listed in bankTransfer.regions and
// priced in VND. The buyer pays with any Vietnamese banking app; the seller
// matches the transfer by its content and issues a MOSAIC- key.
function bankTransferAvailable(price = licensePrice()) {
  const bank = LICENSE_CONFIG.bankTransfer || {};
  return price.currency === 'VND' && price.amount > 0
    && (bank.regions || []).includes(licenseRegion())
    && /^\d{6}$/.test(String(bank.bankBin || '')) && /^[0-9A-Za-z]{4,19}$/.test(String(bank.accountNumber || ''));
}
function tlv(id, value) {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}
function crc16Ccitt(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
// NAPAS VietQR (EMVCo merchant-presented) payload for a transfer of `amount`
// VND to the account, with `content` as the transfer description.
function vietQrPayload({ bankBin, accountNumber, amount, content }) {
  const account = tlv('00', 'A000000727') + tlv('01', tlv('00', bankBin) + tlv('01', accountNumber)) + tlv('02', 'QRIBFTTA');
  const body = tlv('00', '01') + tlv('01', '12') + tlv('38', account) + tlv('53', '704')
    + tlv('54', String(Math.round(amount))) + tlv('58', 'VN') + tlv('62', tlv('08', content)) + '6304';
  return body + crc16Ccitt(body);
}
async function bankTransferDetails(rawEmail) {
  const price = licensePrice();
  if (!bankTransferAvailable(price)) return null;
  const bank = LICENSE_CONFIG.bankTransfer;
  let order;
  let amount = price.amount;
  if (licenseServerUrl()) {
    // The server opens the order, so it can match the payment and hand the
    // key to this computer by itself.
    const email = normalizeEmail(rawEmail);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'email' };
    let answer;
    try { answer = await licenseServerRequest('/v1/orders', { email, machine: await licenseMachineCode() }); } catch { return { error: 'offline' }; }
    if (!answer.ok) return { error: answer.error || 'invalid' };
    order = String(answer.code);
    amount = Number(answer.amount) || amount;
  } else {
    // A short code makes each transfer easy to match to its buyer.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    order = Array.from(crypto.randomBytes(6), byte => alphabet[byte % alphabet.length]).join('');
  }
  const content = `MOSAIC ${order}`;
  const payload = vietQrPayload({ bankBin: String(bank.bankBin), accountNumber: String(bank.accountNumber), amount, content });
  const qr = await require('qrcode').toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
  return {
    qr,
    payload,
    order,
    content,
    amount,
    currency: price.currency,
    automatic: Boolean(licenseServerUrl()),
    bankName: String(bank.bankName || ''),
    accountNumber: String(bank.accountNumber),
    accountName: String(bank.accountName || ''),
    contact: String(bank.contact || ''),
  };
}
function licenseEnforced() { return app.isPackaged || process.env.MOSAIC_LICENSE_ENFORCE === '1'; }
function lemonSqueezyConfigured() {
  // Without a store and product to compare against, any Lemon Squeezy key
  // from any store would unlock Mosaic, so the route stays closed until set.
  return Boolean(LICENSE_CONFIG.lemonSqueezy?.storeId && LICENSE_CONFIG.lemonSqueezy?.productId);
}
// The trial belongs to the machine, not to one file. Its start is kept in
// license.json and in the registry, tagged with a hash of the Windows
// MachineGuid; the earliest record for this machine wins. Deleting either
// copy, or bringing license.json over from another computer, does not start
// a fresh trial. Reinstalling Windows (a new MachineGuid) does.
const LICENSE_REGISTRY_KEY = (!app.isPackaged && process.env.MOSAIC_LICENSE_REGISTRY_KEY)
  || `HKCU\\Software\\${app.isPackaged ? 'Mosaic' : 'MosaicTest'}`;
function runReg(args) {
  return new Promise(resolve => execFile('reg.exe', args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve(error ? null : String(stdout || ''))));
}
let machineIdPromise = null;
function licenseMachineId() {
  machineIdPromise ||= (async () => {
    let source = '';
    if (process.platform === 'win32') {
      const output = await runReg(['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
      source = output?.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] || '';
    }
    // Only a hash is stored: the GUID itself identifies the computer.
    if (!source) source = `${os.hostname()}|${os.userInfo().username}`;
    return crypto.createHash('sha256').update(`mosaic-trial:${source}`).digest('hex').slice(0, 24);
  })();
  return machineIdPromise;
}
async function readRegistryTrialStart(machine) {
  if (process.platform !== 'win32') return 0;
  const output = await runReg(['query', LICENSE_REGISTRY_KEY, '/v', `Trial_${machine}`]);
  return Number(output?.match(/REG_SZ\s+(\d+)/i)?.[1] || 0);
}
async function writeRegistryTrialStart(machine, startedAt) {
  if (process.platform !== 'win32') return;
  await runReg(['add', LICENSE_REGISTRY_KEY, '/v', `Trial_${machine}`, '/t', 'REG_SZ', '/d', String(startedAt), '/f']);
}
// The code a buyer reads out to the seller for a bank-transfer key: ten
// characters from the machine hash, grouped for reading aloud. A signed key
// can name the machine codes it may run on, so it is useless anywhere else.
const MACHINE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let licenseMachineCodeValue = '';
async function licenseMachineCode() {
  if (licenseMachineCodeValue) return licenseMachineCodeValue;
  const digest = crypto.createHash('sha256').update(`mosaic-machine-code:${await licenseMachineId()}`).digest();
  const code = Array.from(digest.subarray(0, 10), byte => MACHINE_CODE_ALPHABET[byte % 32]).join('');
  licenseMachineCodeValue = `${code.slice(0, 5)}-${code.slice(5)}`;
  return licenseMachineCodeValue;
}
const normalizeMachineCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normalizeEmail = value => String(value || '').trim().toLowerCase();
let licenseRecord = null;
let licenseRecordLoading = null;
// Every window asks for the status as it opens, often several at once; they
// share one load, since two loads racing to write the record made the second
// one fail and left the renderer without a status.
function readLicenseRecord() {
  if (licenseRecord) return Promise.resolve(licenseRecord);
  licenseRecordLoading ||= loadLicenseRecord().finally(() => { licenseRecordLoading = null; });
  return licenseRecordLoading;
}
async function loadLicenseRecord() {
  await licenseMachineCode();
  let stored = {};
  try { stored = JSON.parse(await fs.promises.readFile(licenseFilePath(), 'utf8')) || {}; } catch { stored = {}; }
  const record = stored && typeof stored === 'object' ? stored : {};
  const machine = await licenseMachineId();
  // A file without a machine tag predates this check and was written here.
  const fileStart = !record.machine || record.machine === machine ? Number(record.trialStartedAt) || 0 : 0;
  const registryStart = await readRegistryTrialStart(machine);
  const now = Date.now();
  const known = [fileStart, registryStart].filter(value => value > 0 && value <= now);
  const startedAt = known.length ? Math.min(...known) : now;
  licenseRecord = record;
  if (record.trialStartedAt !== startedAt || record.machine !== machine) {
    licenseRecord = { ...record, machine, trialStartedAt: startedAt };
    // An activation belongs to the computer it was made on: a license.json
    // copied from elsewhere must not unlock this one without its own slot.
    if (record.machine && record.machine !== machine) delete licenseRecord.license;
    await writeLicenseRecord(licenseRecord);
  }
  if (registryStart !== startedAt) await writeRegistryTrialStart(machine, startedAt);
  // A license must still prove itself here: a signed token for this machine,
  // or a signed key. A record without one (hand-edited, or a card activation
  // from before the server existed) is dropped rather than trusted.
  const license = licenseRecord.license;
  if (license) {
    const proven = license.source === 'server' ? Boolean(await verifyActivationToken(license.token, license.email))
      : license.source === 'offline' ? Boolean(verifyOfflineLicense(license.key))
        : license.source === 'lemonsqueezy' ? !licenseServerUrl()
          : false;
    if (!proven) {
      licenseRecord = { ...licenseRecord };
      delete licenseRecord.license;
      await writeLicenseRecord(licenseRecord);
    }
  }
  return licenseRecord;
}
async function writeLicenseRecord(record) {
  licenseRecord = record;
  const file = licenseFilePath();
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(temporary, JSON.stringify(record, null, 2), 'utf8');
  await fs.promises.rename(temporary, file);
}
const fromBase64url = text => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function verifyOfflineLicense(key) {
  const text = String(key || '').trim();
  if (!text.startsWith(OFFLINE_LICENSE_PREFIX) || !LICENSE_CONFIG.publicKey) return null;
  const [body, signature] = text.slice(OFFLINE_LICENSE_PREFIX.length).split('.');
  if (!body || !signature) return null;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.from(LICENSE_CONFIG.publicKey, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, fromBase64url(body), publicKey, fromBase64url(signature))) return null;
    const payload = JSON.parse(fromBase64url(body).toString('utf8'));
    return payload?.v === 1 && payload.id && payload.email ? payload : null;
  } catch { return null; }
}
async function lemonSqueezyRequest(action, fields) {
  const response = await fetch(`${LICENSE_API}/${action}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  // 4xx answers carry a JSON reason (wrong key, limit reached); anything else
  // is the service being unreachable, which must not count as a verdict.
  if (!body || response.status >= 500) throw new Error(`License service answered ${response.status}`);
  return body;
}
// ---- License server (license-server/, Cloudflare Workers + D1) ----------
// When package.json → mosaicLicense.licenseServer is set, every key except a
// signed MOSAIC- key goes through it: it counts devices, lists and removes
// them from any computer, and turns a bank transfer into a key. Its answers
// carry a token signed with the key in mosaicLicense.publicKey, so neither a
// fake server nor a hand-edited license.json can unlock the app.
function licenseServerUrl() {
  const url = String(LICENSE_CONFIG.licenseServer || '').replace(/\/+$/, '');
  if (/^https:\/\/[^/\s]+$/i.test(url)) return url;
  // A test run may use a local `wrangler dev`.
  if (!app.isPackaged && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(url)) return url;
  return '';
}
async function licenseServerRequest(route, body) {
  const response = await fetch(`${licenseServerUrl()}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let answer = null;
  try { answer = await response.json(); } catch { answer = null; }
  // Only a JSON answer below 500 is a verdict; anything else is "unreachable".
  if (!answer || response.status >= 500) throw new Error(`License server answered ${response.status}`);
  return answer;
}
function verifySignedPayload(text) {
  const [body, signature] = String(text || '').split('.');
  if (!body || !signature || !LICENSE_CONFIG.publicKey) return null;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.from(LICENSE_CONFIG.publicKey, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, fromBase64url(body), publicKey, fromBase64url(signature))) return null;
    return JSON.parse(fromBase64url(body).toString('utf8'));
  } catch { return null; }
}
async function verifyActivationToken(token, email) {
  const payload = verifySignedPayload(token);
  if (payload?.kind !== 'activation' || payload.machine !== await licenseMachineCode()) return null;
  return !email || normalizeEmail(payload.email) === normalizeEmail(email) ? payload : null;
}
async function licenseCredentials(credentials) {
  const license = (await readLicenseRecord()).license;
  return {
    key: String(credentials?.key || (license?.source === 'server' ? license.key : '') || '').trim(),
    email: normalizeEmail(credentials?.email || (license?.source === 'server' ? license.email : '')),
  };
}
async function licenseDevices(credentials) {
  if (!licenseServerUrl()) return { ok: false, error: 'unavailable' };
  const { key, email } = await licenseCredentials(credentials);
  if (!key || !email) return { ok: false, error: 'invalid' };
  try {
    const answer = await licenseServerRequest('/v1/devices', { key, email });
    if (!answer.ok) return { ok: false, error: 'invalid' };
    return { ok: true, devices: answer.devices || [], deviceLimit: answer.deviceLimit || null, current: await licenseMachineCode() };
  } catch { return { ok: false, error: 'offline' }; }
}
// Remove a computer from a license, from any computer that knows the key and
// email: what Eagle's "Activated Device Management" does.
async function removeLicenseDevice(machine, credentials) {
  if (!licenseServerUrl()) return { ok: false, error: 'unavailable' };
  const { key, email } = await licenseCredentials(credentials);
  if (!key || !email) return { ok: false, error: 'invalid' };
  let answer;
  try { answer = await licenseServerRequest('/v1/deactivate', { key, email, machine }); } catch { return { ok: false, error: 'offline' }; }
  if (!answer.ok) return { ok: false, error: 'invalid' };
  const here = await licenseMachineCode();
  const record = { ...(await readLicenseRecord()) };
  if (String(machine).toUpperCase() === here && record.license?.source === 'server') {
    delete record.license;
    await writeLicenseRecord(record);
    broadcastLicense(licenseStatus(record));
  }
  return { ok: true, devices: answer.devices || [], deviceLimit: answer.deviceLimit || null, current: here, status: licenseStatus(record) };
}
// A bank-transfer order the server can match a payment to; once paid, the
// app picks up the key and activates itself.
async function licenseOrderStatus(code, email) {
  if (!licenseServerUrl()) return { ok: false, error: 'unavailable' };
  let answer;
  try { answer = await licenseServerRequest('/v1/orders/status', { code, email, machine: await licenseMachineCode() }); } catch { return { ok: false, error: 'offline' }; }
  if (!answer.ok) return { ok: false, error: 'invalid' };
  if (answer.status !== 'paid' || !answer.key) return { ok: true, status: 'pending' };
  const activation = await activateLicense(answer.key, email);
  return { ok: true, status: 'paid', key: answer.key, activation };
}
function lemonSqueezyKeyMatchesProduct(meta) {
  return String(meta?.store_id) === String(LICENSE_CONFIG.lemonSqueezy?.storeId)
    && String(meta?.product_id) === String(LICENSE_CONFIG.lemonSqueezy?.productId);
}
function keyHint(key) {
  const text = String(key || '');
  return text.length > 8 ? `…${text.slice(-6)}` : text;
}
function licenseStatus(record) {
  const trialEndsAt = Number(record.trialStartedAt) + LICENSE_TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const trialDaysLeft = Math.max(0, Math.ceil((trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)));
  const license = record.license ? { source: record.license.source, email: record.license.email || null, keyHint: keyHint(record.license.key), activatedAt: record.license.activatedAt || null } : null;
  let state;
  if (license) state = 'licensed';
  else if (!licenseEnforced()) state = 'development';
  else state = trialDaysLeft > 0 ? 'trial' : 'expired';
  return {
    state,
    trialDays: LICENSE_TRIAL_DAYS,
    trialDaysLeft,
    trialEndsAt,
    price: (({ checkoutUrl: _url, ...price }) => price)(licensePrice()),
    deviceLimit: Number(LICENSE_CONFIG.deviceLimit) || null,
    checkoutAvailable: /^https:\/\//i.test(licensePrice().checkoutUrl),
    bankTransferAvailable: bankTransferAvailable(),
    machineCode: licenseMachineCodeValue || null,
    serverEnabled: Boolean(licenseServerUrl()),
    recoverAvailable: lemonSqueezyConfigured() && /^https:\/\//i.test(String(LICENSE_CONFIG.recoverUrl || '')),
    supportContact: String(LICENSE_CONFIG.bankTransfer?.contact || '') || null,
    cardKeysAccepted: lemonSqueezyConfigured(),
    license,
  };
}
function broadcastLicense(status) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('license:changed', status);
  }
}
let licenseRevalidation = null;
async function revalidateLicense(record) {
  const license = record.license;
  if (!['lemonsqueezy', 'server'].includes(license?.source)) return;
  const age = Date.now() - Number(license.validatedAt || 0);
  if (age >= 0 && age < LICENSE_REVALIDATE_MS) return;
  if (licenseRevalidation) return;
  licenseRevalidation = (async () => {
    try {
      let revoked = false;
      let reason = 'invalid';
      let token = license.token;
      if (license.source === 'server') {
        const answer = await licenseServerRequest('/v1/validate', { key: license.key, machine: await licenseMachineCode() });
        if (answer.ok && await verifyActivationToken(answer.token, license.email)) token = answer.token;
        else if (!answer.ok && ['invalid', 'revoked', 'not-activated'].includes(answer.error)) { revoked = true; reason = answer.error; }
        else throw new Error('Unverifiable answer');
      } else {
        const answer = await lemonSqueezyRequest('validate', { license_key: license.key, instance_id: license.instanceId });
        revoked = answer.valid === false || !lemonSqueezyKeyMatchesProduct(answer.meta)
          || ['disabled', 'expired'].includes(String(answer.license_key?.status || ''));
        reason = answer.error || answer.license_key?.status || 'invalid';
      }
      const next = { ...(await readLicenseRecord()) };
      if (revoked) {
        next.revoked = { key: keyHint(license.key), at: Date.now(), reason };
        delete next.license;
      } else next.license = { ...license, ...(token ? { token } : {}), validatedAt: Date.now() };
      await writeLicenseRecord(next);
      if (revoked) broadcastLicense(licenseStatus(next));
    } catch { /* Offline or unreachable: keep the activation and try again later. */ }
    finally { licenseRevalidation = null; }
  })();
}
async function currentLicenseStatus() {
  const record = await readLicenseRecord();
  void revalidateLicense(record);
  return licenseStatus(record);
}
// Like Eagle, a key unlocks only together with the email it was bought with:
// handing a key on means handing on one's email too. A wrong email and a
// wrong key get the same answer, so neither can be guessed separately.
async function activateLicense(rawKey, rawEmail) {
  const key = String(rawKey || '').trim();
  const email = normalizeEmail(rawEmail);
  if (!key || key.length > 2048) return { ok: false, error: 'empty' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'email' };
  const record = { ...(await readLicenseRecord()) };
  const offline = verifyOfflineLicense(key);
  if (key.startsWith(OFFLINE_LICENSE_PREFIX)) {
    if (!offline || normalizeEmail(offline.email) !== email) return { ok: false, error: 'invalid' };
    if (Array.isArray(offline.machines) && offline.machines.length) {
      const here = normalizeMachineCode(await licenseMachineCode());
      if (!offline.machines.map(normalizeMachineCode).includes(here)) return { ok: false, error: 'other-machine' };
    }
    record.license = { source: 'offline', key, id: offline.id, email: offline.email, activatedAt: Date.now() };
  } else if (licenseServerUrl()) {
    let answer;
    try {
      answer = await licenseServerRequest('/v1/activate', { key, email, machine: await licenseMachineCode(), name: os.hostname() });
    } catch { return { ok: false, error: 'offline' }; }
    if (!answer.ok) {
      if (answer.error === 'device-limit') return { ok: false, error: 'device-limit', devices: answer.devices || [], deviceLimit: answer.deviceLimit || null };
      return { ok: false, error: 'invalid' };
    }
    if (!(await verifyActivationToken(answer.token, email))) return { ok: false, error: 'invalid' };
    record.license = {
      source: 'server',
      key,
      email,
      token: answer.token,
      keyHint: answer.license?.keyHint || null,
      activatedAt: Date.now(),
      validatedAt: Date.now(),
    };
  } else {
    if (!lemonSqueezyConfigured()) return { ok: false, error: 'card-keys-unavailable' };
    // Check the key before activating, so a wrong email or product never
    // takes up one of the buyer's device slots.
    let check;
    try { check = await lemonSqueezyRequest('validate', { license_key: key }); } catch { return { ok: false, error: 'offline' }; }
    if (!check.license_key || ['disabled', 'expired'].includes(String(check.license_key.status || ''))) return { ok: false, error: 'invalid' };
    if (!lemonSqueezyKeyMatchesProduct(check.meta)) return { ok: false, error: 'wrong-product' };
    if (normalizeEmail(check.meta?.customer_email) !== email) return { ok: false, error: 'invalid' };
    let answer;
    try {
      answer = await lemonSqueezyRequest('activate', { license_key: key, instance_name: `${os.hostname()} (Mosaic)` });
    } catch { return { ok: false, error: 'offline' }; }
    if (!answer.activated) {
      const limitReached = /limit/i.test(String(answer.error || ''));
      return { ok: false, error: limitReached ? 'device-limit' : 'invalid', detail: answer.error || null };
    }
    if (!lemonSqueezyKeyMatchesProduct(answer.meta)) {
      // A real key, but for another product: give the device slot back.
      await lemonSqueezyRequest('deactivate', { license_key: key, instance_id: answer.instance?.id }).catch(() => {});
      return { ok: false, error: 'wrong-product' };
    }
    record.license = {
      source: 'lemonsqueezy',
      key,
      instanceId: answer.instance?.id,
      email: answer.meta?.customer_email || null,
      activatedAt: Date.now(),
      validatedAt: Date.now(),
    };
  }
  delete record.revoked;
  await writeLicenseRecord(record);
  const status = licenseStatus(record);
  broadcastLicense(status);
  return { ok: true, status };
}
async function deactivateLicense() {
  const record = { ...(await readLicenseRecord()) };
  const license = record.license;
  if (!license) return { ok: true, status: licenseStatus(record) };
  if (license.source === 'server') {
    try {
      const answer = await licenseServerRequest('/v1/deactivate', { key: license.key, email: license.email, machine: await licenseMachineCode() });
      if (!answer.ok) return { ok: false, error: 'invalid' };
    } catch { return { ok: false, error: 'offline' }; }
  }
  if (license.source === 'lemonsqueezy') {
    // Free the device slot so the key can move to another computer. If the
    // service cannot be reached, keep the activation rather than lose the slot.
    try {
      const answer = await lemonSqueezyRequest('deactivate', { license_key: license.key, instance_id: license.instanceId });
      if (!answer.deactivated && !/not found/i.test(String(answer.error || ''))) return { ok: false, error: 'invalid', detail: answer.error || null };
    } catch { return { ok: false, error: 'offline' }; }
  }
  delete record.license;
  await writeLicenseRecord(record);
  const status = licenseStatus(record);
  broadcastLicense(status);
  return { ok: true, status };
}
async function createWindow(profileId = null) {
  let profile = profileId ? await profileById(profileId) : await defaultProfile();
  if (!profile) throw new Error('Profile not found');
  if (isProfileReady(profile)) profile = await trackProfileLibraryLocation(profile);
  const existing = profileWindows.get(profile.id);
  if (existing && !existing.isDestroyed()) { focusWindow(existing); return existing; }
  if (isProfileReady(profile)) {
    try { await ensureProfileAspectRatios(profile); }
    catch (error) { console.warn('Could not index Gallery aspect ratios:', error.message); }
  }
  const { isMaximized: restoreMaximized, ...windowBounds } = usableWindowState();
  const window = new BrowserWindow({
    ...windowBounds,
    minWidth: 1050, minHeight: 700,
    title: `${APP_DISPLAY_NAME} — ${profile.name}`, titleBarStyle: 'hidden', backgroundColor: '#111217',
    icon: fs.existsSync(APP_ICON_ICO_PATH) ? APP_ICON_ICO_PATH : fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  // BrowserWindow accepts bounds in its constructor but does not restore a
  // custom `isMaximized` field. Apply it explicitly after construction.
  if (restoreMaximized) window.maximize();
  // BrowserWindow.webContents is destroyed before the `closed` event runs.
  // Keep the stable id now so the cleanup handler never touches a destroyed
  // Electron object when the custom Close button is used.
  const webContentsId = window.webContents.id;
  window.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    console.error('[InDeck renderer load failed]', errorCode, errorDescription, validatedURL);
  });
  // The Vite document title is intentionally generic. Keep test windows
  // visibly distinct from the installed Mosaic application in the taskbar.
  profileWindowNames.set(profile.id, profile.name);
  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(`${APP_DISPLAY_NAME} — ${profileWindowNames.get(profile.id) || profile.name}`);
  });
  window.webContents.on('console-message', (_, level, message, line, sourceId) => {
    if (level >= 2) console.error('[InDeck renderer]', message, `${sourceId}:${line}`);
  });
  window.webContents.on('render-process-gone', (_, details) => {
    console.error('[InDeck renderer process gone]', details.reason, details.exitCode);
  });
  window.on('resize', () => saveWindowState(window));
  window.on('move', () => saveWindowState(window));
  window.on('maximize', () => saveWindowState(window));
  window.on('unmaximize', () => saveWindowState(window));
  window.on('close', () => {
    saveWindowState(window);
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
  window.webContents.once('did-finish-load', () => scheduleVaultDimensionFill(profile));
  window.loadFile(rendererEntry());
  return window;
}

// Startup repairs are best effort. One that fails (a Library on a drive that
// is not plugged in, a cross-drive rename) must not stop the window from
// opening: IPC handlers are registered further down, after these steps.
async function startupStep(label, step) {
  try { return await step(); }
  catch (error) { console.error(`Startup step "${label}" failed:`, error); return undefined; }
}
app.whenReady().then(async () => {
  await migrateLegacyAppData();
  await migrateProfileDataPaths();
  await startupStep('taskbar icon', ensureTaskbarIcon);
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
  const startupProfiles = await readProfileRegistry();
  if (process.env.MOSAIC_RESET_THUMBNAIL_CACHE === '1') {
    await resetThumbnailCaches(startupProfiles);
    console.log('Mosaic thumbnail disk cache reset');
  }
  for (const profile of startupProfiles.profiles) {
    if (isProfileReady(profile)) await startupStep(`restore ${profile.id}`, () => restoreProfileLibraryLocation(profile));
  }
  // Remove the pre-1.1.2 global-Vault migration from every Profile at once.
  // Waiting until a Profile window is opened would leave stale media visible
  // in an unopened Profile's Main Gallery.
  await startupStep('vault cleanup', removeAutomaticallyAttachedVaultSourcesFromProfiles);
  // Shortcuts are created only by the explicit profile actions (create,
  // restore, rename/default change, or the "Create shortcut" button). Do not
  // replace an existing Desktop shortcut every time Mosaic starts.
  await startupStep('folder icons', ensureProfileFolderIcons);
  await startupStep('shortcut repair', repairBrokenProfileShortcuts);
  let currentDefaultProfile = await defaultProfile();
  if (isProfileReady(currentDefaultProfile)) await startupStep('default profile repair', async () => {
    currentDefaultProfile = await trackProfileLibraryLocation(currentDefaultProfile);
    const library = await readStore(currentDefaultProfile);
    const migrated = await migrateInDeckMedia(currentDefaultProfile, library);
    const sanitized = sanitizeExtensionGalleryMembership(currentDefaultProfile, library);
    // Gallery Default Media Sources are Mosaic-managed folders. Missing ones
    // are repaired at startup instead of being treated as disconnected user
    // folders, preserving the DMS link created with every Gallery.
    const repairedDefaults = await ensureDefaultSourcesForExistingGalleries(currentDefaultProfile, library);
    const prunedUnavailable = await reconcileUnavailableSources(currentDefaultProfile, library);
    if (migrated || sanitized || repairedDefaults || prunedUnavailable) await writeStore(currentDefaultProfile, library);
  });
  registerNativeMessagingHost().catch(error => console.error('Could not register native messaging host:', error.message));
  configureAutoUpdater();
  async function readReconciledStore(profile) {
    const data = await readStore(profile);
    // Snapshot reads are on the hot path during app startup, source watcher
    // updates, and UI changes.  They must not recursively walk DefaultSave or
    // stat every known Media.  Source changes are reconciled by the watcher,
    // explicit refresh, import, recovery, and source removal flows instead.
    const defaultSaveChanged = await ensureProfileDefaultSaveSource(profile, data, { scan: false });
    // Vault bridge details are refreshed only for sources this Profile has
    // already linked. Discovery itself must never create Profile membership.
    const vaultChanged = await reconcileVaultBridgeSources(profile, data);
    if (defaultSaveChanged || vaultChanged) await writeStore(profile, data);
    return data;
  }
  ipcMain.handle('license:status', () => currentLicenseStatus());
  ipcMain.handle('license:activate', (_, key, email) => activateLicense(key, email));
  ipcMain.handle('license:recover', async () => {
    const url = String(LICENSE_CONFIG.recoverUrl || '');
    if (!lemonSqueezyConfigured() || !/^https:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('license:deactivate', () => deactivateLicense());
  ipcMain.handle('license:bank-transfer', (_, email) => bankTransferDetails(email));
  ipcMain.handle('license:order-status', (_, code, email) => licenseOrderStatus(String(code || ''), String(email || '')));
  ipcMain.handle('license:devices', (_, credentials) => licenseDevices(credentials));
  ipcMain.handle('license:remove-device', (_, machine, credentials) => removeLicenseDevice(String(machine || ''), credentials));
  ipcMain.handle('license:buy', async () => {
    const url = licensePrice().checkoutUrl;
    if (!/^https:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('app:display-name', () => APP_DISPLAY_NAME);
  ipcMain.handle('store:read', async event => readReconciledStore(await profileForWebContents(event.sender)));
  ipcMain.handle('store:write', async (event, value) => {
    const profile = await profileForWebContents(event.sender);
    const data = value && typeof value === 'object' ? value : {};
    // Filesystem reconciliation is intentionally not done here. A normal UI
    // edit used to stat every asset in every Media Source before writing the
    // state, which made large Libraries progressively slower. Watcher-driven
    // `sources:refresh` owns that work and persists the reconciled result.
    return writeStore(profile, data);
  });
  // New renderers consume a versioned snapshot instead of treating browser
  // storage as a library. Keep store:* temporarily for the legacy renderer.
  ipcMain.handle('library:snapshot', async event => {
    const profile = await profileForWebContents(event.sender);
    return { version: 1, library: await readReconciledStore(profile) };
  });
  ipcMain.handle('profiles:list', async () => (await readProfileRegistry()).profiles
    .slice().sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
    .map(profile => ({ id: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault), initialized: isProfileReady(profile), mediaPath: profile.mediaPath || null, lastMediaPath: profile.lastMediaPath || null })));
  ipcMain.handle('profiles:discarded-list', async () => (await readProfileRegistry()).discardedProfiles.map(profile => ({ id: profile.id, name: profile.name, initialized: isProfileReady(profile), mediaPath: profile.mediaPath || null, discardedAt: profile.discardedAt || null })));
  ipcMain.handle('profiles:current', async event => {
    const profile = await profileForWebContents(event.sender);
    return { id: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault), initialized: isProfileReady(profile), mediaPath: profile.mediaPath || null, lastMediaPath: profile.lastMediaPath || null };
  });
  ipcMain.handle('profiles:create', async (_, name) => {
    const profile = await withProfileLock(() => createProfile(name));
    return { id: profile.id, name: profile.name, isDefault: false, initialized: false };
  });
  ipcMain.handle('profiles:rename', async (_, profileId, name) => {
    const profile = await withProfileLock(() => renameProfile(profileId, name));
    profileWindowNames.set(profile.id, profile.name);
    const window = profileWindows.get(profile.id);
    if (window && !window.isDestroyed()) window.setTitle(`${APP_DISPLAY_NAME} — ${profile.name}`);
    return { id: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault), initialized: isProfileReady(profile) };
  });
  ipcMain.handle('profiles:set-default', async (_, profileId) => {
    const profile = await withProfileLock(() => setDefaultProfile(profileId));
    return { id: profile.id, name: profile.name, isDefault: true, initialized: isProfileReady(profile) };
  });
  ipcMain.handle('profiles:delete', async (_, profileId, typedName, replacementDefaultId) => {
    const { profile, replacement } = await withProfileLock(() => deleteProfile(profileId, typedName, replacementDefaultId));
    if (replacement) await createWindow(replacement.id);
    const window = profileWindows.get(profile.id);
    if (window && !window.isDestroyed()) setTimeout(() => window.close(), 0);
    return { id: profile.id };
  });
  ipcMain.handle('profiles:recover', async (_, profileId) => withProfileLock(() => recoverDiscardedProfile(profileId)));
  ipcMain.handle('profiles:permanently-delete', async (_, profileId, typedName) => {
    const profile = await withProfileLock(() => permanentlyDeleteDiscardedProfile(profileId, typedName));
    return { id: profile.id };
  });
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
  ipcMain.handle('profiles:create-shortcut', async (_, profileId) => withProfileLock(() => createProfileShortcut(profileId)));
  ipcMain.handle('extension:browsers', async () => detectBrowsers());
  ipcMain.handle('extension:install', async (_, browserId) => openExtensionInstall(browserId));
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { state: 'development' };
    await autoUpdater.checkForUpdates();
    return { state: 'checking' };
  });
  ipcMain.handle('update:download', async () => {
    if (!app.isPackaged) throw new Error('Updates are available only in an installed build');
    await autoUpdater.downloadUpdate();
    return { state: 'downloading' };
  });
  ipcMain.handle('update:install', () => {
    if (app.isPackaged) autoUpdater.quitAndInstall(false, true);
  });
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
    // Persist the DMS record in the backend as part of Gallery creation. The
    // renderer also persists its state, but this prevents a quick close or a
    // render race from leaving a physical folder without its Gallery link.
    const gallery = stored || {
      id: galleryId,
      name: galleryName,
      defaultSourceId: galleryDefaultSourceId(galleryId),
      defaultSourcePath: previousPath,
      sourceIds: [],
      items: [],
    };
    if (!stored) {
      gallery.name = galleryName;
      gallery.defaultSourcePath = previousPath;
    }
    const source = await ensureGalleryDefaultSource(profile, data, gallery, previousPath || gallery.defaultSourcePath);
    await writeStore(profile, data);
    return { id: source.id, name: source.name, path: source.path };
  });
  ipcMain.handle('gallery:default-source:discard', async (event, payload = {}) => discardGalleryDefaultSource(await profileForWebContents(event.sender), payload));
  ipcMain.handle('folder:scan', async (event, source) => {
    const profile = await profileForWebContents(event.sender);
    const result = await scanSource(profile, source);
    // A newly added Vault source is measured once the renderer has saved it.
    if (result?.vault) setTimeout(() => scheduleVaultDimensionFill(profile), 2000);
    return result;
  });
  ipcMain.handle('source:catalog', async (event, source) => cachedSourceScan(await profileForWebContents(event.sender), source));
  ipcMain.handle('source:catalog-remove', async (event, sourceId) => removeCachedSource(await profileForWebContents(event.sender), sourceId));
  ipcMain.handle('source:resolve', (_, source) => resolveSource(source));
  ipcMain.handle('thumbnails:ensure', async (event, assets, requestId) => createThumbnails(await profileForWebContents(event.sender), assets, requestId));
  ipcMain.handle('thumbnails:regenerate', async (event, assets) => regenerateThumbnails(await profileForWebContents(event.sender), assets));
  ipcMain.handle('thumbnails:analyze-colors', async (event, assets, requestId) => analyzeThumbnailColors(await profileForWebContents(event.sender), assets, requestId));
  ipcMain.handle('thumbnails:colors', async event => thumbnailColors(await profileForWebContents(event.sender)));
  ipcMain.handle('thumbnails:cancel', async (event, requestId) => {
    cancelThumbnailRequest(await profileForWebContents(event.sender), requestId);
  });
  // Lightweight profiler for diagnosing whether a slow thumbnail waited in
  // the queue, was slow to read, or was expensive to decode. Kept in memory
  // only so normal use does not add I/O to the thumbnail path.
  ipcMain.handle('thumbnails:metrics', async event => {
    const profile = await profileForWebContents(event.sender);
    return thumbnailLatency.get(String(profile?.id || DEFAULT_PROFILE_ID)) || [];
  });
  ipcMain.handle('vault:bridges', async () => (await readVaultBridges())
    .filter(item => item?.id && item?.folder)
    .map(item => ({ id: String(item.id), folder: String(item.folder), tracking: bridgeTracking(item) })));
  ipcMain.handle('media:sync-locations', async event => syncMediaLocations(await profileForWebContents(event.sender)));
  ipcMain.handle('sources:refresh', async (event, folders) => {
    const profile = await profileForWebContents(event.sender);
    const result = await refreshTrackedSources(profile, folders);
    scheduleVaultDimensionFill(profile);
    return result;
  });
  ipcMain.handle('sources:watch', (event, folders) => {
    return profileForWebContents(event.sender).then(profile => watchFolders(profile, event.sender, Array.isArray(folders) ? folders : []));
  });
  ipcMain.handle('image:copy', async (event, asset) => {
    let image;
    if (isSvg(asset?.path || asset?.name) || isDerivedImage(asset?.path || asset?.name)) {
      // The clipboard takes a bitmap: copy the 2048 px rendering the Lightbox
      // shows, since nativeImage reads none of these originals.
      const profile = await profileForWebContents(event.sender);
      const url = await scheduleThumbnail(profile, { ...asset, thumbnailSize: THUMBNAIL_DISPLAY_SIZE, thumbnailPriority: 'high' }).catch(() => null);
      image = url ? nativeImage.createFromPath(fileURLToPath(url)) : nativeImage.createEmpty();
    } else if (asset?.vault) {
      try { image = nativeImage.createFromBuffer(Buffer.from(await (await fetch(asset.contentUrl)).arrayBuffer())); }
      catch { return false; }
    } else image = nativeImage.createFromPath(asset?.path || '');
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });
  ipcMain.handle('image:show-in-folder', (_, asset) => {
    const assetPath = typeof asset?.path === 'string' ? asset.path : '';
    if (asset?.vault || !assetPath || !fs.existsSync(assetPath)) return false;
    shell.showItemInFolder(assetPath);
    return true;
  });
  ipcMain.handle('clipboard:write-text', (_, text) => {
    const value = String(text ?? '');
    if (!value || value.length > 2_000_000) return false;
    clipboard.writeText(value);
    return true;
  });
  // An SVG's markup pastes into Figma, Illustrator and code as the vector it is.
  ipcMain.handle('media:copy-svg', async (_, asset) => {
    try {
      let text;
      if (asset?.vault) {
        const response = await fetch(String(asset.contentUrl || ''));
        if (!response.ok) return false;
        text = await response.text();
      } else {
        const file = String(asset?.path || '');
        if (!isSvg(file) || (await fs.promises.stat(file)).size > 8 * 1024 * 1024) return false;
        text = await fs.promises.readFile(file, 'utf8');
      }
      if (!/<svg\b/i.test(text)) return false;
      clipboard.writeText(text);
      return true;
    } catch { return false; }
  });
  // Windows' own "Open with" chooser, so a file can go to Photoshop, Figma or
  // any editor rather than only to its default app.
  ipcMain.handle('media:open-with', async (_, asset) => {
    const assetPath = typeof asset?.path === 'string' ? asset.path : '';
    if (asset?.vault || !assetPath || !fs.existsSync(assetPath)) return false;
    if (process.platform !== 'win32') return !(await shell.openPath(assetPath));
    try {
      // OpenAs_RunDLL takes the rest of its command line as the path, quotes
      // and all, so the path is passed verbatim rather than quoted.
      const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', assetPath], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch { return false; }
  });
  // Drag media out of Mosaic into another app (Figma, Photoshop, Explorer, a
  // browser upload). Only local media files are handed to the OS; a Vault
  // keeps no file on disk to give.
  ipcMain.on('media:start-drag', (event, payload) => {
    const files = (Array.isArray(payload?.assets) ? payload.assets : [])
      .filter(asset => !asset?.vault && typeof asset?.path === 'string' && MEDIA_EXTENSIONS.has(path.extname(asset.path).toLowerCase()))
      .map(asset => asset.path)
      .filter(file => { try { return fs.statSync(file).isFile(); } catch { return false; } })
      .slice(0, 500);
    if (!files.length) return;
    let icon = null;
    try {
      // The card's cached thumbnail, recognised by the cache's own file names.
      const iconPath = payload?.icon ? fileURLToPath(String(payload.icon)) : '';
      if (/^[0-9a-f]{40}\.jpg$/i.test(path.basename(iconPath))) icon = nativeImage.createFromPath(iconPath);
    } catch { icon = null; }
    if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(APP_ICON_PATH);
    const { width, height } = icon.getSize();
    if (width > 96 || height > 96) icon = icon.resize(width >= height ? { width: 96 } : { height: 96 });
    try { event.sender.startDrag({ file: files[0], files, icon }); } catch { /* The OS refused the drag. */ }
  });
  ipcMain.handle('media:open-default', async (_, asset) => {
    if (asset?.vault || !asset?.path) return false;
    return !(await shell.openPath(asset.path));
  });
  ipcMain.handle('media:trash', async (_, asset) => {
    try {
      if (asset?.vault) {
        // A Vault holds no file on disk for the Recycle Bin to take, so the
        // Vault's own trash is the equivalent: the media leaves the Gallery
        // and stays recoverable, which is what the action promises.
        const contentUrl = String(asset.contentUrl || '');
        if (!contentUrl) return { ok: false, reason: 'vault-unavailable' };
        // Only delete once this Vault is known to have a trash. An older build
        // still running the previous code answers the same DELETE by erasing
        // the payload outright, and the confirmation the user agreed to says
        // the file stays recoverable. Say which of the two it was, so the user
        // is not left guessing why nothing happened.
        const trashUrl = contentUrl.replace(/\/v1\/files\/[^/]+\/content\?/, '/v1/trash?');
        const probe = await fetch(trashUrl).then(response => response.status).catch(() => 0);
        // 404 is a Vault build without the trash endpoint; anything else that
        // is not a success (no answer, a stale token) means it is not usable.
        if (probe === 404) return { ok: false, reason: 'vault-no-trash' };
        if (probe < 200 || probe >= 300) return { ok: false, reason: 'vault-unavailable' };
        const response = await fetch(contentUrl.replace('/content?', '?'), { method: 'DELETE' }).catch(() => null);
        return response?.ok ? true : { ok: false, reason: response ? 'failed' : 'vault-unavailable' };
      }
      if (!asset?.path || isRecycleBinPath(asset.path)) return false;
      await shell.trashItem(asset.path);
      return true;
    }
    catch { return false; }
  });
  if (!NATIVE_MESSAGING_MODE) {
    await launchProfileWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }
}).catch(error => {
  // Without this the process kept running with no window and no IPC handlers,
  // holding the single-instance lock so every later launch opened a dead UI.
  console.error('Mosaic failed to start:', error);
  if (!NATIVE_MESSAGING_MODE) dialog.showErrorBox('Mosaic could not start', String(error?.stack || error?.message || error));
  app.exit(1);
});
app.on('window-all-closed', () => { if (!NATIVE_MESSAGING_MODE && process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  stopFolderWatchers();
});
