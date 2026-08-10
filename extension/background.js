const NATIVE_HOST_NAME = 'com.indeck.mastervision';
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
    justification: 'Copy an image dropped onto the Mosaic Extension copy target.'
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
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('The dropped item is not an image');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Image is too large to copy');
    return { ok: true, dataUrl: bytesToDataUrl(bytes, response.headers.get('content-type').split(';')[0]) };
  } catch (error) { return { ok: false, error: error.message }; }
}
async function copyImageToClipboard({ url, dataUrl }) {
  try {
    const imageData = dataUrl || (await fetchImageData(url)).dataUrl;
    if (!imageData) throw new Error('Không thể đọc dữ liệu ảnh.');
    await ensureClipboardDocument();
    const result = await chrome.runtime.sendMessage({ type: 'offscreen-copy-image', dataUrl: imageData });
    if (!result?.ok) throw new Error(result?.error || 'Không thể copy ảnh.');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || 'Không thể copy ảnh.' }; }
}

function nativeRequest(message) {
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, response => {
      const error = chrome.runtime.lastError;
      if (error) return resolve({ ok: false, error: `${error.message}. Open Mosaic once after installing it, then reload this extension.` });
      resolve(response || { ok: false, error: 'Mosaic did not return a response.' });
    });
  });
}
async function selectedProfileId() {
  const value = await chrome.storage.local.get('indeckProfileId');
  return value.indeckProfileId || null;
}
async function saveToInDeck(url, galleryId = null) {
  const profileId = await selectedProfileId();
  if (!profileId) return { ok: false, error: 'Chọn profile trong Extension Settings trước khi lưu.' };
  const result = await nativeRequest({ type: 'media:import', profileId, url, galleryId });
  if (!result.ok) return result;
  if (result.saved !== true) return { ok: false, error: 'Ảnh chưa được xác nhận là đã lưu vào Library.' };
  return { ok: true, saved: true, name: result.asset?.name, galleryId: result.galleryId || null };
}
async function extensionConfig() {
  const profileId = await selectedProfileId();
  if (!profileId) return { ok: false, error: 'Chọn profile trong Extension Settings trước.' };
  const result = await nativeRequest({ type: 'profile:config', profileId });
  if (result.ok) await chrome.storage.local.set({ indeckExtensionConfig: result });
  return result;
}
async function setGallerySlot(index, galleryId) {
  const current = await extensionConfig();
  if (!current.ok) return current;
  const slots = [...(current.slots || [])];
  const gallery = (current.galleries || []).find(item => item.id === galleryId);
  if (!gallery) return { ok: false, error: 'Gallery không còn khả dụng.' };
  const existing = slots.findIndex(item => item.id === galleryId);
  if (existing >= 0) slots.splice(existing, 1);
  slots[index] = gallery;
  return nativeRequest({ type: 'profile:slots', profileId: await selectedProfileId(), galleryIds: slots.map(item => item?.id || null) });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'save-image' && message.url) saveToInDeck(message.url, message.galleryId).then(sendResponse);
  else if (message?.type === 'copy-image') copyImageToClipboard(message).then(sendResponse);
  else if (message?.type === 'get-extension-config') extensionConfig().then(sendResponse);
  else if (message?.type === 'set-gallery-slot') setGallerySlot(Number(message.index), message.galleryId).then(sendResponse);
  else if (message?.type === 'get-image-data' && message.url) fetchImageData(message.url).then(sendResponse);
  else return false;
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save-image-to-indeck', title: 'Save image to Mosaic', contexts: ['image'] });
});
chrome.runtime.onClicked?.addListener(() => chrome.runtime.openOptionsPage());
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-image-to-indeck') return;
  const result = await saveToInDeck(info.srcUrl);
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'web-extention-result', ...result });
});
