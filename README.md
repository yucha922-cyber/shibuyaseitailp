# NAORU整体 渋谷店 リスティング広告用LP プロジェクト

リスティング広告（Google広告・Yahoo!広告）からの流入を前提に、CVR（コンバージョン率）最大化を目的としたランディングページの戦略・構成・実装プロジェクトです。

## 最終ゴール
**初回体験予約（3,500円／通常6,600円）の申込み獲得**

## サービス前提
| 項目 | 内容 |
|---|---|
| 出店エリア | 東京・渋谷 |
| 通常料金 | 1回30分 6,600円 |
| 回数券 | 4回 25,000円（1回あたり6,250円） |
| 初回限定価格 | 3,500円（通常6,600円） |
| ターゲット年齢 | 30〜50代 男女 |
| 強み候補 | 慢性痛／肩こり／腰痛／姿勢改善 |

---

## 進捗ステータス

- [x] **Phase 1**：戦略・構成・コピーの策定（`docs/` ディレクトリ）
- [x] **Phase 2**：HTML/CSS/JS によるLP実装（`public/` ディレクトリ）← **本コミット時点**
- [ ] Phase 3：計測タグ設置（GA4 / Google広告 / Yahoo!広告 / LINEタグ）と初期広告入稿
- [ ] Phase 4：A/Bテストと改善

---

## ドキュメント（Phase 1 成果物）

| # | ファイル | 内容 |
|---|---|---|
| 01 | [docs/01-strategy-and-positioning.md](docs/01-strategy-and-positioning.md) | 戦略：渋谷競合9院ベンチマーク・メイン訴求症状の決定・男女両ペルソナ設計 |
| 02 | [docs/02-lp-structure-and-copy.md](docs/02-lp-structure-and-copy.md) | LP構成案：FVから最終CTAまでのセクション設計とコピー実例 |
| 03 | [docs/03-compliance-and-beforeafter.md](docs/03-compliance-and-beforeafter.md) | 薬機法・景品表示法・ビフォーアフター掲載対応 |
| 04 | [docs/04-listing-ads.md](docs/04-listing-ads.md) | リスティング広告連動：キーワード／広告文／メッセージマッチ |
| 05 | [docs/05-implementation-notes.md](docs/05-implementation-notes.md) | 実装フェーズ移行時の技術指針 |

---

## LP実装（Phase 2 成果物）

### ディレクトリ構成
```
（リポジトリルート）
├── index.html         # メインLP（全15セクション、Phase1構成案を完全反映）
├── thanks.html        # サンクスページ（CV計測タグ発火位置）
├── privacy.html       # プライバシーポリシー
├── terms.html         # 利用規約
├── assets/
│   ├── css/main.css   # 全スタイル（モバイルファースト・男女両対応のカラー設計）
│   ├── js/main.js     # FAQアコーディオン・追従CTA・スムーズスクロール・フォームバリデーション
│   └── img/           # 画像素材（実装時に差し替え）
├── docs/              # Phase 1 戦略ドキュメント群
└── README.md          # 本ファイル
```

> GitHub Pages で公開する場合、リポジトリルートの `index.html` がトップページとして配信されます。

### LPの主要セクション
FV / 共感（お悩み） / 放置リスク / 独自アプローチ（AI姿勢分析 ×3理由） / 姿勢ビフォーアフター / お客様の声（男女1:1配分） / 比較表 / 中間CTA / 施術の流れ（6ステップ） / 施術者紹介（男女両方） / アクセス / 料金 / FAQ / 最終CTA / 予約フォーム

### 設計上のポイント
- **男女両ペルソナへの配慮**：ピンク・赤系を避けた白×ネイビー×ティールの中立的カラーパレット、お客様の声と施術者紹介を男女ほぼ1:1で配分、フォームに「施術者の性別希望」プルダウンを実装
- **モバイルファースト**：渋谷×整体検索の8割超を占めるSPに最適化、追従CTAバーで常時CV機会を提供
- **薬機法・景品表示法対応**：NG表現（治る／効果／No.1等）を完全排除、ビフォーアフターとお客様の声には必須注釈を明記
- **パフォーマンス**：外部ライブラリ不使用（jQuery等なし）、CSS/JSは最小限、画像はlazy loading前提

### 公開URLでの確認（GitHub Pages）

リポジトリルートに `index.html` を配置済みのため、GitHub Pagesを有効化すれば公開URLでLPがそのまま表示されます。

```
https://yucha922-cyber.github.io/shibuyaseitailp/
```

### ローカル確認方法

リポジトリルートで静的サーバーを起動してください。

```bash
# Python の例
python3 -m http.server 8000

# Node.js（npx）の例
npx serve .

# VS Code Live Server拡張でも可
```

ブラウザで `http://localhost:8000/` を開くとLPが表示されます。

### 画像差し替えポイント

実装時に置き換える必要があるプレースホルダー部分は、HTML内に `[ ... ]` の形でコメント表記しています。主な必要素材：

| 配置 | 推奨素材 | 推奨サイズ |
|---|---|---|
| FV右側ビジュアル | 院内 or 施術風景 or AI姿勢分析画面 | 800×1000px / WebP / 200KB以下 |
| 独自アプローチ × 3 | AI画面 / 施術風景 / 推移グラフ | 各 800×600px |
| ビフォーアフター × 3組 | 横向き姿勢写真（同条件撮影） | 各 600×800px |
| 施術者紹介 × 2 | 男女施術者のプロフェッショナル写真 | 各 800×600px |
| 店舗地図 | Google Maps 埋め込みコード | iframe |
| OG画像 | ブランドビジュアル | 1200×630px |

### 計測タグ設置位置（Phase 3 で実装）

`public/index.html` および `public/thanks.html` 内のコメントアウトされた `<!-- 計測タグ -->` ブロックに、以下のIDを差し替えて有効化してください：

- Google Analytics 4：`G-XXXXXXXXXX`
- Google広告コンバージョン：`AW-XXXXXXXXXX/XXXXXXXXXXXXX`
- Yahoo!広告コンバージョンタグ
- LINE Tag
- Microsoft Clarity（任意・ヒートマップ）

詳細は [docs/04-listing-ads.md](docs/04-listing-ads.md) の §4-8 を参照。

---

## 次のアクション

1. **デザインレビュー**：ローカル起動してUI/UXを確認
2. **写真・地図素材の準備**：上記「画像差し替えポイント」に従って素材手配
3. **計測タグID発行**：Google広告アカウント、GA4プロパティ、Yahoo!広告アカウントの準備
4. **法令最終チェック**：[docs/03-compliance-and-beforeafter.md](docs/03-compliance-and-beforeafter.md) の最終チェックリストを通す（公開前に薬機法・景表法の専門家チェックを推奨）
5. **ホスティング決定 → 公開**：Cloudflare Pages / Vercel / Netlify いずれかを推奨
