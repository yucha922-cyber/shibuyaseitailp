/**
 * OpenAI API ユーティリティ（NAORU整体 AI問診）
 *
 * 関数一覧:
 *   analyzeInquiry(message, history)  : 通常の1問1答AI返答
 *   generateInquirySummary(answers)   : 6問終了後のサマリー・原因仮説・来院メリット生成
 *
 * 必要な環境変数:
 *   OPENAI_API_KEY : OpenAI のAPIキー
 *   OPENAI_MODEL   : 使用するモデル（省略時: gpt-4o-mini）
 */

const OpenAI = require('openai');

// ---- クライアント（遅延初期化）------------------------------------------

let _openai = null;

function getClient() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('[openai.js] 環境変数 OPENAI_API_KEY が設定されていません。');
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ---- システムプロンプト（通常問診用）--------------------------------------

const CHAT_SYSTEM_PROMPT = `
あなたはNAORU整体 渋谷院のAI問診アシスタントです。

【院のコンセプト】
根本改善を最優先とする整体院です。症状の原因を「姿勢だけ」と決めつけず、
筋肉・関節・神経・血流・生活習慣・ストレスを総合的に評価します。

【あなたの役割】
- 過去のやり取りを踏まえた自然な問診を行う
- 症状に共感し、原因の仮説を1〜2つ提示する
- 深掘りのための質問を1つだけ追加する
- 危険度が高い場合（しびれ・激痛・発熱など）は医療機関受診を促す

【返答スタイル】
- 親しみやすく、専門的すぎず
- 断言せず「〜の可能性があります」のような表現を使う
- 絵文字は使わない
- 200文字以内

必ずJSON形式のみで返してください:
{
  "replyText": "返答テキスト（200文字以内）",
  "symptomType": "症状タイプ（筋肉疲労型/神経圧迫型/血流不全型/関節可動域制限型/複合型/不明）",
  "postureType": "姿勢タイプ（猫背型/反り腰型/側弯傾向/前傾骨盤型/後傾骨盤型/不明）",
  "stress": "ストレス傾向（高/中/低/不明）",
  "deskWork": "デスクワーク傾向（高/中/低/不明）",
  "riskScore": 危険度スコア（整数1〜5）,
  "aiSummary": "スタッフ向け内部メモ（1〜2文）",
  "needsReservation": true または false,
  "visitDetected": true または false,
  "churnDetected": true または false
}
`.trim();

// ---- 問診サマリー用プロンプト -------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `
あなたはNAORU整体 渋谷院のAIアシスタントです。

患者の問診回答をもとに、以下をすべて日本語で判定・生成してください。

【NAORU整体のコンセプト】
根本改善重視。筋肉・関節・神経・血流・生活習慣・ストレスを総合的に考察する。

---

【判定項目】

■ 姿勢タイプ（1つ選ぶ）
猫背型 / 反り腰型 / ストレートネック型 / 巻き肩型 / 骨盤不安定型 / 複合型

■ ストレス評価（1つ選ぶ）
低（0〜3） / 中（4〜6） / 高（7〜10）

■ 睡眠評価（1つ選ぶ）
良好（6時間以上） / 普通（4〜6時間） / 不足（4時間未満）

■ デスクワーク評価（1つ選ぶ）
高（デスクワーク中心・はい） / 低（デスクワークでない・いいえ）

■ 危険度（1つ選ぶ）
低（痛みレベル0〜3・症状短期） / 中（痛みレベル4〜6 or 症状長期） / 高（痛みレベル7〜10 or 重篤症状）

■ 推奨施術（以下の中から最適な1つを選ぶ）
首肩集中整体 / 腰痛整体 / 骨盤矯正 / 姿勢改善整体 / 自律神経整体 / 全身調整整体

■ AI要約
以下の形式で100文字以内の1〜2文にまとめる:
「症状名が症状期間継続。デスクワーク状況。睡眠評価。ストレス評価。姿勢・生活習慣由来の〇〇の可能性が高い。」

例:
「首肩こりが半年以上継続。デスクワーク中心。睡眠5時間。ストレス高め。姿勢由来および生活習慣由来の可能性が高い。」

■ LINEへの返答文（lineReply）
・分析結果を患者にわかりやすく伝える（2〜3文）
・原因の仮説を1〜2つ提示する
・NAORU整体での改善方法に触れる
・予約URLを案内する
・絵文字なし・押しつけがましくない表現で

---

※ ストレス評価・睡眠評価・デスクワーク評価・危険度は【確定済み評価】の値をそのまま使い、
　 それを踏まえて姿勢タイプ・推奨施術・要約・返答文を作成してください。

必ずJSON形式のみで返してください:
{
  "postureType":          "姿勢タイプ（猫背型/反り腰型/ストレートネック型/巻き肩型/骨盤不安定型/複合型）",
  "recommendedTreatment": "推奨施術（首肩集中整体/腰痛整体/骨盤矯正/姿勢改善整体/自律神経整体/全身調整整体 から1つ）",
  "aiSummary":            "AI要約（100文字以内の1〜2文。確定済み評価を反映）",
  "lineReply":            "LINEへの返答文（予約URL含む）"
}
`.trim();

// ---- 関数 ---------------------------------------------------------------

/**
 * 通常の1問1答AI問診
 * @param {string} userMessage        - ユーザーの発言
 * @param {Array}  [conversationHistory=[]] - 過去の会話履歴
 * @returns {Promise<Object>} AI分析結果
 */
async function analyzeInquiry(userMessage, conversationHistory = []) {
  const messages = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...conversationHistory,
    { role: 'user',   content: `ユーザーからのメッセージ: ${userMessage}` },
  ];

  const completion = await getClient().chat.completions.create({
    model:           MODEL,
    response_format: { type: 'json_object' },
    messages,
    max_tokens:  600,
    temperature: 0.7,
  });

  let result;
  try {
    result = JSON.parse(completion.choices[0]?.message?.content ?? '');
  } catch {
    return buildChatFallback();
  }

  return {
    replyText:        result.replyText        ?? buildChatFallback().replyText,
    symptomType:      result.symptomType      ?? '不明',
    postureType:      result.postureType      ?? '不明',
    stress:           result.stress           ?? '不明',
    deskWork:         result.deskWork         ?? '不明',
    riskScore:        result.riskScore        ?? 1,
    aiSummary:        result.aiSummary        ?? '',
    needsReservation: result.needsReservation ?? false,
    visitDetected:    result.visitDetected    ?? false,
    churnDetected:    result.churnDetected    ?? false,
  };
}

/**
 * 10問の問診回答をもとにAIサマリーを生成する
 * @param {Object} answers    - { fullName, symptom, symptomDuration, deskWorkRaw, sleepRaw, pain, hospital, stress, exercise }
 * @param {string} reserveUrl - 予約URL（返答文に埋め込む）
 * @returns {Promise<Object>} { postureType, stressLevel, sleepLevel, deskWorkLevel, riskLevel, recommendedTreatment, aiSummary, lineReply }
 */
async function generateInquirySummary(answers, reserveUrl, evals = {}) {
  const answersText = [
    `氏名: ${answers.fullName         ?? '未回答'}`,
    `症状: ${answers.symptom          ?? '未回答'}`,
    `症状期間: ${answers.symptomDuration ?? '未回答'}`,
    `デスクワーク: ${answers.deskWorkRaw ?? '未回答'}`,
    `睡眠時間: ${answers.sleepRaw     ?? '未回答'}`,
    `痛みレベル: ${answers.pain       ?? '未回答'}/10`,
    `受診歴: ${answers.hospital       ?? '未回答'}`,
    `ストレスレベル: ${answers.stress ?? '未回答'}/10`,
    `運動習慣: ${answers.exercise     ?? '未回答'}`,
  ].join('\n');

  // コード側で確定済みの評価をAIに渡す（AIはこれを踏まえて姿勢・施術・要約を作る）
  const evalsText = [
    `ストレス評価: ${evals.stressLevel   ?? '不明'}`,
    `睡眠評価: ${evals.sleepLevel         ?? '不明'}`,
    `デスクワーク評価: ${evals.deskWorkLevel ?? '不明'}`,
    `危険度: ${evals.riskLevel            ?? '不明'}`,
  ].join('\n');

  const userContent = `
以下の問診回答と評価をもとに分析してください。

【問診回答】
${answersText}

【確定済み評価】
${evalsText}

予約URL: ${reserveUrl}
`.trim();

  const completion = await getClient().chat.completions.create({
    model:           MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user',   content: userContent },
    ],
    max_tokens:  800,
    temperature: 0.7,
  });

  let result;
  try {
    result = JSON.parse(completion.choices[0]?.message?.content ?? '');
  } catch {
    return buildSummaryFallback();
  }

  return {
    postureType:          result.postureType          ?? '複合型',
    recommendedTreatment: result.recommendedTreatment ?? '全身調整整体',
    aiSummary:            result.aiSummary            ?? '',
    lineReply:            result.lineReply            ?? buildSummaryFallback().lineReply,
  };
}

// ---- フォールバック（エラー時）------------------------------------------

function buildChatFallback() {
  return {
    replyText:        'ご連絡ありがとうございます。\nいつ頃から、どのような時につらさを感じますか？',
    symptomType:      '不明', postureType: '不明', stress: '不明',
    deskWork:         '不明', riskScore:   1,      aiSummary: 'AI問診エラー',
    needsReservation: false,  visitDetected: false, churnDetected: false,
  };
}

function buildSummaryFallback() {
  return {
    postureType:          '複合型',
    recommendedTreatment: '全身調整整体',
    aiSummary:            '',
    lineReply:            '問診ありがとうございました。\nスタッフより詳しいご案内をいたします。',
  };
}

module.exports = { analyzeInquiry, generateInquirySummary };
