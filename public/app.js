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
const MAX_RENDERED_CHANNELS = 600;

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
const app = document.querySelector("#app");
const loginScreen = document.querySelector("#loginScreen");
const loginForm = document.querySelector("#loginForm");
const loginEmail = document.querySelector("#loginEmail");
const loginPassword = document.querySelector("#loginPassword");
const loginError = document.querySelector("#loginError");
const logoutButton = document.querySelector("#logoutButton");
const logoutForm = document.querySelector(".logout-form");
const adminToggle = document.querySelector("#adminToggle");
const adminPanel = document.querySelector("#adminPanel");
const userForm = document.querySelector("#userForm");
const newUserName = document.querySelector("#newUserName");
const newUserEmail = document.querySelector("#newUserEmail");
const newUserPassword = document.querySelector("#newUserPassword");
const newUserRole = document.querySelector("#newUserRole");
const usersList = document.querySelector("#usersList");

let channels = [];
let currentUser = null;
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
let tvSession = new URLSearchParams(window.location.search).get("tv_session") || "";

if (tvSession) {
  try {
    sessionStorage.setItem("jv_tv_session", tvSession);
  } catch (error) {
    console.warn("Sessao temporaria apenas na URL.");
  }
} else {
  try {
    tvSession = sessionStorage.getItem("jv_tv_session") || "";
  } catch (error) {
    tvSession = "";
  }
}

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

document.addEventListener("keydown", (event) => {
  const keys = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"];
  if (!keys.includes(event.key)) return;

  const focusable = [...document.querySelectorAll("button:not([hidden]), input:not([hidden]), select:not([hidden])")]
    .filter((element) => !element.disabled && element.offsetParent !== null);
  if (!focusable.length) return;

  const currentIndex = Math.max(0, focusable.indexOf(document.activeElement));
  const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
  const nextIndex = (currentIndex + direction + focusable.length) % focusable.length;

  focusable[nextIndex].focus();
  event.preventDefault();
});

function setStatus(message) {
  statusText.textContent = message;
}

async function apiFetch(url, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(tvSession ? { "X-TV-Session": tvSession } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers
  });

  if (response.status === 401) {
    showLogin();
    throw new Error("Login necessario.");
  }

  return response;
}

function showLogin(message = "") {
  currentUser = null;
  app.hidden = true;
  loginScreen.hidden = false;
  loginError.textContent = message;
}

function showApp(user) {
  currentUser = user;
  loginScreen.hidden = true;
  app.hidden = false;
  adminToggle.hidden = user.role !== "admin";
  if (user.role !== "admin") adminPanel.hidden = true;
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
  const response = await apiFetch(`/api/channels/${encodeURIComponent(channelId)}/play`, { method: "POST" });
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
  video.pause();
  video.removeAttribute("src");
  video.load();
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
    setStatus("Carregando filme...");
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
  const visibleList = list.slice(0, MAX_RENDERED_CHANNELS);
  channelList.innerHTML = "";

  visibleList.forEach((channel, index) => {
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

  if (list.length > visibleList.length) {
    const message = document.createElement("div");
    message.className = "list-limit";
    message.textContent = `Mostrando ${visibleList.length} de ${list.length}. Use a busca para encontrar pelo numero do filme.`;
    channelList.appendChild(message);
  }

  setActiveChannel();
}

async function loadChannels() {
  setStatus("Carregando canais...");
  const response = await apiFetch("/api/channels");
  channels = await response.json();
  renderCategories();
  renderChannels();
  updateStats();
  setStatus("Escolha uma categoria ou pesquise um canal");
}

async function loadUsers() {
  if (!currentUser || currentUser.role !== "admin") return;

  const response = await apiFetch("/api/users");
  const users = await response.json();
  usersList.innerHTML = "";

  users.forEach((user) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <span>
        <strong>${user.name}</strong>
        <span>${user.email}</span>
      </span>
      <span class="role-badge">${user.role}</span>
    `;
    usersList.appendChild(row);
  });
}

async function checkSession() {
  const response = await apiFetch("/api/auth/me");
  const data = await response.json();

  if (!data.user) {
    showLogin();
    return;
  }

  showApp(data.user);
  await loadChannels();
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

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: loginEmail.value,
      password: loginPassword.value
    })
  });

  const data = await response.json();
  if (!response.ok) {
    loginError.textContent = data.error || "Erro ao entrar.";
    return;
  }

  loginPassword.value = "";
  showApp(data.user);
  await loadChannels();
});

logoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  try {
    sessionStorage.removeItem("jv_tv_session");
  } catch (error) {}
  tvSession = "";
  stopStream();
  showLogin();
});

adminToggle.addEventListener("click", async () => {
  adminPanel.hidden = !adminPanel.hidden;
  if (!adminPanel.hidden) await loadUsers();
});

userForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await apiFetch("/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: newUserName.value,
      email: newUserEmail.value,
      password: newUserPassword.value,
      role: newUserRole.value
    })
  });

  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error || "Erro ao criar usuario");
    return;
  }

  userForm.reset();
  setStatus("Usuario criado");
  await loadUsers();
});

video.addEventListener("playing", () => {
  setStatus(playMode.value === "delayed" ? "Ao vivo com atraso" : "Ao vivo");
});

video.addEventListener("error", () => {
  const messages = {
    1: "Reproducao cancelada",
    2: "Erro de rede ao carregar o filme",
    3: "Erro ao decodificar o video",
    4: "Formato de video nao suportado"
  };
  const code = video.error ? video.error.code : 0;
  setStatus(messages[code] || "Erro ao carregar o video");
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

checkSession().catch((error) => {
  console.error(error);
  showLogin("Erro ao carregar sessao.");
});
