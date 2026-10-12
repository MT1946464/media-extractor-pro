// =============================================
// Image & Video Extractor — Service Worker (ES Module)
// Manifest V3 | Production Ready
// Only processes standard HTML pages.
// Does NOT interact with streaming services.
// =============================================

// ── Blocked Streaming / DRM Domains ───────────
const BLOCKED_DOMAINS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'netflix.com', 'primevideo.com', 'disneyplus.com',
  'hulu.com', 'hbomax.com', 'max.com', 'peacocktv.com',
  'paramountplus.com', 'espn.com', 'twitch.tv',
  'spotify.com', 'tidal.com', 'deezer.com',
  'soundcloud.com', 'vimeo.com', 'dailymotion.com',
  'bilibili.com', 'crunchyroll.com', 'funimation.com'
];

function isBlockedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return BLOCKED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ── Badge Helper ──────────────────────────────
function setBadge(count, tabId) {
  const text = count > 0 ? (count > 999 ? '99+' : String(count)) : '';
  const colorOpts = { color: '#6366f1' };
  const textOpts  = { text };
  if (tabId) { colorOpts.tabId = tabId; textOpts.tabId = tabId; }

  chrome.action.setBadgeBackgroundColor(colorOpts).catch(() => {});
  chrome.action.setBadgeText(textOpts).catch(() => {});
}

// ── Pinterest Live Download URL Validator ─────
async function resolveValidPinterestDownloadUrl(url) {
  if (!url || !url.includes('pinimg.com/videos')) return url;
  const hashMatch = url.match(/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{32})/i);
  if (!hashMatch) return url;
  const [, p1, p2, p3, hash] = hashMatch;

  const isIht = url.includes('/iht/');
  const candidates = isIht ? [
    `https://v1.pinimg.com/videos/iht/expMp4/${p1}/${p2}/${p3}/${hash}_720w.mp4`,
    `https://v1.pinimg.com/videos/mc/720p/${p1}/${p2}/${p3}/${hash}.mp4`,
    `https://v1.pinimg.com/videos/mc/expMp4/${p1}/${p2}/${p3}/${hash}_t1.mp4`,
    `https://v.pinimg.com/videos/iht/expMp4/${p1}/${p2}/${p3}/${hash}_720w.mp4`
  ] : [
    `https://v1.pinimg.com/videos/mc/720p/${p1}/${p2}/${p3}/${hash}.mp4`,
    `https://v1.pinimg.com/videos/iht/expMp4/${p1}/${p2}/${p3}/${hash}_720w.mp4`,
    `https://v1.pinimg.com/videos/mc/expMp4/${p1}/${p2}/${p3}/${hash}_t1.mp4`,
    `https://v.pinimg.com/videos/mc/720p/${p1}/${p2}/${p3}/${hash}.mp4`
  ];

  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate, { method: 'HEAD' });
      const ctype = resp.headers.get('content-type') || '';
      if (resp.ok && (ctype.includes('video') || ctype.includes('octet-stream') || !ctype.includes('xml'))) {
        return candidate;
      }
    } catch {}
  }
  return url;
}

// ── Original High-Resolution Image Resolver ───
async function resolveOriginalImageUrl(url) {
  if (!url) return url;

  // 1. Pinterest Images (NOT video files)
  if (url.includes('pinimg.com') && !url.includes('/videos/')) {
    if (url.includes('/originals/')) return url;

    // Test originals first
    const origUrl = url.replace(/\/(?:236x|474x|564x|736x|1200x)\//, '/originals/');
    try {
      const resp = await fetch(origUrl, { method: 'HEAD' });
      const ctype = resp.headers.get('content-type') || '';
      if (resp.ok && ctype.includes('image')) {
        return origUrl;
      }
    } catch {}

    // Fallback to 736x
    const highResUrl = url.replace(/\/(?:236x|474x|564x|1200x)\//, '/736x/');
    try {
      const resp = await fetch(highResUrl, { method: 'HEAD' });
      const ctype = resp.headers.get('content-type') || '';
      if (resp.ok && ctype.includes('image')) {
        return highResUrl;
      }
    } catch {}

    return url;
  }

  // 2. Twitter / X
  if (url.includes('twimg.com')) {
    return url.replace(/([?&]name=)[a-z0-9_]+/i, '$1orig');
  }

  // 3. WordPress
  if (url.match(/-\d{2,4}x\d{2,4}\.(jpe?g|png|webp|avif)$/i)) {
    return url.replace(/-\d{2,4}x\d{2,4}(\.(jpe?g|png|webp|avif))$/i, '$1');
  }

  // 4. Google / Blogspot
  if (url.includes('googleusercontent.com') || url.includes('ggpht.com')) {
    if (url.match(/=(?:w\d+-h\d+|s\d+)(?:-[a-z0-9]+)*$/i)) {
      return url.replace(/=(?:w\d+-h\d+|s\d+)(?:-[a-z0-9]+)*$/i, '=s0');
    }
  }

  // 5. Shopify
  if (url.includes('cdn.shopify.com')) {
    return url.replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|1024x1024|2048x2048)\./i, '.');
  }

  // 6. Reddit
  if (url.includes('preview.redd.it')) {
    return url.split('?')[0].replace('preview.redd.it', 'i.redd.it');
  }

  return url;
}

// ── Message Handler ───────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (request.action === 'updateBadge') {
    setBadge(request.count ?? 0, tabId);
    return false;
  }

  if (request.action === 'downloadImage') {
    let { url, filename, saveAs = false } = request;
    if (!url) return false;

    (async () => {
      try {
        if (url.includes('pinimg.com/videos')) {
          url = await resolveValidPinterestDownloadUrl(url);
        } else {
          url = await resolveOriginalImageUrl(url);
        }
        await chrome.downloads.download({
          url,
          filename: filename || `media-extractor-pro/file_${Date.now()}`,
          saveAs,
          conflictAction: 'uniquify',
        });
      } catch (err) {
        console.warn('[MEP] download error:', err);
      }
    })();

    return false;
  }
});

// ── Tab Update → Refresh Badge ────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  // Do not inject into streaming/DRM platforms
  if (isBlockedUrl(tab.url)) {
    setBadge(0, tabId);
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    }).catch(() => {}); // ok if already injected

    // Short wait for content script to settle
    await new Promise(r => setTimeout(r, 500));

    chrome.tabs.sendMessage(tabId, { action: 'extractMedia' }, res => {
      if (chrome.runtime.lastError) return;
      if (res) {
        const count = (res.images?.length || 0) + (res.videos?.length || 0) + (res.audios?.length || 0);
        setBadge(count, tabId);
      }
    });
  } catch { /* tab not scriptable */ }
});

// ── Tab Activated → Update Badge ──────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome://')) {
      setBadge(0, tabId);
      return;
    }

    chrome.tabs.sendMessage(tabId, { action: 'extractMedia' }, res => {
      if (chrome.runtime.lastError) return;
      if (res) {
        const count = (res.images?.length || 0) + (res.videos?.length || 0) + (res.audios?.length || 0);
        setBadge(count, tabId);
      }
    });
  } catch { /* ignore */ }
});

// ── Context Menus Setup ───────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mep_extract_page',
      title: 'Extract Media with Media Extractor Pro',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'mep_download_original',
      title: 'Download in Original HD Quality',
      contexts: ['image', 'video']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'mep_extract_page') {
    if (chrome.action.openPopup) {
      chrome.action.openPopup().catch(() => {});
    }
  } else if (info.menuItemId === 'mep_download_original') {
    const rawUrl = info.srcUrl || info.linkUrl;
    if (!rawUrl) return;
    let downloadUrl = rawUrl;
    if (downloadUrl.includes('pinimg.com/videos')) {
      downloadUrl = await resolveValidPinterestDownloadUrl(downloadUrl);
    } else {
      downloadUrl = await resolveOriginalImageUrl(downloadUrl);
    }
    const ext = downloadUrl.split('?')[0].split('.').pop() || 'jpg';
    chrome.downloads.download({
      url: downloadUrl,
      filename: `media-extractor-pro/original_${Date.now()}.${ext}`,
      saveAs: false,
      conflictAction: 'uniquify'
    }).catch(err => console.warn('[MEP] context menu download error:', err));
  }
});



// =============================================
// Background Download Jobs (ZIP / bulk files)
// The heavy lifting runs in an offscreen document so it keeps
// going after the popup closes. Job state lives in
// chrome.storage.session so the popup can show progress when reopened.
// =============================================
const JOB_KEY       = 'mepJob';
const BLOBS_KEY     = 'mepBlobDownloads';
const OFFSCREEN_URL = 'background/offscreen.html';
let creatingOffscreen = null;

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const ctx = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Fetch media and build ZIP archives in the background'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function getJob() {
  const data = await chrome.storage.session.get(JOB_KEY);
  return data[JOB_KEY] || null;
}

// Serialize read-modify-write updates so rapid progress messages don't clobber each other
let jobWriteChain = Promise.resolve();
function updateJob(patch) {
  jobWriteChain = jobWriteChain.then(async () => {
    const job = (await getJob()) || {};
    const next = { ...job, ...patch, updatedAt: Date.now() };
    if (patch.phase && patch.phase !== job.phase && !('percentOverride' in patch)) delete next.percentOverride;
    await chrome.storage.session.set({ [JOB_KEY]: next });
    setJobBadge(next);
    if (['done', 'error', 'cancelled'].includes(next.state)) maybeCloseOffscreen();
    return next;
  }).catch(err => console.warn('[MEP] job update failed:', err));
  return jobWriteChain;
}

function setJobBadge(job) {
  const tabId = job.tabId;
  let text = '', color = '#6366f1';
  if (job.state === 'running') {
    const pct = job.percentOverride != null
      ? job.percentOverride
      : (job.total ? Math.floor((job.done / job.total) * 100) : 0);
    text = `${pct}%`;
    color = '#f59e0b';
  } else if (job.state === 'done') { text = '✓'; color = '#10b981'; }
  else if (job.state === 'error') { text = '!'; color = '#ef4444'; }
  else return;
  const o = tabId ? { tabId } : {};
  chrome.action.setBadgeBackgroundColor({ ...o, color }).catch(() => {});
  chrome.action.setBadgeText({ ...o, text }).catch(() => {});
}

async function maybeCloseOffscreen() {
  const job = await getJob();
  if (job && job.state === 'running') return;
  const blobs = (await chrome.storage.session.get(BLOBS_KEY))[BLOBS_KEY] || {};
  if (Object.keys(blobs).length) return; // a blob-backed download is still being written
  if (await hasOffscreen()) chrome.offscreen.closeDocument().catch(() => {});
}

async function startJob(job, tabId) {
  const current = await getJob();
  if (current && current.state === 'running') {
    if (await hasOffscreen()) return { ok: false, error: 'A download job is already running' };
    // stale state (e.g. extension reloaded mid-job) — fall through and replace it
  }
  if (!job.items?.length) return { ok: false, error: 'Nothing to download' };

  await chrome.storage.session.set({
    [JOB_KEY]: {
      id: Date.now(), mode: job.mode, state: 'running', phase: 'Starting',
      total: job.items.length, done: 0, failed: 0, message: '', tabId, startedAt: Date.now()
    }
  });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'runJob', job }).catch(e => ({ ok: false, error: e.message }));
  if (!res?.ok) {
    await updateJob({ state: 'error', message: res?.error || 'Background worker did not start' });
    return { ok: false, error: res?.error || 'Background worker did not start' };
  }
  return { ok: true };
}

async function cancelJob() {
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancelJob' }).catch(() => {});
  } else {
    await updateJob({ state: 'cancelled', message: 'Cancelled' });
  }
}

async function jobDownload({ url, filename, saveAs, isBlob }) {
  try {
    let finalUrl = url;
    if (!isBlob) {
      finalUrl = url.includes('pinimg.com/videos')
        ? await resolveValidPinterestDownloadUrl(url)
        : await resolveOriginalImageUrl(url);
    }
    const id = await chrome.downloads.download({
      url: finalUrl, filename, saveAs: !!saveAs, conflictAction: 'uniquify'
    });
    if (isBlob && id != null) {
      const blobs = (await chrome.storage.session.get(BLOBS_KEY))[BLOBS_KEY] || {};
      blobs[id] = url;
      await chrome.storage.session.set({ [BLOBS_KEY]: blobs });
    }
    return { ok: id != null, id };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// Free blob memory once the browser has finished writing the file
chrome.downloads.onChanged.addListener(async delta => {
  const st = delta.state?.current;
  if (st !== 'complete' && st !== 'interrupted') return;
  const blobs = (await chrome.storage.session.get(BLOBS_KEY))[BLOBS_KEY] || {};
  const blobUrl = blobs[delta.id];
  if (!blobUrl) return;
  delete blobs[delta.id];
  await chrome.storage.session.set({ [BLOBS_KEY]: blobs });
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'revokeBlob', url: blobUrl }).catch(() => {});
  maybeCloseOffscreen();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;

  if (msg.action === 'startJob') {
    startJob(msg.job, msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'cancelJob') {
    cancelJob().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'jobProgress') {
    updateJob(msg.patch || {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'jobDownload') {
    jobDownload(msg).then(sendResponse);
    return true;
  }
  return false;
});
