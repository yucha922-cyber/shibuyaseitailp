/**
 * キャンセル・日程変更受付フロー
 *
 * ■ フロー概要
 *   リッチメニュー「キャンセル・日程変更」ボタン押下
 *     ↓ AIが「キャンセル希望日時を教えてください」と返信
 *     ↓ state: cancel_flow_wait_cancel_date
 *
 *   STEP2: ユーザーが日時を返信
 *     ├ 日時が取得できた場合
 *     │   ↓ 「承知しました。別日のご希望があればどうぞ」と返信
 *     │   ↓ state: cancel_flow_wait_new_dates
 *     └ 日時不明の場合（「分からない」「忘れた」等）
 *         ↓ 「お分かりになりましたら再度ご連絡ください」と返信
 *         ↓ state: null（終了）
 *
 *   STEP3: ユーザーが新しい希望日時を返信（state: cancel_flow_wait_new_dates）
 *     ├ 日時が1つ以上送られた場合
 *     │   ↓ 「受付しました。スタッフより折り返し連絡します」と返信
 *     │   ↓ state: null（終了）
 *     └ 未定の場合（「未定」「また連絡」等）
 *         ↓ 「ご都合が決まりましたらご連絡ください」と返信
 *         ↓ state: null（終了）
 *
 * ■ AI ルール
 *   - 空き状況を案内しない
 *   - 予約を確定しない
 *   - スタッフの代わりに日程調整しない
 *   - 必要最低限のヒアリングのみ
 *   - 絵文字を使わない
 */

const OpenAI = require('openai').default ?? require('openai');
const { updateUserData } = require('./redis');

// ---- OpenAI クライアント（遅延初期化）--------------------------------------

let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// ---- state 定数 -------------------------------------------------------------

const STATES = {
  WAIT_CANCEL_DATE : 'cancel_flow_wait_cancel_date',
  WAIT_NEW_DATES   : 'cancel_flow_wait_new_dates',
};

// ---- 固定返信テキスト -------------------------------------------------------

const MESSAGES = {
  /** リッチメニュー押下直後 */
  START:
`ご連絡ありがとうございます。

キャンセルをご希望のご予約日時を教えてください。

例
・6月20日 15:00
・明日 18時
・来週金曜日 10時

日時がお分かりにならない場合は、「分からない」とご返信ください。`,

  /** キャンセル日時を受け付けた後（別日希望ヒアリング） */
  CANCEL_ACCEPTED:
`承知いたしました。

キャンセル内容／送信内容を受付いたしました。

別日でのご予約をご希望の場合は、ご希望日時を3つほどご返信ください。

例
・6月25日 午前中
・6月26日 15:00以降
・6月28日 18:00以降

ご希望日時が未定の場合は、「未定」とご返信ください。`,

  /** 時間の長さだけの変更（短縮・延長など）を受け付けた場合 */
  DURATION_CHANGE_ACCEPTED:
`承知いたしました。

ご予約時間の変更内容を受付いたしました。

スタッフが予約状況を確認のうえ、後ほどご返信いたします。

今しばらくお待ちください。`,

  /** 日時が分からなかった場合（STEP2 パターンB） */
  CANCEL_DATE_UNKNOWN:
`承知いたしました。

ご予約日時がお分かりになりましたら、再度ご連絡ください。

スタッフにて確認が必要な場合は、後ほどご連絡させていただくことがございます。`,

  /** 新しい希望日時を受け付けた（STEP3） */
  NEW_DATES_ACCEPTED:
`承知いたしました。

ご希望日時を受付いたしました。

スタッフが予約状況を確認のうえ、後ほどご返信いたします。

今しばらくお待ちください。`,

  /** 新しい日時が未定（STEP3） */
  NEW_DATES_UNDECIDED:
`承知いたしました。

またご都合よろしい日がありましたらご連絡ください。`,
};

// ---- キーワードによる事前判定 -----------------------------------------------

/**
 * 「日時不明・未定」を示すキーワード。
 * AIを呼ぶ前にコードで判定し、誤判定を防ぐ。
 */
const UNDECIDED_KEYWORDS = [
  '未定', 'わからない', '分からない', '分かりません', 'わかりません',
  '忘れた', '忘れました', '確認してから', '確認します', 'また連絡',
  'また連絡します', 'また後で', 'まだ決まっていない', 'まだ決まってない',
  'まだわかりません', 'まだわからない', '決まったら', '決まり次第',
];

/**
 * 「操作ミス・間違い」を示すキーワード。
 * フロー進行中にこれらが来た場合はフローを終了し、次の質問を送らない。
 */
const MISTAKE_KEYWORDS = [
  '間違え', '間違い', 'まちがえ', 'まちがい',
  '誤って', '誤り', '違います', 'ちがいます',
  '押し間違', '押間違', '押し間違い', '押間違い',
  '選び間違', '選び間違い',
  'すみません間違', 'ごめんなさい',
  '関係ないです', '別の件', 'キャンセルしません', '取り消し',
];

/** キャンセルフローの自動タイムアウト時間（時間単位） */
const CANCEL_FLOW_TIMEOUT_HOURS = 1;

function isUndecidedText(text) {
  const normalized = text.trim().toLowerCase();
  return UNDECIDED_KEYWORDS.some((kw) => normalized.includes(kw));
}

/**
 * テキストが「操作ミス・間違い」を示すかチェックする。
 */
function isMistakeText(text) {
  const normalized = text.trim().toLowerCase();
  return MISTAKE_KEYWORDS.some((kw) => normalized.includes(kw));
}

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

// ---- AI による日時解析 ------------------------------------------------------

/**
 * ユーザーメッセージから日時情報または「不明」を判定する。
 * まずキーワードで事前判定し、判断できない場合のみ AI を呼ぶ。
 *
 * @param {string} userText
 * @param {'cancel_date'|'new_dates'} mode
 * @returns {Promise<{detected: boolean, summary: string, intent?: string}>}
 *   detected: 日時（または候補日時）が含まれていれば true
 *   summary:  スタッフ向けの日時テキスト（Sheets記録用）
 *   intent:   cancel_date モード時のみ 'duration_change'（時間の長さだけの変更）
 *             または 'cancel'（キャンセル・日程変更）
 */
async function extractDateInfo(userText, mode) {
  // キーワードで「未定・分からない」と確定できる場合は AI を呼ばない
  if (isUndecidedText(userText)) {
    return { detected: false, summary: '' };
  }

  const systemPrompt = mode === 'cancel_date'
    ? `あなたはユーザーの返信から予約の変更内容を読み取るアシスタントです。
- 日時・曜日・時間帯・「明日」「来週」などの相対表現が含まれていれば detected: true にしてください。そうでなければ detected: false。
- intent は次のいずれかにしてください:
  - "duration_change": 予約の日付は変えず、施術時間の長さ（枠）だけを変えたい場合（例:「1時間を30分に変更したい」「30分を60分に延ばしたい」）
  - "cancel": 予約自体のキャンセル、または別日への日程変更を希望している場合
以下のJSON形式のみで返答してください:
{"detected": true|false, "intent": "duration_change"|"cancel", "summary": "抽出した日時・変更内容（例: 6月18日14時の枠を30分に短縮）または空文字"}`
    : `あなたはユーザーの返信から希望日時の候補を抽出するアシスタントです。
1つでも日時・曜日・時間帯の候補が含まれていれば detected: true にしてください。
そうでない場合は detected: false にしてください。
以下のJSON形式のみで返答してください:
{"detected": true|false, "summary": "抽出した候補日時（例: 来週月曜午前、水曜18時以降）または空文字"}`;

  try {
    const res = await getOpenAI().chat.completions.create({
      model:           process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens:      200,
      temperature:     0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userText },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content ?? '{}');
    return {
      detected: parsed.detected === true,
      summary:  String(parsed.summary ?? ''),
      intent:   parsed.intent === 'duration_change' ? 'duration_change' : 'cancel',
    };
  } catch (err) {
    console.error('[cancelFlow] AI日時解析エラー:', err.message);
    // フォールバック: エラー時は「日時あり」として扱い次ステップへ進める
    return { detected: true, summary: userText.slice(0, 50), intent: 'cancel' };
  }
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
    // このケースは webhook.js 側でリッチメニュー判定後に呼ぶ想定だが
    // 念のため state がない場合もここで開始できるようにしておく
    await safe('cancelFlow state 設定', () =>
      updateUserData(userId, {
        cancelFlowState:    STATES.WAIT_CANCEL_DATE,
        cancelFlowStartAt:  new Date().toISOString(),
        lastMessageAt:      new Date().toISOString(),
      })
    );
    await logHistory({ userId, displayName, eventType: 'キャンセルフロー開始', content: '' });
    await reply(replyToken, MESSAGES.START);
    return true;
  }

  // ---- 間違いキーワード検出 → フロー即終了（次の質問を送らない）-----------
  // STEP2・STEP3 共通。フロー進行中に「間違えました」等が来た場合は静かに終了。
  if (isMistakeText(userText)) {
    await safe('cancelFlow 終了（操作ミス）', () =>
      updateUserData(userId, {
        cancelFlowState: null,
        lastMessageAt:   new Date().toISOString(),
      })
    );
    await logHistory({ userId, displayName, eventType: 'キャンセルフロー終了', content: '操作ミスによる終了' });
    return true; // 返信はしない（replyしないでtrueを返す）
  }

  // ---- STEP2: キャンセル日時の入力待ち --------------------------------------
  if (cancelFlowState === STATES.WAIT_CANCEL_DATE) {
    const { detected, summary, intent } = await extractDateInfo(userText, 'cancel_date');

    if (detected && intent === 'duration_change') {
      // パターンC: 日付は変えず、施術時間の長さだけの変更（短縮・延長）
      // 別日候補のヒアリングは不要なのでフローを終了する
      await safe('cancelFlow 終了（時間変更）', () =>
        updateUserData(userId, {
          cancelFlowState:  null,
          cancelDate:       summary || userText,
          lastMessageAt:    new Date().toISOString(),
        })
      );
      await logHistory({
        userId, displayName,
        eventType: 'キャンセルフロー終了',
        content:   `施術時間の変更希望: ${summary || userText}`,
      });
      await reply(replyToken, MESSAGES.DURATION_CHANGE_ACCEPTED);
    } else if (detected) {
      // パターンA: 日時を取得できた（キャンセル・日程変更）
      await safe('cancelFlow state → wait_new_dates', () =>
        updateUserData(userId, {
          cancelFlowState:   STATES.WAIT_NEW_DATES,
          cancelDate:        summary || userText,
          lastMessageAt:     new Date().toISOString(),
        })
      );
      await logHistory({
        userId, displayName,
        eventType: 'キャンセル日時受付',
        content:   `キャンセル希望日時: ${summary || userText}`,
      });
      await reply(replyToken, MESSAGES.CANCEL_ACCEPTED);
    } else {
      // パターンB: 日時が分からない
      await safe('cancelFlow 終了（日時不明）', () =>
        updateUserData(userId, {
          cancelFlowState:  null,
          cancelDate:       '日時不明',
          lastMessageAt:    new Date().toISOString(),
        })
      );
      await logHistory({
        userId, displayName,
        eventType: 'キャンセルフロー終了',
        content:   'キャンセル日時: 不明',
      });
      await reply(replyToken, MESSAGES.CANCEL_DATE_UNKNOWN);
    }
    return true;
  }

  // ---- STEP3: 新しい希望日時の入力待ち --------------------------------------
  if (cancelFlowState === STATES.WAIT_NEW_DATES) {
    const { detected, summary } = await extractDateInfo(userText, 'new_dates');

    if (detected) {
      // 候補日時あり
      await safe('cancelFlow 終了（希望日時受付）', () =>
        updateUserData(userId, {
          cancelFlowState:  null,
          newDateRequests:  summary || userText,
          lastMessageAt:    new Date().toISOString(),
        })
      );
      await logHistory({
        userId, displayName,
        eventType: 'キャンセルフロー終了',
        content:   `希望日時: ${summary || userText}`,
      });
      await reply(replyToken, MESSAGES.NEW_DATES_ACCEPTED);
    } else {
      // 未定
      await safe('cancelFlow 終了（希望日時未定）', () =>
        updateUserData(userId, {
          cancelFlowState:  null,
          newDateRequests:  '未定',
          lastMessageAt:    new Date().toISOString(),
        })
      );
      await logHistory({
        userId, displayName,
        eventType: 'キャンセルフロー終了',
        content:   '希望日時: 未定',
      });
      await reply(replyToken, MESSAGES.NEW_DATES_UNDECIDED);
    }
    return true;
  }

  // 対象外（あり得ないが安全のため）
  return false;
}

module.exports = {
  CANCEL_FLOW_STATES:       STATES,
  CANCEL_FLOW_START_MESSAGE: MESSAGES.START,
  isCancelFlowTimedOut,
  handleCancelFlow,
};
