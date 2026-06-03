/**
 * NAORU整体 渋谷院 LINE Webhook
 *
 * 処理フロー:
 *   LINEメッセージ受信
 *     → OpenAI で AI問診（症状分析・返答生成）
 *     → LINE に返答
 *     → Google Sheets に問診データを保存
 *
 * 依存ファイル:
 *   utils/openai.js  : OpenAI API（問診AI）
 *   utils/sheets.js  : Google Sheets API（データ保存）
 */

const express = require('express');
const line = require('@line/bot-sdk');
const { analyzeInquiry } = require('../utils/openai');
const { appendToSheet } = require('../utils/sheets');

// ---- LINE Bot 設定 -------------------------------------------------------

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const RESERVE_URL = 'https://reserve.naoru.info/';
const TEL = '070-8519-6347';

const client = new line.Client(config);
const app = express();

// ---- ルーティング --------------------------------------------------------

// 死活確認用（Vercel が正常稼働しているか確認するエンドポイント）
app.get('/api/webhook', (_req, res) => {
  res.status(200).send('NAORU LINE webhook is running.');
});

// LINE からのイベントを受け取るメインエンドポイント
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

/**
 * LINE にテキストメッセージを返信する
 * @param {string} token - replyToken
 * @param {string} text  - 返答テキスト
 */
function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

/**
 * LINEユーザーの表示名を取得する
 * グループ/ルームでは取得不可なため、失敗時は '不明' を返す
 */
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
 * Google Sheets への保存をバックグラウンドで実行する
 * 保存失敗でも LINE 返信は止めないようにエラーを握りつぶす
 */
function saveToSheet(params) {
  appendToSheet(params).catch((err) => {
    console.error('[webhook] スプレッドシート保存失敗:', err.message);
  });
}

// ---- メインのイベントハンドラ --------------------------------------------

async function handleEvent(event) {

  // ---- フォロー（友だち追加）イベント ------------------------------------
  if (event.type === 'follow') {
    const displayName = await getDisplayName(event.source?.userId);

    // 友だち追加をシートに記録
    saveToSheet({
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

  // テキストメッセージ以外は処理しない
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userText     = event.message.text;
  const displayName  = await getDisplayName(event.source?.userId);

  // ---- 予約・電話など即答できる内容は AI を通さず直接返す ----------------
  // （API コストと応答速度の最適化）

  if (userText.includes('予約') || userText.includes('よやく')) {
    saveToSheet({
      displayName,
      symptom:           '予約希望',
      inquiry:           userText,
      reservationStatus: '予約希望',
      aiSummary:         'ユーザーが予約を希望',
    });
    return reply(
      event.replyToken,
      `ご予約ありがとうございます！\n\n▼Web予約（24時間受付）\n${RESERVE_URL}\n\n▼お電話\n${TEL}\n\n初回限定 3,500円（通常13,200円）のキャンペーン実施中です。\nお気軽にどうぞ。`
    );
  }

  if (userText.includes('電話') || userText.includes('tel') || userText.includes('TEL')) {
    saveToSheet({
      displayName,
      symptom:           '電話問い合わせ',
      inquiry:           userText,
      reservationStatus: '未予約',
      aiSummary:         'ユーザーが電話番号を問い合わせ',
    });
    return reply(event.replyToken, `お電話はこちらです。\n${TEL}\n\n営業時間: 11:00〜20:00（最終受付19:00）`);
  }

  if (userText.includes('場所') || userText.includes('アクセス') || userText.includes('住所')) {
    saveToSheet({
      displayName,
      symptom:           'アクセス問い合わせ',
      inquiry:           userText,
      reservationStatus: '未予約',
      aiSummary:         'ユーザーがアクセスを問い合わせ',
    });
    return reply(
      event.replyToken,
      `NAORU整体 渋谷院は渋谷駅から徒歩圏内です。\n詳しいアクセスはWebサイトをご覧ください。\n\nお電話でもご案内できます。\n${TEL}`
    );
  }

  // ---- その他のメッセージはすべて AI問診へ --------------------------------

  let aiResult;
  try {
    // OpenAI に問診を依頼（3〜5秒程度かかる）
    aiResult = await analyzeInquiry(userText);
  } catch (err) {
    // AI が失敗してもユーザーには自然な返答をする
    console.error('[webhook] OpenAI 呼び出し失敗:', err.message);
    aiResult = {
      replyText:        'ご連絡ありがとうございます。\n詳しい状況をお聞かせください。いつ頃から、どのような時につらさを感じますか？',
      symptomType:      'エラー',
      postureType:      '不明',
      stress:           '不明',
      deskWork:         '不明',
      riskScore:        1,
      aiSummary:        'AI問診エラー',
      needsReservation: false,
    };
  }

  // 危険度が高い場合（4以上）は予約案内を強調する文言を付加
  let replyText = aiResult.replyText;
  if (aiResult.riskScore >= 4) {
    replyText += `\n\nお身体の状態が気になります。早めにご来院されることをお勧めします。\n▼ご予約\n${RESERVE_URL}`;
  } else if (aiResult.needsReservation) {
    replyText += `\n\n▼ご予約・詳細はこちら\n${RESERVE_URL}`;
  }

  // スプレッドシートに AI 分析結果を含めて保存
  saveToSheet({
    displayName,
    symptom:           aiResult.symptomType,
    inquiry:           userText,
    reservationStatus: aiResult.needsReservation ? '予約推奨' : '未予約',
    postureType:       aiResult.postureType,
    stress:            aiResult.stress,
    deskWork:          aiResult.deskWork,
    aiSummary:         `[危険度:${aiResult.riskScore}] ${aiResult.aiSummary}`,
  });

  // AI の返答を LINE に送信
  return reply(event.replyToken, replyText);
}

module.exports = app;
