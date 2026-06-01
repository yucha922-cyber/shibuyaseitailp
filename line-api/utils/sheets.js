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

// データを書き込むシート名と範囲（A列〜M列 = 13列分）
// 列構成: A日時 / B表示名 / C症状 / D問診内容 / E予約状況 /
//         F姿勢タイプ / Gストレス / H睡眠 / Iデスクワーク / JAI要約 /
//         K来院 / L継続 / M離反
const SHEET_RANGE = 'シート1!A:M';

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
 * @param {string} params.displayName       - B列: LINEの表示名
 * @param {string} params.symptom           - C列: 症状（例: 肩こり、腰痛）
 * @param {string} params.inquiry           - D列: 問診内容（ユーザーが送ったテキスト）
 * @param {string} params.reservationStatus - E列: 予約状況（例: 予約済み、未予約）
 *
 * --- 以下は OpenAI 問診・CRM 用の拡張フィールド（任意・省略時は空欄） ---
 * @param {string} [params.postureType] - F列: 姿勢タイプ（例: 猫背、反り腰）
 * @param {string} [params.stress]      - G列: ストレス（AI判定）
 * @param {string} [params.sleep]       - H列: 睡眠（AI判定）
 * @param {string} [params.deskWork]    - I列: デスクワーク（AI判定）
 * @param {string} [params.aiSummary]   - J列: AI要約（OpenAIによる問診まとめ）
 * @param {string} [params.visited]     - K列: 来院（例: 済、未）
 * @param {string} [params.continued]   - L列: 継続（リピート状況）
 * @param {string} [params.churned]     - M列: 離反（離反フラグ）
 *
 * ※ OpenAI 問診を実装する際は、上記フィールドを呼び出し側で渡すだけで
 *    自動的に対応する列へ保存されます（コード変更不要）。
 */
async function appendToSheet({
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
  // 環境変数チェック（設定忘れを早期検出）
  if (!SPREADSHEET_ID) {
    throw new Error(
      '[sheets.js] 環境変数 SPREADSHEET_ID が設定されていません。.env を確認してください。'
    );
  }

  // 書き込む行データを配列で定義（A列〜M列の順番に対応）
  // 未指定の拡張フィールドは空文字 '' を入れて列ズレを防ぐ
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const row = [
    now,                          // A: 日時
    displayName ?? '不明',        // B: LINE表示名
    symptom ?? '不明',            // C: 症状
    inquiry ?? '',                // D: 問診内容
    reservationStatus ?? '未予約', // E: 予約状況
    postureType ?? '',            // F: 姿勢タイプ
    stress ?? '',                 // G: ストレス
    sleep ?? '',                  // H: 睡眠
    deskWork ?? '',               // I: デスクワーク
    aiSummary ?? '',              // J: AI要約
    visited ?? '',                // K: 来院
    continued ?? '',              // L: 継続
    churned ?? '',                // M: 離反
  ];

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
