/**
 * AI問診ステップ管理
 *
 * ステップ番号の意味:
 *   0     : 問診未開始
 *   1〜9  : 各質問を待っている状態（質問済み・回答待ち）
 *   10以上: 全質問終了 → OpenAI要約生成へ
 */

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
    key:   'jobType',
    label: '仕事内容',
    text:  '③お仕事の内容を教えてください。\n\n（例: デスクワーク・接客・立ち仕事・力仕事・在宅勤務　など）',
  },
  {
    step:  4,
    key:   'sittingHours',
    label: '座位時間',
    text:  '④1日のうち、座っている時間はどのくらいですか？\n\n（例: 2時間未満・4〜6時間・8時間以上　など）',
  },
  {
    step:  5,
    key:   'sleep',
    label: '睡眠時間',
    text:  '⑤1日の平均睡眠時間を教えてください。\n\n（例: 5時間・7時間・バラバラ　など）',
  },
  {
    step:  6,
    key:   'stress',
    label: 'ストレスレベル',
    text:  '⑥最近のストレスレベルを教えてください。\n\n1 = ほとんどない\n5 = 非常に高い\n\n数字1つでお答えください。',
  },
  {
    step:  7,
    key:   'pain',
    label: '痛みレベル',
    text:  '⑦現在のつらさ・痛みを10段階で教えてください。\n\n1 = ほとんど気にならない\n10 = 日常生活に支障がある\n\n数字1つでお答えください。',
  },
  {
    step:  8,
    key:   'hospital',
    label: '受診歴',
    text:  '⑧過去に病院・整形外科・接骨院などを受診したことはありますか？\n\n「はい」「いいえ」「現在も通院中」でお答えください。',
  },
  {
    step:  9,
    key:   'goal',
    label: '改善したいこと',
    text:  '⑨最後に、一番改善したいことを教えてください。\n\n（例: 痛みをなくしたい・仕事に集中できるようにしたい・ぐっすり眠れるようになりたい　など）',
  },
];

function getQuestion(step) {
  return QUESTIONS.find((q) => q.step === step) ?? null;
}

function isCompleted(step) {
  return step > QUESTIONS.length;
}

/**
 * 回答オブジェクトを読みやすい文字列に変換する（Sheets保存用）
 */
function formatAnswers(answers) {
  return QUESTIONS.map((q) => `${q.label}: ${answers[q.key] ?? '未回答'}`).join('\n');
}

module.exports = { QUESTIONS, getQuestion, isCompleted, formatAnswers };
