/**
 * キャンセル・日程変更受付フロー（シンプル版）
 *
 * ■ フロー概要（2ステップ）
 *   STEP1: リッチメニュー「キャンセル・日程変更」ボタン押下
 *     ↓ AIが1通の案内メッセージを自動送信
 *         （①キャンセル希望日時 ＋ ②変更後の希望日時を3つ、をまとめて聞く）
 *     ↓ state: cancel_flow_wait_response
 *
 *   STEP2: ユーザーが何かしら返信
 *     ↓ AIが「受付しました。後ほどスタッフがご連絡します」と自動送信
 *     ↓ state: null（フロー終了。以降AIは自動返信しない）
 *
 * ■ ルール
 *   - 日時の解析・空き状況案内・予約確定はAIが行わない（スタッフが対応）
 *   - 1往復だけAIが自動応答し、その後は自動でフローを終了する
 *   - 絵文字を使わない
 */

const { updateUserData } = require('./redis');

// ---- state 定数 -------------------------------------------------------------

const STATES = {
  // ユーザーからの返信を待っている状態（1ステップのみ）
  WAIT_RESPONSE: 'cancel_flow_wait_response',
};

// ---- 固定返信テキスト -------------------------------------------------------

const MESSAGES = {
  /** リッチメニュー押下直後に送る案内（1通にまとめる）*/
  START:
`ご連絡ありがとうございます。
キャンセル・日程変更を承ります。

以下の2点を、まとめてご返信ください。

①キャンセルをご希望の予約日時
②変更後のご希望日時（3つほど）

例
①6月20日 15:00
②6月25日 午前中／6月26日 15:00以降／6月28日 18:00以降

変更後の日時が未定の場合は、①のみご返信ください。`,

  /** ユーザーの返信を受け付けた後（フロー終了）*/
  ACCEPTED:
`スタッフが後ほどご連絡いたします。
今しばらくお待ちください。`,
};

/** キャンセルフローの自動タイムアウト時間（時間単位） */
const CANCEL_FLOW_TIMEOUT_HOURS = 1;

/**
 * cancelFlowState に保存された開始時刻からタイムアウトを判定する。
 * @param {string|null} cancelFlowStartAt - ISO日時文字列
 * @returns {boolean} タイムアウトなら true
 */
function isCancelFlowTimedOut(cancelFlowStartAt) {
  if (!cancelFlowStartAt) return false;
  const elapsedHours = (Date.now() - new Date(cancelFlowStartAt).getTime()) / (1000 * 60 * 60);
  return elapsedHours >= CANCEL_FLOW_TIMEOUT_HOURS;
}

// ---- メインハンドラ ---------------------------------------------------------

/**
 * キャンセルフローのエントリーポイント。
 * webhook.js の handleEvent() から呼び出す。
 *
 * @param {object} opts
 * @param {string} opts.replyToken
 * @param {string} opts.userId
 * @param {string} opts.displayName
 * @param {string} opts.userText
 * @param {string|null} opts.cancelFlowState  - 現在のフロー state（Redisから）
 * @param {Function} opts.reply               - webhook.js の reply 関数
 * @param {Function} opts.logHistory          - appendHistory ラッパー
 * @param {Function} opts.safe                - safe ラッパー
 * @returns {Promise<boolean>} このフローで処理した場合 true、対象外なら false
 */
async function handleCancelFlow({ replyToken, userId, displayName, userText, cancelFlowState, reply, logHistory, safe }) {

  // ---- STEP1: フロー開始（リッチメニュー押下）-------------------------------
  if (cancelFlowState === null || cancelFlowState === undefined) {
    await safe('cancelFlow state 設定', () =>
      updateUserData(userId, {
        cancelFlowState:    STATES.WAIT_RESPONSE,
        cancelFlowStartAt:  new Date().toISOString(),
        lastMessageAt:      new Date().toISOString(),
      })
    );
    await logHistory({ userId, displayName, eventType: 'キャンセルフロー開始', content: '' });
    await reply(replyToken, MESSAGES.START);
    return true;
  }

  // ---- STEP2: ユーザーの返信を受け付けてフロー終了 --------------------------
  // どんな返信であっても1通で受付完了とし、以降はスタッフが対応する。
  if (cancelFlowState === STATES.WAIT_RESPONSE) {
    await safe('cancelFlow 終了（受付完了）', () =>
      updateUserData(userId, {
        cancelFlowState:  null,
        cancelRequest:    userText,
        lastMessageAt:    new Date().toISOString(),
      })
    );
    await logHistory({
      userId, displayName,
      eventType: 'キャンセル・日程変更受付',
      content:   userText,
    });
    await reply(replyToken, MESSAGES.ACCEPTED);
    return true;
  }

  // 対象外（あり得ないが安全のため）
  return false;
}

module.exports = {
  CANCEL_FLOW_STATES:        STATES,
  CANCEL_FLOW_START_MESSAGE: MESSAGES.START,
  isCancelFlowTimedOut,
  handleCancelFlow,
};
