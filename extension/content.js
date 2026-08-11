let draggedImageUrl = null;
let copyZone = null;
let saveTray = null;
let draggingGallery = false;
let saveTrayRequest = 0;

function imageUrlFor(event) {
  const image = event.target.closest?.('img');
  return image?.currentSrc || image?.src || null;
}
function removeZones() {
  saveTrayRequest += 1;
  copyZone?.remove();
  saveTray?.remove();
  copyZone = null;
  saveTray = null;
  draggedImageUrl = null;
}
function dropUrl(event) { return draggedImageUrl || event.dataTransfer?.getData('text/uri-list'); }
function isRemoteUrl(url) { return /^https?:/i.test(url || ''); }
function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Image data could not be read.'));
    reader.readAsDataURL(blob);
  });
}
async function copyDataFor(url, event) {
  if (url?.startsWith('data:image/')) return url;
  if (url?.startsWith('blob:')) return readBlobAsDataUrl(await fetch(url).then(response => response.blob()));
  const file = event.dataTransfer?.files?.[0];
  if (file?.type.startsWith('image/')) return readBlobAsDataUrl(file);
  return null;
}
async function writeImageToClipboard(dataUrl) {
  const blob = await fetch(dataUrl).then(response => response.blob());
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('The image could not be processed for copying.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
function showToast(message) {
  const toast = document.createElement('div');
  toast.id = 'indeck-extension-toast';
  toast.textContent = message;
  document.documentElement.append(toast);
  setTimeout(() => toast.remove(), 3500);
}
function setSaving(slot, saving) {
  if (!slot) return;
  slot.classList.toggle('is-saving', saving);
  const label = slot.querySelector('.indeck-slot-copy strong');
  if (saving && label) label.textContent = 'Saving image…';
}
async function saveImage(event, gallery, slot) {
  event.preventDefault();
  const url = dropUrl(event);
  if (!isRemoteUrl(url)) { showToast('This image has no web URL that Mosaic can save.'); removeZones(); return; }
  setSaving(slot, true);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'save-image', url, galleryId: gallery?.id || null });
    const target = result?.galleryId && gallery ? `Gallery “${gallery.name}”` : 'the default folder';
    const fileName = result?.name ? `“${result.name}” ` : '';
    showToast(result?.ok && result?.saved === true ? `Saved ${fileName}to ${target}.` : (result?.error || 'The image could not be saved.'));
  } catch {
    showToast('Could not connect to Mosaic to save the image.');
  } finally {
    removeZones();
  }
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function makeDropTarget({ kind, gallery, defaultFolder }) {
  const slot = document.createElement('button');
  slot.type = 'button';
  slot.className = `indeck-save-slot ${kind === 'default' ? 'indeck-default-slot' : ''} ${gallery ? 'has-gallery' : 'is-empty'}`;
  slot.dataset.galleryId = gallery?.id || '';
  slot.innerHTML = kind === 'default'
    ? `<span class="indeck-slot-icon">⌁</span><span class="indeck-slot-copy"><strong>Save to default</strong><small>${defaultFolder?.name || 'DefaultSave'}</small></span>`
    : gallery
      ? `<span class="indeck-slot-copy"><strong>${escapeHtml(gallery.name)}</strong><small>Drop an image to save it in this Gallery</small></span>`
      : `<span class="indeck-slot-add">＋</span><span class="indeck-slot-copy"><strong>Empty slot</strong><small>Drag a Gallery here</small></span>`;
  slot.addEventListener('dragover', event => {
    const galleryPayload = event.dataTransfer?.getData('application/x-mosaic-gallery');
    if (galleryPayload || draggedImageUrl) { event.preventDefault(); slot.classList.add('is-over'); }
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('is-over'));
  slot.addEventListener('drop', async event => {
    slot.classList.remove('is-over');
    const galleryPayload = event.dataTransfer?.getData('application/x-mosaic-gallery');
    if (kind !== 'default' && galleryPayload) {
      event.preventDefault();
      await replaceSlot(Number(slot.dataset.slotIndex), galleryPayload);
      return;
    }
    await saveImage(event, gallery || null, slot);
  });
  return slot;
}
async function replaceSlot(index, galleryId) {
  const result = await chrome.runtime.sendMessage({ type: 'set-gallery-slot', index, galleryId });
  if (!result?.ok) { showToast(result?.error || 'The Gallery could not be saved to this slot.'); return; }
  renderSaveTray(result);
}
function renderSaveTray(config) {
  if (!saveTray) return;
  const slots = Array.isArray(config.slots) ? config.slots : [];
  const mosaicIcon = chrome.runtime.getURL('icons/mosaic.png');
  saveTray.innerHTML = `
    <div class="indeck-tray-title"><img src="${mosaicIcon}" alt="" style="width:20px;height:20px;border-radius:6px;object-fit:cover"><span>Mosaic</span><small>Drop an image on a destination</small></div>
    <div class="indeck-save-targets"></div>
    <div class="indeck-gallery-row">
      <label for="indeck-gallery-select">＋ Add Gallery slot</label>
      <select id="indeck-gallery-select"><option value="">Choose a Gallery…</option>${(config.galleries || []).map(gallery => `<option value="${escapeHtml(gallery.id)}">${escapeHtml(gallery.name)}</option>`).join('')}</select>
      <button type="button" id="indeck-gallery-list">Drag Gallery</button>
    </div>
    <div class="indeck-gallery-picker" hidden></div>`;
  const targets = saveTray.querySelector('.indeck-save-targets');
  targets.append(makeDropTarget({ kind: 'default', defaultFolder: config.defaultFolder }));
  for (let index = 0; index < 4; index += 1) {
    const slot = makeDropTarget({ kind: 'gallery', gallery: slots[index], defaultFolder: config.defaultFolder });
    slot.dataset.slotIndex = String(index);
    targets.append(slot);
  }
  const select = saveTray.querySelector('#indeck-gallery-select');
  select.addEventListener('change', async () => {
    if (!select.value) return;
    await replaceSlot(slots.length < 4 ? slots.length : 3, select.value);
  });
  const picker = saveTray.querySelector('.indeck-gallery-picker');
  saveTray.querySelector('#indeck-gallery-list').addEventListener('click', () => {
    picker.hidden = !picker.hidden;
    picker.innerHTML = (config.galleries || []).map(gallery => `<button type="button" draggable="true" data-gallery-id="${escapeHtml(gallery.id)}">◇ <span>${escapeHtml(gallery.name)}</span></button>`).join('') || '<small>No Galleries are available in Mosaic.</small>';
    picker.querySelectorAll('[data-gallery-id]').forEach(item => item.addEventListener('dragstart', event => {
      draggingGallery = true;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-mosaic-gallery', item.dataset.galleryId);
    }));
  });
}
function showCopyZone() {
  if (copyZone) return;
  copyZone = document.createElement('div');
  copyZone.id = 'indeck-copy-zone';
  copyZone.innerHTML = '<span>⧉</span><strong>Copy image</strong><small>Clipboard</small>';
  copyZone.addEventListener('dragover', event => { event.preventDefault(); copyZone.classList.add('is-over'); });
  copyZone.addEventListener('dragleave', () => copyZone.classList.remove('is-over'));
  copyZone.addEventListener('drop', async event => {
    event.preventDefault();
    const url = dropUrl(event);
    let dataUrl = await copyDataFor(url, event).catch(() => null);
    if (!dataUrl && isRemoteUrl(url)) {
      const fetched = await chrome.runtime.sendMessage({ type: 'get-image-data', url });
      dataUrl = fetched?.ok ? fetched.dataUrl : null;
    }
    if (!dataUrl) { showToast('Image data could not be read for copying.'); removeZones(); return; }
    const result = await chrome.runtime.sendMessage({ type: 'copy-image', url, dataUrl });
    showToast(result?.ok ? 'Image copied.' : (result?.error || 'The image could not be copied.'));
    removeZones();
  });
  document.documentElement.append(copyZone);
}
async function showSaveTray() {
  if (saveTray) return;
  const request = ++saveTrayRequest;
  saveTray = document.createElement('section');
  saveTray.id = 'indeck-save-tray';
  renderSaveTray({ defaultFolder: { name: 'DefaultSave' }, galleries: [], slots: [null, null, null, null] });
  document.documentElement.append(saveTray);
  const config = await chrome.runtime.sendMessage({ type: 'get-extension-config' });
  if (request !== saveTrayRequest || !draggedImageUrl || !saveTray) return;
  if (!config?.ok) {
    saveTray.innerHTML = '<div class="indeck-tray-loading">Open Mosaic and choose a destination profile in Extension Settings.</div>';
    return;
  }
  renderSaveTray(config);
}

document.addEventListener('dragstart', event => {
  const url = imageUrlFor(event);
  if (!url) return;
  draggedImageUrl = url;
  showCopyZone();
  void showSaveTray();
}, true);
document.addEventListener('dragend', () => {
  if (draggingGallery) { draggingGallery = false; return; }
  setTimeout(removeZones, 0);
}, true);
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'mosaic-extension-result') showToast(message.ok && message.saved === true ? 'Image saved.' : (message.error || 'The image could not be saved.'));
});
