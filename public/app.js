const categoryOrder = [
  "Todos",
  "Abertos",
  "Esportes",
  "Filmes",
  "Telecine",
  "Series",
  "Infantil",
  "Documentarios",
  "Variedades",
  "Teste"
];

const video = document.querySelector("#video");
const welcome = document.querySelector("#welcome");
const statusText = document.querySelector("#status");
const nowTitle = document.querySelector("#nowTitle");
const playMode = document.querySelector("#playMode");
const channelList = document.querySelector("#channelList");
const categoryList = document.querySelector("#categoryList");
const searchInput = document.querySelector("#searchInput");
const screen = document.querySelector("#screen");
const totalChannels = document.querySelector("#totalChannels");
const totalCategories = document.querySelector("#totalCategories");
const currentCategory = document.querySelector("#currentCategory");
const currentMode = document.querySelector("#currentMode");

let channels = [];
let hls = null;
let activeChannelId = "";
let activeStreamUrl = "";
let activeMode = "auto";
let selectedCategory = "Todos";
let lastStallAt = 0;
let lastReloadAt = 0;
let stallTimer = null;
let bufferTimer = null;
let delayTimer = null;

window.open = function blockedPopup() {
  console.warn("Popup bloqueado pela TV.");
  return null;
};

document.addEventListener("click", (event) => {
  const externalLink = event.target.closest("a[target='_blank']");
  if (!externalLink) return;
  event.preventDefault();
  console.warn("Nova aba bloqueada:", externalLink.href);
}, true);

function setStatus(message) {
  statusText.textContent = message;
}

function modeLabel() {
  return playMode.options[playMode.selectedIndex].text.replace("Modo ", "");
}

function updateStats() {
  totalChannels.textContent = String(channels.length);
  totalCategories.textContent = String(new Set(channels.map((channel) => channel.category)).size);
  currentCategory.textContent = selectedCategory;
  currentMode.textContent = modeLabel();
}

function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function isHlsUrl(url, mode = "auto") {
  return mode === "hls" || /\.(m3u8|txt)(\?|$)/i.test(url);
}

function withCacheBuster(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_tv=${Date.now()}`;
}

function nearPlaylistEnd() {
  return Number.isFinite(video.duration) && video.duration > 0 && video.duration - video.currentTime < 8;
}

function reloadActiveStream(reason) {
  if (!activeChannelId) return;

  const now = Date.now();
  if (now - lastReloadAt < 6000) return;

  lastReloadAt = now;
  setStatus(reason || "Atualizando transmissao...");
  playChannelById(activeChannelId, true);
}

function startStallWatchdog() {
  clearInterval(stallTimer);
  stallTimer = setInterval(() => {
    if (!activeChannelId || video.paused || video.hidden) return;
    if (video.readyState < 3 && nearPlaylistEnd()) {
      reloadActiveStream("Buscando novos segmentos...");
    }
  }, 3000);
}

function getHlsConfig() {
  if (playMode.value === "delayed") {
    return {
      lowLatencyMode: false,
      startLevel: 0,
      liveSyncDuration: 45,
      liveMaxLatencyDuration: 90,
      capLevelToPlayerSize: true,
      testBandwidth: true,
      maxBufferLength: 90,
      maxMaxBufferLength: 120,
      maxBufferSize: 25 * 1000 * 1000,
      backBufferLength: 0,
      maxBufferHole: 1.5,
      startFragPrefetch: true,
      fragLoadingMaxRetry: 15,
      fragLoadingRetryDelay: 2500,
      manifestLoadingMaxRetry: 15,
      manifestLoadingRetryDelay: 2500,
      levelLoadingMaxRetry: 15,
      levelLoadingRetryDelay: 2500,
      abrEwmaDefaultEstimate: 180000,
      abrBandWidthFactor: 0.65,
      abrBandWidthUpFactor: 0.5
    };
  }

  if (playMode.value === "light") {
    return {
      lowLatencyMode: false,
      startLevel: 0,
      liveSyncDuration: 18,
      liveMaxLatencyDuration: 45,
      capLevelToPlayerSize: true,
      testBandwidth: true,
      maxBufferLength: 8,
      maxMaxBufferLength: 16,
      backBufferLength: 0,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 10,
      fragLoadingRetryDelay: 1800,
      manifestLoadingMaxRetry: 10,
      manifestLoadingRetryDelay: 1800,
      levelLoadingMaxRetry: 10,
      levelLoadingRetryDelay: 1800,
      abrEwmaDefaultEstimate: 220000,
      abrBandWidthFactor: 0.7,
      abrBandWidthUpFactor: 0.55
    };
  }

  return {
    lowLatencyMode: false,
    startLevel: 0,
    liveSyncDuration: 28,
    liveMaxLatencyDuration: 70,
    capLevelToPlayerSize: true,
    testBandwidth: true,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 0,
    maxBufferHole: 1,
    fragLoadingMaxRetry: 12,
    fragLoadingRetryDelay: 2000,
    manifestLoadingMaxRetry: 12,
    manifestLoadingRetryDelay: 2000,
    levelLoadingMaxRetry: 12,
    levelLoadingRetryDelay: 2000,
    abrEwmaDefaultEstimate: 350000,
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.65
  };
}

function getBufferedAhead() {
  for (let index = 0; index < video.buffered.length; index++) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (video.currentTime >= start && video.currentTime <= end) {
      return Math.max(0, end - video.currentTime);
    }
  }

  return 0;
}

function waitForSlowInternetBuffer() {
  clearInterval(bufferTimer);
  clearInterval(delayTimer);

  if (playMode.value !== "delayed") {
    video.play().catch(() => setStatus("Clique em reproduzir no player"));
    return;
  }

  video.pause();
  let remaining = 25;
  setStatus(`Aguardando ${remaining}s para internet lenta...`);

  delayTimer = setInterval(() => {
    remaining--;
    const ahead = getBufferedAhead();
    setStatus(`Aguardando ${remaining}s | buffer ${Math.floor(ahead)}s`);

    if (remaining > 0) return;

    clearInterval(delayTimer);
    if (Number.isFinite(video.duration) && video.duration > 60) {
      video.currentTime = Math.max(0, video.duration - 45);
    }
    setStatus("Ao vivo com atraso");
    video.play().catch(() => setStatus("Clique em reproduzir no player"));
  }, 1000);
}

function showVideo() {
  welcome.hidden = true;
  video.hidden = false;
}

function setActiveChannel(url) {
  document.querySelectorAll(".channel").forEach((button) => {
    button.classList.toggle("active", button.dataset.id === activeChannelId);
  });
}

async function requestStream(channelId) {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/play`, { method: "POST" });
  if (!response.ok) {
    throw new Error("Nao foi possivel abrir o canal.");
  }
  return response.json();
}

async function playChannelById(channelId, isReload = false) {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) {
    setStatus("Canal nao encontrado");
    return;
  }

  destroyHls();
  activeChannelId = channel.id;
  activeMode = channel.mode || "hls";
  setActiveChannel();
  nowTitle.textContent = channel.name;
  setStatus(isReload ? "Atualizando transmissao..." : "Carregando transmissao...");
  showVideo();

  try {
    const ticket = await requestStream(channel.id);
    activeStreamUrl = ticket.streamUrl;
  } catch (error) {
    console.error(error);
    setStatus("Erro ao abrir canal");
    return;
  }

  if (isHlsUrl(activeStreamUrl, activeMode) && window.Hls && Hls.isSupported()) {
    hls = new Hls(getHlsConfig());
    hls.loadSource(withCacheBuster(activeStreamUrl));
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hls.currentLevel = 0;
      hls.nextLevel = 0;
      waitForSlowInternetBuffer();
      startStallWatchdog();
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setStatus("Reconectando canal...");
        hls.startLoad();
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        setStatus("Recuperando video...");
        hls.recoverMediaError();
        return;
      }

      setStatus("Erro ao carregar o canal");
    });
  } else {
    video.src = activeStreamUrl;
    video.play().catch(() => setStatus("Clique em reproduzir no player"));
  }
}

function stopStream() {
  destroyHls();
  video.pause();
  video.removeAttribute("src");
  video.load();
  welcome.hidden = false;
  video.hidden = false;
  activeChannelId = "";
  activeStreamUrl = "";
  activeMode = "auto";
  nowTitle.textContent = "Tela inicial";
  clearInterval(stallTimer);
  clearInterval(bufferTimer);
  clearInterval(delayTimer);
  setActiveChannel("");
  setStatus("Reproducao parada");
}

function categoryCounts() {
  return channels.reduce((counts, channel) => {
    counts[channel.category] = (counts[channel.category] || 0) + 1;
    return counts;
  }, {});
}

function filteredChannels() {
  const query = searchInput.value.trim().toLowerCase();
  return channels.filter((channel) => {
    const categoryMatch = selectedCategory === "Todos" || channel.category === selectedCategory;
    const searchMatch = !query || channel.name.toLowerCase().includes(query) || channel.category.toLowerCase().includes(query);
    return categoryMatch && searchMatch;
  });
}

function renderCategories() {
  const counts = categoryCounts();
  const categories = categoryOrder.filter((category) => category === "Todos" || counts[category]);
  categoryList.innerHTML = "";

  categories.forEach((category) => {
    const button = document.createElement("button");
    const count = category === "Todos" ? channels.length : counts[category] || 0;
    button.type = "button";
    button.className = `category${category === selectedCategory ? " active" : ""}`;
    button.innerHTML = `<span>${category}</span><span class="category-count">${count}</span>`;
    button.addEventListener("click", () => {
      selectedCategory = category;
      renderCategories();
      renderChannels();
      updateStats();
    });
    categoryList.appendChild(button);
  });
}

function renderChannels() {
  const list = filteredChannels();
  channelList.innerHTML = "";

  list.forEach((channel, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "channel";
    button.dataset.id = channel.id;
    button.innerHTML = `
      <span class="logo">${String(index + 1).padStart(2, "0")}</span>
      <span>
        <span class="name">${channel.name}</span>
        <span class="meta">${channel.category}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      playChannelById(channel.id);
    });
    channelList.appendChild(button);
  });

  setActiveChannel();
}

async function loadChannels() {
  setStatus("Carregando canais...");
  const response = await fetch("/api/channels");
  channels = await response.json();
  renderCategories();
  renderChannels();
  updateStats();
  setStatus("Escolha uma categoria ou pesquise um canal");
}

document.querySelector("#stopButton").addEventListener("click", stopStream);

document.querySelector("#fullscreenButton").addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    screen.requestFullscreen();
  }
});

searchInput.addEventListener("input", renderChannels);

playMode.addEventListener("change", () => {
  updateStats();
  if (activeChannelId) playChannelById(activeChannelId);
});

video.addEventListener("playing", () => {
  setStatus(playMode.value === "delayed" ? "Ao vivo com atraso" : "Ao vivo");
});

video.addEventListener("waiting", () => {
  setStatus("Carregando buffer...");
  const now = Date.now();
  if (playMode.value === "delayed" && getBufferedAhead() < 4) {
    video.pause();
    waitForSlowInternetBuffer();
    return;
  }
  if (nearPlaylistEnd()) {
    reloadActiveStream("Atualizando transmissao...");
    return;
  }
  if (hls && now - lastStallAt > 5000) {
    lastStallAt = now;
    hls.currentLevel = 0;
    hls.nextLevel = 0;
    hls.startLoad();
  }
});

video.addEventListener("stalled", () => {
  if (nearPlaylistEnd()) reloadActiveStream("Buscando novos segmentos...");
});

video.addEventListener("ended", () => reloadActiveStream("Continuando transmissao..."));

video.addEventListener("pause", () => {
  if (activeChannelId) setStatus("Pausado");
});

loadChannels().catch((error) => {
  console.error(error);
  setStatus("Erro ao carregar canais");
});
