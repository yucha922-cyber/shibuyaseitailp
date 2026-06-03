/**
 * OpenAI API ユーティリティ（NAORU整体 AI問診）
 *
 * 役割:
 *   LINEユーザーのメッセージと過去の会話履歴を受け取り、
 *   NAORU整体のコンセプトに沿った問診返答と分析データをJSON形式で返す。
 *
 * 必要な環境変数:
 *   OPENAI_API_KEY : OpenAI のAPIキー
 *   OPENAI_MODEL   : 使用するモデル（省略時: gpt-4o-mini）
 *
 * 返り値（AIResponse）の構造:
 *   replyText        : LINEに送る自然な問診返答
 *   symptomType      : 症状タイプ（筋肉疲労型 / 神経圧迫型 など）
 *   postureType      : 姿勢タイプ（猫背型 / 反り腰型 など）
 *   stress           : ストレス傾向（高 / 中 / 低）
 *   deskWork         : デスクワーク傾向（高 / 中 / 低）
 *   riskScore        : 危険度スコア（1〜5）
 *   aiSummary        : スタッフ向けの内部メモ
 *   needsReservation : 予約を強く勧めるべきか（true/false）
 *   visitDetected    : 来院を報告するメッセージか（true/false）
 *   churnDetected    : キャンセル・離反を示すメッセージか（true/false）
 */

const OpenAI = require('openai');

// ---- OpenAI クライアント（遅延初期化）--------------------------------------

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

// ---- システムプロンプト ---------------------------------------------------
//
// ここを変更するだけでAIの返答スタイル・分析軸を調整できます。

const SYSTEM_PROMPT = `
あなたはNAORU整体 渋谷院のAI問診アシスタントです。

【院のコンセプト】
根本改善を最優先とする整体院です。症状を「姿勢だけ」と決めつけず、以下を総合的に評価します:
- 筋肉（緊張・疲労・柔軟性）
- 関節（可動域・炎症）
- 神経（圧迫・過敏）
- 血流（滞り・冷え）
- 生活習慣（睡眠・食事・運動）
- ストレス（精神的・身体的）
- 姿勢（構造的なバランス）

【あなたの役割】
1. 過去のやり取りを踏まえ、文脈のある自然な問診を行う
2. ユーザーの症状に共感し、原因の仮説を1〜2つ提示する
3. 深掘りのための質問を1つだけ追加する（多すぎると離脱する）
4. 危険度が高い場合（しびれ・激痛・発熱・急な頭痛など）は医療機関受診を促す
5. 自然な流れでNAORU整体への予約を案内する（押しつけにならないよう注意）

【来院・離反の検出】
以下のような発言があった場合は対応するフラグをtrueにする:
- visitDetected=true: 「行ってきました」「施術受けました」「来院しました」「ありがとうございました（施術後のお礼）」「楽になりました」
- churnDetected=true: 「キャンセルします」「やめます」「行かないことにしました」「解約」「もういいです」

【返答スタイル】
- 過去のやり取りがある場合は「先ほどお伝えいただいた〜」など文脈を活かす
- 親しみやすく、専門的すぎず
- 断言せず「〜の可能性があります」のような表現を使う
- 絵文字は使わない
- 200文字以内（LINEで読みやすい長さ）

【必ずJSON形式のみで返すこと】他のテキストは一切含めないでください。

{
  "replyText": "LINEに表示するユーザー向けの自然な問診返答（200文字以内）",
  "symptomType": "症状タイプ（筋肉疲労型 / 神経圧迫型 / 血流不全型 / 関節可動域制限型 / 複合型 / 不明）",
  "postureType": "姿勢タイプ（猫背型 / 反り腰型 / 側弯傾向 / 前傾骨盤型 / 後傾骨盤型 / 不明）",
  "stress": "ストレス傾向（高 / 中 / 低 / 不明）",
  "deskWork": "デスクワーク傾向（高 / 中 / 低 / 不明）",
  "riskScore": 危険度スコア（整数1〜5）,
  "aiSummary": "スタッフ向け内部メモ（1〜2文）",
  "needsReservation": true または false,
  "visitDetected": true または false,
  "churnDetected": true または false
}
`.trim();

// ---- メイン関数 -----------------------------------------------------------

/**
 * ユーザーのメッセージをAIに送り、問診結果を返す
 *
 * @param {string} userMessage              - ユーザーがLINEで送ったテキスト
 * @param {Array}  [conversationHistory=[]] - 過去の会話履歴（OpenAI messages形式）
 * @returns {Promise<AIResponse>} AI分析結果
 */
async function analyzeInquiry(userMessage, conversationHistory = []) {
  // メッセージ配列を構築: system → 過去の会話 → 今回のユーザー発言
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory, // ← 過去3往復分が入る
    { role: 'user', content: `ユーザーからのメッセージ: ${userMessage}` },
  ];

  const completion = await getClient().chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' }, // JSON形式を強制
    messages,
    max_tokens:  600,
    temperature: 0.7,
  });

  const rawText = completion.choices[0]?.message?.content ?? '';

  let result;
  try {
    result = JSON.parse(rawText);
  } catch {
    console.error('[openai.js] JSONパース失敗:', rawText);
    return buildFallbackResponse();
  }

  // 必須フィールドが欠けていた場合もフォールバックで補完
  return {
    replyText:        result.replyText        ?? buildFallbackResponse().replyText,
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
 * APIエラー時・解析失敗時のフォールバック
 * ユーザーにはエラーを露出させない
 */
function buildFallbackResponse() {
  return {
    replyText:        'ご連絡ありがとうございます。\nいつ頃から、どのような時につらさを感じますか？',
    symptomType:      '不明',
    postureType:      '不明',
    stress:           '不明',
    deskWork:         '不明',
    riskScore:        1,
    aiSummary:        'AI問診エラー（フォールバック応答）',
    needsReservation: false,
    visitDetected:    false,
    churnDetected:    false,
  };
}

module.exports = { analyzeInquiry };
