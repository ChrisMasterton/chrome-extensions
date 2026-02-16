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
