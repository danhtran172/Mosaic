async function writePng(dataUrl) {
  const source = await fetch(dataUrl).then(response => response.blob());
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('The image could not be processed for copying.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'offscreen-copy-image') return false;
  writePng(message.dataUrl)
    .then(() => sendResponse({ ok: true }))
    .catch(error => sendResponse({ ok: false, error: error.message || 'The image could not be copied.' }));
  return true;
});
