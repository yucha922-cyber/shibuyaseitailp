/**
 * NAORU整体 渋谷院 LINE Webhook
 *
 * リッチメニュー構成（LINE Official Account Manager で設定済み）:
 *   A: 簡単AI診断       → テキスト "AI問診" を送信
 *   B: 初回予約         → リンク（webhookイベントなし）
 *   C: スタッフ相談      → テキスト "スタッフ相談" を送信
 *   D: マップ           → リンク（webhookイベントなし）
 *   E: キャンセル        → テキスト "キャンセル" を送信
 *
 * 処理フロー:
 *   LINEメッセージ受信
 *     ↓ Redisでモード・問診ステップ・cancelFlowState を確認
 *     ├ 有人対応中               → AIスキップ、記録のみ
 *     ├ #ai / AI再開             → AIモードに戻す
 *     ├ #完了                    → 問診完了
 *     ├ 「スタッフ相談」等        → 有人モードへ切替
 *     ├ 「キャンセル」           → キャンセルフロー開始
 *     ├ cancelFlowState が設定中  → キャンセルフロー継続
 *     ├ 問診中（step 1〜6）       → 回答保存 → 次の質問 or サマリー生成
 *     ├ 「AI問診」               → 問診開始
 *     └ その他                   → 通常AI問診
 */

const express = require('express');
const line    = require('@line/bot-sdk');

const { analyzeInquiry, generateInquirySummary } = require('../utils/openai');
const { upsertPatient, getPatient, appendHistory } = require('../utils/sheets');
const { getQuestion, isAnalysisStep, isCompleted, resolveAnswer, formatAnswers,
        evaluateStress, evaluateRisk, evaluateSleep, evaluateDeskWork } = require('../utils/inquiry');
const { RICH_MENU_ACTIONS }                                    = require('../utils/richMenu');
const { handleCancelFlow }                                     = require('../utils/cancelFlow');
const {
  getUserData, getMode, setMode, updateUserData,
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

// 有人モードの自動復帰までの時間（時間単位）
// スタッフが対応完了後にAIへ戻し忘れても、最後のやり取りから
// この時間が経過すれば自動でAIモードに戻る。
// ※ ここの数字を変えるだけで復帰時間を調整できます（例: 6 → 6時間）。
const HUMAN_AUTO_REVERT_HOURS = 3;

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

// 患者マスターを upsert（更新 or 新規作成）
const savePatient = (patient)      => safe('患者マスターupsert', () => upsertPatient(patient));
// 対応履歴に1行追記
const logHistory  = (log)          => safe('対応履歴追記',       () => appendHistory(log));

/**
 * 来院を記録し、CRM強化列（初回来院日 / 最終来院日 / 予約回数）を更新する。
 *   - 初回来院日: まだ空のときだけ今日の日付を入れる
 *   - 最終来院日: 毎回 今日の日付で上書き
 *   - 予約回数  : 既存値 + 1
 * @returns {Promise<Object>} 追加で upsert すべきフィールド
 */
async function buildVisitUpdate(userId) {
  const today   = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const current = await safe('患者マスター取得', () => getPatient(userId));

  const prevCount = parseInt(current?.visitCount, 10);
  const visitCount = (Number.isNaN(prevCount) ? 0 : prevCount) + 1;

  return {
    visited:      '済',
    continued:    '継続',
    lastVisitAt:  today,
    visitCount,
    // 初回来院日は未設定のときだけセット（既存値があれば触らない）
    ...(current?.firstVisitAt ? {} : { firstVisitAt: today }),
  };
}
const setModeSafe = (uid, mode)    => safe('モード変更',         () => setMode(uid, mode));
const saveTalk    = (uid, u, a, ext) => safe('Redis保存',        () => saveConversation(uid, u, a, ext));

// ---- メインのイベントハンドラ --------------------------------------------

async function handleEvent(event) {

  // ---- フォロー（友だち追加）--------------------------------------------
  if (event.type === 'follow') {
    const userId      = event.source?.userId;
    const displayName = await getDisplayName(userId);

    // 患者マスターに登録（新規作成）
    await savePatient({ userId, displayName, supportStatus: 'AI対応中' });
    // 対応履歴に記録
    await logHistory({ userId, displayName, eventType: '友だち追加', content: '' });

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
  let mode             = 'ai';
  let inquiryStep      = 0;
  let history          = [];
  let reserved         = false; // 予約確定フラグ（true ならAIを起動しない）
  let cancelFlowState  = null;  // キャンセルフローの現在 state

  try {
    const [userData, hist, step] = await Promise.all([
      getUserData(userId),
      getConversationHistory(userId),
      getInquiryStep(userId),
    ]);
    mode            = userData.mode ?? 'ai';
    history         = hist;
    inquiryStep     = step;
    reserved        = userData.reserved === true;
    cancelFlowState = userData.cancelFlowState ?? null;

    // ---- 有人モードの自動復帰 -------------------------------------------
    // スタッフが対応完了後にAIへ戻し忘れても、最後のやり取りから
    // 一定時間（HUMAN_AUTO_REVERT_HOURS）が経過していれば自動でAIモードに戻す。
    // ※ 予約確定ユーザー（reserved）は自動復帰の対象外（AIを起動しない）。
    if (!reserved && mode === 'human' && userData.lastMessageAt) {
      const elapsedMs   = Date.now() - new Date(userData.lastMessageAt).getTime();
      const elapsedHour = elapsedMs / (1000 * 60 * 60);
      if (elapsedHour >= HUMAN_AUTO_REVERT_HOURS) {
        console.log(`[webhook] 有人モード自動復帰（${elapsedHour.toFixed(1)}h経過）: ${userId}`);
        await setModeSafe(userId, 'ai');
        await safe('問診リセット', () => resetInquiry(userId));
        mode        = 'ai';
        inquiryStep = 0;
      }
    }
  } catch (err) {
    console.error('[webhook] Redis取得失敗（AIモードで続行）:', err.message);
  }

  // ---- ① キャンセルフロー --------------------------------------------------
  // リッチメニュー「キャンセル」ボタン押下でフロー開始。フロー継続中もここで処理する。
  // human モード・予約確定中でも割り込みできる（患者都合のキャンセルを優先）。
  //
  // ※「キャンセル」は AI問診中断キーワード（⑧）とも重複する。
  //   問診中（inquiryStep≧1）に「キャンセル」が来た場合は従来どおり
  //   問診中断（⑧）を優先し、問診外でのみキャンセルフローを開始する。
  //   これにより既存の問診中断機能を壊さない。
  const isCancelFlowTrigger = userText === RICH_MENU_ACTIONS.CANCEL_FLOW && inquiryStep === 0;
  if (isCancelFlowTrigger || cancelFlowState !== null) {
    const handled = await handleCancelFlow({
      replyToken:      event.replyToken,
      userId,
      displayName,
      userText,
      // トリガーボタン直後は state=null で渡す（START メッセージを返す）
      cancelFlowState: isCancelFlowTrigger ? null : cancelFlowState,
      reply,
      logHistory,
      safe,
    });
    if (handled) return;
  }

  // ---- ② リッチメニュー A「簡単AI診断」→ 強制的にAIモードへ切替 ---------
  // human モード中・予約確定中など、どの状態からでも問診を開始できる。
  if (userText === RICH_MENU_ACTIONS.AI_INQUIRY || userText.includes('AI問診') || userText.includes('AI診断')) {
    await setModeSafe(userId, 'ai');
    await safe('問診開始', () => startInquiry(userId)); // step = 1 にセット
    await safe('予約確定解除', () => updateUserData(userId, { reserved: false }));
    await savePatient({ userId, displayName, supportStatus: 'AI対応中' });
    await logHistory({ userId, displayName, eventType: 'AI問診開始', content: '' });
    return reply(event.replyToken, [
      '簡単AI診断を始めます。\n全9問です。それぞれの質問にお答えください。\n（途中でやめる場合は「キャンセル」と送ってください）',
      getQuestion(1).text,
    ]);
  }

  // ---- ③ リッチメニュー C「スタッフ相談」→ 強制的に有人モードへ切替 -----
  // AI問診中・問診完了後など、どの状態からでもスタッフ対応へ切替できる。
  if (HUMAN_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'human');
    await safe('問診リセット', () => resetInquiry(userId));
    const replyText = 'スタッフ対応へ切り替えました。\n担当者より順次ご返信いたします。';
    await savePatient({ userId, displayName, supportStatus: '有人対応中' });
    await logHistory({ userId, displayName, eventType: 'スタッフ相談', content: userText });
    await saveTalk(userId, userText, replyText, {});
    return reply(event.replyToken, replyText);
  }

  // ---- ④ AIモードに戻すキーワード（スタッフ用コマンド）------------------
  if (RESET_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'ai');
    await safe('問診リセット', () => resetInquiry(userId));
    await safe('予約確定解除', () => updateUserData(userId, { reserved: false }));
    await savePatient({ userId, displayName, supportStatus: 'AI対応中' });
    return reply(event.replyToken, 'AI問診を再開します。\nメニューの「簡単AI診断」を押してください。');
  }

  // ---- ⑤ 対応完了キーワード（スタッフ用コマンド）------------------------
  if (COMPLETE_KEYWORDS.some((kw) => userText.includes(kw))) {
    await setModeSafe(userId, 'completed');
    await savePatient({ userId, displayName, supportStatus: '問診完了' });
    return null;
  }

  // ---- ⑥ 予約確定ユーザー → AIを起動しない（スタッフ対応のまま）----------
  if (reserved) {
    await logHistory({ userId, displayName, eventType: '予約確定ユーザーメッセージ', content: userText });
    await safe('最終時刻更新', () => updateUserData(userId, { lastMessageAt: new Date().toISOString() }));
    return null;
  }

  // ---- ⑦ 有人対応中 → AIスキップ、記録のみ ------------------------------
  if (mode === 'human') {
    await logHistory({ userId, displayName, eventType: 'スタッフ対応中メッセージ', content: userText });
    await safe('最終時刻更新', () => updateUserData(userId, { lastMessageAt: new Date().toISOString() }));
    return null;
  }

  // ---- ⑧ 問診キャンセル --------------------------------------------------
  if (inquiryStep >= 1 && CANCEL_KEYWORDS.some((kw) => userText.includes(kw))) {
    await safe('問診リセット', () => resetInquiry(userId));
    return reply(event.replyToken, '問診をキャンセルしました。\nまたいつでもメニューの「簡単AI診断」から始められます。');
  }

  // ---- ⑨ 問診進行中（step 1〜9）の回答を処理 ----------------------------
  if (inquiryStep >= 1) {
    return handleInquiryStep(event.replyToken, userId, displayName, userText, inquiryStep);
  }

  // ---- ⑩ 通常のAI問診（自由入力）--------------------------------------
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

  // 来院を検出したら CRM強化列（初回/最終来院日・予約回数）も計算
  const visitUpdate = aiResult.visitDetected ? await buildVisitUpdate(userId) : {};

  // 患者マスターを upsert（最新の症状・分析で更新）
  // ※ Vercelは応答を返すと関数が終了するため、reply前に必ず await する
  await savePatient({
    userId, displayName,
    symptom:       aiResult.symptomType,
    aiSummary:     aiResult.aiSummary,
    postureType:   aiResult.postureType,
    stress:        aiResult.stress,
    deskWork:      aiResult.deskWork,
    supportStatus: 'AI対応中',
    ...visitUpdate,
    ...(aiResult.churnDetected ? { churned: '離反' } : {}),
  });

  // 対応履歴に記録
  await logHistory({ userId, displayName, eventType: 'AI問診（自由入力）', content: userText });
  if (aiResult.visitDetected) await logHistory({ userId, displayName, eventType: '来院', content: userText });
  if (aiResult.churnDetected) await logHistory({ userId, displayName, eventType: '離反', content: userText });

  await saveTalk(userId, userText, aiResult.replyText, {});

  return reply(event.replyToken, replyText);
}

// ---- 問診サブハンドラ ---------------------------------------------------

/**
 * 問診の各ステップを処理する
 * 回答を保存 → 次の質問 or step10（AI分析中メッセージ）→ サマリー生成
 */
async function handleInquiryStep(replyToken, userId, displayName, userText, currentStep) {
  const currentQuestion = getQuestion(currentStep);
  if (!currentQuestion) {
    await safe('問診リセット', () => resetInquiry(userId));
    return reply(replyToken, '問診の状態が不正でした。メニューの「簡単AI診断」から最初からやり直してください。');
  }

  // 回答を「1. 肩こり・首こり」形式に整えてから保存して次のステップへ
  const resolved = resolveAnswer(currentQuestion, userText);
  const nextStep = await safe('回答保存',
    () => saveAnswerAndAdvance(userId, currentQuestion.key, resolved)
  ) ?? currentStep + 1;

  // Q10: 「AI分析を開始します」メッセージを送ってからサマリー生成
  if (isAnalysisStep(nextStep)) {
    await reply(replyToken, 'Q10. AI分析を開始します。\n少々お待ちください...');
    return handleInquiryComplete(null, userId, displayName);
  }

  // 全問終了
  if (isCompleted(nextStep)) {
    return handleInquiryComplete(replyToken, userId, displayName);
  }

  // 次の質問を送信
  return reply(replyToken, getQuestion(nextStep).text);
}

/**
 * 全9問終了後の処理
 * OpenAI で各種判定・要約を生成し、Sheetsに保存してユーザーに結果を返信
 */
async function handleInquiryComplete(replyToken, userId, displayName) {
  const answers = await safe('回答取得', () => getInquiryAnswers(userId)) ?? {};

  // ---- 各評価はAIに依存せずコードで確定（必ず値が入る）-------------------
  const stressLevel   = evaluateStress(answers.stress);
  const riskLevel     = evaluateRisk(answers.pain);
  const sleepLevel    = evaluateSleep(answers.sleepRaw);
  const deskWorkLevel = evaluateDeskWork(answers.deskWorkRaw);

  // ---- 姿勢タイプ・推奨施術・要約・返答文のみAIが生成 --------------------
  // AIが失敗しても上記の評価は保存されるよう、AI部分は別途フォールバック。
  let ai = {
    postureType: '複合型',
    recommendedTreatment: '全身調整整体',
    aiSummary: '',
    lineReply: `診断ありがとうございました。\nスタッフより詳しいご案内をいたします。\n\n▼初回予約（3,500円）\n${RESERVE_URL}`,
  };
  try {
    ai = await generateInquirySummary(answers, RESERVE_URL, { stressLevel, riskLevel, sleepLevel, deskWorkLevel });
  } catch (err) {
    console.error('[webhook] サマリー生成失敗（評価値は保存されます）:', err.message);
  }

  // AI要約が空ならコード側で簡易要約を組み立てる（空欄を防ぐ）
  const aiSummary = ai.aiSummary && ai.aiSummary.trim()
    ? ai.aiSummary
    : `${answers.symptom ?? ''}（${answers.symptomDuration ?? ''}）。デスクワーク${deskWorkLevel}・睡眠${sleepLevel}・ストレス${stressLevel}・危険度${riskLevel}。${
        deskWorkLevel === '高' && stressLevel === '高' ? '姿勢由来および生活習慣・ストレス由来の可能性が高い。' :
        deskWorkLevel === '高' ? '姿勢由来および生活習慣由来の可能性が高い。' :
        stressLevel === '高' ? 'ストレス由来および自律神経由来の可能性が高い。' :
        '姿勢・生活習慣由来の可能性が高い。'
      }`;

  const inquiryText = formatAnswers(answers);

  // 患者マスターを upsert（問診結果で全列更新）
  await savePatient({
    userId,
    displayName,
    fullName:             answers.fullName        ?? '',
    symptom:              answers.symptom         ?? '',
    symptomDuration:      answers.symptomDuration ?? '',
    postureType:          ai.postureType,
    stress:               stressLevel,
    sleep:                sleepLevel,
    deskWork:             deskWorkLevel,
    riskLevel:            riskLevel,
    aiSummary:            aiSummary,
    recommendedTreatment: ai.recommendedTreatment,
    supportStatus:        '問診完了',
  });

  // ---- ユーザーに送る診断結果メッセージをコード側で組み立てる ----------
  // AIが失敗しても必ず分析内容が表示されるようにする。
  const riskAdvice = {
    高: '痛みが強い状態です。症状が長引く・悪化する場合は早めに専門院・医療機関の受診をおすすめします。',
    中: '放置すると慢性化する可能性があります。早めのケアがおすすめです。',
    低: '今は軽度ですが、根本改善のため早めのケアが効果的です。',
  }[riskLevel] ?? '早めのケアがおすすめです。';

  const resultMessage =
`【AI分析結果】${answers.fullName ? `\n${answers.fullName} 様` : ''}

■ 気になる症状
${answers.symptom ?? '未回答'}（${answers.symptomDuration ?? '未回答'}）

■ 姿勢タイプ：${ai.postureType}
■ ストレス：${stressLevel} ／ 睡眠：${sleepLevel} ／ デスクワーク：${deskWorkLevel}
■ 危険度：${riskLevel}

■ 分析サマリー
${aiSummary}

■ あなたへのおすすめ施術
「${ai.recommendedTreatment}」

${riskAdvice}

NAORU整体ではお身体の状態に合わせた根本改善をご提案します。
ぜひ一度ご来院ください。

▼初回予約（3,500円）
${RESERVE_URL}`;

  // 対応履歴に「AI問診完了」を記録
  await logHistory({ userId, displayName, eventType: 'AI問診完了', content: inquiryText });

  // 問診ステップをリセット
  await safe('問診リセット', () => resetInquiry(userId));

  // Q10で replyToken を使い切っている場合は pushMessage で送る
  if (replyToken) {
    return reply(replyToken, resultMessage);
  } else {
    return client.pushMessage(userId, { type: 'text', text: resultMessage });
  }
}

module.exports = app;
