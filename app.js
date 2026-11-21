const STORAGE_LOCAL_BOOKS = "wf_local_books_v2";
const STORAGE_PREFS = "wf_prefs_v2";

// 全局持有正在朗读的 Utterance，防止移动端浏览器垃圾回收导致 onend 丢失卡死
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
  voices: []
};

const el = id => document.getElementById(id);

// 1. 初始化
async function init() {
  initVoices();
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
        items: null
      }));
    }
  } catch (_) {}

  state.books = [...repoBooks, ...localBooks];
  renderBookOptions();

  if (state.books.length > 0) {
    await selectBook(state.books[0].id);
  }
}

// 2. 多人声加载与分类（外文人声 / 中文人声）
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

      if (langLow.startsWith("zh") || langLow.includes("cmn")) {
        const opt = document.createElement("option");
        opt.value = v.voiceURI;
        opt.textContent = label;
        zhSel.appendChild(opt);
      } else {
        const opt = document.createElement("option");
        opt.value = v.voiceURI;
        opt.textContent = label;
        foreignSel.appendChild(opt);
      }
    });

    if (saved.foreignVoiceURI) foreignSel.value = saved.foreignVoiceURI;
    if (saved.zhVoiceURI) zhSel.value = saved.zhVoiceURI;
  };

  load();
  window.speechSynthesis.onvoiceschanged = load;
  // 兼容部分安卓浏览器延迟加载人声列表
  setTimeout(load, 400);
  setTimeout(load, 1200);
}

// 3. 词库管理
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
    select.innerHTML = `<option value="">暂无词库（点击右上角导入）</option>`;
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

// 拆分双语短语/例句：返回 { foreign, zh }
function splitBilingualLine(raw) {
  const text = String(raw || "").trim();
  if (!text) return { foreign: "", zh: "" };

  // 优先支持显式竖线分隔："pure serendipity | 纯属机缘巧合"
  if (text.includes("|")) {
    const [f, ...rest] = text.split("|");
    return { foreign: f.trim(), zh: rest.join("|").trim() };
  }

  // 匹配尾部连续中文解释部分（兼容日语假名+汉字在前的句子）
  const match = text.match(/^(.+?)\s+([\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef，。！？；：、（）\s]+)$/);
  if (match) {
    return { foreign: match[1].trim(), zh: match[2].trim() };
  }

  // 若整句均为中文
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

    // 若 JSON 中包含 example / exampleMeaning 字段，也一并加入展示与朗读
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

// 5. 高可靠 TTS 朗读核心（防 GC 回收 + 超时看门狗 + 多人声支持）
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

    // 绑定指定人声或自动语言
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

    // 防止安卓 WebView 自动暂停或丢失 onend 回调
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

// 朗读外文部分（单词 + 外文词组/例句）
async function speakForeignSequence(item, token) {
  if (!item || token !== state.playToken) return;
  await speakText(item.word, false);
  if (token !== state.playToken) return;

  if (el("readPhrasesChk").checked && item.phrases.length > 0) {
    for (const p of item.phrases) {
      if (token !== state.playToken) return;
      if (p.foreign) {
        await speakText(p.foreign, false);
      }
    }
  }
}

// 朗读中文部分（单词释义 + 词组/例句中文意思）
async function speakChineseSequence(item, token) {
  if (!item || token !== state.playToken || !el("readZhChk").checked) return;

  if (item.meaning) {
    // 去掉词性缩写如 n. / adj. / v. 让中文朗读更自然
    const cleanMeaning = item.meaning.replace(/\b(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int)\.\s*/gi, "");
    await speakText(cleanMeaning, true);
  }
  if (token !== state.playToken) return;

  if (el("readPhrasesChk").checked && item.phrases.length > 0) {
    for (const p of item.phrases) {
      if (token !== state.playToken) return;
      if (p.zh) {
        await speakText(p.zh, true);
      }
    }
  }
}

// 6. 自动播放主循环（思考阶段 -> 揭示意思阶段 -> 自动跳下一个）
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

    // 阶段一：若设置了思考时间，先仅展示原文并朗读外文
    renderCard(thinkSec > 0);
    await Promise.all([
      waitMs(thinkSec * 1000),
      speakForeignSequence(item, token)
    ]);
    if (!state.isPlaying || token !== state.playToken) break;

    // 阶段二：在原文下方揭示中文意思，朗读中文并停留设定时长
    revealMeaningNow();
    await Promise.all([
      waitMs(staySec * 1000),
      speakChineseSequence(item, token)
    ]);
    if (!state.isPlaying || token !== state.playToken) break;

    // 自动跳到下一个单词
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

// 单次朗读（立即显示完整意思并顺序朗读外文+中文）
async function triggerSingleSpeak() {
  if (state.filteredItems.length === 0) return;
  if (state.isPlaying) {
    stopAutoPlay();
  }
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

// 8. 纯净全屏与横竖屏切换
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
    zhVoiceURI: el("zhVoiceSelect").value
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
  el("bookSelect").addEventListener("change", e => selectBook(e.target.value));
  el("categorySelect").addEventListener("change", e => {
    stopAutoPlay();
    applyCategoryFilter(e.target.value);
  });

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
    if (state.isPlaying) {
      stopAutoPlay();
      startAutoPlay();
    } else {
      renderCard(false);
    }
  });

  el("nextBtn").addEventListener("click", () => {
    if (!state.filteredItems.length) return;
    state.index = (state.index + 1) % state.filteredItems.length;
    if (state.isPlaying) {
      stopAutoPlay();
      startAutoPlay();
    } else {
      renderCard(false);
    }
  });

  // 思考阶段轻触卡片可提前显示释义
  el("vocabCard").addEventListener("click", () => {
    if (el("vocabCard").classList.contains("hide-meaning")) {
      revealMeaningNow();
    }
  });

  el("rotateBtn").addEventListener("click", toggleOrientation);
  el("fsRotateToggle").addEventListener("click", e => { e.stopPropagation(); toggleOrientation(); });
  el("fullscreenBtn").addEventListener("click", enterPureFullscreen);
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
    } catch (_) {
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
