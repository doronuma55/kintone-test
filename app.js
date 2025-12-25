/***********************
 * 設定
 ***********************/

// 問題の元データとなる CSV ファイル（既存のものをそのまま利用）
const CSV_FILES = ["result.csv", "result (1).csv", "result (2).csv"]; // index.html と同じフォルダに配置

// 1セットで出題する問題数
const QUESTIONS_PER_QUIZ = 10;

// デバッグ用：特定の問題だけを出題したいときの ID リスト
// 形式は「練習問題セット-設問」。例：セット1の設問3 → "1-3"
const FIXED_QUESTION_IDS = [];

// ★ できるだけ広く出題したい：学習回数（= 1回10問のセット）をこの回数で回すと、全問を一通り出しやすくする
const TARGET_RUNS_TO_SEE_ALL = 20;


/***********************
 * ユーティリティ
 ***********************/
const $ = (id) => document.getElementById(id);

// XSS 対策用：HTML に差し込むテキストは必ず escape する
function escapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function indexToLabel(i) {
  return String.fromCharCode("A".charCodeAt(0) + i);
}

function linkOrText(url) {
  const u = String(url ?? "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) {
    return `<a href="${escapeHTML(u)}" target="_blank" rel="noopener noreferrer">${escapeHTML(u)}</a>`;
  }
  return escapeHTML(u);
}


/***********************
 * CSV パーサ（シンプル・クォート対応）
 ***********************/
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // "" → " にエスケープされているケース
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else if (ch === "\r") {
        // \r\n など
        continue;
      } else {
        cur += ch;
      }
    }
  }

  // 最後のセル
  row.push(cur);
  rows.push(row);

  // 空行っぽいものを削る
  return rows.filter(r => r.some(c => String(c ?? "").trim() !== ""));
}


/***********************
 * クイズ履歴（ローカルストレージ）
 * 目的：できるだけ広く出題されるように、直近で出した問題を避ける
 ***********************/
const STATS_KEY = "kintone_quiz_stats_v1";

/**
 * stats = {
 *   quizRun: number,
 *   byId: {
 *     [id]: { seen: number, lastSeen: number }
 *   }
 * }
 */
function loadQuizStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return { quizRun: 0, byId: {} };
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { quizRun: 0, byId: {} };
    if (!data.byId) data.byId = {};
    if (typeof data.quizRun !== "number") data.quizRun = 0;
    return data;
  } catch {
    return { quizRun: 0, byId: {} };
  }
}

function saveQuizStats(stats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // ignore
  }
}

function getStat(stats, id) {
  return stats.byId[id] || { seen: 0, lastSeen: -1 };
}

function setStat(stats, id, value) {
  stats.byId[id] = value;
}

/**
 * 出題ロジック：
 * - FIXED_QUESTION_IDS があればそれを優先
 * - そうでなければ「最近出ていない問題」を優先して抽出
 */
function pickQuestions(all, n) {
  if (FIXED_QUESTION_IDS.length > 0) {
    const map = new Map(all.map(q => [q.id, q]));
    const picked = FIXED_QUESTION_IDS.map(id => map.get(id)).filter(Boolean);
    return picked.slice(0, n);
  }

  const stats = loadQuizStats();
  const nextRun = (stats.quizRun || 0) + 1;

  // スコアリング：lastSeen が古いほど優先（見たことないものは最優先）
  const scored = all.map(q => {
    const s = getStat(stats, q.id);
    const seen = s.seen || 0;
    const lastSeen = (typeof s.lastSeen === "number") ? s.lastSeen : -1;

    // lastSeen が -1（未出題）は優先
    // それ以外は「今からどれだけ離れているか」で優先
    const gap = (lastSeen < 0) ? 999999 : (nextRun - lastSeen);
    return { q, seen, lastSeen, gap };
  });

  // gap 大きい（古い）→ seen 少ない → ランダム
  scored.sort((a, b) => {
    if (b.gap !== a.gap) return b.gap - a.gap;
    if (a.seen !== b.seen) return a.seen - b.seen;
    return Math.random() - 0.5;
  });

  const picked = scored.slice(0, n).map(x => x.q);

  // stats 更新
  picked.forEach(q => {
    const s = getStat(stats, q.id);
    setStat(stats, q.id, { seen: (s.seen || 0) + 1, lastSeen: nextRun });
  });
  stats.quizRun = nextRun;
  saveQuizStats(stats);

  return picked;
}


/***********************
 * 解説レイヤー（explanations.json）
 ***********************/
let explanationsById = {};
let explanationsAsOf = null;

async function loadExplanations() {
  try {
    const res = await fetch("explanations.json");
    if (!res.ok) {
      console.warn("explanations.json 読み込み失敗:", res.status);
      return;
    }

    const data = await res.json();

    explanationsById = {};
    explanationsAsOf = data.asOf || null;

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (!item || !item.id) continue;
      explanationsById[item.id] = item;
    }

    console.log("explanations.json を読み込みました。件数:", Object.keys(explanationsById).length);
  } catch (e) {
    console.warn("explanations.json 読み込み中にエラー:", e);
  }
}


/***********************
 * CSV → 問題オブジェクト変換
 * （result*.csv 専用のマッピング）
 ***********************/
/**
 * result.csv 系の前提：
 *   - 「練習問題セット」「設問」から一意な id ("1-3" など) を採番
 *   - 選択肢は { text, rawText, isCorrect, helpUrl, textRef } の形
 *   - rawText は「原文厳格引用」用（trim しない）
 */
function buildQuestionsFromResultCsv(rows) {
  if (!rows || rows.length < 2) return [];

  const header = rows[0].map(h => (h ?? "").trim());
  const hIndex = (name) => header.indexOf(name);

  // result.csv 系の列名に合わせる
  const idx = {
    setNo:    hIndex("練習問題セット"),
    qNo:      hIndex("設問"),
    category: hIndex("カテゴリ"),
    question: hIndex("出題内容"),
    choiceA:  hIndex("選択肢A"),
    choiceB:  hIndex("選択肢B"),
    choiceC:  hIndex("選択肢C"),
    choiceD:  hIndex("選択肢D"),
    correct:  hIndex("正解"),
    urlA:     hIndex("関連リンクA"),
    urlB:     hIndex("関連リンクB"),
    urlC:     hIndex("関連リンクC"),
    urlD:     hIndex("関連リンクD"),
    textRefA: hIndex("参照テキストA"),
    textRefB: hIndex("参照テキストB"),
    textRefC: hIndex("参照テキストC"),
    textRefD: hIndex("参照テキストD"),
  };

  const questions = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const getRaw = (i) => (i >= 0 && i < row.length ? (row[i] ?? "") : "");
    const get = (i) => getRaw(i).trim();

    const setNo = get(idx.setNo);
    const qNo = get(idx.qNo);
    const id = (setNo && qNo) ? `${setNo}-${qNo}` : `row-${r}`;

    const category = get(idx.category);
    const textRaw = getRaw(idx.question);
    const text = textRaw.trim();
    const correctRaw = get(idx.correct).toUpperCase();

    if (!text || !correctRaw) continue;

    // 正答列 "ABC" → ["A","B","C"] に分解（A〜D 以外の文字は無視）
    const correctKeys = Array.from(
      new Set(
        correctRaw
          .split("")
          .filter(ch => ["A", "B", "C", "D"].includes(ch))
      )
    );

    // 各選択肢を「中身＋正誤フラグ」で定義（A/B/C/D のラベル自体には依存しない）
    const rawChoices = [
      {
        colKey: "A",
        rawText: getRaw(idx.choiceA),
        text: get(idx.choiceA),
        helpUrl: get(idx.urlA),
        textRef: get(idx.textRefA),
      },
      {
        colKey: "B",
        rawText: getRaw(idx.choiceB),
        text: get(idx.choiceB),
        helpUrl: get(idx.urlB),
        textRef: get(idx.textRefB),
      },
      {
        colKey: "C",
        rawText: getRaw(idx.choiceC),
        text: get(idx.choiceC),
        helpUrl: get(idx.urlC),
        textRef: get(idx.textRefC),
      },
      {
        colKey: "D",
        rawText: getRaw(idx.choiceD),
        text: get(idx.choiceD),
        helpUrl: get(idx.urlD),
        textRef: get(idx.textRefD),
      },
    ];

    // 実際にテキストが入っている選択肢だけ抽出
    const choices = [];
    rawChoices.forEach((c, idxChoice) => {
      if (!c.text) return;
      choices.push({
        // 「どの列から来たか」は id に残しておく（現状は使っていないがデバッグ用）
        id: idxChoice,
        text: c.text,
        rawText: c.rawText ?? c.text,
        isCorrect: correctKeys.includes(c.colKey),
        helpUrl: c.helpUrl,
        textRef: c.textRef,
      });
    });

    if (choices.length < 2) continue;

    const correctCount = choices.filter(c => c.isCorrect).length;
    if (correctCount === 0) continue;

    questions.push({
      id,                          // 解説レイヤーと紐づけるための一意な ID
      category,
      text,
      textRaw,
      choices,                     // A/B/C/D に依存しない「内容＋正誤フラグ」
      isMultiple: correctCount > 1 // true → 複数選択問題
    });
  }

  return questions;
}


/***********************
 * アプリ状態（メモリ上のデータ）
 ***********************/

// CSV から読み込んだ全問題
let allQuestions = [];
// 参照用：id → 元の問題（CSV順の選択肢を保持）
let allQuestionsById = {};

// 今回の10問
let currentQuizQuestions = [];
let currentIndex = 0;

// 各問題の回答（選択した choiceIndex の配列）
let userAnswers = [];

// 状態（採点済み/解説表示済み）
let questionStates = [];

// 合計正解数
let scoreCount = 0;


/***********************
 * DOM 参照
 ***********************/
const startScreen  = $("start-screen");
const quizScreen   = $("quiz-screen");
const resultScreen = $("result-screen");

const loadStatus   = $("load-status");
const startBtn     = $("start-btn");

const gradeBtn     = $("grade-btn");
const explainBtn   = $("explain-btn");
const nextBtn      = $("next-btn");
const restartBtn   = $("restart-btn");
const copyEditBtn = $("copy-edit-btn");

const questionNumberEl = $("question-number");
const categoryLabelEl  = $("category-label");
const questionTextEl   = $("question-text");
const choicesContainer = $("choices-container");
const feedbackEl       = $("feedback");
const progressBarEl    = $("progress-bar");

const scoreSummaryEl   = $("score-summary");
const reviewContainer  = $("review-container");


/***********************
 * 画面切り替え
 ***********************/
function showScreen(name) {
  startScreen.classList.add("hidden");
  quizScreen.classList.add("hidden");
  resultScreen.classList.add("hidden");

  if (name === "start") {
    startScreen.classList.remove("hidden");
  } else if (name === "quiz") {
    quizScreen.classList.remove("hidden");
  } else if (name === "result") {
    resultScreen.classList.remove("hidden");
  }
}


/***********************
 * 問題バンクのロード（CSV）
 ***********************/
async function loadQuestionBank() {
  loadStatus.textContent = "CSVファイルから問題を読み込んでいます…（file:// で開くと失敗します。簡易サーバー経由で開いてください）";

  const loaded = [];

  for (const file of CSV_FILES) {
    try {
      const res = await fetch(file);
      if (!res.ok) {
        console.warn("CSV 読み込み失敗:", file, res.status);
        continue;
      }
      const text = await res.text();
      const rows = parseCSV(text);
      const qs   = buildQuestionsFromResultCsv(rows);
      loaded.push(...qs);
    } catch (e) {
      console.error("CSV 読み込みエラー:", file, e);
    }
  }

  allQuestions = loaded;

  // id→問題（元データ）マップを作成
  allQuestionsById = {};
  for (const q of allQuestions) {
    if (q && q.id) allQuestionsById[q.id] = q;
  }

  if (allQuestions.length === 0) {
    loadStatus.textContent = "有効な問題が1件も読み込めませんでした。CSVファイルの配置と内容を確認してください。";
    startBtn.disabled = true;
  } else {
    loadStatus.textContent = `読み込み完了：${allQuestions.length}問。［テストを開始する］でランダムに${QUESTIONS_PER_QUIZ}問を出題します。`;
    startBtn.disabled = false;
  }
}


/***********************
 * クイズ開始
 ***********************/
function startQuiz() {
  if (!allQuestions || allQuestions.length === 0) return;

  // 出題問題を抽出（最近出ていないもの優先）
  const picked = pickQuestions(allQuestions, QUESTIONS_PER_QUIZ);

  // 画面表示用に、選択肢の順番だけ毎回シャッフル
  currentQuizQuestions = picked.map(q => ({
    ...q,
    choices: shuffleArray(q.choices) // ★ 選択肢の順番を毎回ランダム化
  }));

  currentIndex = 0;
  userAnswers = currentQuizQuestions.map(() => []); // 各問題ごとに「選んだ choiceIndex 配列」
  questionStates = currentQuizQuestions.map(() => ({
    graded: false,
    explained: false,
    isCorrect: false,
  }));
  scoreCount = 0;

  showScreen("quiz");
  renderCurrentQuestion();
}


/***********************
 * 現在の問題を描画
 ***********************/
function renderCurrentQuestion() {
  const total = currentQuizQuestions.length;
  const q = currentQuizQuestions[currentIndex];
  const state = questionStates[currentIndex];
  const selectedIndexes = new Set(userAnswers[currentIndex]); // 0..choices.length-1

  questionNumberEl.textContent = `第 ${currentIndex + 1} 問 / 全 ${total} 問（問題ID：${q.id}）`;
  categoryLabelEl.textContent = q.category || "カテゴリ未設定";
  questionTextEl.innerHTML = escapeHTML(q.text);

  // 複数選択可の表示
  if (q.isMultiple) {
    categoryLabelEl.textContent += "（複数選択可）";
  }

  // 進捗バー（「何問目まで到達したか」をざっくり表示）
  const progressPercent = (currentIndex / total) * 100;
  progressBarEl.style.width = `${progressPercent}%`;

  // フィードバック（採点結果・解説表示エリア）をリセット
  feedbackEl.innerHTML = "";

  // 選択肢ボタンの描画
  choicesContainer.innerHTML = "";
  q.choices.forEach((choice, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-btn";

    const label = indexToLabel(idx); // A/B/C/D を「画面表示用」にその場で割り振る
    btn.dataset.index = String(idx);
    btn.dataset.label = label;

    const text = `[${label}] ${choice.text}`;
    btn.innerHTML = escapeHTML(text);

    if (selectedIndexes.has(idx)) {
      btn.classList.add("selected");
    }

    btn.addEventListener("click", () => {
      toggleChoiceSelection(idx);
    });

    choicesContainer.appendChild(btn);
  });

  const hasSelection = selectedIndexes.size > 0;

  if (!state.graded) {
    gradeBtn.disabled = !hasSelection;  // 何か1つ以上選ばれていれば採点可能
    explainBtn.disabled = true;
    nextBtn.disabled = true;
  } else {
    gradeBtn.disabled = true;
    explainBtn.disabled = state.explained;
    nextBtn.disabled = !state.explained;
  }

  if (copyEditBtn) copyEditBtn.disabled = false;
}


/***********************
 * 選択肢クリック
 *  - 単一問題：ラジオボタン的に 1 つだけ保持
 *  - 複数問題：チェックボックス的にトグル
 ***********************/
function toggleChoiceSelection(choiceIndex) {
  const q = currentQuizQuestions[currentIndex];
  const arr = userAnswers[currentIndex];
  const idx = Number(choiceIndex);

  if (!q.isMultiple) {
    // 単一選択：1つに置き換える
    userAnswers[currentIndex] = [idx];
  } else {
    // 複数選択：トグル
    const pos = arr.indexOf(idx);
    if (pos >= 0) {
      arr.splice(pos, 1);
    } else {
      arr.push(idx);
    }
    userAnswers[currentIndex] = arr;
  }

  renderCurrentQuestion();
}


/***********************
 * 採点
 ***********************/
function gradeCurrentQuestion() {
  const q = currentQuizQuestions[currentIndex];
  const state = questionStates[currentIndex];
  if (state.graded) return;

  const userIndexes = Array.from(new Set(userAnswers[currentIndex])).sort((a, b) => a - b);

  const correctIndexes = q.choices
    .map((choice, idx) => (choice.isCorrect ? idx : null))
    .filter(idx => idx !== null);

  const isCorrect =
    userIndexes.length === correctIndexes.length &&
    userIndexes.every((v, i) => v === correctIndexes[i]);

  state.graded = true;
  state.isCorrect = isCorrect;

  if (isCorrect) scoreCount += 1;

  // 選択肢の見た目を更新（正解/不正解ハイライト）
  Array.from(choicesContainer.querySelectorAll("button.choice-btn")).forEach(btn => {
    const idx = Number(btn.dataset.index);
    const choice = q.choices[idx];

    btn.disabled = true;

    if (choice.isCorrect) {
      btn.classList.add("correct");
    } else if (userIndexes.includes(idx)) {
      btn.classList.add("wrong");
    }
  });

  // フィードバック表示
  feedbackEl.innerHTML = isCorrect
    ? `<div class="ok">正解！</div>`
    : `<div class="ng">不正解…</div>`;

  renderCurrentQuestion();
}


/***********************
 * 解説表示（画面用）
 ***********************/
function showExplanation() {
  const q = currentQuizQuestions[currentIndex];
  const state = questionStates[currentIndex];
  if (!state.graded || state.explained) return;

  const userIndexes = Array.from(new Set(userAnswers[currentIndex])).sort((a, b) => a - b);
  const correctIndexes = q.choices
    .map((choice, idx) => (choice.isCorrect ? idx : null))
    .filter(idx => idx !== null);

  const userLabels = userIndexes.map(indexToLabel);
  const correctLabels = correctIndexes.map(indexToLabel);

  const userText = userLabels.length ? userLabels.join(", ") : "（未回答）";
  const correctText = correctLabels.join(", ");

  // explanations.json の本文を優先（なければ簡易説明）
  const exp = explanationsById[q.id] || null;

  let html = `<hr>`;
  html += `<div class="explain">`;
  html += `<div class="muted">あなたの回答：${escapeHTML(userText)}<br>`;
  html += `正解：${escapeHTML(correctText)}</div>`;

  if (exp && exp.body) {
    html += `<pre class="explain-body">${escapeHTML(exp.body)}</pre>`;
  } else {
    html += `<p class="muted">（この問題の解説は未登録です：explanations.json に id=${escapeHTML(q.id)} を追加してください）</p>`;
  }

  // 関連ヘルプ／テキスト：CSV 側に載っている URL / テキスト参照先を表示
  const helpLines = [];
  q.choices.forEach((choice, idx) => {
    const label = indexToLabel(idx);
    const parts = [];
    if (choice.helpUrl) {
      parts.push(`ヘルプ: ${linkOrText(choice.helpUrl)}`);
    }
    if (choice.textRef) {
      parts.push(`テキスト: ${escapeHTML(choice.textRef)}`);
    }
    if (parts.length > 0) {
      helpLines.push(`[${label}] ${parts.join(" / ")}`);
    }
  });

  if (helpLines.length > 0) {
    html += `<div class="refs"><div class="muted">参照</div><ul>`;
    helpLines.forEach(line => {
      html += `<li>${line}</li>`;
    });
    html += `</ul></div>`;
  }

  html += `</div>`;

  feedbackEl.innerHTML += html;

  state.explained = true;
  renderCurrentQuestion();
}


/***********************
 * 次へ
 ***********************/
function goToNextQuestion() {
  const total = currentQuizQuestions.length;

  if (currentIndex < total - 1) {
    currentIndex += 1;
    renderCurrentQuestion();
  } else {
    showResult();
  }
}


/***********************
 * 結果画面
 ***********************/
function showResult() {
  showScreen("result");

  scoreSummaryEl.textContent = `あなたのスコア：${scoreCount} / ${currentQuizQuestions.length}`;

  // レビュー表示
  reviewContainer.innerHTML = "";

  currentQuizQuestions.forEach((q, i) => {
    const state = questionStates[i];
    const userIndexes = Array.from(new Set(userAnswers[i])).sort((a, b) => a - b);

    const correctIndexes = q.choices
      .map((choice, idx) => (choice.isCorrect ? idx : null))
      .filter(idx => idx !== null);

    const userLabels = userIndexes.map(indexToLabel);
    const correctLabels = correctIndexes.map(indexToLabel);

    const userText = userLabels.length ? userLabels.join(", ") : "（未回答）";
    const correctText = correctLabels.join(", ");

    const div = document.createElement("div");
    div.className = "review-item";

    div.innerHTML = `
      <div class="review-head">
        <span class="badge">Q${i + 1}</span>
        <span class="${state.isCorrect ? "ok" : "ng"}">${state.isCorrect ? "正解" : "不正解"}</span>
        <span class="muted">（問題ID：${escapeHTML(q.id)}）</span>
      </div>
      <div class="review-q">${escapeHTML(q.text)}</div>
      <div class="muted">あなたの回答：${escapeHTML(userText)} / 正解：${escapeHTML(correctText)}</div>
    `;

    reviewContainer.appendChild(div);
  });
}


/***********************
 * 解説修正用にコピー
 * - CSV順（choice1→）の原文を維持
 * - ABCD表記は出さない（アプリ上はシャッフルされるため）
 ***********************/
function buildCopyTextForQuestion(qId) {
  const qOriginal = (qId && allQuestionsById && allQuestionsById[qId]) ? allQuestionsById[qId] : null;
  const q = qOriginal || currentQuizQuestions[currentIndex];

  const questionTextRaw = (q.textRaw ?? q.text ?? "");
  const choices = Array.isArray(qOriginal?.choices) ? qOriginal.choices : (q.choices ?? []);
  const correctChoices = choices.filter(c => c.isCorrect).map(c => (c.rawText ?? c.text ?? ""));

  const exp = (q.id && explanationsById && explanationsById[q.id]) ? explanationsById[q.id] : null;
  const body = exp?.body ?? "";

  const lines = [];
  lines.push(`問題ID：${q.id}`);
  lines.push(`設問：`);
  lines.push(String(questionTextRaw));
  lines.push("");
  lines.push("選択肢（CSV順・原文厳格引用）");
  choices.forEach((c, i) => {
    lines.push(`（${i + 1}）`);
    lines.push(String(c.rawText ?? c.text ?? ""));
    lines.push("");
  });

  lines.push("正解（原文）");
  if (correctChoices.length === 0) {
    lines.push("（不明）");
  } else {
    correctChoices.forEach(t => lines.push(`・${String(t)}`));
  }

  lines.push("");
  lines.push("現在の解説（body）：");
  lines.push(body ? String(body) : "（未登録）");

  lines.push("");
  lines.push("追加指示（任意）：");

  return lines.join("\n");
}

async function copyTextToClipboard(text) {
  // localhost / https は isSecureContext になりやすい。file:// は失敗しやすい。
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}

  // フォールバック（古いブラウザ/非セキュアコンテキスト用）
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

async function copyForEditCurrentQuestion() {
  const q = currentQuizQuestions[currentIndex];
  const text = buildCopyTextForQuestion(q?.id);

  const ok = await copyTextToClipboard(text);

  const msg = ok ? "解説修正用テキストをコピーしました。" : "コピーに失敗しました。localhost（簡易サーバ）で開いてください。";
  if (feedbackEl && (feedbackEl.innerHTML ?? "") === "") {
    feedbackEl.innerHTML = `<p>${escapeHTML(msg)}</p>`;
  } else {
    alert(msg);
  }
}


/***********************
 * 初期化
 ***********************/
document.addEventListener("DOMContentLoaded", () => {
  showScreen("start");

  // CSV から問題バンク読み込み
  loadQuestionBank();

  // explanations.json から解説レイヤーを読み込み（あれば）
  loadExplanations();

  // ボタンイベント
  startBtn.addEventListener("click", startQuiz);
  gradeBtn.addEventListener("click", gradeCurrentQuestion);
  explainBtn.addEventListener("click", showExplanation);
  nextBtn.addEventListener("click", goToNextQuestion);
  restartBtn.addEventListener("click", startQuiz);
  if (copyEditBtn) copyEditBtn.addEventListener("click", copyForEditCurrentQuestion);
});
