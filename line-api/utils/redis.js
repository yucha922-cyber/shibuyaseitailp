/**
 * Upstash Redis ユーティリティ（会話履歴・ユーザー状態の管理）
 *
 * 役割:
 *   LINEユーザーごとの会話履歴と状態（来院回数・最新行番号など）を
 *   サーバーレス環境(Vercel)でも永続化するためのRedisラッパー。
 *
 * 必要な環境変数:
 *   UPSTASH_REDIS_REST_URL   : Upstash コンソールの REST URL
 *   UPSTASH_REDIS_REST_TOKEN : Upstash コンソールの REST Token
 *
 * データ構造（Redis キー: "user:{userId}"）:
 *   {
 *     history: [{ role, content }, ...],  // 会話履歴（最大6件）
 *     latestRow: 3,                        // Sheetsの最新行番号
 *     visitCount: 2,                       // 来院回数
 *     lastMessageAt: "2024-01-01T...",     // 最終メッセージ日時
 *   }
 *
 * TTL: 86400秒（24時間）= 24時間メッセージがなければ会話リセット
 */

const { Redis } = require('@upstash/redis');

// ---- クライアント（遅延初期化）------------------------------------------
// モジュール読み込み時ではなく実際に使う時に初期化することで、
// 環境変数未設定でも起動エラーにならないようにする

let _redis = null;

function getClient() {
  if (!_redis) {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error(
        '[redis.js] UPSTASH_REDIS_REST_URL または UPSTASH_REDIS_REST_TOKEN が未設定です。'
      );
    }
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

// ---- 定数 ---------------------------------------------------------------

// 保持する会話メッセージ数（user + assistant で1往復 = 2件）
// 6件 = 3往復分の文脈
const HISTORY_LIMIT = 6;

// 会話の有効期間（秒）。この間メッセージがなければ履歴はリセットされる
const TTL_SECONDS = 86400; // 24時間

// ---- 関数 ---------------------------------------------------------------

/**
 * ユーザーの会話履歴を取得する
 * @param {string} userId - LINE の userId
 * @returns {Promise<Array>} OpenAI messages 形式の配列
 */
async function getConversationHistory(userId) {
  const data = await getClient().get(`user:${userId}`);
  return data?.history ?? [];
}

/**
 * 会話を記録し、最新6件に切り詰めて保存する
 *
 * @param {string} userId          - LINE の userId
 * @param {string} userMessage     - ユーザーのメッセージ
 * @param {string} assistantReply  - AIの返答
 * @param {Object} [extra]         - 追加で保存するデータ（latestRow など）
 * @returns {Promise<Array>}       保存後の履歴
 */
async function saveConversation(userId, userMessage, assistantReply, extra = {}) {
  const key = `user:${userId}`;

  // 既存データを取得（なければ空オブジェクト）
  const existing = (await getClient().get(key)) ?? {};
  const history  = existing.history ?? [];

  // 今回の1往復を追加
  history.push({ role: 'user',      content: userMessage   });
  history.push({ role: 'assistant', content: assistantReply });

  // 古い履歴を切り捨てて最新 HISTORY_LIMIT 件だけ残す
  const trimmed = history.slice(-HISTORY_LIMIT);

  // 保存データを構築（既存データとマージ）
  const toSave = {
    ...existing,
    ...extra,
    history:       trimmed,
    lastMessageAt: new Date().toISOString(),
  };

  // TTL 付きで保存（TTL_SECONDS 秒後に自動削除）
  await getClient().set(key, toSave, { ex: TTL_SECONDS });

  return trimmed;
}

/**
 * ユーザーの全データを取得する
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getUserData(userId) {
  return (await getClient().get(`user:${userId}`)) ?? {};
}

/**
 * ユーザーデータを部分更新する（指定したフィールドだけ上書き）
 * @param {string} userId
 * @param {Object} updates - 更新するフィールドと値
 */
async function updateUserData(userId, updates) {
  const key      = `user:${userId}`;
  const existing = (await getClient().get(key)) ?? {};
  await getClient().set(key, { ...existing, ...updates }, { ex: TTL_SECONDS });
}

// ---- 対応モード管理 ------------------------------------------------------
//
// モードは3種類:
//   'ai'        : AI対応中（通常。OpenAIが自動返信）
//   'human'     : 有人対応中（スタッフが対応。AIは返信しない）
//   'completed' : 問診完了（対応終了）
//
// モードはユーザーデータの "mode" フィールドに保存される。

/**
 * ユーザーの現在の対応モードを取得する
 * @param {string} userId
 * @returns {Promise<string>} 'ai' / 'human' / 'completed'（未設定時は 'ai'）
 */
async function getMode(userId) {
  const data = await getClient().get(`user:${userId}`);
  return data?.mode ?? 'ai'; // デフォルトはAI対応
}

/**
 * ユーザーの対応モードを変更する
 * @param {string} userId
 * @param {string} mode - 'ai' / 'human' / 'completed'
 */
async function setMode(userId, mode) {
  await updateUserData(userId, { mode });
}

module.exports = {
  getConversationHistory,
  saveConversation,
  getUserData,
  updateUserData,
  getMode,
  setMode,
};
