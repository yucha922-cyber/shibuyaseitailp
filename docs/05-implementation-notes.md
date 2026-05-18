# 05. 実装フェーズ移行時のメモ

> Phase 1（戦略・構成）完了後、Phase 2（実装）に進む際の技術的な指針をまとめたメモです。
> 実装着手前にクライアント・チームで本ドキュメントの方針を確認してください。

---

## 5-1. 技術スタックの選択肢

| アプローチ | メリット | デメリット | 推奨ケース |
|---|---|---|---|
| **静的HTML + CSS + 軽量JS** | 表示速度最速・SEO良好・運用負荷最小・改修自由度高 | フォーム・CMS機能は別途 | **本プロジェクトの推奨** |
| **Next.js（静的書き出し）** | コンポーネント化・将来拡張性・型安全 | ビルド環境必要・運用やや複雑 | 複数LP展開や、他サービスとの統合があるなら |
| **WordPress + LPテーマ** | 非エンジニアでも更新可能 | 表示速度・セキュリティ・運用コスト懸念 | 社内更新運用が多いなら |
| **Studio／STUDIOなどノーコード** | デザインから本番までノーコード | カスタマイズ自由度・計測タグ柔軟性に制約 | スピード優先・初期検証なら |

### 本プロジェクトの推奨：静的HTML + Vanilla CSS + 軽量JS

理由：
- 1ページの完結したLPであり、SPA化のメリットが薄い
- 表示速度はCVRに直結する（Googleのページエクスペリエンスも考慮）
- LP改善のスピード（A/Bテスト・コピー差替え）を最優先したい
- 計測タグの設置自由度が最も高い
- GitHub Pages / Cloudflare Pages / Vercel Static で無料〜低コストにホスト可能

---

## 5-2. 推奨ディレクトリ構成（実装時）

```
shibuyaseitailp/                       # リポジトリルート ＝ Webサイトルート
├── README.md
├── index.html                        # メインLP（GitHub Pagesのトップページ）
├── thanks.html                       # サンクスページ（CV計測タグ発火）
├── privacy.html                      # プライバシーポリシー
├── terms.html                        # 利用規約
├── assets/
│   ├── css/
│   │   └── main.css
│   ├── js/
│   │   └── main.js                  # スクロール追従・FAQ開閉・フォームバリデーション
│   └── img/
│       ├── fv/                      # ファーストビュー画像
│       ├── ai-analysis/             # AI姿勢分析関連
│       ├── staff/                   # 施術者写真
│       ├── store/                   # 店舗写真
│       ├── flow/                    # 施術の流れ
│       ├── testimonials/            # お客様写真（実写 or イラスト）
│       └── beforeafter/             # 姿勢の変化事例（注釈必須）
├── docs/                            # 戦略ドキュメント（Phase 1成果物）
│   ├── 01-strategy-and-positioning.md
│   ├── 02-lp-structure-and-copy.md
│   ├── 03-compliance-and-beforeafter.md
│   ├── 04-listing-ads.md
│   └── 05-implementation-notes.md
└── .gitignore
```

> **設計判断**：LP（`index.html`）をリポジトリルートに配置することで、GitHub Pages / Cloudflare Pages / Vercel Static の各種ホスティングサービスで設定変更なしにそのまま公開できます。

---

## 5-3. パフォーマンス目標（CVR直結のため必達）

| 指標 | 目標値 | 計測ツール |
|---|---|---|
| **LCP**（Largest Contentful Paint） | **2.5秒以下** | PageSpeed Insights, Lighthouse |
| **CLS**（Cumulative Layout Shift） | **0.1以下** | 同上 |
| **INP**（Interaction to Next Paint） | **200ms以下** | 同上 |
| **TTFB**（Time to First Byte） | **0.8秒以下** | WebPageTest |
| **PageSpeed Insights スコア** | モバイル **80以上**、デスクトップ **90以上** | PageSpeed Insights |
| **ページサイズ合計（gzip後）** | **1.5MB以下** | Chrome DevTools |

### 達成のための具体策

- **画像最適化**
  - WebP / AVIF 形式を採用（JPEG/PNGはフォールバック）
  - `loading="lazy"` を FV 以外に適用
  - `srcset` でデバイス幅別配信
  - FV画像は WebP で 100KB 以下を目標
- **CSS / JS最適化**
  - Critical CSS をインライン化（FV関連は head に）
  - JS は `defer` 推奨、`async` は計測タグなど独立スクリプト限定
  - 外部ライブラリは原則使わない（jQuery等不要）
  - フォントはサブセット化、`font-display: swap`
- **CDN・配信**
  - Cloudflare Pages / Vercel / Cloudflare CDN 経由
  - HTTP/2 or HTTP/3 必須
  - Brotli 圧縮を有効化

---

## 5-4. レスポンシブ設計

### ブレークポイント
- SP：〜767px
- TB：768〜1024px
- PC：1025px〜

### モバイルファースト
渋谷×整体の検索の **80%以上はモバイル想定**。CSS は SP 基準で書き、PC は media query で拡張。

### タッチターゲット
- ボタン・リンクの最小サイズ：48px × 48px
- 親指で押しやすい位置（SPでは画面下1/3を意識）

---

## 5-5. アクセシビリティ（最低限）

- `lang="ja"` を `<html>` に設定
- 画像にはすべて `alt` を設定
- フォーム要素は `<label>` 必須
- カラーコントラスト比 4.5:1 以上
- キーボード操作可能（フォーム・FAQ・ナビ）
- 動画・アニメーションは prefers-reduced-motion を尊重

---

## 5-6. SEO（最低限）

- `<title>` ：「肩こり・腰痛・姿勢矯正のNAORU整体 渋谷店【公式】初回3,500円｜AI姿勢分析」
- `<meta name="description">` ：130〜140字程度
- OG画像（1200×630px）
- Twitter Card（summary_large_image）
- JSON-LD：LocalBusiness（住所・電話・営業時間・地理座標）
- canonical設定
- robots.txt / sitemap.xml

---

## 5-7. フォーム設計の注意

- **入力項目最小化**：氏名・電話・希望日時の3項目を必須に、それ以上は任意
- **HTML5バリデーション + JSバリデーション** の二重防衛
- 電話番号は `inputmode="tel"`、メールは `inputmode="email"`
- 送信ボタンは送信中の二重送信を防ぐ（disable）
- 送信成功時：thanks.html へリダイレクト → CVタグ発火
- 失敗時：ユーザーに明確にエラー表示、入力内容は保持
- スパム対策：Honeypot field + reCAPTCHA v3（v2はUX低下）

---

## 5-8. LINE予約導線

- LINE公式アカウントの「友だち追加URL」を CTA に設置
- 友だち追加後の自動応答メッセージで予約フォームを送付（リッチメニューも活用）
- LINE Tag を設置し、LINE経由予約のCV計測を行う
- **重要**：LINE経由のCVもサンクスページに着地させて広告タグを発火させる設計が望ましい

---

## 5-9. ホスティング推奨

| サービス | 月額（初期想定） | メリット |
|---|---|---|
| **Cloudflare Pages** | 無料 | 高速CDN、ビルド統合、GitHub連携、独自ドメイン無料 |
| **Vercel** | 無料〜 | Next.jsと相性◎、プレビュー機能、GitHub連携 |
| **Netlify** | 無料〜 | フォーム機能内蔵、シンプル運用 |
| **AWS S3 + CloudFront** | 低額 | 自社AWS環境がある場合 |
| **さくらインターネット 等の国内サーバー** | 数百円〜 | 国内サポート重視の場合 |

---

## 5-10. ドメイン・URL設計

- 専用ドメイン or NAORUコーポレートのサブドメイン推奨
  - 例：`shibuya-lp.naorusalon.com` 等
- HTTPS必須（Let's Encrypt無料証明書）
- URL構造：`/`（LP）, `/thanks`（サンクス）, `/privacy`, `/terms`

---

## 5-11. リリース前最終チェックリスト

- [ ] [03-compliance-and-beforeafter.md](03-compliance-and-beforeafter.md) のチェックリストをすべてクリア
- [ ] 全リンクの動作確認（404なし）
- [ ] フォーム送信テスト（CV計測まで一気通貫）
- [ ] LINE予約テスト
- [ ] 主要ブラウザ確認（Chrome / Safari / Edge / Firefox）
- [ ] iOS Safari / Android Chrome での実機確認
- [ ] PageSpeed Insights スコア確認（モバイル80以上）
- [ ] GA4 イベント発火確認（リアルタイムレポート）
- [ ] Google広告コンバージョンタグ確認（テストCV）
- [ ] Yahoo!広告コンバージョンタグ確認
- [ ] favicon、OG画像、Twitter Card 表示確認
- [ ] 法令最終チェック（薬機法・景品表示法）
- [ ] プライバシーポリシー・利用規約ページ設置
- [ ] Google Search Console 登録、sitemap.xml 送信
- [ ] バックアップ取得（初期リリース版）

---

## 5-12. 運用開始後の改善サイクル

| 頻度 | アクション |
|---|---|
| **日次** | 広告管理画面で消化額・CV数・CPA確認、明らかに悪いKWは即停止 |
| **週次** | LP改善仮説の優先順位付け、A/Bテスト計画、KW入札調整、検索語句レポート確認 |
| **月次** | CVR・CPA・LTVの月次振り返り、レポート作成、次月の方針決定 |
| **四半期** | LP大幅改修（FV/オファー/構成見直し）の検討、競合再調査 |

---

## 次のアクション（Phase 2 移行時）

1. **必要素材の準備**
   - 院内写真（広角・複数アングル）
   - 施術風景写真（スタッフ・お客様の同意取得）
   - AI姿勢分析の画面キャプチャ（実機 or デザインモック）
   - 院長・施術者の顔写真（プロフェッショナル撮影推奨）
   - お客様の声（事前ヒアリング・同意書）
   - 姿勢ビフォーアフター（同意・注釈必須）
   - ロゴ・ブランドカラー指定

2. **デザインカンプ作成**
   - Figma等でPC・SP両対応のカンプ
   - ステークホルダーレビュー → 確定

3. **コーディング着手**
   - 本ディレクトリ構成に従って実装
   - パフォーマンス目標を意識した実装

4. **計測タグ準備**
   - Google広告アカウント、GA4プロパティ、Yahoo!広告アカウント、LINE公式アカウントの準備
   - 各コンバージョンタグ発行

5. **公開・広告入稿**
   - リリース前最終チェックリスト完了
   - 広告は[04-listing-ads.md](04-listing-ads.md)の設計に基づき入稿
