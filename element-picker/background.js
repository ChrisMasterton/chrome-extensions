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

// Capture the visible tab so the content script can build element crops.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'ELEMENT_PICKER_CAPTURE_VISIBLE') {
    return;
  }

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
});
