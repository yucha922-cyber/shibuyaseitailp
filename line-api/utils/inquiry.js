/**
 * AI問診ステップ管理（NAORU整体向け 10ステップ）
 *
 *   step 0     : 未開始
 *   step 1〜9  : 各質問を待っている状態
 *   step 10    : Q10「AI分析中」メッセージ送信 → サマリー生成
 *   step 11以上: 完了
 *
 * 選択式の質問には options を持たせ、ユーザーが「1」と答えても
 * 「1. 肩こり・首こり」のように選択肢の文字を補完して保存する。
 */

const QUESTIONS = [
  {
    step:  1,
    key:   'fullName',
    label: 'お名前',
    text:  'Q1. お名前（フルネーム）を教えてください。',
  },
  {
    step:  2,
    key:   'symptom',
    label: '症状',
    options: ['肩こり・首こり', '頭痛', '腰痛', '坐骨神経痛', '膝痛', '姿勢が気になる', '自律神経の乱れ', 'その他'],
    text:  'Q2. 現在一番気になる症状は何ですか？\n\n1. 肩こり・首こり\n2. 頭痛\n3. 腰痛\n4. 坐骨神経痛\n5. 膝痛\n6. 姿勢が気になる\n7. 自律神経の乱れ\n8. その他\n\n番号またはそのままお答えください。',
  },
  {
    step:  3,
    key:   'symptomDuration',
    label: '症状期間',
    options: ['1週間以内', '1か月以内', '3か月以上', '半年以上', '1年以上'],
    text:  'Q3. その症状はいつ頃からありますか？\n\n1. 1週間以内\n2. 1か月以内\n3. 3か月以上\n4. 半年以上\n5. 1年以上\n\n番号またはそのままお答えください。',
  },
  {
    step:  4,
    key:   'deskWorkRaw',
    label: 'デスクワーク',
    options: ['はい', 'いいえ'],
    text:  'Q4. お仕事はデスクワーク中心ですか？\n\n1. はい\n2. いいえ\n\n番号またはそのままお答えください。',
  },
  {
    step:  5,
    key:   'sleepRaw',
    label: '睡眠時間',
    options: ['4時間未満', '4〜6時間', '6〜8時間', '8時間以上'],
    text:  'Q5. 1日の平均睡眠時間は？\n\n1. 4時間未満\n2. 4〜6時間\n3. 6〜8時間\n4. 8時間以上\n\n番号またはそのままお答えください。',
  },
  {
    step:  6,
    key:   'pain',
    label: '痛みレベル',
    text:  'Q6. 現在の痛みを0〜10で教えてください。\n\n0 = 痛みなし　10 = 激痛\n\n数字1つでお答えください。',
  },
  {
    step:  7,
    key:   'hospital',
    label: '受診歴',
    options: ['はい', 'いいえ'],
    text:  'Q7. 過去に病院・整形外科・整骨院・整体などに通いましたか？\n\n1. はい\n2. いいえ\n\n番号またはそのままお答えください。',
  },
  {
    step:  8,
    key:   'stress',
    label: 'ストレスレベル',
    text:  'Q8. 現在のストレスを0〜10で表すと？\n\n0 = ほぼない　10 = 非常に高い\n\n数字1つでお答えください。',
  },
  {
    step:  9,
    key:   'exercise',
    label: '運動習慣',
    options: ['週3回以上', '週1〜2回', 'ほぼしない'],
    text:  'Q9. 運動習慣はありますか？\n\n1. 週3回以上\n2. 週1〜2回\n3. ほぼしない\n\n番号またはそのままお答えください。',
  },
];

const ANALYSIS_STEP = 10;

function getQuestion(step) {
  return QUESTIONS.find((q) => q.step === step) ?? null;
}

function isAnalysisStep(step) {
  return step === ANALYSIS_STEP;
}

function isCompleted(step) {
  return step > ANALYSIS_STEP;
}

/**
 * ユーザーの生回答を「1. 肩こり・首こり」形式に整える。
 *   - 選択肢つきの質問で番号(例 "1")を答えた → 「1. 選択肢名」
 *   - 選択肢名そのもの or 自由入力        → そのまま返す
 * @param {Object} question - QUESTIONS の1要素
 * @param {string} raw      - ユーザーの生回答
 * @returns {string}
 */
function resolveAnswer(question, raw) {
  const text = (raw ?? '').trim();
  if (!question?.options) return text;

  // 「1」「1番」「1.」など先頭の数字を抜き出す
  const numMatch = text.match(/^\s*(\d+)/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1; // 1始まり → 0始まり
    if (idx >= 0 && idx < question.options.length) {
      return `${idx + 1}. ${question.options[idx]}`;
    }
  }

  // 選択肢名で答えた場合は番号を補完
  const optIdx = question.options.findIndex((o) => text.includes(o));
  if (optIdx >= 0) return `${optIdx + 1}. ${question.options[optIdx]}`;

  return text; // 自由入力（その他など）
}

/**
 * 回答オブジェクトを読みやすい文字列に変換する（問診内容列・AI送信用）
 * answers には resolveAnswer 済みの値が入っている前提
 */
function formatAnswers(answers) {
  return QUESTIONS.map((q) => `${q.label}: ${answers[q.key] ?? '未回答'}`).join('\n');
}

// ---- 回答からの自動評価（AIに依存せずコードで確定）----------------------

/** ストレス評価: 0〜3=低 / 4〜6=中 / 7〜10=高 */
function evaluateStress(painOrStressRaw) {
  const n = parseInt(painOrStressRaw, 10);
  if (Number.isNaN(n)) return '不明';
  if (n <= 3) return '低';
  if (n <= 6) return '中';
  return '高';
}

/** 危険度: 痛み 0〜3=低 / 4〜6=中 / 7〜10=高 */
function evaluateRisk(painRaw) {
  const n = parseInt(painRaw, 10);
  if (Number.isNaN(n)) return '不明';
  if (n <= 3) return '低';
  if (n <= 6) return '中';
  return '高';
}

/** 睡眠評価: 6時間以上=良好 / 4〜6時間=普通 / 4時間未満=不足 */
function evaluateSleep(sleepResolved) {
  const s = sleepResolved ?? '';
  if (s.includes('8時間以上') || s.includes('6〜8')) return '良好';
  if (s.includes('4〜6')) return '普通';
  if (s.includes('4時間未満')) return '不足';
  return '不明';
}

/** デスクワーク評価: はい=高 / いいえ=低 */
function evaluateDeskWork(deskResolved) {
  const d = deskResolved ?? '';
  if (d.includes('はい')) return '高';
  if (d.includes('いいえ')) return '低';
  return '不明';
}

module.exports = {
  QUESTIONS,
  ANALYSIS_STEP,
  getQuestion,
  isAnalysisStep,
  isCompleted,
  resolveAnswer,
  formatAnswers,
  evaluateStress,
  evaluateRisk,
  evaluateSleep,
  evaluateDeskWork,
};
