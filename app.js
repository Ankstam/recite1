// 【自动填入配置】将你的 github_pat_ 密钥分成两半填在此处，打开网页即自动组合填入
const DEFAULT_TOKEN_PART_1 = "";
const DEFAULT_TOKEN_PART_2 = "";

const STORAGE_LOCAL_BOOKS = "wf_local_books_v4";
const STORAGE_PREFS = "wf_prefs_v8";
const STORAGE_FAVORITES = "wf_favorites_v1";
const STORAGE_CUSTOM_FOLDERS = "wf_custom_folders_v1";

const audioPlayer = new Audio();
const ttsBlobCache = new Map();
const activeUtterances = new Set();

const EN_VOICES = [
  { id: "edge:en-US-JennyNeural", label: "英语 · 微软 Jenny (美式女声·亲切)" },
  { id: "edge:en-US-AriaNeural", label: "英语 · 微软 Aria (美式女声·播报)" },
  { id: "edge:en-US-GuyNeural", label: "英语 · 微软 Guy (美式男声·沉稳)" },
  { id: "edge:en-US-ChristopherNeural", label: "英语 · 微软 Christopher (美式男声·睡前)" },
  { id: "edge:en-US-AnaNeural", label: "英语 · 微软 Ana (美式少女音)" },
  { id: "edge:en-GB-SoniaNeural", label: "英语 · 微软 Sonia (英式女声·伦敦音)" },
  { id: "edge:en-GB-RyanNeural", label: "英语 · 微软 Ryan (英式男声·磁性)" },
  { id: "gtts:en-US", label: "英语 · Google 网页在线 (美式 US)" },
  { id: "gtts:en-GB", label: "英语 · Google 网页在线 (英式 UK)" },
  { id: "gtts:en-AU", label: "英语 · Google 网页在线 (澳式 AU)" }
];

const JA_VOICES = [
  { id: "edge:ja-JP-NanamiNeural", label: "日语 · 微软 七海 Nanami (女声·自然)" },
  { id: "edge:ja-JP-KeitaNeural", label: "日语 · 微软 圭太 Keita (男声·清爽)" },
  { id: "edge:ja-JP-AoiNeural", label: "日语 · 微软 葵 Aoi (女声·轻柔)" },
  { id: "edge:ja-JP-DaichiNeural", label: "日语 · 微软 大地 Daichi (男声·沉稳)" },
  { id: "edge:ja-JP-MayuNeural", label: "日语 · 微软 真由 Mayu (女声·清晰)" },
  { id: "gtts:ja", label: "日语 · Google 网页在线 (标准 JP)" }
];

const ZH_VOICES = [
  { id: "edge:zh-CN-XiaoxiaoNeural", label: "中文 · 微软 晓晓 (普通话女声·温暖)" },
  { id: "edge:zh-CN-XiaoyiNeural", label: "中文 · 微软 晓伊 (普通话女声·睡前)" },
  { id: "edge:zh-CN-YunxiNeural", label: "中文 · 微软 云希 (普通话男声·青年)" },
  { id: "edge:zh-CN-YunjianNeural", label: "中文 · 微软 云健 (普通话男声·磁性)" },
  { id: "edge:zh-HK-HiuMaanNeural", label: "中文 · 微软 晓曼 (香港粤语女声)" },
  { id: "gtts:zh-CN", label: "中文 · Google 网页在线 (普通话 CN)" },
  { id: "gtts:zh-TW", label: "中文 · Google 网页在线 (台湾国语 TW)" },
  { id: "gtts:zh-HK", label: "中文 · Google 网页在线 (香港粤语 HK)" }
];

const state = {
  books: [],
  currentBookId: "",
  allItems: [],
  filteredItems: [],
  index: 0,
  isPlaying: false,
  playToken: 0,
  isCssLandscape: false,
  wakeLock: null,
  sleepTimeout: null,
  hudTimeout: null,
  toastTimeout: null,
  sysVoices: [],
  editingItems: [],
  favorites: []
};

const el = id => document.getElementById(id);

function showToast(msg) {
  const banner = el("toastBanner");
  if (!banner) return;
  banner.textContent = msg;
  banner.classList.add("show");
  clearTimeout(state.toastTimeout);
  state.toastTimeout = setTimeout(() => banner.classList.remove("show"), 1800);
}

function setTtsStatus(msg) {
  const box = el("ttsStatusText");
  if (box) box.textContent = msg;
}

function getBuiltInToken() {
  return `${DEFAULT_TOKEN_PART_1}${DEFAULT_TOKEN_PART_2}`.trim();
}

function applyAutoTokenIfNeeded() {
  const builtIn = getBuiltInToken();
  const input = el("ghTokenInput");
  if (builtIn && !input.value.trim()) {
    input.value = builtIn;
  }
  updateTokenStatus();
}

function getActiveToken() {
  return el("ghTokenInput").value.trim() || getBuiltInToken();
}

function updateTokenStatus() {
  const box = el("tokenSplitStatus");
  if (!box) return;
  const builtIn = getBuiltInToken();
  const active = getActiveToken();
  if (builtIn && el("ghTokenInput").value.trim() === builtIn) {
    box.textContent = `密钥状态：已从代码两半自动组合填入（共 ${builtIn.length} 位）`;
  } else if (active) {
    box.textContent = `密钥状态：已就绪（共 ${active.length} 位）`;
  } else {
    box.textContent = "密钥状态：未配置（请在 app.js 顶部填入两半密钥或直接输入）";
  }
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function getRepoConfig() {
  return {
    owner: el("ghOwnerInput").value.trim() || "Ankstam",
    repo: el("ghRepoInput").value.trim() || "recite1",
    branch: "main",
    token: getActiveToken()
  };
}

function getGhHeaders(requireToken = false) {
  const { token } = getRepoConfig();
  if (requireToken && !token) {
    throw new Error("未检测到 GitHub 密钥，请在 app.js 顶部填写两半密钥或在设置中输入");
  }
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

// 1. 初始化
async function init() {
  loadFavorites();
  await initVoices();
  restorePrefs();
  applyAutoTokenIfNeeded();
  bindEvents();
  await reloadAllBooks();
}

// 2. 收藏册管理
function getFavKey(item) {
  return `${(item.word || "").trim().toLowerCase()}::${(item.meaning || "").trim()}`;
}

function loadFavorites() {
  try {
    state.favorites = JSON.parse(localStorage.getItem(STORAGE_FAVORITES) || "[]");
  } catch {
    state.favorites = [];
  }
  updateFavBadgeUI();
}

function saveFavorites() {
  localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(state.favorites));
  updateFavBadgeUI();
}

function isItemFavorited(item) {
  if (!item || !item.word) return false;
  const key = getFavKey(item);
  return state.favorites.some(f => getFavKey(f) === key);
}

function updateFavBadgeUI() {
  const dot = el("favCountDot");
  if (dot) {
    const len = state.favorites.length;
    dot.textContent = String(len);
    dot.hidden = len === 0;
  }

  const currentItem = state.filteredItems[state.index];
  const favorited = isItemFavorited(currentItem);
  const tag = el("cardFavTag");
  if (tag) tag.hidden = !favorited;

  const fsFavBtn = el("fsFavBtn");
  if (fsFavBtn) fsFavBtn.textContent = favorited ? "★ 已收藏" : "☆ 收藏";
}

function toggleFavoriteCurrentWord() {
  if (!state.filteredItems.length) return;
  const item = state.filteredItems[state.index];
  if (!item || !item.word) return;

  const key = getFavKey(item);
  const idx = state.favorites.findIndex(f => getFavKey(f) === key);

  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    saveFavorites();
    showToast(`☆ 已取消收藏：${item.word}`);
  } else {
    state.favorites.unshift({
      category: item.category || "收藏词",
      word: item.word,
      phonetic: item.phonetic || "",
      meaning: item.meaning || "",
      phrases: JSON.parse(JSON.stringify(item.phrases || [])),
      addedAt: Date.now()
    });
    saveFavorites();
    showToast(`★ 已加入收藏：${item.word}`);
  }
}

function openFavoritesModal() {
  renderFavsManageList();
  if (!el("favTargetBookInput").value) {
    el("favTargetBookInput").value = `收藏精选_${new Date().toISOString().slice(0, 10)}`;
  }
  el("favsDialog").showModal();
}

function renderFavsManageList() {
  const container = el("favsManageList");
  const titleEl = el("favsModalTitle");
  if (titleEl) titleEl.textContent = `我的收藏册 (${state.favorites.length})`;

  container.innerHTML = "";
  el("selectAllFavsChk").checked = state.favorites.length > 0;

  if (state.favorites.length === 0) {
    container.innerHTML = `<div style="padding:14px;font-size:12px;color:var(--subtext);text-align:center;">暂无收藏单词（背诵或纯净全屏时双击屏幕任意处即可收藏）</div>`;
    return;
  }

  state.favorites.forEach((item, idx) => {
    const label = document.createElement("label");
    label.className = "book-check-item";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.value = String(idx);
    chk.checked = true;
    chk.className = "fav-select-chk";

    const meta = document.createElement("div");
    meta.className = "fav-item-meta";

    const wSpan = document.createElement("span");
    wSpan.className = "fav-item-word";
    wSpan.textContent = `${item.word} ${item.phonetic || ""}`.trim();

    const sSpan = document.createElement("span");
    sSpan.className = "fav-item-sub";
    sSpan.textContent = item.meaning || "（无释义）";

    meta.append(wSpan, sSpan);

    const catTag = document.createElement("span");
    catTag.className = "tag-cloud";
    catTag.textContent = item.category || "收藏";

    label.append(chk, meta, catTag);
    container.appendChild(label);
  });
}

function getSelectedFavoriteItems() {
  const indices = [...document.querySelectorAll(".fav-select-chk:checked")].map(c => parseInt(c.value, 10));
  return indices.map(i => state.favorites[i]).filter(Boolean);
}

// 3. 初始化三语独立下拉列表
async function initVoices() {
  const enSel = el("enVoiceSelect");
  const jaSel = el("jaVoiceSelect");
  const zhSel = el("zhVoiceSelect");

  const renderSelect = (selectEl, presets, extraCloud, systemList, langPrefix, defaultVal) => {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFS) || "{}");
    const savedMap = {
      enVoiceSelect: saved.enVoiceURI,
      jaVoiceSelect: saved.jaVoiceURI,
      zhVoiceSelect: saved.zhVoiceURI
    };
    const currentVal = selectEl.value || savedMap[selectEl.id] || defaultVal;

    selectEl.innerHTML = "";
    const cloudGroup = document.createElement("optgroup");
    cloudGroup.label = "云端高清音源 (微软 / Google 网页在线)";

    const presetIds = new Set();
    presets.forEach(v => {
      presetIds.add(v.id);
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label;
      cloudGroup.appendChild(opt);
    });

    extraCloud.forEach(v => {
      const id = `edge:${v.ShortName}`;
      if (presetIds.has(id)) return;
      if ((v.Locale || "").toLowerCase().startsWith(langPrefix)) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = `微软 ${v.ShortName}`;
        cloudGroup.appendChild(opt);
      }
    });
    selectEl.appendChild(cloudGroup);

    const matchedSys = systemList.filter(v => (v.lang || "").toLowerCase().startsWith(langPrefix));
    if (matchedSys.length > 0) {
      const sysGroup = document.createElement("optgroup");
      sysGroup.label = "浏览器内置 / 系统本地引擎 (离线备用)";
      matchedSys.forEach(v => {
        const opt = document.createElement("option");
        opt.value = `sys:${v.voiceURI}`;
        opt.textContent = `本地 · ${v.name} (${v.lang})`;
        sysGroup.appendChild(opt);
      });
      selectEl.appendChild(sysGroup);
    }

    selectEl.value = currentVal;
    if (!selectEl.value) selectEl.value = defaultVal;
  };

  const refreshAll = (cloudList, sysList) => {
    renderSelect(enSel, EN_VOICES, cloudList, sysList, "en", "edge:en-US-JennyNeural");
    renderSelect(jaSel, JA_VOICES, cloudList, sysList, "ja", "edge:ja-JP-NanamiNeural");
    renderSelect(zhSel, ZH_VOICES, cloudList, sysList, "zh", "edge:zh-CN-XiaoxiaoNeural");
  };

  refreshAll([], []);

  let cloudList = [];
  try {
    const res = await fetch("/api/voices");
    if (res.ok) cloudList = await res.json();
  } catch (_) {}

  if ("speechSynthesis" in window) {
    state.sysVoices = window.speechSynthesis.getVoices() || [];
    window.speechSynthesis.onvoiceschanged = () => {
      state.sysVoices = window.speechSynthesis.getVoices() || [];
      refreshAll(cloudList, state.sysVoices);
    };
  }
  refreshAll(cloudList, state.sysVoices);
}

// 4. GitHub 直连词库管理
function getCustomFolders() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_CUSTOM_FOLDERS) || "[]");
  } catch {
    return [];
  }
}

function registerCustomFolder(folderPath) {
  const clean = folderPath.replace(/^\/+|\/+$/g, "");
  if (!clean || clean === "books") return;
  const list = getCustomFolders();
  if (!list.includes(clean)) {
    list.push(clean);
    localStorage.setItem(STORAGE_CUSTOM_FOLDERS, JSON.stringify(list));
  }
}

async function fetchRepoFolderJsonFiles(owner, repo, branch, folderPath, headers) {
  const cleanFolder = folderPath.replace(/^\/+|\/+$/g, "");
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanFolder}?ref=${branch}`;
  const res = await fetch(api, { cache: "no-store", headers });
  if (!res.ok) return { files: [], subDirs: [] };
  const list = await res.json();
  if (!Array.isArray(list)) return { files: [], subDirs: [] };

  const files = list
    .filter(f => f.type === "file" && f.name.endsWith(".json"))
    .map(f => {
      const prefix = cleanFolder === "books" ? "" : `${cleanFolder.replace(/^books\//, "")}/`;
      const baseTitle = f.name.replace(/\.json$/i, "");
      return {
        id: `repo:${f.path}`,
        rawName: baseTitle,
        name: `[云端] ${prefix}${baseTitle}`,
        source: "repo",
        file: f.path,
        items: null
      };
    });

  const subDirs = list.filter(f => f.type === "dir").map(d => d.path);
  return { files, subDirs };
}

async function reloadAllBooks(preferBookId = "") {
  const localBooks = getLocalBooks();
  let repoBooks = [];
  const { owner, repo, branch } = getRepoConfig();
  const headers = getGhHeaders(false);

  try {
    const foldersToScan = new Set(["books", ...getCustomFolders()]);
    const scanned = new Set();

    for (const folder of foldersToScan) {
      if (scanned.has(folder)) continue;
      scanned.add(folder);
      const { files, subDirs } = await fetchRepoFolderJsonFiles(owner, repo, branch, folder, headers);
      repoBooks.push(...files);
      subDirs.forEach(d => foldersToScan.add(d));
    }
  } catch (_) {}

  state.books = [...repoBooks, ...localBooks];
  renderBookOptions();
  renderBookManageList();

  if (state.books.length === 0) {
    state.currentBookId = "";
    state.allItems = [];
    state.filteredItems = [];
    renderCard(false);
    return;
  }

  const targetId = preferBookId && state.books.some(b => b.id === preferBookId)
    ? preferBookId
    : state.books[0].id;
  await selectBook(targetId);
}

function getLocalBooks() {
  try { return JSON.parse(localStorage.getItem(STORAGE_LOCAL_BOOKS) || "[]"); } catch { return []; }
}

function saveLocalBooks(books) {
  localStorage.setItem(STORAGE_LOCAL_BOOKS, JSON.stringify(books));
}

function sanitizeFileName(name) {
  const clean = name.trim().replace(/[\\/:*?"<>|]/g, "_") || `book_${Date.now()}`;
  return clean.endsWith(".json") ? clean : `${clean}.json`;
}

async function saveBookToGitHub(bookName, items, existingFullPath = "", customFolder = "books") {
  const { owner, repo, branch } = getRepoConfig();
  const headers = getGhHeaders(true);

  let targetPath = existingFullPath;
  if (!targetPath) {
    const cleanFolder = (customFolder || "books").trim().replace(/^\/+|\/+$/g, "") || "books";
    registerCustomFolder(cleanFolder);
    const fileName = sanitizeFileName(bookName);
    targetPath = `${cleanFolder}/${fileName}`;
  }

  const encodedPath = targetPath.split("/").map(encodeURIComponent).join("/");
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  let existingSha = null;
  const checkRes = await fetch(`${apiUrl}?ref=${branch}`, { cache: "no-store", headers });
  if (checkRes.ok) {
    const meta = await checkRes.json();
    existingSha = meta.sha;
  }

  const payload = {
    bookName: bookName.replace(/\.json$/i, ""),
    updatedAt: new Date().toISOString(),
    items: items.map(item => ({
      category: item.category || "默认分类",
      word: item.word,
      phonetic: item.phonetic || "",
      meaning: item.meaning || "",
      phrases: (item.phrases || []).map(p => (p.zh ? `${p.foreign} | ${p.zh}` : p.foreign))
    }))
  };

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `${existingSha ? "Update" : "Create"} vocab book: ${targetPath}`,
      content: utf8ToBase64(JSON.stringify(payload, null, 2)),
      branch,
      ...(existingSha ? { sha: existingSha } : {})
    })
  });

  const data = await putRes.json();
  if (!putRes.ok) throw new Error(`GitHub 保存失败：${data.message || putRes.status}`);
  return `repo:${targetPath}`;
}

async function deleteBookFromGitHub(fullPath) {
  const { owner, repo, branch } = getRepoConfig();
  const headers = getGhHeaders(true);
  const normalizedPath = fullPath.includes("/") ? fullPath : `books/${fullPath}`;
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  const checkRes = await fetch(`${apiUrl}?ref=${branch}`, { cache: "no-store", headers });
  if (!checkRes.ok) return;
  const meta = await checkRes.json();

  const delRes = await fetch(apiUrl, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Delete vocab book: ${normalizedPath}`, sha: meta.sha, branch })
  });

  if (!delRes.ok) {
    const err = await delRes.json();
    throw new Error(`删除 ${normalizedPath} 失败：${err.message || delRes.status}`);
  }
}

function renderBookOptions() {
  const select = el("bookSelect");
  select.innerHTML = "";
  if (state.books.length === 0) {
    select.innerHTML = `<option value="">暂无词库（点击左上角导入）</option>`;
    return;
  }
  state.books.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    select.appendChild(opt);
  });
  if (state.currentBookId) select.value = state.currentBookId;
}

function renderBookManageList() {
  const container = el("bookManageList");
  container.innerHTML = "";
  el("selectAllBooksChk").checked = false;
  updateBatchDeleteBtnCount();

  if (state.books.length === 0) {
    container.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--subtext);text-align:center;">暂无词库</div>`;
    return;
  }

  state.books.forEach(b => {
    const label = document.createElement("label");
    label.className = "book-check-item";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.value = b.id;
    chk.className = "book-del-chk";
    chk.addEventListener("change", updateBatchDeleteBtnCount);

    const title = document.createElement("span");
    title.textContent = b.name.replace(/^\[(云端|本地)\]\s*/, "");

    const badge = document.createElement("span");
    badge.className = b.source === "repo" ? "tag-cloud" : "tag-local";
    badge.textContent = b.source === "repo" ? "GitHub" : "本地";

    label.append(chk, title, badge);
    container.appendChild(label);
  });
}

function updateBatchDeleteBtnCount() {
  const count = document.querySelectorAll(".book-del-chk:checked").length;
  el("batchDeleteBooksBtn").textContent = `删除所选 (${count})`;
}

async function selectBook(bookId) {
  stopAutoPlay();
  state.currentBookId = bookId;
  el("bookSelect").value = bookId;

  const book = state.books.find(b => b.id === bookId);
  if (!book) return;

  if (book.source === "repo" && !book.items) {
    el("cardWord").textContent = "加载中...";
    const { owner, repo, branch } = getRepoConfig();
    const encodedPath = book.file.split("/").map(encodeURIComponent).join("/");
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${branch}`;
    const res = await fetch(apiUrl, { cache: "no-store", headers: getGhHeaders(false) });
    const meta = await res.json();
    const data = JSON.parse(base64ToUtf8(meta.content || ""));
    book.items = normalizeItems(Array.isArray(data) ? data : data.items || []);
  }

  state.allItems = book.items || [];
  buildCategoryFilter();
  applyCategoryFilter("ALL");
}

function splitBilingualLine(raw) {
  const text = String(raw || "").trim();
  if (!text) return { foreign: "", zh: "" };
  if (text.includes("|")) {
    const [f, ...rest] = text.split("|");
    return { foreign: f.trim(), zh: rest.join("|").trim() };
  }
  const match = text.match(/^(.+?)\s+([\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef，。！？；：、（）\s]+)$/);
  if (match) return { foreign: match[1].trim(), zh: match[2].trim() };
  if (/^[\u4e00-\u9fa5\s，。！？；：、（）]+$/.test(text)) return { foreign: "", zh: text };
  return { foreign: text, zh: "" };
}

function normalizeItems(rawList) {
  return rawList.map(item => {
    const rawPhrases = Array.isArray(item.phrases)
      ? item.phrases
      : typeof item.phrases === "string" && item.phrases
      ? item.phrases.split(/[;；]/).map(s => s.trim()).filter(Boolean)
      : [];

    const parsedPhrases = rawPhrases.map(p => {
      if (typeof p === "object" && p !== null) {
        return { foreign: (p.text || p.en || "").trim(), zh: (p.zh || p.meaning || "").trim() };
      }
      return splitBilingualLine(p);
    });

    return {
      category: (item.category || "默认分类").trim(),
      word: (item.word || "").trim(),
      phonetic: (item.phonetic || "").trim(),
      meaning: (item.meaning || "").trim(),
      phrases: parsedPhrases.filter(p => p.foreign || p.zh)
    };
  }).filter(i => i.word);
}

function parseImportedContent(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return normalizeItems(Array.isArray(parsed) ? parsed : parsed.items || []);
  }

  return trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const delimiter = line.includes("\t") ? "\t" : "|";
      const parts = line.split(delimiter).map(s => s.trim());

      const word = parts[0] || "";
      const meaning = parts[1] || "";
      const phonetic = parts[2] || "";
      const sentenceCol = parts[3] || "";
      const sentenceZhCol = parts[4] || "";
      const category = parts[5] || "默认分类";

      const phrases = [];
      if (sentenceCol || sentenceZhCol) {
        const fList = sentenceCol ? sentenceCol.split(/[;；]/).map(s => s.trim()) : [];
        const zList = sentenceZhCol ? sentenceZhCol.split(/[;；]/).map(s => s.trim()) : [];
        const maxLen = Math.max(fList.length, zList.length);
        for (let i = 0; i < maxLen; i++) {
          if (fList[i] || zList[i]) {
            phrases.push({ foreign: fList[i] || "", zh: zList[i] || "" });
          }
        }
      }

      return { category, word, phonetic, meaning, phrases };
    })
    .filter(i => i.word);
}

// 5. 分类过滤与卡片渲染
function buildCategoryFilter() {
  const cats = [...new Set(state.allItems.map(i => i.category))];
  const sel = el("categorySelect");
  sel.innerHTML = `<option value="ALL">全部分类 (${state.allItems.length})</option>`;
  cats.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });
}

function applyCategoryFilter(cat) {
  state.filteredItems = cat === "ALL"
    ? [...state.allItems]
    : state.allItems.filter(i => i.category === cat);
  state.index = 0;
  renderCard(false);
}

function renderCard(hideMeaning = false) {
  const total = state.filteredItems.length;
  const card = el("vocabCard");
  card.classList.toggle("hide-meaning", hideMeaning);

  if (total === 0) {
    el("cardCategory").textContent = "空词库";
    el("cardWord").textContent = "无匹配单词";
    el("cardPhonetic").textContent = "";
    el("cardMeaning").textContent = "请切换分类或点击左上角导入词库";
    el("cardPhrases").innerHTML = "";
    el("progressText").textContent = "0 / 0";
    updateFavBadgeUI();
    return;
  }

  const item = state.filteredItems[state.index];
  el("cardCategory").textContent = item.category;
  el("cardWord").textContent = item.word;
  el("cardPhonetic").textContent = item.phonetic;
  el("cardMeaning").textContent = item.meaning;

  const ul = el("cardPhrases");
  ul.innerHTML = "";
  item.phrases.forEach(p => {
    const li = document.createElement("li");
    if (p.foreign) {
      const fSpan = document.createElement("span");
      fSpan.className = "phrase-foreign";
      fSpan.textContent = p.foreign;
      li.appendChild(fSpan);
    }
    if (p.zh) {
      const zSpan = document.createElement("span");
      zSpan.className = "phrase-zh";
      zSpan.textContent = p.zh;
      li.appendChild(zSpan);
    }
    ul.appendChild(li);
  });

  el("progressText").textContent = `${state.index + 1} / ${total}`;
  updateFavBadgeUI();
}

function revealMeaningNow() {
  el("vocabCard").classList.remove("hide-meaning");
}

// 6. 词库编辑器
function openBookEditor() {
  const book = state.books.find(b => b.id === state.currentBookId);
  if (!book) return alert("请先选择一本词库");

  el("editBookNameInput").value = book.rawName || book.name.replace(/^\[(云端|本地)\]\s*/, "");
  el("batchCategoryInput").value = "";
  state.editingItems = JSON.parse(JSON.stringify(state.allItems));
  renderEditorItems();
  el("booksDialog").close();
  el("editorDialog").showModal();
}

function renderEditorItems() {
  const list = el("editorItemsList");
  list.innerHTML = "";

  state.editingItems.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "editor-item-card";

    const top = document.createElement("div");
    top.className = "editor-item-top";

    const wordIn = document.createElement("input");
    wordIn.type = "text";
    wordIn.placeholder = "单词";
    wordIn.value = item.word;
    wordIn.addEventListener("input", e => { state.editingItems[idx].word = e.target.value; });

    const phonIn = document.createElement("input");
    phonIn.type = "text";
    phonIn.placeholder = "音标（空则无）";
    phonIn.value = item.phonetic;
    phonIn.addEventListener("input", e => { state.editingItems[idx].phonetic = e.target.value; });

    const catIn = document.createElement("input");
    catIn.type = "text";
    catIn.placeholder = "分类";
    catIn.value = item.category;
    catIn.addEventListener("input", e => { state.editingItems[idx].category = e.target.value; });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "del-item-btn";
    delBtn.textContent = "删";
    delBtn.addEventListener("click", () => {
      state.editingItems.splice(idx, 1);
      renderEditorItems();
    });

    top.append(wordIn, phonIn, catIn, delBtn);

    const meanIn = document.createElement("input");
    meanIn.type = "text";
    meanIn.placeholder = "单词意思";
    meanIn.value = item.meaning;
    meanIn.addEventListener("input", e => { state.editingItems[idx].meaning = e.target.value; });

    const phraseIn = document.createElement("textarea");
    phraseIn.rows = 2;
    phraseIn.placeholder = "句子或词组（每行一条：句子 | 句子意思）";
    phraseIn.value = item.phrases.map(p => (p.zh ? `${p.foreign} | ${p.zh}` : p.foreign)).join("\n");
    phraseIn.addEventListener("input", e => {
      state.editingItems[idx].phrases = e.target.value
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(splitBilingualLine);
    });

    card.append(top, meanIn, phraseIn);
    list.appendChild(card);
  });
}

// 7. 三语独立云端发音引擎
function stopSpeechEngine() {
  try {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
  } catch (_) {}
  activeUtterances.clear();
  if ("speechSynthesis" in window) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
  }
}

function playAudioBlobUrl(blobUrl, playbackRate = 1.0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(), 16000);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audioPlayer.onended = null;
      audioPlayer.onerror = null;
      resolve();
    }

    audioPlayer.onended = finish;
    audioPlayer.onerror = () => {
      clearTimeout(timer);
      reject(new Error("音频解码播放失败"));
    };

    audioPlayer.src = blobUrl;
    audioPlayer.preservesPitch = true;
    audioPlayer.playbackRate = playbackRate;
    audioPlayer.play().catch(err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function speakViaSystemTts(text, langType, rate) {
  return new Promise(resolve => {
    if (!("speechSynthesis" in window)) return resolve();
    let settled = false;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    utter.lang = langType === "zh" ? "zh-CN" : (langType === "ja" ? "ja-JP" : "en-US");

    const selMap = { zh: el("zhVoiceSelect").value, ja: el("jaVoiceSelect").value, en: el("enVoiceSelect").value };
    const selectedVal = selMap[langType] || "";
    if (selectedVal.startsWith("sys:")) {
      const uri = selectedVal.slice(4);
      const v = state.sysVoices.find(item => item.voiceURI === uri);
      if (v) utter.voice = v;
    }

    const watchdog = setTimeout(() => finish(), Math.max(3000, text.length * 450 + 2000));
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      activeUtterances.delete(utter);
      resolve();
    }
    utter.onend = finish;
    utter.onerror = finish;
    activeUtterances.add(utter);
    try { window.speechSynthesis.speak(utter); } catch (_) { finish(); }
  });
}

async function speakText(text, langType = "en") {
  const cleanText = String(text || "").trim();
  if (!cleanText) return;

  const rate = parseFloat(el("speechRate").value) || 0.9;
  const voiceMap = {
    en: el("enVoiceSelect").value,
    ja: el("jaVoiceSelect").value,
    zh: el("zhVoiceSelect").value
  };
  const defaultMap = {
    en: "edge:en-US-JennyNeural",
    ja: "edge:ja-JP-NanamiNeural",
    zh: "edge:zh-CN-XiaoxiaoNeural"
  };

  const selectedVal = voiceMap[langType] || defaultMap[langType];

  if (selectedVal.startsWith("sys:")) {
    setTtsStatus(`当前音源：浏览器本地系统 (${langType.toUpperCase()})`);
    return speakViaSystemTts(cleanText, langType, rate);
  }

  if (selectedVal.startsWith("gtts:")) {
    const gLang = selectedVal.slice(5);
    const cacheKey = `gtts|${gLang}|${cleanText}`;
    try {
      let blobUrl = ttsBlobCache.get(cacheKey);
      if (!blobUrl) {
        const res = await fetch(`/api/gtts?lang=${encodeURIComponent(gLang)}&text=${encodeURIComponent(cleanText)}`);
        if (!res.ok) throw new Error(`Google 网页接口异常 (${res.status})`);
        blobUrl = URL.createObjectURL(await res.blob());
        ttsBlobCache.set(cacheKey, blobUrl);
      }
      setTtsStatus(`当前音源：Google 网页在线 (${gLang})`);
      await playAudioBlobUrl(blobUrl, rate);
      return;
    } catch (err) {
      setTtsStatus(`Google 网页暂不可用(${err.message})，已切回本地发音`);
      return speakViaSystemTts(cleanText, langType, rate);
    }
  }

  const edgeVoice = selectedVal.startsWith("edge:") ? selectedVal.slice(5) : defaultMap[langType].slice(5);
  const cacheKey = `edge|${edgeVoice}|${rate.toFixed(1)}|${cleanText}`;
  try {
    let blobUrl = ttsBlobCache.get(cacheKey);
    if (!blobUrl) {
      const apiUrl = `/api/tts?voice=${encodeURIComponent(edgeVoice)}&rate=${rate.toFixed(1)}&text=${encodeURIComponent(cleanText)}`;
      const res = await fetch(apiUrl);
      if (!res.ok) {
        let errMsg = `${res.status}`;
        try { const j = await res.json(); errMsg = j.error || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }
      blobUrl = URL.createObjectURL(await res.blob());
      ttsBlobCache.set(cacheKey, blobUrl);
    }
    setTtsStatus(`当前音源：微软云端 (${edgeVoice})`);
    await playAudioBlobUrl(blobUrl, 1.0);
  } catch (err) {
    setTtsStatus(`微软接口异常(${err.message})，自动尝试 Google 网页在线...`);
    const gFallbackLang = langType === "zh" ? "zh-CN" : (langType === "ja" ? "ja" : "en-US");
    try {
      const res = await fetch(`/api/gtts?lang=${gFallbackLang}&text=${encodeURIComponent(cleanText)}`);
      if (!res.ok) throw new Error("Google 网页备用失败");
      const url = URL.createObjectURL(await res.blob());
      setTtsStatus(`当前音源：Google 网页在线 (${gFallbackLang})`);
      await playAudioBlobUrl(url, rate);
    } catch (_) {
      setTtsStatus(`云端暂不可用，已回退本地系统发音`);
      await speakViaSystemTts(cleanText, langType, rate);
    }
  }
}

function detectForeignLang(text) {
  return /[\u3040-\u30ff]/.test(String(text || "")) ? "ja" : "en";
}

async function speakForeignSequence(item, token) {
  if (!item || token !== state.playToken) return;

  // 支持独立开关控制单词本体是否发音
  if (el("readWordChk").checked) {
    await speakText(item.word, detectForeignLang(item.word));
    if (token !== state.playToken) return;
  }

  if (el("readPhrasesChk").checked && item.phrases.length > 0) {
    for (const p of item.phrases) {
      if (token !== state.playToken) return;
      if (p.foreign) await speakText(p.foreign, detectForeignLang(p.foreign));
    }
  }
}

async function speakChineseSequence(item, token) {
  if (!item || token !== state.playToken || !el("readZhChk").checked) return;

  if (item.meaning) {
    const cleanMeaning = item.meaning.replace(/\b(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int)\.\s*/gi, "");
    await speakText(cleanMeaning, "zh");
  }
  if (token !== state.playToken) return;

  if (el("readPhrasesChk").checked && item.phrases.length > 0) {
    for (const p of item.phrases) {
      if (token !== state.playToken) return;
      if (p.zh) await speakText(p.zh, "zh");
    }
  }
}

const waitMs = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

// 核心播放循环：语音彻底播完后，再严格执行设定的“思考时间”与“释义停留”
async function startAutoPlay() {
  if (state.filteredItems.length === 0) return;

  try { audioPlayer.load(); } catch (_) {}
  stopSpeechEngine();
  await waitMs(40);

  state.isPlaying = true;
  el("playPauseBtn").textContent = "暂停播放";
  requestWakeLock();
  setupSleepTimer();

  const token = ++state.playToken;

  while (state.isPlaying && token === state.playToken) {
    const item = state.filteredItems[state.index];
    const thinkSec = parseFloat(el("thinkTime").value) || 0;
    const staySec = parseFloat(el("stayTime").value) || 3.5;

    // 阶段一：仅显示原文并朗读外文 -> 外文彻底播完后，再进入纯粹的“思考时间”
    renderCard(thinkSec > 0);
    await speakForeignSequence(item, token);
    if (!state.isPlaying || token !== state.playToken) break;

    if (thinkSec > 0) {
      await waitMs(thinkSec * 1000);
      if (!state.isPlaying || token !== state.playToken) break;
    }

    // 阶段二：揭示释义并朗读中文 -> 中文彻底播完后，再进入纯粹的“释义停留”
    revealMeaningNow();
    await speakChineseSequence(item, token);
    if (!state.isPlaying || token !== state.playToken) break;

    if (staySec > 0) {
      await waitMs(staySec * 1000);
      if (!state.isPlaying || token !== state.playToken) break;
    }

    state.index = (state.index + 1) % state.filteredItems.length;
  }
}

function stopAutoPlay() {
  state.isPlaying = false;
  state.playToken++;
  stopSpeechEngine();
  el("playPauseBtn").textContent = "自动播放";
  releaseWakeLock();
}

async function triggerSingleSpeak() {
  if (state.filteredItems.length === 0) return;
  try { audioPlayer.load(); } catch (_) {}
  if (state.isPlaying) stopAutoPlay();
  stopSpeechEngine();
  await waitMs(40);

  const token = ++state.playToken;
  const item = state.filteredItems[state.index];
  revealMeaningNow();
  await speakForeignSequence(item, token);
  if (token === state.playToken) await speakChineseSequence(item, token);
}

// 8. 屏幕常亮、定时、纯净全屏与横竖屏
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (_) {}
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

function setupSleepTimer() {
  clearTimeout(state.sleepTimeout);
  const mins = parseInt(el("sleepTimerSelect").value, 10);
  if (mins > 0) state.sleepTimeout = setTimeout(() => stopAutoPlay(), mins * 60 * 1000);
}

async function enterPureFullscreen() {
  document.body.classList.add("pure-fullscreen");
  requestWakeLock();
  try {
    if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
  } catch (_) {}
}

async function exitPureFullscreen() {
  document.body.classList.remove("pure-fullscreen");
  el("fsHud").classList.remove("visible");
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
}

async function toggleOrientation() {
  state.isCssLandscape = !state.isCssLandscape;
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock(state.isCssLandscape ? "landscape" : "portrait");
      el("app").classList.remove("css-landscape");
      return;
    }
  } catch (_) {}
  el("app").classList.toggle("css-landscape", state.isCssLandscape);
}

// 9. 设置持久化与事件绑定
function savePrefs() {
  localStorage.setItem(STORAGE_PREFS, JSON.stringify({
    theme: document.body.dataset.theme,
    thinkTime: el("thinkTime").value,
    stayTime: el("stayTime").value,
    speechRate: el("speechRate").value,
    readWord: el("readWordChk").checked,
    readZh: el("readZhChk").checked,
    readPhrases: el("readPhrasesChk").checked,
    enVoiceURI: el("enVoiceSelect").value,
    jaVoiceURI: el("jaVoiceSelect").value,
    zhVoiceURI: el("zhVoiceSelect").value,
    ghOwner: el("ghOwnerInput").value,
    ghRepo: el("ghRepoInput").value,
    ghToken: el("ghTokenInput").value
  }));
}

function restorePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_PREFS) || "{}");
    if (p.theme) applyTheme(p.theme, false);
    if (p.thinkTime !== undefined) el("thinkTime").value = p.thinkTime;
    if (p.stayTime !== undefined) el("stayTime").value = p.stayTime;
    if (p.speechRate !== undefined) el("speechRate").value = p.speechRate;
    if (typeof p.readWord === "boolean") el("readWordChk").checked = p.readWord;
    if (typeof p.readZh === "boolean") el("readZhChk").checked = p.readZh;
    if (typeof p.readPhrases === "boolean") el("readPhrasesChk").checked = p.readPhrases;
    if (p.ghOwner) el("ghOwnerInput").value = p.ghOwner;
    if (p.ghRepo) el("ghRepoInput").value = p.ghRepo;
    if (p.ghToken) el("ghTokenInput").value = p.ghToken;
  } catch (_) {}
  el("thinkTimeVal").textContent = `${parseFloat(el("thinkTime").value).toFixed(1)}s`;
  el("stayTimeVal").textContent = `${parseFloat(el("stayTime").value).toFixed(1)}s`;
  el("speechRateVal").textContent = `${parseFloat(el("speechRate").value).toFixed(1)}x`;
}

function applyTheme(themeVal, persist = true) {
  document.body.dataset.theme = themeVal;
  document.querySelectorAll(".theme-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.themeVal === themeVal);
  });
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute("content", themeVal === "day" ? "#f4f7fb" : "#000000");
  if (persist) savePrefs();
}

function bindEvents() {
  el("openSettingsBtn").addEventListener("click", () => {
    applyAutoTokenIfNeeded();
    el("settingsDialog").showModal();
  });
  el("openFavsBtn").addEventListener("click", openFavoritesModal);
  el("openBooksBtn").addEventListener("click", () => {
    renderBookManageList();
    el("booksDialog").showModal();
  });
  el("openImportBtn").addEventListener("click", () => el("importDialog").showModal());
  el("fullscreenBtn").addEventListener("click", enterPureFullscreen);

  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => el(btn.dataset.close).close());
  });
  [el("settingsDialog"), el("favsDialog"), el("booksDialog"), el("editorDialog"), el("importDialog")].forEach(dlg => {
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  });

  // 舞台区域统一手势：双击任意非按钮区域自动收藏/取消收藏；单击揭示意思或唤出全屏控制条
  let lastStageTapTime = 0;
  let singleTapTimer = null;

  el("stage").addEventListener("click", e => {
    if (e.target.closest("button") || e.target.closest("#fsHud")) return;

    const now = Date.now();
    if (now - lastStageTapTime < 320) {
      clearTimeout(singleTapTimer);
      lastStageTapTime = 0;
      toggleFavoriteCurrentWord();
      return;
    }

    lastStageTapTime = now;
    singleTapTimer = setTimeout(() => {
      if (e.target.closest("#vocabCard") && el("vocabCard").classList.contains("hide-meaning")) {
        revealMeaningNow();
      } else if (document.body.classList.contains("pure-fullscreen")) {
        const hud = el("fsHud");
        hud.classList.add("visible");
        clearTimeout(state.hudTimeout);
        state.hudTimeout = setTimeout(() => hud.classList.remove("visible"), 3000);
      }
    }, 320);
  });

  // 收藏册弹窗操作
  el("selectAllFavsChk").addEventListener("change", e => {
    document.querySelectorAll(".fav-select-chk").forEach(c => { c.checked = e.target.checked; });
  });

  el("removeSelectedFavsBtn").addEventListener("click", () => {
    const selectedSet = new Set(
      [...document.querySelectorAll(".fav-select-chk:checked")].map(c => parseInt(c.value, 10))
    );
    if (selectedSet.size === 0) return alert("请先勾选要移除的收藏单词");
    state.favorites = state.favorites.filter((_, idx) => !selectedSet.has(idx));
    saveFavorites();
    renderFavsManageList();
  });

  el("reciteSelectedFavsBtn").addEventListener("click", () => {
    const chosen = getSelectedFavoriteItems();
    if (chosen.length === 0) return alert("请至少勾选一个收藏单词");

    stopAutoPlay();
    state.currentBookId = "fav:temp";
    state.allItems = JSON.parse(JSON.stringify(chosen));
    buildCategoryFilter();
    applyCategoryFilter("ALL");
    el("favsDialog").close();
    showToast(`已载入 ${chosen.length} 个收藏词，可随时开始背诵`);
  });

  el("exportFavsBtn").addEventListener("click", () => {
    const chosen = getSelectedFavoriteItems();
    if (chosen.length === 0) return alert("请先勾选要导出的收藏单词");

    const lines = chosen.map(item => {
      const fStr = (item.phrases || []).map(p => p.foreign).filter(Boolean).join(";");
      const zStr = (item.phrases || []).map(p => p.zh).filter(Boolean).join(";");
      return `${item.word}|${item.meaning || ""}|${item.phonetic || ""}|${fStr}|${zStr}|${item.category || "收藏"}`;
    });

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `收藏词库_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  el("saveFavsCloudBtn").addEventListener("click", async () => {
    const chosen = getSelectedFavoriteItems();
    if (chosen.length === 0) return alert("请先勾选要保存的收藏单词");

    const folderPath = el("favTargetFolderInput").value.trim() || "books/favorites";
    const bookName = el("favTargetBookInput").value.trim() || `收藏精选_${new Date().toISOString().slice(0, 10)}`;
    const customCat = el("favTargetCatInput").value.trim();

    const itemsToSave = chosen.map(item => ({
      ...item,
      category: customCat || item.category || "重点收藏"
    }));

    const btn = el("saveFavsCloudBtn");
    btn.disabled = true;
    btn.textContent = "保存中...";

    try {
      const newRepoId = await saveBookToGitHub(bookName, itemsToSave, "", folderPath);
      el("favsDialog").close();
      await reloadAllBooks(newRepoId);
      showToast(`已保存到 GitHub：${folderPath}/${sanitizeFileName(bookName)}`);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "保存至 GitHub";
    }
  });

  // 试听三语
  el("testVoiceBtn").addEventListener("click", async () => {
    const btn = el("testVoiceBtn");
    btn.disabled = true;
    btn.textContent = "试听中...";
    try {
      stopAutoPlay();
      await speakText("Serendipity", "en");
      await speakText("おやすみなさい", "ja");
      await speakText("云端人声测试成功", "zh");
    } finally {
      btn.disabled = false;
      btn.textContent = "试听三语";
    }
  });

  el("copySampleBtn").addEventListener("click", async () => {
    const sampleText = el("sampleTemplateBox").textContent.trim();
    try {
      await navigator.clipboard.writeText(sampleText);
      el("copySampleBtn").textContent = "已复制样本 ✓";
      setTimeout(() => { el("copySampleBtn").textContent = "复制格式样本"; }, 2000);
    } catch (_) {
      el("importTextArea").value = sampleText;
    }
  });

  el("fillSampleBtn").addEventListener("click", () => {
    el("importTextArea").value = el("sampleTemplateBox").textContent.trim();
    if (!el("importBookName").value) el("importBookName").value = "样本测试词库";
  });

  el("bookSelect").addEventListener("change", e => selectBook(e.target.value));
  el("categorySelect").addEventListener("change", e => {
    stopAutoPlay();
    applyCategoryFilter(e.target.value);
  });

  el("selectAllBooksChk").addEventListener("change", e => {
    document.querySelectorAll(".book-del-chk").forEach(c => { c.checked = e.target.checked; });
    updateBatchDeleteBtnCount();
  });

  el("batchDeleteBooksBtn").addEventListener("click", async () => {
    const checkedIds = [...document.querySelectorAll(".book-del-chk:checked")].map(c => c.value);
    if (checkedIds.length === 0) return alert("请先勾选要删除的词库");
    if (!confirm(`确定要删除选中的 ${checkedIds.length} 个词库吗？`)) return;

    const btn = el("batchDeleteBooksBtn");
    btn.disabled = true;
    btn.textContent = "删除中...";

    try {
      let locals = getLocalBooks();
      for (const id of checkedIds) {
        if (id.startsWith("local:")) {
          locals = locals.filter(b => b.id !== id);
        } else if (id.startsWith("repo:")) {
          await deleteBookFromGitHub(id.replace(/^repo:/, ""));
        }
      }
      saveLocalBooks(locals);
      await reloadAllBooks();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      updateBatchDeleteBtnCount();
    }
  });

  el("openEditorBtn").addEventListener("click", openBookEditor);

  el("applyBatchCategoryBtn").addEventListener("click", () => {
    const newCat = el("batchCategoryInput").value.trim();
    if (!newCat) return alert("请输入目标分类名称");
    state.editingItems.forEach(item => { item.category = newCat; });
    renderEditorItems();
  });

  el("addWordItemBtn").addEventListener("click", () => {
    const defaultCat = state.editingItems[0]?.category || "默认分类";
    state.editingItems.unshift({ category: defaultCat, word: "", phonetic: "", meaning: "", phrases: [] });
    renderEditorItems();
  });

  el("saveEditLocalBtn").addEventListener("click", async () => {
    const cleanItems = state.editingItems.filter(i => i.word.trim());
    if (cleanItems.length === 0) return alert("词库至少需要保留一个有效单词");
    const rawName = el("editBookNameInput").value.trim() || "未命名词库";

    const locals = getLocalBooks();
    if (state.currentBookId.startsWith("local:")) {
      const target = locals.find(b => b.id === state.currentBookId);
      if (target) {
        target.rawName = rawName;
        target.name = `[本地] ${rawName}`;
        target.items = cleanItems;
      }
      saveLocalBooks(locals);
      el("editorDialog").close();
      await reloadAllBooks(state.currentBookId);
    } else {
      const newId = `local:${Date.now()}`;
      locals.unshift({ id: newId, rawName, name: `[本地] ${rawName}`, source: "local", items: cleanItems });
      saveLocalBooks(locals);
      el("editorDialog").close();
      await reloadAllBooks(newId);
    }
  });

  el("saveEditCloudBtn").addEventListener("click", async () => {
    const cleanItems = state.editingItems.filter(i => i.word.trim());
    if (cleanItems.length === 0) return alert("词库至少需要保留一个有效单词");
    const rawName = el("editBookNameInput").value.trim() || "未命名词库";

    const btn = el("saveEditCloudBtn");
    btn.disabled = true;
    btn.textContent = "同步到 GitHub 中...";

    try {
      const currentBook = state.books.find(b => b.id === state.currentBookId);
      const existingFile = currentBook?.source === "repo" ? currentBook.file : "";
      const newRepoId = await saveBookToGitHub(rawName, cleanItems, existingFile);
      el("editorDialog").close();
      await reloadAllBooks(newRepoId);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "保存到 GitHub 云端";
    }
  });

  el("importFileInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!el("importBookName").value) el("importBookName").value = file.name.replace(/\.[^.]+$/, "");
    el("importTextArea").value = await file.text();
  });

  el("confirmImportBtn").addEventListener("click", async () => {
    const btn = el("confirmImportBtn");
    try {
      const items = parseImportedContent(el("importTextArea").value);
      if (items.length === 0) return alert("未识别到有效单词，请检查格式");

      const rawName = el("importBookName").value.trim() || `词库_${new Date().toISOString().slice(0, 10)}`;
      const target = el("importTargetSelect").value;

      btn.disabled = true;
      btn.textContent = "保存中...";

      if (target === "repo") {
        const newRepoId = await saveBookToGitHub(rawName, items);
        el("importDialog").close();
        el("importTextArea").value = "";
        el("importBookName").value = "";
        await reloadAllBooks(newRepoId);
      } else {
        const newBook = { id: `local:${Date.now()}`, rawName, name: `[本地] ${rawName}`, source: "local", items };
        const locals = getLocalBooks();
        locals.unshift(newBook);
        saveLocalBooks(locals);
        el("importDialog").close();
        el("importTextArea").value = "";
        el("importBookName").value = "";
        await reloadAllBooks(newBook.id);
      }
    } catch (err) {
      alert(err.message || "格式解析或保存失败");
    } finally {
      btn.disabled = false;
      btn.textContent = "确认保存并使用";
    }
  });

  el("ghOwnerInput").addEventListener("input", savePrefs);
  el("ghRepoInput").addEventListener("input", savePrefs);
  el("ghTokenInput").addEventListener("input", () => {
    savePrefs();
    updateTokenStatus();
  });
  el("enVoiceSelect").addEventListener("change", savePrefs);
  el("jaVoiceSelect").addEventListener("change", savePrefs);
  el("zhVoiceSelect").addEventListener("change", savePrefs);

  document.querySelectorAll(".theme-btn").forEach(btn => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.themeVal, true));
  });

  el("thinkTime").addEventListener("input", e => {
    el("thinkTimeVal").textContent = `${parseFloat(e.target.value).toFixed(1)}s`;
    savePrefs();
  });
  el("stayTime").addEventListener("input", e => {
    el("stayTimeVal").textContent = `${parseFloat(e.target.value).toFixed(1)}s`;
    savePrefs();
  });
  el("speechRate").addEventListener("input", e => {
    el("speechRateVal").textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
    savePrefs();
  });

  el("readWordChk").addEventListener("change", savePrefs);
  el("readZhChk").addEventListener("change", savePrefs);
  el("readPhrasesChk").addEventListener("change", savePrefs);

  el("playPauseBtn").addEventListener("click", () => state.isPlaying ? stopAutoPlay() : startAutoPlay());
  el("speakOnceBtn").addEventListener("click", triggerSingleSpeak);

  el("prevBtn").addEventListener("click", () => {
    if (!state.filteredItems.length) return;
    state.index = (state.index - 1 + state.filteredItems.length) % state.filteredItems.length;
    if (state.isPlaying) { stopAutoPlay(); startAutoPlay(); } else { renderCard(false); }
  });

  el("nextBtn").addEventListener("click", () => {
    if (!state.filteredItems.length) return;
    state.index = (state.index + 1) % state.filteredItems.length;
    if (state.isPlaying) { stopAutoPlay(); startAutoPlay(); } else { renderCard(false); }
  });

  el("rotateBtn").addEventListener("click", toggleOrientation);
  el("fsRotateToggle").addEventListener("click", e => { e.stopPropagation(); toggleOrientation(); });
  el("fsExitBtn").addEventListener("click", e => { e.stopPropagation(); exitPureFullscreen(); });
  el("fsRevealBtn").addEventListener("click", e => { e.stopPropagation(); revealMeaningNow(); });
  el("fsFavBtn").addEventListener("click", e => { e.stopPropagation(); toggleFavoriteCurrentWord(); });
  el("fsPlayToggle").addEventListener("click", e => {
    e.stopPropagation();
    state.isPlaying ? stopAutoPlay() : startAutoPlay();
  });
}

init();
