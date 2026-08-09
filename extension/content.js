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
    reader.onerror = () => reject(new Error('Không thể đọc dữ liệu ảnh.'));
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
  if (!png) throw new Error('Không thể xử lý ảnh để copy.');
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
  if (saving && label) label.textContent = 'Đang lưu ảnh…';
}
async function saveImage(event, gallery, slot) {
  event.preventDefault();
  const url = dropUrl(event);
  if (!isRemoteUrl(url)) { showToast('Ảnh này không có URL web để lưu vào InDeck.'); removeZones(); return; }
  setSaving(slot, true);
  const galleryId = gallery?.id || null;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'save-image', url, galleryId });
    const target = result?.galleryId && gallery ? `Gallery “${gallery.name}”` : 'thư mục mặc định';
    const fileName = result?.name ? `“${result.name}” ` : '';
    showToast(result?.ok ? `Đã lưu ${fileName}vào ${target}.` : (result?.error || 'Không thể lưu ảnh.'));
  } catch {
    showToast('Không thể kết nối với InDeck để lưu ảnh.');
  } finally {
    removeZones();
  }
}
function makeDropTarget({ kind, gallery, defaultFolder }) {
  const slot = document.createElement('button');
  slot.type = 'button';
  slot.className = `indeck-save-slot ${kind === 'default' ? 'indeck-default-slot' : ''} ${gallery ? 'has-gallery' : 'is-empty'}`;
  slot.dataset.galleryId = gallery?.id || '';
  slot.innerHTML = kind === 'default'
    ? `<span class="indeck-slot-icon">⌁</span><span class="indeck-slot-copy"><strong>Lưu mặc định</strong><small>${defaultFolder?.name || 'DefaultSave'}</small></span>`
    : gallery
      ? `<span class="indeck-slot-copy"><strong>${escapeHtml(gallery.name)}</strong><small>Thả ảnh để thêm vào Gallery</small></span>`
      : `<span class="indeck-slot-add">＋</span><span class="indeck-slot-copy"><strong>Slot trống</strong><small>Kéo Gallery vào đây</small></span>`;
  slot.addEventListener('dragover', event => {
    const galleryPayload = event.dataTransfer?.getData('application/x-indeck-gallery');
    if (galleryPayload || draggedImageUrl) { event.preventDefault(); slot.classList.add('is-over'); }
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('is-over'));
  slot.addEventListener('drop', async event => {
    slot.classList.remove('is-over');
    const galleryPayload = event.dataTransfer?.getData('application/x-indeck-gallery');
    if (kind !== 'default' && galleryPayload) {
      event.preventDefault();
      await replaceSlot(Number(slot.dataset.slotIndex), galleryPayload);
      return;
    }
    await saveImage(event, gallery || null, slot);
  });
  return slot;
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
async function replaceSlot(index, galleryId) {
  const result = await chrome.runtime.sendMessage({ type: 'set-gallery-slot', index, galleryId });
  if (!result?.ok) { showToast(result?.error || 'Không thể lưu Gallery vào slot.'); return; }
  renderSaveTray(result);
}
function renderSaveTray(config) {
  if (!saveTray) return;
  const slots = Array.isArray(config.slots) ? config.slots : [];
  saveTray.innerHTML = `
    <div class="indeck-tray-title"><span>InDeck</span><small>Thả ảnh vào đích muốn lưu</small></div>
    <div class="indeck-save-targets"></div>
    <div class="indeck-gallery-row">
      <label for="indeck-gallery-select">＋ Chọn Gallery để thêm slot</label>
      <select id="indeck-gallery-select"><option value="">Chọn từ danh sách Gallery…</option>${(config.galleries || []).map(gallery => `<option value="${escapeHtml(gallery.id)}">${escapeHtml(gallery.name)}</option>`).join('')}</select>
      <button type="button" id="indeck-gallery-list">Kéo Gallery</button>
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
    const firstEmpty = slots.length < 4 ? slots.length : 3;
    await replaceSlot(firstEmpty, select.value);
  });
  const picker = saveTray.querySelector('.indeck-gallery-picker');
  saveTray.querySelector('#indeck-gallery-list').addEventListener('click', () => {
    picker.hidden = !picker.hidden;
    picker.innerHTML = (config.galleries || []).map(gallery => `<button type="button" draggable="true" data-gallery-id="${escapeHtml(gallery.id)}">◇ <span>${escapeHtml(gallery.name)}</span></button>`).join('') || '<small>Chưa có Gallery khả dụng trong InDeck.</small>';
    picker.querySelectorAll('[data-gallery-id]').forEach(item => item.addEventListener('dragstart', event => {
      draggingGallery = true;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-indeck-gallery', item.dataset.galleryId);
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
    if (!dataUrl) { showToast('Không thể đọc dữ liệu ảnh để copy.'); removeZones(); return; }
    const result = await chrome.runtime.sendMessage({ type: 'copy-image', url, dataUrl });
    showToast(result?.ok ? 'Đã copy ảnh.' : (result?.error || 'Không thể copy ảnh.'));
    removeZones();
  });
  document.documentElement.append(copyZone);
}
async function showSaveTray() {
  if (saveTray) return;
  const request = ++saveTrayRequest;
  saveTray = document.createElement('section');
  saveTray.id = 'indeck-save-tray';
  // Expose the targets immediately while the desktop bridge is loading.
  renderSaveTray({ defaultFolder: { name: 'DefaultSave' }, galleries: [], slots: [null, null, null, null] });
  document.documentElement.append(saveTray);
  const config = await chrome.runtime.sendMessage({ type: 'get-extension-config' });
  if (request !== saveTrayRequest || !draggedImageUrl || !saveTray) return;
  if (!config?.ok) { return;
    saveTray.innerHTML = '<div class="indeck-tray-loading">Mở ứng dụng InDeck để chọn Gallery.</div>';
    document.documentElement.append(saveTray);
    return;
  }
  renderSaveTray(config);
  document.documentElement.append(saveTray);
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
  if (message?.type === 'web-extention-result') showToast(message.ok ? 'Đã lưu ảnh.' : message.error);
});
