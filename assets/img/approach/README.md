# 独自アプローチセクション 画像（3枚）

このディレクトリには、「NAORU整体が、姿勢から変える3つの理由」セクションの**3枚の画像**を配置します。

## 画像の配置方法

各理由に対応する画像を、以下のファイル名でアップロードしてください。

| 配置 | ファイル名 | 推奨する写真 |
|---|---|---|
| REASON 01 | `reason1.jpg` | AI姿勢分析の結果画面・タブレット表示など |
| REASON 02 | `reason2.jpg` | 施術風景（優しい雰囲気・ボキボキしない様子） |
| REASON 03 | `reason3.jpg` | 姿勢の変化が分かる写真（ビフォーアフター等） |

### GitHub Web画面からアップロードする手順

1. GitHub のリポジトリページで `assets/img/approach/` ディレクトリを開く
2. 右上の「Add file」→「Upload files」をクリック
3. 画像ファイルをドラッグ＆ドロップ
4. **ファイル名が `reason1.jpg` / `reason2.jpg` / `reason3.jpg` であることを確認**
5. 「Commit changes」をクリック

## 推奨画像仕様

| 項目 | 推奨 |
|---|---|
| ファイル名 | `reason1.jpg` / `reason2.jpg` / `reason3.jpg` |
| 形式 | JPG / WebP |
| アスペクト比 | **4:3 推奨**（800×600px 等） |
| ファイルサイズ | 各 **200KB以下推奨** |

## 仕様

- 各画像は角丸＋ソフトシャドウのカード内に `object-fit: cover` で表示されます
- 画像が未配置の場合は `placeholder1.svg` 〜 `placeholder3.svg` が自動表示されます

## 別の画像形式・ファイル名を使いたい場合

`index.html` 内の各 `<img src="assets/img/approach/reasonX.jpg" ...>` を編集してください。
