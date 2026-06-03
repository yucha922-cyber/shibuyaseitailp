/**
 * Google Sheets CRM ユーティリティ
 *
 * 2シート構成:
 *
 *  ┌─────────────────────────────────────────────────────────┐
 *  │ シート①「患者マスター」: 1患者 = 1行（upsert方式）         │
 *  │   主キー: LINE User ID（A列）                              │
 *  │   既存なら更新 / なければ新規作成                          │
 *  ├─────────────────────────────────────────────────────────┤
 *  │ シート②「対応履歴」: すべての行動ログ（append方式）        │
 *  │   1イベント = 1行を末尾に追記                              │
 *  └─────────────────────────────────────────────────────────┘
 *
 * 必要な環境変数:
 *   SPREADSHEET_ID          : スプレッドシートID
 *   GOOGLE_CREDENTIALS_JSON : credentials.json の中身（Vercel本番）
 *   GOOGLE_CREDENTIALS_PATH : credentials.json のパス（ローカル開発、省略可）
 *
 * 関数一覧:
 *   upsertPatient(patient) : 患者マスターを upsert（更新 or 新規作成）
 *   appendHistory(log)     : 対応履歴に1行追記
 */

const { google } = require('googleapis');
const path       = require('path');

// ---- 設定 ---------------------------------------------------------------

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID;
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH
  ? path.resolve(process.env.GOOGLE_CREDENTIALS_PATH)
  : path.resolve(__dirname, '..', 'credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// シート名（スプレッドシートのタブ名と一致させること）
const PATIENT_SHEET = '患者マスター';
const HISTORY_SHEET = '対応履歴';

// ---- 患者マスターの列定義 -------------------------------------------------
//
// 配列の順番がそのまま列（A, B, C...）になる。
// key      : upsertPatient() に渡すオブジェクトのフィールド名
// header   : スプレッドシート1行目に入れるヘッダー名

const PATIENT_COLUMNS = [
  { key: 'userId',        header: 'LINE User ID'   }, // A（主キー）
  { key: 'displayName',   header: 'LINE表示名'     }, // B
  { key: 'symptom',       header: '症状'           }, // C
  { key: 'inquiry',       header: '問診内容'       }, // D
  { key: 'aiSummary',     header: 'AI要約'         }, // E
  { key: 'postureType',   header: '姿勢タイプ'     }, // F
  { key: 'stress',        header: 'ストレス'       }, // G
  { key: 'sleep',         header: '睡眠'           }, // H
  { key: 'deskWork',      header: 'デスクワーク'   }, // I
  { key: 'reservation',   header: '予約状況'       }, // J
  { key: 'supportStatus', header: '対応ステータス' }, // K
  { key: 'visited',       header: '来院'           }, // L
  { key: 'continued',     header: '継続'           }, // M
  { key: 'churned',       header: '離反'           }, // N
  // ---- CRM強化列（整体院向け）----
  { key: 'firstVisitAt',  header: '初回来院日'     }, // O  来院分析
  { key: 'lastVisitAt',   header: '最終来院日'     }, // P  再来管理
  { key: 'staff',         header: '担当者'         }, // Q  誰が対応したか
  { key: 'visitCount',    header: '予約回数'       }, // R  継続率分析
  { key: 'ltv',           header: 'LTV'            }, // S  顧客価値分析
  { key: 'referrer',      header: '紹介者'         }, // T  紹介管理
  { key: 'updatedAt',     header: '最終更新日時'   }, // U
];

// ---- 認証 ---------------------------------------------------------------

/**
 * Service Account 認証クライアントを生成する
 *   1. GOOGLE_CREDENTIALS_JSON（環境変数）→ Vercel本番
 *   2. credentials.json ファイル          → ローカル開発
 */
async function getAuthClient() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    let credentials;
    try { credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch { throw new Error('[sheets.js] GOOGLE_CREDENTIALS_JSON の形式が不正です。'); }
    return (new google.auth.GoogleAuth({ credentials, scopes: SCOPES })).getClient();
  }
  return (new google.auth.GoogleAuth({ keyFile: CREDENTIALS_PATH, scopes: SCOPES })).getClient();
}

/**
 * Sheets API クライアントを取得する（共通処理）
 */
async function getSheets() {
  if (!SPREADSHEET_ID) throw new Error('[sheets.js] SPREADSHEET_ID が未設定です。');
  const authClient = await getAuthClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * 列番号(0始まり)をスプレッドシートの列名(A,B,...,Z,AA)に変換する
 * 例: 0→A, 1→B, 25→Z, 26→AA
 */
function columnLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

// 患者マスターの最終列（O列など）を自動計算
const PATIENT_LAST_COL = columnLetter(PATIENT_COLUMNS.length - 1);

// ---- ① 患者マスター（upsert方式）---------------------------------------

/**
 * 患者マスターを upsert する（存在すれば更新、なければ新規作成）
 *
 * @param {Object} patient - 患者データ（PATIENT_COLUMNS の key に対応）
 * @param {string} patient.userId        - LINE User ID（主キー・必須）
 * @param {string} [patient.displayName] - LINE表示名
 * @param {string} [patient.symptom]     - 症状
 * @param {string} [patient.inquiry]     - 問診内容
 * @param {string} [patient.aiSummary]   - AI要約
 * @param {string} [patient.postureType] - 姿勢タイプ
 * @param {string} [patient.stress]      - ストレス
 * @param {string} [patient.sleep]       - 睡眠
 * @param {string} [patient.deskWork]    - デスクワーク
 * @param {string} [patient.reservation] - 予約状況
 * @param {string} [patient.supportStatus] - 対応ステータス
 * @param {string} [patient.visited]      - 来院
 * @param {string} [patient.continued]    - 継続
 * @param {string} [patient.churned]      - 離反
 * @param {string} [patient.firstVisitAt] - 初回来院日（来院分析）
 * @param {string} [patient.lastVisitAt]  - 最終来院日（再来管理）
 * @param {string} [patient.staff]        - 担当者
 * @param {string|number} [patient.visitCount] - 予約回数（継続率分析）
 * @param {string|number} [patient.ltv]   - LTV（顧客価値分析）
 * @param {string} [patient.referrer]     - 紹介者（紹介管理）
 *
 * @returns {Promise<number|null>} 更新/作成した行番号
 *
 * 【重要】
 *   undefined のフィールドは「更新しない」（既存値を保持）。
 *   空文字 '' を渡すと「空に上書き」される。
 */
async function upsertPatient(patient) {
  if (!patient.userId) throw new Error('[sheets.js] upsertPatient: userId は必須です。');

  const sheets = await getSheets();

  // --- ステップ1: A列（User ID）を全て読み込み、既存行を探す ---
  const idColumn = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${PATIENT_SHEET}!A:A`,
  });

  const ids      = idColumn.data.values ?? []; // [['LINE User ID'], ['Uxxx'], ...]
  let   rowIndex = -1;                          // 見つかった行番号（1始まり）

  // 1行目はヘッダーなので2行目(index=1)から探す
  for (let i = 1; i < ids.length; i++) {
    if (ids[i][0] === patient.userId) {
      rowIndex = i + 1; // 配列index(0始まり) → 行番号(1始まり)
      break;
    }
  }

  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  if (rowIndex === -1) {
    // --- 新規作成: 末尾に1行追加 ---
    // 渡されていないフィールドは空文字にする
    const row = PATIENT_COLUMNS.map((col) => {
      if (col.key === 'userId')    return patient.userId;
      if (col.key === 'updatedAt') return now;
      return patient[col.key] ?? '';
    });

    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId:    SPREADSHEET_ID,
      range:            `${PATIENT_SHEET}!A:${PATIENT_LAST_COL}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody:      { values: [row] },
    });

    const updatedRange = appendRes.data.updates?.updatedRange ?? '';
    const match        = updatedRange.match(/(\d+)(?::\w+\d+)?$/);
    const newRow       = match ? parseInt(match[1], 10) : null;

    console.log(`[sheets.js] 患者マスター 新規作成 row=${newRow}: ${patient.displayName}`);
    return newRow;
  }

  // --- 更新: 既存行を読み込み、渡されたフィールドだけ差し替える ---
  const existingRow = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${PATIENT_SHEET}!A${rowIndex}:${PATIENT_LAST_COL}${rowIndex}`,
  });
  const current = existingRow.data.values?.[0] ?? [];

  const merged = PATIENT_COLUMNS.map((col, i) => {
    if (col.key === 'updatedAt') return now;             // 更新日時は常に最新
    if (patient[col.key] !== undefined) return patient[col.key]; // 渡された値で上書き
    return current[i] ?? '';                             // それ以外は既存値を維持
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${PATIENT_SHEET}!A${rowIndex}:${PATIENT_LAST_COL}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody:      { values: [merged] },
  });

  console.log(`[sheets.js] 患者マスター 更新 row=${rowIndex}: ${patient.displayName}`);
  return rowIndex;
}

/**
 * 患者マスターから1患者の現在データを取得する（無ければ null）
 *
 * 予約回数の加算や「初回来院日が未設定なら入れる」といった
 * 既存値を踏まえた更新をしたいときに使う。
 *
 * @param {string} userId - LINE User ID
 * @returns {Promise<Object|null>} PATIENT_COLUMNS の key をプロパティに持つオブジェクト
 */
async function getPatient(userId) {
  if (!userId) return null;
  const sheets = await getSheets();

  const idColumn = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${PATIENT_SHEET}!A:A`,
  });

  const ids = idColumn.data.values ?? [];
  let rowIndex = -1;
  for (let i = 1; i < ids.length; i++) {
    if (ids[i][0] === userId) { rowIndex = i + 1; break; }
  }
  if (rowIndex === -1) return null;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${PATIENT_SHEET}!A${rowIndex}:${PATIENT_LAST_COL}${rowIndex}`,
  });
  const cells = res.data.values?.[0] ?? [];

  const patient = {};
  PATIENT_COLUMNS.forEach((col, i) => { patient[col.key] = cells[i] ?? ''; });
  return patient;
}

// ---- ② 対応履歴（append方式）-------------------------------------------

/**
 * 対応履歴に1行追記する（すべての行動ログ）
 *
 * @param {Object} log
 * @param {string} log.userId      - LINE User ID
 * @param {string} log.displayName - LINE表示名
 * @param {string} log.eventType   - イベント種別（例: AI問診開始 / 予約 / 来院）
 * @param {string} [log.content]   - 内容（メッセージ本文や補足）
 */
async function appendHistory({ userId, displayName, eventType, content }) {
  const sheets = await getSheets();

  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const row = [
    now,                  // A: 日時
    userId      ?? '',    // B: LINE User ID
    displayName ?? '不明',// C: LINE表示名
    eventType   ?? '',    // D: イベント種別
    content     ?? '',    // E: 内容
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${HISTORY_SHEET}!A:E`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: [row] },
  });

  console.log(`[sheets.js] 対応履歴 追記: ${eventType} / ${displayName}`);
}

module.exports = {
  upsertPatient,
  getPatient,
  appendHistory,
  PATIENT_COLUMNS, // セットアップ用にエクスポート
};
