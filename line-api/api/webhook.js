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
const { analyzeInquiry }                      = require('../utils/openai');
const { appendToSheet, updateUserStatus }     = require('../utils/sheets');
const { getConversationHistory, saveConversation, getUserData } = require('../utils/redis');

// ---- LINE Bot 設定 -------------------------------------------------------

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET,
};

const RESERVE_URL = 'https://reserve.naoru.info/';
const TEL         = '070-8519-6347';

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

  // ---- 即答パターン（APIコスト節約・応答速度優先）------------------------

  if (userText.includes('予約') || userText.includes('よやく')) {
    const replyText = `ご予約ありがとうございます！\n\n▼Web予約（24時間受付）\n${RESERVE_URL}\n\n▼お電話\n${TEL}\n\n初回限定 3,500円（通常13,200円）のキャンペーン実施中です。`;
    saveToSheetSafe({ userId, displayName, symptom: '予約希望', inquiry: userText, reservationStatus: '予約希望', aiSummary: 'ユーザーが予約を希望' });
    saveConversationSafe(userId, userText, replyText, {});
    return reply(event.replyToken, replyText);
  }

  if (userText.includes('電話') || userText.includes('tel') || userText.includes('TEL')) {
    const replyText = `お電話はこちらです。\n${TEL}\n\n営業時間: 11:00〜20:00（最終受付19:00）`;
    saveToSheetSafe({ userId, displayName, symptom: '電話問い合わせ', inquiry: userText, reservationStatus: '未予約', aiSummary: '電話番号の問い合わせ' });
    saveConversationSafe(userId, userText, replyText, {});
    return reply(event.replyToken, replyText);
  }

  if (userText.includes('場所') || userText.includes('アクセス') || userText.includes('住所')) {
    const replyText = `NAORU整体 渋谷院は渋谷駅から徒歩圏内です。\n詳しいアクセスはWebサイトをご覧ください。\n\nお電話でもご案内できます。\n${TEL}`;
    saveToSheetSafe({ userId, displayName, symptom: 'アクセス問い合わせ', inquiry: userText, reservationStatus: '未予約', aiSummary: 'アクセスの問い合わせ' });
    saveConversationSafe(userId, userText, replyText, {});
    return reply(event.replyToken, replyText);
  }

  // ---- AI問診（文脈あり）-------------------------------------------------

  // Redisから過去の会話履歴と最新行番号を取得
  let conversationHistory = [];
  let latestRow           = null;

  try {
    const [history, userData] = await Promise.all([
      getConversationHistory(userId),
      getUserData(userId),
    ]);
    conversationHistory = history;
    latestRow           = userData.latestRow ?? null;
  } catch (err) {
    // Redis が使えなくても問診は続行（履歴なしの単発問診になる）
    console.error('[webhook] Redis取得失敗（単発問診で続行）:', err.message);
  }

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
