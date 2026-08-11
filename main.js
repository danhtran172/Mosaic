const { app, BrowserWindow, dialog, ipcMain, clipboard, nativeImage, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
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
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'mosaic-window-state.json');

const MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.mp4', '.mov', '.m4v', '.webm', '.avi', '.ts']);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);
const WEB_IMPORTS_SOURCE_ID = 'allsight-web-imports';
const PROFILE_MAIN_LIBRARY_SOURCE_ID = 'indeck-profile-main-library';
const VAULT_BRIDGE_FILES = [
  path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'MosaicVault', 'mosaic-bridge.json'),
  path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'MasterVisionVault', 'mosaic-bridge.json'),
  // Existing Vault installations continue to work while they migrate their
  // bridge file name independently of Mosaic.
  path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'MasterVisionVault', 'indeck-bridge.json'),
];
// Keep branded resources inside the project so packaged/source builds never
// depend on a user Downloads path.
const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon.png');
const APP_ICON_ICO_PATH = path.join(app.getPath('userData'), 'Mosaic.ico');
const DEFAULT_PROFILE_ID = 'default';
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
  await ensureProfileFolderIcon(profile.dataPath);
  registry.profiles.push(profile);
  await writeProfileRegistry(registry);
  await createProfileShortcut(profile.id);
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
  await fs.promises.mkdir(status.mediaPath, { recursive: true });
  profile.mediaPath = status.mediaPath;
  profile.lastMediaPath = status.mediaPath;
  profile.mediaTracking = await identifyFolder(status.mediaPath);
  profile.initialized = true;
  profile.libraryLocationConfiguredAt = Date.now();
  const stored = await updateProfileInRegistry(profile);
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
  if (previousDefault && previousDefault.id !== profile.id) await syncProfileShortcut({ ...previousDefault, isDefault: false });
  await syncProfileShortcut({ ...profile, isDefault: true });
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
  if (replacement) await syncProfileShortcut({ ...replacement, isDefault: true });
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
  await createProfileShortcut(profile.id);
  return profile;
}
function profileShortcutPath(profile) {
  const fileName = profile.isDefault ? 'Mosaic.lnk' : `${safeFolderPart(profile.name)}.lnk`;
  return path.join(app.getPath('desktop'), fileName);
}
function profileShortcutCandidates(profile) {
  return [...new Set([
    profile.shortcutPath,
    profileShortcutPath(profile),
    path.join(app.getPath('desktop'), `Mosaic - ${safeFolderPart(profile.name)}.lnk`),
    path.join(app.getPath('desktop'), 'Mosaic.lnk'),
  ].filter(Boolean))];
}
function shortcutBelongsToProfile(shortcutPath, profileId) {
  try { return String(shell.readShortcutLink(shortcutPath)?.args || '').includes(`--profile=${profileId}`); }
  catch { return false; }
}
async function removeProfileShortcut(profile) {
  for (const shortcutPath of profileShortcutCandidates(profile)) {
    if (!shortcutBelongsToProfile(shortcutPath, profile.id)) continue;
    await fs.promises.unlink(shortcutPath).catch(() => {});
  }
}
async function syncProfileShortcut(profile) {
  await removeProfileShortcut(profile);
  return createProfileShortcut(profile.id);
}
async function createProfileShortcut(profileId) {
  const profile = await profileById(profileId);
  if (!profile) throw new Error('Profile not found');
  await removeProfileShortcut(profile);
  const shortcutPath = profileShortcutPath(profile);
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
  if (!shell.writeShortcutLink(shortcutPath, 'create', options)) throw new Error('Could not create the profile shortcut');
  const registry = await readProfileRegistry();
  const index = registry.profiles.findIndex(item => item.id === profile.id);
  if (index >= 0 && registry.profiles[index].shortcutPath !== shortcutPath) {
    registry.profiles[index].shortcutPath = shortcutPath;
    await writeProfileRegistry(registry);
  }
  return shortcutPath;
}
async function ensureProfileShortcuts() {
  const registry = await readProfileRegistry();
  for (const profile of registry.profiles) {
    await syncProfileShortcut(profile);
    await ensureProfileFolderIcon(profile.dataPath);
    if (profile.mediaPath) await ensureProfileFolderIcon(profile.mediaPath);
  }
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
const THUMBNAIL_CACHE_LIMIT = 1600;
const thumbnailCachePruneCounters = new Map();
const thumbnailWorkQueues = new Map();
// Thumbnail calls are made by visible cards.  The work queue is shared by the
// whole profile, not by each IPC request, so a fast scroll cannot multiply
// image/video decoding work beyond this fixed concurrency.
function scheduleThumbnail(profile, asset, requestId) {
  const profileKey = String(profile?.id || DEFAULT_PROFILE_ID);
  let queue = thumbnailWorkQueues.get(profileKey);
  if (!queue) {
    queue = { active: 0, pending: [], jobs: new Map() };
    thumbnailWorkQueues.set(profileKey, queue);
  }
  const jobKey = `${asset?.id}:${asset?.modified || 0}`;
  requestId ||= `batch:${crypto.randomUUID()}`;
  let job = queue.jobs.get(jobKey);
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  if (job) {
    const consumers = job.consumers.get(requestId) || [];
    consumers.push(resolve);
    job.consumers.set(requestId, consumers);
    return promise;
  }
  job = { asset, jobKey, consumers: new Map([[requestId, [resolve]]]), started: false };
  queue.jobs.set(jobKey, job);
  queue.pending.push(job);
  const pump = () => {
    while (queue.active < 3 && queue.pending.length) {
      const next = queue.pending.shift();
      if (!next.consumers.size) { queue.jobs.delete(next.jobKey); continue; }
      queue.active += 1;
      next.started = true;
      createThumbnail(profile, next.asset)
        .then(value => { next.consumers.forEach(resolvers => resolvers.forEach(resolve => resolve(value))); }, () => { next.consumers.forEach(resolvers => resolvers.forEach(resolve => resolve(null))); })
        .finally(() => {
          queue.active -= 1;
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
}
async function pruneThumbnailCache(profile) {
  const key = String(profile?.id || DEFAULT_PROFILE_ID);
  const count = (thumbnailCachePruneCounters.get(key) || 0) + 1;
  thumbnailCachePruneCounters.set(key, count);
  // Pruning occasionally, rather than during every thumbnail lookup, keeps
  // the cache bounded without putting directory enumeration on the scroll path.
  if (count % 80) return;
  try {
    const folder = thumbnailDirectory(profile);
    const files = (await fs.promises.readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.png'));
    if (files.length <= THUMBNAIL_CACHE_LIMIT) return;
    const details = await Promise.all(files.map(async entry => ({
      path: path.join(folder, entry.name),
      mtime: (await fs.promises.stat(path.join(folder, entry.name))).mtimeMs,
    })));
    details.sort((a, b) => a.mtime - b.mtime);
    await Promise.all(details.slice(0, details.length - THUMBNAIL_CACHE_LIMIT).map(file => fs.promises.rm(file.path, { force: true })));
  } catch { /* A cache is disposable. */ }
}
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
    // The filesystem timestamp doubles as the LRU access marker.
    void fs.promises.utimes(target, new Date(), new Date()).catch(() => {});
    return pathToFileURL(target).href;
  } catch { /* Generate missing cache entry below. */ }
  try {
    await fs.promises.mkdir(thumbnailDirectory(profile), { recursive: true });
    if (asset.type === 'video') {
      if (!(await createVideoThumbnail(asset, temporary))) { await fs.promises.rm(temporary, { force: true }).catch(() => {}); return null; }
      await fs.promises.rename(temporary, target);
      void pruneThumbnailCache(profile);
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
    void pruneThumbnailCache(profile);
    return pathToFileURL(target).href;
  } catch { await fs.promises.rm(temporary, { force: true }).catch(() => {}); return null; }
}
async function createThumbnails(profile, assets, requestId) {
  // Keep IPC payloads bounded; `scheduleThumbnail` is the profile-wide queue
  // that enforces decoding concurrency across all visible cards.
  const items = Array.isArray(assets) ? assets.slice(0, 50) : [];
  const output = {};
  const urls = await Promise.all(items.map(asset => scheduleThumbnail(profile, asset, requestId)));
  urls.forEach((thumbnailUrl, index) => { if (thumbnailUrl) output[items[index].id] = thumbnailUrl; });
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
  const documents = await Promise.all(VAULT_BRIDGE_FILES.map(async file => {
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
    catch { return null; }
  }));
  const bridges = documents.flatMap(document => Array.isArray(document?.vaults) ? document.vaults : []);
  return [...new Map(bridges.filter(bridge => bridge?.id).map(bridge => [String(bridge.id), bridge])).values()];
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
    const scanned = await scanDirectoryKeepingKnownIds(folder, source);
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
  if (!String(sourceId || '').startsWith('indeck-gallery-default:') || !isPathInside(indeckMediaPath(profile), folder)) {
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
async function refreshTrackedSources(profile, folders = []) {
  const data = await readStore(profile);
  const requested = new Set((Array.isArray(folders) ? folders : []).map(normalizedPath));
  const targets = (data.sources || []).filter(source => !requested.size || requested.has(normalizedPath(source.path)));
  const removedIds = new Set();
  const addedIdsBySource = new Map();
  let changed = false;
  for (const source of targets) {
    if (isInDeckDiscardPath(profile, source.path)) continue;
    const previousByPath = new Map((source.assets || []).map(asset => [normalizedPath(asset.path), String(asset.id)]));
    const previousIds = new Set(previousByPath.values());
    const result = await scanSource(profile, source);
    if (!result.folder) continue;
    if (normalizedPath(source.path) !== normalizedPath(result.folder)) {
      source.path = result.folder;
      source.name = path.basename(result.folder) || source.name;
      changed = true;
    }
    if (result.tracking) source.tracking = result.tracking;
    if (result.vaultBridgeId) source.vaultBridgeId = result.vaultBridgeId;
    const nextAssets = (result.assets || []).map(asset => ({ ...asset, id: previousByPath.get(normalizedPath(asset.path)) || asset.id }));
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
  changed = removeLibraryAssetReferences(data, removedIds) || changed;
  if (changed) await writeStore(profile, data);
  return { refreshedSourceIds: targets.map(source => String(source.id)), removedAssetIds: [...removedIds] };
}

function localMediaSource(profile, source) {
  return source && !source.vaultBridgeId && source.path && !isRecycleBinPath(source.path) && !isInDeckDiscardPath(profile, source.path);
}

async function syncMediaLocations(profile) {
  profile = await ensureProfileLibraryFolders(profile);
  const data = await readStore(profile);
  await ensureProfileDefaultSaveSource(profile, data);
  const moved = [], skipped = [], conflicts = [];

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
  await writeStore(profile, data);
  return { moved, skipped, conflicts };
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
async function createWindow(profileId = null) {
  let profile = profileId ? await profileById(profileId) : await defaultProfile();
  if (!profile) throw new Error('Profile not found');
  if (isProfileReady(profile)) profile = await trackProfileLibraryLocation(profile);
  const existing = profileWindows.get(profile.id);
  if (existing && !existing.isDestroyed()) { focusWindow(existing); return existing; }
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
  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(`${APP_DISPLAY_NAME} — ${profile.name}`);
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
  window.loadFile(rendererEntry());
  return window;
}

app.whenReady().then(async () => {
  await migrateLegacyAppData();
  await migrateProfileDataPaths();
  await ensureTaskbarIcon();
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
  for (const profile of startupProfiles.profiles) {
    if (isProfileReady(profile)) await restoreProfileLibraryLocation(profile);
  }
  await ensureProfileShortcuts();
  let currentDefaultProfile = await defaultProfile();
  if (isProfileReady(currentDefaultProfile)) {
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
  }
  registerNativeMessagingHost().catch(error => console.error('Could not register native messaging host:', error.message));
  configureAutoUpdater();
  async function readReconciledStore(profile) {
    const data = await readStore(profile);
    // Snapshot reads are on the hot path during app startup, source watcher
    // updates, and UI changes.  They must not recursively walk DefaultSave or
    // stat every known Media.  Source changes are reconciled by the watcher,
    // explicit refresh, import, recovery, and source removal flows instead.
    const defaultSaveChanged = await ensureProfileDefaultSaveSource(profile, data, { scan: false });
    if (defaultSaveChanged) await writeStore(profile, data);
    return data;
  }
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
    const profile = await createProfile(name);
    return { id: profile.id, name: profile.name, isDefault: false, initialized: false };
  });
  ipcMain.handle('profiles:rename', async (_, profileId, name) => {
    const profile = await renameProfile(profileId, name);
    const window = profileWindows.get(profile.id);
    if (window && !window.isDestroyed()) window.setTitle(`${APP_DISPLAY_NAME} — ${profile.name}`);
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
  ipcMain.handle('folder:scan', async (event, source) => scanSource(await profileForWebContents(event.sender), source));
  ipcMain.handle('source:catalog', async (event, source) => cachedSourceScan(await profileForWebContents(event.sender), source));
  ipcMain.handle('source:catalog-remove', async (event, sourceId) => removeCachedSource(await profileForWebContents(event.sender), sourceId));
  ipcMain.handle('source:resolve', (_, source) => resolveSource(source));
  ipcMain.handle('thumbnails:ensure', async (event, assets, requestId) => createThumbnails(await profileForWebContents(event.sender), assets, requestId));
  ipcMain.handle('thumbnails:cancel', async (event, requestId) => {
    cancelThumbnailRequest(await profileForWebContents(event.sender), requestId);
  });
  ipcMain.handle('vault:bridges', async () => (await readVaultBridges())
    .filter(item => item?.id && item?.folder)
    .map(item => ({ id: String(item.id), folder: String(item.folder), tracking: bridgeTracking(item) })));
  ipcMain.handle('media:sync-locations', async event => syncMediaLocations(await profileForWebContents(event.sender)));
  ipcMain.handle('sources:refresh', async (event, folders) => refreshTrackedSources(await profileForWebContents(event.sender), folders));
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
  ipcMain.handle('media:trash', async (_, asset) => {
    try {
      if (asset?.vault || !asset?.path || isRecycleBinPath(asset.path)) return false;
      await shell.trashItem(asset.path);
      return true;
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
