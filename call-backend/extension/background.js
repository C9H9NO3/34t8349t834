// Click the extension icon on the Google Voice tab to start streaming its audio
// to the backend. Click again to stop.

let capturing = false;

chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) {
    chrome.runtime.sendMessage({ type: "stop-capture" });
    capturing = false;
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const hasDoc = await chrome.offscreen.hasDocument?.();
  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture call audio for live transcription.",
    });
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });
  chrome.runtime.sendMessage({ type: "start-capture", streamId });
  capturing = true;
  chrome.action.setBadgeText({ text: "REC" });
});
