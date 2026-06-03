/**
 * NAORU整体 渋谷院 LINE Webhook
 *
 * 処理フロー:
 *   LINEメッセージ受信
 *     → Redis から会話履歴・最新行番号を取得
 *     → OpenAI で AI問診（文脈付き）
 *     → LINE に返答
 *     → Google Sheets に問診データを追記（行番号を取得）
 *     → Redis に会話履歴・行番号を保存
 *     → 来院/離反を検出した場合はシートのK/L/M列を更新
 */

const express = require('express');
const line    = require('@line/bot-sdk');
const { analyzeInquiry }                                   = require('../utils/openai');
const { appendToSheet, updateUserStatus, updateSupportStatus } = require('../utils/sheets');
const { getConversationHistory, saveConversation, getUserData, getMode, setMode } = require('../utils/redis');

// ---- LINE Bot 設定 -------------------------------------------------------

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET,
};

const RESERVE_URL = 'https://reserve.naoru.info/';
const TEL         = '070-8519-6347';

// ---- 対応モード切替キーワード --------------------------------------------
//
// これらのキーワードが含まれると「有人対応モード」に切り替わり、
// 以降AIは返信せず、スタッフが対応する状態になる。

const HUMAN_KEYWORDS = ['予約', '予約したい', 'よやく', '人と話したい', 'スタッフ', 'オペレーター', '担当者', '電話で話したい'];

// 管理者・ユーザーがAI対応モードに戻すためのキーワード（リセット用）
// スタッフがLINE公式アカウントの管理画面から、このキーワードを送るか、
// ユーザーに送ってもらうことでAIモードに復帰できる。
const RESET_KEYWORDS = ['#ai', '＃ai', 'AI再開', 'AIに戻す', 'AI問診'];

// 対応完了にするキーワード（スタッフ用）
const COMPLETE_KEYWORDS = ['#完了', '＃完了', '対応完了', '問診完了'];

const client = new line.Client(config);
const app    = express();

// ---- ルーティング --------------------------------------------------------

app.get('/api/webhook', (_req, res) => {
  res.status(200).send('NAORU LINE webhook is running.');
});

app.post('/api/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('[webhook] イベント処理エラー:', err);
    res.status(500).end();
  }
});

// ---- ユーティリティ -------------------------------------------------------

function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

async function getDisplayName(userId) {
  if (!userId) return '不明';
  try {
    const profile = await client.getProfile(userId);
    return profile.displayName;
  } catch {
    return '不明';
  }
}

/**
 * Sheets保存をバックグラウンド実行し、行番号を返す
 * 失敗してもLINE返信は止めない
 * @returns {Promise<number|null>}
 */
async function saveToSheetSafe(params) {
  try {
    return await appendToSheet(params);
  } catch (err) {
    console.error('[webhook] Sheets保存失敗:', err.message);
    return null;
  }
}

/**
 * K/L/M列の更新をバックグラウンド実行
 * 失敗してもLINE返信は止めない
 */
async function updateStatusSafe(rowNumber, statuses) {
  try {
    await updateUserStatus(rowNumber, statuses);
  } catch (err) {
    console.error('[webhook] Sheetsステータス更新失敗:', err.message);
  }
}

/**
 * Redis操作をバックグラウンド実行
 * Redisが使えなくてもLINE返信は止めない
 */
async function saveConversationSafe(userId, userMsg, assistantMsg, extra) {
  try {
    await saveConversation(userId, userMsg, assistantMsg, extra);
  } catch (err) {
    console.error('[webhook] Redis保存失敗:', err.message);
  }
}

/**
 * 対応モードの変更を安全に実行（失敗してもLINE返信は止めない）
 */
async function setModeSafe(userId, mode) {
  try {
    await setMode(userId, mode);
  } catch (err) {
    console.error('[webhook] モード変更失敗:', err.message);
  }
}

/**
 * O列（対応ステータス）更新を安全に実行
 */
async function updateSupportStatusSafe(rowNumber, status) {
  try {
    await updateSupportStatus(rowNumber, status);
  } catch (err) {
    console.error('[webhook] 対応ステータス更新失敗:', err.message);
  }
}

// ---- メインのイベントハンドラ --------------------------------------------

async function handleEvent(event) {

  // ---- フォロー（友だち追加）--------------------------------------------
  if (event.type === 'follow') {
    const userId      = event.source?.userId;
    const displayName = await getDisplayName(userId);

    saveToSheetSafe({
      userId,
      displayName,
      symptom:           '（友だち追加）',
      inquiry:           '',
      reservationStatus: '未予約',
      aiSummary:         '友だち追加イベント',
    });

    return reply(
      event.replyToken,
      `${displayName}さん、NAORU整体 渋谷院です。\n友だち追加ありがとうございます！\n\n現在お悩みの症状をそのままメッセージで送ってください。AIが状態を分析し、最適なご提案をします。\n\n▼ご予約はこちら\n${RESERVE_URL}`
    );
  }

  // テキストメッセージ以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userText    = event.message.text;
  const userId      = event.source?.userId;
  const displayName = await getDisplayName(userId);

  // Redisから「現在の対応モード」「会話履歴」「最新行番号」を取得
  let mode                = 'ai';
  let conversationHistory = [];
  let latestRow           = null;

  try {
    const [currentMode, history, userData] = await Promise.all([
      getMode(userId),
      getConversationHistory(userId),
      getUserData(userId),
    ]);
    mode                = currentMode;
    conversationHistory = history;
    latestRow           = userData.latestRow ?? null;
  } catch (err) {
    // Redis が使えなくてもAIモードで続行する
    console.error('[webhook] Redis取得失敗（AIモードで続行）:', err.message);
  }

  // ---- ① リセットキーワード: 有人 → AI に戻す ---------------------------
  // スタッフ（または案内されたユーザー）が「#ai」等を送るとAIモードに復帰
  if (RESET_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'ai');
    if (latestRow) updateSupportStatusSafe(latestRow, 'AI対応中');
    const replyText = 'AI問診を再開します。\n気になる症状やお悩みをお聞かせください。';
    saveConversationSafe(userId, userText, replyText, {});
    return reply(event.replyToken, replyText);
  }

  // ---- ② 完了キーワード: 問診完了にする（スタッフ用）---------------------
  if (COMPLETE_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'completed');
    if (latestRow) updateSupportStatusSafe(latestRow, '問診完了');
    // 完了時はユーザーへの自動返信はしない（スタッフが締めくくる想定）
    return null;
  }

  // ---- ③ 有人対応モード中: AIを呼ばずスタッフに任せる -------------------
  if (mode === 'human') {
    // ユーザーの発言だけ記録し、AI返信はしない（スタッフが手動で返信）
    saveToSheetSafe({
      userId,
      displayName,
      symptom:           '有人対応',
      inquiry:           userText,
      reservationStatus: '対応中',
      aiSummary:         'スタッフ対応中のメッセージ',
      supportStatus:     '有人対応中',
    });
    return null; // ★AIは返信しない
  }

  // ---- ④ 有人対応モードへの切替キーワードを検出 --------------------------
  // 「予約」「スタッフ」「人と話したい」等で有人対応へ切替
  if (HUMAN_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'human');

    const replyText =
      'ご連絡ありがとうございます。\nスタッフが順次対応いたしますので、少々お待ちください。\n\nお急ぎの場合はお電話でも承ります。\n' + TEL;

    const newRow = await saveToSheetSafe({
      userId,
      displayName,
      symptom:           '有人対応へ切替',
      inquiry:           userText,
      reservationStatus: '対応待ち',
      aiSummary:         'キーワード検出により有人対応へ切替',
      supportStatus:     '有人対応中',
    });
    saveConversationSafe(userId, userText, replyText, { latestRow: newRow ?? latestRow });
    return reply(event.replyToken, replyText);
  }

  // ---- ⑤ 通常のAI問診（mode === 'ai'）-----------------------------------

  // OpenAI に問診を依頼（過去の会話履歴を渡す）
  let aiResult;
  try {
    aiResult = await analyzeInquiry(userText, conversationHistory);
  } catch (err) {
    console.error('[webhook] OpenAI呼び出し失敗:', err.message);
    aiResult = {
      replyText:        'ご連絡ありがとうございます。\nいつ頃から、どのような時につらさを感じますか？',
      symptomType:      'エラー',
      postureType:      '不明',
      stress:           '不明',
      deskWork:         '不明',
      riskScore:        1,
      aiSummary:        'AI問診エラー',
      needsReservation: false,
      visitDetected:    false,
      churnDetected:    false,
    };
  }

  // 危険度・予約推奨に応じて返答に案内文を付加
  let replyText = aiResult.replyText;
  if (aiResult.riskScore >= 4) {
    replyText += `\n\nお身体の状態が気になります。早めにご来院されることをお勧めします。\n▼ご予約\n${RESERVE_URL}`;
  } else if (aiResult.needsReservation) {
    replyText += `\n\n▼ご予約・詳細はこちら\n${RESERVE_URL}`;
  }

  // スプレッドシートに追記し、書き込んだ行番号を取得
  const newRow = await saveToSheetSafe({
    userId,
    displayName,
    symptom:           aiResult.symptomType,
    inquiry:           userText,
    reservationStatus: aiResult.needsReservation ? '予約推奨' : '未予約',
    postureType:       aiResult.postureType,
    stress:            aiResult.stress,
    deskWork:          aiResult.deskWork,
    aiSummary:         `[危険度:${aiResult.riskScore}] ${aiResult.aiSummary}`,
    supportStatus:     'AI対応中',
  });

  // Redisに会話履歴と最新行番号を保存
  saveConversationSafe(userId, userText, aiResult.replyText, {
    latestRow: newRow ?? latestRow, // 新しい行番号を更新
  });

  // 来院を報告するメッセージを検出 → K・L列を更新
  if (aiResult.visitDetected && latestRow) {
    updateStatusSafe(latestRow, { visited: '済', continued: '継続' });
  }

  // 離反・キャンセルを検出 → M列を更新
  if (aiResult.churnDetected && latestRow) {
    updateStatusSafe(latestRow, { churned: '離反' });
  }

  return reply(event.replyToken, replyText);
}

module.exports = app;
