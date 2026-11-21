const STORAGE_LOCAL_BOOKS = "wf_local_books_v3";
const STORAGE_PREFS = "wf_prefs_v3";

const activeUtterances = new Set();

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
  voices: [],
  editingItems: []
};

const el = id => document.getElementById(id);

// 1. 初始化
async function init() {
  initVoices();
  restorePrefs();
  bindEvents();
  await reloadAllBooks();
}

async function reloadAllBooks(preferBookId = "") {
  const localBooks = getLocalBooks();
  let repoBooks = [];
  try {
    const res = await fetch(`/api/books?t=${Date.now()}`);
    if (res.ok) {
      const list = await res.json();
      repoBooks = list.map(b => ({
        id: b.id,
        rawName: b.name,
        name: `[云端] ${b.name}`,
        source: "repo",
        file: b.file,
        items: null
      }));
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

// 2. 多人声加载
function initVoices() {
  if (!("speechSynthesis" in window)) return;

  const load = () => {
    const list = window.speechSynthesis.getVoices();
    if (!list || list.length === 0) return;
    state.voices = list;

    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFS) || "{}");
    const foreignSel = el("foreignVoiceSelect");
    const zhSel = el("zhVoiceSelect");

    foreignSel.innerHTML = `<option value="">外文：自动人声</option>`;
    zhSel.innerHTML = `<option value="">中文：自动人声</option>`;

    list.forEach(v => {
      const langLow = (v.lang || "").toLowerCase();
      const label = `${v.name.replace(/Microsoft |Google |Apple /g, "")} (${v.lang})`;
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = label;

      if (langLow.startsWith("zh") || langLow.includes("cmn")) {
        zhSel.appendChild(opt);
      } else {
        foreignSel.appendChild(opt);
      }
    });

    if (saved.foreignVoiceURI) foreignSel.value = saved.foreignVoiceURI;
    if (saved.zhVoiceURI) zhSel.value = saved.zhVoiceURI;
  };

  load();
  window.speechSynthesis.onvoiceschanged = load;
  setTimeout(load, 400);
  setTimeout(load, 1200);
}

// 3. 词库存储与云端同步工具
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

function getAdminHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Admin-Password": el("adminPwdInput").value.trim()
  };
}

function sanitizeFileName(name) {
  const clean = name.trim().replace(/[\\/:*?"<>|]/g, "_") || `book_${Date.now()}`;
  return clean.endsWith(".json") ? clean : `${clean}.json`;
}

async function saveBookToGitHub(bookName, items, existingFileName = "") {
  const fileName = existingFileName || sanitizeFileName(bookName);
  const payload = {
    bookName: bookName.replace(/\.json$/i, ""),
    updatedAt: new Date().toISOString(),
    items: items.map(item => ({
      category: item.category || "未分类",
      word: item.word,
      phonetic: item.phonetic || "",
      meaning: item.meaning || "",
      phrases: item.phrases.map(p => (p.zh ? `${p.foreign} | ${p.zh}` : p.foreign))
    }))
  };

  const res = await fetch(`/api/book/${encodeURIComponent(fileName)}`, {
    method: "PUT",
    headers: getAdminHeaders(),
    body: JSON.stringify(payload, null, 2)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "保存到 GitHub 失败");
  }
  return `repo:${data.file || fileName}`;
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

// 渲染多选批量删除列表
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
    title.textContent = b.rawName || b.name.replace(/^\[(云端|本地)\]\s*/, "");

    const badge = document.createElement("span");
    badge.className = b.source === "repo" ? "tag-cloud" : "tag-local";
    badge.textContent = b.source === "repo" ? "GitHub" : "本地";

    label.appendChild(chk);
    label.appendChild(title);
    label.appendChild(badge);
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
    const res = await fetch(`/api/book/${encodeURIComponent(book.file)}?t=${Date.now()}`);
    const data = await res.json();
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
  if (match) {
    return { foreign: match[1].trim(), zh: match[2].trim() };
  }

  if (/^[\u4e00-\u9fa5\s，。！？；：、（）]+$/.test(text)) {
    return { foreign: "", zh: text };
  }

  return { foreign: text, zh: "" };
}

function normalizeItems(rawList) {
  return rawList.map(item => {
    const rawPhrases = Array.isArray(item.phrases)
      ? item.phrases
      : typeof item.phrases === "string" && item.phrases
      ? item.phrases.split(";").map(s => s.trim()).filter(Boolean)
      : [];

    const parsedPhrases = rawPhrases.map(p => {
      if (typeof p === "object" && p !== null) {
        return { foreign: (p.text || p.en || "").trim(), zh: (p.zh || p.meaning || "").trim() };
      }
      return splitBilingualLine(p);
    });

    if (item.example) {
      const ex = splitBilingualLine(item.example);
      parsedPhrases.push({
        foreign: ex.foreign,
        zh: (item.exampleMeaning || ex.zh || "").trim()
      });
    }

    return {
      category: (item.category || "未分类").trim(),
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

  return normalizeItems(
    trimmed
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
  );
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
}

function revealMeaningNow() {
  el("vocabCard").classList.remove("hide-meaning");
}

// 5. 词库与分类编辑器逻辑
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
    phonIn.placeholder = "音标";
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
    meanIn.placeholder = "中文意思";
    meanIn.value = item.meaning;
    meanIn.addEventListener("input", e => { state.editingItems[idx].meaning = e.target.value; });

    const phraseIn = document.createElement("textarea");
    phraseIn.rows = 2;
    phraseIn.placeholder = "词组或例句（每行一条，格式：英文 | 中文意思）";
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

// 6. TTS 朗读核心
function stopSpeechEngine() {
  if (!("speechSynthesis" in window)) return;
  activeUtterances.clear();
  try {
    window.speechSynthesis.cancel();
  } catch (_) {}
}

function speakText(text, isChinese = false) {
  return new Promise(resolve => {
    if (!("speechSynthesis" in window)) return resolve();
    const cleanText = String(text || "").trim();
    if (!cleanText) return resolve();

    let settled = false;
    const rate = parseFloat(el("speechRate").value) || 0.85;
    const utter = new SpeechSynthesisUtterance(cleanText);
    utter.rate = rate;

    if (isChinese) {
      utter.lang = "zh-CN";
      const zhUri = el("zhVoiceSelect").value;
      if (zhUri) {
        const v = state.voices.find(item => item.voiceURI === zhUri);
        if (v) utter.voice = v;
      }
    } else {
      const isJapanese = /[\u3040-\u30ff]/.test(cleanText);
      utter.lang = isJapanese ? "ja-JP" : "en-US";
      const fUri = el("foreignVoiceSelect").value;
      if (fUri) {
        const v = state.voices.find(item => item.voiceURI === fUri);
        if (v) utter.voice = v;
      }
    }

    const maxDurationMs = Math.max(2800, Math.ceil((cleanText.length * 420) / rate) + 2200);
    const watchdog = setTimeout(() => finish(), maxDurationMs);
    const resumeTimer = setInterval(() => {
      try {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      } catch (_) {}
    }, 350);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(resumeTimer);
      activeUtterances.delete(utter);
      resolve();
    }

    utter.onend = finish;
    utter.onerror = finish;

    activeUtterances.add(utter);
    try {
      window.speechSynthesis.speak(utter);
    } catch (_) {
      finish();
    }
  });
}

async function speakForeignSequence(item, token) {
  if (!item || token !== state.playToken) return;
  await speakText(item.word, false);
  if (token !== state.playToken) return;

  if (el("readPhrasesChk").checked && item.phrases.length > 0) {
    for (const p of item.phrases) {
      if (token !== state.playToken) return;
      if (p.foreign) await speakText(p.foreign, false);
    }
  }
}

async function speakChineseSequence(item, token) {
  if (!item || token !== state.playToken || !el("readZhChk").checked) return;

  if (item.meaning) {
    const cleanMeaning = item.meaning.replace(/\b(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int)\.\s*/gi, "");
    await speakText(cleanMeaning, true);
  }
  if (token !== state.playToken) return;

  if (el("readPhrasesChk").checked && item.phrases.length > 0) {
    for (const p of item.phrases) {
      if (token !== state.playToken) return;
      if (p.zh) await speakText(p.zh, true);
    }
  }
}

const waitMs = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

async function startAutoPlay() {
  if (state.filteredItems.length === 0) return;

  stopSpeechEngine();
  await waitMs(60);

  state.isPlaying = true;
  el("playPauseBtn").textContent = "暂停播放";
  requestWakeLock();
  setupSleepTimer();

  const token = ++state.playToken;

  while (state.isPlaying && token === state.playToken) {
    const item = state.filteredItems[state.index];
    const thinkSec = parseFloat(el("thinkTime").value) || 0;
    const staySec = parseFloat(el("stayTime").value) || 3.5;

    renderCard(thinkSec > 0);
    await Promise.all([
      waitMs(thinkSec * 1000),
      speakForeignSequence(item, token)
    ]);
    if (!state.isPlaying || token !== state.playToken) break;

    revealMeaningNow();
    await Promise.all([
      waitMs(staySec * 1000),
      speakChineseSequence(item, token)
    ]);
    if (!state.isPlaying || token !== state.playToken) break;

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
  if (state.isPlaying) stopAutoPlay();
  stopSpeechEngine();
  await waitMs(60);

  const token = ++state.playToken;
  const item = state.filteredItems[state.index];
  revealMeaningNow();
  await speakForeignSequence(item, token);
  if (token === state.playToken) {
    await speakChineseSequence(item, token);
  }
}

// 7. 屏幕常亮、定时、纯净全屏与横竖屏
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
  el("app").classList.toggle("css-landscape", state.isCssLandscape);
}

// 8. 设置持久化与事件绑定
function savePrefs() {
  localStorage.setItem(STORAGE_PREFS, JSON.stringify({
    theme: document.body.dataset.theme,
    thinkTime: el("thinkTime").value,
    stayTime: el("stayTime").value,
    speechRate: el("speechRate").value,
    readZh: el("readZhChk").checked,
    readPhrases: el("readPhrasesChk").checked,
    foreignVoiceURI: el("foreignVoiceSelect").value,
    zhVoiceURI: el("zhVoiceSelect").value,
    adminPwd: el("adminPwdInput").value
  }));
}

function restorePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_PREFS) || "{}");
    if (p.theme) applyTheme(p.theme, false);
    if (p.thinkTime !== undefined) el("thinkTime").value = p.thinkTime;
    if (p.stayTime !== undefined) el("stayTime").value = p.stayTime;
    if (p.speechRate !== undefined) el("speechRate").value = p.speechRate;
    if (typeof p.readZh === "boolean") el("readZhChk").checked = p.readZh;
    if (typeof p.readPhrases === "boolean") el("readPhrasesChk").checked = p.readPhrases;
    if (p.adminPwd) el("adminPwdInput").value = p.adminPwd;
  } catch (_) {}
  el("thinkTimeVal").textContent = `${parseFloat(el("thinkTime").value).toFixed(1)}s`;
  el("stayTimeVal").textContent = `${parseFloat(el("stayTime").value).toFixed(1)}s`;
  el("speechRateVal").textContent = `${parseFloat(el("speechRate").value).toFixed(2)}x`;
}

function applyTheme(themeVal, persist = true) {
  document.body.dataset.theme = themeVal;
  document.querySelectorAll(".theme-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.themeVal === themeVal);
  });
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute("content", themeVal === "day" ? "#f4f7fb" : "#000000");
  }
  if (persist) savePrefs();
}

function bindEvents() {
  el("openSettingsBtn").addEventListener("click", () => el("settingsDialog").showModal());
  el("openBooksBtn").addEventListener("click", () => {
    renderBookManageList();
    el("booksDialog").showModal();
  });
  el("openImportBtn").addEventListener("click", () => el("importDialog").showModal());
  el("fullscreenBtn").addEventListener("click", enterPureFullscreen);

  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => el(btn.dataset.close).close());
  });
  [el("settingsDialog"), el("booksDialog"), el("editorDialog"), el("importDialog")].forEach(dlg => {
    dlg.addEventListener("click", e => {
      if (e.target === dlg) dlg.close();
    });
  });

  el("bookSelect").addEventListener("change", e => selectBook(e.target.value));
  el("categorySelect").addEventListener("change", e => {
    stopAutoPlay();
    applyCategoryFilter(e.target.value);
  });

  // 全选 / 批量删除词库
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
          const file = id.replace(/^repo:/, "");
          const res = await fetch(`/api/book/${encodeURIComponent(file)}`, {
            method: "DELETE",
            headers: getAdminHeaders()
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `删除 ${file} 失败`);
          }
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

  // 打开编辑器与保存修改
  el("openEditorBtn").addEventListener("click", openBookEditor);

  el("applyBatchCategoryBtn").addEventListener("click", () => {
    const newCat = el("batchCategoryInput").value.trim();
    if (!newCat) return alert("请输入目标分类名称");
    state.editingItems.forEach(item => { item.category = newCat; });
    renderEditorItems();
  });

  el("addWordItemBtn").addEventListener("click", () => {
    const defaultCat = state.editingItems[0]?.category || "未分类";
    state.editingItems.unshift({
      category: defaultCat,
      word: "",
      phonetic: "",
      meaning: "",
      phrases: []
    });
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

  // 导入新词库（支持直接存本地或上传 GitHub）
  el("importFileInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!el("importBookName").value) {
      el("importBookName").value = file.name.replace(/\.[^.]+$/, "");
    }
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
        const newBook = {
          id: `local:${Date.now()}`,
          rawName,
          name: `[本地] ${rawName}`,
          source: "local",
          items
        };
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

  // 其余设置与播放控制
  el("adminPwdInput").addEventListener("input", savePrefs);
  el("foreignVoiceSelect").addEventListener("change", savePrefs);
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
    el("speechRateVal").textContent = `${parseFloat(e.target.value).toFixed(2)}x`;
    savePrefs();
  });

  el("readZhChk").addEventListener("change", savePrefs);
  el("readPhrasesChk").addEventListener("change", savePrefs);

  el("playPauseBtn").addEventListener("click", () => {
    state.isPlaying ? stopAutoPlay() : startAutoPlay();
  });
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

  el("vocabCard").addEventListener("click", () => {
    if (el("vocabCard").classList.contains("hide-meaning")) revealMeaningNow();
  });

  el("rotateBtn").addEventListener("click", toggleOrientation);
  el("fsRotateToggle").addEventListener("click", e => { e.stopPropagation(); toggleOrientation(); });
  el("fsExitBtn").addEventListener("click", e => { e.stopPropagation(); exitPureFullscreen(); });
  el("fsRevealBtn").addEventListener("click", e => { e.stopPropagation(); revealMeaningNow(); });
  el("fsPlayToggle").addEventListener("click", e => {
    e.stopPropagation();
    state.isPlaying ? stopAutoPlay() : startAutoPlay();
  });

  el("stage").addEventListener("click", () => {
    if (!document.body.classList.contains("pure-fullscreen")) return;
    const hud = el("fsHud");
    hud.classList.add("visible");
    clearTimeout(state.hudTimeout);
    state.hudTimeout = setTimeout(() => hud.classList.remove("visible"), 3000);
  });
}

init();
