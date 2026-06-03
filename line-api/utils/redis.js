/**
 * Upstash Redis ユーティリティ（会話履歴・ユーザー状態・問診状態の管理）
 *
 * 必要な環境変数:
 *   UPSTASH_REDIS_REST_URL   : Upstash コンソールの REST URL
 *   UPSTASH_REDIS_REST_TOKEN : Upstash コンソールの REST Token
 *
 * Redisに保存するデータ構造（キー: "user:{userId}"）:
 *   {
 *     mode:           'ai' | 'human' | 'completed',  // 対応モード
 *     inquiryStep:    0〜7,                           // 問診の現在ステップ
 *     inquiryAnswers: { symptom, duration, ... },     // 各質問の回答
 *     history:        [{ role, content }, ...],       // AI会話履歴（最大6件）
 *     latestRow:      3,                              // Sheetsの最新行番号
 *     lastMessageAt:  "2024-01-01T00:00:00Z",         // 最終メッセージ日時
 *   }
 *
 * TTL: 86400秒（24時間）= メッセージがなければ会話・問診状態をリセット
 */

const { Redis } = require('@upstash/redis');

// ---- クライアント（遅延初期化）------------------------------------------

let _redis = null;

function getClient() {
  if (!_redis) {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error('[redis.js] UPSTASH_REDIS_REST_URL/TOKEN が未設定です。');
    }
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

const HISTORY_LIMIT = 6;   // 保持する会話の最大数（3往復）
const TTL_SECONDS   = 86400; // 24時間

// ---- 基本操作 ------------------------------------------------------------

/**
 * ユーザーの全データを取得する
 */
async function getUserData(userId) {
  return (await getClient().get(`user:${userId}`)) ?? {};
}

/**
 * ユーザーデータを部分更新する（指定したフィールドだけ上書き）
 */
async function updateUserData(userId, updates) {
  const key      = `user:${userId}`;
  const existing = (await getClient().get(key)) ?? {};
  await getClient().set(key, { ...existing, ...updates }, { ex: TTL_SECONDS });
}

// ---- 会話履歴 ------------------------------------------------------------

/**
 * 会話履歴のみを取得する（OpenAI の messages 配列形式）
 */
async function getConversationHistory(userId) {
  const data = await getClient().get(`user:${userId}`);
  return data?.history ?? [];
}

/**
 * 1往復分の会話を追加して保存する（最新6件に切り詰め）
 * @param {string} userId
 * @param {string} userMessage    - ユーザー発言
 * @param {string} assistantReply - AIの返答
 * @param {Object} [extra]        - 同時に更新したい他のフィールド
 */
async function saveConversation(userId, userMessage, assistantReply, extra = {}) {
  const key      = `user:${userId}`;
  const existing = (await getClient().get(key)) ?? {};
  const history  = existing.history ?? [];

  history.push({ role: 'user',      content: userMessage   });
  history.push({ role: 'assistant', content: assistantReply });

  const trimmed = history.slice(-HISTORY_LIMIT); // 古い履歴を切り捨て

  await getClient().set(key, {
    ...existing,
    ...extra,
    history:       trimmed,
    lastMessageAt: new Date().toISOString(),
  }, { ex: TTL_SECONDS });

  return trimmed;
}

// ---- 対応モード ----------------------------------------------------------
//
//   'ai'        : AI対応中（デフォルト。OpenAIが自動返信）
//   'human'     : 有人対応中（スタッフ対応。AIは返信しない）
//   'completed' : 問診完了

/**
 * 現在の対応モードを取得する（未設定時は 'ai'）
 */
async function getMode(userId) {
  const data = await getClient().get(`user:${userId}`);
  return data?.mode ?? 'ai';
}

/**
 * 対応モードを変更する
 */
async function setMode(userId, mode) {
  await updateUserData(userId, { mode });
}

// ---- 問診ステップ管理 ---------------------------------------------------
//
// step の意味:
//   0     : 問診未開始
//   1〜6  : 各質問を待っている状態
//   7以上 : 全問終了

/**
 * 現在の問診ステップを取得する（0=未開始）
 */
async function getInquiryStep(userId) {
  const data = await getClient().get(`user:${userId}`);
  return data?.inquiryStep ?? 0;
}

/**
 * 問診を開始する（stepを1にリセット、回答をクリア）
 */
async function startInquiry(userId) {
  await updateUserData(userId, {
    inquiryStep:    1,
    inquiryAnswers: {},
  });
}

/**
 * 現在のステップの回答を保存し、次のステップに進める
 * @param {string} userId
 * @param {string} answerKey - 回答を保存するフィールド名（例: 'symptom'）
 * @param {string} answer    - ユーザーの回答テキスト
 * @returns {Promise<number>} 更新後のステップ番号
 */
async function saveAnswerAndAdvance(userId, answerKey, answer) {
  const key      = `user:${userId}`;
  const existing = (await getClient().get(key)) ?? {};

  const answers  = existing.inquiryAnswers ?? {};
  answers[answerKey] = answer; // 回答を保存

  const nextStep = (existing.inquiryStep ?? 1) + 1;

  await getClient().set(key, {
    ...existing,
    inquiryAnswers: answers,
    inquiryStep:    nextStep,
    lastMessageAt:  new Date().toISOString(),
  }, { ex: TTL_SECONDS });

  return nextStep;
}

/**
 * 問診を終了状態にリセットする（完了・中断時）
 */
async function resetInquiry(userId) {
  await updateUserData(userId, {
    inquiryStep:    0,
    inquiryAnswers: {},
  });
}

/**
 * 現在の問診回答データを取得する
 */
async function getInquiryAnswers(userId) {
  const data = await getClient().get(`user:${userId}`);
  return data?.inquiryAnswers ?? {};
}

module.exports = {
  getUserData,
  updateUserData,
  getConversationHistory,
  saveConversation,
  getMode,
  setMode,
  getInquiryStep,
  startInquiry,
  saveAnswerAndAdvance,
  resetInquiry,
  getInquiryAnswers,
};
