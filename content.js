// DOM media discovery and playback evidence. Network capture handles
// blob/MediaSource players and cross-origin HLS requests.
(function installScanner() {
  // This global belongs to Chrome's isolated extension world, not the page.
  // Install synchronously so simultaneous static/manual injections share it.
  const singletonKey = "__yangmoContentScanner", owner = "yangmo-content", version = 1;
  const previous = globalThis[singletonKey];
  if (previous?.owner === owner && previous.document === document && previous.version === version && typeof previous.forceRescan === "function") {
    return previous.forceRescan().then(result => {
      if (!result.invalidated) return result;
      // An extension reload may leave an old isolated-world closure behind.
      // Replace it once with this execution's runtime; never retry in a loop.
      previous.dispose();
      if (globalThis[singletonKey] === previous) delete globalThis[singletonKey];
      return installScanner();
    });
  }
  if (previous?.owner === owner && typeof previous.dispose === "function") previous.dispose();
  const memo = new Map(), pendingReports = new Set(), videoHooks = new Map();
  const videoPlayback = new WeakMap();
  const newDocumentToken = () => typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  let documentToken = newDocumentToken();
  // A newly injected scanner is a new activation, including after extension
  // reload on a document previously restored from BFCache.
  let documentStartedAt = Date.now();
  let playbackGeneration = 0;
  let nextVideoId = 0;
  let sourceSignature = "";
  let active = true, disposed = false, runtimeInvalidated = false;
  let scanTimer;
  const scope = () => ({ documentToken, generation: playbackGeneration });
  const isCurrent = snapshot => !disposed && snapshot.documentToken === documentToken && snapshot.generation === playbackGeneration;
  function send(message) {
    const snapshot = scope();
    return new Promise(resolve => {
      let timer, settled = false;
      const finish = accepted => {
        if (settled) return;
        settled = true; clearTimeout(timer); pendingReports.delete(cancel);
        resolve(Boolean(accepted && isCurrent(snapshot)));
      };
      const cancel = () => finish(false); pendingReports.add(cancel);
      const failed = error => { if (/extension context invalidated/i.test(error?.message || "")) runtimeInvalidated = true; finish(false); };
      // A lost reply must not leave executeScript or a future rescan hanging.
      timer = setTimeout(cancel, 4000);
      try {
        Promise.resolve(chrome.runtime.sendMessage({ ...message, ...snapshot, documentStartedAt })).then(response =>
          finish(response?.status !== "ignored" && (response?.status === "ok" || response?.success === true)), failed);
      } catch (error) { failed(error); }
    });
  }
  function report(category, message, force = false) {
    const key = JSON.stringify(message);
    let entry = memo.get(category);
    if (!entry || entry.key !== key) { entry = { key, accepted: false, pending: null }; memo.set(category, entry); }
    if (entry.pending) return entry.pending;
    if (entry.accepted && !force) return Promise.resolve(true);
    const snapshot = scope();
    const operation = send(message).then(accepted => {
      if (isCurrent(snapshot) && memo.get(category) === entry) entry.accepted = accepted;
      entry.pending = null; return accepted;
    });
    entry.pending = operation;
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    return operation;
  }
  function absoluteUrl(value) {
    if (!value) return null;
    try { const url = new URL(value, document.baseURI); return /^https?:$/.test(url.protocol) ? url.href : null; }
    catch { return null; }
  }
  function reportUrl(value, { name = "", mime = "", explicitVideo = false, active = false, title = document.title || "" } = {}, force = false) {
    const url = absoluteUrl(value);
    if (!url || (!explicitVideo && /\.(ts|m4s)(?:$|[?#])/i.test(url))) return;
    const playlist = /\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(mime);
    // data-url also occurs on articles, ads, and navigation. HTTP alone does
    // not make a URL a media playlist.
    if (!playlist && !explicitVideo && !/\.(mp4|webm|mov|mkv|flv|m4v|mp3|m4a|aac|ogg)(?:$|[?#])/i.test(url)) return;
    const key = `${url}|${mime}|${name}|${explicitVideo}`;
    return report(`url:${key}`, { action: playlist ? "reportMasterStream" : "reportDOMVideo", url, mime, name, active,
      directVideo: explicitVideo, title }, force);
  }
  function videoSource(video) { return video.srcObject ? '' : video.currentSrc || video.src || ""; }
  function observeVideo(video, event) {
    // currentSrc can still name the previous movie after src is reassigned.
    // Prefer the declared source and wait until the loaded source matches it.
    const declared = video.srcObject ? [] : [video.src || "", ...[...video.querySelectorAll("source[src]")].map(item => item.src)].filter(Boolean);
    const source = JSON.stringify(declared.length ? declared : [videoSource(video)]);
    let state = videoPlayback.get(video);
    if (!state) {
      state = { id: ++nextVideoId, source, sourceObject: video.srcObject || null, revision: 0, observed: false, playing: false };
      videoPlayback.set(video, state);
    }
    if (source !== state.source || state.sourceObject !== (video.srcObject || null) || event?.type === "emptied") {
      state.source = source; state.sourceObject = video.srcObject || null;
      state.revision++; state.observed = false; state.playing = false;
    }
    const playbackEvent = event?.isTrusted !== false && event?.type === "playing";
    // A preload, a seek, and loadedmetadata on a paused video are not proof
    // of playback. This also detects a player already running when we attach.
    const sourceMatches = !declared.length || declared.includes(video.currentSrc);
    const running = sourceMatches && !video.paused && !video.ended && video.readyState >= 2;
    const hasPlayedRange = sourceMatches && video.played?.length > 0;
    if (event?.type !== "emptied" && (playbackEvent || running || hasPlayedRange)) state.observed = true;
    state.playing = state.observed && running;
    return state;
  }
  function reportPlayback(force = false) {
    const videos = [...document.querySelectorAll("video")];
    const states = videos.map(video => observeVideo(video));
    const selection = [...document.querySelectorAll("[udata], [data-url]")].filter(element => element.getAttribute("name") === "lineData" && element.classList.contains("active"))
      .map(element => absoluteUrl(element.getAttribute("udata") || element.getAttribute("data-url")));
    const signature = JSON.stringify([document.URL || document.baseURI, selection, states.map(state => [state.id, state.source, state.revision])]);
    if (signature !== sourceSignature) {
      for (const cancel of [...pendingReports]) cancel();
      sourceSignature = signature; playbackGeneration++; memo.clear();
    }
    const state = {
      action: "reportPlaybackState", videoCount: videos.length,
      iframeCount: document.querySelectorAll("iframe, frame").length,
      hasPlayed: states.some(item => item.observed), playing: states.some(item => item.playing),
      generation: playbackGeneration
    };
    return report("playback", state, force);
  }
  function inspectVideo(video) {
    const reports = [{ value: videoSource(video), options: { explicitVideo: true } }];
    if (!video.srcObject) video.querySelectorAll("source[src]").forEach(source => reports.push({ value: source.src, options: { mime: source.type, explicitVideo: true } }));
    if (videoHooks.has(video)) return reports;
    const listeners = new Map(); videoHooks.set(video, listeners);
    const listen = (event, handler) => { listeners.set(event, handler); video.addEventListener(event, handler); };
    for (const event of ["play", "playing", "loadedmetadata", "emptied", "pause", "ended"]) listen(event, eventInfo => {
      if (!active || disposed) return;
      observeVideo(video, eventInfo); void scan();
    });
    listen("timeupdate", () => {
      if (!active || disposed) return;
      // At most the first advancing frame changes playback state. Do not send
      // or persist a status update for every video-clock tick.
      if (!videoPlayback.get(video)?.observed && !video.paused && !video.ended && video.readyState >= 2 && video.currentTime > 0) reportPlayback();
    });
    return reports;
  }
  function unhookVideo(video) {
    for (const [event, handler] of videoHooks.get(video) || []) video.removeEventListener(event, handler);
    videoHooks.delete(video);
  }
  function scan(force = false) {
    if (scanTimer !== undefined) { clearTimeout(scanTimer); scanTimer = undefined; }
    if (!active || disposed) return Promise.resolve({ success: false, inactive: true, ...scope(), reports: 0, failedReports: 0 });
    const playback = reportPlayback(force), snapshot = scope(), title = document.title || "", media = [];
    document.querySelectorAll("[udata], [data-url]").forEach(element => {
      // ikanbot renders all episodes and routes. Only the selected episode is
      // relevant; inactive URLs would otherwise flood the popup with 196 rows.
      if (element.getAttribute("name") === "lineData" && !element.classList.contains("active")) return;
      media.push({ value: element.getAttribute("udata") || element.getAttribute("data-url"), options: {
        name: (element.getAttribute("title") || element.textContent || "").trim().slice(0, 80),
        active: element.getAttribute("name") === "lineData"
      } });
    });
    const videos = new Set(document.querySelectorAll("video"));
    for (const video of videoHooks.keys()) if (!videos.has(video)) unhookVideo(video);
    videos.forEach(video => media.push(...inspectVideo(video)));
    const outcome = results => ({
      success: active && isCurrent(snapshot) && results.every(Boolean), ...snapshot,
      reports: results.length, failedReports: results.filter(value => !value).length,
      ...(!active || disposed ? { inactive: true } : {}), ...(runtimeInvalidated ? { invalidated: true } : {})
    });
    return (async () => {
      // Identity/generation and filename metadata must be accepted before URLs
      // can use them. Independent media reports then proceed in parallel.
      const results = [await playback];
      if (!results[0] || !active || !isCurrent(snapshot)) return outcome(results);
      if (window.top === window && title) results.push(await report("title", { action: "reportPageTitle", title }, force));
      if (!results.every(Boolean) || !active || !isCurrent(snapshot)) return outcome(results);
      results.push(...await Promise.all(media.map(item => reportUrl(item.value, { ...item.options, title }, force)).filter(Boolean)));
      return outcome(results);
    })();
  }
  function scheduleScan() { if (active && !disposed && scanTimer === undefined) scanTimer = setTimeout(() => { scanTimer = undefined; void scan(); }, 200); }
  const observer = new MutationObserver(records => {
    // Video clocks, captions and unrelated CSS animations should not trigger a
    // full scan. Observe selected-route classes and actual media insertions.
    const selector = "video, source, iframe, frame, [udata], [data-url], title";
    if (records.some(record => {
      if (record.type === "attributes") return record.attributeName === "class"
        ? record.target.getAttribute("name") === "lineData"
        : record.target.matches?.(selector);
      return record.target.matches?.("title") || [...(record.addedNodes || []), ...(record.removedNodes || [])].some(node =>
        node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector)));
    })) scheduleScan();
  });
  const observeDocument = () => observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["src", "udata", "data-url", "type", "class"]
  });
  function pageHide() {
    // Removed/navigated iframes must not leave a permanently "playing" entry
    // behind. A BFCache restore gets a fresh activation token below.
    active = false; observer.disconnect();
    if (scanTimer !== undefined) { clearTimeout(scanTimer); scanTimer = undefined; }
    for (const cancel of [...pendingReports]) cancel();
    playbackGeneration++;
    send({ action: "reportPlaybackState", videoCount: 0, iframeCount: 0,
      hasPlayed: false, playing: false, inactive: true });
  }
  function pageShow(event) {
    if (disposed) return;
    if (event.persisted) {
      // BFCache restores the same Document object after a navigation reset.
      // Treat this activation as fresh so both playback and URLs are resent.
      documentToken = newDocumentToken(); documentStartedAt = Date.now();
      for (const cancel of [...pendingReports]) cancel();
      memo.clear();
    }
    active = true; observeDocument();
    scheduleScan();
  }
  function dispose() {
    disposed = true; active = false; observer.disconnect();
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    for (const cancel of [...pendingReports]) cancel();
    for (const video of videoHooks.keys()) unhookVideo(video);
    window.removeEventListener("pagehide", pageHide); window.removeEventListener("pageshow", pageShow);
    memo.clear();
  }
  Object.defineProperty(globalThis, singletonKey, { configurable: true, value: Object.freeze({ owner, version, document, forceRescan: () => scan(true), dispose }) });
  window.addEventListener("pagehide", pageHide); window.addEventListener("pageshow", pageShow);
  observeDocument();
  return scan();
})();
