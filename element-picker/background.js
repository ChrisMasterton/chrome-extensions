// Handle extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  // Inject the picker script into the current tab
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['picker.js']
  });
  
  // Inject styles
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ['picker.css']
  });
});

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      },
      (downloadId) => {
        if (chrome.runtime.lastError || typeof downloadId !== 'number') {
          resolve({
            ok: false,
            error: chrome.runtime.lastError?.message || 'Unable to save screenshot',
          });
          return;
        }

        chrome.downloads.search({ id: downloadId }, (items) => {
          resolve({
            ok: true,
            downloadId,
            requestedFilename: filename,
            filename: items?.[0]?.filename || filename,
          });
        });
      }
    );
  });
}

// Capture the visible tab so the content script can build element crops.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.type === 'ELEMENT_PICKER_CAPTURE_VISIBLE') {
    const windowId = sender?.tab?.windowId;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError?.message || 'Unable to capture viewport',
        });
        return;
      }

      sendResponse({ ok: true, dataUrl });
    });

    return true;
  }

  if (message.type === 'ELEMENT_PICKER_SAVE_IMAGE') {
    downloadDataUrl(message.dataUrl, message.filename).then(sendResponse);
    return true;
  }
});
