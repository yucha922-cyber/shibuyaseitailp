/**
 * OpenAI API ユーティリティ（NAORU整体 AI問診）
 *
 * 役割:
 *   LINEユーザーのメッセージを受け取り、OpenAI GPTを使って
 *   NAORU整体のコンセプトに沿った自然な問診返答と分析データを返す。
 *
 * 必要な環境変数:
 *   OPENAI_API_KEY : OpenAI のAPIキー
 *   OPENAI_MODEL   : 使用するモデル（省略時: gpt-4o-mini）
 *
 * 返り値の構造（AIResponse）:
 *   replyText    : LINEに送る自然な日本語の返答
 *   symptomType  : 症状タイプ（例: 筋肉疲労型、神経圧迫型）
 *   postureType  : 姿勢タイプ（例: 猫背型、反り腰型）
 *   stress       : ストレス傾向（高/中/低）
 *   deskWork     : デスクワーク傾向（高/中/低）
 *   riskScore    : 危険度スコア（1〜5、5が最も要注意）
 *   aiSummary    : スプレッドシート保存用のAI要約（1〜2文）
 *   needsReservation : 予約を強く勧めるべきか（true/false）
 */

const OpenAI = require('openai');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ---- OpenAI クライアント（遅延初期化）--------------------------------------
// モジュール読み込み時ではなく、実際に使う時に初期化することで
// 環境変数が未設定でも起動エラーにならないようにする

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

// ---- システムプロンプト（NAORU整体のコンセプトを定義） ---------------------
//
// ここを変更するだけでAIの返答スタイル・分析軸を調整できます。
// キャラクター・価値観・分析フレームはすべてここで管理します。

const SYSTEM_PROMPT = `
あなたはNAORU整体 渋谷院のAI問診アシスタントです。

【院のコンセプト】
- 「根本改善」を最優先とする整体院です
- 症状を「姿勢だけ」「骨格だけ」と決めつけず、以下を総合的に評価します:
  - 筋肉（緊張・疲労・柔軟性）
  - 関節（可動域・炎症）
  - 神経（圧迫・過敏）
  - 血流（滞り・冷え）
  - 生活習慣（睡眠・食事・運動）
  - ストレス（精神的・身体的）
  - 姿勢（構造的なバランス）

【あなたの役割】
1. ユーザーの症状に共感し、原因の仮説を1〜2つ提示する
2. 深掘りのための質問を1つだけ追加する（多すぎると離脱する）
3. 危険度が高い場合（しびれ・激痛・発熱・急な頭痛など）は医療機関受診を促す
4. 自然な流れでNAORU整体への予約を案内する（押しつけにならないよう注意）

【返答スタイル】
- 親しみやすく、専門的すぎず
- 一方的に断言せず「〜の可能性があります」「〜かもしれません」のような表現を使う
- 絵文字は使わない
- 200文字以内を目安に（LINEで読みやすい長さ）

【分析データ（JSON形式で必ず返すこと）】
返答は必ず以下のJSON形式のみで返してください。他のテキストは含めないでください。

{
  "replyText": "LINEに表示するユーザー向けの自然な問診返答（200文字以内）",
  "symptomType": "症状タイプ（例: 筋肉疲労型 / 神経圧迫型 / 血流不全型 / 関節可動域制限型 / 複合型 / 不明）",
  "postureType": "姿勢タイプ（例: 猫背型 / 反り腰型 / 側弯傾向 / 前傾骨盤型 / 後傾骨盤型 / 不明）",
  "stress": "ストレス傾向（高 / 中 / 低 / 不明）",
  "deskWork": "デスクワーク傾向（高 / 中 / 低 / 不明）",
  "riskScore": 危険度スコア（整数1〜5、1=軽微、5=要医療受診）,
  "aiSummary": "スプレッドシート管理用の要約（1〜2文、スタッフが読む内部メモ）",
  "needsReservation": true または false（整体施術を強く勧める場合はtrue）
}
`.trim();

// ---- メイン関数 -----------------------------------------------------------

/**
 * ユーザーのメッセージをAIに送り、問診結果を返す
 *
 * @param {string} userMessage - ユーザーがLINEで送ったテキスト
 * @param {string} [conversationHistory] - 過去のやり取り（将来の文脈対応用、現在は未使用）
 * @returns {Promise<AIResponse>} AI分析結果
 *
 * @typedef {Object} AIResponse
 * @property {string} replyText
 * @property {string} symptomType
 * @property {string} postureType
 * @property {string} stress
 * @property {string} deskWork
 * @property {number} riskScore
 * @property {string} aiSummary
 * @property {boolean} needsReservation
 */
async function analyzeInquiry(userMessage) {
  // OpenAI APIへリクエストを送る
  const completion = await getClient().chat.completions.create({
    model: MODEL,
    // JSON形式の返答を強制（モデルが対応している場合）
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        // ユーザーの症状をAIに渡す（将来は会話履歴も含められる）
        content: `ユーザーからのメッセージ: ${userMessage}`,
      },
    ],
    // トークン上限（長すぎる返答を防ぐ）
    max_tokens: 600,
    // 返答の多様性（0に近いほど安定した返答、1に近いほど創造的）
    temperature: 0.7,
  });

  // APIからのテキスト取得
  const rawText = completion.choices[0]?.message?.content ?? '';

  // JSON をパース
  let result;
  try {
    result = JSON.parse(rawText);
  } catch {
    // JSONパース失敗時はフォールバック（サービスを止めないため）
    console.error('[openai.js] JSONパース失敗:', rawText);
    return buildFallbackResponse(userMessage);
  }

  // 必須フィールドが欠けている場合もフォールバックで補完
  return {
    replyText:        result.replyText        ?? buildFallbackResponse().replyText,
    symptomType:      result.symptomType      ?? '不明',
    postureType:      result.postureType      ?? '不明',
    stress:           result.stress           ?? '不明',
    deskWork:         result.deskWork         ?? '不明',
    riskScore:        result.riskScore        ?? 1,
    aiSummary:        result.aiSummary        ?? '',
    needsReservation: result.needsReservation ?? false,
  };
}

/**
 * APIエラー時や解析失敗時のフォールバック返答
 * ユーザーには自然に見えるよう、エラーを露出させない
 */
function buildFallbackResponse() {
  return {
    replyText:
      'ご連絡ありがとうございます。\n詳しい状況をお聞かせください。いつ頃から、どのような時につらさを感じますか？',
    symptomType:      '不明',
    postureType:      '不明',
    stress:           '不明',
    deskWork:         '不明',
    riskScore:        1,
    aiSummary:        'AI問診エラー（フォールバック応答）',
    needsReservation: false,
  };
}

module.exports = { analyzeInquiry };
