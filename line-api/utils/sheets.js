/**
 * Google Sheets への書き込みユーティリティ
 *
 * 使い方:
 *   const { appendToSheet } = require('./utils/sheets');
 *   await appendToSheet({ displayName, symptom, inquiry, reservationStatus });
 *
 * 必要な環境変数:
 *   SPREADSHEET_ID  : GoogleスプレッドシートのID（URLの /d/〇〇〇/ の部分）
 *
 * 認証情報（どちらか一方を設定すればOK）:
 *   ◆ Vercel本番  : GOOGLE_CREDENTIALS_JSON に credentials.json の中身を丸ごと貼り付け
 *   ◆ ローカル開発 : GOOGLE_CREDENTIALS_PATH に json ファイルのパスを指定
 *                    （省略時は line-api/credentials.json を自動で探す）
 *
 * 必要な準備:
 *   1. Google Cloud Console でサービスアカウントを作成し json をダウンロード
 *   2. スプレッドシートにサービスアカウントのメールアドレスを「編集者」として共有
 *   3. SPREADSHEET_ID と認証情報を環境変数に設定
 */

const { google } = require('googleapis');
const path = require('path');

// ---- 設定 ----------------------------------------------------------------

// スプレッドシートIDを環境変数から取得（必須）
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// credentials.json のパス（環境変数で上書き可能。省略時は line-api/credentials.json）
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH
  ? path.resolve(process.env.GOOGLE_CREDENTIALS_PATH)
  : path.resolve(__dirname, '..', 'credentials.json');

// データを書き込むシート名と開始列（A列〜E列 = 5列分）
const SHEET_RANGE = 'Sheet1!A:E';

// 認証に必要なスコープ（スプレッドシートの読み書き）
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// ---- 認証 ----------------------------------------------------------------

/**
 * Service Account 認証クライアントを生成する
 *
 * 優先順位:
 *   1. GOOGLE_CREDENTIALS_JSON（環境変数にJSON文字列）→ Vercel本番向け
 *   2. credentials.json ファイル（keyFile）          → ローカル開発向け
 */
async function getAuthClient() {
  // --- パターン1: 環境変数にJSONが入っている場合（Vercel本番） ---
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } catch (err) {
      throw new Error(
        '[sheets.js] GOOGLE_CREDENTIALS_JSON の形式が不正です（JSONとして解析できません）。'
      );
    }
    const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
    return auth.getClient();
  }

  // --- パターン2: ファイルから読み込む場合（ローカル開発） ---
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SCOPES,
  });
  return auth.getClient();
}

// ---- メイン関数 ----------------------------------------------------------

/**
 * スプレッドシートに1行追記する
 *
 * @param {Object} params
 * @param {string} params.displayName      - LINEの表示名
 * @param {string} params.symptom          - 症状（例: 肩こり、腰痛）
 * @param {string} params.inquiry          - 問診内容（ユーザーが送ったテキスト）
 * @param {string} params.reservationStatus - 予約状況（例: 予約済み、未予約）
 *
 * ※ 将来的に OpenAI 問診へ拡張する場合は、この関数の params に
 *    { aiSummary, aiDiagnosis } などを追加し、列を増やすだけで対応できます。
 */
async function appendToSheet({ displayName, symptom, inquiry, reservationStatus }) {
  // 環境変数チェック（設定忘れを早期検出）
  if (!SPREADSHEET_ID) {
    throw new Error(
      '[sheets.js] 環境変数 SPREADSHEET_ID が設定されていません。.env を確認してください。'
    );
  }

  // 書き込む行データを配列で定義（列順: 日時 / 表示名 / 症状 / 問診内容 / 予約状況）
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const row = [now, displayName ?? '不明', symptom ?? '不明', inquiry ?? '', reservationStatus ?? '未予約'];

  // 認証クライアントを取得
  const authClient = await getAuthClient();

  // Sheets API クライアントを生成
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // append でシートの末尾に1行追記
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'USER_ENTERED', // 日付などを自動フォーマット
    insertDataOption: 'INSERT_ROWS',  // 既存データを上書きせず末尾に追加
    requestBody: {
      values: [row],
    },
  });

  console.log(`[sheets.js] スプレッドシートに保存しました: ${row.join(' | ')}`);
}

module.exports = { appendToSheet };
