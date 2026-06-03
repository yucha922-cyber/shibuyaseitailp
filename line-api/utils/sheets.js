/**
 * Google Sheets への書き込み・更新ユーティリティ
 *
 * 列構成（A〜P列）:
 *   A: 日時          B: LINE表示名    C: 症状タイプ   D: 問診内容（全回答）
 *   E: 予約状況      F: 姿勢タイプ    G: ストレス     H: 睡眠
 *   I: デスクワーク  J: AI要約        K: 来院         L: 継続
 *   M: 離反          N: ユーザーID    O: 対応ステータス P: 問診完了
 *
 * 関数一覧:
 *   appendToSheet(params)              : 末尾に1行追記 → 行番号を返す
 *   updateUserStatus(rowNum, statuses) : K/L/M列を更新
 *   updateSupportStatus(rowNum, status): O列を更新
 */

const { google } = require('googleapis');
const path       = require('path');

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID;
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH
  ? path.resolve(process.env.GOOGLE_CREDENTIALS_PATH)
  : path.resolve(__dirname, '..', 'credentials.json');
const SHEET_RANGE = 'シート1!A:P';
const SHEET_NAME  = 'シート1';
const SCOPES      = ['https://www.googleapis.com/auth/spreadsheets'];

// ---- 認証 ---------------------------------------------------------------

async function getAuthClient() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    let credentials;
    try { credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch { throw new Error('[sheets.js] GOOGLE_CREDENTIALS_JSON の形式が不正です。'); }
    return (new google.auth.GoogleAuth({ credentials, scopes: SCOPES })).getClient();
  }
  return (new google.auth.GoogleAuth({ keyFile: CREDENTIALS_PATH, scopes: SCOPES })).getClient();
}

// ---- 追記 ---------------------------------------------------------------

/**
 * スプレッドシートに1行追記する
 *
 * @param {Object} params
 * @param {string} params.userId            - N列: LINE userId
 * @param {string} params.displayName       - B列: LINE表示名
 * @param {string} params.symptom           - C列: 症状タイプ
 * @param {string} params.inquiry           - D列: 問診内容（全回答テキスト）
 * @param {string} params.reservationStatus - E列: 予約状況
 * @param {string} [params.postureType]     - F列: 姿勢タイプ
 * @param {string} [params.stress]          - G列: ストレス傾向
 * @param {string} [params.sleep]           - H列: 睡眠
 * @param {string} [params.deskWork]        - I列: デスクワーク傾向
 * @param {string} [params.aiSummary]       - J列: AI要約（サマリー全文）
 * @param {string} [params.visited]         - K列: 来院状況
 * @param {string} [params.continued]       - L列: 継続状況
 * @param {string} [params.churned]         - M列: 離反状況
 * @param {string} [params.supportStatus]   - O列: 対応ステータス
 * @param {string} [params.inquiryCompleted]- P列: 問診完了（'済' or ''）
 *
 * @returns {Promise<number|null>} 書き込んだ行番号
 */
async function appendToSheet({
  userId, displayName, symptom, inquiry, reservationStatus,
  postureType, stress, sleep, deskWork, aiSummary,
  visited, continued, churned, supportStatus, inquiryCompleted,
}) {
  if (!SPREADSHEET_ID) throw new Error('[sheets.js] SPREADSHEET_ID が未設定です。');

  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const row = [
    now,                            // A: 日時
    displayName       ?? '不明',    // B: LINE表示名
    symptom           ?? '不明',    // C: 症状タイプ
    inquiry           ?? '',        // D: 問診内容
    reservationStatus ?? '未予約',  // E: 予約状況
    postureType       ?? '',        // F: 姿勢タイプ
    stress            ?? '',        // G: ストレス
    sleep             ?? '',        // H: 睡眠
    deskWork          ?? '',        // I: デスクワーク
    aiSummary         ?? '',        // J: AI要約
    visited           ?? '',        // K: 来院
    continued         ?? '',        // L: 継続
    churned           ?? '',        // M: 離反
    userId            ?? '',        // N: ユーザーID
    supportStatus     ?? 'AI対応中',// O: 対応ステータス
    inquiryCompleted  ?? '',        // P: 問診完了
  ];

  const authClient = await getAuthClient();
  const sheets     = google.sheets({ version: 'v4', auth: authClient });

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            SHEET_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: [row] },
  });

  // レスポンスから行番号を抽出（例: "シート1!A3:P3" → 3）
  const updatedRange = response.data.updates?.updatedRange ?? '';
  const match        = updatedRange.match(/(\d+)(?::\w+\d+)?$/);
  const rowNumber    = match ? parseInt(match[1], 10) : null;

  console.log(`[sheets.js] 追記完了 row=${rowNumber}: ${displayName} / ${symptom}`);
  return rowNumber;
}

// ---- 更新 ---------------------------------------------------------------

/**
 * K（来院）・L（継続）・M（離反）列を更新する
 */
async function updateUserStatus(rowNumber, { visited, continued, churned } = {}) {
  if (!rowNumber) return;
  if (!SPREADSHEET_ID) throw new Error('[sheets.js] SPREADSHEET_ID が未設定です。');

  const data = [];
  if (visited   !== undefined) data.push({ range: `${SHEET_NAME}!K${rowNumber}`, values: [[visited]]   });
  if (continued !== undefined) data.push({ range: `${SHEET_NAME}!L${rowNumber}`, values: [[continued]] });
  if (churned   !== undefined) data.push({ range: `${SHEET_NAME}!M${rowNumber}`, values: [[churned]]   });
  if (data.length === 0) return;

  const sheets = google.sheets({ version: 'v4', auth: await getAuthClient() });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody:   { valueInputOption: 'USER_ENTERED', data },
  });
  console.log(`[sheets.js] CRMステータス更新 row=${rowNumber}`);
}

/**
 * O列（対応ステータス）を更新する
 * @param {string} status - 'AI対応中' / '有人対応中' / '問診完了'
 */
async function updateSupportStatus(rowNumber, status) {
  if (!rowNumber || !SPREADSHEET_ID) return;

  const sheets = google.sheets({ version: 'v4', auth: await getAuthClient() });
  await sheets.spreadsheets.values.update({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${SHEET_NAME}!O${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody:      { values: [[status]] },
  });
  console.log(`[sheets.js] 対応ステータス更新 row=${rowNumber}: ${status}`);
}

module.exports = { appendToSheet, updateUserStatus, updateSupportStatus };
