/**
 * AI問診ステップ管理
 *
 * 役割:
 *   6段階の問診フローを定義する。
 *   Redisに「何問目か」「各回答」を保存し、
 *   一問一答形式で問診を進める。
 *
 * ステップ番号の意味:
 *   0 : 問診未開始
 *   1〜6 : 各質問を待っている状態（質問済み・回答待ち）
 *   7 : 全質問終了 → OpenAI要約生成へ
 */

// ---- 6つの質問定義 -------------------------------------------------------
//
// key     : Redisに保存するフィールド名
// label   : Google Sheetsのカラムヘッダー名
// text    : ユーザーへ送る質問文
// hint    : ユーザーへの入力例（補足）

const QUESTIONS = [
  {
    step:  1,
    key:   'symptom',
    label: '症状',
    text:  '①どのようなお悩みがありますか？\n\n（例: 肩こり・腰痛・頭痛・膝の痛み・疲れが取れない　など、複数でも大丈夫です）',
  },
  {
    step:  2,
    key:   'duration',
    label: '発症時期',
    text:  '②いつ頃からその症状がありますか？\n\n（例: 1週間前から・半年以上前から・気づいたら慢性的に　など）',
  },
  {
    step:  3,
    key:   'deskWork',
    label: 'デスクワーク',
    text:  '③お仕事はデスクワーク中心ですか？\n\n「はい」「いいえ」「半々くらい」でお答えください。',
  },
  {
    step:  4,
    key:   'sleep',
    label: '睡眠時間',
    text:  '④1日の平均睡眠時間を教えてください。\n\n（例: 5時間・7時間・バラバラ　など）',
  },
  {
    step:  5,
    key:   'pain',
    label: '痛みレベル',
    text:  '⑤現在のつらさ・痛みを10段階で教えてください。\n\n1 = ほとんど気にならない\n10 = 日常生活に支障がある\n\n数字1つでお答えください。',
  },
  {
    step:  6,
    key:   'hospital',
    label: '病院受診歴',
    text:  '⑥過去に病院・整形外科・接骨院などを受診したことはありますか？\n\n「はい」「いいえ」「現在も通院中」でお答えください。',
  },
];

// ---- ユーティリティ関数 --------------------------------------------------

/**
 * ステップ番号に対応する質問オブジェクトを返す
 * @param {number} step - 1〜6
 * @returns {Object|null}
 */
function getQuestion(step) {
  return QUESTIONS.find((q) => q.step === step) ?? null;
}

/**
 * 全6問が終了しているか判定する
 * @param {number} step
 * @returns {boolean}
 */
function isCompleted(step) {
  return step > QUESTIONS.length;
}

/**
 * 回答オブジェクトを読みやすい文字列に変換する（Sheets保存用）
 * @param {Object} answers - { symptom, duration, deskWork, sleep, pain, hospital }
 * @returns {string}
 */
function formatAnswers(answers) {
  return QUESTIONS.map((q) => `${q.label}: ${answers[q.key] ?? '未回答'}`).join('\n');
}

module.exports = { QUESTIONS, getQuestion, isCompleted, formatAnswers };
