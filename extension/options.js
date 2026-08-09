const NATIVE_HOST_NAME = 'com.indeck.mastervision';
const select = document.querySelector('#profile');
const save = document.querySelector('#save');
const status = document.querySelector('#status');

function nativeRequest(message) {
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: false, error: 'No response from InDeck.' });
    });
  });
}
function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}
async function loadProfiles() {
  const result = await nativeRequest({ type: 'profiles:list' });
  if (!result.ok) {
    select.innerHTML = '<option>Không thể kết nối InDeck</option>';
    setStatus(`${result.error}. Mở InDeck một lần sau khi cài bản desktop, rồi tải lại extension.`, true);
    return;
  }
  const saved = await chrome.storage.local.get('indeckProfileId');
  select.innerHTML = result.profiles.map(profile => `<option value="${profile.id}">${profile.name}${profile.isDefault ? ' (Default)' : ''}</option>`).join('');
  select.value = result.profiles.some(profile => profile.id === saved.indeckProfileId) ? saved.indeckProfileId : result.profiles[0]?.id || '';
  select.disabled = !select.value;
  save.disabled = !select.value;
  setStatus(saved.indeckProfileId ? 'Lựa chọn hiện tại đã được tải.' : 'Hãy lưu một profile để bắt đầu.');
}
save.addEventListener('click', async () => {
  await chrome.storage.local.set({ indeckProfileId: select.value });
  setStatus(`Đã chọn profile “${select.options[select.selectedIndex].text}”.`);
});
loadProfiles();
