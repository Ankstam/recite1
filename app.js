const STORAGE_LOCAL_BOOKS = "wf_local_books_v4";
const STORAGE_PREFS = "wf_prefs_v5";

// 全局唯一音频播放器与 MP3 缓存（确保手机端连续循环不卡死、重复词 0 延迟）
const audioPlayer = new Audio();
const ttsBlobCache = new Map();
const activeUtterances = new Set();

// 精选微软 Neural 高拟真发音人预设
const CURATED_FOREIGN_VOICES = [
  { id: "edge:en-US-JennyNeural", label: "微软 Jenny (美式女声·亲切默认)" },
  { id: "edge:en-US-AriaNeural", label: "微软 Aria (美式女声·播报清晰)" },
  { id: "edge:en-US-GuyNeural", label: "微软 Guy (美式男声·沉稳)" },
  { id: "edge:en-US-ChristopherNeural", label: "微软 Christopher (美式男声·睡前温和)" },
  { id: "edge:en-US-AnaNeural", label: "微软 Ana (美式少女音·清脆)" },
  { id: "edge:en-GB-SoniaNeural", label: "微软 Sonia (英式女声·标准伦敦音)" },
  { id: "edge:en-GB-RyanNeural", label: "微软 Ryan (英式男声·磁性英音)" },
  { id: "edge:ja-JP-NanamiNeural", label: "微软 七海 Nanami (日语女声)" },
  { id: "edge:ja-JP-KeitaNeural", label: "微软 圭太 Keita (日语男声)" }
];

const CURATED_ZH_VOICES = [
  { id: "edge:zh-CN-XiaoxiaoNeural", label: "微软 晓晓 (普通话女声·温暖默认)" },
  { id: "edge:zh-CN-XiaoyiNeural", label: "微软 晓伊 (普通话女声·睡前温柔)" },
  { id: "edge:zh-CN-YunxiNeural", label: "微软 云希 (普通话男声·阳光青年)" },
  { id: "edge:zh-CN-YunjianNeural", label: "微软 云健 (普通话男声·沉稳磁性)" },
  { id: "edge:zh-CN-XiaochenNeural", label: "微软 晓辰 (普通话女声·知性自然)" },
  { id: "edge:zh-HK-HiuMaanNeural", label: "微软 晓曼 (香港粤语女声)" }
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
  sysVoices: [],
  editingItems: []
};

const el = id => document.getElementById(id);

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
    token: el("ghTokenInput").value.trim()
  };
}

function getGhHeaders(requireToken = false) {
  const { token } = getRepoConfig();
  if (requireToken && !token) {
    throw new Error("请先点击左上角「齿轮设置」，粘贴你的 GitHub Token 密钥");
  }
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

// 1. 初始化
async function init() {
  await initVoices();
  restorePrefs();
  bindEvents();
  await reloadAllBooks();
}

// 2. 加载第三方微软云端人声 + 浏览器内置 Google/系统人声
async function initVoices() {
  const foreignSel = el("foreignVoiceSelect");
  const zhSel = el("zhVoiceSelect");

  const renderVoiceSelects = (extraCloudVoices = [], systemVoices = []) => {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFS) || "{}");
    const prevF = foreignSel.value || saved.foreignVoiceURI || "edge:en-US-JennyNeural";
    const prevZ = zhSel.value || saved.zhVoiceURI || "edge:zh-CN-XiaoxiaoNeural";

    foreignSel.innerHTML = "";
    zhSel.innerHTML = "";

    // 精选微软云端音源组
    const fGroupCloud = document.createElement("optgroup");
    fGroupCloud.label = "微软云端高清人声 (推荐)";
    CURATED_FOREIGN_VOICES.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label;
      fGroupCloud.appendChild(opt);
    });

    const curatedIds = new Set([...CURATED_FOREIGN_VOICES, ...CURATED_ZH_VOICES].map(v => v.id));
    extraCloudVoices.forEach(v => {
      const id = `edge:${v.ShortName}`;
      if (curatedIds.has(id)) return;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `微软 ${v.ShortName}`;
      if ((v.Locale || "").toLowerCase().startsWith("zh")) {
        // 归入中文
      } else if (/^(en|ja|ko|fr|de|es|ru)-/i.test(v.Locale || "")) {
        fGroupCloud.appendChild(opt);
      }
    });
    foreignSel.appendChild(fGroupCloud);

    const zGroupCloud = document.createElement("optgroup");
    zGroupCloud.label = "微软云端中文人声 (推荐)";
    CURATED_ZH_VOICES.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label;
      zGroupCloud.appendChild(opt);
    });
    extraCloudVoices.forEach(v => {
      const id = `edge:${v.ShortName}`;
      if (!curatedIds.has(id) && (v.Locale || "").toLowerCase().startsWith("zh")) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = `微软 ${v.ShortName}`;
        zGroupCloud.appendChild(opt);
      }
    });
    zhSel.appendChild(zGroupCloud);

    // 浏览器内置 Google / 本地引擎（离线备用）
    if (systemVoices.length > 0) {
      const fGroupSys = document.createElement("optgroup");
      fGroupSys.label = "浏览器内置 / Google 本地引擎";
      const zGroupSys = document.createElement("optgroup");
      zGroupSys.label = "浏览器内置 / Google 中文引擎";

      systemVoices.forEach(v => {
        const opt = document.createElement("option");
        opt.value = `sys:${v.voiceURI}`;
        opt.textContent = `${v.name} (${v.lang})`;
        if ((v.lang || "").toLowerCase().startsWith("zh")) {
          zGroupSys.appendChild(opt);
        } else {
          fGroupSys.appendChild(opt);
        }
      });

      if (fGroupSys.children.length > 0) foreignSel.appendChild(fGroupSys);
      if (zGroupSys.children.length > 0) zhSel.appendChild(zGroupSys);
    }

    foreignSel.value = prevF;
    if (!foreignSel.value) foreignSel.value = "edge:en-US-JennyNeural";
    zhSel.value = prevZ;
    if (!zhSel.value) zhSel.value = "edge:zh-CN-XiaoxiaoNeural";
  };

  renderVoiceSelects([], []);

  // 异步拉取云端完整语音列表与系统列表
  let cloudList = [];
  try {
    const res = await fetch("/api/voices");
    if (res.ok) cloudList = await res.json();
  } catch (_) {}

  if ("speechSynthesis" in window) {
    state.sysVoices = window.speechSynthesis.getVoices() || [];
    window.speechSynthesis.onvoiceschanged = () => {
      state.sysVoices = window.speechSynthesis.getVoices() || [];
      renderVoiceSelects(cloudList, state.sysVoices);
    };
  }
  renderVoiceSelects(cloudList, state.sysVoices);
}

// 3. GitHub 直连词库管理
async function reloadAllBooks(preferBookId = "") {
  const localBooks = getLocalBooks();
  let repoBooks = [];
  const { owner, repo, branch } = getRepoConfig();

  try {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/books?ref=${branch}`;
    const res = await fetch(api, { cache: "no-store", headers: getGhHeaders(false) });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        repoBooks = list
          .filter(f => f.name.endsWith(".json"))
          .map(f => ({
            id: `repo:${f.name}`,
            rawName: f.name.replace(/\.json$/i, ""),
            name: `[云端] ${f.name.replace(/\.json$/i, "")}`,
            source: "repo",
            file: f.name,
            items: null
          }));
      }
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

async function saveBookToGitHub(bookName, items, existingFileName = "") {
  const { owner, repo, branch } = getRepoConfig();
  const headers = getGhHeaders(true);
  const fileName = existingFileName || sanitizeFileName(bookName);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/books/${encodeURIComponent(fileName)}`;

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
      phrases: item.phrases.map(p => (p.zh ? `${p.foreign} | ${p.zh}` : p.foreign))
    }))
  };

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `${existingSha ? "Update" : "Create"} vocab book: ${fileName}`,
      content: utf8ToBase64(JSON.stringify(payload, null, 2)),
      branch,
      ...(existingSha ? { sha: existingSha } : {})
    })
  });

  const data = await putRes.json();
  if (!putRes.ok) throw new Error(`GitHub 保存失败：${data.message || putRes.status}`);
  return `repo:${fileName}`;
}

async function deleteBookFromGitHub(fileName) {
  const { owner, repo, branch } = getRepoConfig();
  const headers = getGhHeaders(true);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/books/${encodeURIComponent(fileName)}`;

  const checkRes = await fetch(`${apiUrl}?ref=${branch}`, { cache: "no-store", headers });
  if (!checkRes.ok) return;
  const meta = await checkRes.json();

  const delRes = await fetch(apiUrl, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Delete vocab book: ${fileName}`, sha: meta.sha, branch })
  });

  if (!delRes.ok) {
    const err = await delRes.json();
    throw new Error(`删除 ${fileName} 失败：${err.message || delRes.status}`);
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
    title.textContent = b.rawName || b.name.replace(/^\[(云端|本地)\]\s*/, "");

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
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/books/${encodeURIComponent(book.file)}?ref=${branch}`;
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

// 4. 极简导入解析器：支持制表符(\t) 或 竖线(|)
// 列顺序：单词 | 单词意思 | 音标 | 句子 | 句子意思 | 分类（空则无）
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

// 7. 第三方微软云端 TTS 核心（带缓存与系统离线自动回退）
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

function speakViaSystemTts(text, isChinese, rate) {
  return new Promise(resolve => {
    if (!("speechSynthesis" in window)) return resolve();
    let settled = false;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    utter.lang = isChinese ? "zh-CN" : (/[\u3040-\u30ff]/.test(text) ? "ja-JP" : "en-US");

    const selectedVal = isChinese ? el("zhVoiceSelect").value : el("foreignVoiceSelect").value;
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

async function speakText(text, isChinese = false) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return;

  const rate = parseFloat(el("speechRate").value) || 0.9;
  const selectedVal = isChinese ? el("zhVoiceSelect").value : el("foreignVoiceSelect").value;

  // 若用户主动选择了本地系统引擎，直接走系统发音
  if (selectedVal.startsWith("sys:")) {
    return speakViaSystemTts(cleanText, isChinese, rate);
  }

  // 解析微软云端发音人（检测到日语假名且当前为英语人声时自动切换日语七海人声）
  let voiceName = selectedVal.startsWith("edge:")
    ? selectedVal.slice(5)
    : (isChinese ? "zh-CN-XiaoxiaoNeural" : "en-US-JennyNeural");

  if (!isChinese && /[\u3040-\u30ff]/.test(cleanText) && !voiceName.startsWith("ja-JP")) {
    voiceName = "ja-JP-NanamiNeural";
  }

  const cacheKey = `${voiceName}|${rate.toFixed(1)}|${cleanText}`;

  try {
    let blobUrl = ttsBlobCache.get(cacheKey);
    if (!blobUrl) {
      const apiUrl = `/api/tts?voice=${encodeURIComponent(voiceName)}&rate=${rate.toFixed(1)}&text=${encodeURIComponent(cleanText)}`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error("Edge TTS 接口返回异常");
      const blob = await res.blob();
      blobUrl = URL.createObjectURL(blob);
      ttsBlobCache.set(cacheKey, blobUrl);
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(), 15000);

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
        reject(new Error("音频播放失败"));
      };
      audioPlayer.src = blobUrl;
      audioPlayer.play().catch(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (_) {
    // 断网或云端波动时自动降级到本地发音，保证背诵不中断
    await speakViaSystemTts(cleanText, isChinese, rate);
  }
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

  // 解锁移动端音频播放器上下文
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

    renderCard(thinkSec > 0);
    await Promise.all([waitMs(thinkSec * 1000), speakForeignSequence(item, token)]);
    if (!state.isPlaying || token !== state.playToken) break;

    revealMeaningNow();
    await Promise.all([waitMs(staySec * 1000), speakChineseSequence(item, token)]);
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
    readZh: el("readZhChk").checked,
    readPhrases: el("readPhrasesChk").checked,
    foreignVoiceURI: el("foreignVoiceSelect").value,
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
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  });

  // 样本一键复制与填入
  el("copySampleBtn").addEventListener("click", async () => {
    const sampleText = el("sampleTemplateBox").textContent.trim();
    try {
      await navigator.clipboard.writeText(sampleText);
      el("copySampleBtn").textContent = "已复制样本 ✓";
      setTimeout(() => { el("copySampleBtn").textContent = "复制格式样本"; }, 2000);
    } catch (_) {
      el("importTextArea").value = sampleText;
      alert("当前环境不支持直接写入剪贴板，已直接为你填入下方输入框");
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
  el("ghTokenInput").addEventListener("input", savePrefs);
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
    el("speechRateVal").textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
    savePrefs();
  });

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
