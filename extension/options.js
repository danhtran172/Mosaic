const NATIVE_HOST_NAMES = ['com.mosaic.app', 'com.mosaictest.app', 'com.indeck.mastervision'];
const select = document.querySelector('#profile');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
const connection = document.querySelector('#connection');

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
  return { ok: false, error: lastError };
}
function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
  connection.textContent = error ? 'Not connected' : 'Connected';
  connection.dataset.state = error ? 'error' : 'ready';
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}
function profileLabel(profile) {
  const suffix = profile.isDefault ? ' (Default)' : '';
  return `${profile.name}${suffix}${profile.available ? '' : ` — unavailable: ${profile.reason || 'Mosaic cannot access this profile.'}`}`;
}
function renderProfiles(profiles, selectedId) {
  if (!profiles.length) {
    select.innerHTML = '<option>No profiles found</option>';
    select.disabled = true;
    save.disabled = true;
    return null;
  }
  select.innerHTML = profiles.map(profile => `<option value="${escapeHtml(profile.id)}"${profile.available ? '' : ' disabled'}>${escapeHtml(profileLabel(profile))}</option>`).join('');
  const selected = profiles.find(profile => profile.id === selectedId && profile.available)
    || profiles.find(profile => profile.available)
    || null;
  select.value = selected?.id || '';
  select.disabled = !selected;
  save.disabled = !selected;
  return selected;
}
async function loadProfiles() {
  select.disabled = true;
  save.disabled = true;
  refresh.disabled = true;
  connection.textContent = 'Checking';
  connection.dataset.state = 'loading';
  const stored = await chrome.storage.local.get(['indeckProfileId', 'mosaicProfileHost', 'mosaicExtensionProfiles']);
  const result = await nativeRequest({ type: 'profiles:list' }, stored.mosaicProfileHost);
  refresh.disabled = false;
  if (!result.ok) {
    const cached = Array.isArray(stored.mosaicExtensionProfiles) ? stored.mosaicExtensionProfiles.map(profile => ({
      ...profile,
      available: false,
      reason: 'Mosaic is not connected.',
    })) : [];
    renderProfiles(cached, stored.indeckProfileId);
    setStatus(cached.length ? 'Mosaic is not connected. Cached profiles are shown but cannot be selected.' : result.error || 'Could not connect to Mosaic.', true);
    return;
  }
  const profiles = (result.profiles || []).map(profile => ({ ...profile, available: profile.available !== false }));
  await chrome.storage.local.set({ mosaicExtensionProfiles: profiles, mosaicProfileHost: result.hostName });
  const selected = renderProfiles(profiles, stored.indeckProfileId);
  if (!selected) setStatus('Profiles are listed, but none have an available Default Library Location.', true);
  else setStatus(stored.indeckProfileId ? 'Current profile selection loaded.' : 'Choose a profile and save to begin.');
}
save.addEventListener('click', async () => {
  const selected = select.options[select.selectedIndex];
  if (!selected?.value || selected.disabled) return;
  const stored = await chrome.storage.local.get('mosaicProfileHost');
  await chrome.storage.local.set({ indeckProfileId: select.value, mosaicProfileHost: stored.mosaicProfileHost || null });
  setStatus(`Selected profile: “${selected.text}”.`);
});
refresh.addEventListener('click', () => { void loadProfiles(); });
void loadProfiles();
