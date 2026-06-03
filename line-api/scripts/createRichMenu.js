/**
 * リッチメニュー作成スクリプト（一回だけ実行）
 *
 * 役割:
 *   LINE Messaging API にリッチメニューを登録し、
 *   全ユーザーのデフォルトメニューとして設定する。
 *
 * 実行方法:
 *   1. line-api/ ディレクトリで以下を実行:
 *      CHANNEL_ACCESS_TOKEN=xxxx node scripts/createRichMenu.js
 *
 *   2. 表示された richMenuId をメモする
 *
 *   3. LINE Developers Console でリッチメニュー画像をアップロードする
 *      → Messaging API → Rich menus → 該当メニュー → Upload image
 *      → 画像サイズ: 2500 × 1686 px（PNG または JPEG）
 *
 * ※ このスクリプトは一度実行すれば OK です。再実行すると新しいメニューが追加されます。
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const https = require('https');
const { RICH_MENU_BODY } = require('../utils/richMenu');

const ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('❌ 環境変数 CHANNEL_ACCESS_TOKEN が設定されていません。');
  process.exit(1);
}

// ---- LINE API ヘルパー --------------------------------------------------

/**
 * LINE API に HTTPS リクエストを送る
 * @param {string} method - 'GET' / 'POST' / 'DELETE'
 * @param {string} path   - APIパス（例: /v2/bot/richmenu）
 * @param {Object} [body] - リクエストボディ（オブジェクト）
 */
function lineApiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';

    const options = {
      hostname: 'api.line.me',
      path,
      method,
      headers: {
        Authorization:  `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

// ---- メイン処理 ---------------------------------------------------------

async function main() {
  console.log('🚀 リッチメニューを作成します...\n');

  // ① リッチメニューを作成
  console.log('① リッチメニューを作成中...');
  const createRes = await lineApiRequest('POST', '/v2/bot/richmenu', RICH_MENU_BODY);

  if (createRes.status !== 200) {
    console.error('❌ リッチメニューの作成に失敗しました:', createRes.body);
    process.exit(1);
  }

  const richMenuId = createRes.body.richMenuId;
  console.log(`✅ 作成成功！ richMenuId: ${richMenuId}\n`);

  // ② 全ユーザーのデフォルトメニューとして設定
  console.log('② デフォルトメニューとして設定中...');
  const defaultRes = await lineApiRequest(
    'POST',
    `/v2/bot/user/all/richmenu/${richMenuId}`,
  );

  if (defaultRes.status !== 200) {
    console.error('❌ デフォルト設定に失敗しました:', defaultRes.body);
    console.log(`   richMenuId: ${richMenuId} は作成されています。`);
    console.log('   LINE Developers Console で手動でデフォルト設定してください。');
    process.exit(1);
  }

  console.log('✅ デフォルトメニューに設定しました！\n');

  // ---- 次のステップの案内 -----------------------------------------------
  console.log('='.repeat(60));
  console.log('📋 次のステップ: リッチメニュー画像をアップロードしてください');
  console.log('='.repeat(60));
  console.log('');
  console.log('1. LINE Developers Console を開く');
  console.log('   https://developers.line.biz/');
  console.log('');
  console.log('2. チャンネル → Messaging API → Rich menus');
  console.log('');
  console.log(`3. richMenuId: ${richMenuId} のメニューを選択`);
  console.log('');
  console.log('4. "Upload image" から画像をアップロード');
  console.log('   - サイズ: 2500 × 1686 px');
  console.log('   - 形式:   PNG または JPEG');
  console.log('   - ボタン配置（左→右、上→下）:');
  console.log('     [AI問診] [AI姿勢分析] [予約する]');
  console.log('     [スタッフ相談] [料金案内] [アクセス]');
  console.log('');
  console.log(`✅ richMenuId をメモ: ${richMenuId}`);
}

main().catch((err) => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
