/**
 * NAORU整体 渋谷院 LINE Webhook
 *
 * 処理フロー:
 *   LINEイベント受信（メッセージ / ポストバック）
 *     ↓ Redisでモード・問診ステップを確認
 *     ├ 有人対応中     → AIスキップ、記録のみ
 *     ├ リセットキーワード → AIモードに戻す
 *     ├ 完了キーワード    → 問診完了
 *     ├ 有人切替キーワード → 有人モードへ
 *     ├ 問診中（step 1〜6）→ 回答を保存して次の質問 or サマリー生成
 *     └ 通常AI問診        → OpenAIで返答 → Sheets保存
 */

const express = require('express');
const line    = require('@line/bot-sdk');

const { analyzeInquiry, generateInquirySummary }          = require('../utils/openai');
const { appendToSheet, updateUserStatus, updateSupportStatus } = require('../utils/sheets');
const { getQuestion, isCompleted, formatAnswers }          = require('../utils/inquiry');
const {
  getUserData, getMode, setMode,
  getConversationHistory, saveConversation,
  getInquiryStep, startInquiry, saveAnswerAndAdvance,
  resetInquiry, getInquiryAnswers,
} = require('../utils/redis');

// ---- LINE Bot 設定 -------------------------------------------------------

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET,
};

const RESERVE_URL = 'https://reserve.naoru.info/';
const TEL         = '070-8519-6347';

const client = new line.Client(config);
const app    = express();

// ---- キーワード定義 ------------------------------------------------------

// 有人対応モードに切り替えるキーワード
const HUMAN_KEYWORDS    = ['スタッフに相談したい', '人と話したい', 'スタッフ', '相談', 'オペレーター', '担当者'];
// AIモードに戻すキーワード（スタッフまたはユーザーが送信）
const RESET_KEYWORDS    = ['#ai', '＃ai', 'AI再開', 'AIに戻す', 'AI問診'];
// 問診完了にするキーワード（スタッフ用）
const COMPLETE_KEYWORDS = ['#完了', '＃完了', '対応完了', '問診完了'];
// 問診キャンセルキーワード
const CANCEL_KEYWORDS   = ['キャンセル', 'やめる', 'やめます', 'やめたい', 'もういい'];

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

function reply(token, messages) {
  // messages が文字列なら { type: 'text' } に変換
  const msgs = (Array.isArray(messages) ? messages : [messages]).map((m) =>
    typeof m === 'string' ? { type: 'text', text: m } : m
  );
  return client.replyMessage(token, msgs.length === 1 ? msgs[0] : msgs);
}

async function getDisplayName(userId) {
  if (!userId) return '不明';
  try { return (await client.getProfile(userId)).displayName; }
  catch { return '不明'; }
}

// エラーを握りつぶして安全に実行するラッパー群
async function safe(label, fn) {
  try { return await fn(); }
  catch (err) { console.error(`[webhook] ${label} 失敗:`, err.message); return null; }
}

const saveSheet   = (params)           => safe('Sheets追記',         () => appendToSheet(params));
const updateStatus = (row, statuses)   => safe('CRMステータス更新',   () => updateUserStatus(row, statuses));
const updateSupport = (row, status)    => safe('対応ステータス更新',   () => updateSupportStatus(row, status));
const setModeSafe  = (uid, mode)       => safe('モード変更',          () => setMode(uid, mode));
const saveTalk     = (uid, u, a, ext)  => safe('Redis保存',           () => saveConversation(uid, u, a, ext));

// ---- メインのイベントハンドラ --------------------------------------------

async function handleEvent(event) {

  // ---- フォロー（友だち追加）--------------------------------------------
  if (event.type === 'follow') {
    const userId      = event.source?.userId;
    const displayName = await getDisplayName(userId);

    saveSheet({ userId, displayName, symptom: '（友だち追加）', inquiry: '', reservationStatus: '未予約', aiSummary: '友だち追加' });

    return reply(
      event.replyToken,
      `${displayName}さん、NAORU整体 渋谷院です。\n友だち追加ありがとうございます！\n\n下のメニューから「AI問診」を選ぶと、症状の分析ができます。\nお悩みをそのままメッセージで送っていただいても大丈夫です。\n\n▼ご予約\n${RESERVE_URL}`
    );
  }

  // ---- ポストバック（リッチメニューのボタン）------------------------------
  if (event.type === 'postback') {
    const userId = event.source?.userId;
    const data   = event.postback?.data ?? '';

    if (data === 'action=start_inquiry') {
      return handleInquiryStart(event.replyToken, userId);
    }
    return null;
  }

  // テキストメッセージ以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userText    = event.message.text.trim();
  const userId      = event.source?.userId;
  const displayName = await getDisplayName(userId);

  // Redis から状態を一括取得
  let mode         = 'ai';
  let inquiryStep  = 0;
  let latestRow    = null;
  let history      = [];

  try {
    const [userData, hist, step] = await Promise.all([
      getUserData(userId),
      getConversationHistory(userId),
      getInquiryStep(userId),
    ]);
    mode        = userData.mode       ?? 'ai';
    latestRow   = userData.latestRow  ?? null;
    history     = hist;
    inquiryStep = step;
  } catch (err) {
    console.error('[webhook] Redis取得失敗（AIモードで続行）:', err.message);
  }

  // ---- ① リセットキーワード → AIモードに復帰 ---------------------------
  if (RESET_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'ai');
    await safe('問診リセット', () => resetInquiry(userId));
    if (latestRow) updateSupport(latestRow, 'AI対応中');
    return reply(event.replyToken, 'AI問診を再開します。\n気になる症状やお悩みをメッセージで送ってください。');
  }

  // ---- ② 完了キーワード → 問診完了 ------------------------------------
  if (COMPLETE_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'completed');
    if (latestRow) updateSupport(latestRow, '問診完了');
    return null; // スタッフが締めくくる
  }

  // ---- ③ 有人対応モード中 → AIスキップ、記録のみ ----------------------
  if (mode === 'human') {
    saveSheet({ userId, displayName, symptom: '有人対応', inquiry: userText, reservationStatus: '対応中', aiSummary: 'スタッフ対応中', supportStatus: '有人対応中' });
    return null;
  }

  // ---- ④ 問診キャンセル -----------------------------------------------
  if (CANCEL_KEYWORDS.some((kw) => userText.includes(kw)) && inquiryStep > 0) {
    await safe('問診リセット', () => resetInquiry(userId));
    return reply(event.replyToken, '問診をキャンセルしました。\nまたいつでも「AI問診」から始められます。');
  }

  // ---- ⑤ 問診進行中（step 1〜6）--------------------------------------
  if (inquiryStep >= 1) {
    return handleInquiryStep(event.replyToken, userId, displayName, userText, inquiryStep, latestRow);
  }

  // ---- ⑥ 有人切替キーワード → 有人モードへ ----------------------------
  if (HUMAN_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'human');
    const replyText = `スタッフが順次対応いたします。少々お待ちください。\n\nお急ぎの場合はお電話でも承ります。\n${TEL}`;
    const row = await saveSheet({ userId, displayName, symptom: '有人対応へ切替', inquiry: userText, reservationStatus: '対応待ち', aiSummary: 'キーワードで有人切替', supportStatus: '有人対応中' });
    saveTalk(userId, userText, replyText, { latestRow: row ?? latestRow });
    return reply(event.replyToken, replyText);
  }

  // ---- ⑦ リッチメニューのショートカットキーワード ----------------------
  if (userText === 'AI問診を始める' || userText === 'AI問診') {
    return handleInquiryStart(event.replyToken, userId);
  }

  if (userText.includes('AI姿勢分析')) {
    const replyText = `AI姿勢分析についてのご案内です。\n\nNAORU整体では来院時にAIを使った姿勢分析を実施しています。\n数値で現在の姿勢状態を確認し、根本的な改善に向けたご提案をします。\n\n▼まずは初回体験（3,500円）からどうぞ\n${RESERVE_URL}`;
    saveSheet({ userId, displayName, symptom: 'AI姿勢分析問い合わせ', inquiry: userText, reservationStatus: '未予約', aiSummary: '姿勢分析の問い合わせ' });
    return reply(event.replyToken, replyText);
  }

  if (userText.includes('料金')) {
    const replyText = '初回限定 3,500円（通常 13,200円・税込）\nAI姿勢分析つき・所要約60分\n\n▼Web予約はこちら\n' + RESERVE_URL;
    saveSheet({ userId, displayName, symptom: '料金問い合わせ', inquiry: userText, reservationStatus: '未予約', aiSummary: '料金問い合わせ' });
    return reply(event.replyToken, replyText);
  }

  if (userText.includes('アクセス') || userText.includes('場所') || userText.includes('住所')) {
    const replyText = `NAORU整体 渋谷院は渋谷駅から徒歩圏内です。\n詳しいアクセスはWebサイトをご確認ください。\n\nお電話: ${TEL}`;
    saveSheet({ userId, displayName, symptom: 'アクセス問い合わせ', inquiry: userText, reservationStatus: '未予約', aiSummary: 'アクセス問い合わせ' });
    return reply(event.replyToken, replyText);
  }

  // ---- ⑧ 通常のAI問診 ------------------------------------------------
  let aiResult;
  try {
    aiResult = await analyzeInquiry(userText, history);
  } catch (err) {
    console.error('[webhook] OpenAI失敗:', err.message);
    aiResult = {
      replyText: 'ご連絡ありがとうございます。\nいつ頃から、どのような時につらさを感じますか？',
      symptomType: 'エラー', postureType: '不明', stress: '不明',
      deskWork: '不明', riskScore: 1, aiSummary: 'AI問診エラー',
      needsReservation: false, visitDetected: false, churnDetected: false,
    };
  }

  let replyText = aiResult.replyText;
  if (aiResult.riskScore >= 4) {
    replyText += `\n\nお身体の状態が心配です。早めのご来院をお勧めします。\n▼ご予約\n${RESERVE_URL}`;
  } else if (aiResult.needsReservation) {
    replyText += `\n\n▼ご予約・詳細\n${RESERVE_URL}`;
  }

  const newRow = await saveSheet({
    userId, displayName,
    symptom:           aiResult.symptomType,
    inquiry:           userText,
    reservationStatus: aiResult.needsReservation ? '予約推奨' : '未予約',
    postureType:       aiResult.postureType,
    stress:            aiResult.stress,
    deskWork:          aiResult.deskWork,
    aiSummary:         `[危険度:${aiResult.riskScore}] ${aiResult.aiSummary}`,
    supportStatus:     'AI対応中',
  });

  saveTalk(userId, userText, aiResult.replyText, { latestRow: newRow ?? latestRow });

  if (aiResult.visitDetected && latestRow) updateStatus(latestRow, { visited: '済', continued: '継続' });
  if (aiResult.churnDetected && latestRow) updateStatus(latestRow, { churned: '離反' });

  return reply(event.replyToken, replyText);
}

// ---- 問診サブハンドラ ---------------------------------------------------

/**
 * 問診を開始する（ステップ1の質問を送信）
 */
async function handleInquiryStart(replyToken, userId) {
  await safe('問診開始', () => startInquiry(userId));

  const firstQuestion = getQuestion(1);
  return reply(replyToken, [
    '問診を開始します。\n全6問です。それぞれの質問に答えてください。\n（途中でやめる場合は「キャンセル」と送ってください）',
    firstQuestion.text,
  ]);
}

/**
 * 問診ステップを進める（回答保存 → 次の質問 or サマリー生成）
 */
async function handleInquiryStep(replyToken, userId, displayName, userText, currentStep, latestRow) {
  // 現在のステップに対応するQuestionを取得して回答を保存
  const currentQuestion = getQuestion(currentStep);
  if (!currentQuestion) {
    // 想定外のステップ → リセット
    await safe('問診リセット', () => resetInquiry(userId));
    return reply(replyToken, '問診の状態が不正でした。最初からやり直してください。');
  }

  // 回答を保存して次のステップへ進める
  const nextStep = await safe('回答保存',
    () => saveAnswerAndAdvance(userId, currentQuestion.key, userText)
  ) ?? currentStep + 1;

  // 全問完了？
  if (isCompleted(nextStep)) {
    return handleInquiryComplete(replyToken, userId, displayName, latestRow);
  }

  // 次の質問を送信
  const nextQuestion = getQuestion(nextStep);
  return reply(replyToken, nextQuestion.text);
}

/**
 * 6問終了 → AIサマリー生成 → Sheets保存 → ユーザーに返答
 */
async function handleInquiryComplete(replyToken, userId, displayName, latestRow) {
  // 全回答を取得
  const answers = await safe('回答取得', () => getInquiryAnswers(userId)) ?? {};

  // 「考え中...」のメッセージを返してからAIを呼ぶのは
  // LINE APIでは難しいため、そのまま処理（3〜5秒かかる場合あり）

  // OpenAI にサマリーを依頼
  let summary;
  try {
    summary = await generateInquirySummary(answers, RESERVE_URL);
  } catch (err) {
    console.error('[webhook] サマリー生成失敗:', err.message);
    summary = {
      lineReply: '問診ありがとうございました。\nスタッフより詳しいご案内をいたします。',
      symptomType: '不明', postureType: '不明', riskScore: 1,
      aiSummary: 'サマリー生成エラー',
    };
  }

  // 問診内容を整形（Sheets保存用）
  const inquiryText = formatAnswers(answers);

  // Sheets に問診完了として保存
  const newRow = await saveSheet({
    userId,
    displayName,
    symptom:           summary.symptomType,
    inquiry:           inquiryText,
    reservationStatus: '問診完了',
    postureType:       summary.postureType,
    aiSummary:         `[危険度:${summary.riskScore}] ${summary.summary ?? ''}\n${summary.hypothesis ?? ''}`,
    supportStatus:     '問診完了',
    inquiryCompleted:  '済',
  });

  // 問診ステップをリセット
  await safe('問診リセット', () => resetInquiry(userId));
  if (newRow ?? latestRow) updateSupport(newRow ?? latestRow, '問診完了');

  // 返答を送信
  return reply(replyToken, summary.lineReply);
}

module.exports = app;
