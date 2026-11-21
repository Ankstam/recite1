const STORAGE_LOCAL_BOOKS = "wf_local_books_v1";
const STORAGE_PREFS = "wf_prefs_v1";

const state = {
  books: [],          // [{ id, name, source: 'repo'|'local', items: [...] }]
  currentBookId: "",
  allItems: [],
  filteredItems: [],
  index: 0,
  isPlaying: false,
  playToken: 0,
  isCssLandscape: false,
  wakeLock: null,
  sleepTimeout: null,
  hudTimeout: null
};

const el = id => document.getElementById(id);

// 1. 初始化加载：同时拉取 GitHub 仓库词库与本地导入词库
async function init() {
  restorePrefs();
  bindEvents();

  const localBooks = getLocalBooks();
  let repoBooks = [];
  try {
    const res = await fetch("/api/books");
    if (res.ok) {
      const list = await res.json();
      repoBooks = list.map(b => ({
        id: b.id,
        name: `[仓库] ${b.name}`,
        source: "repo",
        file: b.file,
        items: null // 选中时按需加载
      }));
    }
  } catch (_) {
    // 离线状态下自动跳过网络拉取，直接使用本地导入词库
  }

  state.books = [...repoBooks, ...localBooks];
  renderBookOptions();

  if (state.books.length > 0) {
    await selectBook(state.books[0].id);
  }
}

function getLocalBooks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_LOCAL_BOOKS) || "[]");
  } catch {
    return [];
  }
}

function saveLocalBooks(books) {
  localStorage.setItem(STORAGE_LOCAL_BOOKS, JSON.stringify(books));
}

function renderBookOptions() {
  const select = el("bookSelect");
  select.innerHTML = "";
  if (state.books.length === 0) {
    select.innerHTML = `<option value="">暂无词库（请点击右侧导入）</option>`;
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

// 2. 切换并标准化加载词库（兼容仓库 JSON 与本地存储）
async function selectBook(bookId) {
  stopAutoPlay();
  state.currentBookId = bookId;
  el("bookSelect").value = bookId;

  const book = state.books.find(b => b.id === bookId);
  if (!book) return;

  el("deleteLocalBookBtn").style.display = book.source === "local" ? "inline-block" : "none";

  if (book.source === "repo" && !book.items) {
    el("cardWord").textContent = "加载中...";
    const res = await fetch(`/api/book/${encodeURIComponent(book.file)}`);
    const data = await res.json();
    book.items = normalizeItems(Array.isArray(data) ? data : data.items || []);
  }

  state.allItems = book.items || [];
  buildCategoryFilter();
  applyCategoryFilter("ALL");
}

function normalizeItems(rawList) {
  return rawList.map(item => ({
    category: (item.category || "未分类").trim(),
    word: (item.word || "").trim(),
    phonetic: (item.phonetic || "").trim(),
    meaning: (item.meaning || "").trim(),
    phrases: Array.isArray(item.phrases)
      ? item.phrases
      : typeof item.phrases === "string" && item.phrases
      ? item.phrases.split(";").map(s => s.trim()).filter(Boolean)
      : []
  })).filter(i => i.word);
}

// 3. 本地导入解析器（支持 JSON 文件、TXT 文本文件或直接粘贴）
function parseImportedContent(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  // 尝试作为 JSON 解析
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return normalizeItems(Array.isArray(parsed) ? parsed : parsed.items || []);
  }

  // 作为纯文本逐行解析：单词 | 音标 | 释义 | 词组1;词组2 | 分类
  return trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split("|").map(s => s.trim());
      return {
        word: parts[0] || "",
        phonetic: parts[1] || "",
        meaning: parts[2] || "",
        phrases: parts[3] ? parts[3].split(";").map(p => p.trim()).filter(Boolean) : [],
        category: parts[4] || "自定义导入"
      };
    })
    .filter(i => i.word);
}

// 4. 分类过滤与卡片渲染
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
  renderCard();
}

function renderCard() {
  const total = state.filteredItems.length;
  if (total === 0) {
    el("cardCategory").textContent = "空词库";
    el("cardWord").textContent = "无匹配单词";
    el("cardPhonetic").textContent = "";
    el("cardMeaning").textContent = "请切换分类或导入词库";
    el("cardPhrases").innerHTML = "";
    el("progressText").textContent = "0 / 0";
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
    li.textContent = p;
    ul.appendChild(li);
  });

  el("progressText").textContent = `${state.index + 1} / ${total}`;
}

// 5. TTS 语音朗读（自动识别英/日文，确保读完才切下一个）
function speakText(text) {
  return new Promise(resolve => {
    if (!("speechSynthesis" in window) || !text) return resolve();
    const utter = new SpeechSynthesisUtterance(text);
    // 自动检测日文假名/汉字或英文
    utter.lang = /[\u3040-\u30ff]/.test(text) ? "ja-JP" : "en-US";
    utter.rate = parseFloat(el("speechRate").value);
    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

async function speakCurrentItem(token) {
  const item = state.filteredItems[state.index];
  if (!item) return;
  window.speechSynthesis.cancel();

  await speakText(item.word);
  if (token !== state.playToken) return;

  if (el("readPhrasesChk").checked && item.phrases.length > 0) {
    for (const phrase of item.phrases) {
      if (token !== state.playToken) return;
      // 提取词组中的外文部分进行朗读（过滤中文释义）
      const foreignPart = phrase.replace(/[\u4e00-\u9fa5（）【】，。；：]+/g, " ").trim();
      if (foreignPart) await speakText(foreignPart);
    }
  }
}

// 6. 自动播放主循环（双速锁定：朗读完成 + 最小停留时间均满足才翻页）
async function startAutoPlay() {
  if (state.filteredItems.length === 0) return;
  // iOS/移动端首次用户点击解锁语音引擎
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));

  state.isPlaying = true;
  el("playPauseBtn").textContent = "暂停播放";
  requestWakeLock();
  setupSleepTimer();

  const token = ++state.playToken;

  while (state.isPlaying && token === state.playToken) {
    renderCard();
    const minWaitMs = parseFloat(el("displaySpeed").value) * 1000;
    const waitPromise = new Promise(r => setTimeout(r, minWaitMs));
    const speakPromise = speakCurrentItem(token);

    await Promise.all([waitPromise, speakPromise]);
    if (!state.isPlaying || token !== state.playToken) break;

    state.index = (state.index + 1) % state.filteredItems.length;
  }
}

function stopAutoPlay() {
  state.isPlaying = false;
  state.playToken++;
  window.speechSynthesis.cancel();
  el("playPauseBtn").textContent = "自动播放";
  releaseWakeLock();
}

// 7. 屏幕常亮与定时停止
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
  if (mins > 0) {
    state.sleepTimeout = setTimeout(() => stopAutoPlay(), mins * 60 * 1000);
  }
}

// 8. 纯净全屏与横竖屏控制
async function enterPureFullscreen() {
  document.body.classList.add("pure-fullscreen");
  requestWakeLock();
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch (_) {}
}

async function exitPureFullscreen() {
  document.body.classList.remove("pure-fullscreen");
  el("fsHud").classList.remove("visible");
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
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
  // 浏览器不支持系统方向锁定时，启用 CSS 90度旋转兜底
  el("app").classList.toggle("css-landscape", state.isCssLandscape);
}

// 9. 事件绑定与偏好记忆
function savePrefs() {
  localStorage.setItem(STORAGE_PREFS, JSON.stringify({
    theme: document.body.dataset.theme,
    displaySpeed: el("displaySpeed").value,
    speechRate: el("speechRate").value,
    readPhrases: el("readPhrasesChk").checked
  }));
}

function restorePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_PREFS) || "{}");
    if (p.theme) applyTheme(p.theme, false);
    if (p.displaySpeed) el("displaySpeed").value = p.displaySpeed;
    if (p.speechRate) el("speechRate").value = p.speechRate;
    if (typeof p.readPhrases === "boolean") el("readPhrasesChk").checked = p.readPhrases;
  } catch (_) {}
  el("displaySpeedVal").textContent = `${parseFloat(el("displaySpeed").value).toFixed(1)}s`;
  el("speechRateVal").textContent = `${parseFloat(el("speechRate").value).toFixed(2)}x`;
}

function applyTheme(mode, adjustSpeed = true) {
  document.body.dataset.theme = mode;
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  if (adjustSpeed) {
    if (mode === "bedtime") {
      el("speechRate").value = "0.75";
      el("displaySpeed").value = "5.0";
    } else if (mode === "wakeup") {
      el("speechRate").value = "0.85";
      el("displaySpeed").value = "4.0";
    } else {
      el("speechRate").value = "1.00";
      el("displaySpeed").value = "3.0";
    }
    el("displaySpeedVal").textContent = `${parseFloat(el("displaySpeed").value).toFixed(1)}s`;
    el("speechRateVal").textContent = `${parseFloat(el("speechRate").value).toFixed(2)}x`;
  }
  savePrefs();
}

function bindEvents() {
  el("bookSelect").addEventListener("change", e => selectBook(e.target.value));
  el("categorySelect").addEventListener("change", e => {
    stopAutoPlay();
    applyCategoryFilter(e.target.value);
  });

  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.mode, true));
  });

  el("displaySpeed").addEventListener("input", e => {
    el("displaySpeedVal").textContent = `${parseFloat(e.target.value).toFixed(1)}s`;
    savePrefs();
  });
  el("speechRate").addEventListener("input", e => {
    el("speechRateVal").textContent = `${parseFloat(e.target.value).toFixed(2)}x`;
    savePrefs();
  });
  el("readPhrasesChk").addEventListener("change", savePrefs);

  el("playPauseBtn").addEventListener("click", () => state.isPlaying ? stopAutoPlay() : startAutoPlay());
  el("speakOnceBtn").addEventListener("click", () => speakCurrentItem(++state.playToken));
  el("prevBtn").addEventListener("click", () => {
    if (!state.filteredItems.length) return;
    state.index = (state.index - 1 + state.filteredItems.length) % state.filteredItems.length;
    renderCard();
    if (state.isPlaying) { stopAutoPlay(); startAutoPlay(); }
  });
  el("nextBtn").addEventListener("click", () => {
    if (!state.filteredItems.length) return;
    state.index = (state.index + 1) % state.filteredItems.length;
    renderCard();
    if (state.isPlaying) { stopAutoPlay(); startAutoPlay(); }
  });

  el("rotateBtn").addEventListener("click", toggleOrientation);
  el("fsRotateToggle").addEventListener("click", e => { e.stopPropagation(); toggleOrientation(); });
  el("fullscreenBtn").addEventListener("click", enterPureFullscreen);
  el("fsExitBtn").addEventListener("click", e => { e.stopPropagation(); exitPureFullscreen(); });
  el("fsPlayToggle").addEventListener("click", e => {
    e.stopPropagation();
    state.isPlaying ? stopAutoPlay() : startAutoPlay();
  });

  // 纯净全屏下轻触屏幕任意位置，短暂浮出退出控制条（3秒后自动隐藏）
  el("stage").addEventListener("click", () => {
    if (!document.body.classList.contains("pure-fullscreen")) return;
    const hud = el("fsHud");
    hud.classList.add("visible");
    clearTimeout(state.hudTimeout);
    state.hudTimeout = setTimeout(() => hud.classList.remove("visible"), 3000);
  });

  // 导入弹窗交互
  el("openImportBtn").addEventListener("click", () => el("importDialog").showModal());
  el("importFileInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!el("importBookName").value) {
      el("importBookName").value = file.name.replace(/\.[^.]+$/, "");
    }
    el("importTextArea").value = await file.text();
  });

  el("confirmImportBtn").addEventListener("click", async () => {
    try {
      const items = parseImportedContent(el("importTextArea").value);
      if (items.length === 0) return alert("未识别到有效单词，请检查格式");

      const name = el("importBookName").value.trim() || `本地词库 ${new Date().toLocaleDateString()}`;
      const newBook = {
        id: `local:${Date.now()}`,
        name: `[本地] ${name}`,
        source: "local",
        items
      };

      const locals = getLocalBooks();
      locals.unshift(newBook);
      saveLocalBooks(locals);

      state.books = [newBook, ...state.books];
      renderBookOptions();
      el("importDialog").close();
      el("importTextArea").value = "";
      el("importBookName").value = "";
      await selectBook(newBook.id);
    } catch (err) {
      alert("JSON 格式解析失败，请检查括号或引号是否完整");
    }
  });

  el("deleteLocalBookBtn").addEventListener("click", async () => {
    if (!state.currentBookId.startsWith("local:")) return;
    const locals = getLocalBooks().filter(b => b.id !== state.currentBookId);
    saveLocalBooks(locals);
    state.books = state.books.filter(b => b.id !== state.currentBookId);
    renderBookOptions();
    el("importDialog").close();
    if (state.books.length > 0) await selectBook(state.books[0].id);
  });
}

init();
