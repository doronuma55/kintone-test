/***********************
 * 設定
 ***********************/

// 問題の元データとなる CSV ファイル（既存のものをそのまま利用）
const CSV_FILES = ["result.csv", "result (1).csv", "result (2).csv"]; // index.html と同じフォルダに配置

// 1セットで出題する問題数
const QUESTIONS_PER_QUIZ = 10;

// デバッグ用：特定の問題だけを出題したいときの ID リスト
// 形式は「練習問題セット-設問」。例：セット1の設問3 → "1-3"
// ★ セット1の設問1〜3だけを出したいので、ひとまずこの3つを指定
const FIXED_QUESTION_IDS = [];

// ★ できるだけ広く出題したい：学習回数（= 1回10問のセット）をこの回数で回すと、全問を一通り出しやすくする
//   - 完全に「順繰り」にはせず、毎回ランダム性も残します（同じ問題が何度か出るのは許容）。
const TARGET_COVERAGE_QUIZZES = 20;

// 出題履歴（何回出たか／いつ出たか）をブラウザに保存するキー
const QUIZ_STATS_STORAGE_KEY = "kintone_quiz_stats_v1";
// 通常どおり全問題からランダム出題したくなったら、上を null か [] に変更する：
// const FIXED_QUESTION_IDS = null;



/***********************
 * ユーティリティ
 ***********************/

// document.getElementById の短縮版
const $ = (id) => document.getElementById(id);

// XSS 対策用：HTML に差し込むテキストは必ず escape する
function escapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 0,1,2,... を A,B,C,... のラベルに変換する（画面表示用）
function indexToLabel(index) {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

// URL が http/https の場合だけ <a> に変換する。
// それ以外は単なるテキストとして扱う。
function linkOrText(url) {
  if (!url) return "";
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return escapeHTML(trimmed);
  }
  return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${escapeHTML(trimmed)}</a>`;
}

/**
 * シンプルな CSV パーサ
 * - Excel から出した標準的な CSV を想定
 * - ダブルクォートで囲まれたフィールド内のカンマ・改行に対応
 * - RFC 完全準拠ではないが、今回の用途には十分
 */
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
        // クォート閉じ
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
        // CR は無視（CRLF 対応）
      } else {
        cur += ch;
      }
    }
  }

  // 最後のフィールド・行を追加
  row.push(cur);
  rows.push(row);

  // 完全に空の行は除去
  return rows.filter(r => r.some(c => (c ?? "").trim() !== ""));
}

// 配列をシャッフル（Fisher–Yates）
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/***********************
 * 出題履歴（localStorage）と「出やすさ調整」ロジック
 *
 * 目的：
 * - 10問×20回くらいで、なるべく全体（例：135問）を一通り出す
 * - ただし「順繰り」ではなく、ランダム性も残して復習（重複）も混ぜる
 *
 * 仕組み（ざっくり）：
 * - quizRun（何回目の10問セットか）と、各問題の seen（出題回数）、lastSeen（最後に出た回）を保存
 * - 毎回「未出題」を優先して一定数混ぜつつ、残りは「出題回数が少ないほど出やすい」重み付き抽選
 ***********************/
function loadQuizStats() {
  try {
    const raw = localStorage.getItem(QUIZ_STATS_STORAGE_KEY);
    if (!raw) return { quizRun: 0, byId: {} };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { quizRun: 0, byId: {} };
    if (typeof obj.quizRun !== "number") obj.quizRun = 0;
    if (!obj.byId || typeof obj.byId !== "object") obj.byId = {};
    return obj;
  } catch (e) {
    return { quizRun: 0, byId: {} };
  }
}

function saveQuizStats(stats) {
  try {
    localStorage.setItem(QUIZ_STATS_STORAGE_KEY, JSON.stringify(stats));
  } catch (e) {
    // localStorage が使えない環境でもアプリ自体は動かす
    console.warn("Failed to save quiz stats:", e);
  }
}

function getStat(stats, id) {
  const s = stats.byId[id];
  if (s && typeof s === "object") {
    return {
      seen: typeof s.seen === "number" ? s.seen : 0,
      lastSeen: typeof s.lastSeen === "number" ? s.lastSeen : -9999
    };
  }
  return { seen: 0, lastSeen: -9999 };
}

function setStat(stats, id, next) {
  stats.byId[id] = { seen: next.seen, lastSeen: next.lastSeen };
}

/**
 * 重み付き抽選（重複なし）で k 個選ぶ
 * items: 配列（要素はオブジェクトでもOK）
 * getWeight: (item) => number（0以上。0は選ばれない）
 */
function weightedSampleWithoutReplacement(items, k, getWeight) {
  const pool = [...items];
  const picked = [];

  for (let t = 0; t < k && pool.length > 0; t++) {
    // 重み合計
    let total = 0;
    const weights = pool.map(it => {
      const w = Math.max(0, Number(getWeight(it)) || 0);
      total += w;
      return w;
    });

    // すべて 0 の場合は、残りをランダムに拾う
    if (total <= 0) {
      const shuffled = shuffleArray(pool);
      picked.push(...shuffled.slice(0, k - picked.length));
      break;
    }

    // ルーレット選択
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return picked;
}

/**
 * 10問セットを作る（未出題を優先しつつ、復習（重複）も混ぜる）
 */
function selectQuizQuestions(pool, count) {
  const stats = loadQuizStats();
  const nextRun = stats.quizRun + 1;

  // 全体を TARGET_COVERAGE_QUIZZES 回くらいで一通り出すために、毎回「最低この数」は未出題を混ぜる
  const targetNewPerQuiz = Math.min(
    count,
    Math.max(1, Math.ceil(pool.length / TARGET_COVERAGE_QUIZZES))
  );

  // 未出題（seen===0）
  const unseen = pool.filter(q => getStat(stats, q.id).seen === 0);
  const newCount = Math.min(targetNewPerQuiz, unseen.length, count);

  // まず未出題からランダムに newCount 取る（未出題同士は同等）
  const pickedNew = shuffleArray(unseen).slice(0, newCount);

  // 残りは「出題回数が少ないほど」「直近に出ていないほど」出やすくする（ただしゼロにはしない）
  const pickedIds = new Set(pickedNew.map(q => q.id));
  const restPool = pool.filter(q => !pickedIds.has(q.id));
  const restCount = count - pickedNew.length;

  // 直近に出た問題を少し避けるためのウィンドウ（何回分）
  const RECENT_WINDOW = 3;

  const pickedRest = weightedSampleWithoutReplacement(restPool, restCount, (q) => {
    const s = getStat(stats, q.id);
    const seen = s.seen;
    const since = nextRun - s.lastSeen;

    // 出題回数が多いほど重みを下げる（復習は残しつつ、未出題/少数回を優先）
    const countPenalty = 1 / Math.pow(1 + seen, 1.15);

    // 直近に出たら少しだけ出にくくする
    const recencyPenalty = since <= RECENT_WINDOW ? 0.25 : 1;

    // 完全に0にはしない（偶然の復習も起きる）
    const base = 0.0001;

    return base + countPenalty * recencyPenalty;
  });

  const picked = [...pickedNew, ...pickedRest];

  // この時点で「出題した」扱いとして履歴を更新（同一セット内は重複しない）
  picked.forEach(q => {
    const s = getStat(stats, q.id);
    setStat(stats, q.id, { seen: s.seen + 1, lastSeen: nextRun });
  });
  stats.quizRun = nextRun;
  saveQuizStats(stats);

  return picked;
}


/***********************
 * 解説レイヤー（explanations.json）
 ***********************/

// explanations.json から読み込んだ「id → 解説オブジェクト」のマップ
// 形式： { "1-1": { id, title, body, links }, ... }
let explanationsById = {};

// 解説全体の「○○現在」的な日付（JSON の asOf ）
let explanationsAsOf = null;

/**
 * explanations.json を fetch して、explanationsById に詰める
 * - 失敗しても致命的ではないので、エラー時はコンソールに出して無視
 */
async function loadExplanations() {
  try {
    const res = await fetch("explanations.json"); // index.html と同階層に配置したファイル
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
 * 1つの CSV（2次元配列）から、内部で扱う問題オブジェクト配列に変換する。
 * - 今回のポイント：
 *   - 「練習問題セット」「設問」から一意な id ("1-3" など) を採番
 *   - 選択肢は { text, isCorrect, helpUrl, textRef } の形で、A/B/C/D に依存しない
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
    correct:  hIndex("正答"),

    choiceA:  hIndex("選択肢A"),
    choiceB:  hIndex("選択肢B"),
    choiceC:  hIndex("選択肢C"),
    choiceD:  hIndex("選択肢D"),

    urlA:     hIndex("選択肢A ヘルプ参照先URL"),
    urlB:     hIndex("選択肢B ヘルプ参照先URL"),
    urlC:     hIndex("選択肢C ヘルプ参照先URL"),
    urlD:     hIndex("選択肢D ヘルプ参照先URL"),

    textRefA: hIndex("選択肢A テキスト参照先"),
    textRefB: hIndex("選択肢B テキスト参照先"),
    textRefC: hIndex("選択肢C テキスト参照先"),
    textRefD: hIndex("選択肢D テキスト参照先"),
  };

  // 最低限必要なのは「問題文」と「正答」
  if (idx.question === -1 || idx.correct === -1) return [];

  const questions = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (i) => (i >= 0 && i < row.length ? (row[i] ?? "").trim() : "");

    const text = get(idx.question);
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
    if (correctKeys.length === 0) continue;

    const category = get(idx.category) || "";

    // 練習問題セット + 設問 から一意な ID を作る
    const setNoRaw = idx.setNo >= 0 ? get(idx.setNo) : "";
    const qNoRaw   = idx.qNo   >= 0 ? get(idx.qNo)   : "";

    let id = "";
    if (setNoRaw && qNoRaw) {
      // 例：セット1の設問3 → "1-3"
      id = `${setNoRaw}-${qNoRaw}`;
    } else {
      // 万一どちらか欠けている場合は、行番号ベースの ID にフォールバック
      id = `row-${r}`;
    }

    // 各選択肢を「中身＋正誤フラグ」で定義（A/B/C/D のラベル自体には依存しない）
    const rawChoices = [
      {
        colKey: "A",
        text: get(idx.choiceA),
        helpUrl: get(idx.urlA),
        textRef: get(idx.textRefA),
      },
      {
        colKey: "B",
        text: get(idx.choiceB),
        helpUrl: get(idx.urlB),
        textRef: get(idx.textRefB),
      },
      {
        colKey: "C",
        text: get(idx.choiceC),
        helpUrl: get(idx.urlC),
        textRef: get(idx.textRefC),
      },
      {
        colKey: "D",
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

// 今回の 10 問セット（選択肢シャッフル後）
let currentQuizQuestions = [];

// 現在表示中のインデックス（0 開始）
let currentIndex = 0;

// 各問題について、ユーザーが選んだ選択肢のインデックス配列
// 例：[[0], [1,3], [], ...]
let userAnswers = [];

// 各問題の採点・解説状態
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

  if (allQuestions.length === 0) {
    loadStatus.textContent = "有効な問題が1件も読み込めませんでした。CSVファイルの配置と内容を確認してください。";
    startBtn.disabled = true;
  } else {
    loadStatus.textContent = `読み込み完了：${allQuestions.length}問。［テストを開始する］でランダムに${QUESTIONS_PER_QUIZ}問を出題します。`;
    startBtn.disabled = false;
  }
}


/***********************
 * テスト開始・再開
 ***********************/
function startQuiz() {
  if (allQuestions.length === 0) return;

  // ▼ 出題プールを決める
  //   - FIXED_QUESTION_IDS に配列が入っていれば、そのIDの問題だけに絞る
  //   - null や空配列なら、全問題を対象にする
  let pool = allQuestions;

  if (Array.isArray(FIXED_QUESTION_IDS) && FIXED_QUESTION_IDS.length > 0) {
    const idSet = new Set(FIXED_QUESTION_IDS);
    const filtered = allQuestions.filter(q => idSet.has(q.id));

    if (filtered.length === 0) {
      // IDが1つも見つからなかったときは全問題にフォールバック
      console.warn("FIXED_QUESTION_IDS に対応する問題が見つかりませんでした。全問題から出題します。");
    } else {
      pool = filtered;
    }
  }

  // 1セットの問題数は、定数とプールの小さい方
  const count = Math.min(QUESTIONS_PER_QUIZ, pool.length);

  // ▼ 出題セットを作る（履歴を見て「未出題を優先しつつ、復習も混ぜる」）
  const picked = selectQuizQuestions(pool, count);

  // 出題用の配列を作る（選択肢もシャッフルしたコピー）
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
 * 現在の問題表示
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

    if (state.graded) {
      // 採点後は操作不可・色だけ表示
      btn.disabled = true;
      const isCorrect = choice.isCorrect;
      const isSelected = selectedIndexes.has(idx);

      if (isCorrect) {
        btn.classList.add("correct");
      }
      if (isSelected && !isCorrect) {
        btn.classList.add("incorrect");
      }
    } else {
      // 未採点時：クリックで選択
      btn.addEventListener("click", () => {
        toggleChoiceSelection(idx);
      });
    }

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

  if (q.isMultiple) {
    // 複数選択可 → チェックボックス風トグル
    const pos = arr.indexOf(idx);
    if (pos === -1) {
      arr.push(idx);
    } else {
      arr.splice(pos, 1);
    }
  } else {
    // 単一選択 → 常に1つだけ選ばれている状態にする
    arr.length = 0;
    arr.push(idx);
  }

  renderCurrentQuestion();
}


/***********************
 * 採点（選択肢の isCorrect フラグで判定）
 ***********************/
function gradeCurrentQuestion() {
  const q = currentQuizQuestions[currentIndex];
  const state = questionStates[currentIndex];

  if (state.graded) return;

  const userIndexes = Array.from(new Set(userAnswers[currentIndex])).sort((a, b) => a - b);
  if (userIndexes.length === 0) return;

  const correctIndexes = q.choices
    .map((choice, idx) => (choice.isCorrect ? idx : null))
    .filter(idx => idx !== null);

  const userSet = new Set(userIndexes);
  const correctSet = new Set(correctIndexes);

  let isCorrect = true;

  // 正しい選択肢が全て選ばれているか
  for (const i of correctSet) {
    if (!userSet.has(i)) {
      isCorrect = false;
      break;
    }
  }
  // 余分な選択がないか
  if (isCorrect) {
    for (const i of userSet) {
      if (!correctSet.has(i)) {
        isCorrect = false;
        break;
      }
    }
  }

  state.graded = true;
  state.isCorrect = isCorrect;
  if (isCorrect) scoreCount++;

  // ボタンの見た目更新
  const buttons = choicesContainer.querySelectorAll(".choice-btn");
  buttons.forEach((btn, idx) => {
    const isC = q.choices[idx].isCorrect;
    const isSel = userSet.has(idx);

    btn.disabled = true;
    if (isC) btn.classList.add("correct");
    if (isSel && !isC) btn.classList.add("incorrect");
  });

  const typeLabel = q.isMultiple ? "（複数選択問題）" : "（単一選択問題）";
  feedbackEl.innerHTML = isCorrect
    ? `✔ 正解です！${typeLabel}`
    : `✖ 不正解です。${typeLabel}`;

  gradeBtn.disabled = true;
  explainBtn.disabled = false;
  nextBtn.disabled = true;
}


/***********************
 * 解説表示（explanations.json と連動）
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

  let html = feedbackEl.innerHTML;
  html += "<br>";
  html += `正解：${escapeHTML(correctText)}<br>`;
  html += `あなたの回答：${escapeHTML(userText)}<br>`;

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
    html += "<br>関連ヘルプ／テキスト参照先（問題ごとに設定されたもの）：<br>";
    helpLines.forEach(line => {
      html += `${line}<br>`;
    });
  }

  // ★ explanations.json 側の「本気解説」を表示（あれば）
  const exp = q.id ? explanationsById[q.id] : null;

  if (exp && exp.body) {
    html += "<br>解説：<br>";
    const bodyHtml = escapeHTML(exp.body).replace(/\n/g, "<br>");
    html += bodyHtml;

    // 「2025-12-09 現在」のような注釈（全体 asOf が優先。なければ item.asOf）
    const asOf = explanationsAsOf || exp.asOf;
    if (asOf) {
      html += `<br><small>※この解説は ${escapeHTML(asOf)} 時点の情報に基づいています。最新の仕様や詳細は必ず公式ヘルプを確認してください。</small>`;
    }
  }

  // explanations.json 内の「関連リンク」
  if (exp && Array.isArray(exp.links) && exp.links.length > 0) {
    html += "<br>関連リンク（公式ヘルプなど）：<br>";
    for (const link of exp.links) {
      if (!link) continue;
      const label = escapeHTML(link.label || link.url || "");
      const url   = link.url ? escapeHTML(link.url) : "";
      if (url) {
        html += `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a><br>`;
      } else if (label) {
        html += `${label}<br>`;
      }
    }
  }

  feedbackEl.innerHTML = html;

  state.explained = true;
  explainBtn.disabled = true;
  nextBtn.disabled = false;
}


/***********************
 * 次の問題へ
 ***********************/
function goToNextQuestion() {
  const total = currentQuizQuestions.length;
  const state = questionStates[currentIndex];
  if (!state.graded || !state.explained) return;

  if (currentIndex < total - 1) {
    currentIndex++;
    renderCurrentQuestion();
  } else {
    showResult();
  }
}


/***********************
 * 結果画面
 ***********************/
function showResult() {
  const total = currentQuizQuestions.length;
  const rate = total > 0 ? Math.round((scoreCount / total) * 100) : 0;

  scoreSummaryEl.textContent = `全 ${total} 問中 ${scoreCount} 問正解（正答率 ${rate}%）`;

  reviewContainer.innerHTML = "";

  currentQuizQuestions.forEach((q, qi) => {
    const state = questionStates[qi];
    const userIndexes = Array.from(new Set(userAnswers[qi])).sort((a, b) => a - b);
    const correctIndexes = q.choices
      .map((choice, idx) => (choice.isCorrect ? idx : null))
      .filter(idx => idx !== null);

    const userLabels = userIndexes.map(indexToLabel);
    const correctLabels = correctIndexes.map(indexToLabel);

    const item = document.createElement("div");
    item.className = "review-item";

    const title = document.createElement("h4");
    title.textContent = `第 ${qi + 1} 問：${q.category || ""}`;
    item.appendChild(title);

    const qText = document.createElement("p");
    qText.textContent = q.text;
    item.appendChild(qText);

    const your = document.createElement("p");
    your.textContent = `あなたの回答：${userLabels.length ? userLabels.join(", ") : "（未回答）"}`;
    item.appendChild(your);

    const correct = document.createElement("p");
    correct.textContent = `正解：${correctLabels.join(", ")}`;
    item.appendChild(correct);

    const result = document.createElement("p");
    result.textContent = state.isCorrect ? "→ 正解" : "→ 不正解";
    item.appendChild(result);

    // 下の方にも、CSV由来のヘルプ／テキスト参照先をまとめておく
    const helpLines = [];
    q.choices.forEach((choice, idx) => {
      const label = indexToLabel(idx);
      const parts = [];
      if (choice.helpUrl) parts.push(`ヘルプ: ${linkOrText(choice.helpUrl)}`);
      if (choice.textRef) parts.push(`テキスト: ${escapeHTML(choice.textRef)}`);
      if (parts.length > 0) {
        helpLines.push(`[${label}] ${parts.join(" / ")}`);
      }
    });

    if (helpLines.length > 0) {
      const helpP = document.createElement("p");
      helpP.innerHTML = "関連ヘルプ／テキスト参照先（問題ごとに設定されたもの）：<br>" +
        helpLines.join("<br>");
      item.appendChild(helpP);
    }

    reviewContainer.appendChild(item);
  });

  showScreen("result");
}


/***********************
 * イベント登録（初期化）
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
});