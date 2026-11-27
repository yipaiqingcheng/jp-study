/* 日本語 学習帖 · app.js
 * 三个模块：单词（艾宾浩斯复习）、语法（用户添加·自评状态）、听力（播放器+逐句解析）
 * 数据来自 window.JP_WORDS / window.JP_GRAMMAR / window.JP_LISTENING
 */
(function () {
  "use strict";

  var WORDS = window.JP_WORDS || [];
  var GRAMMAR = window.JP_GRAMMAR || [];
  var LISTENING = window.JP_LISTENING || [];

  var INTERVALS = [0, 1, 2, 4, 7, 15, 30, 60]; // 艾宾浩斯复习间隔（天）
  var DAILY_NEW = 20;
  var DAILY_REVIEW_MAX = 40;
  var K_PROGRESS = "jp_progress_v1";
  var K_DAILY = "jp_daily_v1";
  var K_STREAK = "jp_streak_v1";
  var K_GRAMMAR = "jp_grammar_state";
  var K_THEME = "jp_theme_v3";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayStr(d) {
    var x = d || new Date();
    return x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  }
  function addDays(dateStr, n) {
    var p = dateStr.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* =========================================================
   * 朗读（点读）：Web Speech API，优先日语音色
   * ======================================================= */
  var jaVoice = null;
  var currentWord = null;
  var voiceCount = 0;
  function refreshVoices() {
    if (!window.speechSynthesis) return;
    var vs = window.speechSynthesis.getVoices() || [];
    voiceCount = vs.length;
    jaVoice = null;
    var fallback = null;
    for (var i = 0; i < vs.length; i++) {
      if (/^ja[-_]?JP/i.test(vs[i].lang)) { jaVoice = vs[i]; break; }
      if (!fallback && /^ja/i.test(vs[i].lang)) fallback = vs[i];
    }
    if (!jaVoice) jaVoice = fallback;
  }
  if (window.speechSynthesis) {
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
  }

  var clipAudio = null;
  function savedVolume() {
    var v = parseFloat(localStorage.getItem(K_VOLUME));
    return v >= 0 && v <= 1 ? v : 1;
  }
  function applyVolume(el, v) {
    el.volume = v;
    if (v > 0) lastVolume = v;
  }
  function syncMuteBtn(btn, v) {
    if (!btn) return;
    btn.textContent = v > 0 ? VOL_ON : VOL_OFF;
    btn.classList.toggle("muted", v <= 0);
  }

  function playClip(url, btn, fallbackText) {
    if (!clipAudio) {
      clipAudio = document.createElement("audio");
      clipAudio.preload = "auto";
      document.body.appendChild(clipAudio);
    }
    try { clipAudio.pause(); } catch (e) {}
    clipAudio.src = url;
    clipAudio.volume = savedVolume();
    var done = function () { if (btn) btn.classList.remove("on"); };
    clipAudio.onended = done;
    clipAudio.onerror = function () { done(); speak(fallbackText, btn); };
    if (btn) btn.classList.add("on");
    var p = clipAudio.play();
    if (p && p.catch) p.catch(function () { done(); speak(fallbackText, btn); });
  }

  function speak(text, btn) {
    if (!text) return;
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      toast("这个浏览器不支持朗读，换个浏览器试试");
      return;
    }
    if (!jaVoice) refreshVoices();
    // 有语音列表但没有日语语音：不要用系统默认（会读成中文），直接告诉用户怎么装
    if (!jaVoice && voiceCount > 0) {
      toast("设备里没有日语语音包，现在读会变成中文。请在系统设置里安装「日语」语音数据，或用 Chrome / Safari 打开。");
      if (btn) btn.classList.remove("on");
      return;
    }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.rate = 0.92;
      u.pitch = 1;
      if (jaVoice) u.voice = jaVoice;
      if (btn) {
        btn.classList.add("on");
        u.onend = function () { btn.classList.remove("on"); };
        u.onerror = function () { btn.classList.remove("on"); };
      }
      window.speechSynthesis.speak(u);
    } catch (err) {
      if (btn) btn.classList.remove("on");
      toast("朗读失败：" + (err && err.message ? err.message : "未知错误"));
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1900);
  }

  /* =========================================================
   * 主题 & 标签页
   * ======================================================= */
  function initTheme() {
    var saved = localStorage.getItem(K_THEME) || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    var btn = $("#themeBtn");
    if (btn) btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", cur);
      localStorage.setItem(K_THEME, cur);
      btn.textContent = cur === "dark" ? "☾" : "☀";
      if (cur === "dark") btn.textContent = "☀";
      else btn.textContent = "☾";
    });
    if (btn) btn.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "☀" : "☾";
  }

  function activateTab(id) {
    var tabs = $$(".tab");
    var found = false;
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-view") === id;
      if (on) found = true;
      t.classList.toggle("active", on);
    });
    if (!found) return;
    $$(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + id); });
    if (id === "words") renderWordStats();
    if (id === "grammar") renderGrammar();
    if (id === "listening") renderListenList();
  }

  function initTabs() {
    var tabs = $$(".tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var id = tab.getAttribute("data-view");
        activateTab(id);
        try { history.replaceState(null, "", "#" + id); } catch (e) { }
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    var hash = (location.hash || "").replace("#", "");
    if (hash) activateTab(hash);
    window.addEventListener("hashchange", function () {
      var h = (location.hash || "").replace("#", "");
      if (h) activateTab(h);
    });
  }

  /* =========================================================
   * 模块一：单词 · 艾宾浩斯
   * ======================================================= */
  var progress = {};      // id -> {stage, next, learned, last}
  var daily = {};         // {date, newCount, reviewed}
  var streak = {};        // {last, days}
  var queue = [];         // [{id, isNew}]
  var qIndex = 0;
  var flipped = false;

  function initStore() {
    progress = load(K_PROGRESS, {});
    daily = load(K_DAILY, {});
    streak = load(K_STREAK, {});
    if (daily.date !== todayStr()) {
      daily = { date: todayStr(), newCount: 0, reviewed: 0 };
      save(K_DAILY, daily);
    }
  }

  function bumpStreak() {
    var t = todayStr();
    if (streak.last === t) return;
    if (streak.last === addDays(t, -1)) streak.days = (streak.days || 0) + 1;
    else streak.days = 1;
    streak.last = t;
    save(K_STREAK, streak);
  }

  function dueWords() {
    var t = todayStr();
    return WORDS.filter(function (w) { return progress[w.id] && progress[w.id].next <= t; })
      .sort(function (a, b) { return progress[a.id].next < progress[b.id].next ? -1 : 1; });
  }

  function newWords(limit) {
    var out = [];
    for (var i = 0; i < WORDS.length && out.length < limit; i++) {
      if (!progress[WORDS[i].id]) out.push(WORDS[i]);
    }
    return out;
  }

  function buildQueue(extraNew) {
    var due = dueWords().slice(0, DAILY_REVIEW_MAX);
    var quota = Math.max(0, DAILY_NEW - (daily.newCount || 0)) + (extraNew || 0);
    var fresh = newWords(quota);
    // 交错：两张复习里夹一张新词
    var q = [], di = 0, ni = 0;
    while (di < due.length || ni < fresh.length) {
      if (di < due.length) q.push({ id: due[di++].id, isNew: false });
      if (di < due.length) q.push({ id: due[di++].id, isNew: false });
      if (ni < fresh.length) q.push({ id: fresh[ni++].id, isNew: true });
    }
    queue = q;
    qIndex = 0;
  }

  function wordById(id) {
    for (var i = 0; i < WORDS.length; i++) if (WORDS[i].id === id) return WORDS[i];
    return null;
  }

  function renderWordStats() {
    var t = todayStr();
    var due = dueWords().length;
    var mastered = 0, learning = 0;
    WORDS.forEach(function (w) {
      var p = progress[w.id];
      if (!p) return;
      if (p.stage >= 4) mastered++;
      else learning++;
    });
    var todayDone = (daily.newCount || 0) + (daily.reviewed || 0);
    var map = {
      "statDue": due,
      "statToday": todayDone,
      "statMastered": mastered,
      "statDays": streak.days || 0
    };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = map[id];
    });
    var sub = $("#statTotal");
    if (sub) sub.textContent = "/ 共 " + WORDS.length + " 词 · 学习中 " + learning;
    var today = $("#todayLabel");
    if (today) today.textContent = "今天 " + t;
    setText("hudStreak", streak.days || 0);
    setText("hudWords", WORDS.length);
    setText("wordCount", WORDS.length);
  }

  function renderCard() {
    var stage = $("#cardStage");
    var emptyBox = $("#wordEmpty");
    if (!stage || !emptyBox) return;

    if (!queue.length || qIndex >= queue.length) {
      stage.style.display = "none";
      emptyBox.style.display = "block";
      var ctr = $("#studyControls");
      if (ctr) ctr.style.display = "none";
      var done = (daily.newCount || 0) + (daily.reviewed || 0);
      $("#emptyTitle").textContent = done > 0 ? "今日已打卡 " + done + " 词" : "今天还没有学习记录";
      $("#emptySub").textContent = dueWords().length
        ? "还有 " + dueWords().length + " 个词待复习，点下面的按钮继续。"
        : "复习都完成了。想多背的话，可以再取 " + Math.ceil(DAILY_NEW / 2) + " 个新词。";
      renderQueueDots();
      renderWordTable();
      renderWordStats();
      return;
    }
    stage.style.display = "block";
    emptyBox.style.display = "none";
    var ctr2 = $("#studyControls");
    if (ctr2) ctr2.style.display = "block";

    var cur = queue[qIndex];
    var w = wordById(cur.id);
    if (!w) { qIndex++; renderCard(); return; }

    var p = progress[w.id];
    flipped = false;
    var fc = $("#flashcard");
    fc.classList.remove("flipped");

    $("#cLevel").innerHTML = '<span class="chip ' + (w.level === "N2" ? "n2" : "n3") + '">' + esc(w.level) + "</span>" +
      (cur.isNew ? '<span class="chip done">新词</span>' : '<span class="chip">复习 · 第 ' + ((p && p.stage) || 1) + " 阶</span>");
    $("#wordMain").textContent = w.word;
    $("#wordKana").textContent = w.kana;
    $("#cCorner").textContent = cur.isNew ? "新" : "復";

    // 背面
    $("#backWord").textContent = w.word;
    $("#backKana").textContent = w.kana;
    currentWord = w;
    $("#backPos").textContent = w.pos || "";
    $("#meaning").textContent = w.meaning || "";
    $("#meaningEn").textContent = w.meaningEn || "";
    var ipaEl = $("#meaningIpa");
    if (ipaEl) ipaEl.textContent = w.ipaEn ? " " + w.ipaEn : "";
    var exBox = $("#exBox");
    if (w.example) {
      exBox.style.display = "block";
      $("#exJp").textContent = w.example;
      $("#exKana").textContent = w.exampleKana || "";
      $("#exZh").textContent = w.exampleZh || "";
      $("#exEn").textContent = w.exampleEn || "";
    } else {
      exBox.style.display = "none";
    }
    var nextNote = $("#nextNote");
    if (p) {
      nextNote.textContent = "上次复习 " + p.last + " · 当前第 " + p.stage + " 阶（间隔 " +
        (INTERVALS[Math.min(p.stage, 7)] || 0) + " 天）";
    } else {
      nextNote.textContent = "第一次见到这个词。评价后按艾宾浩斯间隔安排下次复习。";
    }

    // 进度
    var total = queue.length;
    var pos = qIndex + 1;
    $("#queueLabel").textContent = "本轮 " + pos + " / " + total;
    var bar = $("#progressBar");
    if (bar) bar.style.width = Math.round((qIndex / total) * 100) + "%";
    renderQueueDots();
    renderWordTable();
    renderWordStats();
  }

  function renderQueueDots() {
    var box = $("#queueDots");
    if (!box) return;
    box.innerHTML = queue.map(function (item, i) {
      var cls = "queue-dot" + (item.isNew ? " new" : "") + (i < qIndex ? " done" : "") + (i === qIndex ? " now" : "");
      return '<i class="' + cls + '"></i>';
    }).join("");
  }

  function renderWordTable() {
    var body = $("#wordTableBody");
    if (!body) return;
    body.innerHTML = WORDS.map(function (w) {
      var p = progress[w.id];
      var st = p ? p.stage : 0;
      var dots = "";
      for (var i = 0; i < 7; i++) dots += '<i class="' + (i < st ? "on" : "") + '"></i>';
      return "<tr>" +
        '<td class="w">' + esc(w.word) + '<br><span class="w-kana">' + esc(w.kana) + "</span></td>" +
        '<td><span class="chip ' + (w.level === "N2" ? "n2" : "n3") + '">' + esc(w.level) + "</span></td>" +
        "<td>" + esc(w.meaning) + "</td>" +
        '<td><span class="stage-dots">' + dots + "</span></td>" +
        '<td style="font-size:12px;color:var(--ink-3)">' + (p ? "间隔 " + (INTERVALS[Math.min(st, 7)] || 0) + " 天<br>下次 " + esc(p.next) : "未学") + "</td>" +
        "</tr>";
    }).join("");
  }

  function rate(kind) {
    if (!queue.length || qIndex >= queue.length) return;
    var cur = queue[qIndex];
    var id = cur.id;
    var t = todayStr();
    var p = progress[id];
    var isNew = !p;

    if (isNew) {
      p = { stage: 1, next: addDays(t, INTERVALS[1]), learned: t, last: t };
      daily.newCount = (daily.newCount || 0) + 1;
      // 新词也尊重评价：认识直接进第 2 阶
      if (kind === "know") { p.stage = 2; p.next = addDays(t, INTERVALS[2]); }
    } else {
      if (kind === "know") {
        p.stage = Math.min(7, (p.stage || 1) + 1);
        p.next = addDays(t, INTERVALS[p.stage] || 60);
      } else if (kind === "fuzzy") {
        p.next = addDays(t, 1);
      } else {
        p.stage = Math.max(1, (p.stage || 1) - 1);
        p.next = addDays(t, 1);
      }
      p.last = t;
      daily.reviewed = (daily.reviewed || 0) + 1;
    }
    progress[id] = p;
    save(K_PROGRESS, progress);
    save(K_DAILY, daily);
    bumpStreak();

    qIndex++;
    var msgs = { know: "记住了，间隔拉长 →", fuzzy: "有点模糊，明天再见 →", forget: "忘记了，回到短间隔 →" };
    toast(msgs[kind] || "已记录");
    renderCard();
  }

  function flipCard() {
    var fc = $("#flashcard");
    if (!fc) return;
    flipped = !flipped;
    fc.classList.toggle("flipped", flipped);
  }

  function initWords() {
    initStore();
    buildQueue(0);
    renderCard();

    var fc = $("#flashcard");
    if (fc) fc.addEventListener("click", function (e) {
      if (e.target.closest(".rate")) return;
      flipCard();
    });
    $$(".rate").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        rate(b.getAttribute("data-kind"));
      });
    });
    var more = $("#moreNewBtn");
    if (more) more.addEventListener("click", function () {
      var extra = newWords(Math.ceil(DAILY_NEW / 2));
      if (!extra.length) { toast("词库里的词都学过了 🎉"); return; }
      extra.forEach(function (w) { queue.push({ id: w.id, isNew: true }); });
      toast("又加了 " + extra.length + " 个新词");
      renderCard();
    });
    var speakBtn = $("#exSpeak");
    var wordSpeakBtn = $("#wordSpeak");
    if (wordSpeakBtn) {
      wordSpeakBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (currentWord) playClip("audio/word/" + currentWord.id + ".mp3", wordSpeakBtn, currentWord.word);
      });
    }
    if (speakBtn) {
      speakBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (currentWord) playClip("audio/example/" + currentWord.id + ".mp3", speakBtn, currentWord.example || currentWord.word);
      });
    }
    var again = $("#resetQueueBtn");
    if (again) again.addEventListener("click", function () {
      buildQueue(0);
      renderCard();
      toast("已按到期顺序重排");
    });

    // 键盘：空格翻面，1/2/3 评级
    document.addEventListener("keydown", function (e) {
      var wordsView = $("#view-words");
      if (!wordsView || !wordsView.classList.contains("active")) return;
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); flipCard(); }
      if (e.key === "1") rate("forget");
      if (e.key === "2") rate("fuzzy");
      if (e.key === "3") rate("know");
    });

    renderMemoryChart();
  }

  function renderMemoryChart() {
    var box = $("#memoryChart");
    if (!box) return;
    var W = 430, H = 250, padL = 34, padR = 16, padT = 20, padB = 32;
    var maxDay = 60;
    var x = function (d) {
      return padL + (Math.log(1 + Math.min(d, maxDay)) / Math.log(1 + maxDay)) * (W - padL - padR);
    };
    var y = function (r) { return padT + (1 - r) * (H - padT - padB); };

    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" class="memory-chart" role="img" aria-label="艾宾浩斯遗忘曲线">';
    for (var i = 0; i <= 4; i++) {
      var yy = padT + (i / 4) * (H - padT - padB);
      svg += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="var(--line)" stroke-width="1" opacity=".65"/>';
      svg += '<text x="' + (padL - 8) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="9.5" fill="var(--ink-3)">' + ((1 - i / 4) * 100) + "%</text>";
    }

    // 理论遗忘：不复习
    var d = "M" + x(0).toFixed(1) + "," + y(1).toFixed(1);
    for (var day = 0.5; day <= maxDay; day += 0.5) {
      var keep = Math.exp(-day / 2.4);
      d += "L" + x(day).toFixed(1) + "," + y(keep).toFixed(1);
    }
    svg += '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="5 4" opacity=".5"/>';

    // 按间隔复习：每次复习后回到高位，再缓慢衰减
    var path = "M" + x(INTERVALS[0]).toFixed(1) + "," + y(0.96).toFixed(1);
    var lows = [0.2, 0.28, 0.36, 0.44, 0.52, 0.58, 0.63, 0.66];
    for (var k = 0; k < INTERVALS.length; k++) {
      var s = INTERVALS[k];
      var e = k + 1 < INTERVALS.length ? INTERVALS[k + 1] : maxDay;
      var dx = x(e) - x(s);
      var yEnd = y(lows[k]);
      path += "C" + (x(s) + dx * 0.28).toFixed(1) + "," + y(0.72).toFixed(1) +
        " " + (x(s) + dx * 0.62).toFixed(1) + "," + (yEnd + 4).toFixed(1) +
        " " + x(e).toFixed(1) + "," + yEnd.toFixed(1);
      if (k + 1 < INTERVALS.length) {
        path += "L" + x(e).toFixed(1) + "," + y(0.96).toFixed(1);
      }
    }
    svg += '<path d="' + path + '" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linejoin="round"/>';

    INTERVALS.forEach(function (day, idx) {
      svg += '<circle cx="' + x(day).toFixed(1) + '" cy="' + y(0.96).toFixed(1) + '" r="3.6" fill="var(--green)" stroke="var(--paper-2)" stroke-width="1.5"/>';
      svg += '<text x="' + x(day).toFixed(1) + '" y="' + (H - 14) + '" text-anchor="middle" font-size="9.5" fill="var(--ink-3)">' + (idx === 0 ? "0" : day) + "</text>";
      svg += '<line x1="' + x(day).toFixed(1) + '" y1="' + (padT + 4) + '" x2="' + x(day).toFixed(1) + '" y2="' + (H - padB) + '" stroke="var(--green)" stroke-dasharray="2 4" opacity=".28"/>';
    });
    svg += "</svg>";
    box.innerHTML = svg;
  }

  /* =========================================================
   * 模块二：语法
   * ======================================================= */
  var gState = {};
  var gFilter = "all";
  var gSearch = "";

  function initGrammar() {
    gState = load(K_GRAMMAR, {});
    var search = $("#gSearch");
    if (search) search.addEventListener("input", function () {
      gSearch = search.value.trim().toLowerCase();
      renderGrammar();
    });
    $$("#gFilter button").forEach(function (b) {
      b.addEventListener("click", function () {
        gFilter = b.getAttribute("data-f");
        $$("#gFilter button").forEach(function (x) { x.classList.toggle("on", x === b); });
        renderGrammar();
      });
    });
  }

  function gStateOf(id) { return gState[id] || ""; }

  function renderGrammar() {
    var grid = $("#gGrid");
    if (!grid) return;
    var list = GRAMMAR.filter(function (g) {
      var st = gStateOf(g.id);
      if (gFilter === "learning" && st !== "learning") return false;
      if (gFilter === "mastered" && st !== "mastered") return false;
      if (gFilter === "review" && st !== "review") return false;
      if (gFilter === "n2" && g.level !== "N2") return false;
      if (gFilter === "n3" && g.level !== "N3") return false;
      if (gSearch) {
        var hay = (g.pattern + " " + g.meaning + " " + g.connect + " " + (g.tags || []).join(" ") + " " + g.note).toLowerCase();
        if (hay.indexOf(gSearch) === -1) return false;
      }
      return true;
    });

    var mastered = 0, learning = 0, review = 0;
    GRAMMAR.forEach(function (g) {
      var st = gStateOf(g.id);
      if (st === "mastered") mastered++;
      else if (st === "learning") learning++;
      else if (st === "review") review++;
    });
    setText("gTotal", GRAMMAR.length);
    setText("gLearning", learning);
    setText("gMastered", mastered);
    setText("gReview", review);

    if (!list.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">' +
        '<div class="big">没有匹配的语法</div><div>换个筛选条件，或者把你的新语法发给 AI，让它加进来。</div></div>';
      return;
    }

    grid.innerHTML = list.map(function (g, gi) {
      var st = gStateOf(g.id);
      var cls = "g-card" + (st === "mastered" ? " mastered" : st === "learning" ? " learning" : "");
      var ex = (g.examples || []).map(function (e) {
        return '<div class="jp">' + esc(e.jp) + "</div>" +
          (e.kana ? '<div class="kana">' + esc(e.kana) + "</div>" : "") +
          (e.zh ? '<div class="zh">' + esc(e.zh) + "</div>" : "");
      }).join("");
      return '<article class="' + cls + '" data-id="' + esc(g.id) + '">' +
        '<div class="g-idx">' + pad(gi + 1) + "</div>" +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' +
        '<span class="chip ' + (g.level === "N2" ? "n2" : "n3") + '">' + esc(g.level || "") + "</span>" +
        (st ? '<span class="chip done">' + (st === "mastered" ? "已掌握" : st === "learning" ? "学习中" : "需复习") + "</span>" : "") +
        '<span style="margin-left:auto;font-size:11.5px;color:var(--ink-3)">' + esc(g.source || "") + "</span></div>" +
        '<div class="g-pattern">' + esc(g.pattern) + "</div>" +
        '<div class="g-connect">接续：' + esc(g.connect || "—") + "</div>" +
        '<div class="g-meaning">' + esc(g.meaning) + "</div>" +
        '<div class="g-ex">' + ex + (g.note ? '<div class="g-note">▸ ' + esc(g.note) + "</div>" : "") + "</div>" +
        '<div class="g-foot">' +
        '<button class="state-btn' + (st === "review" ? " on" : "") + '" data-st="review">需复习</button>' +
        '<button class="state-btn' + (st === "learning" ? " on" : "") + '" data-st="learning">学习中</button>' +
        '<button class="state-btn' + (st === "mastered" ? " on" : "") + '" data-st="mastered">已掌握</button>' +
        '<span class="spacer"></span><span class="g-foot-hint">点击卡片看例句</span>' +
        "</div></article>";
    }).join("");

    $$(".g-card", grid).forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (e.target.closest(".state-btn")) return;
        card.classList.toggle("open");
      });
    });
    $$(".state-btn", grid).forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var card = b.closest(".g-card");
        var id = card.getAttribute("data-id");
        var st = b.getAttribute("data-st");
        if (gState[id] === st) delete gState[id];
        else gState[id] = st;
        save(K_GRAMMAR, gState);
        renderGrammar();
        toast(gState[id] ? "已标记为「" + ({ mastered: "已掌握", learning: "学习中", review: "需复习" })[gState[id]] + "」" : "已取消标记");
      });
    });
  }

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  /* =========================================================
   * 模块三：听力
   * ======================================================= */
  var curListen = null;
  var audio = null;
  var loopRange = null;   // {start, end, on}
  var sentOffsets = [];   // [{start, end}] 按字符比例估算

  function renderListenList() {
    var box = $("#listenList");
    if (!box) return;
    box.innerHTML = LISTENING.map(function (l, idx) {
      var bars = "";
      for (var i = 0; i < 24; i++) {
        var h = 18 + Math.round(Math.abs(Math.sin((i + 1) * 0.72 + idx)) * 78);
        bars += '<i style="height:' + h + '%;animation-delay:' + (i * 0.055).toFixed(2) + 's"></i>';
      }
      return '<article class="listen-card" data-id="' + esc(l.id) + '">' +
        '<div class="lc-no">' + pad(idx + 1) + "</div>" +
        "<div>" +
        "<h3>" + esc(l.title) + "</h3>" +
        '<div class="jp-title">' + esc(l.titleJp) + "</div>" +
        '<div class="meta"><span class="chip">' + esc(l.level) + "</span>" +
        '<span class="chip">' + (l.sentences || []).length + " 句</span>" +
        '<span class="chip">' + esc(l.source) + "</span></div>" +
        "</div>" +
        '<div class="lc-wave">' + bars + "</div>" +
        '<div class="lc-go"><span>精聴</span><b>▶</b></div>' +
        "</article>";
    }).join("");

    $$(".listen-card", box).forEach(function (c) {
      c.addEventListener("click", function () { openListen(c.getAttribute("data-id")); });
    });
  }

  var VOL_ON = "\uD83D\uDD0A";
  var VOL_OFF = "\uD83D\uDD07";
  var K_VOLUME = "jp_volume_v1";
  var lastVolume = 1;
  var curSent = -1, scrollHoldUntil = 0;

  function openListen(id) {
    var l = null;
    LISTENING.forEach(function (x) { if (x.id === id) l = x; });
    if (!l) return;
    curListen = l;
    loopRange = null;
    $("#listenListWrap").style.display = "none";
    $("#listenDetail").style.display = "block";
    window.scrollTo({ top: 0, behavior: "smooth" });

    $("#detailTitle").textContent = l.title;
    $("#detailJp").textContent = l.titleJp;
    curSent = -1;
    scrollHoldUntil = 0;
    $("#detailChips").innerHTML = '<span class="chip">' + esc(l.level) + "</span>" +
      '<span class="chip">' + esc(l.source) + "</span>" +
      (l.url ? '<a class="chip" href="' + esc(l.url) + '" target="_blank" rel="noopener">原文链接 ↗</a>' : "");

    // 播放器
    var player = $("#player");
    player.innerHTML =
      '<button class="play-btn" id="playBtn">▶</button>' +
      '<div class="time" id="timeLabel">00:00 / 00:00</div>' +
      '<div class="seek" id="seekBar"><i></i></div>' +
      '<select class="rate-sel" id="rateSel">' +
      '<option value="0.75">0.75×</option><option value="1" selected>1.0×</option>' +
      '<option value="1.25">1.25×</option><option value="1.5">1.5×</option></select>' +
      '<button class="mini" id="loopBtn" title="循环当前句">↻</button>' +
      '<div class="vol" id="volBox">' +
      '<button class="mini vol-btn" id="muteBtn" title="静音 / 恢复">' + VOL_ON + "</button>" +
      '<input class="vol-range" id="volRange" type="range" min="0" max="100" step="1" value="100" aria-label="音量">' +
      "</div>";

    // 句子
    var totalChars = 0;
    sentOffsets = (l.sentences || []).map(function (s) {
      var len = (s.jp || "").length;
      var o = { start: totalChars, end: totalChars + len };
      totalChars += len;
      return o;
    });

    var list = $("#sentList");
    list.innerHTML = (l.sentences || []).map(function (s, i) {
      var rules = (s.grammar || []).map(function (g) {
        return '<div class="g-rule"><div class="p">' + esc(g.p) + '</div><div class="e">' + esc(g.e) + "</div></div>";
      }).join("");
      return '<div class="sent" data-i="' + i + '">' +
        '<div class="sent-head">' +
        '<span class="sent-no">' + pad(i + 1) + "</span>" +
        '<div class="sent-jp">' + (s.ruby || esc(s.jp)) + "</div>" +
        '<div class="sent-actions">' +
        '<button class="mini" data-act="play" title="播放这句">▶</button>' +
        '<button class="mini" data-act="grammar" title="语法解析">文</button>' +
        "</div></div>" +
        '<div class="sent-kana">' + esc(s.kana || "") + "</div>" +
        '<div class="sent-zh">' + esc(s.zh || "") + "</div>" +
        '<div class="sent-grammar">' + (rules || '<div class="g-rule"><div class="e">本句无特别语法标注。</div></div>') + "</div>" +
        "</div>";
    }).join("");

    // 汇总
    $("#listenSummary").innerHTML =
      '<div class="panel"><h3 style="margin:0 0 4px;font-family:var(--serif);font-size:17px">本篇重点语法</h3>' +
      '<ul class="k-list">' + (l.keyGrammar || []).map(function (k) { return "<li>" + esc(k) + "</li>"; }).join("") + "</ul>" +
      '<div class="divider"></div>' +
      '<h3 style="margin:0 0 4px;font-family:var(--serif);font-size:17px">关键词汇</h3>' +
      '<div class="vocab-list">' + (l.vocab || []).map(function (v) {
        return '<div class="vocab-item"><b>' + esc(v.w) + "</b><span>" + esc(v.k) + "</span><span>· " + esc(v.m) + "</span></div>";
      }).join("") + "</div></div>";

    // 音频（挂到 body 上，便于调试与移动端恢复播放）
    audio = document.createElement("audio");
    audio.src = encodeURI(l.audio);
    audio.preload = "metadata";
    audio.style.display = "none";
    applyVolume(audio, savedVolume());
    document.body.appendChild(audio);
    audio.addEventListener("loadedmetadata", function () {
      updateTime();
      $("#seekBar").querySelector("i").style.width = "0%";
    });
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", function () {
      $("#playBtn").textContent = "▶";
      highlight(-1);
      loopRange = null;
    });
    audio.addEventListener("error", function () {
      toast("音频加载失败，请确认 mp3 与页面在同一目录结构下");
    });

    $("#playBtn").onclick = togglePlay;
    $("#seekBar").onclick = function (e) {
      if (!audio.duration) return;
      var r = e.target.getBoundingClientRect();
      var ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      audio.currentTime = ratio * audio.duration;
      loopRange = null;
      var lb = $("#loopBtn");
      if (lb) lb.style.color = "";
    };
    $("#rateSel").onchange = function () { audio.playbackRate = parseFloat(this.value); };
    var volRange = $("#volRange");
    var muteBtn = $("#muteBtn");
    volRange.value = String(Math.round(savedVolume() * 100));
    syncMuteBtn(muteBtn, savedVolume());
    volRange.oninput = function () {
      var v = Math.max(0, Math.min(1, Number(this.value) / 100));
      audio.volume = v;
      lastVolume = v > 0 ? v : lastVolume;
      try { localStorage.setItem(K_VOLUME, String(v)); } catch (e) { }
      syncMuteBtn(muteBtn, v);
    };
    muteBtn.onclick = function () {
      var v = audio.volume > 0 ? 0 : lastVolume || 1;
      audio.volume = v;
      if (v > 0) lastVolume = v;
      volRange.value = String(Math.round(v * 100));
      try { localStorage.setItem(K_VOLUME, String(v)); } catch (e) { }
      syncMuteBtn(muteBtn, v);
    };
    $("#loopBtn").onclick = function () {
      if (!loopRange) { toast("先点句子里的 ▶ 播放某句，再按 ↻ 循环"); return; }
      loopRange.on = !loopRange.on;
      this.style.color = loopRange.on ? "var(--accent)" : "";
      toast(loopRange.on ? "循环本句：开" : "循环本句：关");
    };

    $$("#sentList .mini").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var card = b.closest(".sent");
        var i = +card.getAttribute("data-i");
        var act = b.getAttribute("data-act");
        if (act === "grammar") { card.classList.toggle("open"); return; }
        playSentence(i);
      });
    });
    $$("#sentList .sent").forEach(function (c) {
      c.addEventListener("click", function (e) {
        if (e.target.closest(".mini")) return;
        c.classList.toggle("open");
      });
    });

    // 注音 / 翻译开关（按钮 on = 已隐藏）
    var tgRuby = $("#tgRuby"), tgZh = $("#tgZh");
    tgRuby.classList.remove("on");
    tgZh.classList.remove("on");
    list.classList.remove("no-furigana");
    $$(".sent-zh", list).forEach(function (z) { z.style.display = ""; });
    tgRuby.onclick = function () {
      var hide = !tgRuby.classList.contains("on");
      tgRuby.classList.toggle("on", hide);
      list.classList.toggle("no-furigana", hide);
    };
    tgZh.onclick = function () {
      var hide = !tgZh.classList.contains("on");
      tgZh.classList.toggle("on", hide);
      $$(".sent-zh", list).forEach(function (z) { z.style.display = hide ? "none" : ""; });
    };
  }

  function togglePlay() {
    if (!audio) return;
    if (audio.paused) {
      audio.play().then(function () { $("#playBtn").textContent = "❚❚"; })
        .catch(function () { toast("浏览器阻止了自动播放，再点一次试试"); });
    } else {
      audio.pause();
      $("#playBtn").textContent = "▶";
    }
  }

  function fmt(sec) {
    if (!isFinite(sec)) return "00:00";
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return pad(m) + ":" + pad(s);
  }

  function updateTime() {
    var tl = $("#timeLabel");
    if (!tl || !audio) return;
    tl.textContent = fmt(audio.currentTime) + " / " + fmt(audio.duration || 0);
  }

  function onTimeUpdate() {
    if (!audio) return;
    updateTime();
    var dur = audio.duration || 0;
    if (dur) {
      var pct = (audio.currentTime / dur) * 100;
      var fill = $("#seekBar") && $("#seekBar").querySelector("i");
      if (fill) fill.style.width = pct + "%";
      highlight(sentenceAt(audio.currentTime / dur));
    }
    if (loopRange && loopRange.on && audio.currentTime >= loopRange.end) {
      audio.currentTime = loopRange.start;
    }
  }

  function sentenceAt(ratio) {
    if (!curListen || !sentOffsets.length) return -1;
    var total = sentOffsets[sentOffsets.length - 1].end || 1;
    var pos = ratio * total;
    for (var i = 0; i < sentOffsets.length; i++) {
      if (pos <= sentOffsets[i].end) return i;
    }
    return sentOffsets.length - 1;
  }

  /* 播放到哪句，就把哪句顶到可视区第一行（避开顶栏与吸顶播放器） */
  function chromeOffset() {
    var hud = document.querySelector(".hud");
    var hudH = hud ? hud.getBoundingClientRect().height : 0;
    var pl = $("#player");
    if (pl && getComputedStyle(pl).position === "sticky") return hudH + pl.offsetHeight + 12;
    return hudH + 12;
  }

  function scrollSentTop(i) {
    var el = $('#sentList .sent[data-i="' + i + '"]');
    if (!el) return;
    var top = window.scrollY + el.getBoundingClientRect().top - chromeOffset();
    var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    top = Math.max(0, Math.min(top, max));
    if (Math.abs(window.scrollY - top) < 6) return;
    window.scrollTo({ top: top, behavior: "smooth" });
  }

  function holdScroll() { scrollHoldUntil = Date.now() + 5000; }
  window.addEventListener("wheel", holdScroll, { passive: true });
  window.addEventListener("touchmove", holdScroll, { passive: true });

  function highlight(i, force) {
    $$("#sentList .sent").forEach(function (c) {
      c.classList.toggle("playing", +c.getAttribute("data-i") === i);
    });
    var changed = i !== curSent;
    curSent = i;
    if (!changed || i < 0) return;
    if (!force) {
      if (!audio || audio.paused) return;
      if (Date.now() < scrollHoldUntil) return;
    }
    scrollSentTop(i);
  }

  function playSentence(i) {
    if (!audio || !audio.duration) { toast("音频还没加载好，稍等一下"); return; }
    var total = sentOffsets[sentOffsets.length - 1].end || 1;
    var o = sentOffsets[i];
    var start = (o.start / total) * audio.duration;
    var end = (o.end / total) * audio.duration;
    loopRange = { start: start, end: end, on: true };
    audio.currentTime = start;
    audio.play().then(function () { $("#playBtn").textContent = "❚❚"; }).catch(function () { });
    $("#loopBtn").style.color = "var(--accent)";
    $("#loopBtn").textContent = "↻";
    highlight(i, true);
    scrollSentTop(i);
  }

  function closeListen() {
    if (audio) {
      audio.pause();
      if (audio.parentNode) audio.parentNode.removeChild(audio);
      audio = null;
    }
    loopRange = null;
    curListen = null;
    $("#listenDetail").style.display = "none";
    $("#listenListWrap").style.display = "block";
  }

  function initListening() {
    var back = $("#backToListen");
    if (back) back.addEventListener("click", closeListen);
    renderListenList();
  }

  /* =========================================================
   * 启动
   * ======================================================= */
  function initClock() {
    var el = $("#hudClock");
    if (!el) return;
    function tick() {
      var d = new Date();
      el.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }
    tick();
    setInterval(tick, 1000);
  }

  function syncHudVar() {
    var hud = document.querySelector(".hud");
    if (!hud) return;
    document.documentElement.style.setProperty("--hud-h", Math.round(hud.getBoundingClientRect().height) + "px");
  }
  window.addEventListener("resize", syncHudVar);

  /* ================= 默写模式 ================= */
  var dict = { list: [], i: 0, timer: null, audio: null, active: false, wrong: {} };
  var K_WRONG = "jp_dict_wrong_v1";

  function loadWrong() {
    try {
      var raw = localStorage.getItem(K_WRONG);
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === "object" ? o : {};
    } catch (e) { return {}; }
  }
  function saveWrong(o) { save(K_WRONG, o); }
  function wordById(id) {
    for (var k = 0; k < WORDS.length; k++) if (WORDS[k].id === id) return WORDS[k];
    return null;
  }
  function wrongDue() {
    var t = todayStr();
    var map = loadWrong();
    return Object.keys(map).filter(function (id) {
      var e = map[id];
      return e && e.due && e.due <= t && wordById(id);
    }).map(function (id) { return { id: id, count: map[id].count || 0, kind: map[id].kind }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function dictWords() {
    var today = todayStr();
    var queue = wrongDue();
    var list = [], seen = {};
    queue.forEach(function (it) {
      if (list.length >= 10) return;
      var w = wordById(it.id);
      if (w && !seen[w.id]) { list.push(w); seen[w.id] = true; }
    });
    var todayWords = WORDS.filter(function (w) { return w.added === today; });
    todayWords.forEach(function (w) {
      if (list.length >= 20 || seen[w.id]) return;
      list.push(w); seen[w.id] = true;
    });
    if (list.length) return list;
    var dates = {};
    WORDS.forEach(function (w) { if (w.added) dates[w.added] = true; });
    var keys = Object.keys(dates).sort();
    if (keys.length) {
      var last = keys[keys.length - 1];
      return WORDS.filter(function (w) { return w.added === last; });
    }
    return WORDS.slice(-20);
  }

  function dictPlay() {
    var w = dict.list[dict.i];
    if (!w) return;
    if (!dict.audio) {
      dict.audio = document.createElement("audio");
      dict.audio.preload = "auto";
      document.body.appendChild(dict.audio);
    }
    var a = dict.audio;
    a.onerror = function () { speak(w.word, null); };
    a.src = "audio/word/" + w.id + ".mp3";
    a.volume = savedVolume();
    try { a.currentTime = 0; } catch (e) {}
    var pr = a.play();
    if (pr && pr.catch) pr.catch(function () { speak(w.word, null); });
  }

  function dictRender() {
    var w = dict.list[dict.i];
    $("#dictNo").textContent = pad(dict.i + 1);
    var dots = dict.list.map(function (_, k) {
      var cls = k < dict.i ? "done" : (k === dict.i ? "now" : "");
      return '<i class="' + cls + '"></i>';
    }).join("");
    $("#dictDots").innerHTML = dots;
    var last = dict.i >= dict.list.length - 1;
    $("#dictNext").hidden = last;
    $("#dictFinish").hidden = !last;
  }

  function dictPlayLoop() {
    if (dict.timer) clearInterval(dict.timer);
    dictPlay();
    dict.timer = setInterval(dictPlay, 3000);
  }

  function dictStart() {
    dict.list = dictWords();
    var queue = {};
    wrongDue().forEach(function (it) { queue[it.id] = true; });
    dict.wrong = {};
    dict.list.forEach(function (w) { if (queue[w.id]) dict.wrong[w.id] = true; });
    var tag = $("#dictWrongTag");
    if (tag) {
      var ids = Object.keys(dict.wrong);
      var total = 0;
      var wq = loadWrong();
      ids.forEach(function (id) {
        var e = wq[id] || {};
        total += ((e.wc || 0) + (e.kc || 0)) || e.count || 0;
      });
      tag.hidden = ids.length === 0;
      tag.textContent = ids.length ? "含错词 " + ids.length + " 个 · 累计错 " + total + " 次" : "";
    }
    dict.i = 0;
    dict.active = true;
    $("#view-words").classList.add("dict-mode");
    $("#dictPanel").hidden = false;
    $("#dictStage").hidden = false;
    $("#dictDone").hidden = true;
    dictRender();
    dictPlayLoop();
  }

  function dictStop() {
    dict.active = false;
    if (dict.timer) { clearInterval(dict.timer); dict.timer = null; }
    if (dict.audio) { try { dict.audio.pause(); } catch (e) {} }
    $("#view-words").classList.remove("dict-mode");
    $("#dictPanel").hidden = true;
  }

  function dictNext() {
    if (dict.i >= dict.list.length - 1) return;
    dict.i++;
    dictRender();
    dictPlayLoop();
  }

  function dictFinish() {
    if (dict.timer) { clearInterval(dict.timer); dict.timer = null; }
    if (dict.audio) { try { dict.audio.pause(); } catch (e) {} }
    $("#dictStage").hidden = true;
    $("#dictDone").hidden = false;
    var ol = $("#dictList");
    ol.classList.remove("show-ans");
    ol.innerHTML = dict.list.map(function (w, k) {
      var bad = dict.wrong[w.id] ? " wrong" : "";
      var wcnt = 0, wwc = 0, wkc = 0;
      if (dict.wrong[w.id]) {
        var wq = loadWrong();
        var we = wq[w.id] || {};
        wwc = we.wc || 0;
        wkc = we.kc || 0;
        wcnt = wwc + wkc || we.count || 0;
      }
      var tip = "到今天为止：汉字错 " + wwc + " 次 · 假名错 " + wkc + " 次（合计 " + wcnt + " 次）";
      var tag = dict.wrong[w.id]
        ? '<em class="tag cnt" title="' + tip + '">错 ' + wcnt + " 次</em>"
        : "";
      return '<li class="dict-item' + bad + '"><b>' + pad(k + 1) + "</b>" +
        '<span class="ans"><span class="w">' + esc(w.word) + tag + '</span><span class="k">' + esc(w.kana) + "</span></span></li>";
    }).join("");
    toast("默写完成，共 " + dict.list.length + " 词");
  }

  function dictApplyResult(id, kind) {
    var t = todayStr();
    var p = progress[id];
    if (!p) p = { stage: 1, next: addDays(t, INTERVALS[1]), learned: t, last: t };
    if (kind === "know") {
      p.stage = Math.min(7, (p.stage || 1) + 1);
      p.next = addDays(t, INTERVALS[p.stage] || 60);
    } else if (kind === "fuzzy") {
      p.next = addDays(t, 1);
    } else {
      p.stage = Math.max(1, (p.stage || 1) - 1);
      p.next = addDays(t, 1);
    }
    p.last = t;
    progress[id] = p;

    var wrong = loadWrong();
    if (kind === "know") {
      delete wrong[id];
    } else {
      var e = wrong[id] || { count: 0, wc: 0, kc: 0 };
      if (kind === "fuzzy") e.kc = (e.kc || 0) + 1;
      else e.wc = (e.wc || 0) + 1;
      e.count = (e.wc || 0) + (e.kc || 0);
      e.due = addDays(t, 1);
      e.kind = kind === "fuzzy" ? "kana" : "word";
      e.last = t;
      wrong[id] = e;
    }
    saveWrong(wrong);
  }

  function dictParse(text) {
    var tokens = String(text || "").split(/[\s,，;；、]+/).filter(Boolean);
    var map = {};
    tokens.forEach(function (tk) {
      var m = tk.match(/^(\d+)\s*[:：.、]?\s*(.+)$/);
      if (!m) return;
      var idx = parseInt(m[1], 10) - 1;
      var r = m[2];
      if (/^(△|半|部分|partial)|^k×|×k$|假×|×假|假名错|kana.?wrong/i.test(r)) map[idx] = "fuzzy";
      else if (/^(○|◯|o|ok|对|✓|正|right)/i.test(r)) map[idx] = "know";
      else if (/^(×|x|错|✗|wrong|no)/i.test(r)) map[idx] = "forget";
    });
    return map;
  }

  function initDictation() {
    var btn = $("#dictBtn");
    if (!btn) return;
    btn.addEventListener("click", dictStart);
    $("#dictQuit").addEventListener("click", dictStop);
    $("#dictNext").addEventListener("click", dictNext);
    $("#dictFinish").addEventListener("click", dictFinish);
    $("#dictReplay").addEventListener("click", dictPlay);
    $("#dictAgain").addEventListener("click", dictStart);
    $("#dictToggleAnswer").addEventListener("click", function () {
      $("#dictList").classList.toggle("show-ans");
      this.textContent = $("#dictList").classList.contains("show-ans") ? "隐藏答案" : "显示答案";
    });
    $("#dictCopy").addEventListener("click", function () {
      var txt = dict.list.map(function (w, k) { return pad(k + 1) + " " + w.word + "（" + w.kana + "）"; }).join("\n");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast("清单已复制"); }, function () { toast("复制失败，请手动选择"); });
      } else {
        toast("当前浏览器不支持自动复制");
      }
    });
    $("#dictApply").addEventListener("click", function () {
      var map = dictParse($("#dictFeedback").value);
      var keys = Object.keys(map);
      if (!keys.length) { toast("没识别到批改结果，格式如：1× 2○ 3○"); return; }
      var ok = 0, kana = 0, bad = 0;
      keys.forEach(function (k) {
        var w = dict.list[+k];
        if (!w) return;
        dictApplyResult(w.id, map[k]);
        if (map[k] === "know") ok++;
        else if (map[k] === "fuzzy") kana++;
        else bad++;
      });
      save(K_PROGRESS, progress);
      renderWordTable();
      renderWordStats();
      var again = kana + bad;
      $("#dictNote").textContent = "已登记 " + keys.length + " 词（全对 " + ok + " · 假名差 " + kana + " · 错 " + bad + "）"
        + (again ? "，其中 " + again + " 词已进入明日默写" : "");
      toast(again ? "已登记，" + again + " 个错词进入明日默写" : "批改结果已登记到复习计划");
    });
    document.addEventListener("keydown", function (e) {
      if (!dict.active) return;
      if (e.key === "Escape") dictStop();
    });
  }

  function boot() {
    syncHudVar();
    initClock();
    initTheme();
    initTabs();
    initDictation();
    initWords();
    initGrammar();
    renderGrammar();
    initListening();
    var n = $("#dataNote");
    if (n) n.textContent = "词 " + WORDS.length + " · 语法 " + GRAMMAR.length + " · 听力 " + LISTENING.length + " 篇";
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
