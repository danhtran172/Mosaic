const NATIVE_HOST_NAME = 'com.indeck.mastervision';
const select = document.querySelector('#profile');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
const connection = document.querySelector('#connection');

function nativeRequest(message) {
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: false, error: 'Mosaic did not return a response.' });
    });
  });
}
function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
  connection.textContent = error ? 'Chưa kết nối' : 'Đã kết nối';
  connection.dataset.state = error ? 'error' : 'ready';
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}
async function loadProfiles() {
  select.disabled = true;
  save.disabled = true;
  refresh.disabled = true;
  connection.textContent = 'Đang kiểm tra';
  connection.dataset.state = 'loading';
  const result = await nativeRequest({ type: 'profiles:list' });
  refresh.disabled = false;
  if (!result.ok) {
    select.innerHTML = '<option>Không thể kết nối Mosaic</option>';
    setStatus(result.error || 'Không thể kết nối Native Messaging Host.', true);
    return;
  }
  const saved = await chrome.storage.local.get('indeckProfileId');
  if (!result.profiles.length) {
    select.innerHTML = '<option>Chưa có profile sẵn sàng</option>';
    setStatus('Hãy hoàn tất Default Library Location cho ít nhất một profile trong Mosaic.', true);
    return;
  }
  select.innerHTML = result.profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}${profile.isDefault ? ' (Default)' : ''}</option>`).join('');
  select.value = result.profiles.some(profile => profile.id === saved.indeckProfileId) ? saved.indeckProfileId : result.profiles[0]?.id || '';
  select.disabled = !select.value;
  save.disabled = !select.value;
  setStatus(saved.indeckProfileId ? 'Đã tải lựa chọn hiện tại.' : 'Chọn một profile rồi lưu để bắt đầu.');
}
save.addEventListener('click', async () => {
  await chrome.storage.local.set({ indeckProfileId: select.value });
  setStatus(`Đã chọn profile “${select.options[select.selectedIndex].text}”.`);
});
refresh.addEventListener('click', () => { void loadProfiles(); });
void loadProfiles();
