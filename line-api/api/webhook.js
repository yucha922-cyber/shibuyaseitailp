/**
 * NAORU整体 渋谷院 LINE Webhook
 *
 * リッチメニュー構成（LINE Official Account Manager で設定済み）:
 *   A: 簡単AI診断  → テキスト "AI問診" を送信
 *   B: 初回予約    → リンク（webhookイベントなし）
 *   C: スタッフ相談 → テキスト "スタッフ相談" を送信
 *   D: マップ      → リンク（webhookイベントなし）
 *
 * 処理フロー:
 *   LINEメッセージ受信
 *     ↓ Redisでモード・問診ステップを確認
 *     ├ 有人対応中         → AIスキップ、記録のみ
 *     ├ #ai / AI再開       → AIモードに戻す
 *     ├ #完了              → 問診完了
 *     ├ 「スタッフ相談」等 → 有人モードへ切替
 *     ├ 問診中（step 1〜6）→ 回答保存 → 次の質問 or サマリー生成
 *     ├ 「AI問診」         → 問診開始
 *     └ その他             → 通常AI問診
 */

const express = require('express');
const line    = require('@line/bot-sdk');

const { analyzeInquiry, generateInquirySummary }               = require('../utils/openai');
const { appendToSheet, updateUserStatus, updateSupportStatus } = require('../utils/sheets');
const { getQuestion, isCompleted, formatAnswers }              = require('../utils/inquiry');
const { RICH_MENU_ACTIONS }                                    = require('../utils/richMenu');
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

const RESERVE_URL = 'https://sv1.sattou.net/naoru/reserve/shibuya.hp';
const TEL         = '070-8519-6347';

const client = new line.Client(config);
const app    = express();

// ---- キーワード定義 ------------------------------------------------------

// 有人対応モードに切り替えるキーワード
// ※ リッチメニューCの「スタッフ相談」も含める
const HUMAN_KEYWORDS = [
  RICH_MENU_ACTIONS.STAFF_CONSULT, // 'スタッフ相談'
  '人と話したい', 'スタッフ', '相談したい', 'オペレーター', '担当者',
];

// AIモードに戻すキーワード（スタッフがLINE管理画面から送信 or ユーザーが送信）
const RESET_KEYWORDS    = ['#ai', '＃ai', 'AI再開', 'AIに戻す'];

// 問診完了にするキーワード（スタッフ用）
const COMPLETE_KEYWORDS = ['#完了', '＃完了', '対応完了'];

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

/**
 * LINEに返信する
 * @param {string} token    - replyToken
 * @param {string|Array} messages - テキスト or メッセージオブジェクトの配列
 */
function reply(token, messages) {
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

// エラーを握りつぶして安全に実行するラッパー
async function safe(label, fn) {
  try { return await fn(); }
  catch (err) { console.error(`[webhook] ${label} 失敗:`, err.message); return null; }
}

const saveSheet     = (params)         => safe('Sheets追記',       () => appendToSheet(params));
const updateStatus  = (row, statuses)  => safe('CRMステータス更新', () => updateUserStatus(row, statuses));
const updateSupport = (row, status)    => safe('対応ステータス更新', () => updateSupportStatus(row, status));
const setModeSafe   = (uid, mode)      => safe('モード変更',        () => setMode(uid, mode));
const saveTalk      = (uid, u, a, ext) => safe('Redis保存',         () => saveConversation(uid, u, a, ext));

// ---- メインのイベントハンドラ --------------------------------------------

async function handleEvent(event) {

  // ---- フォロー（友だち追加）--------------------------------------------
  if (event.type === 'follow') {
    const userId      = event.source?.userId;
    const displayName = await getDisplayName(userId);

    saveSheet({
      userId, displayName,
      symptom: '（友だち追加）', inquiry: '',
      reservationStatus: '未予約', aiSummary: '友だち追加',
    });

    return reply(
      event.replyToken,
      `${displayName}さん、NAORU整体 渋谷院です。\n友だち追加ありがとうございます！\n\n下のメニューから「簡単AI診断」を選ぶと、症状の分析ができます。\nお悩みをそのままメッセージで送っていただいても大丈夫です。\n\n▼初回予約（3,500円）\n${RESERVE_URL}`
    );
  }

  // テキストメッセージ以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userText    = event.message.text.trim();
  const userId      = event.source?.userId;
  const displayName = await getDisplayName(userId);

  // Redis から現在の状態を一括取得
  let mode        = 'ai';
  let inquiryStep = 0;
  let latestRow   = null;
  let history     = [];

  try {
    const [userData, hist, step] = await Promise.all([
      getUserData(userId),
      getConversationHistory(userId),
      getInquiryStep(userId),
    ]);
    mode        = userData.mode      ?? 'ai';
    latestRow   = userData.latestRow ?? null;
    history     = hist;
    inquiryStep = step;
  } catch (err) {
    console.error('[webhook] Redis取得失敗（AIモードで続行）:', err.message);
  }

  // ---- ① AIモードに戻すキーワード（スタッフ用）------------------------
  if (RESET_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'ai');
    await safe('問診リセット', () => resetInquiry(userId));
    if (latestRow) updateSupport(latestRow, 'AI対応中');
    return reply(event.replyToken, 'AI問診を再開します。\nメニューの「簡単AI診断」か、お悩みをそのままメッセージで送ってください。');
  }

  // ---- ② 対応完了キーワード（スタッフ用）------------------------------
  if (COMPLETE_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'completed');
    if (latestRow) updateSupport(latestRow, '問診完了');
    return null; // スタッフが最後のメッセージを送る
  }

  // ---- ③ 有人対応中 → AIスキップ、記録のみ ---------------------------
  if (mode === 'human') {
    saveSheet({
      userId, displayName,
      symptom: '有人対応', inquiry: userText,
      reservationStatus: '対応中', aiSummary: 'スタッフ対応中のメッセージ',
      supportStatus: '有人対応中',
    });
    return null; // AIは返信しない（スタッフが手動で返信）
  }

  // ---- ④ 問診キャンセル -----------------------------------------------
  if (inquiryStep >= 1 && CANCEL_KEYWORDS.some((kw) => userText.includes(kw))) {
    await safe('問診リセット', () => resetInquiry(userId));
    return reply(event.replyToken, '問診をキャンセルしました。\nまたいつでもメニューの「簡単AI診断」から始められます。');
  }

  // ---- ⑤ 問診進行中（step 1〜6）の回答を処理 -------------------------
  if (inquiryStep >= 1) {
    return handleInquiryStep(event.replyToken, userId, displayName, userText, inquiryStep, latestRow);
  }

  // ---- ⑥ リッチメニュー A「簡単AI診断」 または「AI問診」テキスト -------
  if (userText === RICH_MENU_ACTIONS.AI_INQUIRY || userText.includes('AI問診') || userText.includes('AI診断')) {
    return handleInquiryStart(event.replyToken, userId);
  }

  // ---- ⑦ リッチメニュー C「スタッフ相談」 または有人切替キーワード ------
  if (HUMAN_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'human');
    const replyText = `スタッフが順次ご対応いたします。少々お待ちください。\n\nお急ぎの方はお電話でも承ります。\n${TEL}`;
    const row = await saveSheet({
      userId, displayName,
      symptom: '有人対応へ切替', inquiry: userText,
      reservationStatus: '対応待ち', aiSummary: 'スタッフ相談ボタンで有人切替',
      supportStatus: '有人対応中',
    });
    saveTalk(userId, userText, replyText, { latestRow: row ?? latestRow });
    return reply(event.replyToken, replyText);
  }

  // ---- ⑧ 通常のAI問診（自由入力）--------------------------------------
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
    replyText += `\n\nお身体の状態が心配です。早めのご来院をお勧めします。\n▼初回予約\n${RESERVE_URL}`;
  } else if (aiResult.needsReservation) {
    replyText += `\n\n▼初回予約（3,500円）\n${RESERVE_URL}`;
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

  return reply(replyToken, [
    '簡単AI診断を始めます。\n全6問です。それぞれの質問にお答えください。\n（途中でやめる場合は「キャンセル」と送ってください）',
    getQuestion(1).text,
  ]);
}

/**
 * 問診の各ステップを処理する
 * 回答を保存 → 次の質問 or 全問完了時にサマリー生成
 */
async function handleInquiryStep(replyToken, userId, displayName, userText, currentStep, latestRow) {
  const currentQuestion = getQuestion(currentStep);
  if (!currentQuestion) {
    await safe('問診リセット', () => resetInquiry(userId));
    return reply(replyToken, '問診の状態が不正でした。メニューの「簡単AI診断」から最初からやり直してください。');
  }

  // 回答を保存して次のステップへ
  const nextStep = await safe('回答保存',
    () => saveAnswerAndAdvance(userId, currentQuestion.key, userText)
  ) ?? currentStep + 1;

  // 全6問終了？
  if (isCompleted(nextStep)) {
    return handleInquiryComplete(replyToken, userId, displayName, latestRow);
  }

  // 次の質問を送信
  return reply(replyToken, getQuestion(nextStep).text);
}

/**
 * 全6問終了後の処理
 * OpenAI でサマリー・原因仮説・来院メリットを生成し、Sheetsに保存してユーザーに返答
 */
async function handleInquiryComplete(replyToken, userId, displayName, latestRow) {
  const answers = await safe('回答取得', () => getInquiryAnswers(userId)) ?? {};

  // OpenAI にサマリーを依頼（3〜5秒かかる場合があります）
  let summary;
  try {
    summary = await generateInquirySummary(answers, RESERVE_URL);
  } catch (err) {
    console.error('[webhook] サマリー生成失敗:', err.message);
    summary = {
      lineReply:   `診断ありがとうございました。\nスタッフより詳しいご案内をいたします。\n\n▼初回予約（3,500円）\n${RESERVE_URL}`,
      symptomType: '不明', postureType: '不明', riskScore: 1,
      summary: '', hypothesis: '',
    };
  }

  // 問診内容を整形して Sheets に保存
  const newRow = await saveSheet({
    userId,
    displayName,
    symptom:          summary.symptomType,
    inquiry:          formatAnswers(answers),   // 全6問の回答をテキスト化
    reservationStatus:'問診完了',
    postureType:      summary.postureType,
    aiSummary:        `[危険度:${summary.riskScore}] ${summary.summary ?? ''} ${summary.hypothesis ?? ''}`.trim(),
    supportStatus:    '問診完了',
    inquiryCompleted: '済',
  });

  // 問診ステップをリセット
  await safe('問診リセット', () => resetInquiry(userId));
  if (newRow ?? latestRow) updateSupport(newRow ?? latestRow, '問診完了');

  return reply(replyToken, summary.lineReply);
}

module.exports = app;
