(function(){
  "use strict";
  var doc = document, root = doc.documentElement, body = doc.body;
  function id(x){ return doc.getElementById(x); }

  var empty         = id("empty");
  var playerView    = id("playerView");
  var playerCard    = id("playerCard");
  var coverArt      = id("coverArt");
  var coverFallback = id("coverFallback");
  var trackTitle    = id("trackTitle");
  var trackArtist   = id("trackArtist");
  var trackAlbum    = id("trackAlbum");
  var wave          = id("wave");
  var audioMount    = id("audioMount");
  var metaLine      = id("metaLine");
  var noticeEl      = id("audioNotice");
  var fileInput     = id("fileInput");
  var overlay       = id("dropOverlay");
  var toastEl       = id("toast");
  var docTitle      = id("docTitle");
  var hoverZone     = id("hoverZone");
  var bgPicker      = id("bgPicker");
  var themeColor    = id("themeColor");
  var footerEl      = id("footer");
  var topbar        = doc.querySelector(".topbar");
  var brandIcon     = id("brandIcon");

  // Reuse the favicon (single source of truth) for the header brand icon.
  var favLink = doc.querySelector('link[rel="icon"]');
  if (brandIcon && favLink) brandIcon.src = favLink.href;

  var BASE_TITLE = "Audio Viewer";
  var MAX_WAVE_BYTES = 50 * 1024 * 1024;   // skip the waveform decode past ~50 MB
  var MAX_TAG_BYTES  = 20 * 1024 * 1024;   // sanity cap for an ID3v2 tag
  var MAX_ART_BYTES  = 10 * 1024 * 1024;   // sanity cap for embedded cover art

  var currentFile = null;
  var currentName = "";
  var audioEl = null;          // the mounted <audio> (rebuilt per file so listeners stay fresh)
  var objectUrl = null;        // playback object URL — revoked on drop-to-replace and on Clear
  var audioCtx = null;         // lazy AudioContext for waveform peaks
  var loadSeq = 0;             // guards async tag/waveform work against a newer load
  var wavePeaks = null;
  var tagInfo = null;
  var mode = "player";         // rendered plane only (binary viewer — no source plane)
  var toastTimer = null;

  // ---------- v2 playback state (§17.2 v2) ----------
  var loopOn = false;          // session-only; applied to each mounted <audio> (never persisted)
  var RATES = [0.75, 1, 1.25, 1.5, 2];
  var rateIdx = 1;             // resets to 1× per new file (never persisted)
  var rafId = 0;               // playhead rAF loop (runs only while playing)
  var MS = ("mediaSession" in navigator) ? navigator.mediaSession : null;
  // Volume + mute persist across visits ("fv-vol" / "fv-muted"); file:// safe.
  var savedVol = null, savedMuted = false;
  try {
    var sv = localStorage.getItem("fv-vol");
    if (sv !== null && sv !== "" && isFinite(+sv)) savedVol = Math.min(1, Math.max(0, +sv));
    savedMuted = localStorage.getItem("fv-muted") === "1";
  } catch (e){}

  // Accepted audio types. .wma/.mid/.midi are accepted-with-notice: browsers ship
  // no native decoder (or synthesizer) for them, so they get an honest card
  // instead of a broken player. Everything else plays via the native element.
  var ACCEPT_EXT = {
    mp3:1, wav:1, flac:1, m4a:1, aac:1, ogg:1, oga:1, opus:1,
    weba:1, mka:1, aif:1, aiff:1, wma:1, mid:1, midi:1
  };
  var ACCEPT_NAME = {};
  var NOTICE_EXT = { wma:1, mid:1, midi:1 };
  var FMT_LABEL = {
    mp3:"MP3", wav:"WAV", flac:"FLAC", m4a:"M4A (AAC)", aac:"AAC",
    ogg:"OGG", oga:"OGG (Vorbis)", opus:"Opus", weba:"WebM audio", mka:"Matroska audio",
    aif:"AIFF", aiff:"AIFF", wma:"Windows Media Audio", mid:"MIDI", midi:"MIDI"
  };

  function extOf(name){ var m = /\.([a-z0-9_]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; }
  function isAccepted(name){
    if (!name) return false;
    var base = String(name).toLowerCase().split("/").pop().split("\\").pop();
    return ACCEPT_NAME[base] === 1 || ACCEPT_EXT[extOf(base)] === 1;
  }
  function baseName(name){
    var b = String(name || "").split("/").pop().split("\\").pop();
    var stem = b.replace(/\.[a-z0-9_]+$/i, "");
    return stem || b;
  }

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove("show"); }, 1900);
  }

  function fmtBytes(n){
    if (!(n >= 0)) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function fmtTime(t){
    if (!isFinite(t) || t < 0) return "";
    var s = Math.round(t), m = Math.floor(s / 60); s -= m * 60;
    var h = Math.floor(m / 60); m -= h * 60;
    return (h ? h + ":" + (m < 10 ? "0" : "") + m : String(m)) + ":" + (s < 10 ? "0" : "") + s;
  }
  function updateMeta(dur){
    var parts = [];
    if (dur) parts.push(fmtTime(dur));
    var ext = extOf(currentName);
    parts.push(FMT_LABEL[ext] || (ext ? "." + ext : "Audio"));
    if (currentFile) parts.push(fmtBytes(currentFile.size));
    metaLine.textContent = parts.join(" · ");
  }

  // ---------- Player lifecycle ----------
  function teardownAudio(){
    if (rafId){ cancelAnimationFrame(rafId); rafId = 0; }
    if (audioEl){
      try { audioEl.pause(); } catch (e){}
      audioEl.removeAttribute("src");
      try { audioEl.load(); } catch (e){}
      if (audioEl.parentNode) audioEl.parentNode.removeChild(audioEl);
      audioEl = null;
    }
    if (objectUrl){ URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }
  function resetPlayerUi(){
    coverArt.hidden = true; coverArt.removeAttribute("src");
    coverFallback.hidden = false;
    trackArtist.hidden = true; trackArtist.textContent = "";
    trackAlbum.hidden = true; trackAlbum.textContent = "";
    wave.hidden = true; wavePeaks = null;
    wave.setAttribute("aria-valuenow", "0");
    wave.setAttribute("aria-valuemax", "0");
    wave.removeAttribute("aria-valuetext");
    var g = wave.getContext && wave.getContext("2d");
    if (g) g.clearRect(0, 0, wave.width, wave.height);
    noticeEl.hidden = true; noticeEl.textContent = "";
    metaLine.textContent = "";
  }

  // Reflect the loaded file's name into the URL (?name=), so a bookmarked or
  // shared link says what was being viewed. history.replaceState only, and
  // URLSearchParams does its own percent-encoding — this never touches the
  // DOM, so it carries no XSS risk on its own. The value becomes untrusted
  // input again the moment it is read back (see the on-load block near the
  // bottom of this script), and that path must stay textContent-only.
  function syncQueryName(name){
    var url = new URL(location.href);
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  function showAudio(file){
    var seq = ++loadSeq;
    teardownAudio();          // revokes the previous object URL (drop-to-replace)
    resetPlayerUi();
    currentFile = file; currentName = file.name || ""; tagInfo = null;
    syncQueryName(currentName);

    empty.hidden = true;
    playerView.hidden = false;
    docTitle.textContent = currentName || BASE_TITLE;
    doc.title = currentName ? currentName + " — " + BASE_TITLE : BASE_TITLE;
    body.classList.add("viewing");
    revealHeader();           // rendered plane: header shows, then collapses to the handle after 3 s
    window.scrollTo(0, 0);
    playerView.scrollTop = 0;

    var ext = extOf(currentName);
    trackTitle.textContent = baseName(currentName);   // tag title replaces this if present
    updateMeta(0);

    if (NOTICE_EXT[ext]){     // accept-with-notice: no native decoder — honest card, no player
      playerCard.hidden = true;
      showNotice(noticeCopy(ext));
      return;
    }

    playerCard.hidden = false;

    // Mount a fresh <audio controls> on an object URL. Playback never touches
    // FileReader — the browser streams straight from the File on disk.
    objectUrl = URL.createObjectURL(file);
    audioEl = doc.createElement("audio");
    audioEl.controls = true;
    audioEl.preload = "metadata";
    audioEl.setAttribute("aria-label", "Audio player");
    audioEl.addEventListener("loadedmetadata", function(){
      if (seq !== loadSeq) return;
      updateMeta(audioEl.duration);
      syncWaveAria();
    });
    audioEl.addEventListener("error", function(){ if (seq === loadSeq) codecHint(ext); });
    audioEl.addEventListener("stalled", function(){
      if (seq === loadSeq && audioEl && !(audioEl.duration > 0)) codecHint(ext);
    });
    // v2: live playhead (rAF only while playing; timeupdate keeps it honest when paused)
    audioEl.addEventListener("play", startRaf);
    audioEl.addEventListener("pause", stopRaf);
    audioEl.addEventListener("ended", stopRaf);
    audioEl.addEventListener("timeupdate", function(){
      if (seq !== loadSeq) return;
      syncWaveAria();
      if (!rafId) drawWave();
    });
    // v2: volume + mute persistence (fires for both volume and muted changes)
    audioEl.addEventListener("volumechange", function(){
      if (seq !== loadSeq || !audioEl) return;
      savedVol = audioEl.volume; savedMuted = audioEl.muted;
      try {
        localStorage.setItem("fv-vol", String(audioEl.volume));
        localStorage.setItem("fv-muted", audioEl.muted ? "1" : "0");
      } catch (e){}
    });
    if (savedVol !== null) audioEl.volume = savedVol;   // apply persisted volume before the first play
    audioEl.muted = savedMuted;
    rateIdx = 1; applyRate();                           // speed resets to 1× per new file
    applyLoop();                                        // loop is session state — reapply to the fresh element
    audioEl.src = objectUrl;
    audioMount.appendChild(audioEl);
    updateMediaSession();                               // filename first; ID3 tags refine it async

    readTags(file, seq);      // ID3v2.3/v2.4: title, artist, album, year, cover art
    buildWave(file, seq);     // Web Audio peaks (silently skipped >50 MB or if decode fails)
  }

  function clearAll(){
    loadSeq++;
    teardownAudio();          // revokes the object URL
    resetPlayerUi();
    currentFile = null; currentName = ""; tagInfo = null;
    syncQueryName("");
    trackTitle.textContent = "";
    playerView.hidden = true; playerCard.hidden = true;
    empty.hidden = false;
    docTitle.textContent = BASE_TITLE;
    doc.title = BASE_TITLE;
    body.classList.remove("viewing", "hdr-hidden");
    clearTimeout(hdrIdleTimer);
    if (MS){ try { MS.metadata = null; } catch (e){} }
  }

  function readFile(file){
    if (!file) return;
    if (!isAccepted(file.name)){
      if (!familyRoute(file)) toast("“" + file.name + "” isn’t a supported audio file");
      return;
    }
    showAudio(file);
  }

  // ---------- Notice / codec-hint cards (textContent-only sinks) ----------
  function showNotice(copy){
    noticeEl.textContent = "";
    var h = doc.createElement("div"); h.className = "audio-notice-title"; h.textContent = copy.title;
    var p = doc.createElement("p"); p.textContent = copy.body;
    var q = doc.createElement("p"); q.className = "audio-notice-sub"; q.textContent = "Your file was not uploaded anywhere.";
    noticeEl.appendChild(h); noticeEl.appendChild(p); noticeEl.appendChild(q);
    noticeEl.hidden = false;
  }
  function noticeCopy(ext){
    if (ext === "mid" || ext === "midi") return {
      title: "Can’t play a “." + ext + "” file",
      body: "MIDI files are musical scores, not recorded audio — browsers don’t ship a synthesizer for them. Render it to audio in a DAW or player (GarageBand, VLC, TiMidity++) and save it as .mp3 or .wav to play it here."
    };
    return {
      title: "Can’t play a “." + ext + "” file",
      body: "Windows Media Audio has no in-browser decoder. Convert it to .mp3 or .flac (VLC or ffmpeg does this in seconds) to play it here."
    };
  }
  function codecHint(ext){
    // Browser-dependent honesty (the image viewer's .heic pattern): the type is
    // accepted, but this particular browser ships no decoder for it. Never fail silently.
    wave.hidden = true;
    if (audioEl) audioEl.hidden = true;
    showNotice({
      title: "Can’t play " + (FMT_LABEL[ext] || "“." + ext + "”") + " in this browser",
      body: "The format is supported by this viewer, but this browser has no decoder for it (codecs vary by browser build). Try Chrome, Edge or Safari — or convert the file to .mp3, .wav, .flac or .ogg."
    });
  }

  // ---------- ID3v2 reader (v2.3 + v2.4) — original code, no library ----------
  // Only the tag bytes at the head of the file are read (FileReader on a slice);
  // playback itself streams from the object URL.
  function syncsafe(b, i){ return ((b[i] & 0x7f) << 21) | ((b[i+1] & 0x7f) << 14) | ((b[i+2] & 0x7f) << 7) | (b[i+3] & 0x7f); }
  function be32(b, i){ return ((b[i] << 24) | (b[i+1] << 16) | (b[i+2] << 8) | b[i+3]) >>> 0; }
  function latin1(b, s, e){
    var out = "";
    for (var i = s; i < e; i++) out += String.fromCharCode(b[i]);
    return out;
  }
  function decodeText(b, s, e, enc){
    if (e <= s) return "";
    try {
      if (window.TextDecoder){
        if (enc === 3) return new TextDecoder("utf-8").decode(b.subarray(s, e));
        if (enc === 1){
          if (e - s >= 2 && b[s] === 0xff && b[s+1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(s + 2, e));
          if (e - s >= 2 && b[s] === 0xfe && b[s+1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(s + 2, e));
          return new TextDecoder("utf-16le").decode(b.subarray(s, e));
        }
        if (enc === 2) return new TextDecoder("utf-16be").decode(b.subarray(s, e));
      }
    } catch (err){}
    return latin1(b, s, e);   // encoding 0 (ISO-8859-1), or no TextDecoder
  }
  function cutAtNul(str){ var i = str.indexOf("\u0000"); return i >= 0 ? str.slice(0, i) : str; }
  function deunsync(b){
    var out = new Uint8Array(b.length), n = 0;
    for (var i = 0; i < b.length; i++){
      out[n++] = b[i];
      if (b[i] === 0xff && i + 1 < b.length && b[i+1] === 0x00) i++;   // FF 00 -> FF
    }
    return out.subarray(0, n);
  }
  function b64(bytes){
    var out = "", chunk = 0x2000;
    for (var i = 0; i < bytes.length; i += chunk)
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    return btoa(out);
  }

  var TEXT_FRAMES = { TIT2:"title", TPE1:"artist", TALB:"album", TYER:"year", TDRC:"year" };

  function parseId3(u8, major){
    var tags = {}, pos = 0, len = u8.length;
    while (pos + 10 <= len){
      var fid = latin1(u8, pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(fid)) break;                     // padding / garbage — stop
      var fsize = major === 4 ? syncsafe(u8, pos + 4) : be32(u8, pos + 4);
      if (fsize <= 0 || pos + 10 + fsize > len) break;
      var f2 = u8[pos + 9];
      var start = pos + 10, end = start + fsize, skip = false;
      if (major === 4){
        if (f2 & 0x0c) skip = true;                              // compressed / encrypted frame
        if (f2 & 0x01) start += 4;                               // data-length indicator
      } else {
        if (f2 & 0xc0) skip = true;                              // compressed / encrypted frame
        if (f2 & 0x20) start += 1;                               // grouping identity byte
      }
      if (!skip && start < end){
        var m = TEXT_FRAMES[fid];
        var body = u8.subarray(start, end);
        if (major === 4 && (f2 & 0x02)) body = deunsync(body);   // per-frame unsynchronisation
        if (m && !tags[m]){
          var txt = cutAtNul(decodeText(body, 1, body.length, body[0])).replace(/\u0000+$/g, "");
          txt = txt.replace(/^\s+|\s+$/g, "");
          if (fid === "TDRC" || fid === "TYER") txt = txt.slice(0, 4);
          if (txt) tags[m] = txt;
        } else if (fid === "APIC" && !tags.pictureUri && body.length > 4 && body.length <= MAX_ART_BYTES){
          var pic = parseApic(body);
          if (pic) tags.pictureUri = pic;
        }
      }
      pos += 10 + fsize;
    }
    return tags;
  }

  function parseApic(b){
    var enc = b[0], i = 1;
    while (i < b.length && b[i] !== 0) i++;                      // MIME type (latin1, NUL-terminated)
    if (i >= b.length) return null;
    var mime = latin1(b, 1, i) || "image/jpeg";
    i += 1;                                                      // the NUL
    i += 1;                                                      // picture-type byte
    if (enc === 1 || enc === 2){                                 // UTF-16 description: 00 00, pair-aligned
      while (i + 1 < b.length && (b[i] !== 0 || b[i+1] !== 0)) i += 2;
      i += 2;
    } else {                                                     // latin1 / UTF-8 description
      while (i < b.length && b[i] !== 0) i++;
      i += 1;
    }
    if (i >= b.length) return null;
    if (mime.toLowerCase() === "image/jpg") mime = "image/jpeg";
    if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return null;       // data: URI stays an image
    try { return "data:" + mime + ";base64," + b64(b.subarray(i)); }
    catch (err){ return null; }
  }

  function readTags(file, seq){
    var head = new FileReader();
    head.onload = function(){
      if (seq !== loadSeq) return;
      var b = new Uint8Array(head.result || new ArrayBuffer(0));
      if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return;   // no ID3v2 tag
      var major = b[3], flags = b[5];
      if (major !== 3 && major !== 4) return;                    // v2.3 / v2.4 only
      if (flags & 0x80) return;                                  // whole-tag unsynchronisation — bail honestly
      var size = syncsafe(b, 6);
      if (!size || size > MAX_TAG_BYTES) return;
      var rest = new FileReader();
      rest.onload = function(){
        if (seq !== loadSeq) return;
        var u8 = new Uint8Array(rest.result || new ArrayBuffer(0));
        var off = 0;
        if (flags & 0x40){                                       // extended header
          off = major === 4 ? syncsafe(u8, 0) : 4 + be32(u8, 0); // v2.4 size includes itself; v2.3 excludes
          if (!(off > 0) || off >= u8.length) off = 0;
        }
        applyTags(parseId3(u8.subarray(off), major));
      };
      rest.readAsArrayBuffer(file.slice(10, 10 + size));
    };
    head.readAsArrayBuffer(file.slice(0, 10));
  }

  function applyTags(tags){
    tagInfo = tags || {};
    // Tag text is untrusted input — every sink below is textContent.
    if (tags.title) trackTitle.textContent = tags.title;
    if (tags.artist){ trackArtist.textContent = tags.artist; trackArtist.hidden = false; }
    var albumLine = tags.album ? tags.album + (tags.year ? " · " + tags.year : "") : (tags.year || "");
    if (albumLine){ trackAlbum.textContent = albumLine; trackAlbum.hidden = false; }
    if (tags.pictureUri){
      coverArt.src = tags.pictureUri;                            // data: URI (CSP: img-src data:)
      coverArt.hidden = false;
      coverFallback.hidden = true;
    }
    updateMediaSession();                                        // tags beat the filename on the lock screen
  }

  // ---------- Waveform (Web Audio peaks on a copy of the bytes) ----------
  function buildWave(file, seq){
    if (file.size > MAX_WAVE_BYTES) return;                      // skip silently for huge files
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !file.arrayBuffer) return;
    file.arrayBuffer().then(function(buf){
      if (seq !== loadSeq) return;
      try { if (!audioCtx) audioCtx = new AC(); } catch (err){ return; }
      var p = audioCtx.decodeAudioData(buf, function(ab){
        if (seq !== loadSeq) return;
        wavePeaks = computePeaks(ab, 600);
        wave.hidden = false;
        drawWave();
      }, function(){ /* decode failed (codec) — no waveform, no noise */ });
      if (p && p["catch"]) p["catch"](function(){});   // modern engines also return a promise — keep its rejection silent too
    })["catch"](function(){});
  }
  function computePeaks(ab, buckets){
    var ch0 = ab.getChannelData(0);
    var ch1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : null;
    var n = ch0.length, per = Math.max(1, Math.floor(n / buckets));
    var stride = Math.max(1, Math.floor(per / 64));              // sample within each bucket for speed
    var out = [], i, j, s, e, v, w, peak;
    for (i = 0; i < buckets; i++){
      s = i * per; e = Math.min(n, s + per); peak = 0;
      for (j = s; j < e; j += stride){
        v = ch0[j] < 0 ? -ch0[j] : ch0[j];
        if (ch1){ w = ch1[j] < 0 ? -ch1[j] : ch1[j]; if (w > v) v = w; }
        if (v > peak) peak = v;
      }
      out.push(peak);
    }
    return out;
  }
  function drawWave(){
    if (!wavePeaks || wave.hidden) return;
    var dpr = window.devicePixelRatio || 1;
    var cw = wave.clientWidth || 480, ch = wave.clientHeight || 88;
    var W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (wave.width !== W) wave.width = W;      // resizing clears the canvas — only when it changed
    if (wave.height !== H) wave.height = H;    // (the playhead repaints this every frame while playing)
    var g = wave.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, wave.width, wave.height);
    g.fillStyle = getComputedStyle(root).getPropertyValue("--accent").replace(/\s/g, "") || "#4f46e5";
    g.globalAlpha = 0.85;
    var n = wavePeaks.length, bw = wave.width / n, mid = wave.height / 2, h;
    for (var i = 0; i < n; i++){
      h = wavePeaks[i] * (wave.height - 4 * dpr);
      if (h < dpr) h = dpr;
      g.fillRect(i * bw + bw * 0.15, mid - h / 2, bw * 0.7 > 1 ? bw * 0.7 : 1, h);
    }
    g.globalAlpha = 1;
    if (audioEl && isFinite(audioEl.duration) && audioEl.duration > 0){   // live playhead
      var x = (audioEl.currentTime / audioEl.duration) * wave.width;
      g.fillRect(x - dpr, 0, 2 * dpr, wave.height);
    }
  }

  // ---------- v2: playhead loop + seek helpers + slider a11y ----------
  function rafLoop(){ drawWave(); rafId = requestAnimationFrame(rafLoop); }
  function startRaf(){ if (!rafId) rafId = requestAnimationFrame(rafLoop); }
  function stopRaf(){ if (rafId){ cancelAnimationFrame(rafId); rafId = 0; } drawWave(); }
  function syncWaveAria(){
    if (!audioEl) return;
    var d = audioEl.duration, t = audioEl.currentTime || 0;
    if (isFinite(d) && d > 0) wave.setAttribute("aria-valuemax", String(Math.round(d)));
    wave.setAttribute("aria-valuenow", String(Math.floor(t)));
    wave.setAttribute("aria-valuetext", fmtTime(t) + (isFinite(d) && d > 0 ? " of " + fmtTime(d) : ""));
  }
  function seekBy(delta){
    if (!audioEl || !isFinite(audioEl.duration)) return;
    var t = audioEl.currentTime + delta;
    if (t < 0) t = 0;
    if (t > audioEl.duration) t = audioEl.duration;
    audioEl.currentTime = t;
    syncWaveAria();
    if (!rafId) drawWave();
  }
  wave.addEventListener("click", function(e){                    // click-to-seek
    if (!audioEl || !(audioEl.duration > 0)) return;
    var r = wave.getBoundingClientRect();
    var frac = (e.clientX - r.left) / (r.width || 1);
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    audioEl.currentTime = frac * audioEl.duration;
    syncWaveAria();
    if (!rafId) drawWave();
  });
  wave.addEventListener("keydown", function(e){                  // slider keyboard access
    if (e.key === "ArrowRight"){ e.preventDefault(); e.stopPropagation(); seekBy(5); }
    else if (e.key === "ArrowLeft"){ e.preventDefault(); e.stopPropagation(); seekBy(-5); }
  });
  window.addEventListener("resize", drawWave);

  function openDialog(){ fileInput.click(); }

  fileInput.addEventListener("change", function(e){
    var f = e.target.files && e.target.files[0];
    if (f) readFile(f);
    fileInput.value = "";
  });

  // Copy the track details (tags when present, else name + meta line)
  id("btnCopy").addEventListener("click", function(){
    if (!currentFile){ toast("Nothing to copy yet"); return; }
    var t = tagInfo || {};
    var lines = [t.title || baseName(currentName)];
    if (t.artist) lines.push(t.artist);
    if (t.album) lines.push(t.album + (t.year ? " (" + t.year + ")" : ""));
    else if (t.year) lines.push(t.year);
    lines.push(metaLine.textContent || currentName);
    var toCopy = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(toCopy).then(
        function(){ toast("Details copied"); },
        function(){ fallbackCopy(toCopy); }
      );
    } else {
      fallbackCopy(toCopy);
    }
  });

  function fallbackCopy(text){
    var ta = doc.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0";
    doc.body.appendChild(ta); ta.select();
    try { doc.execCommand("copy"); toast("Details copied"); }
    catch (err){ toast("Copy not supported"); }
    doc.body.removeChild(ta);
  }

  id("btnClear").addEventListener("click", clearAll);

  // ---------- v2: loop toggle + playback-speed cycle (session state only) ----------
  var btnLoop = id("btnLoop"), btnSpeed = id("btnSpeed");
  function applyLoop(){
    if (audioEl) audioEl.loop = loopOn;
    btnLoop.setAttribute("aria-pressed", loopOn ? "true" : "false");
    btnLoop.classList.toggle("active", loopOn);
  }
  function toggleLoop(){ loopOn = !loopOn; applyLoop(); }
  btnLoop.addEventListener("click", toggleLoop);
  function applyRate(){
    var r = RATES[rateIdx];
    if (audioEl) audioEl.playbackRate = r;
    btnSpeed.textContent = String(r) + "×";                // the button face IS the state ("1×", "1.25×")
    btnSpeed.setAttribute("aria-label", "Playback speed: " + String(r) + "×");
  }
  btnSpeed.addEventListener("click", function(){ rateIdx = (rateIdx + 1) % RATES.length; applyRate(); });

  // ---------- v2: Media Session — OS media keys + lock-screen metadata ----------
  function updateMediaSession(){
    if (!MS) return;
    var t = tagInfo || {};
    var art = [];
    if (t.pictureUri){
      var mm = /^data:(image\/[a-z0-9.+-]+);/i.exec(t.pictureUri);
      art.push({ src: t.pictureUri, sizes: "300x300", type: mm ? mm[1] : "image/jpeg" });
    }
    try {
      MS.metadata = new MediaMetadata({
        title: t.title || baseName(currentName),
        artist: t.artist || "",
        album: t.album || "",
        artwork: art
      });
    } catch (e){}
  }
  if (MS){
    // setActionHandler throws for unknown actions in older engines — guard each one.
    var msSet = function(action, fn){ try { MS.setActionHandler(action, fn); } catch (e){} };
    msSet("play", function(){ if (audioEl){ var p = audioEl.play(); if (p && p["catch"]) p["catch"](function(){}); } });
    msSet("pause", function(){ if (audioEl) audioEl.pause(); });
    msSet("seekbackward", function(d){ seekBy(-((d && d.seekOffset) || 10)); });
    msSet("seekforward", function(d){ seekBy((d && d.seekOffset) || 10); });
    msSet("seekto", function(d){
      if (!audioEl || !d || typeof d.seekTime !== "number" || !isFinite(audioEl.duration)) return;
      audioEl.currentTime = Math.max(0, Math.min(audioEl.duration, d.seekTime));
      syncWaveAria();
      if (!rafId) drawWave();
    });
  }

  // Empty-state acts as an open button (great on mobile)
  empty.addEventListener("click", openDialog);
  empty.addEventListener("keydown", function(e){
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); openDialog(); }
  });

  // ---------- Header: while viewing it auto-hides after 3s, collapsing to a ----------
  // ---------- thick handle; hover / touch / scroll-up brings it back. ----------------
  var HDR_IDLE_MS = 3000, HDR_THRESH = 6;
  var hdrIdleTimer = null;
  var lastPos = { win:0, pane:0 };

  function showHeader(){ body.classList.remove("hdr-hidden"); }
  // the player is the rendered plane (there is no source plane), so it auto-hides while viewing
  function hideHeader(){ if (body.classList.contains("viewing") && mode === "player") body.classList.add("hdr-hidden"); }
  function armIdleHide(){ clearTimeout(hdrIdleTimer); hdrIdleTimer = setTimeout(hideHeader, HDR_IDLE_MS); }
  function revealHeader(){ showHeader(); armIdleHide(); }

  function onScroll(key, pos){
    if (!body.classList.contains("viewing")) return;
    var delta = pos - lastPos[key];
    lastPos[key] = pos;
    if (delta > HDR_THRESH){ hideHeader(); }            // scroll down -> collapse to the handle
    else if (delta < -HDR_THRESH){ revealHeader(); }    // scroll up   -> reveal, then auto-hide after 3s
  }

  window.addEventListener("scroll", function(){ onScroll("win", window.pageYOffset || root.scrollTop || 0); }, { passive:true });
  playerView.addEventListener("scroll", function(){ onScroll("pane", playerView.scrollTop); }, { passive:true });

  // Reveal by moving the pointer onto the top strip / handle (desktop) or tapping it (mobile).
  hoverZone.addEventListener("mouseenter", revealHeader);
  hoverZone.addEventListener("click", revealHeader);
  hoverZone.addEventListener("touchstart", function(){ revealHeader(); }, { passive:true });
  // keep the header up while the pointer is over it; re-arm the 3s auto-hide when it leaves
  topbar.addEventListener("mouseenter", function(){ showHeader(); clearTimeout(hdrIdleTimer); });
  topbar.addEventListener("mouseleave", function(){ armIdleHide(); });

  // Measure the header so the player pane can clear the fixed bar.
  function measureHeader(){ root.style.setProperty("--hdr-h", (topbar ? topbar.offsetHeight : 56) + "px"); }
  measureHeader();
  window.addEventListener("resize", measureHeader);

  // Footer: the close button hides the footer for this session (returns on reload).
  id("btnHideFooter").addEventListener("click", function(){ if (footerEl) footerEl.hidden = true; });

  // ---------- Hamburger flyout nav ----------
  var btnMenu = id("btnMenu"), navBackdrop = id("navBackdrop");
  function setNav(open){ body.classList.toggle("nav-open", open); btnMenu.setAttribute("aria-expanded", open ? "true" : "false"); }
  btnMenu.addEventListener("click", function(){ setNav(!body.classList.contains("nav-open")); });
  navBackdrop.addEventListener("click", function(){ setNav(false); });
  doc.addEventListener("keydown", function(e){
    if (!id("routeCard").hidden){                     // §6.10 offer card is modal
      if (e.key === "Escape"){ hideRouteCard(); return; }
      if (e.key === "Tab"){                           // two-button focus wrap (aria-modal)
        e.preventDefault();
        var go = id("routeGo"), no = id("routeDismiss");
        (doc.activeElement === go || go.disabled ? no : go).focus();
      }
      return;                                         // nothing else acts beneath the dialog
    }
    if (e.key === "Escape"){ setNav(false); return; }
    // ---------- v2 playback shortcuts (parity with video-viewer) ----------
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (body.classList.contains("nav-open")) return;  // the flyout nav owns the keyboard
    if (!audioEl || !body.classList.contains("viewing")) return;
    var t = e.target, tag = (t && t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
    if (t === audioEl) return;                        // the native controls handle their own keys
    var k = e.key;
    if (k === " " || k === "Spacebar"){
      e.preventDefault();
      if (audioEl.paused){ var p = audioEl.play(); if (p && p["catch"]) p["catch"](function(){}); }
      else audioEl.pause();
    }
    else if (k === "ArrowRight"){ e.preventDefault(); seekBy(5); }
    else if (k === "ArrowLeft"){ e.preventDefault(); seekBy(-5); }
    else if (k === "ArrowUp"){ e.preventDefault(); audioEl.volume = Math.min(1, Math.round((audioEl.volume + 0.05) * 100) / 100); }
    else if (k === "ArrowDown"){ e.preventDefault(); audioEl.volume = Math.max(0, Math.round((audioEl.volume - 0.05) * 100) / 100); }
    else if (k === "m" || k === "M"){ audioEl.muted = !audioEl.muted; }
    else if (k === "l" || k === "L"){ toggleLoop(); }
  });

  // ---------- Background color (chosen by the user, remembered in a cookie) ----------
  function setCookie(name, val){
    doc.cookie = name + "=" + encodeURIComponent(val) + "; max-age=31536000; path=/; SameSite=Lax";
  }
  function getCookie(name){
    var m = doc.cookie.match("(?:^|; )" + name.replace(/([.*+?^${}()|[\]\\])/g, "\\$1") + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : null;
  }
  function hexToRgb(h){
    h = h.replace("#", "");
    if (h.length === 3) h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
    var n = parseInt(h, 16);
    return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
  }
  function srgb(c){ c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
  function luminance(rgb){ return 0.2126*srgb(rgb.r) + 0.7152*srgb(rgb.g) + 0.0722*srgb(rgb.b); }
  function mix(a, b, t){
    return "rgb(" + Math.round(a.r+(b.r-a.r)*t) + "," + Math.round(a.g+(b.g-a.g)*t) + "," + Math.round(a.b+(b.b-a.b)*t) + ")";
  }
  function rgbStr(c){ return "rgb(" + c.r + "," + c.g + "," + c.b + ")"; }

  // Syntax palettes kept for shell parity (no code plane here, but the tokens exist).
  var HL_LIGHT = { comment:"#6e7781", keyword:"#cf222e", tag:"#116329", attr:"#0550ae", string:"#0a3069", number:"#0550ae", title:"#8250df", built:"#953800" };
  var HL_DARK  = { comment:"#8b949e", keyword:"#ff7b72", tag:"#7ee787", attr:"#79c0ff", string:"#a5d6ff", number:"#79c0ff", title:"#d2a8ff", built:"#ffa657" };

  function applyColor(hex){
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) hex = "#ffffff";
    var bg = hexToRgb(hex);
    // Pick black or white text by whichever contrasts better (crossover ~0.179).
    var lightText = luminance(bg) <= 0.179;          // dark background -> light text
    var text = lightText ? { r:240, g:243, b:246 } : { r:31, g:35, b:40 };
    var accentHex = lightText ? "#8b93ff" : "#4f46e5";
    var ac = hexToRgb(accentHex);
    var hl = lightText ? HL_DARK : HL_LIGHT;
    var s = root.style;
    s.setProperty("--bg", hex);
    s.setProperty("--surface", hex);
    s.setProperty("--text", rgbStr(text));
    s.setProperty("--code-text", rgbStr(text));
    s.setProperty("--muted", mix(bg, text, 0.45));
    s.setProperty("--border", mix(bg, text, 0.24));
    s.setProperty("--border-soft", mix(bg, text, 0.13));
    s.setProperty("--code-bg", mix(bg, text, 0.07));
    s.setProperty("--hover", mix(bg, text, 0.10));
    s.setProperty("--accent", accentHex);
    s.setProperty("--accent-contrast", lightText ? "#0d1117" : "#ffffff");
    s.setProperty("--overlay", "rgba(" + ac.r + "," + ac.g + "," + ac.b + ",0.12)");
    s.setProperty("--shadow", lightText ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.12)");
    s.setProperty("--header-bg", "rgba(" + bg.r + "," + bg.g + "," + bg.b + ",0.9)");
    s.setProperty("--hl-comment", hl.comment);
    s.setProperty("--hl-keyword", hl.keyword);
    s.setProperty("--hl-tag", hl.tag);
    s.setProperty("--hl-attr", hl.attr);
    s.setProperty("--hl-string", hl.string);
    s.setProperty("--hl-number", hl.number);
    s.setProperty("--hl-title", hl.title);
    s.setProperty("--hl-built", hl.built);
    s.colorScheme = lightText ? "dark" : "light";
    themeColor.setAttribute("content", hex);
    drawWave();                                       // waveform peaks repaint in the new accent
  }

  function isHex6(v){ return /^#([0-9a-f]{6})$/i.test(v || ""); }
  function saveColor(val){
    setCookie("mykk-bg", val);                                  // primary
    try { localStorage.setItem("mykk-bg", val); } catch (e) {}  // fallback (e.g. file://)
  }
  function loadColor(){
    var v = getCookie("mykk-bg");
    if (!isHex6(v)) { try { v = localStorage.getItem("mykk-bg"); } catch (e) { v = null; } }
    return isHex6(v) ? v : ((window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "#0d1117" : "#ffffff");
  }

  var saved = loadColor();
  bgPicker.value = saved;
  applyColor(saved);
  bgPicker.addEventListener("input", function(){
    applyColor(bgPicker.value);
    saveColor(bgPicker.value);
    syncThemeToggle();
  });

  var themeToggle=document.getElementById("themeToggle"),themeIconSun=document.getElementById("themeIconSun"),themeIconMoon=document.getElementById("themeIconMoon");
  function isDarkBg(){ try { return luminance(hexToRgb(bgPicker.value)) <= 0.179; } catch(e){ return false; } }
  function syncThemeToggle(){ if(!themeToggle) return; var dark=isDarkBg(); themeToggle.setAttribute("aria-pressed", dark?"true":"false"); themeToggle.setAttribute("aria-label", dark?"Switch to light theme":"Switch to dark theme"); if(themeIconSun){ if(dark) themeIconSun.setAttribute("hidden",""); else themeIconSun.removeAttribute("hidden"); } if(themeIconMoon){ if(dark) themeIconMoon.removeAttribute("hidden"); else themeIconMoon.setAttribute("hidden",""); } }
  if(themeToggle){ themeToggle.addEventListener("click", function(){ var next=isDarkBg()?"#ffffff":"#0d1117"; bgPicker.value=next; applyColor(next); saveColor(next); syncThemeToggle(); }); }
  syncThemeToggle();

  // ---------- Drag & drop (anywhere; drop-to-replace) ----------
  var dragDepth = 0;
  function showOverlay(s){ overlay.classList.toggle("show", s); }
  window.addEventListener("dragenter", function(e){
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") === -1) return;
    e.preventDefault(); dragDepth++; showOverlay(true);
  });
  window.addEventListener("dragover", function(e){
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", function(e){
    e.preventDefault(); dragDepth--; if (dragDepth <= 0){ dragDepth = 0; showOverlay(false); }
  });
  window.addEventListener("drop", function(e){
    e.preventDefault(); dragDepth = 0; showOverlay(false);
    var dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files.length){ readFile(dt.files[0]); }
    // text drops are meaningless for a binary audio viewer — ignored
  });

  // ---------- Paste (a copied file routes/loads; text is ignored) ----------
  window.addEventListener("paste", function(e){
    var cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    if (cd.files && cd.files.length){ e.preventDefault(); readFile(cd.files[0]); }
  });

  // ---------- Family router (§6.10): wrong-viewer redirect offer + hand-off ----------
    /* FV-MAP-START — generated from family-map.json (canonical); deep-equality enforced by the harness */
    var FAMILY = {
      audio:    { domain:"audio-viewer.us"     , label:"Audio Viewer"     , kind:"an audio file" },
      cert:     { domain:"cert-viewer.us"      , label:"Cert Viewer"      , kind:"a certificate" },
      data:     { domain:"data-viewer.us"      , label:"Data Viewer"      , kind:"a data file" },
      docx:     { domain:"docx-viewer.us"      , label:"DOCX Viewer"      , kind:"a Word document" },
      eml:      { domain:"eml-viewer.us"       , label:"EML Viewer"       , kind:"an email file" },
      epub:     { domain:"epub-viewer.us"      , label:"EPUB Viewer"      , kind:"an e-book" },
      html:     { domain:"html-viewer.us"      , label:"HTML Viewer"      , kind:"a web or source-code file" },
      image:    { domain:"image-viewer.us"     , label:"Image Viewer"     , kind:"an image" },
      log:      { domain:"log-viewer.us"       , label:"Log Viewer"       , kind:"a log file" },
      markdown: { domain:"markdown-viewer.us"  , label:"Markdown Viewer"  , kind:"a Markdown or text file" },
      pdf:      { domain:"pdf-viewer.us"       , label:"PDF Viewer"       , kind:"a PDF" },
      pptx:     { domain:"pptx-viewer.us"      , label:"PPTX Viewer"      , kind:"a presentation" },
      pub:      { domain:"pub-viewer.us"       , label:"PUB Viewer"       , kind:"a Publisher file" },
      sheets:   { domain:"sheets-viewer.us"    , label:"Sheets Viewer"    , kind:"a spreadsheet" },
      video:    { domain:"video-viewer.us"     , label:"Video Viewer"     , kind:"a video" }
    };
    var FAMILY_HUB = "file-viewer.us";
    var FAMILY_NAMES = {"robots.txt":"html"};
    var FAMILY_MAP = {
      // sheets
      "123":"sheets", xlsx:"sheets", xlsm:"sheets", xlsb:"sheets", xls:"sheets", xlt:"sheets", xltx:"sheets", xltm:"sheets",
      xlam:"sheets", ods:"sheets", fods:"sheets", dif:"sheets", prn:"sheets", dbf:"sheets", numbers:"sheets", xlml:"sheets",
      wk1:"sheets", wk3:"sheets", wks:"sheets", et:"sheets", uos:"sheets",
      // cert
      pem:"cert", crt:"cert", cer:"cert", der:"cert", csr:"cert", cert:"cert", p7b:"cert", p12:"cert",
      pfx:"cert",
      // data
      json:"data", jsonc:"data", json5:"data", jsonld:"data", ndjson:"data", yaml:"data", yml:"data", toml:"data",
      csv:"data", tsv:"data", xml:"data", rss:"data", atom:"data", graphql:"data", gql:"data",
      // docx
      docx:"docx", docm:"docx", dotx:"docx", dotm:"docx", doc:"docx", dot:"docx", rtf:"docx", odt:"docx",
      // eml
      eml:"eml", mbox:"eml", emlx:"eml", msg:"eml",
      // epub
      epub:"epub",
      // html
      html:"html", htm:"html", xhtml:"html", xht:"html", shtml:"html", shtm:"html", stm:"html", hta:"html",
      mhtml:"html", mht:"html", css:"html", scss:"html", sass:"html", less:"html", styl:"html", pcss:"html",
      postcss:"html", js:"html", mjs:"html", cjs:"html", jsx:"html", ts:"html", mts:"html", cts:"html",
      tsx:"html", coffee:"html", htaccess:"html", htpasswd:"html", env:"html", ini:"html", conf:"html", webmanifest:"html",
      map:"html", php:"html", phtml:"html", asp:"html", aspx:"html", ascx:"html", cshtml:"html", vbhtml:"html",
      jsp:"html", jspx:"html", cfm:"html", erb:"html", rhtml:"html", ejs:"html", hbs:"html", handlebars:"html",
      mustache:"html", njk:"html", liquid:"html", jinja:"html", j2:"html", twig:"html", pug:"html", jade:"html",
      haml:"html", slim:"html", vue:"html", svelte:"html", astro:"html",
      // image
      png:"image", jpg:"image", jpeg:"image", jpe:"image", jfif:"image", gif:"image", webp:"image", avif:"image",
      svg:"image", svgz:"image", bmp:"image", dib:"image", ico:"image", cur:"image", tif:"image", tiff:"image",
      tga:"image", targa:"image", icb:"image", vda:"image", vst:"image", qoi:"image", pcx:"image", ppm:"image",
      pgm:"image", pbm:"image", pnm:"image", pam:"image", ff:"image", dds:"image", heic:"image", heif:"image",
      jxl:"image", psd:"image",
      // log
      log:"log", out:"log", err:"log", trace:"log", syslog:"log",
      // markdown
      md:"markdown", markdown:"markdown", mdx:"markdown", txt:"markdown", rst:"markdown", adoc:"markdown",
      // pdf
      pdf:"pdf",
      // pptx
      pptx:"pptx", pptm:"pptx", ppsx:"pptx", ppsm:"pptx", potx:"pptx", potm:"pptx", ppt:"pptx",
      // pub
      pub:"pub",
      // audio
      mp3:"audio", wav:"audio", flac:"audio", m4a:"audio", aac:"audio", ogg:"audio", oga:"audio", opus:"audio",
      weba:"audio", mka:"audio", aif:"audio", aiff:"audio", wma:"audio", mid:"audio", midi:"audio",
      // video
      webm:"video", mp4:"video", m4v:"video", ogv:"video", mov:"video", mkv:"video", avi:"video", wmv:"video"
    };
    /* FV-MAP-END */
    var FAMILY_ORIGINS = Object.keys(FAMILY).map(function (k) { return "https://" + FAMILY[k].domain; })
      .concat("https://" + FAMILY_HUB);
  var DOMAIN = "audio-viewer.us";

  var routeFile = null, routeKey = "", routePrevFocus = null, handoff = null;
  function cancelHandoff(){                    // tear down a pending hand-off (sender below)
    if (!handoff) return;
    window.removeEventListener("message", handoff.onMsg);
    clearTimeout(handoff.timer);
    handoff = null;
  }
  function showRouteCard(file, key){
    cancelHandoff();                           // a new offer aborts any pending hand-off
    if (id("routeCard").hidden) routePrevFocus = document.activeElement;  // don't capture our own button
    routeFile = file; routeKey = key;
    var t = FAMILY[key];
    // ⁨…⁩ (FSI…PDI) bidi-isolate the untrusted name so U+202E-style
    // overrides can't visually reorder the sentence.
    id("routeMsg").textContent = "“⁨" + file.name + "⁩” looks like " + t.kind + " — it belongs to " + t.label + ".";
    id("routeGo").textContent = "Open " + t.domain + " ↗";
    id("routeSub").textContent = "Your file stays on this device — nothing is uploaded.";
    id("routeGo").disabled = false;
    id("routeBackdrop").hidden = false; id("routeCard").hidden = false;
    id("routeGo").focus();
  }
  function hideRouteCard(){
    cancelHandoff();                           // dismissal aborts a pending hand-off
    id("routeBackdrop").hidden = true; id("routeCard").hidden = true;
    routeFile = null; routeKey = "";
    if (routePrevFocus && routePrevFocus.focus) routePrevFocus.focus();
  }
  function familyRoute(file){
    var n = String(file && file.name || "").toLowerCase();
    var key = FAMILY_NAMES[n];
    if (!key){
      var i = n.lastIndexOf(".");
      var ext = i >= 0 ? n.slice(i + 1) : "";
      key = FAMILY_MAP[ext];
    }
    if (!key || FAMILY[key].domain === DOMAIN) return false;  // unknown type, or our own → caller keeps its toast
    showRouteCard(file, key);
    return true;
  }

  // Sender — routeGo is a real user gesture, so no popup blocker. Keep the window
  // handle: it is the message channel (no `noopener` on this one window.open).
  id("routeGo").addEventListener("click", function(){
    if (!routeFile || id("routeGo").disabled) return;               // no double-fire
    cancelHandoff();
    var t = FAMILY[routeKey], origin = "https://" + t.domain, file = routeFile;
    var w = window.open(origin + "/#fvh=" + encodeURIComponent(file.name));
    if (!w){ id("routeSub").textContent = "Couldn’t open the tab — allow pop-ups for this site and try again."; return; }
    id("routeGo").disabled = true;
    var h = {};
    h.onMsg = function(e){
      if (e.source !== w || e.origin !== origin || !e.data) return;
      if (e.data.type === "fv-ready") w.postMessage({ type:"fv-file", file:file }, origin);
      else if (e.data.type === "fv-ack"){ hideRouteCard(); toast("Sent to " + t.label); }  // hideRouteCard tears the handshake down
    };
    h.timer = setTimeout(function(){
      if (handoff !== h) return;
      cancelHandoff();
      id("routeSub").textContent = "Tab opened — drop the file there.";   // Level-1 fallback
    }, 10000);
    handoff = h;
    window.addEventListener("message", h.onMsg);
  });
  id("routeDismiss").addEventListener("click", hideRouteCard);
  id("routeBackdrop").addEventListener("click", hideRouteCard);

  // Receiver — accept a File handed over from a sibling family tab (§6.10).
  window.addEventListener("message", function(e){
    if (FAMILY_ORIGINS.indexOf(e.origin) === -1) return;      // family origins only
    var d = e.data;
    if (d && d.type === "fv-file" && d.file instanceof File){ // clone re-creates a real File in this realm
      readFile(d.file);
      e.source.postMessage({ type:"fv-ack" }, e.origin);      // ack = received and handed to the loader
    }
  });
  var fvh = /[#&]fvh=([^&]*)/.exec(location.hash);
  if (fvh){
    var fvhName = fvh[1];                                   // ⚠️ stranger-controlled — textContent only
    try { fvhName = decodeURIComponent(fvhName); } catch (_) {}  // malformed %-escapes must not abort the receiver
    history.replaceState(null, "", location.pathname + location.search);  // always clear, opener or not
    if (window.opener){
      try { window.opener.postMessage({ type:"fv-ready" }, "*"); } catch(_){}
      window.opener = null;    // sever the reverse-navigation channel once the ping is out
      var emptySub = doc.querySelector(".empty-sub");         // hand-off pending: say so in the empty state
      if (emptySub){
        var emptySubCopy = emptySub.textContent;
        emptySub.textContent = "Receiving “⁨" + fvhName + "⁩”…";  // FSI…PDI isolate the untrusted name
        setTimeout(function(){ emptySub.textContent = emptySubCopy; }, 10000);  // revert if nothing arrives
      }
    }
  }

  // A bookmarked or shared link can carry the name of the file last viewed
  // (?name=, set by syncQueryName above). No content is ever recoverable from
  // a name alone — this only labels the empty state, and it never fetches or
  // renders anything on the strength of it. Skipped when an #fvh hand-off is
  // already customizing the same element.
  if (!fvh && !currentFile){
    var qName = new URLSearchParams(location.search).get("name");
    if (qName){
      var lastSub = doc.querySelector(".empty-sub");
      if (lastSub){
        // ⁨…⁩ (FSI…PDI) bidi-isolate the untrusted name — same treatment as
        // the #fvh receiver above; this value is exactly as stranger-
        // controlled as that one once it is read back out of the URL.
        // Display-only, and it must stay that way: this string is read
        // straight from the URL, so it is exactly as stranger-controlled as
        // file.name or the decoded #fvh value above. No fact is asserted
        // about whether anyone actually viewed it -- only that the link names
        // it.
        lastSub.textContent = "This link was shared for “⁨" + qName + "⁩”.";
      }
    }
  }
})();
