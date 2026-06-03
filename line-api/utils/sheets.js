/**
 * Google Sheets への書き込み・更新ユーティリティ
 *
 * 役割:
 *   LINE問診データをGoogleスプレッドシートに追記・更新する。
 *
 * 必要な環境変数:
 *   SPREADSHEET_ID         : スプレッドシートID
 *   GOOGLE_CREDENTIALS_JSON : credentials.json の中身（Vercel本番）
 *   GOOGLE_CREDENTIALS_PATH : credentials.json のパス（ローカル開発、省略可）
 *
 * 列構成（A〜N列）:
 *   A: 日時　B: LINE表示名　C: 症状　D: 問診内容　E: 予約状況
 *   F: 姿勢タイプ　G: ストレス　H: 睡眠　I: デスクワーク　J: AI要約
 *   K: 来院　L: 継続　M: 離反　N: ユーザーID（行の特定用）
 *
 * 関数一覧:
 *   appendToSheet(params)              : 末尾に1行追記 → 行番号を返す
 *   updateUserStatus(rowNum, statuses) : K/L/M列を上書き更新
 */

const { google } = require('googleapis');
const path = require('path');

// ---- 設定 ---------------------------------------------------------------

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// credentials.json のパス（ローカル開発用。Vercel本番はJSONを環境変数で渡す）
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH
  ? path.resolve(process.env.GOOGLE_CREDENTIALS_PATH)
  : path.resolve(__dirname, '..', 'credentials.json');

// シート名と範囲（N列まで使用）
const SHEET_RANGE = 'シート1!A:N';
const SHEET_NAME  = 'シート1';

// 認証スコープ
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// ---- 認証 ---------------------------------------------------------------

/**
 * Service Account 認証クライアントを生成する
 *
 * 優先順位:
 *   1. GOOGLE_CREDENTIALS_JSON（環境変数）→ Vercel本番向け
 *   2. credentials.json ファイル           → ローカル開発向け
 */
async function getAuthClient() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } catch {
      throw new Error('[sheets.js] GOOGLE_CREDENTIALS_JSON の形式が不正です。');
    }
    const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
    return auth.getClient();
  }

  const auth = new google.auth.GoogleAuth({ keyFile: CREDENTIALS_PATH, scopes: SCOPES });
  return auth.getClient();
}

// ---- 関数 ---------------------------------------------------------------

/**
 * スプレッドシートに1行追記する
 *
 * @param {Object} params
 * @param {string} params.userId           - N列: LINE の userId（行特定用）
 * @param {string} params.displayName      - B列: LINE表示名
 * @param {string} params.symptom          - C列: 症状タイプ
 * @param {string} params.inquiry          - D列: 問診内容（送信テキスト）
 * @param {string} params.reservationStatus - E列: 予約状況
 * @param {string} [params.postureType]    - F列: 姿勢タイプ
 * @param {string} [params.stress]         - G列: ストレス傾向
 * @param {string} [params.sleep]          - H列: 睡眠
 * @param {string} [params.deskWork]       - I列: デスクワーク傾向
 * @param {string} [params.aiSummary]      - J列: AI要約（スタッフ向け）
 * @param {string} [params.visited]        - K列: 来院状況
 * @param {string} [params.continued]      - L列: 継続状況
 * @param {string} [params.churned]        - M列: 離反状況
 *
 * @returns {Promise<number|null>} 書き込んだ行番号（失敗時はnull）
 */
async function appendToSheet({
  userId,
  displayName,
  symptom,
  inquiry,
  reservationStatus,
  postureType,
  stress,
  sleep,
  deskWork,
  aiSummary,
  visited,
  continued,
  churned,
}) {
  if (!SPREADSHEET_ID) {
    throw new Error('[sheets.js] 環境変数 SPREADSHEET_ID が設定されていません。');
  }

  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const row = [
    now,                           // A: 日時
    displayName      ?? '不明',    // B: LINE表示名
    symptom          ?? '不明',    // C: 症状
    inquiry          ?? '',        // D: 問診内容
    reservationStatus ?? '未予約', // E: 予約状況
    postureType      ?? '',        // F: 姿勢タイプ
    stress           ?? '',        // G: ストレス
    sleep            ?? '',        // H: 睡眠
    deskWork         ?? '',        // I: デスクワーク
    aiSummary        ?? '',        // J: AI要約
    visited          ?? '',        // K: 来院
    continued        ?? '',        // L: 継続
    churned          ?? '',        // M: 離反
    userId           ?? '',        // N: ユーザーID（行の特定に使用）
  ];

  const authClient = await getAuthClient();
  const sheets     = google.sheets({ version: 'v4', auth: authClient });

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId:   SPREADSHEET_ID,
    range:           SHEET_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  // 書き込まれた行番号を取得（例: "シート1!A3:N3" → 3）
  const updatedRange = response.data.updates?.updatedRange ?? '';
  const match        = updatedRange.match(/(\d+)(?::\w+\d+)?$/);
  const rowNumber    = match ? parseInt(match[1], 10) : null;

  console.log(`[sheets.js] 保存完了 row=${rowNumber}: ${displayName} / ${symptom}`);
  return rowNumber;
}

/**
 * 指定した行の K（来院）・L（継続）・M（離反）列を更新する
 *
 * @param {number} rowNumber - 更新する行番号
 * @param {Object} statuses
 * @param {string} [statuses.visited]   - K列: 来院状況（例: '済'）
 * @param {string} [statuses.continued] - L列: 継続状況（例: '継続'）
 * @param {string} [statuses.churned]   - M列: 離反状況（例: '離反'）
 */
async function updateUserStatus(rowNumber, { visited, continued, churned } = {}) {
  if (!rowNumber) {
    console.warn('[sheets.js] updateUserStatus: rowNumber が未指定のためスキップ');
    return;
  }
  if (!SPREADSHEET_ID) {
    throw new Error('[sheets.js] 環境変数 SPREADSHEET_ID が設定されていません。');
  }

  // 更新するセルのみ data 配列に追加（undefined は無視）
  const data = [];
  if (visited   !== undefined) data.push({ range: `${SHEET_NAME}!K${rowNumber}`, values: [[visited]]   });
  if (continued !== undefined) data.push({ range: `${SHEET_NAME}!L${rowNumber}`, values: [[continued]] });
  if (churned   !== undefined) data.push({ range: `${SHEET_NAME}!M${rowNumber}`, values: [[churned]]   });

  if (data.length === 0) return; // 更新するものがなければスキップ

  const authClient = await getAuthClient();
  const sheets     = google.sheets({ version: 'v4', auth: authClient });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });

  console.log(`[sheets.js] ステータス更新 row=${rowNumber}:`, { visited, continued, churned });
}

module.exports = { appendToSheet, updateUserStatus };
