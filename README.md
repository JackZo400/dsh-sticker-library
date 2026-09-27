# dsh-sticker-library

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的**聊天表情包库**：收图去重、视觉模型自己打标、按含义挑图，附两条安全线。

它不是「把图片存进一个文件夹」——那种事 `mkdir` 就够了。它管的是**让一个 Agent 真的会用表情包**这件事里最容易做错的四步。

## 为什么要单独做一个

**1. 什么算表情包。**
拿 `summary === '[图片]'` 之类的启发式去认，会把群友发的**真人照片、截图、表情包混成一锅**收进库。只认协议明确标出来的贴图（OneBot 的 `emoji_id` / `sub_type=1` 那类），其余一律不进。

**2. 怎么算「懂」这张图。**
固定标签表是最省事也最没用的做法：我们试过 40 个固定词，40 多张图被压成「可爱 / 卖萌 / 无语」三类，挑图基本等于随机。让视觉模型自己写三行——**画的是什么 / 什么场合发 / 关键词**——它才真的能挑。图上的字要求**照抄**，因为表情包一半的含义就在那行字里。

**3. 删了必须真删干净。**
只把索引里的条目删掉没有用：去重看的是**内容哈希**，同一张图再被发一次，会被原样收回来。所以删除一定是「删文件 + 内容哈希进黑名单」。

**4. 两条安全线。**
`脏`（脏话 / 性暗示 / 下流）和 `烂`（低质烂梗素材）。这两类在**入库那一刻**就拦掉，不指望下游的模型每次都记得别发——它会忘，而且它不懂那是什么意思。

## 装

```bash
npm i dsh-sticker-library
# 或者直接 clone 到你的插件目录，然后在 bundle patch 里 insert（见 cordis.patch.yml）
```

`cordis.patch.yml` 里那份示例配置可以直接抄。

## 配（打标那一路）

打标需要一个「看得见」的模型，两种接法，选一个：

**A. HTTP（任何 OpenAI 兼容的 `/chat/completions`，要支持 `image_url` 的 `data:` base64）**

```yaml
config:
  vision:
    baseUrl: https://api.openai.com/v1
    apiKey: ''            # 建议用环境变量 STICKER_VISION_KEY
    model: gpt-4o-mini    # DeepSeek 官方视觉模型 / qwen-vl 都行
```

**B. 一条命令**（本地跑视觉模型，或者复用你已有的脚本）：

```yaml
config:
  describeCommand: 'node /path/to/describe.js'   # 参数：<图片路径> <提示词>，结果打到 stdout
```

**两个都不配也能用**：库照收、清单照出，只是挑图的准头差一截（清单里没有「画的是什么」）。

> 提示：大图直接 base64 发过去很费 token。我们在生产里先把它压到长边 768 再发——那步用 Pillow 一行就能做，这里没有替你做，因为不想为了省几厘钱给你绑一个 Python 依赖。

## 给 Agent 的工具

| 工具 | 干什么 |
| --- | --- |
| `sticker_catalog` | 列清单：`#3 · 一只橘猫趴在键盘上 · 别人发疯时围观 · 猫/围观/无语` |
| `sticker_pick` | 挑一张，返回本地路径。给编号（`#12`）或关键词（`无语`）都行 |
| `sticker_save` | 把本地图片收进库（通道把贴图下载好之后喂进来） |
| `sticker_tag` | 给还没打标的打标（收完新图调一次） |
| `sticker_forget` | 删一张：真删文件 + 哈希进黑名单 |

`sticker_pick` 挑不到时会**明说挑不到**，不会硬塞一张不相干的——这个细节比看起来重要：一个「随便给你一张」的挑图器，用两次就没人敢让它发图了。

## 给别的插件用的服务

```js
const shelf = ctx.stickerShelf
shelf.catalog(40)                      // 清单文本
shelf.resolve('无语')                   // { id, file, path, desc, ... } | null
shelf.saveFiles(paths, { nick, uid })  // 协议无关的入库口
shelf.stats()
```

核心逻辑（`src/shelf.js`）**不依赖 dsh，也不依赖任何 IM 协议**，可以单独用：

```js
import { createShelf } from 'dsh-sticker-library/shelf'

const shelf = createShelf({
  dir: './stickers',
  describe: async (file, prompt) => myVisionModel(file, prompt), // 必填：给视觉模型看
})

await shelf.saveFiles(['./a.png', './b.gif'], { nick: '阿猫' })
await shelf.tagPending(10)
console.log(shelf.catalog(20))
console.log(shelf.resolve('无语'))
```

## 自检

```bash
node test/selftest.mjs
```

不联网、不调模型、不依赖任何私人目录：视觉模型和下载都是假的，测的是**解析和安全线**（去重、黑名单、大小闸、烂梗拦截、成人图三条路全堵死、协议无关入库口……）。84 项。

## 边界（不做什么）

- 不做发送。挑出来给你路径，怎么发是你的事——发出去的那一刻要过谁的审核，也该由你决定。
- 不替你决定「什么算脏」。提示词里的那两条线是可以改的（`prompt` 配置），改完记得 `TAG_VER` 一起升，否则老图不会重标。
- 不做分布式/并发写。一个目录一个架子。

## License

MIT
