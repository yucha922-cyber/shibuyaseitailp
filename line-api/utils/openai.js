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

患者の問診回答をもとに、以下を日本語で生成してください。

【NAORU整体のコンセプト】
根本改善重視。姿勢だけを原因と決めつけず、
筋肉・関節・神経・血流・生活習慣・ストレスを総合的に考察してください。

【施術者向け要約（aiSummary）の形式】
施術者が初回施術の仮説を立てられるよう、以下の情報を40〜60文字で1文にまとめてください。
- 仕事・座位時間（デスクワーク状況）
- 睡眠時間
- ストレスレベル
- 主な症状・発症時期
- 推定される身体的問題（筋緊張部位・可動域制限など）

形式例:
『デスクワーク8時間以上。睡眠5時間未満。ストレス高め。慢性的肩こり。首肩周囲の筋緊張と胸郭可動性低下が疑われる。』

必ずJSON形式のみで返してください:
{
  "summary": "問診結果のまとめ（2〜3文。患者に読みやすい表現で）",
  "hypothesis": "考えられる主な原因と仮説（2〜3文。複数の視点から）",
  "visitMerit": "NAORU整体に来院するメリット（2〜3文。押しつけにならない表現で）",
  "lineReply": "LINEで送る完成した返答文（summary + hypothesis + visitMerit を統合した自然な文章。予約URLの案内も含める。絵文字なし）",
  "symptomType": "症状タイプ（筋肉疲労型/神経圧迫型/血流不全型/関節可動域制限型/複合型）",
  "postureType": "姿勢タイプ（猫背型/反り腰型/側弯傾向/前傾骨盤型/後傾骨盤型/不明）",
  "riskScore": 危険度スコア（整数1〜5）,
  "aiSummary": "施術者向け要約（上記の形式例に沿った40〜60文字の1文）"
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
 * 9問の問診回答をもとにAIサマリーを生成する
 * @param {Object} answers - { symptom, duration, jobType, sittingHours, sleep, stress, pain, hospital, goal }
 * @param {string} reserveUrl - 予約URL（返答文に埋め込む）
 * @returns {Promise<Object>} { summary, hypothesis, visitMerit, lineReply, symptomType, postureType, riskScore, aiSummary }
 */
async function generateInquirySummary(answers, reserveUrl) {
  // 回答を読みやすい形式に変換してプロンプトに渡す
  const answersText = [
    `症状: ${answers.symptom      ?? '未回答'}`,
    `発症時期: ${answers.duration ?? '未回答'}`,
    `仕事内容: ${answers.jobType  ?? '未回答'}`,
    `座位時間: ${answers.sittingHours ?? '未回答'}`,
    `睡眠時間: ${answers.sleep    ?? '未回答'}`,
    `ストレスレベル: ${answers.stress ?? '未回答'}/5`,
    `痛みレベル: ${answers.pain   ?? '未回答'}/10`,
    `受診歴: ${answers.hospital   ?? '未回答'}`,
    `改善したいこと: ${answers.goal ?? '未回答'}`,
  ].join('\n');

  const userContent = `
以下の問診回答をもとに分析してください。

【問診回答】
${answersText}

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
    summary:      result.summary     ?? '',
    hypothesis:   result.hypothesis  ?? '',
    visitMerit:   result.visitMerit  ?? '',
    lineReply:    result.lineReply   ?? buildSummaryFallback().lineReply,
    symptomType:  result.symptomType ?? '不明',
    postureType:  result.postureType ?? '不明',
    riskScore:    result.riskScore   ?? 1,
    aiSummary:    result.aiSummary   ?? '',
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
    summary:     '問診が完了しました。詳しくはスタッフにご相談ください。',
    hypothesis:  '',
    visitMerit:  '',
    lineReply:   '問診ありがとうございました。\nスタッフより詳しいご案内をいたします。',
    symptomType: '不明',
    postureType: '不明',
    riskScore:   1,
  };
}

module.exports = { analyzeInquiry, generateInquirySummary };
