// A single extension can talk to either the installed Mosaic app or MosaicTest.
// The stored preference only makes the successful host the first attempt;
// every request still falls back to the other compatible host.
const NATIVE_HOST_NAMES = ['com.mosaic.app', 'com.mosaictest.app', 'com.indeck.mastervision'];
const OFFSCREEN_URL = 'offscreen.html';
let offscreenReady = false;

async function ensureClipboardDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] });
    if (contexts.length) return;
  } else if (offscreenReady) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['CLIPBOARD'],
    justification: 'Copy an image dropped onto the Mosaic Extension copy target.',
  }).catch(error => {
    if (!/single offscreen document/i.test(String(error?.message || error))) throw error;
  });
  offscreenReady = true;
}

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
async function fetchImageData(url) {
  try {
    const response = await fetch(url);
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('The dropped item is not an image.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('The image is too large to copy.');
    return { ok: true, dataUrl: bytesToDataUrl(bytes, response.headers.get('content-type').split(';')[0]) };
  } catch (error) { return { ok: false, error: error.message }; }
}
async function copyImageToClipboard({ url, dataUrl }) {
  try {
    const imageData = dataUrl || (await fetchImageData(url)).dataUrl;
    if (!imageData) throw new Error('Image data could not be read.');
    await ensureClipboardDocument();
    const result = await chrome.runtime.sendMessage({ type: 'offscreen-copy-image', dataUrl: imageData });
    if (!result?.ok) throw new Error(result?.error || 'The image could not be copied.');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || 'The image could not be copied.' }; }
}

function requestFromHost(hostName, message) {
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(hostName, message, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: false, error: 'Mosaic did not return a response.' });
    });
  });
}
async function nativeRequest(message, preferredHost = null) {
  const hosts = [...new Set([preferredHost, ...NATIVE_HOST_NAMES].filter(Boolean))];
  let lastError = 'The Mosaic Native Messaging Host is not available.';
  for (const hostName of hosts) {
    const response = await requestFromHost(hostName, message);
    if (response?.ok) return { ...response, hostName };
    lastError = response?.error || lastError;
  }
  return { ok: false, error: `${lastError}. Open Mosaic once after installing it, then reload this extension.` };
}
async function selectedProfile() {
  const value = await chrome.storage.local.get(['indeckProfileId', 'mosaicProfileHost']);
  return { id: value.indeckProfileId || null, hostName: value.mosaicProfileHost || null };
}
async function saveToMosaic(url, galleryId = null) {
  const profile = await selectedProfile();
  if (!profile.id) return { ok: false, error: 'Choose a profile in Extension Settings before saving.' };
  const result = await nativeRequest({ type: 'media:import', profileId: profile.id, url, galleryId }, profile.hostName);
  if (!result.ok) return result;
  if (result.saved !== true) return { ok: false, error: 'The image was not confirmed in the Library.' };
  return { ok: true, saved: true, name: result.asset?.name, galleryId: result.galleryId || null };
}
async function extensionConfig() {
  const profile = await selectedProfile();
  if (!profile.id) return { ok: false, error: 'Choose a profile in Extension Settings first.' };
  const result = await nativeRequest({ type: 'profile:config', profileId: profile.id }, profile.hostName);
  if (result.ok) await chrome.storage.local.set({ indeckExtensionConfig: result, mosaicProfileHost: result.hostName });
  return result;
}
async function setGallerySlot(index, galleryId) {
  const current = await extensionConfig();
  if (!current.ok) return current;
  const slots = [...(current.slots || [])];
  const gallery = (current.galleries || []).find(item => item.id === galleryId);
  if (!gallery) return { ok: false, error: 'This Gallery is no longer available.' };
  const existing = slots.findIndex(item => item.id === galleryId);
  if (existing >= 0) slots.splice(existing, 1);
  slots[index] = gallery;
  const profile = await selectedProfile();
  return nativeRequest({ type: 'profile:slots', profileId: profile.id, galleryIds: slots.map(item => item?.id || null) }, current.hostName || profile.hostName);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'save-image' && message.url) saveToMosaic(message.url, message.galleryId).then(sendResponse);
  else if (message?.type === 'copy-image') copyImageToClipboard(message).then(sendResponse);
  else if (message?.type === 'get-extension-config') extensionConfig().then(sendResponse);
  else if (message?.type === 'set-gallery-slot') setGallerySlot(Number(message.index), message.galleryId).then(sendResponse);
  else if (message?.type === 'get-image-data' && message.url) fetchImageData(message.url).then(sendResponse);
  else return false;
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save-image-to-mosaic', title: 'Save image to Mosaic', contexts: ['image'] });
});
chrome.runtime.onClicked?.addListener(() => chrome.runtime.openOptionsPage());
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-image-to-mosaic') return;
  const result = await saveToMosaic(info.srcUrl);
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'mosaic-extension-result', ...result });
});
